import test from 'node:test';
import assert from 'node:assert/strict';
import {createAlertQueue,alarmOf,alertFeedStatus} from '../frontend/twin/campus-alerts-model.js';
const node=(id='C07',condition='FAULT',time='2026-11-01T01:00:00Z',quality='live')=>({pointId:id,facilityId:'switch-301',point:{device:'网络交换'},quality,currentAlarm:true,observation:{condition,availability:'AVAILABLE',observed_at:time,source_type:'SIMULATED'}});
test('only fresh observation facts produce alarms, never missing coverage or historical records',()=>{
 for(const quality of ['stale','missing','disabled','connecting'])assert.equal(alarmOf(node('C07','FAULT',undefined,quality)),null);
 assert.equal(alarmOf({...node(),observation:null}),null);
 assert.equal(alarmOf(node('C07','NORMAL')),null);
 assert.equal(alarmOf({...node('C07','NORMAL'),observation:{...node('C07','NORMAL').observation,availability:'UNAVAILABLE'}}).kind,'UNAVAILABLE');
});
test('initial baseline is silent; new incident queues once; timestamp refresh does not flood; escalation and recovery rearm',()=>{
 const q=createAlertQueue();q.sync([node(),node('C04','NORMAL')]);assert.equal(q.current,null);
 q.sync([node('C07','NORMAL')]);q.sync([node('C07','WARNING','2026-11-01T01:01:00Z')]);assert.equal(q.current.kind,'WARNING');
 q.dismiss();q.sync([node('C07','WARNING','2026-11-01T01:02:00Z')]);assert.equal(q.current,null);
 q.sync([node('C07','FAULT','2026-11-01T01:03:00Z'),node('C04','WARNING')]);assert.equal(q.pending,2);
 q.dismiss();assert.equal(q.current.pointId,'C04');q.dismiss();assert.equal(q.current,null);
});
test('stale cancels pending and reconnect does not re-alert same incident',()=>{
 const q=createAlertQueue();q.sync([node('C07','NORMAL')]);q.sync([node()]);assert(q.current);
 q.sync([node('C07','FAULT',undefined,'stale')]);assert.equal(q.current,null);q.sync([node('C07','FAULT','2026-11-01T01:05:00Z')]);assert.equal(q.current,null);
});

test('dismissed incident stays deduplicated after many telemetry timestamp refreshes',()=>{
 const q=createAlertQueue();q.sync([node('C07','NORMAL')]);q.sync([node()]);q.dismiss();
 for(let i=1;i<600;i++)q.sync([node('C07','FAULT',new Date(Date.parse('2026-11-01T01:00:00Z')+i*2000).toISOString())]);
 q.sync([node('C07','NORMAL')]);q.sync([node()]);assert.equal(q.current,null);
});

test('first fresh observation after empty or missing bootstrap is a silent baseline per point',()=>{
 const q=createAlertQueue();q.sync([]);q.sync([node('C07','FAULT',undefined,'missing')]);q.sync([node()]);
 assert.equal(q.current,null);assert.equal(q.active.length,1);
 q.sync([node(),node('C04','WARNING')]);assert.equal(q.current,null);assert.equal(q.active.length,2);
 q.sync([node(),node('C04','FAULT','2026-11-01T01:01:00Z')]);assert.equal(q.current.pointId,'C04');
});

test('alert connection status distinguishes unavailable input from zero current alarms',()=>{
 const fresh={brokerState:'connected',connection:'connected',transport:'websocket',nodes:[node('C07','NORMAL')]};
 assert.equal(alertFeedStatus(fresh).ready,true);
 assert.equal(alertFeedStatus({...fresh,brokerState:'disabled'}).ready,false);
 assert.match(alertFeedStatus({...fresh,brokerState:'disabled'}).label,/未启用/);
 assert.equal(alertFeedStatus({...fresh,brokerState:'disconnected'}).ready,false);
 assert.equal(alertFeedStatus({...fresh,connection:'disconnected'}).ready,false);
 assert.equal(alertFeedStatus({...fresh,nodes:[node('C07','FAULT',undefined,'stale')]}).ready,false);
 assert.match(alertFeedStatus({...fresh,nodes:[]}).label,/等待/);
 assert.equal(alertFeedStatus({...fresh,connection:'disconnected',transport:'http'}).ready,true);
 const partial=alertFeedStatus({...fresh,nodes:[node('C07','NORMAL'),node('C04','FAULT',undefined,'stale')]});
 assert.equal(partial.ready,true);assert.match(partial.label,/部分/);
});