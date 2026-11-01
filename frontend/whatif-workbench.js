import {renderComparison,renderPlanning} from './planning-view.js';

export function eligibleParent(run){return !!run&&run.status==='completed'&&run.run_type==='reality'&&run.scenario_id==='S3';}
export function assumptionLines(assumptions={}){
  const values={AVAILABLE:'可用',UNAVAILABLE:'不可用',ALLOWED:'允许',DENIED:'拒绝'};
  const lines=[];
  if(Object.hasOwn(assumptions,'remaining_minutes'))lines.push('剩余时间：'+assumptions.remaining_minutes+' 分钟');
  for(const [key,value] of Object.entries(assumptions.resources||{}))lines.push(({access_coordinator:'访问协调人员',mobile_terminal:'移动终端'}[key]||key)+'：'+(values[value]||'未知'));
  if(Object.hasOwn(assumptions,'p2_z3_access'))lines.push('P2 的 Z3 权限：'+(values[assumptions.p2_z3_access]||'未知'));
  return lines;
}
export function readAssumptions(minutes,resources,permission){
  const result={};
  if(minutes!==''){const value=Number(minutes);if(!Number.isFinite(value)||value<0||value>1440)throw Error('剩余时间应为 0–1440 分钟。');result.remaining_minutes=value;}
  for(const [key,value] of Object.entries(resources))if(value){result.resources??={};result.resources[key]=value==='unknown'?null:value;}
  if(permission)result.p2_z3_access=permission==='unknown'?null:permission;
  return result;
}
export function renderAssumptions(run,target,{el}){
  target.append(el('h3',{},'假设条件（未发生的教学推演）'),el('ul',{},...assumptionLines(run.assumptions).map(line=>el('li',{},line))));
}
export function initWhatifWorkbench({el,button,api,postJSON,showDialog,overlayChanged,getRun,openTasks,onSaved,proof}){
  let parent=null,presets=[],session=0,pending=false,request=null,savePending=false,unconfirmed=false;
  const entry=button('条件推演',open,'btn btn-secondary');entry.id='campus-whatif-open';
  document.querySelector('.campus-business-actions')?.append(entry);
  const dialog=el('dialog',{id:'whatif-dialog',class:'run-dialog','aria-labelledby':'whatif-title'});
  const close=button('关闭面板',()=>dialog.close(),'btn btn-ghost');close.id='whatif-close';
  const context=el('p',{id:'whatif-context',class:'field-hint'}),status=el('p',{id:'whatif-status',role:'status',class:'field-hint'});
  const preset=el('select',{id:'whatif-preset'}),minutes=el('input',{id:'whatif-minutes',type:'number',min:0,max:1440,step:'any'});
  const controls=el('div',{class:'judgment-controls'}),resources={};
  controls.append(el('label',{},'推演预设',preset),el('label',{},'假设剩余时间（分钟；空白继承父现实）',minutes));
  for(const key of ['P1','P2','access_coordinator','mobile_terminal']){
    resources[key]=el('select',{'data-whatif-resource':key},...['','AVAILABLE','UNAVAILABLE','unknown'].map((value,i)=>el('option',{value},['继承父现实','假设可用','假设不可用','假设未知'][i])));
    controls.append(el('label',{},({access_coordinator:'访问协调人员',mobile_terminal:'移动终端'}[key]||key),resources[key]));
  }
  const permission=el('select',{id:'whatif-permission'},...['','ALLOWED','DENIED','unknown'].map((value,i)=>el('option',{value},['继承父现实','假设允许','假设拒绝','假设未知'][i])));
  controls.append(el('label',{},'假设 P2 的 Z3 权限',permission));
  const submit=el('button',{id:'whatif-submit',type:'submit',class:'btn btn-primary'},'保存条件推演');
  const retry=button('重试读取预设',loadPresets,'btn btn-secondary');retry.id='whatif-retry';retry.hidden=true;
  const restart=button('开始新的推演',()=>{
    if(savePending)return;
    if(unconfirmed&&!confirm('此请求的保存结果尚未确认，服务端可能已经保存。放弃后不能继续原样重试；请先从运行历史核对。确定放弃此请求并开始新推演？'))return;
    request=null;unconfirmed=false;open();
  },'btn btn-secondary');restart.id='whatif-restart';restart.hidden=true;
  const tasks=button('前往轮次与任务',()=>{dialog.close();openTasks();},'btn btn-secondary');tasks.id='whatif-tasks-open';
  const output=el('section',{id:'whatif-output','aria-live':'polite'});
  const form=el('form',{},el('p',{class:'field-hint'},'SIMULATED 假设条件仅影响子运行方案；不改变父现实任务、看板或设施标记。'),controls,submit);
  dialog.append(el('header',{class:'drawer-header'},el('h2',{id:'whatif-title'},'条件推演'),close),el('div',{class:'drawer-body'},context,tasks,form,status,retry,restart,output));
  document.body.append(dialog);
  function lock(value){pending=value;for(const input of form.querySelectorAll('input,select,button'))input.disabled=value||unconfirmed||!parent;submit.disabled=value||!parent||!presets.length;retry.disabled=value;submit.setAttribute('aria-busy',String(value));submit.textContent=savePending?'正在等待原请求确认…':unconfirmed?'原样重试未确认请求':'保存条件推演';restart.hidden=!request;restart.disabled=savePending;restart.textContent=unconfirmed?'放弃未确认请求并开始新推演':'开始新的推演';}
  function edited(){if(savePending||unconfirmed)return;request=null;output.replaceChildren();status.textContent='假设条件已更改；请保存为新的推演运行。';lock(false);}
  function applyPreset(){if(savePending||unconfirmed)return;const a=presets.find(p=>p.id===preset.value)?.assumptions||{};minutes.value=a.remaining_minutes??'';permission.value=Object.hasOwn(a,'p2_z3_access')?(a.p2_z3_access??'unknown'):'';for(const [key,input] of Object.entries(resources))input.value=Object.hasOwn(a.resources||{},key)?(a.resources[key]??'unknown'):'';edited();}
  preset.addEventListener('change',applyPreset);
  for(const input of [minutes,permission,...Object.values(resources)])input.addEventListener('input',edited);
  async function loadPresets(){const token=session;lock(true);status.textContent='正在读取推演预设…';retry.hidden=true;
    try{const data=await api('/api/scenarios/S4');if(token!==session||!dialog.open)return;presets=data.presets||[];if(!presets.length)throw Error('未返回推演预设');preset.replaceChildren(...presets.map(p=>el('option',{value:p.id},p.id+' · '+p.label)));applyPreset();status.textContent='选择预设或编辑假设，再明确提交。';}
    catch(e){if(token!==session||!dialog.open)return;status.textContent='预设读取失败，可重试：'+e.message;retry.hidden=false;}
    finally{if(token===session){lock(false);submit.disabled=!parent||!presets.length;}}
  }
  function open(){session++;
    if(request){showDialog(dialog);lock(savePending);return;}
    parent=eligibleParent(getRun())?structuredClone(getRun()):null;presets=[];request=null;output.replaceChildren();status.textContent='';preset.replaceChildren();minutes.value='';permission.value='';Object.values(resources).forEach(i=>i.value='');retry.hidden=true;
    context.textContent=parent?'已锁定父现实运行：'+parent.run_id+' · 截止 '+parent.as_of:'请在轮次与任务中生成或选择已完成的 S3 现实运行，再打开条件推演。';
    showDialog(dialog);lock(false);if(parent)loadPresets();else submit.disabled=true;
  }
  dialog.addEventListener('close',()=>{session++;overlayChanged();entry.focus({preventScroll:true});});
  form.addEventListener('submit',async event=>{event.preventDefault();if(pending||!parent||!form.reportValidity())return;
    try{request??={request_id:crypto.randomUUID(),scenario_id:'S4',run_type:'what_if',parent_run_id:parent.run_id,input_overrides:{},assumptions:readAssumptions(minutes.value,Object.fromEntries(Object.entries(resources).map(([key,input])=>[key,input.value])),permission.value)};}catch(e){status.textContent=e.message;return;}
    const submitted=request;savePending=true;lock(true);status.textContent='正在等待原请求保存确认；关闭后可重新打开查看，同一请求不会重复提交。';
    try{const run=await postJSON('/api/runs',submitted);if(request!==submitted)return;unconfirmed=false;onSaved?.();
      output.replaceChildren(el('code',{id:'whatif-run-id',class:'run-id'},run.run_id));renderAssumptions(run,output,{el});const compare=el('section'),plans=el('section');renderComparison(parent,run,compare,{el});renderPlanning(run,plans,{el,button,proof});output.append(compare,plans);status.textContent='推演已保存；当前选定现实运行保持不变。';
    }catch(e){if(request===submitted){unconfirmed=true;status.textContent='保存结果未确认，原父运行、假设输入和请求标识已保留，可原样重试。修改前须明确放弃未确认请求；服务端可能已经保存：'+e.message;}}
    finally{if(request===submitted){savePending=false;lock(false);}}
  });
  return {open};
}
