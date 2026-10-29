import {matchesPoint} from './model.js';
import {initMotion} from './motion.js';
import {createFilterPickers} from './filter-pickers.js';

const $ = id => document.getElementById(id);
const state = {queueButtons:new Map(),runButtons:new Map(),mapButtons:new Map(),runToken:0,refreshPromise:null,detailTrigger:null,data:null, runs:[], filters:{query:'',scope:'all',required:'all',status:'all'}, cards:new Map(), groups:new Map(), refreshing:false, detail:null, detailToken:0, dirty:false, saving:false, gallery:[], photoIndex:0, runRequest:null};
const motionEffects = new WeakMap(), activeEffects = new Set();
let activeViewTransition = null, photoDirection = 0;
let filterPickers = null;
function presentationMotionAllowed(){return !document.hidden&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&document.documentElement.dataset.feedback==='on';}
function animateFeedback(target,frames,duration=180){
  if(!target)return;
  motionEffects.get(target)?.cancel();
  if(!presentationMotionAllowed()||!target.animate)return;
  const animation=target.animate(frames,{duration,easing:'cubic-bezier(.16,1,.3,1)'});
  motionEffects.set(target,animation);activeEffects.add(animation);
  const clean=()=>{activeEffects.delete(animation);if(motionEffects.get(target)===animation)motionEffects.delete(target);};
  animation.finished.then(clean,clean);
}
function revealFeedback(target,distance=6,duration=200){animateFeedback(target,[{opacity:.55,transform:`translateY(${distance}px)`},{opacity:1,transform:'translateY(0)'}],duration);}
// Read card geometry in two batches; only discrete filters use FLIP.
function captureCardPositions(){
  return new Map([...$('facility-groups').querySelectorAll('.point-card')].map(card=>[card,card.getBoundingClientRect()]));
}
function filterFeedback(before){
  const after=captureCardPositions();
  for(const [card,rect] of after){
    const previous=before.get(card);
    if(!previous){revealFeedback(card,6,180);continue;}
    const dx=previous.left-rect.left,dy=previous.top-rect.top;
    if(Math.abs(dx)>.5||Math.abs(dy)>.5)animateFeedback(card,[{transform:`translate(${dx}px,${dy}px)`},{transform:'translate(0,0)'}],280);
  }
  animateFeedback($('result-count'),[{opacity:.4},{opacity:1}],180);
}
function dialogFeedback(dialog){
  const transform=dialog.classList.contains('drawer')&&innerWidth>580?'translateX(18px)':'translateY(12px)';
  animateFeedback(dialog,[{opacity:.65},{opacity:1}],180);
  animateFeedback(dialog.querySelector('.drawer-body,.photo-figure'),[{opacity:.65,transform},{opacity:1,transform:'translate(0,0)'}],220);
}
const paths = {
  arrow:'M5 12h14m-6-6 6 6-6 6', check:'m5 12 4 4L19 6', clock:'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  alert:'m12 3 10 18H2L12 3Zm0 6v5m0 3h.01', camera:'M3 7h4l2-3h6l2 3h4v13H3V7Zm13 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  building:'M4 21V3h10v18m0-12h6v12M8 7h2M8 11h2M8 15h2M8 19h2M17 13h1M17 17h1', file:'M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8M8 17h6', plus:'M12 5v14M5 12h14', eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
};
function icon(name) { const s=document.createElementNS('http://www.w3.org/2000/svg','svg'); s.setAttribute('viewBox','0 0 24 24');s.setAttribute('class','icon');s.setAttribute('fill','none');s.setAttribute('stroke','currentColor');s.setAttribute('stroke-width','1.6');s.setAttribute('stroke-linecap','round');s.setAttribute('stroke-linejoin','round');s.setAttribute('aria-hidden','true');const p=document.createElementNS(s.namespaceURI,'path');p.setAttribute('d',paths[name]||paths.file);s.append(p);return s; }
function el(tag, attrs={}, ...children) {
  const item=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs)) {
    if(value===null||value===undefined) continue;
    if(key==='class') item.className=value;
    else if(key.startsWith('on')) item.addEventListener(key.slice(2),value);
    else if(key==='text') item.textContent=value;
    else if(key in item && !key.startsWith('aria')) item[key]=value;
    else item.setAttribute(key,String(value));
  }
  for(const child of children.flat()) if(child!==null&&child!==undefined) item.append(child instanceof Node?child:document.createTextNode(String(child)));
  return item;
}
function button(label, action, className='btn btn-secondary', symbol) { return el('button',{type:'button',class:className,onclick:action},symbol?icon(symbol):null,label); }
function date(value, full=false) { if(!value) return '未记录'; const d=new Date(value);return Number.isNaN(d.valueOf())?'时间格式未知':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',...(full?{second:'2-digit'}:{})}); }
function clock(value) { const d=new Date(value);return Number.isNaN(d.valueOf())?'—':d.toLocaleTimeString('zh-CN',{hour12:false}); }
function statusBadge(text,tone='muted') { return el('span',{class:`status-badge is-${tone}`},icon(tone==='good'?'check':tone==='danger'?'alert':'clock'),text); }
function facilityState(p) { return ({ok:['最近记录正常','good'],alarm:['告警待关注','danger'],unknown:['状态待确认','warn'],'no-record':['暂无状态记录','muted']})[p.latest_status]||['状态待确认','muted']; }
function reviewState(review) { if(!review) return ['尚未发起','muted'];if(review.status==='pending') return ['待复核','warn'];return review.conclusion==='fault'?['已复核 · 确认异常','danger']:['已复核 · 确认正常','good']; }
function coverageState(p) { return !p.required?['不计入必检统计','muted']:p.covered?['现场记录有效','good']:['缺少有效现场记录','warn']; }
function statusRow(label, status) { return el('div',{class:'status-row'},el('span',{class:'status-label'},label),statusBadge(...status)); }
function errorText(error) { if(error.status===403) return '没有执行此操作的权限，请核对访问权限。';if(error.status===409) return error.message+' 请重新打开详情核对，已填写内容仍保留。';return error.message||'请求失败，请稍后重试。'; }
async function api(url, options={}) {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),30000);
  try { const response=await fetch(url,{...options,signal:controller.signal});let data;try{data=await response.json();}catch{data=null;}
    if(!response.ok) { let detail=data?.detail; if(Array.isArray(detail)) detail=detail.map(d=>`${d.loc?.slice(1).join('.')||'输入'}：${d.msg}`).join('；');const error=new Error(typeof detail==='string'?detail:`请求失败（${response.status}），请重试。`);error.status=response.status;throw error; }
    if(data===null) throw new Error('服务返回了无法识别的数据，请重试。');return data;
  } catch(error) { if(error.name==='AbortError'||error instanceof TypeError) throw new Error(options.method?'连接中断或响应超时，保存结果尚未确认。保留当前内容后重试，可核对同一次提交。':'连接中断或响应超时，请检查本地服务后重试。');throw error; }
  finally {clearTimeout(timer);}
}
const postJSON=(url,value)=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
let toastTimer;
function positionToast(){
  // A body's z-index cannot rise above a modal's top layer.
  const parent=[...document.querySelectorAll('dialog[open]')].at(-1)||document.body;
  if($('toast').parentElement!==parent)parent.append($('toast'));
}
function toast(message,isError=false) {positionToast();$('toast').textContent=message;$('toast').classList.add('visible');$('toast').classList.toggle('is-error',isError);revealFeedback($('toast'),6,180);clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),6500);}
function syncChildren(parent,children) {children.forEach((child,i)=>{if(parent.children[i]!==child)parent.insertBefore(child,parent.children[i]||null);});for(const child of [...parent.children])if(!children.includes(child))child.remove();}
function setFilters(values,{animate=true}={}) {
  if(Object.entries(values).every(([key,value])=>state.filters[key]===value))return;
  activeViewTransition?.skipTransition();
  const before=animate&&state.data?.points.length<=12&&presentationMotionAllowed()?captureCardPositions():null;
  for(const card of state.cards.values())motionEffects.get(card)?.cancel();
  motionEffects.get($('result-count'))?.cancel();
  Object.assign(state.filters,values);
  $('search').value=state.filters.query;$('required-filter').value=state.filters.required;$('status-filter').value=state.filters.status;$('mobile-scope').value=state.filters.scope;
  filterPickers?.sync();
  renderFacilities();renderNavSelection();
  if(before)filterFeedback(before);
}
function resetFilters(){setFilters({query:'',scope:'all',required:'all',status:'all'});}
function missingFilter(){setFilters({query:'',scope:'all',required:'required',status:'missing'});$('search').focus({preventScroll:true});}
function renderNavSelection(){for(const b of $('scope-nav').querySelectorAll('[data-scope]')){const active=b.dataset.scope===state.filters.scope;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}}
let navReady=false;
function renderNavigation(points){
  if(navReady)return;navReady=true;const nav=$('scope-nav');nav.replaceChildren();const select=$('mobile-scope');select.replaceChildren(el('option',{value:'all'},'全部楼栋与楼层'));
  function navButton(label,scope,count){const b=button(label,()=>setFilters({scope}),'scope-link',scope==='all'?'building':null);b.dataset.scope=scope;b.append(el('span',{class:'scope-count'},count));return b;}
  nav.append(navButton('全部空间','all',points.length));
  for(const building of [...new Set(points.map(p=>p.building))]){const subset=points.filter(p=>p.building===building);nav.append(el('div',{class:'nav-section'},navButton(building,`building:${building}`,subset.length)));select.append(el('option',{value:`building:${building}`},building));
    for(const zone of [...new Set(subset.map(p=>p.zone_id))]){const items=subset.filter(p=>p.zone_id===zone);nav.append(navButton(`${items[0].floor} · ${zone}`,`zone:${zone}`,items.length));select.append(el('option',{value:`zone:${zone}`},`${building} · ${items[0].floor}`));}
  }
  filterPickers ??= createFilterPickers({getPoints:()=>state.data?.points||[]});
  filterPickers.sync();
  renderNavSelection();
}
function makeCard(id){
  const pid=el('span',{class:'point-id'},id),required=el('span',{class:'point-kind'}),device=el('h3',{class:'point-device'}),location=el('p',{class:'point-location'}),statuses=el('div',{class:'status-lines'}),meta=el('p',{class:'point-meta'});
  const card=el('article',{class:'point-card','data-point':id},el('div',{class:'point-head'},pid,required),device,location,statuses,meta,el('div',{class:'point-actions'},button('查看详情',()=>openDetail(id),'btn btn-ghost btn-small','arrow'),button('现场记录',()=>openDetail(id,'inspect'),'btn btn-secondary btn-small','plus')));
  const corners=document.createElementNS('http://www.w3.org/2000/svg','svg');corners.setAttribute('class','glass-corners');corners.setAttribute('viewBox','0 0 100 100');corners.setAttribute('preserveAspectRatio','none');corners.setAttribute('aria-hidden','true');
  const edge=document.createElementNS(corners.namespaceURI,'path');for(const [key,value]of Object.entries({d:'M82 1 H94 L99 6 V14 M1 86 V94 L6 99 H18',fill:'none',stroke:'currentColor','stroke-width':'1','vector-effect':'non-scaling-stroke'}))edge.setAttribute(key,value);corners.append(edge);card.append(corners);
  card.update=p=>{required.textContent=p.required?'必检点':'普通点';required.classList.toggle('is-required',p.required);device.textContent=p.device;location.textContent=`${p.building} · ${p.floor} / ${p.zone_id}`;statuses.replaceChildren(statusRow('现场覆盖',coverageState(p)),statusRow('设施状态',facilityState(p)),statusRow('复核处理',reviewState(p.review)));meta.textContent=`${p.at?`记录 ${date(p.at)}`:'暂无记录时间'} · 照片 ${p.photo_count||0} 张`;};return card;
}
function renderFacilities(){
  if(!state.data)return;const visible=state.data.points.filter(p=>matchesPoint(p,state.filters));$('result-count').textContent=`当前筛选 ${visible.length} / ${state.data.points.length} 个点位`;
  const groups=[];
  for(const zone of [...new Set(visible.map(p=>p.zone_id))]){
    const subset=visible.filter(p=>p.zone_id===zone);let group=state.groups.get(zone);
    if(!group){group=el('section',{class:'zone-group'},el('div',{class:'zone-heading'},el('h2'),el('span')),el('div',{class:'point-grid'}));state.groups.set(zone,group);}
    group.querySelector('h2').textContent=`${subset[0].building} · ${subset[0].floor}`;group.querySelector('.zone-heading > span').textContent=`${zone} / ${subset.length} 个点位`;
    const cards=subset.map(p=>{let card=state.cards.get(p.point_id);if(!card){card=makeCard(p.point_id);state.cards.set(p.point_id,card);}card.update(p);return card;});syncChildren(group.lastElementChild,cards);groups.push(group);
  }
  if(!groups.length)groups.push(el('div',{class:'empty-state'},el('h3',{},'没有匹配的点位'),el('p',{},'试试其他编号、名称或筛选条件。'),button('清除筛选',resetFilters)));
  syncChildren($('facility-groups'),groups);
}
function renderQueue(){
  const points=state.data.points;const pending=points.filter(p=>p.review?.status==='pending');const gaps=points.filter(p=>p.required&&!p.covered);const seen=new Set([...pending,...gaps].map(p=>p.point_id));const alarms=points.filter(p=>p.latest_status==='alarm'&&!seen.has(p.point_id));
  const items=[...pending.map(p=>({p,kind:'待处理复核',tone:'warn'})),...gaps.filter(p=>!pending.includes(p)).map(p=>({p,kind:'待补现场记录',tone:'warn'})),...alarms.map(p=>({p,kind:'告警待关注',tone:'danger'}))];
  syncChildren($('pending-list'),items.length?items.map(({p,kind,tone})=>{let b=state.queueButtons.get(p.point_id);if(!b){b=button('',()=>openDetail(p.point_id),'queue-item');state.queueButtons.set(p.point_id,b);}b.replaceChildren(el('span',{class:'queue-point'},p.point_id),el('span',{},el('strong',{},p.device),el('small',{},kind)),icon('arrow'));b.dataset.tone=tone;return b;}):[el('p',{class:'empty-state'},'当前没有待补检点或待处理复核。')]);
}
function renderRuns(){
  syncChildren($('recent-runs'),state.runs.length?state.runs.slice(0,5).map(r=>{let b=state.runButtons.get(r.run_id);if(!b){b=button('',()=>openRun(r.run_id),'run-item');state.runButtons.set(r.run_id,b);}b.replaceChildren(el('time',{},date(r.created_at)),el('strong',{},r.summary||'覆盖判断'),el('code',{},r.run_id));return b;}):[el('p',{class:'empty-state'},'还没有运行记录。生成一次判断，保留当前覆盖结果。')]);
  $('all-runs-btn').disabled=!state.runs.length;
}
function renderDashboard(){
  const d=state.data;$('covered-count').textContent=d.covered;$('missing-count').textContent=d.missing.length;$('required-count').textContent=d.required_total;
  $('window-label').textContent=`过去 ${d.window_minutes} 分钟 · ${clock(d.window_start)}—${clock(d.window_end)}`;$('updated-at').textContent=date(d.as_of,true);
  renderNavigation(d.points);renderFacilities();renderQueue();
  const strip=$('coverage-strip');syncChildren(strip,d.points.map(p=>{let b=state.mapButtons.get(p.point_id);if(!b){b=button(p.point_id,()=>openDetail(p.point_id),'map-point');state.mapButtons.set(p.point_id,b);}b.className=`map-point ${!p.required?'is-optional':p.covered?'is-covered':'is-missing'}`;b.setAttribute('aria-label',`${p.point_id} ${p.device}：${coverageState(p)[0]}`);return b;}));
}
async function refresh(manual=false,afterMutation=false){
  if(state.refreshPromise){if(!afterMutation)return state.refreshPromise;await state.refreshPromise;return refresh(manual,true);}
  state.refreshPromise=performRefresh(manual).finally(()=>{state.refreshPromise=null;});return state.refreshPromise;
}
async function performRefresh(manual=false){
  state.refreshing=true;$('refresh-btn').disabled=true;$('refresh-btn').setAttribute('aria-busy','true');
  const [dashboard,runs]=await Promise.allSettled([api('/api/dashboard'),api('/api/runs')]);
  if(dashboard.status==='fulfilled'){state.data=dashboard.value;renderDashboard();$('connection-status').textContent='本地服务已连接 · 每 30 秒刷新';$('connection-status').classList.remove('is-error');}
  else{$('connection-status').textContent=`刷新失败${state.data?' · 正在显示上次数据':''}：${errorText(dashboard.reason)}`;$('connection-status').classList.add('is-error');if(!state.data)$('facility-groups').replaceChildren(el('div',{class:'error-state'},el('h3',{},'暂时无法读取巡检数据'),el('p',{},errorText(dashboard.reason)),button('重新连接',()=>refresh(true))));}
  if(runs.status==='fulfilled'){state.runs=runs.value;renderRuns();}else{$('recent-runs').replaceChildren(el('p',{class:'error-state'},'运行历史加载失败。'),button('重试',()=>refresh(true)));}
  state.refreshing=false;$('refresh-btn').disabled=false;$('refresh-btn').removeAttribute('aria-busy');
  if(manual)toast(dashboard.status==='fulfilled'?'已更新当前统计窗口与点位记录。':errorText(dashboard.reason),dashboard.status==='rejected');
}
function overlayChanged(){positionToast();document.dispatchEvent(new CustomEvent('inspectgo:overlay',{detail:{open:!!document.querySelector('dialog[open]')}}));}
function showDialog(dialog){filterPickers?.close();const opening=!dialog.open;if(opening)dialog.showModal();overlayChanged();if(opening)dialogFeedback(dialog);}
function closeDetail(){if(state.saving){toast('正在保存，请等待服务端确认。');return;}if(state.dirty&&!confirm('还有未提交的内容。关闭将放弃这次填写，是否继续？'))return;$('detail-dialog').close();}
async function openDetail(id,mode=null){
  if(state.saving){toast('正在保存，请等待确认后再切换。');return;}
  if(!$('detail-dialog').open)state.detailTrigger=document.activeElement;
  if($('detail-dialog').open&&state.dirty&&!confirm('还有未提交的内容。切换点位将放弃这次填写，是否继续？'))return;
  const token=++state.detailToken;state.detail=null;state.dirty=false;$('detail-title').textContent=id;$('detail-subtitle').textContent='正在读取点位证据';$('detail-body').replaceChildren(el('div',{class:'empty-state'},'正在读取现场记录与复核信息…'));showDialog($('detail-dialog'));
  try{const data=await api(`/api/points/${encodeURIComponent(id)}`);if(token!==state.detailToken||!$('detail-dialog').open)return;state.detail=data;renderDetail(mode);}catch(error){if(token!==state.detailToken)return;$('detail-body').replaceChildren(el('div',{class:'error-state'},errorText(error),button('重试',()=>openDetail(id,mode))));}
}
function detailSection(title,...content){return el('section',{class:'detail-section'},el('h3',{class:'section-title'},title),...content);}
function chooseDetailMode(mode){if(state.saving){toast('正在保存，请等待确认。');return;}if(state.dirty&&!confirm('切换操作将放弃尚未提交的内容，是否继续？'))return;state.dirty=false;renderDetail(mode);$('detail-body').querySelector('input,textarea')?.focus();}
function renderDetail(mode=null){
  const detail=state.detail,p=detail.point;$('detail-title').textContent=`${p.point_id} · ${p.device}`;$('detail-subtitle').textContent=`${p.building} · ${p.floor} / ${p.required?'必检点':'普通点'}`;
  const activeReview=detail.reviews.find(r=>r.status==='pending');
  const actions=el('div',{class:'point-actions'},button('填写现场记录',()=>chooseDetailMode('inspect'),'btn btn-primary','plus'),button(activeReview?'处理复核':'发起复核',()=>chooseDetailMode('review'),'btn btn-secondary','file'));
  const content=[detailSection('当前情况',el('div',{class:'detail-status'},statusRow('现场覆盖',coverageState(p)),statusRow('设施状态',facilityState(p)),statusRow('复核处理',reviewState(p.review))),el('p',{class:'field-hint'},'现场记录有效不代表设施正常；复核确认异常也属于已完成确认。'),actions)];
  if(mode==='inspect')content.push(detailSection('提交现场记录',inspectionForm(p)));
  if(mode==='review')content.push(detailSection(activeReview?'提交复核结果':'发起现场复核',activeReview?inspectionForm(p,activeReview):reviewForm(p)));
  const photos=detail.photos||[];
  content.push(detailSection(`现场照片 · ${photos.length} 张`,photos.length?el('div',{class:'photo-grid'},...photos.map((photo,i)=>{const b=button('',()=>openPhotos(photos,i),'photo-thumb');b.append(el('img',{src:photo.url,alt:`${p.point_id} 现场证据 ${i+1}`,loading:'lazy'}),el('span',{},date(photo.inspected_at)));return b;})):el('p',{class:'empty-state'},'尚无实际照片。历史文字中的“照片已上传”不代表已有图片文件。')));
  const recordItems = detail.records.map(r => el('article', {class:'record-item'},
    el('div', {class:'record-meta'}, el('strong', {}, r.source==='onsite'?'现场记录':'远程记录'), el('time', {}, date(r.inspected_at||r.created_at,true))),
    el('p', {}, r.evidence||'未填写说明'),
    el('small', {}, `${r.inspector_id?`记录人：${r.inspector_id}`:'记录人：未记录'} · ${r.is_legacy?'历史模拟记录':'人工提交'} · ${r.status==='ok'?'记录正常':r.status==='alarm'?'记录异常':'状态未知'}`)
  ));
  content.push(detailSection('现场证据与记录时间', el('div', {class:'record-list'}, ...(recordItems.length?recordItems:[el('p',{class:'empty-state'},'暂无记录。')]))));
  if(detail.reviews.length)content.push(detailSection('复核处理记录',...detail.reviews.map(r=>el('article',{class:'review-item'},statusBadge(...reviewState(r)),el('p',{},r.reason),el('small',{},`${date(r.updated_at||r.created_at,true)} · 版本 ${r.version}`),el('code',{},r.review_id)))));
  $('detail-body').replaceChildren(...content);$('detail-body').scrollTop=0;revealFeedback($('detail-body').querySelector('form')||$('detail-body'),mode?6:0,mode?200:140);if(!$('detail-dialog').contains(document.activeElement))$('detail-close').focus({preventScroll:true});
}
let fieldSequence=0;
function field(label,control,hint,wide=false){const id=`field-${++fieldSequence}`;control.id=id;return el('div',{class:`field${wide?' field-wide':''}`},el('label',{htmlFor:id},label),control,hint?el('p',{class:'field-hint'},hint):null);}
function localInputTime(){const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function formMessage(target,message,error=false){target.textContent=message;target.classList.toggle('is-error',error);target.classList.toggle('is-success',!error);target.setAttribute('role',error?'alert':'status');}
function inspectionForm(point,review=null){
  const form=el('form',{'data-form':review?'review-evidence':'inspection'}),message=el('p',{class:'form-message','aria-live':'polite'}),submit=el('button',{type:'submit',class:'btn btn-primary'},review?'提交复核结果':'保存现场记录');
  const inspector=el('input',{name:'inspector_id',required:true,maxLength:80,placeholder:'填写姓名或巡检编号',autocomplete:'name'});
  const time=el('input',{name:'inspected_at',type:'datetime-local',value:localInputTime(),required:true});
  const result=el('select',{name:review?'conclusion':'result',required:true},... (review?[['','请选择确认结论'],['normal','确认正常'],['fault','确认异常'],['unknown','仍无法确认']]:[['','请选择检查结果'],['ok','现场未发现异常'],['alarm','现场发现异常'],['unknown','现场仍无法判断']]).map(([value,label])=>el('option',{value},label)));
  const notes=el('textarea',{name:'notes',required:true,maxLength:2000,rows:3,placeholder:review?'填写复核过程、所见事实和判断依据':'记录现场所见、检查内容和发现的问题'});
  const files=el('input',{name:'photos',type:'file',accept:'image/jpeg,image/png,image/webp',multiple:true}),fileInfo=el('p',{class:'field-hint'});
  const confirmed=el('input',{name:'onsite_confirmed',type:'checkbox',required:true,value:'true'});
  const grid=el('div',{class:'form-grid'},field('巡检人',inspector),field('现场时间',time,'按本机时区填写'),field(review?'人工确认结论':'检查结果',result,review?'“仍无法确认”会保留待复核状态。':null,true),field('现场说明',notes,null,true),field('照片（可选）',files,'JPEG、PNG、WebP；每张不超过 10MB，最多 5 张。',true));
  grid.append(fileInfo,el('label',{class:'check-field field-wide'},confirmed,el('span',{},'我已到达现场并完成上述检查。照片上传本身不代表复核通过。')));
  if(review)form.append(el('p',{class:'field-hint'},`复核原因：${review.reason} · 当前版本 ${review.version}`));form.append(grid,message,el('div',{class:'form-actions'},submit));
  let requestId=crypto.randomUUID();
  form.addEventListener('input',()=>{state.dirty=true;requestId=crypto.randomUUID();});
  files.addEventListener('change',()=>{const selected=[...files.files];fileInfo.textContent=selected.map(f=>`${f.name} (${(f.size/1024/1024).toFixed(1)}MB)`).join('、');files.setCustomValidity(selected.length>5?'最多选择 5 张图片。':selected.some(f=>f.size>10*1024*1024)?'单张图片不能超过 10MB。':'');});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(state.saving||!form.reportValidity())return;state.saving=true;
    const body=new FormData(form);body.set('point_id',point.point_id);body.set('request_id',requestId);body.set('inspected_at',new Date(time.value).toISOString());if(!files.files.length)body.delete('photos');
    if(review){body.set('version',String(review.version));body.set('result',({normal:'ok',fault:'alarm',unknown:'unknown'})[result.value]);}
    const controls=[...form.querySelectorAll('input,select,textarea,button')];controls.forEach(c=>c.disabled=true);submit.setAttribute('aria-busy','true');submit.textContent='正在保存…';formMessage(message,'正在等待服务端保存确认。');
    try{await api(review?`/api/reviews/${encodeURIComponent(review.review_id)}/evidence`:'/api/inspections',{method:'POST',body});state.dirty=false;state.saving=false;toast(review&&result.value==='unknown'?'复核证据已保存，仍需继续确认。':'已保存到本地数据库。');await refresh(false,true);await openDetail(point.point_id);}
    catch(error){formMessage(message,errorText(error),true);}
    finally{state.saving=false;controls.forEach(c=>c.disabled=false);submit.removeAttribute('aria-busy');submit.textContent=review?'提交复核结果':'保存现场记录';}
  });return form;
}
function reviewForm(point){
  const form=el('form',{'data-form':'review-request'}),reason=el('textarea',{name:'reason',rows:3,required:true,maxLength:1000,placeholder:'说明需要现场确认的问题，例如告警与现场情况不一致'}),message=el('p',{class:'form-message','aria-live':'polite'}),submit=el('button',{type:'submit',class:'btn btn-primary'},'创建复核请求');let requestId=crypto.randomUUID();
  form.append(field('复核原因',reason,'发起请求只会加入待复核队列，不会修改设施状态。',true),message,el('div',{class:'form-actions'},submit));form.addEventListener('input',()=>{state.dirty=true;requestId=crypto.randomUUID();});
  form.addEventListener('submit',async e=>{e.preventDefault();if(state.saving||!form.reportValidity())return;state.saving=true;submit.disabled=true;reason.disabled=true;submit.setAttribute('aria-busy','true');submit.textContent='正在创建…';
    try{await postJSON('/api/reviews',{point_id:point.point_id,reason:reason.value,request_id:requestId});state.dirty=false;state.saving=false;toast('复核请求已创建，等待现场证据。');await refresh(false,true);await openDetail(point.point_id,'review');}catch(error){formMessage(message,errorText(error),true);}finally{state.saving=false;submit.disabled=false;reason.disabled=false;submit.removeAttribute('aria-busy');submit.textContent='创建复核请求';}
  });return form;
}
function openPhotos(photos,index){state.gallery=photos;state.photoIndex=index;renderPhoto();showDialog($('photo-dialog'));}
function renderPhoto(direction=0){const photo=state.gallery[state.photoIndex];if(!photo)return;photoDirection=direction;$('photo-image').setAttribute('aria-busy','true');motionEffects.get($('photo-image'))?.cancel();$('photo-image').src=photo.url;$('photo-image').alt=`${photo.point_id} 现场证据照片`;$('photo-caption').textContent=`${photo.point_id} · 现场时间 ${date(photo.inspected_at,true)} · 上传时间 ${date(photo.created_at,true)}`;$('photo-position').textContent=`${state.photoIndex+1} / ${state.gallery.length}`;$('photo-prev').disabled=state.photoIndex===0;$('photo-next').disabled=state.photoIndex===state.gallery.length-1;}
function stepPhoto(delta){const next=state.photoIndex+delta;if(next>=0&&next<state.gallery.length){state.photoIndex=next;renderPhoto(delta);}}
function renderRun(run){
  $('run-title').textContent='运行判断';const content=[el('code',{class:'run-id'},run.run_id),el('p',{},date(run.created_at,true)),el('h3',{},run.summary||'覆盖快照')];
  if(!run.snapshot)content.push(el('p',{class:'empty-state'},'这是一条历史摘要。旧版本未保存完整快照，无法补造当时的点位详情。'));
  else {const s=run.snapshot;content.push(el('p',{class:'field-hint'},`保存时的窗口：${date(s.window_start,true)}—${date(s.window_end,true)}。此结果不会随当前看板刷新而变化。`),el('div',{class:'run-stat'},el('strong',{},`${s.covered} / ${s.required_total}`),' 个必检点已覆盖'),el('div',{class:'run-points'},...s.points.filter(p=>p.required).map(p=>el('div',{class:'status-row'},el('span',{},`${p.point_id} · ${p.device}`),statusBadge(...coverageState(p))))));}
  content.push(el('p',{class:'field-hint'},'本次为覆盖判断快照，不修改设施状态，也不代表完成全部任务或安全验收。'));$('run-body').replaceChildren(...content);animateFeedback($('run-body'),[{opacity:.6},{opacity:1}],160);
}
async function openRun(id){const token=++state.runToken;$('run-title').textContent='运行判断';$('run-body').replaceChildren(el('p',{class:'empty-state'},'正在读取保存结果…'));showDialog($('run-dialog'));try{const run=await api(`/api/runs/${encodeURIComponent(id)}`);if(token===state.runToken&&$('run-dialog').open)renderRun(run);}catch(error){$('run-body').replaceChildren(el('p',{class:'error-state'},errorText(error)),button('重试',()=>openRun(id)));}}
async function newRun(){const b=$('run-btn');if(b.disabled)return;b.disabled=true;b.setAttribute('aria-busy','true');state.runRequest??=crypto.randomUUID();
  try{const run=await postJSON('/api/runs',{request_id:state.runRequest});state.runRequest=null;state.runToken++;renderRun(run);showDialog($('run-dialog'));toast('运行判断已保存。');await refresh(false,true);}catch(error){toast(errorText(error),true);}finally{b.disabled=false;b.removeAttribute('aria-busy');}
}
$('refresh-btn').addEventListener('click',()=>refresh(true));$('run-btn').addEventListener('click',newRun);$('missing-shortcut').addEventListener('click',missingFilter);$('reset-filters').addEventListener('click',resetFilters);
$('search').addEventListener('input',e=>setFilters({query:e.target.value},{animate:false}));$('mobile-scope').addEventListener('change',e=>setFilters({scope:e.target.value}));$('required-filter').addEventListener('change',e=>setFilters({required:e.target.value}));$('status-filter').addEventListener('change',e=>setFilters({status:e.target.value}));
const viewSwitch=document.querySelector('.view-switch');
viewSwitch.dataset.view='grid';
function applyView(mode){$('facility-groups').classList.toggle('list-view',mode==='list');$('view-grid').setAttribute('aria-pressed',String(mode==='grid'));$('view-list').setAttribute('aria-pressed',String(mode==='list'));}
for(const mode of ['grid','list'])$('view-'+mode).addEventListener('click',()=>{
  if(viewSwitch.dataset.view===mode)return;
  activeViewTransition?.skipTransition();
  viewSwitch.dataset.view=mode;
  document.querySelectorAll('.point-card[data-point]').forEach(card=>{card.style.viewTransitionName=`card-${card.dataset.point}`;});
  if(document.startViewTransition&&presentationMotionAllowed()){
    const transition=document.startViewTransition(()=>{if(viewSwitch.dataset.view===mode)applyView(mode);});
    activeViewTransition=transition;
    const finish=()=>{if(activeViewTransition===transition)activeViewTransition=null;};
    transition.finished.then(finish,finish);
    transition.ready.then(()=>{
      const rules=[],animations=document.getAnimations().filter(animation=>animation.effect?.pseudoElement?.startsWith('::view-transition-group(card-'));
      for(const animation of animations){
        const frames=animation.effect.getKeyframes(),from=frames[0],to=frames.at(-1);
        const fromMatrix=new DOMMatrixReadOnly(from.transform),toMatrix=new DOMMatrixReadOnly(to.transform);
        const fromWidth=parseFloat(from.width),fromHeight=parseFloat(from.height),toWidth=parseFloat(to.width),toHeight=parseFloat(to.height);
        if(![fromWidth,fromHeight,toWidth,toHeight].every(Number.isFinite)||toWidth<=0||toHeight<=0)continue;
        rules.push(`${animation.effect.pseudoElement}{width:${toWidth}px;height:${toHeight}px;transform-origin:0 0;}`);
        animation.effect.setKeyframes([
          {transform:`translate(${fromMatrix.e}px,${fromMatrix.f}px) scale(${fromWidth/toWidth},${fromHeight/toHeight})`},
          {transform:`translate(${toMatrix.e}px,${toMatrix.f}px) scale(1,1)`}
        ]);
      }
      const style=document.createElement('style');style.textContent=rules.join('\n');document.head.append(style);
      transition.finished.then(()=>style.remove(),()=>style.remove());
    },()=>{}).catch(()=>transition.skipTransition());
  }else applyView(mode);
});
const finePointer=matchMedia('(hover: hover) and (pointer: fine)');
document.addEventListener('pointermove',event=>{
  if(event.pointerType!=='mouse'||!finePointer.matches||!presentationMotionAllowed()||!(event.target instanceof Element))return;
  const card=event.target.closest('.point-card');if(!card)return;
  const rect=card.getBoundingClientRect();card.style.setProperty('--mx',`${event.clientX-rect.left}px`);card.style.setProperty('--my',`${event.clientY-rect.top}px`);
},{passive:true});
const feedbackControls='.btn, .queue-item, .scope-link, .run-item, .photo-thumb, .map-point, #missing-shortcut, .filter-picker-trigger, .picker-row, .picker-section, .picker-dismiss';
function feedbackControl(target){return target instanceof Element?target.closest(feedbackControls):null;}
function clickRing(control,x,y){
  if(!presentationMotionAllowed()||control.matches(':disabled'))return;
  const host=control.closest('dialog[open]')||document.body,ring=el('span',{class:'click-ring','aria-hidden':'true'});
  ring.style.left=`${x}px`;ring.style.top=`${y}px`;
  ring.addEventListener('animationend',()=>ring.remove(),{once:true});host.append(ring);setTimeout(()=>ring.remove(),700);
}
function clearPressed(){document.querySelectorAll('.ui-pressed').forEach(control=>control.classList.remove('ui-pressed'));}
document.addEventListener('pointerdown',event=>{
  const control=feedbackControl(event.target);
  if(event.button!==0||!control||control.matches(':disabled')||!presentationMotionAllowed())return;
  control.classList.add('ui-pressed');clickRing(control,event.clientX,event.clientY);
},{passive:true});
for(const event of ['pointerup','pointercancel'])document.addEventListener(event,clearPressed,{passive:true});
window.addEventListener('blur',clearPressed);
document.documentElement.addEventListener('pointerleave',clearPressed);
document.addEventListener('keydown',event=>{
  const control=feedbackControl(event.target);
  if(!event.repeat&&['Enter',' '].includes(event.key)&&control&&!control.matches(':disabled')&&presentationMotionAllowed())control.classList.add('ui-pressed');
});
document.addEventListener('keyup',clearPressed);
document.addEventListener('click',event=>{
  const control=feedbackControl(event.target);
  if(event.detail===0&&control){const rect=control.getBoundingClientRect();clickRing(control,rect.left+rect.width/2,rect.top+rect.height/2);}
},{capture:true});
document.addEventListener('inspectgo:feedback',event=>{
  if(event.detail.enabled)return;
  clearPressed();for(const animation of activeEffects)animation.cancel();activeEffects.clear();activeViewTransition?.skipTransition();
  document.querySelectorAll('.click-ring').forEach(ring=>ring.remove());
});
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('close',()=>{motionEffects.get(dialog)?.cancel();dialog.querySelectorAll('.click-ring').forEach(ring=>ring.remove());clearPressed();});
$('detail-close').addEventListener('click',closeDetail);$('detail-dialog').addEventListener('cancel',e=>{e.preventDefault();closeDetail();});$('detail-dialog').addEventListener('close',()=>{state.detailToken++;state.dirty=false;state.detail=null;overlayChanged();if(!state.detailTrigger?.isConnected)$('search').focus({preventScroll:true});});
for(const name of ['photo','run']){$(name+'-close').addEventListener('click',()=>$(name+'-dialog').close());$(name+'-dialog').addEventListener('close',overlayChanged);}
$('photo-prev').addEventListener('click',()=>stepPhoto(-1));$('photo-next').addEventListener('click',()=>stepPhoto(1));$('photo-dialog').addEventListener('keydown',e=>{if(e.key==='ArrowLeft')stepPhoto(-1);if(e.key==='ArrowRight')stepPhoto(1);});$('photo-image').addEventListener('load',()=>{$('photo-image').removeAttribute('aria-busy');if($('photo-dialog').open)animateFeedback($('photo-image'),[{opacity:.55,transform:`translateX(${photoDirection*10}px)`},{opacity:1,transform:'translateX(0)'}],180);});$('photo-image').addEventListener('error',()=>{$('photo-image').removeAttribute('aria-busy');$('photo-caption').textContent='图片暂时无法读取，请关闭后重试。';});
$('all-runs-btn').addEventListener('click',()=>{state.runToken++;$('run-title').textContent='最近运行记录';$('run-body').replaceChildren(el('p',{class:'field-hint'},'最多显示最近 20 次运行；点击查看当时保存的结果。'),...state.runs.map(r=>button(`${date(r.created_at)} · ${r.summary||r.run_id}`,()=>openRun(r.run_id),'run-item')));showDialog($('run-dialog'));});
window.addEventListener('beforeunload',e=>{if(state.dirty||state.saving){e.preventDefault();e.returnValue='';}});
let disposeMotion=initMotion();let poll=setInterval(()=>{if(!document.hidden)refresh();},30000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});window.addEventListener('pagehide',()=>{clearInterval(poll);disposeMotion();});window.addEventListener('pageshow',event=>{if(event.persisted){disposeMotion=initMotion({replayIntro:false});clearInterval(poll);poll=setInterval(()=>{if(!document.hidden)refresh();},30000);refresh();}});
refresh();

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const targets = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(item => item.getClientRects().length);
    if (!targets.length) { event.preventDefault(); return; }
    const index = targets.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); targets.at(-1).focus(); }
    else if (!event.shiftKey && (index === targets.length - 1 || index < 0)) { event.preventDefault(); targets[0].focus(); }
  });
}
