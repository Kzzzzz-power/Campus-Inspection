import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesPoint} from '../frontend/model.js';
let realtime = {};
try { realtime = await import('../frontend/realtime.js'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const epoch = Date.parse('2026-10-29T12:00:00Z');
const point = {point_id:'C01',facility_id:'lighting-201',zone_id:'Z1',device:'照明控制',required:true,covered:true,latest_status:'ok',photo_count:2,at:'2026-10-29T11:59:00Z',review:{status:'completed',conclusion:'fault'}};
const filters = {query:'',scope:'all',required:'all',status:'all'};
function facility(condition='NORMAL', availability='AVAILABLE') {
  return {checkpoint_id:'C01',facility_id:'lighting-201',zone_id:'Z1',name:'照明控制',critical:true,observation:{facility_id:'lighting-201',zone_id:'Z1',observed_at:new Date(epoch).toISOString(),source_type:'SIMULATED',availability,condition,metrics:{latency_ms:23}},received_at:new Date(epoch).toISOString(),freshness:'fresh'};
}
function snapshot(facilities=[facility()], revision=2, broker='connected') {
  return {type:'facilities_snapshot',revision,as_of:new Date(epoch).toISOString(),stale_after_seconds:10,broker:{state:broker,reason:''},facilities};
}
function harness(options={}) {
  assert.equal(typeof realtime.createRealtimeClient,'function','real WebSocket client must exist');
  let current=epoch, sequence=0, changes=0;
  const timers=new Map(), sockets=[];
  class Socket {
    constructor(url) { this.url=url;this.closed=false;sockets.push(this); }
    open() { this.onopen?.(); }
    message(value) { this.onmessage?.({data:JSON.stringify(value)}); }
    disconnect() { this.onclose?.(); }
    close() { this.closed=true; }
  }
  const client=realtime.createRealtimeClient({url:'ws://localhost/ws/facilities',WebSocketImpl:Socket,now:()=>current,fetchImpl:null,...options,onChange:()=>changes++,setTimer:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,at:current+delay,delay});return id;},clearTimer:id=>timers.delete(id)});
  const advance=ms=>{const end=current+ms;while(true){const next=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;current=next[1].at;timers.delete(next[0]);next[1].fn();}current=end;};
  const view=()=>realtime.projectPoint(point,client.state,current);
  return {client,sockets,timers,advance,view,get changes(){return changes;},connect(){client.start();sockets.at(-1).open();sockets.at(-1).message(snapshot());}};
}
test('fresh simulated observations drive facility status without changing coverage, review or record metadata',()=>{
  const h=harness();h.connect();h.sockets[0].message(snapshot([facility('WARNING')]));
  const projected=h.view();assert.equal(projected.latest_status,'alarm');assert.equal(projected.realtime.current,true);
  for(const key of ['required','covered','photo_count','at','review'])assert.equal(projected[key],point[key]);
  assert.equal(point.latest_status,'ok');assert.equal(projected.realtime.facility.observation.metrics.latency_ms,23);
});
test('missing, unavailable and unknown availability have distinct state projections',()=>{
  const h=harness();h.connect();
  h.sockets[0].message(snapshot([{...facility(),observation:null,received_at:null,freshness:'missing'}]));
  assert.equal(h.view().latest_status,'unknown');assert.equal(h.view().realtime.reason,'missing');
  h.sockets[0].message(snapshot([facility('NORMAL','UNAVAILABLE')]));assert.equal(h.view().latest_status,'alarm');
  h.sockets[0].message(snapshot([facility('NORMAL','UNKNOWN')]));assert.equal(h.view().latest_status,'unknown');
});
test('observations expire locally while retaining original business values and observation time',()=>{
  const h=harness();h.connect();h.sockets[0].message(snapshot([facility('FAULT')]));h.advance(10001);
  const projected=h.view();assert.equal(projected.latest_status,'unknown');assert.equal(projected.realtime.reason,'stale');
  assert.equal(projected.realtime.facility.observation.condition,'FAULT');assert.equal(projected.realtime.facility.observation.observed_at,new Date(epoch).toISOString());assert.ok(h.changes>=3);
});
test('same-revision server freshness updates are accepted and full snapshots replace missing entries',()=>{
  const h=harness();h.connect();h.sockets[0].message(snapshot([{...facility(),freshness:'stale'}]));assert.equal(h.view().realtime.reason,'stale');
  h.sockets[0].message(snapshot([]));assert.equal(h.view().latest_status,'unknown');assert.equal(h.view().realtime.facility,null);
});
test('broker disconnect and WebSocket disconnect preserve the last observation without declaring FAULT',()=>{
  const h=harness();h.connect();h.sockets[0].message(snapshot([facility()],3,'disconnected'));
  assert.equal(h.view().latest_status,'unknown');assert.equal(h.view().realtime.reason,'broker');assert.equal(h.view().realtime.facility.observation.condition,'NORMAL');
  h.sockets[0].message(snapshot());h.sockets[0].disconnect();assert.equal(h.client.state.connection,'disconnected');assert.equal(h.view().realtime.reason,'disconnected');assert.equal(h.view().latest_status,'unknown');
});
test('disabled broker preserves legacy state, while initial connection has an unknown remote state',()=>{
  const h=harness();assert.equal(h.view().latest_status,'unknown');h.connect();h.sockets[0].message(snapshot([],0,'disabled'));
  assert.equal(h.view().latest_status,'ok');assert.equal(h.view().realtime.reason,'disabled');
});
test('reconnect accepts a reset revision and ignores events from the old connection',()=>{
  const h=harness();h.connect();const old=h.sockets[0],lateMessage=old.onmessage;
  old.message(snapshot([facility('FAULT')],99));old.disconnect();h.advance(500);assert.equal(h.sockets.length,2);
  h.sockets[1].open();assert.equal(h.view().latest_status,'unknown');h.sockets[1].message(snapshot([facility()],0));assert.equal(h.view().latest_status,'ok');
  lateMessage({data:JSON.stringify(snapshot([facility('FAULT')],100))});assert.equal(h.view().latest_status,'ok');
});
test('reconnect delay backs off to at most ten seconds, stop cleans up and start resumes once',()=>{
  const h=harness();h.client.start();h.client.start();assert.equal(h.sockets.length,1);
  for(const delay of [500,1000,2000,4000,8000,10000,10000]){const count=h.sockets.length;h.sockets.at(-1).disconnect();h.advance(delay-1);assert.equal(h.sockets.length,count);h.advance(1);assert.equal(h.sockets.length,count+1);}
  const last=h.sockets.at(-1);h.client.stop();assert.equal(last.closed,true);assert.equal(h.timers.size,0);h.advance(20000);const count=h.sockets.length;h.client.start();assert.equal(h.sockets.length,count+1);
});
test('malformed snapshots are ignored and do not overwrite the last complete snapshot',()=>{
  const h=harness();h.connect();h.sockets[0].onmessage({data:'not json'});h.sockets[0].message({...snapshot(),facilities:null});h.sockets[0].message(snapshot([{...facility(),observation:{condition:'FAULT'}}]));
  assert.equal(h.view().latest_status,'ok');assert.equal(h.view().realtime.facility.observation.condition,'NORMAL');
});
test('alarm and unknown filters match projected state; facility_id is searchable',()=>{
  const h=harness();h.connect();h.sockets[0].message(snapshot([facility('FAULT')]));assert.equal(matchesPoint(h.view(),{...filters,status:'alarm'}),true);
  h.sockets[0].disconnect();assert.equal(matchesPoint(h.view(),{...filters,status:'alarm'}),false);assert.equal(matchesPoint(h.view(),{...filters,status:'unknown'}),true);
  assert.equal(matchesPoint(h.view(),{...filters,query:'LIGHTING-201'}),true);
});
test('DEVICE source and optional latency metrics follow the backend observation contract',()=>{
  const h=harness();h.connect();
  const device=facility('FAULT');device.observation.source_type='DEVICE';
  h.sockets[0].message(snapshot([device],3));
  assert.equal(h.view().latest_status,'alarm');assert.equal(h.view().realtime.facility.observation.source_type,'DEVICE');
});
test('simulated observations accept finite custom metrics and no latency value without inventing one',()=>{
  const h=harness();h.connect();
  for(const metrics of [{temperature_c:-2},{},Object.fromEntries(Array.from({length:20},(_,i)=>['metric_'+i,i]))]){
    const incoming=facility('FAULT');incoming.observation.metrics=metrics;
    h.sockets[0].message(snapshot([incoming],3));
    assert.equal(h.view().latest_status,'alarm');assert.deepEqual(h.view().realtime.facility.observation.metrics,metrics);
    assert.equal(Object.hasOwn(h.view().realtime.facility.observation.metrics,'latency_ms'),false);
  }
});
test('invalid source, metrics types, keys, size and negative latency never replace the last valid snapshot',()=>{
  const h=harness();h.connect();
  const unknown=facility('FAULT');unknown.observation.source_type='UNKNOWN';h.sockets[0].message(snapshot([unknown],3));assert.equal(h.view().latest_status,'ok');
  for(const metrics of [null,[],{latency_ms:-1},{latency_ms:1,load:null},{latency_ms:1,load:true},{latency_ms:1,load:'2'},{latency_ms:1,'':2},{latency_ms:1,['x'.repeat(65)]:2},Object.fromEntries(Array.from({length:21},(_,i)=>['metric_'+i,i]))]){
    const incoming=facility('FAULT');incoming.observation.metrics=metrics;h.sockets[0].message(snapshot([incoming],3));
    assert.equal(h.view().latest_status,'ok',JSON.stringify(metrics));
  }
  const nonfinite=facility('FAULT');nonfinite.observation.metrics={latency_ms:1,load:0};
  h.sockets[0].onmessage({data:JSON.stringify(snapshot([nonfinite],3)).replace('"load":0','"load":1e400')});
  assert.equal(h.view().latest_status,'ok');
});

const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function pendingHttp(){const requests=[];return{requests,fetchImpl:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve:value=>resolve({ok:true,json:async()=>value}),reject}))};}
test('HTTP bootstrap drives current state before WS without changing source type',async()=>{
 const http=pendingHttp(),h=harness(http);h.client.start();assert.equal(http.requests.length,1);assert.equal(http.requests[0].url,'/api/current');
 http.requests[0].resolve(snapshot([facility('FAULT')]));await settle();assert.equal(h.client.state.transport,'http');assert.equal(h.view().latest_status,'alarm');assert.equal(h.view().realtime.facility.observation.source_type,'SIMULATED');h.client.stop();
});
test('late HTTP never overwrites newer WS data even with a higher revision',async()=>{
 const http=pendingHttp(),h=harness(http);h.connect();http.requests[0].resolve(snapshot([facility('FAULT')],999));await settle();assert.equal(h.client.state.transport,'websocket');assert.equal(h.view().latest_status,'ok');h.advance(6000);assert.equal(http.requests.length,1);h.client.stop();
});
test('HTTP fallback serves disconnected WS and accepts server revision reset',async()=>{
 const http=pendingHttp(),h=harness(http);h.connect();http.requests[0].resolve(snapshot());await settle();h.sockets[0].disconnect();assert.equal(h.view().latest_status,'unknown');assert.equal(http.requests.length,2);
 http.requests[1].resolve(snapshot([facility('FAULT')],0));await settle();assert.equal(h.client.state.transport,'http');assert.equal(h.view().latest_status,'alarm');h.advance(500);assert.equal(h.view().latest_status,'alarm');h.sockets[1].open();h.sockets[1].message(snapshot([facility()],0));assert.equal(h.view().latest_status,'ok');h.client.stop();
});
test('HTTP failures remove current validity, retry and ignore results after stop',async()=>{
 const http=pendingHttp(),h=harness(http);h.client.start();http.requests[0].resolve(snapshot([facility('FAULT')]));await settle();h.advance(5000);assert.equal(http.requests.length,2);http.requests[1].reject(new Error('offline'));await settle();assert.equal(h.view().latest_status,'unknown');assert.equal(h.view().realtime.facility.observation.condition,'FAULT');
 h.advance(5000);assert.equal(http.requests.length,3);h.client.stop();http.requests[2].resolve(snapshot());await settle();assert.equal(h.client.state.connection,'stopped');assert.equal(h.client.state.ready,false);assert.equal(h.timers.size,0);
});
test('server as_of plus monotonic elapsed ignores browser wall-clock skew and changes',()=>{
 let wall=epoch+86400000,mono=100;const h=harness({now:()=>wall,monotonicNow:()=>mono});h.connect();assert.equal(realtime.projectPoint(point,h.client.state).latest_status,'ok');wall-=172800000;mono+=10001;assert.equal(realtime.projectPoint(point,h.client.state).realtime.reason,'stale');h.client.stop();
});
test('point identity must match checkpoint, facility and zone without rewriting dashboard identity',()=>{
 const h=harness();h.connect();for(const change of [{checkpoint_id:'C99'},{facility_id:'other'},{zone_id:'other'}]){const state={...h.client.state,facilities:new Map([['C01',{...facility('FAULT'),...change}]])};const p=realtime.projectPoint(point,state,epoch);assert.equal(p.latest_status,'unknown');assert.equal(p.facility_id,point.facility_id);assert.equal(p.zone_id,point.zone_id);assert.equal(p.realtime.facility,null);assert.equal(p.realtime.reason,'identity');}h.client.stop();
});

test('HTTP equal-revision freshness transition and invalid response do not turn stale data into current alarms',async()=>{
 const http=pendingHttp(),h=harness(http);h.client.start();http.requests[0].resolve(snapshot([facility('FAULT')]));await settle();
 h.advance(5000);http.requests[1].resolve(snapshot([{...facility('FAULT'),freshness:'stale'}]));await settle();assert.equal(h.view().realtime.reason,'stale');
 h.advance(5000);http.requests[2].resolve({...snapshot(),facilities:null});await settle();assert.equal(h.view().latest_status,'unknown');assert.equal(h.view().realtime.facility.observation.condition,'FAULT');h.client.stop();
});
test('previous session HTTP responses cannot replace a restarted client snapshot',async()=>{
 const http=pendingHttp(),h=harness(http);h.client.start();const old=http.requests[0];h.client.stop();h.client.start();assert.equal(http.requests.length,2);
 http.requests[1].resolve(snapshot());await settle();old.resolve(snapshot([facility('FAULT')],999));await settle();assert.equal(h.view().latest_status,'ok');assert.equal(h.client.state.transport,'http');h.client.stop();
});
test('HTTP transport failure never downgrades an accepted WS snapshot',async()=>{
 const http=pendingHttp(),h=harness(http);h.connect();http.requests[0].reject(new Error('aborted'));await settle();assert.equal(h.client.state.transport,'websocket');assert.equal(h.client.state.ready,true);assert.equal(h.view().latest_status,'ok');h.client.stop();
});
