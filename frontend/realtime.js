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

export function projectPoint(point, state, now=Date.now()) {
  const facility = state.facilities.get(point.point_id) || null;
  const observation = facility?.observation;
  let reason = '';
  if (state.snapshot?.broker.state === 'disabled') reason = 'disabled';
  else if (state.connection === 'disconnected' || state.connection === 'stopped') reason = 'disconnected';
  else if (state.connection !== 'connected' || !state.ready) reason = 'connecting';
  else if (state.snapshot?.broker.state !== 'connected') reason = 'broker';
  else if (!observation) reason = 'missing';
  else if (facility.freshness !== 'fresh' || now - Date.parse(observation.observed_at) > state.snapshot.stale_after_seconds * 1000) reason = 'stale';
  let status = 'unknown';
  if (reason === 'disabled') status = point.latest_status;
  else if (!reason) {
    if (observation.availability === 'UNAVAILABLE' || ['WARNING','FAULT'].includes(observation.condition)) status = 'alarm';
    else if (observation.availability === 'AVAILABLE') status = 'ok';
  }
  // Project only the displayed facility state; site evidence and review objects stay untouched.
  return {...point,facility_id:facility?.facility_id || point.facility_id,latest_status:status,realtime:{facility,reason,current:!reason}};
}

export function createRealtimeClient({url, onChange=()=>{}, WebSocketImpl=globalThis.WebSocket,
    now=Date.now, setTimer=setTimeout, clearTimer=clearTimeout}) {
  const state = {connection:'connecting',snapshot:null,facilities:new Map(),ready:false};
  let active=false, socket=null, retryTimer=null, expiryTimer=null, retryDelay=500;
  const notify = () => onChange(state, now());
  function releaseSocket() {
    const previous=socket;socket=null;
    if (previous) {
      previous.onopen=previous.onmessage=previous.onerror=previous.onclose=null;
      previous.close();
    }
  }
  function disconnected() {
    releaseSocket();state.connection='disconnected';state.ready=false;notify();
    if (active && retryTimer === null) {
      retryTimer=setTimer(()=>{retryTimer=null;connect();},retryDelay);
      retryDelay=Math.min(retryDelay*2,10000);
    }
  }
  function connect() {
    if (!active) return;
    state.connection='connecting';state.ready=false;notify();
    let current;
    try { current=new WebSocketImpl(url);socket=current; }
    catch { disconnected();return; }
    current.onopen=()=>{if(socket!==current)return;state.connection='connected';notify();};
    current.onmessage=event=>{
      if (socket!==current || !active) return;
      let snapshot;
      try { snapshot=JSON.parse(event.data); } catch { return; }
      if (!validSnapshot(snapshot)) return;
      // Every message is complete. Equal revisions can carry fresh-to-stale changes; restarts reset revisions.
      state.snapshot=snapshot;
      state.facilities=new Map(snapshot.facilities.map(facility=>[facility.checkpoint_id,facility]));
      state.ready=true;retryDelay=500;notify();
    };
    current.onclose=current.onerror=()=>{if(socket===current && active)disconnected();};
  }
  function checkExpiry() {
    if (!active) return;
    notify();expiryTimer=setTimer(checkExpiry,1000);
  }
  return {
    state,
    start() {
      if (active) return;
      active=true;retryDelay=500;connect();expiryTimer=setTimer(checkExpiry,1000);
    },
    stop() {
      active=false;clearTimer(retryTimer);clearTimer(expiryTimer);retryTimer=expiryTimer=null;
      releaseSocket();state.connection='stopped';state.ready=false;notify();
    },
  };
}