import {projectPoint} from '../realtime.js';

const counts = () => ({total:0,fresh:0,stale:0,missing:0,alarm:0,simulated:0,device:0});
export function createTwinStore() {
  const listeners=new Set();
  let snapshot={nodes:[],byId:new Map(),counts:counts(),asOf:null,brokerState:'connecting',connection:'connecting',transport:'none',errors:[]};
  return {
    getSnapshot:()=>snapshot,
    subscribe(callback) { listeners.add(callback);return ()=>listeners.delete(callback); },
    sync(points,realtimeState,now) {
      const state=realtimeState||{connection:'connecting',ready:false,snapshot:null,facilities:new Map()};
      const totals=counts(),errors=[];
      const nodes=(points||[]).map(point=>{
        const projectedPoint=projectPoint(point,state,now),remote=projectedPoint.realtime;
        const observation=remote.facility?.observation||null;
        const quality=remote.reason==='disabled'?'disabled':remote.current?'live':
          remote.reason==='identity'?'missing':observation?'stale':
          remote.reason==='connecting'&&!state.snapshot?'connecting':'missing';
        const currentAlarm=quality==='live'&&projectedPoint.latest_status!=='unknown'?projectedPoint.latest_status==='alarm':null;
        const coverage=point.covered===null?'unknown':!point.required?'optional':point.covered===true?'covered':'missing';
        const node={pointId:point.point_id,facilityId:point.facility_id,zoneId:point.zone_id,twinId:'point:'+point.point_id,
          point,projectedPoint,quality,observation,receivedAt:remote.facility?.received_at||null,
          sourceType:observation?.source_type||null,currentAlarm,lastKnownAlarm:remote.lastKnownStatus==='alarm',coverage,review:point.review,reason:remote.reason};
        totals.total++;if(quality==='live')totals.fresh++;if(quality==='stale')totals.stale++;if(quality==='missing')totals.missing++;
        if(currentAlarm===true)totals.alarm++;if(node.sourceType==='SIMULATED')totals.simulated++;if(node.sourceType==='DEVICE')totals.device++;
        if(remote.reason==='identity')errors.push({pointId:point.point_id,reason:'identity'});
        return node;
      });
      snapshot={nodes,byId:new Map(nodes.map(node=>[node.pointId,node])),counts:totals,asOf:state.snapshot?.as_of||null,
        brokerState:state.snapshot?.broker?.state||'connecting',connection:state.connection,transport:state.transport||'none',errors};
      for(const callback of listeners)callback(snapshot);
      return snapshot;
    },
  };
}
