import {createInspectionAlertState} from './inspection-alerts-model.js';
// Business reminders are independent of remote equipment alerts and immutable run selection.
export function initInspectionAlerts({el,button,api,getRun,getData,openTasks,openDetail,openRun,openReview,createReview}){
  const state=createInspectionAlertState(),events=new AbortController();
  let manuallyOpened=false,previous=null,signature='',disposed=false,announcementKey='';
  const trigger=button('巡检提醒 · 0',()=>{previous=document.activeElement;manuallyOpened=true;render();popup.focus({preventScroll:true});},'btn btn-secondary');
  trigger.id='inspection-alert-open';trigger.setAttribute('aria-controls','inspection-alert-popup');trigger.setAttribute('aria-expanded','false');
  (document.querySelector('.board-heading')||document.querySelector('.header-tools')).append(trigger);
  const title=el('h2',{id:'inspection-alert-title'},'巡检待处理提醒'),source=el('p',{id:'inspection-alert-source',class:'inspection-alert-source'});
  const list=el('div',{id:'inspection-alert-items',class:'inspection-alert-items'});
  const warning=el('p',{id:'inspection-alert-warning',role:'status'});
  const close=button('知道了',dismiss,'btn btn-ghost');close.id='inspection-alert-dismiss';
  const popup=el('section',{id:'inspection-alert-popup',class:'inspection-alert-popup',role:'dialog','aria-modal':'false','aria-labelledby':title.id,tabIndex:-1,hidden:true},
    el('header',{},title,close),source,warning,list,el('p',{class:'inspection-alert-rule'},
      '待补检 / 受阻是业务提醒，不是设备故障。关闭仅收起提示；补证后的新判断确认缺口或阻塞消除，才移除对应提醒。'));
  const announcement=el('span',{class:'sr-only','aria-live':'polite'});
  document.body.append(popup,announcement);
  const on=(node,type,fn)=>node.addEventListener(type,fn,{signal:events.signal});
  function dismiss(){
    const held=popup.contains(document.activeElement);
    manuallyOpened=false;state.dismiss();render();
    if(held)(previous?.isConnected&&previous.getClientRects().length?previous:trigger).focus({preventScroll:true});
  }
  function action(label,fn,kind,id){
    const b=button(label,()=>{dismiss();fn();},'btn btn-secondary btn-small');
    b.dataset.inspectionAction=kind;if(id)b.dataset.pointId=id;return b;
  }
  function render(){
    if(disposed)return;
    const s=state.snapshot;
    trigger.textContent='巡检提醒 · '+s.issues.length;trigger.dataset.count=String(s.issues.length);
    trigger.dataset.state=s.issues.length?'attention':'clear';
    const newSignature=JSON.stringify([s.round,s.run?.run_id,s.followup,s.issues,s.warning]);
    if(signature!==newSignature){
      signature=newSignature;
      popup.dataset.runId=s.run?.run_id||'';popup.dataset.roundId=s.round||'';
      title.textContent=s.issues.length?'巡检待处理提醒 · '+s.issues.length:'暂无待补检或受阻提醒';
      source.textContent=s.round?
        '轮次 '+s.round+'\n'+(s.run?'依据 '+s.run.run_id+(s.followup?' · 最新复核后判断':' · 选定运行'):'依据当轮覆盖查询；任务状态尚未生成。')+
        (s.followup&&s.selectedRunId!==s.run.run_id?'\n工作台仍显示原选定运行，历史结果保持不变。':''):'请先选择轮次或建立教学实例。';
      warning.textContent=s.warning;warning.hidden=!s.warning;
      const focused=popup.contains(document.activeElement)?document.activeElement.dataset.inspectionAction:null;
      const focusedPoint=document.activeElement.dataset.pointId;
      list.replaceChildren(...s.issues.map(issue=>{
        const actions=el('div',{class:'inspection-alert-actions'});
        if(issue.pointId)actions.append(action('补充现场记录',()=>openDetail(issue.pointId,'inspect'),'inspect',issue.pointId));
        if(s.run){
          const pending=(s.run.input_snapshot?.review_snapshot||[]).find(r=>r.status==='pending'&&
            (issue.pointId?r.point_id===issue.pointId:r.task_id===issue.taskId));
          actions.append(action(pending?'处理已有复核':'发起现场复核',()=>pending?openReview(pending.review_id):createReview(issue,s.run),'review',issue.pointId));
          actions.append(action('查看判断依据',()=>openRun(s.run.run_id),'proof',issue.pointId));
        }else actions.append(action('生成任务判断',()=>openTasks(),'tasks',issue.pointId));
        return el('article',{'data-inspection-issue':issue.id,'data-kind':issue.kind},
          el('h3',{},(issue.kind==='blocked'?'⚠ ':'◷ ')+issue.label),el('p',{},issue.reason),actions);
      }));
      if(!s.issues.length)list.append(el('p',{},s.round?'当前依据中没有待补检或受阻项；这不代表所有设施均正常。':'未选择轮次，不作巡检状态判断。'));
      if(s.followup)list.append(action('查看补证后的新运行',()=>openRun(s.run.run_id),'followup'));
      if(focused&&!document.querySelector('dialog[open]')){
        const target=[...list.querySelectorAll('button')].find(b=>b.dataset.inspectionAction===focused&&b.dataset.pointId===focusedPoint);
        (target||close).focus({preventScroll:true});
      }
    }
    const wasHidden=popup.hidden;
    popup.hidden=!(s.pending||manuallyOpened)||document.hidden||!!document.querySelector('dialog[open]');
    trigger.setAttribute('aria-expanded',String(!popup.hidden));
    if(!popup.hidden&&wasHidden){
      if(!manuallyOpened)previous=document.activeElement;
      const key=s.round+'|'+s.issues.map(i=>i.id+i.kind).join('|');
      if(key!==announcementKey){announcement.textContent=title.textContent;announcementKey=key;}
    }
    if(wasHidden!==popup.hidden)document.dispatchEvent(new CustomEvent('inspectgo:inspection-reminder'));
  }
  on(document,'inspectgo:overlay',render);on(document,'visibilitychange',render);
  on(document,'keydown',e=>{if(e.key==='Escape'&&!popup.hidden&&!document.querySelector('dialog[open]')){e.preventDefault();e.stopImmediatePropagation();dismiss();}});
  function sync(){state.sync(getRun(),getData());render();}
  async function reviewResult(review,result){
    const ticket=state.ticket();
    if(!result||!ticket.round||review?.inspection_round_id!==ticket.round)return;
    if(result.status!=='completed'||!result.run_id){
      state.warn('材料或过程变更已保存，但新判断尚未确认；原提醒保留，请在复核详情重试判断。');render();return;
    }
    try{
      const run=await api('/api/runs/'+encodeURIComponent(result.run_id));
      if(state.acceptReviewRun(run,ticket))render();
    }catch{
      const current=state.ticket();
      if(current.epoch!==ticket.epoch||current.round!==ticket.round)return;
      state.warn('新运行已保存，但提醒依据读取失败；原提醒保留，请在复核详情刷新后重试。');render();
    }
  }
  sync();
  return {sync,reviewResult,dispose(){disposed=true;events.abort();popup.remove();trigger.remove();announcement.remove();}};
}
