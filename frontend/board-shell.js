import {initBoardMasonry} from './board-masonry.js?v=20261101-pinboard-2';
import {matchesPoint,facilityState} from './model.js?v=20261101-pinboard-2';
import {planLabel} from './planning-view.js';

const boards=[
  ['overview','总览','从空间定位设施，从现场记录追溯每一次巡检。','building'],
  ['coverage','覆盖与阻塞','找出缺少有效现场记录的必检点，并查看阻塞依据。','eye'],
  ['tasks','轮次与任务','选定轮次，查看五项任务判断与候选方案。','clock'],
  ['evidence','证据与复核','把现场照片、判断依据和复核过程连起来。','camera'],
  ['analysis','分析与推演','基于已保存的事实解释结果，在独立运行中检验假设。','file']
];
const taskLabels={established:'成立',blocked:'受阻',pending_verification:'待验证',unknown:'状态未知'};
const reviewLabels={pending:'待处理',completed:'完成',timeout:'超时',cancelled:'取消'};
const toneOf=state=>({established:'good',blocked:'danger',pending_verification:'warn',unknown:'muted'}[state]||'muted');

// This is a presentation shell: existing controllers retain forms, requests and selected runs.
export function initBoardShell({el,button,icon,api,getData,getRun,getRuns,getFilters,getPoints,setFilters,openDetail,openRun,openPhotos,openTasks,openReview,locatePoint,motionAllowed}){
  const $=id=>document.getElementById(id), events=new AbortController(), scrolls=new Map(), pins=new Map();
  let evidenceRevision=0, loadedEvidenceRevision=-1;
  let active='overview', lastData=null, evidenceLoading=false, evidenceEpoch=0, photoPages=[], inspectionPage=null, reviews=null, evidenceError='', reviewFilter='pending', disposed=false;
  const on=(node,event,fn)=>node.addEventListener(event,fn,{signal:events.signal});
  const fmt=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'未提供';
  const empty=text=>el('p',{class:'pin-empty'},text);
  const note=text=>el('p',{class:'pin-note'},text);
  const badge=(text,tone='muted')=>el('span',{class:'status-badge is-'+tone},icon(tone==='danger'?'alert':tone==='good'?'check':'clock'),text);
  const focusedAction=(label,fn,key)=>{const b=button(label,fn,'btn btn-ghost btn-small');b.dataset.focusKey=key;return b;};
  let savedPins=new Set();try{savedPins=new Set(JSON.parse(localStorage.getItem('inspectgo:board-pins')||'[]'));}catch{}
  document.body.classList.add('pinboard');
  const heading=el('header',{class:'board-heading'},el('div',{},el('h2',{id:'board-title',tabIndex:-1}),el('p',{id:'board-purpose'})),el('div',{id:'board-context'}));
  const nav=el('nav',{class:'board-nav','aria-label':'工作区'}),rail=el('aside',{class:'board-rail'},el('p',{class:'board-rail-title'},'巡检工作区'),nav,
    button('选择 / 新建轮次',()=>openTasks(),'btn btn-secondary'),note('教学演练 · 设计示意\n结果不替代正式安全检查。'));
  const main=el('main',{id:'board-main',class:'board-main',tabIndex:-1},heading),layout=el('div',{class:'board-layout'},rail,main);
  const panels=new Map(),grids=new Map(),navItems=new Map();
  for(const [id,name,,symbol] of boards){
    const b=button('',()=>selectBoard(id),'board-nav-item');b.dataset.board=id;b.setAttribute('aria-controls','board-'+id);
    const count=el('span',{class:'board-nav-count','aria-hidden':'true'},'—');b.append(icon(symbol),el('span',{},name),count);nav.append(b);navItems.set(id,{button:b,count});
    const panel=el('section',{id:'board-'+id,class:'board-panel','data-board-panel':id,'aria-label':name,hidden:id!==active}),grid=el('div',{class:'board-grid',id:id+'-pins'});panel.append(grid);panels.set(id,panel);grids.set(id,grid);main.append(panel);
  }
  document.querySelector('.app-header').after(layout);
  document.querySelector('.skip-link').href='#board-main';
  const campus=$('campus-stage'),dock=document.querySelector('.campus-workbench'),taskStrip=el('section',{class:'board-task-strip','aria-label':'选定运行的五项任务判断'});
  taskStrip.append(el('div',{class:'board-section-heading'},el('h3',{},'五项任务判断'),note('固定顺序展示 · 各项独立判断')),$('campus-run-context'),document.querySelector('.campus-task-states'));
  const catalogRetry=[...dock.querySelectorAll('button')].find(b=>b.textContent==='重试读取任务');if(catalogRetry)taskStrip.append(catalogRetry);
  panels.get('overview').prepend(campus,taskStrip);
  // Reuse the global search and filter controls; no second filter state.
  const toolbar=document.querySelector('.filter-toolbar'),search=toolbar.querySelector('.search-field'),viewSwitch=toolbar.querySelector('.view-switch');
  document.querySelector('.points-heading').append(viewSwitch);
  const filterControls=el('div',{class:'board-filter-controls',id:'board-filter-controls',hidden:true});
  filterControls.append(...[...toolbar.children].filter(n=>n!==search));toolbar.remove();
  const filterToggle=button('筛选',()=>{filterControls.hidden=!filterControls.hidden;filterToggle.setAttribute('aria-expanded',String(!filterControls.hidden));},'btn btn-secondary');filterToggle.id='board-filter-toggle';filterToggle.setAttribute('aria-controls',filterControls.id);filterToggle.setAttribute('aria-expanded','false');
  const status=el('details',{class:'board-status'},el('summary',{},'连接与设置'),el('div',{class:'board-status-panel'},document.querySelector('.connection-block'),document.querySelector('.motion-control')));
  const tools=document.querySelector('.header-tools');tools.prepend(filterToggle,status);document.querySelector('.brand-lockup').after(search);
  const chips=el('div',{class:'board-filter-chips','aria-label':'已应用筛选'}),scope=el('p',{id:'board-search-scope'});
  const filterbar=el('div',{class:'board-filterbar'},filterControls,chips,scope);document.querySelector('.app-header').after(filterbar);
  on(filterControls,'keydown',e=>{if(e.key==='Escape'){filterControls.hidden=true;filterToggle.setAttribute('aria-expanded','false');filterToggle.focus();}});
  // The old data renderers continue targeting the same element IDs.
  const oldMain=$('app-main'),pointList=el('section',{id:'app-main',class:'board-point-list',tabIndex:-1});
  pointList.append(document.querySelector('.points-section'));panels.get('coverage').append(pointList);oldMain.remove();
  const oldShell=document.querySelector('.app-shell'),storage=el('div',{hidden:true,'aria-hidden':'true'});
  storage.append(document.querySelector('.scope-rail'));document.body.append(storage);

  function pin(board,id,title,type,entryId=null,{wide=false,priority=2}={}){
    const body=el('div',{class:'pin-body'}),actions=el('footer',{class:'pin-actions'}),toggle=button('',()=>{
      if(savedPins.has(id))savedPins.delete(id);else savedPins.add(id);
      try{localStorage.setItem('inspectgo:board-pins',JSON.stringify([...savedPins]));}catch{}
      updatePin();
    },'btn btn-ghost btn-small pin-toggle');
    const content=el('div',{class:'pin-content'},el('header',{class:'pin-header'},el('h3',{},title),toggle),body,actions);
    const card=el('article',{id:'pin-'+id,class:`board-pin pin-${type}${wide?' pin-wide':''}`,'data-priority':priority},content);
    function updatePin(){const pinned=savedPins.has(id);toggle.replaceChildren(icon(pinned?'check':'plus'));toggle.setAttribute('aria-label',(pinned?'取消钉住：':'钉住：')+title);toggle.setAttribute('aria-pressed',String(pinned));toggle.title='仅保存在此浏览器';card.classList.toggle('is-pinned',pinned);}
    updatePin();if(entryId&&$(entryId)){const entry=$(entryId);entry.className='btn btn-secondary';actions.append(entry);}
    grids.get(board).append(card);const result={card,body,actions,signature:null};pins.set(id,result);return result;
  }
  function paint(id,key,build){
    const p=pins.get(id),signature=JSON.stringify(key);if(p.signature===signature)return;p.signature=signature;
    const focused=p.body.contains(document.activeElement)?document.activeElement.dataset.focusKey:null;
    p.body.replaceChildren(...build());
    if(focused){const target=[...p.body.querySelectorAll('[data-focus-key]')].find(n=>n.dataset.focusKey===focused);(target||p.actions.querySelector('button')||$('board-title')).focus({preventScroll:true});}
  }
  function rows(points,label){return el('div',{class:'pin-list'},...points.map(p=>el('div',{class:'pin-row'},el('div',{},el('code',{},p.point_id),el('strong',{},p.device),el('small',{},label(p))),
    focusedAction('定位',()=>locate(p.point_id),'locate-'+p.point_id),focusedAction('详情',()=>openDetail(p.point_id),'detail-'+p.point_id))));}
  function locate(id){selectBoard('overview');requestAnimationFrame(()=>{locatePoint(id);campus.scrollIntoView({block:'start',behavior:'instant'});});}

  pin('overview','alerts','当前远程告警','task',null,{priority:0});
  pin('overview','missing','需要补齐的现场记录','metric',null,{priority:1}).actions.append(button('查看全部待补检',()=>{setFilters({query:'',scope:'all',required:'required',status:'missing'});selectBoard('coverage');},'btn btn-secondary'));
  const pending=pin('overview','pending','待处理事项','task',null,{priority:1});pending.body.append($('pending-list'));pending.actions.append(button('进入证据与复核',()=>selectBoard('evidence'),'btn btn-ghost'));
  pin('overview','round-short','当前巡检轮次','timeline').actions.append(button('选择轮次 / 生成判断',()=>openTasks(),'btn btn-secondary'));
  pin('overview','point-search','筛选命中的点位','task').card.hidden=true;

  const metric=pin('coverage','coverage','现场巡检覆盖','metric','campus-coverage-open',{wide:true});
  const oldOverview=document.querySelector('.overview-section');
  // oldMain was removed above, so retain detached overview nodes through oldMain.
  const overview=oldOverview||oldMain.querySelector('.overview-section');
  metric.body.append(el('div',{class:'pin-metric-row'},el('div',{class:'pin-ring',id:'board-coverage-ring',role:'img'},el('span',{class:'pin-ring-value',id:'board-coverage-value'},'—')),overview.querySelector('.summary-strip')),overview.querySelector('#window-label'),overview.querySelector('.coverage-map'),note('远程状态不单独算覆盖；现场记录有效不代表设施正常。'));
  pin('coverage','blockers','当前阻塞','task');
  pin('coverage','gaps','缺少有效现场记录','task').actions.append(button('回到空间定位',()=>selectBoard('overview'),'btn btn-ghost'));
  pin('coverage','run-evidence','本次判断证据','timeline','campus-run-evidence-open');

  pin('tasks','round','轮次与任务','task','campus-tasks-open');
  pin('tasks','tasks','五项任务及依据','task',null,{wide:true});
  pin('tasks','plans','候选方案与对比','task','campus-plans-open',{wide:true});

  pin('evidence','photos','现场照片','evidence','evidence-browser-open',{wide:true}).actions.append(button('刷新照片与复核',()=>loadEvidence(true),'btn btn-ghost'));
  pin('evidence','reviews','现场复核','task','review-list-open');
  const history=pin('evidence','history','最近运行记录','timeline','all-runs-btn');history.body.append(note('最多展示最近 50 次运行中的近期记录。'),$('recent-runs'));
  pin('evidence','evidence','选定运行的证据','timeline');
  pin('evidence','records','现场记录时间线','timeline').actions.append(button('查询完整记录',()=>{const tab=$('evidence-browser-tab');tab.value='inspections';$('evidence-browser-open').click();},'btn btn-secondary'));
  pin('analysis','whatif','条件推演','analysis','campus-whatif-open',{wide:true});
  pin('analysis','analysis','T5 分析与助手','analysis','campus-analysis-open',{wide:true});
  pin('analysis','analysis-history','最近运行与复盘','timeline').actions.append(button('查看运行历史',()=>{selectBoard('evidence');$('all-runs-btn').focus({preventScroll:true});},'btn btn-secondary'));
  // Card surfaces open the existing detail controller; nested controls keep their own action.
  const primary={alerts:()=>getPoints().find(p=>p.realtime?.current&&p.latest_status==='alarm')&&openDetail(getPoints().find(p=>p.realtime?.current&&p.latest_status==='alarm').point_id),blockers:()=>openTasks(getRun()?.blockers?.[0]?.task_id||'tasks'),tasks:()=>openTasks(),evidence:()=>{$('campus-run-evidence-open').click();}};
  for(const [id,p] of pins){
    const entry=p.actions.querySelector('button');
    if(!entry&&!primary[id])continue;
    p.card.tabIndex=0;p.card.setAttribute('aria-label',p.card.querySelector('h3').textContent+'，打开内容');
    const open=()=>{if(entry&&!entry.disabled)entry.click();else if(!entry)primary[id]?.();};
    on(p.card,'click',e=>{if(e.target.closest('button,a,input,select,textarea,label,summary')||!getSelection().isCollapsed)return;open();});
    on(p.card,'keydown',e=>{if(e.target===p.card&&(e.key==='Enter'||e.key===' ')){e.preventDefault();open();}});
  }
  dock.remove();oldShell.remove();
  const masonry=initBoardMasonry([...grids.values()],motionAllowed);

  function selectBoard(id,{focus=false}={}){
    if(!panels.has(id))return;
    if(id!==active){scrolls.set(active,window.scrollY);active=id;
      for(const [key,panel] of panels)panel.hidden=key!==id;
      requestAnimationFrame(()=>{window.scrollTo({top:scrolls.get(id)||0,behavior:'instant'});masonry.refresh({reset:true});if(focus)$('board-title').focus({preventScroll:true});});
      if(motionAllowed())panels.get(id).animate([{opacity:.6,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],{duration:200,easing:'ease-out'});
    }
    document.body.dataset.board=id;
    const config=boards.find(b=>b[0]===id);$('board-title').textContent=config[1]==='总览'?'校园设施空间总览':config[1];$('board-purpose').textContent=config[2];
    for(const [key,item] of navItems){if(key===id)item.button.setAttribute('aria-current','page');else item.button.removeAttribute('aria-current');}
    if(id==='evidence'&&loadedEvidenceRevision!==evidenceRevision&&!evidenceLoading)loadEvidence();
    sync();masonry.refresh();
  }
  on(nav,'keydown',e=>{if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const current=[...navItems.values()].findIndex(n=>n.button===document.activeElement);if(current<0)return;e.preventDefault();const items=[...navItems.values()],i=e.key==='Home'?0:e.key==='End'?items.length-1:(current+(['ArrowDown','ArrowRight'].includes(e.key)?1:-1)+items.length)%items.length;items[i].button.focus();});
  function syncFilters(){
    const filters=getFilters(),entries=[];
    if(filters.query)entries.push(['query','搜索：'+filters.query,'']);
    for(const [key,id,label]of [['scope','mobile-scope','范围'],['required','required-filter','属性'],['status','status-filter','状态']])if(filters[key]!=='all')entries.push([key,label+'：'+$(id).selectedOptions[0]?.textContent,'all']);
    const signature=JSON.stringify(entries);if(chips.dataset.signature!==signature){chips.dataset.signature=signature;chips.replaceChildren(...entries.map(([key,label,value])=>{const b=button(label+' ×',()=>{setFilters({[key]:value});$('search').focus({preventScroll:true});},'btn btn-ghost btn-small');b.setAttribute('aria-label','移除'+label);return b;}));}
    chips.hidden=!entries.length;filterbar.classList.toggle('has-filters',entries.length>0);
    const data=getData(),points=getPoints(),matched=points.filter(p=>matchesPoint(p,filters));
    scope.textContent=entries.length?`匹配 ${matched.length} / ${points.length} 个点位；轮次统计与运行历史保持完整范围。`:'搜索点位、设施或位置 · 记录可在“证据与复核”按轮次与时间查询';
    filterToggle.textContent=entries.length?'筛选 · '+entries.length:'筛选';
    return {data,points,matched,filters,hasFilters:entries.length>0};
  }
  function taskRows(run){return run?.task_results?.map(t=>el('div',{class:'pin-row'},el('div',{},el('strong',{},t.task_id+' · '+t.name),badge(taskLabels[t.state]||'状态未知',toneOf(t.state)),el('p',{},t.reason)),focusedAction('依据',()=>openTasks(t.task_id),'task-'+t.task_id)))||[empty('尚未生成判断。请先选择轮次或建立教学实例。')];}
  function proofRows(run){
    if(!run?.evidence?.length)return [empty('尚无选定运行的判断证据。')];
    const items=run.evidence.slice(0,6).map(e=>el('div',{class:'pin-row'},
      el('div',{},el('code',{},e.checkpoint_id||'运行级证据'),
        el('p',{},e.evidence_type),el('small',{},`${e.source_type} · 取得状态 ${e.status}`))));
    return [el('div',{class:'pin-list'},...items),note(`此运行关联 ${run.evidence.length} 条证据；完整字段可在判断依据中查看。`)];
  }
  function sync(){
    if(disposed)return;
    const {data,points,matched,hasFilters}=syncFilters(),run=getRun(),runs=getRuns()||[];
    const alarms=points.filter(p=>p.realtime?.current&&p.latest_status==='alarm'),pendingPoints=points.filter(p=>(p.review?.effective_status||p.review?.status)==='pending');
    const hasRound=!!data?.inspection_round_id,missing=hasRound?points.filter(p=>p.required&&p.covered===false):null;
    const values={overview:points.length,coverage:missing?.length,tasks:run?.task_results?.length,evidence:pendingPoints.length,analysis:runs.filter(r=>r.run_type==='what_if').length};
    const countLabels={overview:'点位总数',coverage:'待补检点位',tasks:'选定运行任务数',evidence:'存在待处理复核的点位',analysis:'最近运行中的条件推演数'};
    for(const [id,item]of navItems){item.count.textContent=values[id]??'—';item.button.title=countLabels[id]+'：'+(values[id]??'未取得');}
    const contextKey=JSON.stringify([data?.inspection_round_id,run?.run_id,alarms.map(p=>p.point_id),hasRound]);
    if($('board-context').dataset.signature!==contextKey){$('board-context').dataset.signature=contextKey;$('board-context').replaceChildren(el('p',{class:'pin-meta'},data?.inspection_round_id?'轮次 '+data.inspection_round_id:'未选择轮次'),run?el('code',{title:run.run_id},'冻结运行 '+run.run_id):note('尚未生成判断'),button('当前远程告警 '+(data?alarms.length:'—'),()=>{selectBoard('overview');pins.get('alerts').card.scrollIntoView({block:'center',behavior:'instant'});},alarms.length?'btn btn-secondary board-urgent':'btn btn-ghost btn-small'));}
    paint('alerts',alarms.map(p=>[p.point_id,p.latest_status,p.realtime?.facility?.observation?.condition]),()=>[alarms.length?rows(alarms,p=>facilityState(p)[0]):empty(data?'当前未取得有效远程告警。':'正在读取远程状态…'),note('仅新发生的有效告警可触发弹窗；过期或未知不作为故障。')]);
    paint('missing',[data?.inspection_round_id,missing?.map(p=>p.point_id)],()=>[el('div',{class:'pin-datum'},el('strong',{},missing?.length??'—'),el('span',{},'个必检点待补记录')),missing?.length?rows(missing.slice(0,3),()=> '缺少当轮有效现场记录'):empty(hasRound?'本轮必检点已有有效现场记录。':'选择轮次后计算覆盖，不能由远程状态代替。')]);
    pins.get('missing').actions.querySelector('button').disabled=!hasRound;
    paint('gaps',[data?.inspection_round_id,missing?.map(p=>p.point_id)],()=>[missing?.length?rows(missing,()=> '缺少当轮有效现场记录'):empty(hasRound?'本轮没有待补检的必检点。':'未选择轮次，覆盖尚未判断。')]);
    const roundKey=[data?.inspection_round_id,data?.window_start,data?.window_end,run?.run_id];
    for(const id of ['round','round-short'])paint(id,roundKey,()=>[data?.inspection_round_id?el('div',{},el('code',{},data.inspection_round_id),el('p',{},`${fmt(data.window_start)} — ${fmt(data.window_end)}`),note(run?'正在显示已保存的判断快照。':'已选轮次，尚未生成判断。')):empty('尚未选择巡检轮次。'),note('现场记录、设施状态与任务判断分别呈现。')]);
    pins.get('point-search').card.hidden=!hasFilters;paint('point-search',matched.map(p=>[p.point_id,p.device]),()=>[matched.length?rows(matched,()=> '当前搜索与筛选命中'):empty('没有匹配点位。可移除顶部筛选条件。')]);
    const ring=$('board-coverage-ring'),ratio=hasRound&&data.required_total>0&&typeof data.covered==='number'?data.covered/data.required_total:null;
    ring.style.setProperty('--coverage-angle',ratio===null?'0deg':(ratio*360)+'deg');$('board-coverage-value').textContent=ratio===null?'—':Math.round(ratio*100)+'%';ring.setAttribute('aria-label',ratio===null?'覆盖尚未判断':`必检覆盖 ${data.covered}/${data.required_total}`);
    paint('blockers',run?.run_id,()=>run?.blockers?.length?run.blockers.map(b=>el('div',{class:'pin-row'},el('div',{},el('strong',{},b.task_id+' · '+b.dependency_id),el('p',{},b.reason),note(b.point_ids?.join('、')||'任务依赖')),focusedAction('依据',()=>openTasks(b.task_id),'blocker-'+b.dependency_id))):[empty(run?'此运行未列出明确阻塞；证据不足仍需查看任务依据。':'尚未生成判断，无法列出当前阻塞。')]);
    for(const id of ['run-evidence','evidence'])paint(id,run?.run_id,()=>proofRows(run));
    paint('tasks',run?.run_id,()=>taskRows(run));
    paint('plans',run?.run_id,()=>run?.plan_results?.length?[el('div',{class:'pin-plan-list'},...run.plan_results.map(p=>el('article',{class:'pin-plan','data-board-plan':p.plan_id},el('h4',{},p.name),badge(planLabel(run,p.state),p.state==='executable'?'good':p.state==='not_executable'?'danger':'muted'),el('p',{class:'pin-datum'},p.estimated_minutes+' 分钟'),el('p',{},p.reason)))),note('耗时是案例教学估计；方案可执行不代表任务完成。')]:[empty(run?'此运行没有候选方案结果。':'尚未生成判断。'),note('建立 S3 教学实例后，可比较甲、乙、丙三个方案。')]);
    paint('whatif',run?.run_id,()=>[el('span',{class:'pin-label'},'教学推演'),el('h4',{},'改变条件，保留现实'),note('可调整剩余时间、人员可用性和访问权限；结果保存为带 parent_run_id 的独立运行。'),run?el('code',{},run.run_id):empty('尚未选择现实运行。'),note(run?.scenario_id==='S3'?'已选 S3 现实运行，可以打开推演。':'需先生成或选择已完成的 S3 现实运行。')]);
    paint('analysis',run?.run_id,()=>[el('span',{class:'pin-label'},'AI 辅助分析'),el('h4',{},'现在哪还没巡？派谁去最省时间？'),note('统计 → 外部上下文 → 资料检索 → 模型 → 只读工具 → AI 解释'),run?el('p',{},run.summary):empty('尚未生成判断，分析需要已有现实运行作为依据。'),note('打开助手查看实际结果与来源；AI 不替代现场判断。')]);
    paint('analysis-history',runs.map(r=>r.run_id),()=>runs.length?[el('div',{class:'pin-list'},...runs.slice(0,4).map(r=>el('div',{class:'pin-row'},el('div',{},el('small',{},fmt(r.created_at)),el('p',{},r.summary||'运行记录')),focusedAction('查看',()=>openRun(r.run_id),'run-'+r.run_id)))),note('展示已保存运行摘要，不为旧运行补造历史快照。')]:[empty('尚无运行记录。')]);
    if(data!==lastData){lastData=data;evidenceRevision++;if(active==='evidence'&&!evidenceLoading)loadEvidence();}
    renderEvidence();masonry.refresh();
  }
  async function loadEvidence(force=false){
    if(evidenceLoading&&!force)return;const epoch=++evidenceEpoch, revision=evidenceRevision;evidenceLoading=true;evidenceError='';renderEvidence();
    const points=getData()?.points||[];
    const [reviewResult,inspectionResult,...photos]=await Promise.allSettled([api('/api/reviews'),api('/api/inspections?limit=50&offset=0'),...points.filter(p=>p.photo_count>0).map(p=>api('/api/points/'+encodeURIComponent(p.point_id)))]);
    if(disposed||epoch!==evidenceEpoch)return;
    const errors=[];if(inspectionResult.status==='fulfilled')inspectionPage=inspectionResult.value;else errors.push('现场记录：'+inspectionResult.reason.message);if(reviewResult.status==='fulfilled')reviews=reviewResult.value.items;else errors.push('复核：'+reviewResult.reason.message);
    photoPages=photos.filter(r=>r.status==='fulfilled').map(r=>r.value);if(photos.some(r=>r.status==='rejected'))errors.push('部分照片元数据读取失败');
    evidenceError=errors.join('；');loadedEvidenceRevision=revision;evidenceLoading=false;renderEvidence();masonry.refresh();
    if(active==='evidence'&&revision!==evidenceRevision)loadEvidence();
  }
  function renderEvidence(){
    const matched=new Set(getPoints().filter(p=>matchesPoint(p,getFilters())).map(p=>p.point_id));
    const photos=photoPages.filter(d=>matched.has(d.point.point_id)).flatMap(d=>(d.photos||[]).map(photo=>({...photo,point_id:d.point.point_id}))).sort((a,b)=>String(b.inspected_at||b.created_at).localeCompare(String(a.inspected_at||a.created_at)));
    paint('photos',[photos.map(p=>p.image_id),evidenceLoading,evidenceError],()=>[
      note('实际保存的现场照片 · 全部轮次 · 按当前点位筛选'),
      ...(evidenceLoading?[note('正在读取照片与复核…')]:[]),
      ...(evidenceError?[el('p',{class:'pin-error',role:'status'},evidenceError),button('重试读取',()=>loadEvidence(true),'btn btn-secondary')]:[]),
      photos.length?el('div',{class:'pin-photos'},...photos.slice(0,8).map((p,i)=>{const b=focusedAction('',()=>openPhotos(photos,i),'photo-'+p.image_id);b.className='pin-preview';b.setAttribute('aria-label','预览 '+p.point_id+' 现场照片');b.append(el('img',{src:p.url,alt:p.point_id+' 已保存现场证据',loading:'lazy'}),el('span',{},p.point_id+' · '+fmt(p.inspected_at)));return b;})):empty(evidenceLoading?'正在读取…':evidenceError?'照片读取未完成。':'尚无实际照片。概念示意不会作为现场证据。'),
      photos.length>8?note(`当前展示最近 8 / ${photos.length} 张，完整照片可在点位详情查看。`):null
    ].filter(Boolean));
    const facilities=new Map(getPoints().filter(p=>matched.has(p.point_id)).map(p=>[p.facility_id,p.point_id]));
    const records=(inspectionPage?.items||[]).filter(r=>facilities.has(r.facility_id));
    paint('records',[records.map(r=>r.inspection_id),evidenceLoading,evidenceError],()=>[
      note('最近 50 条现场记录内按当前点位筛选 · 全部轮次'),
      ...(evidenceError?[el('p',{class:'pin-error'},evidenceError),button('重试读取',()=>loadEvidence(true),'btn btn-secondary')]:[]),
      records.length?el('div',{class:'pin-list'},...records.slice(0,5).map(r=>el('div',{class:'pin-row'},
        el('div',{},el('code',{},facilities.get(r.facility_id)),el('small',{},fmt(r.inspected_at)),
          el('p',{},r.notes||'未提供现场说明'),note('轮次 '+(r.inspection_round_id||'未归入轮次'))),
        focusedAction('详情',()=>openDetail(facilities.get(r.facility_id)),'inspection-'+r.inspection_id)))):
        empty(evidenceLoading?'正在读取现场记录…':evidenceError?'记录读取未完成。':'当前筛选下暂无现场记录。')
    ]);
    const filtered=(reviews||[]).filter(r=>matched.has(r.point_id)&&(reviewFilter==='all'||(r.effective_status||r.status)===reviewFilter)).sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
    paint('reviews',[filtered.map(r=>[r.review_id,r.effective_status,r.status,r.reason]),reviewFilter,evidenceLoading,evidenceError],()=>{
      const controls=el('div',{class:'board-review-filters',role:'group','aria-label':'复核处理状态'},...['pending','completed','timeout','cancelled','all'].map(key=>{const b=button(key==='all'?'全部':reviewLabels[key],()=>{reviewFilter=key;renderEvidence();},'btn btn-ghost btn-small');b.dataset.focusKey='review-filter-'+key;b.setAttribute('aria-pressed',String(key===reviewFilter));return b;}));
      return [controls,...(evidenceError?[el('p',{class:'pin-error',role:'status'},evidenceError),button('重试读取',()=>loadEvidence(true),'btn btn-secondary')]:[]),note('当前处理状态 · 全部轮次 · 等待最久的优先'),filtered.length?el('div',{class:'pin-list'},...filtered.slice(0,6).map(r=>el('div',{class:'pin-row'},el('div',{},el('code',{},r.point_id),badge(reviewLabels[r.effective_status||r.status]||'状态未知',(r.effective_status||r.status)==='pending'?'warn':'muted'),el('p',{},r.reason),el('small',{},fmt(r.created_at))),focusedAction('处理 / 查看',()=>openReview(r.review_id),'review-'+r.review_id)))):empty(evidenceLoading?'正在读取复核请求…':evidenceError?'复核读取未完成，请重试。':'当前筛选下没有此状态的复核请求。')];
    });
  }
  selectBoard('overview');
  // Retain the original dialogs, including their unsaved form and nested-photo behavior.
  on(window,'pagehide',event=>{if(event.persisted)return;disposed=true;evidenceEpoch++;events.abort();masonry.dispose();});
  return {sync,select:selectBoard,locate,refreshEvidence:()=>loadEvidence(true)};
}
