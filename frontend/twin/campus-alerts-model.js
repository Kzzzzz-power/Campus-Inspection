// UI-only incident memory. Remote observations remain authoritative; no writes or task states.
export function alarmOf(node){
 const o=node.observation;
 if(node.quality!=='live'||!o||!Number.isFinite(Date.parse(o.observed_at)))return null;
 const kind=o.condition==='FAULT'?'FAULT':o.condition==='WARNING'?'WARNING':o.availability==='UNAVAILABLE'?'UNAVAILABLE':null;
 if(!kind)return null;
 return {pointId:node.pointId,facilityId:node.facilityId,name:node.point.device,kind,condition:o.condition,availability:o.availability,observedAt:o.observed_at,sourceType:o.source_type,key:[node.pointId,o.observed_at,o.condition,o.availability].join('|')};
}
export function createAlertQueue(){
 let queue=[],active=[];const seen=new Set(),last=new Map();
 return {
  sync(nodes){
   active=nodes.map(alarmOf).filter(Boolean).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
   const current=new Map(active.map(a=>[a.pointId,a]));
   queue=queue.filter(a=>current.get(a.pointId)?.kind===a.kind);
   for(const n of nodes){
    if(n.quality!=='live')continue;const a=current.get(n.pointId),kind=a?.kind||'NORMAL';
    if(a&&last.has(n.pointId)&&last.get(n.pointId)!==kind&&!seen.has(a.key))queue.push(a);
    if(a&&last.get(n.pointId)!==kind)seen.add(a.key);last.set(n.pointId,kind);
   }
  },
  dismiss(){queue.shift();},get current(){return queue[0]||null;},get pending(){return queue.length;},get active(){return active;}
 };
}

// Connection health is separate from facility facts and site coverage.
export function alertFeedStatus(snapshot){
 if(snapshot.brokerState==='disabled')return{ready:false,label:'实时告警未启用'};
 if(snapshot.connection!=='connected'&&snapshot.transport!=='http')return{ready:false,label:snapshot.connection==='connecting'?'正在连接远程状态':'远程连接已中断，等待恢复'};
 if(snapshot.brokerState!=='connected')return{ready:false,label:'远程数据源未连接，等待恢复'};
 const nodes=snapshot.nodes||[],live=nodes.filter(n=>n.quality==='live').length;
 if(!live)return{ready:false,label:'等待有效远程状态；未知或过期不作故障判断'};
 return{ready:true,label:live<nodes.length?'部分点位状态缺失或过期，仅对有效状态提示告警':'实时告警已连接'};
}