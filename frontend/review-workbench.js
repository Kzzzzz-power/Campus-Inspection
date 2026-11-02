import {mountVoiceInput} from './voice-input.js';
const labels={pending:'待现场复核',completed:'材料已处理',timeout:'已超时',cancelled:'已取消'};
export function initReviewWorkbench({el,button,api,postJSON,showDialog,overlayChanged,getRun,openRun,openPhotos,refresh,onJudgment}){
  let saving=false,dirty=false,voiceInput=null,activeId=null;
  const dialog=el('dialog',{id:'review-dialog',class:'drawer','aria-labelledby':'review-title'}),body=el('div',{class:'drawer-body',id:'review-body'});
  const close=button('关闭',()=>{if(!saving)dialog.close();},'btn btn-ghost');
  dialog.append(el('header',{class:'drawer-header'},el('h2',{id:'review-title'},'现场复核'),close),body);document.body.append(dialog);
  dialog.addEventListener('cancel',e=>{if(saving)e.preventDefault();});
  dialog.addEventListener('close',()=>{voiceInput?.cancel();window.speechSynthesis?.cancel();overlayChanged();});
  window.addEventListener('beforeunload',e=>{if(dirty||saving){e.preventDefault();e.returnValue='';}});
  const entry=button('现场复核列表',()=>dirty?showDialog(dialog):list(),'btn btn-secondary');entry.id='review-list-open';document.querySelector('#pending-list').before(entry);
  function field(text,input){return el('label',{class:'field field-wide'},el('span',{},text),input);}
  function local(value){const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,23);}
  function actions(...items){return el('div',{class:'form-actions'},...items);}
  function status(text){return el('p',{role:'status',class:'form-message'},text);}
  async function previewPhoto(pointId,imageId){
    try{const data=await api('/api/points/'+encodeURIComponent(pointId));const index=(data.photos||[]).findIndex(p=>p.image_id===imageId);if(index<0)throw new Error('照片元数据不存在，请刷新复核详情。');openPhotos(data.photos,index);}
    catch(e){const notice=status(e.message);body.prepend(notice);notice.tabIndex=-1;notice.focus();}
  }
  function error(e){if(e.status===403)return '没有执行此操作的权限，请核对权限；草稿已保留。';return (e.status===409?'版本冲突；请刷新版本后核对重试。':'保存结果未确认，可原样重试。')+' '+e.message;}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)voiceInput?.cancel();});
  window.addEventListener('pagehide',()=>voiceInput?.cancel());
  async function list(){if(dirty&&!confirm('返回列表将放弃当前草稿，是否继续？'))return;voiceInput?.destroy();activeId=null;dirty=false;body.replaceChildren(status('正在读取复核请求…'));showDialog(dialog);
    try{const data=await api('/api/reviews');const filter=el('select',{'aria-label':'复核过程状态'},...['pending','all','completed','timeout','cancelled'].map(v=>el('option',{value:v},v==='all'?'全部过程状态':labels[v]))),items=el('div');
      function render(){const rows=data.items.filter(r=>filter.value==='all'||(r.effective_status||r.status)===filter.value);items.replaceChildren(...rows.map(r=>button(`${r.point_id} · ${r.task_id||'历史请求（未记录任务）'} · ${labels[r.effective_status||r.status]} · ${r.reason}`,()=>detail(r.review_id),'queue-item')), ...(!rows.length?[el('p',{class:'empty-state'},'此状态下没有复核请求。')]:[]));}
      filter.addEventListener('change',render);body.replaceChildren(field('复核过程状态',filter),items,actions(button('刷新列表',list,'btn btn-secondary')));render();
    }catch(e){body.replaceChildren(status('读取失败：'+e.message),button('重试',list));}}
  async function create(point=null,run=getRun(),taskId='T2'){
    if(dirty){showDialog(dialog);return;}
    body.replaceChildren(status('正在准备关联信息…'));showDialog(dialog);
    try{const points=(await api('/api/dashboard')).points;const form=el('form',{id:'review-create-form'}),selector=el('select',{name:'point_id',required:true},...points.map(p=>el('option',{value:p.point_id},`${p.point_id} · ${p.device} · ${p.zone_id}`)));
      if(point)selector.value=point.point_id;
      const task=el('select',{name:'task_id'},...['T1','T2','T3','T4','T5'].map(v=>el('option',{value:v},v)));task.value=taskId;
      const reason=el('textarea',{name:'reason',required:true,maxLength:1000,rows:3}),expires=el('input',{name:'expires_at',type:'datetime-local',step:0.001,required:true,value:local(Date.now()+86400000)}),message=status(''),save=el('button',{type:'submit',class:'btn btn-primary'},'创建复核请求');let request=null;
      save.disabled=!run;form.append(el('p',{class:'field-hint'},run?`原触发运行：${run.run_id} · 轮次 ${run.inspection_round_id}`:'请先关闭此窗口，生成或选择现实运行，再从点位或任务发起复核。'),field('设施点位 / 区域',selector),field('关联任务',task),field('复核需求',reason),field('截止时间（本机时区）',expires),el('p',{class:'field-hint'},'默认 24 小时为本系统工程默认，可调整，并非正式制度。'),message,actions(save));
      form.addEventListener('input',()=>{dirty=true;request=null;});
      form.addEventListener('submit',async e=>{e.preventDefault();if(saving||!form.reportValidity())return;request??={point_id:selector.value,task_id:task.value,reason:reason.value,expires_at:new Date(expires.value).toISOString(),trigger_run_id:run?.run_id||null,request_id:crypto.randomUUID()};
        await saveAction(form,message,async()=>{const data=await postJSON('/api/reviews',request);dirty=false;await detail(data.review.review_id,data.rerun);});});body.replaceChildren(form);
    }catch(e){body.replaceChildren(status(e.message),button('重试',()=>create(point,run,taskId)));}}
  async function saveAction(form,message,fn){saving=true;close.disabled=true;const controls=[...form.querySelectorAll('input,select,textarea,button')];controls.forEach(c=>c.disabled=true);message.textContent='正在等待服务端确认…';
    try{await fn();}catch(e){message.textContent=error(e);message.setAttribute('role','alert');}finally{saving=false;close.disabled=false;controls.forEach(c=>c.disabled=false);}}
  function speech(notes,form){voiceInput?.destroy();voiceInput=mountVoiceInput({notes,form,el,button});}
  function rerunResult(result,review){const box=el('section',{id:'review-rerun'});if(!result)return box;
    box.append(status(result.status==='completed'?'新 reality run 已保存：'+result.run_id:result.status==='failed'?'材料已保存，重新判断失败：'+result.error:'材料已保存；未关联触发运行，需选定轮次生成新判断。'));
    box.append(el('p',{class:'field-hint'},'主工作台仍显示原选定运行的冻结结果；业务提醒按补证后的新判断更新。点击查看新运行可检查依据；窗口后的补证不会补算旧轮次覆盖。'));if(result.run_id)box.append(button('查看新运行',()=>openRun(result.run_id),'btn btn-secondary'));
    if(result.status==='failed')box.append(button('重试重新判断',async()=>{try{const data=await postJSON(`/api/reviews/${review.review_id}/rerun`,{version:review.version});await onJudgment?.(review,data.rerun||data);box.replaceWith(rerunResult(data.rerun||data,review));refresh();}catch(e){box.append(status(e.message));}},'btn btn-secondary'));return box;}
  async function detail(id,result=null){if(dirty&&!confirm('切换详情将放弃当前草稿，是否继续？')){showDialog(dialog);return;}voiceInput?.destroy();activeId=id;body.replaceChildren(status('正在读取证据链…'));showDialog(dialog);
    try{const data=await api('/api/reviews/'+encodeURIComponent(id)),r=data.review;dirty=false;const effective=r.effective_status||r.status;
      const latest=data.new_runs?.find(item=>item.version===r.version);
      await onJudgment?.(r,result||(latest?.run_id?{status:'completed',run_id:latest.run_id}:null));
      const heading=el('section',{},el('h3',{},`${r.point_id} · ${labels[effective]}`),el('code',{},r.review_id),el('p',{},`设施 ${r.facility_id} / 区域 ${r.zone_id} / 任务 ${r.task_id||'历史请求（未记录任务）'}`),el('p',{},`原触发运行 ${r.trigger_run_id||'无'} · 轮次 ${r.inspection_round_id||'无'}`),el('p',{},`版本 ${r.version} · 截止 ${r.expires_at||'历史请求（未记录截止）'}`),el('p',{},r.reason),r.close_reason?el('p',{},'关闭原因：'+r.close_reason):null);
      const speak=button('朗读复核需求',()=>{speechSynthesis.cancel();const voice=new SpeechSynthesisUtterance(r.reason);voice.lang='zh-CN';speechSynthesis.speak(voice);},'btn btn-secondary');speak.disabled=!('speechSynthesis'in window);heading.append(speak);if(speak.disabled)heading.append(status('浏览器不支持朗读，请阅读上方复核需求。'));
      if(r.trigger_run_id)heading.append(button('查看原运行',()=>openRun(r.trigger_run_id),'btn btn-ghost'));
      body.replaceChildren(actions(button('返回复核列表',list,'btn btn-ghost')),heading,rerunResult(result,r));
      if(effective==='pending')body.append(evidenceForm(r),transitionForm(r));
      else body.append(el('p',{class:'field-hint'},'请求已结束，不再接收补证。过程状态不会直接判成设施故障。'));
      const evidence=el('section',{},el('h3',{},'证据链'));
      for(const e of data.evidence||[]){
        const value=e.value_json||{},isModel=e.source_type==='MODEL_OUTPUT';
        const description=isModel?(value.description||e.error||'尚未取得可用的模型输出'):value.notes||({ruled_out:'人工确认：已排除异常',confirmed_abnormal:'人工确认：已确认异常',unable_to_confirm:'人工确认：仍无法确认'})[value.conclusion]||'现场证据已保存';
        const row=el('article',{class:'record-item'},el('code',{},e.evidence_id),el('p',{},`${e.evidence_type} · ${e.source_type} · ${e.observed_at||e.created_at}`),el('p',{},description),el('details',{},el('summary',{},'查看证据字段'),el('pre',{},JSON.stringify(value,null,2))));
        if(isModel)row.append(el('p',{class:'field-hint'},'AI 辅助描述，需人工核对，不等于现场结论。'));
        for(const photo of value.photos||[]){const preview=button('',()=>previewPhoto(r.point_id,photo.image_id),'photo-thumb');preview.setAttribute('aria-label','预览复核照片及辅助摘要');preview.append(el('img',{src:photo.url||'/api/evidence/images/'+photo.image_id,alt:'已保存现场照片',loading:'lazy',style:'max-width:100%;max-height:180px;object-fit:contain'}));row.append(preview);}
        if(value.image_id)row.append(button('预览保存的照片',()=>previewPhoto(r.point_id,value.image_id),'btn btn-secondary'));
        evidence.append(row);
      }
      if(!data.evidence?.length)evidence.append(el('p',{class:'empty-state'},'尚无复核证据。'));
      body.append(evidence,el('h3',{},'后续运行'),...(data.new_runs||[]).map(run=>run.run_id?button(run.run_id,()=>openRun(run.run_id),'btn btn-ghost'):rerunResult({status:'failed',error:'版本 '+run.version+' 尚未取得新运行，可重试。'},{...r,version:run.version})));refresh();
    }catch(e){body.replaceChildren(status(result?'保存已确认，但详情读取失败：'+e.message+'。请刷新详情，不必重复提交材料。':e.message),...(result?.run_id?[button('查看已保存的新运行',()=>openRun(result.run_id),'btn btn-secondary')]:[]),button('刷新详情',()=>detail(id,result)));}}
  function evidenceForm(review){const form=el('form',{id:'review-evidence-form'}),person=el('input',{name:'inspector_id',required:true,maxLength:80}),time=el('input',{name:'inspected_at',type:'datetime-local',step:0.001,required:true,value:local(Math.max(Date.now(),Date.parse(review.created_at)))}),notes=el('textarea',{name:'notes',required:true,maxLength:2000,rows:3}),conclusion=el('select',{name:'conclusion',required:true},...['','normal','fault','unknown'].map((value,i)=>el('option',{value},['请选择人工结论','确认正常','确认异常','仍无法确认'][i]))),photos=el('input',{name:'photos',type:'file',accept:'image/jpeg,image/png,image/webp',capture:'environment',multiple:true}),confirm=el('input',{name:'onsite_confirmed',type:'checkbox',required:true,value:'true'}),message=status(''),submit=el('button',{type:'submit',class:'btn btn-primary'},'保存现场证据');let requestId=crypto.randomUUID(),version=review.version;
    form.append(el('h3',{},'现场补证'),field('记录人',person),field('现场时间（本机时区）',time),field('现场说明 / 转写草稿',notes));speech(notes,form);
    form.append(field('照片（手机可调用相机）',photos),el('p',{class:'field-hint'},'最多 5 张，每张 10MB。照片与人工结论分别保存；图片本身不代表已确认。'),field('人工确认结论',conclusion),el('label',{class:'check-field'},confirm,el('span',{},'我已到达现场，并核对说明、语音转写和人工结论。')),message,actions(submit));
    photos.addEventListener('change',()=>photos.setCustomValidity(photos.files.length>5?'最多 5 张照片':[...photos.files].some(f=>f.size>10485760)?'照片不能超过 10MB':''));
    form.addEventListener('input',()=>{dirty=true;requestId=crypto.randomUUID();});
    const reload=button('刷新版本并保留草稿',async()=>{try{const latest=(await api('/api/reviews/'+review.review_id)).review;if((latest.effective_status||latest.status)!=='pending'){message.textContent='请求已结束，草稿仍保留，不能继续补证。';submit.disabled=true;return;}version=latest.version;requestId=crypto.randomUUID();message.textContent=`已读取版本 ${version}，请核对草稿后重新提交。`;}catch(e){message.textContent=e.message;}},'btn btn-ghost');form.append(reload);
    form.addEventListener('submit',async e=>{e.preventDefault();if(saving||!form.reportValidity())return;const payload=new FormData(form);payload.set('point_id',review.point_id);if(review.inspection_round_id)payload.set('inspection_round_id',review.inspection_round_id);payload.set('inspected_at',new Date(time.value).toISOString());payload.set('version',version);payload.set('request_id',requestId);payload.set('result',({normal:'ok',fault:'alarm',unknown:'unknown'})[conclusion.value]);if(!photos.files.length)payload.delete('photos');voiceInput?.cancel();
      await saveAction(form,message,async()=>{const data=await api('/api/reviews/'+review.review_id+'/evidence',{method:'POST',body:payload});dirty=false;await detail(review.review_id,data.rerun);});});return form;}
  function transitionForm(r){const form=el('form',{id:'review-transition-form'}),reason=el('input',{name:'reason',required:true,maxLength:1000,placeholder:'填写取消原因'}),message=status('');let requestId=crypto.randomUUID(),version=r.version;form.append(el('h3',{},'取消请求'),field('原因',reason),message,el('button',{type:'submit',class:'btn btn-secondary'},'取消复核请求'));form.addEventListener('input',()=>{dirty=true;requestId=crypto.randomUUID();});form.addEventListener('submit',async e=>{e.preventDefault();if(saving||!form.reportValidity())return;await saveAction(form,message,async()=>{const data=await postJSON('/api/reviews/'+r.review_id+'/transition',{request_id:requestId,version,status:'cancelled',reason:reason.value});dirty=false;await detail(r.review_id,data.rerun);});});form.append(button('刷新版本并保留取消原因',async()=>{try{const latest=(await api('/api/reviews/'+r.review_id)).review;if((latest.effective_status||latest.status)!=='pending'){message.textContent='请求已结束，取消原因仍保留。';form.querySelector('button[type=submit]').disabled=true;return;}version=latest.version;requestId=crypto.randomUUID();message.textContent='已刷新版本，请核对取消原因后重试。';}catch(e){message.textContent=e.message;}},'btn btn-ghost'));return form;}
  return {create,detail,list};
}
