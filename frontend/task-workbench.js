import {allRounds} from './evidence-browser.js';
const $=id=>document.getElementById(id);
const states={established:['成立','good'],blocked:['受阻','danger'],pending_verification:['待验证','warn'],unknown:['状态未知','muted']};
const depStates={satisfied:'已满足',unsatisfied:'未满足',unknown:'证据不足'};
export function initTaskWorkbench({el,button,api,postJSON,showDialog,toast,onSelection,overlayChanged}){
  let rounds=[],selectedRun=null,runRequest=null,prepareRequest=null,manualRequest=null,dirty=false,saving=false,manualRound=null;
  const panel=el('section',{class:'task-workbench','aria-labelledby':'task-heading'});
  const round=el('select',{id:'judgment-round'}),at=el('input',{id:'judgment-asof',type:'datetime-local',step:1});
  const variation=el('select',{id:'judgment-variation'},...[
    ['base','使用当前完整输入'],['ordinary','教学输入：排除普通点 C03'],['missing','教学输入：缺少必检点 C07'],['denied','教学输入：缺少 C07 且 Z3 拒绝进入']
  ].map(([value,text])=>el('option',{value},text)));
  const status=el('p',{id:'judgment-status',role:'status',class:'field-hint'},'请选择轮次；尚未生成正式判断。');
  const selection=el('div',{class:'judgment-controls'});
  for(const [text,input] of [['巡检轮次',round],['判断截止时间（本机时区）',at],['运行输入',variation]])selection.append(el('label',{},text,input));
  const taskList=el('div',{id:'task-results',class:'task-results'});
  const prepare=button('建立 S1 教学实例',prepareS1,'btn btn-secondary');prepare.id='prepare-s1';
  const reload=button('刷新轮次',loadRounds,'btn btn-ghost');reload.id='judgment-round-refresh';
  const manualButton=button('添加现场补证',openManual,'btn btn-secondary');manualButton.id='manual-evidence-open';
  panel.append(el('h2',{id:'task-heading'},'巡检任务判断'),el('p',{class:'field-hint'},'先计算，再解释。每次判断保存独立 run_id；新证据需要生成新运行。'),
    selection,el('div',{class:'form-actions'},prepare,reload,manualButton),status,taskList);
  document.querySelector('.overview-section').before(panel);
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
  function changed(){selectedRun=null;runRequest=null;renderTasks(null,taskList);status.textContent='输入已更改；尚未生成此输入的正式判断。';onSelection();}
  round.addEventListener('change',()=>{const r=rounds.find(r=>r.round_id===round.value);if(r)at.value=localTime(r.window_end);variation.value='base';changed();});
  at.addEventListener('change',changed);variation.addEventListener('change',()=>{runRequest=null;status.textContent='变更输入只影响下一次运行，已保存结果保持不变。';});
  function query(){if(selectedRun)return '?'+new URLSearchParams({run_id:selectedRun.run_id});if(!round.value||!at.value)return '';return '?'+new URLSearchParams({inspection_round_id:round.value,as_of:new Date(at.value).toISOString()});}
  async function loadRounds(){reload.disabled=true;try{rounds=(await allRounds()).items;const prior=round.value;round.replaceChildren(el('option',{value:''},'未选择轮次'),...rounds.map(r=>el('option',{value:r.round_id},`${r.date} · ${r.round_id}${r.scenario_instance_id?' · 教学模拟':''}`)));round.value=rounds.some(r=>r.round_id===prior)?prior:'';}catch(e){status.textContent='轮次读取失败：'+e.message+'，可重试。';}finally{reload.disabled=false;}}
  async function prepareS1(){if(prepare.disabled)return;prepare.disabled=true;prepareRequest??={instance_id:'web-'+crypto.randomUUID(),request_id:crypto.randomUUID()};
    let saved=false;
    try{const data=await postJSON('/api/scenarios/S1/prepare',prepareRequest);saved=true;prepareRequest=null;await loadRounds();
      if(!rounds.some(r=>r.round_id===data.inspection_round_id))throw Error('实例已保存，但轮次列表尚未读取成功，请刷新轮次。');
      round.value=data.inspection_round_id;at.value=localTime(data.as_of);variation.value='base';changed();status.textContent='S1 教学实例已保存（SIMULATED）；点击“生成运行判断”计算 T1–T5。';
    }catch(e){status.textContent=(saved?'实例保存已确认，后续读取失败：':'实例保存结果未确认，可原样重试：')+e.message;}finally{prepare.disabled=false;}}
  function request(){if(!round.value||!at.value)throw Error('请先选择轮次和判断截止时间，或建立 S1 教学实例。');
    const r=rounds.find(r=>r.round_id===round.value),input_overrides={};
    if(variation.value==='ordinary')input_overrides.exclude_inspection_points=['C03'];
    if(['missing','denied'].includes(variation.value))input_overrides.exclude_inspection_points=['C07'];
    if(variation.value==='denied')input_overrides.zone_access=[{zone_id:'Z3',access:'DENIED'}];
    return runRequest??= {request_id:crypto.randomUUID(),inspection_round_id:round.value,as_of:new Date(at.value).toISOString(),
      scenario_id:r?.scenario_instance_id?'S1':null,run_type:'reality',input_overrides};}
  function accept(run){selectedRun=run;runRequest=null;round.value=run.inspection_round_id;at.value=localTime(run.as_of);
    status.textContent=`已保存 ${run.run_id} · ${run.input_snapshot.round.scenario_instance_id?'教学模拟 · ':''}固定窗口 09:00–09:45（Asia/Shanghai）。当前显示冻结判断。`;
    renderTasks(run,taskList);}
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
      for(const dep of task.checks){const row=el('section',{class:'dependency-row'},el('h4',{},`${dep.dependency_id} · ${depStates[dep.status]}`),el('p',{},dep.reason));
        row.append(el('div',{class:'evidence-links'},...dep.evidence_refs.map(id=>button(id,()=>proof(run,id),'btn btn-ghost btn-small'))));details.append(row);}
      if(task.limitations?.length)details.append(el('p',{class:'field-hint'},task.limitations.join('；')));
      return details;
    }));}
  function renderRun(run,target){const box=el('div');renderTasks(run,box);target.replaceChildren(el('code',{class:'run-id'},run.run_id),
      el('p',{},`${run.summary} · 规则 ${run.rule_version}`),el('p',{class:'field-hint'},`判断截止 ${run.as_of} · 完成 ${run.completed_at}`),
      button('在主工作台查看此运行',()=>{accept(run);$('run-dialog').close();onSelection();panel.scrollIntoView({block:'start',behavior:'instant'});}),box,
      el('p',{class:'field-hint'},'任务成立不等于设施正常。本结果为教学判断，不替代安全检查、专业诊断、维修验收或正式销号。'));
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
  function busy(value){for(const control of [round,at,variation,prepare,reload,manualButton])control.disabled=value;}
  return {query,request,accept,renderRun,busy,get selectedRun(){return selectedRun;}};
}
