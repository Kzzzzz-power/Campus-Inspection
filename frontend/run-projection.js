// Frozen coverage overlays only coverage fields; live facility/review facts stay independent.
export function projectCoverage(data,run){
  if(!data)return null;
  const coverage=run?.coverage,byId=new Map((coverage?.points||[]).map(p=>[p.checkpoint_id,p]));
  return {...data,run_id:run?.run_id||null,inspection_round_id:run?.inspection_round_id||null,
    round_state:coverage?'selected':'no_round',as_of:run?.as_of||null,
    window_start:coverage?.window_start||null,window_end:coverage?.window_end||null,
    required_total:coverage?.required??data.required_total,covered:coverage?.covered??null,missing:coverage?.missing||[],
    points:data.points.map(p=>({...p,covered:byId.get(p.point_id)?.covered??null}))};
}
export function createReadGuard(){
  let generation=0;
  return {invalidate(){generation++;},capture(query){return {generation,query};},
    current(ticket,query){return ticket.generation===generation&&ticket.query===query;}};
}
export function accessDependency(run){return run?.task_results?.find(t=>t.task_id==='T1')?.checks?.find(d=>d.dependency_id==='T1.access')||null;}
