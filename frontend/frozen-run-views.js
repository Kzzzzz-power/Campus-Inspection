import {accessDependency} from './run-projection.js';
import {evidenceLinks,pagedItems} from './paged-evidence.js';
const dependencyLabels={satisfied:'已满足',unsatisfied:'未满足',unknown:'未知（证据不足、失效或冲突）'};
export function initFrozenRunViews({el,button,getRun,showDialog,overlayChanged,proof,openReview}){
  const dialog=el('dialog',{id:'campus-frozen-dialog',class:'run-dialog campus-frozen-dialog','aria-labelledby':'campus-frozen-title'});
  const title=el('h2',{id:'campus-frozen-title'}),body=el('div',{class:'drawer-body',id:'campus-frozen-body'});
  const close=button('关闭面板',()=>dialog.close(),'btn btn-ghost');close.id='campus-frozen-close';
  dialog.append(el('header',{class:'drawer-header'},title,close),body);document.body.append(dialog);
  let trigger=null,kind='coverage';
  dialog.addEventListener('close',()=>{overlayChanged();trigger?.focus({preventScroll:true});});
  function evidenceRow(run,p){
    return el('section',{class:'dependency-row'},button(p.evidence_id,()=>proof(run,p.evidence_id),'btn btn-ghost btn-small'),
      el('p',{},`${p.evidence_type} · 采集状态 ${p.status} · 来源 ${p.source_type} / ${p.source_id}`),
      el('p',{},`点位 ${p.checkpoint_id||'—'} · 区域 ${p.zone_id||p.value_json?.zone_id||'—'} · 复核 ${p.review_id||'—'}`),
      ...['observed_at','retrieved_at','created_at','valid_until'].map(k=>el('p',{class:'field-hint'},`${k}：${p[k]||'未提供'}`)),
      el('pre',{},JSON.stringify(p.value_json,null,2)));
  }
  function references(run,dep){return evidenceLinks(run,dep.evidence_refs,{el,button,proof});}
  function render(){
    const run=getRun();title.textContent=kind==='coverage'?'覆盖与阻塞':'本次判断证据';body.dataset.runId=run?.run_id||'';
    if(!run){body.replaceChildren(el('p',{class:'empty-state'},'尚未选择已完成的现实运行。请在“轮次与任务”生成判断，或从运行历史采用保存结果。'));return;}
    body.replaceChildren(el('code',{class:'run-id'},run.run_id),el('p',{class:'field-hint'},`冻结运行 · ${run.inspection_round_id} · 判断截止 ${run.as_of}；所有内容来自本次运行保存的结果，不随实时观察改变。`));
    if(kind==='coverage'){
      const coverage=run.coverage,access=accessDependency(run);
      body.append(el('h3',{},'区域与点位覆盖'),el('p',{},`必检覆盖 ${coverage.covered} / ${coverage.required} · 窗口 ${coverage.window_start} — ${coverage.window_end}`));
      for(const zone of new Set(coverage.points.map(p=>p.zone_id))){
        body.append(el('h4',{},zone),...coverage.points.filter(p=>p.zone_id===zone).map(p=>el('section',{class:'dependency-row'},
          el('strong',{},`${p.checkpoint_id} · ${p.required?'必检点':'普通点'} · ${p.covered?'已覆盖':'未覆盖'}`),
          el('p',{class:'field-hint'},`设施 ${p.facility_id} · 现场记录 ${(p.inspection_refs||[]).join('、')||'无'}`))));
      }
      body.append(el('h3',{},'有效业务访问 · T1.access'),el('p',{'data-effective-access':access?.status||'unknown'},access?`${dependencyLabels[access.status]||'未知'}：${access.reason}`:'未知：本次运行未提供访问依赖结果。'));
      if(access){body.append(references(run,access));if(access.point_ids?.length)body.append(el('p',{},'依赖输出的拒绝点位：'+access.point_ids.join('、')));}
      body.append(el('h3',{},'原始访问采集证据'),el('p',{class:'field-hint'},'以下仅为冻结采集记录，可能过期、失败或相互冲突；原始 ALLOWED / DENIED 不代表有效业务结果。以上 T1.access 为唯一依赖结论。'));
      const acquired=run.evidence.filter(p=>p.evidence_type==='zone_access');body.append(pagedItems(acquired,p=>evidenceRow(run,p),{el,button,label:'区域访问证据',emptyText:'没有原始区域访问记录。'}));
      body.append(el('h3',{},'阻塞与待确认依赖'));
      const unresolved=run.task_results.flatMap(t=>t.checks.filter(d=>d.status!=='satisfied').map(d=>({task:t.task_id,dep:d})));
      body.append(...(unresolved.length?unresolved.map(({task,dep})=>el('section',{class:'dependency-row'},el('h4',{},`${task} / ${dep.dependency_id} · ${dependencyLabels[dep.status]||'未知'}`),el('p',{},dep.reason),references(run,dep))):[el('p',{},'本次全部必要依赖已满足。')]));
    }else{
      body.append(el('h3',{},'本次证据集合'),el('p',{class:'field-hint'},'这里展示选定运行保存的证据；全局“记录与证据”可查看其他轮次及当前历史。'),pagedItems(run.evidence,p=>evidenceRow(run,p),{el,button,label:'本次证据集合',emptyText:'本次未保存证据。'}));
      body.append(el('h3',{},'冻结复核快照 review_snapshot'));
      const reviews=run.input_snapshot?.review_snapshot||[];
      body.append(pagedItems(reviews,review=>el('section',{class:'dependency-row'},el('pre',{},JSON.stringify(review,null,2)),button('查看当前实时复核详情（旧运行保持冻结）',()=>openReview(review.review_id),'btn btn-secondary')),{el,button,label:'冻结复核快照',emptyText:'本次冻结快照没有关联复核。'}));
    }
  }
  return {open(view){kind=view;trigger=document.activeElement;render();showDialog(dialog);close.focus();},sync(){if(dialog.open&&body.dataset.runId!==(getRun()?.run_id||''))render();}};
}
