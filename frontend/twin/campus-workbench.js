import {initFrozenRunViews} from '../frozen-run-views.js';
// Presentation only: read the existing dashboard and selected immutable run.
// The original evidence/review/history controls are moved, never cloned.
export function initCampusWorkbench({el,button,api,getRun,getData,openTasks,showDialog,overlayChanged,proof,openReview}){
  const host=document.getElementById('campus-stage');if(!host)return{sync(){}};
  const dock=el('nav',{class:'campus-workbench','aria-label':'3D 巡检工作台'});
  const tasks=button('轮次与任务',()=>openTasks(),'btn btn-secondary');tasks.id='campus-tasks-open';
  const plans=button('候选方案与对比',()=>openTasks('plans'),'btn btn-secondary');plans.id='campus-plans-open';
  const views=initFrozenRunViews({el,button,getRun,showDialog,overlayChanged,proof,openReview});
  const coverage=button('覆盖与阻塞',()=>views.open('coverage'),'btn btn-secondary');coverage.id='campus-coverage-open';
  const evidence=button('本次判断证据',()=>views.open('evidence'),'btn btn-secondary');evidence.id='campus-run-evidence-open';
  const actions=el('div',{class:'campus-business-actions'},coverage,tasks,plans,evidence);
  for(const [id,label] of [['evidence-browser-open','记录与证据'],['review-list-open','现场复核列表'],['all-runs-btn','运行历史']]){
    const entry=document.getElementById(id);if(entry){entry.textContent=label;entry.className='btn btn-secondary';actions.append(entry);}
  }
  const context=el('p',{id:'campus-run-context',class:'campus-run-context'}),states=el('div',{class:'campus-task-states','aria-label':'选定运行的任务判断'});
  const retry=button('重试读取任务',loadCatalog,'btn btn-ghost');retry.hidden=true;
  dock.append(actions,context,states,retry);dock.dataset.version='20261101-workbench-2';host.querySelector('.twin-heading').after(dock);
  const labels={established:'成立',blocked:'受阻',pending_verification:'待验证',unknown:'状态未知'};
  const tones={established:'good',blocked:'danger',pending_verification:'warn',unknown:'muted'};
  const taskButtons=new Map();let catalog=[],catalogError=false;
  async function loadCatalog(){
    retry.disabled=true;
    try{catalog=(await api('/api/task-definitions')).items;catalogError=false;retry.hidden=true;}
    catch{catalogError=true;retry.hidden=false;}
    finally{retry.disabled=false;sync();}
  }
  function sync(){
    views.sync();
    const run=getRun(),data=getData();context.dataset.runId=run?.run_id||'';
    plans.disabled=!run?.plan_results?.length;
    const message=run?`冻结判断 · ${run.inspection_round_id} · ${run.run_id}；远程观察独立更新。`:data?.inspection_round_id?`轮次 ${data.inspection_round_id} · 尚未生成判断。`:'先选择轮次或建立教学实例，再生成任务判断。';
    const description=message+(catalogError?' 任务目录暂时读取失败，可重试。':'');
    if(context.textContent!==description)context.textContent=description;
    const results=run?.task_results||catalog,ids=new Set(results.map(t=>t.task_id));
    for(const[id,entry]of taskButtons)if(!ids.has(id)){entry.remove();taskButtons.delete(id);}
    for(const task of results){
      let entry=taskButtons.get(task.task_id);
      if(!entry){entry=button('',()=>openTasks(task.task_id),'campus-task-state');taskButtons.set(task.task_id,entry);states.append(entry);}
      const label=task.state?(labels[task.state]||'状态未知'):'尚未生成判断';
      entry.replaceChildren(el('strong',{},el('span',{class:'task-short'},task.task_id),el('span',{class:'task-name'},task.task_id+' · '+task.name)),el('span',{},label),el('small',{class:'task-next-action'},task.checks?`${task.checks.length} 项依赖 · 查看依据`:'选择轮次'));
      entry.dataset.tone=tones[task.state]||'muted';entry.dataset.taskId=task.task_id;
      entry.setAttribute('aria-label',task.task_id+' '+task.name+'：'+label+'，'+(task.state?'查看判断依据':'选择轮次并生成判断'));
    }
    states.hidden=!results.length;
  }
  sync();loadCatalog();return{sync};
}
