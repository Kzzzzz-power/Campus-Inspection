const hasText = value => typeof value === 'string' && value.length > 0;
const hasDate = value => hasText(value) && Number.isFinite(Date.parse(value));
function validMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return false;
  const entries=Object.entries(metrics);
  return entries.length<=20 && entries.every(([key,value])=>key.length>=1 && key.length<=64 && Number.isFinite(value)) &&
    (!Object.hasOwn(metrics,'latency_ms') || metrics.latency_ms>=0);
}
function validSnapshot(value) {
  if (value?.type !== 'facilities_snapshot' || !Number.isInteger(value.revision) || !hasDate(value.as_of) ||
      !Number.isFinite(value.stale_after_seconds) || value.stale_after_seconds <= 0 ||
      !['disabled','connecting','connected','disconnected'].includes(value.broker?.state) ||
      !Array.isArray(value.facilities)) return false;
  const ids = new Set();
  return value.facilities.every(facility => {
    if (!facility || !hasText(facility.checkpoint_id) || !hasText(facility.facility_id) || !hasText(facility.zone_id) ||
        ids.has(facility.checkpoint_id) || !['missing','fresh','stale'].includes(facility.freshness)) return false;
    ids.add(facility.checkpoint_id);
    const observation = facility.observation;
    if (observation === null) return facility.freshness === 'missing';
    return observation?.facility_id === facility.facility_id && observation.zone_id === facility.zone_id &&
      hasDate(observation.observed_at) && hasDate(facility.received_at) && ['SIMULATED','DEVICE'].includes(observation.source_type) &&
      ['AVAILABLE','UNAVAILABLE','UNKNOWN'].includes(observation.availability) &&
      ['NORMAL','WARNING','FAULT'].includes(observation.condition) && validMetrics(observation.metrics);
  });
}

function observationStatus(observation) {
  if (!observation) return 'unknown';
  if (observation.availability === 'UNAVAILABLE' || ['WARNING','FAULT'].includes(observation.condition)) return 'alarm';
  return observation.availability === 'AVAILABLE' ? 'ok' : 'unknown';
}

export function projectPoint(point, state, now=state.now?.() ?? Date.now()) {
  const candidate=state.facilities.get(point.point_id)||null;
  const mismatch=candidate && (candidate.checkpoint_id!==point.point_id || candidate.facility_id!==point.facility_id || candidate.zone_id!==point.zone_id);
  const facility=mismatch?null:candidate,observation=facility?.observation;
  const httpReady=state.transport==='http' && state.ready;
  let reason='';
  if(state.snapshot?.broker.state==='disabled')reason='disabled';
  else if(mismatch)reason='identity';
  else if(state.connection==='stopped' || (state.connection==='disconnected'&&!httpReady))reason='disconnected';
  else if(!state.ready || (state.connection!=='connected'&&!httpReady))reason='connecting';
  else if(state.snapshot?.broker.state!=='connected')reason='broker';
  else if(!observation)reason='missing';
  else if(facility.freshness!=='fresh' || now-Date.parse(observation.observed_at)>state.snapshot.stale_after_seconds*1000)reason='stale';
  const lastKnownStatus=observationStatus(observation);
  const status=reason==='disabled'?point.latest_status:reason?'unknown':lastKnownStatus;
  // Identity and site evidence always come from the dashboard, never the remote feed.
  return {...point,latest_status:status,realtime:{facility,reason,current:!reason,lastKnownStatus}};
}

export function createRealtimeClient({url,currentUrl='/api/current',onChange=()=>{},WebSocketImpl=globalThis.WebSocket,
    fetchImpl=globalThis.fetch,now=Date.now,monotonicNow=now===Date.now?()=>globalThis.performance?.now()??Date.now():now,
    setTimer=setTimeout,clearTimer=clearTimeout}) {
  const state={connection:'connecting',snapshot:null,facilities:new Map(),ready:false,transport:'none'};
  let active=false,socket=null,retryTimer=null,expiryTimer=null,httpTimer=null,retryDelay=500;
  let generation=0,wsVersion=0,request=null,anchor=null;
  state.now=()=>anchor?anchor.server+Math.max(0,monotonicNow()-anchor.local):now();
  const notify=()=>onChange(state,state.now());
  const websocketReady=()=>state.connection==='connected'&&state.transport==='websocket'&&state.ready;
  function cancelHttp() {
    if(!request)return;
    const previous=request;request=null;clearTimer(previous.timeout);previous.controller.abort();
  }
  function applySnapshot(snapshot,transport) {
    anchor={server:Date.parse(snapshot.as_of),local:monotonicNow()};
    state.snapshot=snapshot;state.facilities=new Map(snapshot.facilities.map(f=>[f.checkpoint_id,f]));
    state.transport=transport;state.ready=true;notify();
  }
  async function fetchCurrent() {
    if(!active || typeof fetchImpl!=='function' || request || websocketReady())return;
    clearTimer(httpTimer);httpTimer=null;
    const current={generation,wsVersion,controller:new AbortController(),timeout:null};request=current;
    current.timeout=setTimer(()=>current.controller.abort(),8000);
    try {
      const response=await fetchImpl(currentUrl,{cache:'no-store',signal:current.controller.signal});
      if(!response.ok)throw new Error('Current snapshot unavailable');
      const value=await response.json();
      if(!active || request!==current || generation!==current.generation || wsVersion!==current.wsVersion)return;
      if(!validSnapshot(value))throw new Error('Invalid current snapshot');
      applySnapshot(value,'http');
    } catch {
      if(active && request===current && generation===current.generation && wsVersion===current.wsVersion && !websocketReady()) {
        state.ready=false;notify();
      }
    } finally {
      clearTimer(current.timeout);
      if(request===current){request=null;if(active&&!websocketReady())httpTimer=setTimer(()=>{httpTimer=null;fetchCurrent();},5000);}
    }
  }
  function releaseSocket() {
    const previous=socket;socket=null;
    if(previous){previous.onopen=previous.onmessage=previous.onerror=previous.onclose=null;previous.close();}
  }
  function disconnected() {
    releaseSocket();state.connection='disconnected';if(state.transport!=='http')state.ready=false;notify();
    cancelHttp();fetchCurrent();
    if(active&&retryTimer===null){retryTimer=setTimer(()=>{retryTimer=null;connect();},retryDelay);retryDelay=Math.min(retryDelay*2,10000);}
  }
  function connect() {
    if(!active)return;
    state.connection='connecting';if(state.transport!=='http')state.ready=false;notify();
    let current;
    try{current=new WebSocketImpl(url);socket=current;}catch{disconnected();return;}
    current.onopen=()=>{if(socket!==current)return;state.connection='connected';notify();};
    current.onmessage=event=>{
      if(socket!==current||!active)return;
      let snapshot;try{snapshot=JSON.parse(event.data);}catch{return;}
      if(!validSnapshot(snapshot))return;
      // Full WS snapshots are ordered by the connection; equal revisions carry expiry and restarts reset revisions.
      wsVersion++;cancelHttp();clearTimer(httpTimer);httpTimer=null;retryDelay=500;applySnapshot(snapshot,'websocket');
    };
    current.onclose=current.onerror=()=>{if(socket===current&&active)disconnected();};
  }
  function checkExpiry(){if(!active)return;notify();expiryTimer=setTimer(checkExpiry,1000);}
  return {
    state,
    start(){if(active)return;active=true;generation++;retryDelay=500;connect();fetchCurrent();expiryTimer=setTimer(checkExpiry,1000);},
    stop(){active=false;generation++;clearTimer(retryTimer);clearTimer(expiryTimer);clearTimer(httpTimer);retryTimer=expiryTimer=httpTimer=null;cancelHttp();releaseSocket();state.connection='stopped';state.ready=false;notify();},
  };
}
