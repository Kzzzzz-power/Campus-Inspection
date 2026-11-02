// Read-only presentation of backend coverage and task results; never derives task states.
const reality = run => run?.run_type==='reality' && run.status==='completed';
export function inspectionIssues(run,data){
  if(run&&!reality(run))return [];
  const round=run?.inspection_round_id||data?.inspection_round_id;
  if(!round||(!run&&data?.round_state==='no_round'))return [];
  const coverage=run?.coverage||data, tasks=run?.task_results||[];
  const t1=tasks.find(t=>t.task_id==='T1'),issues=[];
  for(const id of [...new Set(coverage?.missing||[])]){
    const point=run?coverage.points?.find(p=>p.checkpoint_id===id):data?.points?.find(p=>p.point_id===id);
    if(!point||point.required!==true||point.covered!==false)continue;
    issues.push({id:'missing:'+id,pointId:id,taskId:'T1',kind:t1?.state==='blocked'?'blocked':'missing',
      label:id+' · 待补检'+(t1?.state==='blocked'?' / T1 受阻':''),
      reason:t1?.state==='blocked'?t1.reason:'该轮次缺少有效现场记录；不表示设备故障。'});
  }
  for(const task of tasks.filter(t=>t.state==='blocked')){
    if(task.task_id==='T1'&&issues.length)continue;
    issues.push({id:'task:'+task.task_id,pointId:null,taskId:task.task_id,kind:'blocked',
      label:task.task_id+' · '+(task.name||'巡检任务')+' · 受阻',reason:task.reason});
  }
  return issues;
}
export function createInspectionAlertState(){
  let round=null,token=null,epoch=0,followup=null,selected=null,data=null,issues=[],pending=false,warning='';
  function update(){
    const previous=new Set(issues.map(i=>i.id+'|'+i.kind));
    issues=inspectionIssues(followup||selected,data);
    if(issues.some(i=>!previous.has(i.id+'|'+i.kind)))pending=true;
    if(!issues.length)pending=false;
  }
  return {
    sync(run,value){
      if(run&&!reality(run))return; // A what-if view cannot change the reality reminder.
      const nextRound=run?.inspection_round_id||value?.inspection_round_id||null;
      const nextToken=run?.run_id||(nextRound?'round:'+nextRound:null);
      if(nextToken!==token){epoch++;followup=null;warning='';}
      if(nextRound!==round){issues=[];pending=false;warning='';}
      token=nextToken;round=nextRound;selected=run;data=value;update();
    },
    ticket(){return {epoch,round};},
    acceptReviewRun(run,ticket){
      if(!reality(run)||!ticket||ticket.epoch!==epoch||ticket.round!==round||run.inspection_round_id!==round)return false;
      const current=followup||selected;
      if(current&&Date.parse(run.completed_at)<Date.parse(current.completed_at))return false;
      followup=run;warning='';update();return true;
    },
    warn(message){warning=message;},
    dismiss(){pending=false;},
    get snapshot(){return {round,issues,pending,warning,run:followup||selected,followup:!!followup,selectedRunId:selected?.run_id||null};}
  };
}
