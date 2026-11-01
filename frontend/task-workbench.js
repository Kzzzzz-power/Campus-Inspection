import {renderPlanning,renderComparison} from './planning-view.js';
import {allRounds} from './evidence-browser.js';
import {renderAssumptions} from './whatif-workbench.js';
const $=id=>document.getElementById(id);
const states={established:['成立','good'],blocked:['受阻','danger'],pending_verification:['待验证','warn'],unknown:['状态未知','muted']};
const depStates={satisfied:'已满足',unsatisfied:'未满足',unknown:'证据不足'};
export function adoptableReality(run){return !!run&&run.run_type==='reality'&&run.status==='completed';}
export function initTaskWorkbench({el,button,api,postJSON,showDialog,toast,onSelection,overlayChanged,onReview,onExistingReview,onGenerate,onChange}){
  let rounds=[],selectedRun=null,runRequest=null,prepareRequest=null,manualRequest=null,dirty=false,saving=false,manualRound=null,baselineRun=null;
  const panel=el('section',{class:'task-workbench','aria-labelledby':'task-heading'});
  const round=el('select',{id:'judgment-round'}),at=el('input',{id:'judgment-asof',type:'datetime-local',step:1});
  const variation=el('select',{id:'judgment-variation'},...[
    ['base','使用当前完整输入'],['ordinary','教学输入：排除普通点 C03'],['missing','教学输入：缺少必检点 C07'],['denied','教学输入：缺少 C07 且 Z3 拒绝进入']
  ].map(([value,text])=>el('option',{value},text)));
  const scenario=el('select',{id:'judgment-scenario'},...['S1','S2','S3','S5'].map((value,i)=>el('option',{value},[value+' · 稳定基线',value+' · C07 覆盖阻塞',value+' · 方案可行性',value+' · C03 证据不足与复核'][i])));
  const currentStatus=el('select',{id:'judgment-current-status'},...['','true','false'].map((value,i)=>el('option',{value},['使用场景原输入','教学：当前状态查询可用','教学：当前状态查询不可用'][i])));
  const statusControl=el('label',{class:'scenario-picker',hidden:true},'S5 · C03 当前状态查询（教学输入）',currentStatus,el('span',{class:'field-hint'},'查询成功只增加远程状态证据，不代表人工确认或解除异常。'));
  const minutes=el('input',{id:'planning-minutes',type:'number',min:0,max:1440,step:'any',placeholder:'不覆盖；S3 标准输入为 35'});
  const resourceInputs={};
  const planningControls=el('details',{class:'planning-controls'},el('summary',{},'教学条件输入（仅影响下一次现实运行）'));
  const planningGrid=el('div',{class:'judgment-controls'});
  planningGrid.append(el('label',{},'剩余时间（分钟）',minutes));
  for(const [key,name] of [['P1','P1'],['P2','P2'],['access_coordinator','临时访问协调人员'],['mobile_terminal','移动终端']]){
    const input=el('select',{'data-resource':key},...['','AVAILABLE','UNAVAILABLE','unknown'].map((value,i)=>el('option',{value},['使用原输入','可用','不可用','未取得证据'][i])));
    resourceInputs[key]=input;planningGrid.append(el('label',{},name,input));
  }
  const permission=el('select',{id:'planning-permission'},...['','ALLOWED','DENIED','unknown'].map((value,i)=>el('option',{value},['使用原输入','具备 Z3 权限','明确无 Z3 权限','未取得证据'][i])));
  const zoneAccess=el('select',{id:'judgment-zone-access'},...['','ALLOWED','DENIED'].map((value,i)=>el('option',{value},['使用原输入','ALLOWED · 允许进入','DENIED · 拒绝进入'][i])));
  planningGrid.append(el('label',{},'C07 / Z3 区域访问（下一次运行）',zoneAccess),el('label',{},'P2 的 Z3 权限',permission));
  planningControls.append(el('p',{class:'field-hint'},'SIMULATED 教学输入。S3 中 P2 不可用，案例未声明其当前 Z3 权限，保留未知。方案甲、丙的总耗时已包含访问协调。'),planningGrid);
  const planningResults=el('section',{id:'planning-results'}),comparison=el('section',{id:'planning-comparison'});
  const status=el('p',{id:'judgment-status',role:'status',class:'field-hint'},'请选择轮次；尚未生成正式判断。');
  const selection=el('div',{class:'judgment-controls'});
  for(const [text,input] of [['巡检轮次',round],['判断截止时间（本机时区）',at],['运行输入',variation]])selection.append(el('label',{},text,input));
  const taskList=el('div',{id:'task-results',class:'task-results'});
  const prepare=button('建立 S1 教学实例',prepareS1,'btn btn-secondary');prepare.id='prepare-s1';
  const reload=button('刷新轮次',loadRounds,'btn btn-ghost');reload.id='judgment-round-refresh';
  const manualButton=button('添加现场补证',openManual,'btn btn-secondary');manualButton.id='manual-evidence-open';
  panel.append(el('h2',{id:'task-heading'},'巡检任务判断'),el('p',{class:'field-hint'},'先计算，再解释。每次判断保存独立 run_id；新证据需要生成新运行。'),
    selection,el('label',{class:'scenario-picker'},'教学场景',scenario),statusControl,el('div',{class:'form-actions'},prepare,reload,manualButton),planningControls,status,taskList,planningResults,comparison);
  // Reuse the single task controller and its forms over the campus; no second run state.
  let workbenchDialog=null,generate=null,workbenchClose=null;
  if(document.getElementById('campus-stage')){
    workbenchDialog=el('dialog',{id:'campus-task-dialog',class:'run-dialog campus-task-dialog','aria-labelledby':'campus-task-title'});
    workbenchClose=button('关闭面板',()=>workbenchDialog.close(),'btn btn-ghost');workbenchClose.id='campus-task-close';
    generate=button('生成运行判断',()=>onGenerate?.(),'btn btn-primary');generate.id='campus-generate-run';
    workbenchDialog.append(el('header',{class:'drawer-header'},el('h2',{id:'campus-task-title'},'轮次、任务与方案'),workbenchClose),el('div',{class:'drawer-body'},panel),el('footer',{class:'campus-task-footer'},el('span',{},'新判断保存为独立运行；不修改设施状态。'),generate));
    document.body.append(workbenchDialog);
    workbenchDialog.addEventListener('close',()=>{overlayChanged();if(!document.querySelector('dialog[open]'))$('campus-tasks-open')?.focus({preventScroll:true});});
  }else document.querySelector('.overview-section').before(panel);
  function open(target='tasks'){
    if(workbenchDialog)showDialog(workbenchDialog);
    else panel.scrollIntoView({block:'start',behavior:'instant'});
    if(target==='plans')planningResults.scrollIntoView({block:'nearest',behavior:'instant'});
    else if(target.startsWith('T')){const item=taskList.querySelector('[data-task="'+target+'"]');if(item){item.open=true;item.scrollIntoView({block:'nearest',behavior:'instant'});item.querySelector('summary').focus();}}
  }
  round.append(el('option',{value:''},'未选择轮次'));
  const proofDialog=el('dialog',{id:'judgment-proof-dialog',class:'run-dialog','aria-labelledby':'judgment-proof-title'});
  const proofBody=el('div',{class:'drawer-body',id:'judgment-proof-body'});
  const proofClose=button('关闭',()=>proofDialog.close(),'btn btn-ghost');
  proofDialog.append(el('header',{class:'drawer-header'},el('h2',{id:'judgment-proof-title'},'判断证据'),proofClose),proofBody);
  const manualDialog=el('dialog',{id:'manual-evidence-dialog',class:'run-dialog','aria-labelledby':'manual-title'});
  const manualClose=button('关闭',()=>{if(!saving&&(!dirty||confirm('还有未提交的补证内容。关闭后保留输入，是否继续？')))manualDialog.close();},'btn btn-ghost');
  const form=el('form',{id:'manual-evidence-form',class:'drawer-body'});
  const fields={point:el('select',{name:'checkpoint_id',required:true}),person:el('input',{name:'inspector_id',required:true,maxLength:80}),
    observed:el('input',{name:'observed_at',type:'datetime-local',required:true,step:1}),
    kind:el('select',{name:'evidence_type'},el('option',{value:'field_note'},'现场补证说明'),el('option',{value:'review_confirmation'},'人工确认结论')),
    review:el('input',{name:'review_id',placeholder:'关联已有复核请求（确认结论必填）'}),
    conclusion:el('select',{name:'conclusion'},...['ruled_out','confirmed_abnormal','unable_to_confirm'].map((value,i)=>el('option',{value},['已排除异常','已确认异常','当前无法确认'][i]))),
    basis:el('textarea',{name:'basis',rows:3,placeholder:'从判断证据复制 evidence_id，每行一项'}),
    notes:el('textarea',{name:'notes',required:true,maxLength:2000,rows:3})};
  for(let i=1;i<=8;i++)fields.point.append(el('option',{value:'C'+String(i).padStart(2,'0')},'C'+String(i).padStart(2,'0')));
  const formGrid=el('div',{class:'form-grid'});
  [['点位',fields.point],['记录人',fields.person],['现场时间（本机时区）',fields.observed],['证据类型',fields.kind],['复核请求编号',fields.review],
   ['人工结论',fields.conclusion],['已有依据编号',fields.basis],['现场说明',fields.notes]].forEach(([text,input])=>formGrid.append(el('label',{class:'field'},text,input)));
  const save=el('button',{type:'submit',class:'btn btn-primary'},'保存补证'),message=el('p',{id:'manual-message',role:'status'});
  form.append(el('p',{id:'manual-round',class:'field-hint'}),formGrid,save,message);
  manualDialog.append(el('header',{class:'drawer-header'},el('h2',{id:'manual-title'},'现场补证'),manualClose),form);
  document.body.append(proofDialog,manualDialog);
  for(const dialog of [proofDialog,manualDialog])dialog.addEventListener('close',overlayChanged);
  function localTime(value){const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);}
  function changed(){selectedRun=null;runRequest=null;renderTasks(null,taskList);renderPlanning(null,planningResults,{el,button,proof});renderComparison(baselineRun,null,comparison,{el});status.textContent='输入已更改；尚未生成此输入的正式判断。';onChange?.();onSelection();}
  function syncCurrentStatus(){statusControl.hidden=round.value.split('.')[0]!=='S5';}
  round.addEventListener('change',()=>{const r=rounds.find(r=>r.round_id===round.value);if(r)at.value=localTime(r.window_end);variation.value='base';resetPlanning();syncCurrentStatus();changed();});
  at.addEventListener('change',changed);variation.addEventListener('change',()=>{runRequest=null;status.textContent='变更输入只影响下一次运行，已保存结果保持不变。';});
  function resetPlanning(){minutes.value='';permission.value='';zoneAccess.value='';currentStatus.value='';Object.values(resourceInputs).forEach(input=>input.value='');}
  for(const input of [minutes,permission,zoneAccess,...Object.values(resourceInputs)])input.addEventListener('input',()=>{runRequest=null;status.textContent='教学条件已更改；当前结果仍为已保存快照，生成新运行后才能比较。';});
  scenario.addEventListener('change',()=>{prepareRequest=null;prepare.textContent='建立 '+scenario.value+' 教学实例';});
  currentStatus.addEventListener('change',()=>{runRequest=null;status.textContent='查询教学输入已更改；生成新运行后生效，旧判断保持冻结。';});
  function query(){if(selectedRun)return '?'+new URLSearchParams({run_id:selectedRun.run_id});if(!round.value||!at.value)return '';return '?'+new URLSearchParams({inspection_round_id:round.value,as_of:new Date(at.value).toISOString()});}
  async function loadRounds(){reload.disabled=true;try{rounds=(await allRounds()).items;const prior=round.value;round.replaceChildren(el('option',{value:''},'未选择轮次'),...rounds.map(r=>el('option',{value:r.round_id},`${r.date} · ${r.round_id}${r.scenario_instance_id?' · 教学模拟':''}`)));round.value=rounds.some(r=>r.round_id===prior)?prior:'';if(round.value!==prior)currentStatus.value='';syncCurrentStatus();}catch(e){status.textContent='轮次读取失败：'+e.message+'，可重试。';}finally{reload.disabled=false;}}
  async function prepareS1(){if(prepare.disabled)return;prepare.disabled=true;scenario.disabled=true;prepareRequest??={scenario:scenario.value,payload:{instance_id:'web-'+crypto.randomUUID(),request_id:crypto.randomUUID()}};
    let saved=false;
    try{const data=await postJSON('/api/scenarios/'+prepareRequest.scenario+'/prepare',prepareRequest.payload);saved=true;prepareRequest=null;await loadRounds();
      if(!rounds.some(r=>r.round_id===data.inspection_round_id))throw Error('实例已保存，但轮次列表尚未读取成功，请刷新轮次。');
      round.value=data.inspection_round_id;at.value=localTime(data.as_of);variation.value='base';resetPlanning();syncCurrentStatus();changed();status.textContent=data.scenario_id+' 教学实例已保存（SIMULATED）；点击“生成运行判断”计算 T1–T5。';
    }catch(e){status.textContent=(saved?'实例保存已确认，后续读取失败：':'实例保存结果未确认，可原样重试：')+e.message;}finally{prepare.disabled=false;scenario.disabled=false;}}
  function request(){if(!round.value||!at.value)throw Error('请先选择轮次和判断截止时间，或建立 S1、S2、S3、S5 教学实例。');
    const r=rounds.find(r=>r.round_id===round.value),input_overrides={};
    if(variation.value==='ordinary')input_overrides.exclude_inspection_points=['C03'];
    if(['missing','denied'].includes(variation.value))input_overrides.exclude_inspection_points=['C07'];
    if(variation.value==='denied')input_overrides.zone_access=[{zone_id:'Z3',access:'DENIED'}];
    if(zoneAccess.value)input_overrides.zone_access=[{zone_id:'Z3',access:zoneAccess.value}];
    if(minutes.value!==''){if(!minutes.checkValidity())throw Error('剩余时间应为 0–1440 分钟。');input_overrides.remaining_minutes=Number(minutes.value);}
    for(const [key,input] of Object.entries(resourceInputs))if(input.value){input_overrides.resources??={};input_overrides.resources[key]=input.value==='unknown'?null:input.value;}
    if(permission.value)input_overrides.p2_z3_access=permission.value==='unknown'?null:permission.value;
    if(round.value.split('.')[0]==='S5'&&currentStatus.value)input_overrides.current_status_available=currentStatus.value==='true';
    return runRequest??= {request_id:crypto.randomUUID(),inspection_round_id:round.value,as_of:new Date(at.value).toISOString(),
      scenario_id:r?.scenario_instance_id?round.value.split('.')[0]:null,run_type:'reality',input_overrides};}
  function accept(run){if(!adoptableReality(run))return false;selectedRun=run;runRequest=null;round.value=run.inspection_round_id;at.value=localTime(run.as_of);
    if(['S1','S2','S3','S5'].includes(run.scenario_id)){scenario.value=run.scenario_id;prepare.textContent='建立 '+scenario.value+' 教学实例';}
    zoneAccess.value=run.input_snapshot.input_overrides?.zone_access?.find(z=>z.zone_id==='Z3')?.access||'';
    const currentStatusOverride=run.input_snapshot.input_overrides?.current_status_available;
    currentStatus.value=run.scenario_id==='S5'&&typeof currentStatusOverride==='boolean'?String(currentStatusOverride):'';syncCurrentStatus();
    status.textContent=`已保存 ${run.run_id} · ${run.input_snapshot.round.scenario_instance_id?'教学模拟 · ':''}固定窗口 09:00–09:45（Asia/Shanghai）。当前显示冻结判断。`;
    renderTasks(run,taskList);renderPlanning(run,planningResults,{el,button,proof});renderComparison(baselineRun,run,comparison,{el});onChange?.();}
  function proof(run,id){const p=run.evidence.find(p=>p.evidence_id===id);if(!p){toast('此运行未关联该证据。',true);return;}
    proofBody.replaceChildren(el('code',{},p.evidence_id),el('p',{},`取得状态：${p.status} · 来源：${p.source_type} · ${p.source_id}`),
      el('p',{},`点位：${p.checkpoint_id||'不适用'} · 复核：${p.review_id||'无'} · 轮次：${p.inspection_round_id||'运行探针'}`),
      ...['observed_at','retrieved_at','created_at','valid_until'].filter(k=>p[k]).map(k=>el('p',{},`${k}：${p[k]}`)),
      el('h3',{},'业务内容'),el('pre',{},JSON.stringify(p.value_json,null,2)),el('h3',{},'来源记录'),el('pre',{},JSON.stringify(p.provenance_json,null,2)));
    showDialog(proofDialog);}
  function renderTasks(run,target){if(!run){target.replaceChildren(el('p',{class:'empty-state'},'尚无选定判断。现场记录、设施状态和任务判断是不同信息。'));return;}
    target.replaceChildren(...run.task_results.map(task=>{
      const [label,tone]=states[task.state],details=el('details',{class:'task-result','data-task':task.task_id});
      details.append(el('summary',{},el('strong',{},task.task_id+' · '+task.name),el('span',{class:'status-badge is-'+tone},label)),el('p',{},task.reason));
      if(run.scenario_id==='S5'&&task.task_id==='T2'){
        details.append(el('p',{class:'field-hint'},'C03 当前证据与历史确认分别判断；旧确认过期不能作为本次人工确认，当前查询成功也不能代替现场复核。'));
        for(const evidence of run.evidence.filter(p=>p.checkpoint_id==='C03'&&['current_status','review_confirmation'].includes(p.evidence_type)))details.append(el('p',{class:'field-hint'},`${evidence.evidence_type==='current_status'?'当前状态查询':'人工确认'}：${evidence.status} · 有效截至 ${evidence.valid_until||'未提供'} · ${evidence.evidence_id}`));
      }
      for(const dep of task.checks){const row=el('section',{class:'dependency-row'},el('h4',{},`${dep.dependency_id} · ${depStates[dep.status]}`),el('p',{},dep.reason));
        row.append(el('div',{class:'evidence-links'},...dep.evidence_refs.map(id=>button(id,()=>proof(run,id),'btn btn-ghost btn-small'))));details.append(row);}
      if(run.run_type==='what_if')details.append(el('p',{class:'field-hint'},'父现实任务状态；假设条件不表示任务已恢复，推演不能发起现场复核。'));
      else {
        const reviews=run.input_snapshot.review_snapshot||[];
        const applicable=reviews.filter(r=>r.task_id===task.task_id&&(run.scenario_id!=='S5'||task.task_id!=='T2'||r.point_id==='C03'));
        for(const review of applicable){const entry=button('查看已有复核',()=>onExistingReview?.(review.review_id),'btn btn-secondary');entry.dataset.existingReviewId=review.review_id;details.append(el('p',{class:'field-hint'},`冻结复核快照：${review.point_id} · ${review.status} · ${review.review_id}；打开后查看当前实时详情，旧 run 不变。`),entry);}
        if(!applicable.some(r=>r.status==='pending'))details.append(button('发起现场复核',()=>onReview(run,task.task_id),'btn btn-secondary'));
      }
      if(task.limitations?.length)details.append(el('p',{class:'field-hint'},task.limitations.join('；')));
      return details;
    }));}
  function renderRun(run,target){const box=el('div'),plans=el('section');renderTasks(run,box);renderPlanning(run,plans,{el,button,proof});target.replaceChildren(el('code',{class:'run-id'},run.run_id),
      el('p',{},`${run.summary} · 规则 ${run.rule_version}`),el('p',{class:'field-hint'},`判断截止 ${run.as_of} · 完成 ${run.completed_at}`),
      el('button',{type:'button',class:'btn btn-secondary','data-run-adopt':'',onclick:()=>{accept(run);$('run-dialog').close();onSelection();open();}},'在 3D 工作台查看此运行'),el('button',{type:'button',class:'btn btn-secondary','data-run-baseline':'',onclick:()=>{baselineRun=run;renderComparison(baselineRun,selectedRun,comparison,{el});toast('已设为对比基准：'+run.run_id);}},'设为对比基准'),box,plans,
      el('p',{class:'field-hint'},'任务成立不等于设施正常。本结果为教学判断，不替代安全检查、专业诊断、维修验收或正式销号。'));
    if(run.run_type==='what_if'){
      target.querySelectorAll('[data-run-adopt],[data-run-baseline]').forEach(node=>node.remove());
      const assumptions=el('section'),comparison=el('section');renderAssumptions(run,assumptions,{el});target.prepend(assumptions);target.append(comparison);
      const loadParent=async()=>{comparison.replaceChildren(el('p',{class:'field-hint'},'正在读取父现实快照…'));try{const parent=await api('/api/runs/'+encodeURIComponent(run.parent_run_id));if(target.querySelector('.run-id')?.textContent!==run.run_id)return;renderComparison(parent,run,comparison,{el});}catch(e){if(target.querySelector('.run-id')?.textContent!==run.run_id)return;comparison.replaceChildren(el('p',{class:'error-state'},'父现实读取失败：'+e.message),button('重试读取父现实',loadParent,'btn btn-secondary'));}};loadParent();
    }
  }
  function openManual(){if(!round.value){toast('请先选择归属轮次。',true);round.focus();return;}
    if(!dirty){manualRound=round.value;fields.observed.value=at.value;message.textContent='';}
    $('manual-round').textContent='归属轮次：'+manualRound+'。补证不自动修改已保存运行；保存后请重新生成判断。';showDialog(manualDialog);}
  form.addEventListener('input',()=>{dirty=true;manualRequest=null;});
  manualDialog.addEventListener('cancel',e=>{if(saving||(dirty&&!confirm('关闭后保留未提交内容，是否继续？')))e.preventDefault();});
  window.addEventListener('beforeunload',e=>{if(dirty||saving){e.preventDefault();e.returnValue='';}});
  form.addEventListener('submit',async event=>{event.preventDefault();if(saving||!form.reportValidity())return;
    const isConfirmation=fields.kind.value==='review_confirmation';
    manualRequest??={request_id:crypto.randomUUID(),inspection_round_id:manualRound,checkpoint_id:fields.point.value,
      inspector_id:fields.person.value,observed_at:new Date(fields.observed.value).toISOString(),notes:fields.notes.value,
      evidence_type:fields.kind.value,status:'ok',review_id:fields.review.value.trim()||null,
      value_json:isConfirmation?{conclusion:fields.conclusion.value,basis_evidence_ids:fields.basis.value.split(/[\s,]+/).filter(Boolean)}:{notes:fields.notes.value}};
    saving=true;const controls=[...form.querySelectorAll('input,select,textarea,button')];controls.forEach(c=>c.disabled=true);manualClose.disabled=true;message.textContent='正在等待服务端保存确认…';
    try{const data=await postJSON('/api/evidence/manual',manualRequest);dirty=false;manualRequest=null;message.textContent='保存已确认：'+data.evidence.evidence_id+'。请生成新运行重新判断。';}
    catch(e){message.textContent='保存结果未确认，输入已保留，可原样重试：'+e.message;}
    finally{saving=false;controls.forEach(c=>c.disabled=false);manualClose.disabled=false;}
  });
  renderTasks(null,taskList);loadRounds();
  function busy(value){for(const control of [round,at,variation,scenario,currentStatus,minutes,permission,...Object.values(resourceInputs),prepare,reload,manualButton,generate].filter(Boolean))control.disabled=value;if(generate){generate.textContent=value?'正在生成…':'生成运行判断';generate.setAttribute('aria-busy',String(value));}}
  return {open,query,request,accept,renderRun,busy,proof,get selectedRun(){return selectedRun;}};
}
