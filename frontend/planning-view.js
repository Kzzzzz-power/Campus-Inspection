// Candidate feasibility is calculated by the backend; this module only presents it.
const labels={executable:['可执行','good'],not_executable:['不可执行','danger'],unknown:['无法确认','muted']};
const checks={satisfied:'已满足',unsatisfied:'未满足',unknown:'证据不足'};
export function planLabel(run,state){const label=(labels[state]||labels.unknown)[0];return run?.run_type==='what_if'?'推演条件下'+label:label;}
export function renderPlanning(run,target,{el,button,proof}){
  target.replaceChildren();
  if(!run)return;
  target.append(el('h3',{},'当前阻塞'));
  if(!run.blockers?.length)target.append(el('p',{class:'field-hint'},run.implementation_stage>=4?'本次判断没有明确未满足的依赖；证据不足请查看任务检查项。':'历史运行未保存结构化阻塞明细，请查看任务依赖。'));
  for(const item of run.blockers||[]){
    target.append(el('article',{class:'blocker-card'},el('strong',{},`${item.task_id} · ${item.dependency_id} · ${item.point_ids.join('、')||'任务依赖'}`),
      el('p',{},item.reason),el('div',{class:'evidence-links'},...item.evidence_refs.map(id=>button(id,()=>proof(run,id),'btn btn-ghost btn-small')))));
  }
  target.append(el('h3',{},'候选方案可行性'),el('p',{class:'field-hint'},'可执行只表示输入条件满足，补检尚未发生。以下耗时为案例教学估计，不是实时路线计算，也不会自动派单或完成任务。'));
  if(!run.plan_results?.length){target.append(el('p',{class:'empty-state'},'此运行未提供方案执行条件。建立 S3 教学实例可查看甲、乙、丙的比较。'));return;}
  target.append(el('p',{class:'field-hint'},'甲、乙、丙是候选方案，人员编号为 P1、P2。若要改变执行条件，在“教学条件输入”调整人员、权限和剩余时间后生成新运行；仅作假设时使用“条件推演”。'));
  const grid=el('div',{class:'plan-grid'});
  for(const plan of run.plan_results){
    const [,tone]=labels[plan.state]||labels.unknown,label=planLabel(run,plan.state);
    const detail=el('details',{class:'plan-checks'},el('summary',{},'查看执行条件与判断证据'));
    for(const check of plan.checks)detail.append(el('section',{class:'dependency-row'},el('strong',{},checks[check.status]),el('p',{},check.reason),
      el('div',{class:'evidence-links'},...check.evidence_refs.map(id=>button(id,()=>proof(run,id),'btn btn-ghost btn-small')))));
    grid.append(el('article',{class:'plan-card','data-plan':plan.plan_id},el('div',{class:'plan-heading'},el('h4',{},plan.name),el('span',{class:'status-badge is-'+tone},label)),
      el('p',{class:'plan-duration'},`${plan.estimated_minutes} 分钟`),el('p',{},plan.description),el('p',{},plan.reason),detail));
  }
  target.append(grid);
}
export function renderComparison(base,current,target,{el}){
  target.replaceChildren();if(!base)return;
  const hypothetical=current?.run_type==='what_if';
  target.append(el('h3',{},hypothetical?'父现实与条件推演对比':'运行对比'),el('p',{class:'field-hint'},hypothetical?'父现实任务状态保持不变；子运行仅独立计算假设条件下的方案，不代表补检或恢复。':'对比两份已保存的现实判断；不合并输入，不回写历史。'));
  const grid=el('div',{class:'run-comparison'});
  for(const [title,run] of [[hypothetical?'父现实运行':'基准运行',base],[hypothetical?'条件推演子运行':'当前运行',current]]){
    const box=el('article',{class:'comparison-card'},el('h4',{},title));
    if(!run){box.append(el('p',{},'生成或选择另一份运行后显示。'));grid.append(box);continue;}
    const superseded=new Set(run.input_snapshot?.overridden_parent_planning_evidence_ids||[]);
    const time=run.evidence.filter(e=>e.evidence_type==='time_budget'&&!superseded.has(e.evidence_id)).map(e=>e.status==='ok'?e.value_json?.remaining_minutes:'未知').join(' / ');
    box.append(el('code',{},run.run_id),el('p',{},`轮次 ${run.inspection_round_id}`),el('p',{},`截止 ${run.as_of}`),el('p',{},`剩余时间：${time||'未提供'} 分钟`),el('p',{},run.summary));
    if(run.parent_run_id)box.append(el('p',{},'父运行：'+run.parent_run_id));
    for(const plan of run.plan_results||[])box.append(el('p',{},`${plan.name}：${planLabel(run,plan.state)}`));
    for(const task of run.task_results.filter(t=>hypothetical||t.task_id==='T1'))box.append(el('p',{},(hypothetical?'父现实任务 ':'')+task.task_id+'：'+({established:'成立',blocked:'受阻',pending_verification:'待验证',unknown:'状态未知'}[task.state]||'未提供')));
    grid.append(box);
  }
  target.append(grid);
}
