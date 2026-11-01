const stages=[['statistics','基础统计'],['weather','外部天气'],['rag','巡检资料检索'],['ml','重点关注模型'],['tools','只读工具调用'],['llm','AI 解释与建议']];
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const printable=value=>typeof value==='string'?value:JSON.stringify(value,null,2)??'未提供';
const percent=value=>(value*100).toLocaleString('zh-CN',{maximumFractionDigits:1})+'%';

export function coverageRows(statistics={}){
  const rate=value=>finite(value)&&value>=0&&value<=1?value:null;
  return [{label:'必检覆盖',covered:statistics.covered,required:statistics.required,rate:rate(statistics.coverage_rate)},
    ...Object.entries(statistics.zone_completion||{}).map(([label,value])=>({label,covered:value.covered,required:value.required,
      rate:finite(value.required)&&value.required>0&&finite(value.covered)?rate(value.covered/value.required):null}))];
}

export function durationSummary(statistics={}){
  const duration=statistics.average_inspection_seconds??statistics.duration_seconds;
  const samples=statistics.duration_sample_count??'未提供',total=statistics.inspection_count??'未提供';
  return `${finite(duration)?duration+' 秒':'未记录'}（耗时样本 ${samples}/${total}；未记录部分不推算）`;
}

export function analysisSteps(analysis={}){
  return stages.map(([name,label])=>analysis.steps?.find(step=>step.name===name)||{
    name,label,status:'unavailable',provider:null,observed_at:null,retrieved_at:null,value:null,error:'未返回本阶段结果。',evidence_id:null
  });
}

export function pendingAnalysis(run){
  const snapshot=run?.input_snapshot||{},options=snapshot.analysis_context;
  if(!run?.run_id||run.status==='completed'||(!options&&run.implementation_stage!==6))return null;
  const question=options?.question||'',basis_run_id=options?.basis_run_id||null,failure_mode=options?.failure_mode||'none';
  return {run_id:run.run_id,basis_run_id,question,failure_mode,
    request:snapshot.request_id&&basis_run_id&&question?{request_id:snapshot.request_id,source_run_id:basis_run_id,question,failure_mode}:null};
}

export function analysisConfigSummary(config={}){
  const enabled=config.enabled===true?'已启用':config.enabled===false?'未启用':'启用状态未知';
  const configured=config.configured===true?'已配置':config.configured===false?'配置不完整':'配置状态未知';
  const model=typeof config.model_label==='string'&&config.model_label.trim()?config.model_label:'模型未提供';
  return `AI 服务：${enabled} · ${configured} · ${model}`;
}

export function analysisAnswer(analysis={}){
  const step=analysis.steps?.find(item=>item.name==='llm');
  if(step?.status!=='ok')return {claims:[],message:'AI 答复未生成：'+(step?.error||'未取得可用的模型解释。')};
  const labels={fact:'事实',suggestion:'建议',limitation:'限制'};
  const claims=(step.value?.claims||[]).map(claim=>({...claim,kindLabel:labels[claim.kind]||'未分类'}));
  return {claims,message:claims.length?'':'AI 答复未生成：未返回可展示的解释条目。'};
}

export function toolSummary(item){
  const value=item.result||{};
  if(item.name==='coverage_gaps')return Array.isArray(value.point_ids)?
    (value.point_ids.length?'当前冻结运行未巡的必检点：'+value.point_ids.join('、')+'。':'当前冻结运行的必检点均已覆盖。'):'必检覆盖缺口未提供。';
  if(item.name==='historical_anomalies')return Array.isArray(value.items)?`本运行可追溯的异常历史：${value.items.length} 条；不代表当前故障。`:'异常历史结果未提供。';
  if(item.name==='plan_feasibility')return value.fastest_executable_plan_ids?.length?
    '案例预计耗时最短的可执行候选方案：'+value.fastest_executable_plan_ids.join('、')+'。':'当前结果未给出可执行方案的最短预计耗时选择。';
  return '查看工具实际返回结果。';
}

export function initAnalysisWorkbench({el,button,api,postJSON,showDialog,toast,getRun,openRun,onCompleted}){
  let source=null,request=null,job=null,result=null,busy=false,rejected=false,retryKind=null,timer=null,disposed=false,suspended=false,configLoading=false;
  const entry=button('T5 分析与助手',()=>open(),'btn btn-secondary');entry.id='campus-analysis-open';
  document.querySelector('#campus-stage .campus-business-actions')?.append(entry);
  const dialog=el('dialog',{id:'analysis-dialog',class:'run-dialog analysis-dialog','aria-labelledby':'analysis-title'});
  const close=button('关闭面板',()=>dialog.close(),'btn btn-ghost');close.id='analysis-close';
  const context=el('p',{id:'analysis-context',class:'analysis-meta'});
  const configStatus=el('p',{id:'analysis-config',class:'analysis-meta',role:'status'},'AI 服务配置尚未读取。');
  const question=el('textarea',{id:'analysis-question',name:'question',rows:3,required:true,maxLength:1000,
    placeholder:'输入要基于当前冻结运行回答的问题'});
  question.value='现在哪还没巡？派谁去最省时间？';
  const presets=['现在哪还没巡？派谁去最省时间？','交换机通风巡检需要关注什么？'].map(text=>button(text,()=>{question.value=text;edited();question.focus();},'btn btn-secondary'));
  const failure=el('select',{id:'analysis-failure',name:'failure_mode'},...[
    ['none','正常请求'],['weather','演练：天气不可用'],['rag','演练：资料检索不可用'],['ml','演练：模型不可用'],['llm','演练：AI 解释不可用']
  ].map(([value,text])=>el('option',{value},text)));
  const submit=el('button',{id:'analysis-submit',type:'submit',class:'btn btn-primary'},'生成独立分析运行');
  const form=el('form',{id:'analysis-form',class:'analysis-form'},context,configStatus,
    el('label',{class:'analysis-field',htmlFor:'analysis-question'},'想了解什么',question),
    el('div',{class:'analysis-presets','aria-label':'问题预设'},...presets),
    el('label',{class:'analysis-field',htmlFor:'analysis-failure'},'教学失败演练',failure),
    el('p',{class:'field-hint'},'失败演练仅适用于教学轮次，只影响本次独立运行，不更改实际服务配置。'),submit);
  const status=el('p',{id:'analysis-status',role:'status','aria-live':'polite',class:'analysis-status'});
  const requestInfo=el('p',{id:'analysis-request',class:'analysis-meta'});
  const retry=button('重试同一次请求',retryRequest,'btn btn-secondary');retry.id='analysis-retry';retry.hidden=true;
  const fresh=button('使用当前运行新建分析',()=>reset(getRun()),'btn btn-secondary');fresh.id='analysis-new';
  const output=el('section',{id:'analysis-output','aria-label':'已保存分析结果'});
  const adopt=button('在 3D 工作台采用此运行',adoptResult,'btn btn-primary');adopt.id='analysis-adopt';adopt.hidden=true;
  const history=button('查看此运行完整记录',()=>{if(result){dialog.close();openRun?.(result.run_id);}},'btn btn-secondary');history.id='analysis-history';history.hidden=true;
  dialog.append(el('header',{class:'drawer-header'},el('div',{},el('h2',{id:'analysis-title'},'T5 分析与助手'),
    el('p',{},'基于冻结事实，逐项查看分析来源与证据。')),close),
    el('div',{class:'drawer-body'},form,status,requestInfo,el('div',{class:'analysis-actions'},retry,fresh),output),
    el('footer',{class:'analysis-footer'},el('p',{},'分析保存为单独运行。关闭面板保留任务；采用结果后才更新 3D 工作台。'),
      el('div',{class:'analysis-actions'},adopt,history)));
  document.body.append(dialog);
  form.addEventListener('submit',submitRequest);
  question.addEventListener('input',edited);failure.addEventListener('change',edited);
  dialog.addEventListener('close',closed);
  document.addEventListener('visibilitychange',visibilityChanged);
  window.addEventListener('pagehide',pageHidden);
  window.addEventListener('pageshow',pageShown);

  function say(message,error=false){status.textContent=message;status.dataset.tone=error?'error':'normal';}
  function teaching(){return !!source?.input_snapshot?.round?.scenario_instance_id;}
  function active(){return !!(request||job)&&!result&&!rejected;}
  function canRead(){return !disposed&&!suspended&&!document.hidden&&dialog.open;}
  function controls(){
    const locked=busy||active()||!!result;
    for(const control of [question,...presets])control.disabled=locked;
    failure.disabled=locked||!teaching();
    submit.disabled=locked||!source?.run_id||!!result;
    submit.textContent=busy?'正在等待服务端确认…':active()?(job?'分析任务已提交':'等待确认提交结果'):'生成独立分析运行';
    form.setAttribute('aria-busy',String(busy));
    fresh.disabled=busy||active();retry.hidden=!retryKind;retry.disabled=busy;
    retry.textContent=retryKind==='resume'?'恢复同一次分析':retryKind==='read'?'重新读取分析状态':'重试同一次请求';
    adopt.hidden=!result;history.hidden=!result;adopt.disabled=busy;
    requestInfo.textContent=request?`请求标识 ${request.request_id}${job?.run_id?' · 分析运行 '+job.run_id:''}`:job?'分析运行 '+job.run_id:result?'分析运行 '+result.run_id:'';
  }
  function edited(){if(rejected){request=null;job=null;rejected=false;retryKind=null;}controls();}
  function reset(run){
    if(disposed||busy||active())return;
    stop();source=run?.status==='completed'&&run.run_type==='reality'?run:null;request=null;job=null;result=null;rejected=false;retryKind=null;
    failure.value='none';output.replaceChildren();
    context.textContent=source?`基础运行 ${source.run_id} · 判断截止 ${source.as_of||'未提供'}${teaching()?' · 教学模拟轮次':''}`:'尚未选定基础运行。请先在“轮次与任务”生成或选择已完成的现实运行。';
    say(source?'输入问题后生成独立分析；当前选定运行保持不变。':'请先选择已完成的现实运行，再打开分析面板。');controls();
  }
  function open(run){
    if(disposed)return;
    if(!active()&&!busy){
      const selected=run||(request||result?null:getRun()),pending=pendingAnalysis(selected);
      if(pending){
        stop();source=null;request=pending.request;job={run_id:pending.run_id,status:'unknown'};result=null;rejected=false;retryKind=null;
        question.value=pending.question;failure.value=pending.failure_mode;output.replaceChildren();
        context.textContent='正在继续已有分析'+(pending.basis_run_id?'；基础运行 '+pending.basis_run_id:'；基础运行信息将在结果中显示。');
        say('正在读取已保存任务的当前状态…');controls();
      }else if(selected?.analysis){
        stop();source=selected;request=null;job={run_id:selected.run_id,status:'completed'};result=selected;rejected=false;retryKind=null;
        question.value=selected.analysis.question||question.value;failure.value='none';
        context.textContent='正在回看已保存分析；基础运行 '+selected.analysis.basis_run_id;
        render(selected,output);say(selected.analysis.status==='complete'?'分析已完成。':'分析已完成，部分来源不可用；请查看各项限制。');controls();
      }else if(selected||!source)reset(selected);
    }else if(run&&run.run_id!==source?.run_id&&run.run_id!==job?.run_id)toast?.('当前分析仍在处理中；输入和任务已保留。');
    showDialog(dialog);
    loadConfig();if(job&&!result)poll();
  }
  async function loadConfig(){
    if(disposed||configLoading)return;configLoading=true;configStatus.textContent='正在读取 AI 服务配置状态…';
    try{const config=await api('/api/analyses/config');if(!disposed)configStatus.textContent=analysisConfigSummary(config);}
    catch{if(!disposed)configStatus.textContent='AI 服务配置状态读取失败；重新打开面板可重试。分析各阶段将独立记录可用性。';}
    finally{configLoading=false;}
  }
  async function submitRequest(event){
    event?.preventDefault();if(disposed||busy||active()||result||!source)return;
    if(!question.value.trim()){question.setCustomValidity('请输入分析问题。');question.reportValidity();question.setCustomValidity('');return;}
    if(!form.reportValidity())return;
    request??={request_id:crypto.randomUUID(),source_run_id:source.run_id,question:question.value.trim(),failure_mode:failure.value};
    await send(false);
  }
  async function send(resume){
    if(disposed||busy||(resume?!job?.run_id:!request))return;
    busy=true;rejected=false;retryKind=null;stop();controls();say(resume?'正在恢复同一次分析…':'正在提交独立分析任务…');
    try{
      const response=await postJSON(resume?'/api/analyses/'+encodeURIComponent(job.run_id)+'/retry':'/api/analyses',resume?{}:request);
      if(disposed)return;
      await receive(response);
      // The retry endpoint acknowledges the old status before its background worker starts.
      if(!disposed&&response.status==='interrupted'){retryKind=null;say('恢复请求已受理，等待后台更新同一次运行的状态。');}
    }catch(error){
      if(disposed)return;
      rejected=!resume&&error.status>=400&&error.status<500&&![408,409,429].includes(error.status);
      retryKind=resume?'resume':'submit';
      say((rejected?'服务端未接受此输入，可修改或原样重试：':resume?'恢复结果尚未确认；已保留运行编号，可重试恢复：':'提交结果尚未确认，已保留问题及请求标识；请重试同一次请求：')+error.message,true);
    }finally{busy=false;if(!disposed){controls();schedule();}}
  }
  async function receive(response){
    if(disposed)return;
    if(!response?.run_id||!['queued','running','completed','interrupted'].includes(response.status))throw Error('服务端未返回可识别的分析状态。');
    job=response;retryKind=null;
    if(job.status==='completed'){
      if(!canRead()){say('分析已完成，返回面板后读取结果。');return;}
      try{
        const saved=await api('/api/runs/'+encodeURIComponent(job.run_id));
        if(disposed)return;
        if(saved.run_id!==job.run_id||!saved.analysis)throw Error('分析结果尚未就绪。');
        result=saved;render(result,output);
        say(result.analysis.status==='complete'?'分析已完成并保存。可查看来源，或采用此运行。':'分析已保存，部分来源不可用。可用结果与缺失原因均已保留。');
      }catch(error){if(!disposed){retryKind='read';say('分析已完成，但结果读取失败；可重新读取：'+error.message,true);}}
    }else if(job.status==='interrupted'){
      retryKind='resume';say('分析中断，可恢复同一次运行。'+(job.error?' '+printable(job.error):''),true);
    }else say(job.status==='queued'?'分析任务已排队，等待后台处理。可关闭面板，稍后继续查看。':'后台正在分析。只显示已确认状态；关闭面板不取消任务。');
  }
  async function poll(){
    if(!canRead()||busy||!job||result)return;
    stop();busy=true;controls();
    try{await receive(await api('/api/analyses/'+encodeURIComponent(job.run_id)));}
    catch(error){if(!disposed){retryKind='read';say('状态读取失败，后台任务可能仍在继续。请重新读取：'+error.message,true);}}
    finally{busy=false;if(!disposed){controls();schedule();}}
  }
  function stop(){clearTimeout(timer);timer=null;}
  function schedule(){stop();if(canRead()&&job&&!result&&!retryKind)timer=setTimeout(poll,1500);}
  async function retryRequest(){if(busy||disposed)return;if(retryKind==='read')await poll();else await send(retryKind==='resume');}
  async function adoptResult(){
    if(!result||busy||disposed)return;busy=true;controls();
    try{await onCompleted?.(result);if(!disposed){dialog.close();toast?.('已在 3D 工作台采用分析运行 '+result.run_id);}}
    catch(error){if(!disposed)say('采用运行失败，分析结果仍已保存：'+error.message,true);}
    finally{busy=false;if(!disposed)controls();}
  }
  function closed(){
    stop();const overlays=[...document.querySelectorAll('dialog[open]')],notice=document.getElementById('toast');
    if(notice&&dialog.contains(notice))(overlays.at(-1)||document.body).append(notice);
    document.dispatchEvent(new CustomEvent('inspectgo:overlay',{detail:{open:!!overlays.length}}));
    if(!disposed&&!overlays.length)entry.focus({preventScroll:true});
  }
  function visibilityChanged(){if(document.hidden)stop();else if(canRead())poll();}
  function pageHidden(event){suspended=true;stop();if(!event.persisted)destroy();}
  function pageShown(event){if(event.persisted){suspended=false;if(canRead())poll();}}
  function destroy(){
    disposed=true;stop();document.removeEventListener('visibilitychange',visibilityChanged);
    window.removeEventListener('pagehide',pageHidden);window.removeEventListener('pageshow',pageShown);
    dialog.removeEventListener('close',closed);if(dialog.open)dialog.close();closed();dialog.remove();entry.remove();
  }

  function metadata(step){
    return el('p',{class:'analysis-meta'},`来源 ${step.provider||'未提供'} · 观测 ${step.observed_at||'未提供'} · 获取 ${step.retrieved_at||'未提供'}`);
  }
  function rawDetails(label,value){return el('details',{class:'analysis-details'},el('summary',{},label),el('pre',{tabIndex:0,'aria-label':label},printable(value)));}
  function statisticsView(statistics){
    const charts=el('div',{class:'analysis-charts','aria-label':'冻结运行的必检覆盖与区域覆盖'});
    for(const row of coverageRows(statistics)){
      const description=`${row.covered??'未提供'}/${row.required??'未提供'} · ${row.rate===null?(row.required===0?'无必检点':'覆盖率未提供'):percent(row.rate)}`;
      const track=el('div',{class:'analysis-bar','aria-hidden':'true'}),fill=el('span');
      fill.style.width=row.rate===null?'0%':percent(row.rate);track.append(fill);
      charts.append(el('div',{class:'analysis-chart-row'},el('span',{},row.label),el('strong',{},description),track));
    }
    const counts=el('dl',{class:'analysis-counts'});
    for(const [name,value] of [['有效巡检记录',statistics.inspection_count],['异常点数',statistics.anomaly_count],['待复核',statistics.pending_review_count]]){
      counts.append(el('div',{},el('dt',{},name),el('dd',{},value??'未提供')));
    }
    return el('div',{},charts,counts,el('p',{},'平均巡检耗时：'+durationSummary(statistics)),
      statistics.anomaly_points?.length?el('p',{},'异常依据涉及点位：'+statistics.anomaly_points.join('、')+'；不代表当前故障均未解除。'):null,
      ...(statistics.limitations||[]).map(text=>el('p',{class:'field-hint'},text)));
  }
  function stepContent(step){
    const value=step.value,box=el('div',{class:'analysis-step-content'});
    if(step.status!=='ok')box.append(el('p',{class:'analysis-unavailable'},printable(step.error||'本阶段未提供可用结果。')));
    if(value===null||value===undefined)return box;
    if(step.name==='statistics')box.append(statisticsView(value));
    if(step.name==='weather'){
      box.append(el('p',{},`${value.location?.name||'地点未提供'} · 温度 ${finite(value.temperature_c)?value.temperature_c+' °C':'未提供'} · 相对湿度 ${finite(value.relative_humidity_percent)?value.relative_humidity_percent+'%':'未提供'}`),
        el('p',{class:'field-hint'},value.scope||'天气仅作环境上下文，不单独证明设施故障。'));
    }
    if(step.name==='rag'){
      box.append(el('p',{},value.no_source?'当前问题没有可核验的资料来源。':`已返回 ${value.sources?.length??0} 个来源、${value.chunks?.length??0} 个片段。`));
      if(value.answer)box.append(el('p',{class:'analysis-answer-text'},printable(value.answer)));
      for(const citation of value.citations||[]){
        const item=el('div',{class:'analysis-citation'},el('strong',{},citation.title||citation.source_id||'资料引用'),
          el('p',{},citation.quote||'未提供摘录'),el('p',{class:'analysis-meta'},`${citation.chunk_id||'片段编号未提供'} · ${citation.section||'章节未提供'} · ${citation.provider||'来源未提供'} · 核对 ${citation.reviewed_at||'未提供'}`));
        if(citation.scope)item.append(el('p',{class:'field-hint'},citation.scope));
        try{const url=new URL(citation.url);if(['https:','http:'].includes(url.protocol))item.append(el('a',{href:url.href,target:'_blank',rel:'noopener noreferrer'},'打开资料原文'));}catch{}
        box.append(item);
      }
      box.append(rawDetails('检索片段、Top-k 与拼接上下文',{sources:value.sources,chunks:value.chunks,top_k:value.top_k,context:value.context}));
    }
    if(step.name==='ml'){
      const prediction=value.prediction||{};
      box.append(el('p',{class:'analysis-model-suggestion'},prediction.suggestion||'模型未提供复访建议。'),
        el('p',{},'复访标签：'+(prediction.label||'未提供')),
        el('p',{},'叶节点中 PRIORITY 样本比例：'+(finite(prediction.score)?prediction.score:'未提供')+'（未经校准，不是故障概率）'),
        el('p',{class:'analysis-meta'},'分数定义：'+(prediction.score_label||'未提供')),
        el('p',{class:'field-hint'},'本模型使用合成教学样本，只提供人工复访优先级建议，不预测设施故障。'),
        el('ul',{class:'analysis-limitations'},...(value.limitations||[]).map(text=>el('li',{},text))));
    }
    if(step.name==='tools'){
      box.append(el('p',{class:'field-hint'},'以下为只读工具的计算结果，不是 AI 答复；不会自动派单或完成任务。'));
      for(const item of value.items||[])box.append(el('div',{class:'analysis-tool-result'},el('p',{},toolSummary(item)),
        item.result?.scope?el('p',{class:'field-hint'},item.result.scope):null,
        rawDetails(`${item.name} · ${item.call_id}`,{call_id:item.call_id,name:item.name,arguments:item.arguments,result:item.result})));
    }
    if(step.name==='llm'){
      box.append(el('p',{class:'analysis-meta'},`模型 ${value.model||'未提供'} · 响应 ${value.response_id||'未提供'}`));
      if(value.scope)box.append(el('p',{class:'field-hint'},value.scope));
    }
    return box;
  }
  function answerView(analysis,evidenceTargets){
    const answer=analysisAnswer(analysis),section=el('section',{class:'analysis-answer','aria-label':'助手答复'},el('h4',{},'助手答复'));
    if(answer.message){section.append(el('p',{class:'analysis-unavailable'},answer.message),el('p',{class:'field-hint'},'下方仍可查看各项统计、资料和工具结果。'));return section;}
    const claims=el('ul',{class:'analysis-claims'});
    for(const claim of answer.claims){
      const refs=el('div',{class:'analysis-evidence-links','aria-label':'答复依据'});
      for(const id of claim.evidence_refs||[]){
        const target=evidenceTargets.get(id);
        if(target){
          const link=button(`${target.label} · ${id}`,()=>{
            target.details.open=true;target.details.scrollIntoView({block:'start',behavior:'instant'});
            target.details.querySelector('summary').focus({preventScroll:true});
          },'btn btn-ghost analysis-evidence-link');
          link.setAttribute('data-evidence-ref',id);refs.append(link);
        }else refs.append(el('span',{class:'analysis-unavailable'},id+'（本运行未找到）'));
      }
      if(!claim.evidence_refs?.length)refs.append(el('span',{class:'analysis-unavailable'},'未提供证据引用；请核对。'));
      claims.append(el('li',{},el('p',{class:'analysis-claim-text'},el('strong',{class:'analysis-claim-kind'},claim.kindLabel),claim.text),refs));
    }
    section.append(claims,el('p',{class:'field-hint'},'点击依据可展开本次运行的原始输出。AI 解释仍需人工核对。'));return section;
  }
  function render(run,target){
    const analysis=run?.analysis;
    if(!analysis){target.replaceChildren(el('p',{class:'field-hint'},'此运行没有增强分析结果。'));return;}
    const panel=el('div',{class:'analysis-result'},el('h3',{},'已保存的分析结果'),
      el('p',{class:'analysis-result-state'},analysis.status==='complete'?'全部分析阶段已完成':'分析受限 · 查看各阶段的不可用原因'),
      el('p',{class:'analysis-meta'},`运行 ${run.run_id} · 完成 ${run.completed_at||'未提供'}`),
      el('p',{class:'analysis-answer-text'},'问题：'+(analysis.question||'未提供')));
    const chain=el('ol',{class:'analysis-steps','aria-label':'分析来源与执行结果'});
    const evidenceTargets=new Map();
    for(const step of analysisSteps(analysis)){
      const labels={ok:'已取得',unavailable:'不可用',error:'错误'};
      const details=rawDetails('真实输出与证据 · '+(step.evidence_id||'无证据编号'),step);
      details.classList.add('analysis-evidence');
      const item=el('li',{class:'analysis-step','data-analysis-step':step.name,'data-status':step.status},
        el('div',{class:'analysis-step-heading'},el('h4',{},step.label||step.name),el('span',{class:'analysis-stage-status'},labels[step.status]||'状态未知')),
        metadata(step),stepContent(step),details);
      if(step.evidence_id)evidenceTargets.set(step.evidence_id,{label:step.label||step.name,details});
      chain.append(item);
    }
    panel.append(answerView(analysis,evidenceTargets),
      button('查看基础运行 '+analysis.basis_run_id,()=>{if(dialog.open)dialog.close();openRun?.(analysis.basis_run_id);},'btn btn-secondary'),
      el('p',{class:'field-hint'},analysis.scope||'分析依据冻结运行事实。AI 解释不是任务判定，不替代现场巡检或正式诊断。'),chain);
    target.replaceChildren(panel);
  }
  controls();
  return {open,render,destroy};
}
