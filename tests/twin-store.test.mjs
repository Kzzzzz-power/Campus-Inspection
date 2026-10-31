import test from 'node:test';
import assert from 'node:assert/strict';
let twin={};
try { twin=await import('../frontend/twin/twin-store.js'); } catch(e) { if(e.code!=='ERR_MODULE_NOT_FOUND')throw e; }
const at=Date.parse('2026-10-29T12:00:00Z');
const point={point_id:'C01',facility_id:'lighting-201',zone_id:'Z1',required:true,covered:null,latest_status:'ok',review:{status:'cancelled'}};
const observation={facility_id:'lighting-201',zone_id:'Z1',observed_at:new Date(at).toISOString(),source_type:'DEVICE',availability:'AVAILABLE',condition:'FAULT',metrics:{}};
const facility={checkpoint_id:'C01',facility_id:'lighting-201',zone_id:'Z1',freshness:'fresh',received_at:new Date(at).toISOString(),observation};
const remote=()=>({connection:'connected',ready:true,transport:'websocket',snapshot:{as_of:new Date(at).toISOString(),stale_after_seconds:10,broker:{state:'connected'}},facilities:new Map([['C01',facility]])});
function store(){assert.equal(typeof twin.createTwinStore,'function');return twin.createTwinStore();}
test('dashboard membership, raw facts, null coverage and absent metrics survive projection',()=>{
 const s=store(),r=remote();r.facilities.set('foreign',facility);const v=s.sync([point],r,at),n=v.nodes[0];
 assert.equal(v.nodes.length,1);assert.equal(n.twinId,'point:C01');assert.equal(n.point,point);assert.equal(n.review,point.review);assert.equal(n.coverage,'unknown');assert.equal(n.quality,'live');assert.equal(n.currentAlarm,true);assert.equal(n.lastKnownAlarm,true);assert.deepEqual(n.observation.metrics,{});assert.equal(n.observation.metrics.latency_ms,undefined);
 assert.deepEqual(v.counts,{total:1,fresh:1,stale:0,missing:0,alarm:1,simulated:0,device:1});
});
test('stale alarm stays last known, never a current fault',()=>{
 const v=store().sync([point],remote(),at+10001),n=v.nodes[0];assert.equal(n.quality,'stale');assert.equal(n.currentAlarm,null);assert.equal(n.lastKnownAlarm,true);assert.equal(v.counts.alarm,0);
});
test('missing and mismatched identities do not attach observations',()=>{
 for(const facilities of [new Map(),new Map([['C01',{...facility,zone_id:'other'}]])]){const r=remote();r.facilities=facilities;const v=store().sync([point],r,at),n=v.nodes[0];assert.equal(n.quality,'missing');assert.equal(n.observation,null);assert.equal(n.facilityId,point.facility_id);assert.equal(n.currentAlarm,null);}
});
test('initial and disabled quality preserve explicit semantics',()=>{
 const s=store(),r=remote();r.connection='connecting';r.ready=false;r.facilities=new Map();r.snapshot=null;assert.equal(s.sync([point],r,at).nodes[0].quality,'connecting');
 r.snapshot={broker:{state:'disabled'}};const n=s.sync([point],r,at).nodes[0];assert.equal(n.quality,'disabled');assert.equal(n.projectedPoint.latest_status,'ok');assert.equal(n.currentAlarm,null);
});
test('subscriptions deliver replacement membership and unsubscribe',()=>{
 const s=store(),seen=[],off=s.subscribe(v=>seen.push(v));s.sync([point],remote(),at);s.sync([],remote(),at);assert.equal(seen.length,2);assert.equal(s.getSnapshot().byId.size,0);off();s.sync([point],remote(),at);assert.equal(seen.length,2);
});

test('live unknown is neither normal nor alarm and DEVICE source survives HTTP fallback',()=>{
 const r=remote();r.transport='http';r.connection='disconnected';r.facilities.set('C01',{...facility,observation:{...observation,availability:'UNKNOWN',condition:'NORMAL'}});
 const v=store().sync([point],r,at),n=v.nodes[0];assert.equal(n.quality,'live');assert.equal(n.currentAlarm,null);assert.equal(n.lastKnownAlarm,false);assert.equal(n.sourceType,'DEVICE');assert.equal(v.transport,'http');assert.equal(v.counts.device,1);
});
test('coverage and review timeout/cancel facts remain independent from remote alarms',()=>{
 const s=store();for(const status of ['pending','completed','timeout','cancelled']){const p={...point,covered:false,review:{status,conclusion:'normal'}};const n=s.sync([p],remote(),at).nodes[0];assert.equal(n.coverage,'missing');assert.equal(n.review,p.review);assert.equal(n.currentAlarm,true);}
 assert.equal(s.sync([{...point,required:false,covered:false}],remote(),at).nodes[0].coverage,'optional');
});
test('broker and link failures preserve only last known alarms, while never-observed nodes stay missing',()=>{
 for(const r of [Object.assign(remote(),{connection:'disconnected',ready:false}),Object.assign(remote(),{snapshot:{as_of:new Date(at).toISOString(),broker:{state:'disconnected'},stale_after_seconds:10}})]){
  const s=store(),n=s.sync([point],r,at).nodes[0];assert.equal(n.quality,'stale');assert.equal(n.currentAlarm,null);assert.equal(n.lastKnownAlarm,true);
  r.facilities=new Map();assert.equal(s.sync([point],r,at).nodes[0].quality,'missing');
 }
});
