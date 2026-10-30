const node=(tag,text,attrs={})=>{const e=document.createElement(tag);e.textContent=text;Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v));
return e;};
export async function request(url,options){const response=await fetch(url,options);
let data;
try{data=await response.json();}catch{throw Error(`服务返回非 JSON（HTTP ${response.status}）`);}if(!response.ok)throw Error(`HTTP ${response.status}：${typeof data.detail==='string'?data.detail:JSON.stringify(data.detail??data)}`);
return data;}
export function attachRoundSelector(grid){const label=node('label','归属轮次（可选）',{class:'field field-wide'}),select=node('select','',{name:'inspection_round_id'}),hint=node('span','默认留存，不归入轮次。固定窗口 09:00–09:45，Asia/Shanghai。',{class:'field-hint'}),retry=node('button','重新读取轮次',{type:'button',class:'btn btn-secondary'});select.append(node('option','留存，不归入轮次',{value:''}));label.append(select,hint,retry);grid.append(label);
async function load(){retry.disabled=true;
try{const data=await request('/api/rounds?limit=200');
const value=select.value;select.replaceChildren(node('option','留存，不归入轮次',{value:''}),...data.items.map(r=>node('option',`${r.date} · ${r.round_id}`,{value:r.round_id})));select.value=value;hint.textContent='固定窗口 09:00–09:45，Asia/Shanghai；窗口外记录仍留存。';}catch(e){hint.textContent=`轮次读取失败：${e.message}。可重试，其他输入保留。`;}finally{retry.disabled=false;}}retry.onclick=load;load();}
export function initEvidenceBrowser({showDialog,overlayChanged}={}){
const open=node('button','记录与证据',{id:'evidence-browser-open',type:'button',class:'btn btn-secondary'});document.querySelector('.activity-rail').prepend(open);
const dialog=node('dialog','',{id:'evidence-browser-dialog',class:'run-dialog','aria-labelledby':'evidence-browser-title'}),header=node('header','',{class:'drawer-header'}),close=node('button','关闭',{id:'evidence-browser-close',type:'button',class:'btn btn-ghost'}),body=node('div','',{class:'drawer-body'});header.append(node('h2','记录与证据',{id:'evidence-browser-title'}),close);dialog.append(header,body);document.body.append(dialog);
const controls=node('form','',{class:'evidence-filters'}),tab=node('select','',{id:'evidence-browser-tab'});[['history','远程历史'],['inspections','现场记录'],['evidence','证据']].forEach(([value,text])=>tab.append(node('option',text,{value})));
const facility=node('select','',{id:'evidence-facility-filter'}),round=node('select','',{id:'evidence-round-filter'});round.append(node('option','全部轮次',{value:''}));
const from=node('input','',{id:'evidence-from',type:'datetime-local'}),to=node('input','',{id:'evidence-to',type:'datetime-local'}),search=node('button','查询 / 重试',{id:'evidence-search',type:'submit',class:'btn btn-secondary'});
[[tab,'记录类型'],[facility,'设施编号（精确匹配）'],[round,'轮次'],[from,'起始时间（本机时区）'],[to,'截止时间（本机时区）']].forEach(([input,text])=>{const label=node('label',text);label.append(input);controls.append(label);});controls.append(search);
const status=node('p','',{id:'evidence-status',role:'status'}),results=node('div','',{id:'evidence-results'}),prev=node('button','上一页',{id:'evidence-prev',class:'btn btn-secondary',type:'button'}),next=node('button','下一页',{id:'evidence-next',class:'btn btn-secondary',type:'button'}),pages=node('div','',{class:'form-actions'});pages.append(prev,next);
const create=node('form','',{id:'round-create-form',class:'evidence-filters'}),rid=node('input','',{id:'round-create-id',required:'',placeholder:'轮次编号'}),day=node('input','',{id:'round-create-date',required:'',type:'date'}),save=node('button','创建轮次',{id:'round-create-submit',class:'btn btn-secondary',type:'submit'});[[rid,'轮次编号'],[day,'日期（Asia/Shanghai）']].forEach(([input,text])=>{const label=node('label',text);label.append(input);create.append(label);});create.append(save);
const created=node('p','',{role:'status'}),check=node('button','执行存储自检',{id:'storage-check-submit',class:'btn btn-secondary',type:'button'}),checked=node('pre','',{id:'storage-check-status',role:'status'});
body.append(node('p','仅浏览阶段 02 接入后留存的记录，不回填旧历史；旧记录仍可在点位详情查看。轮次固定 09:00–09:45，Asia/Shanghai。'),controls,status,results,pages,node('h3','显式创建轮次'),create,created,node('h3','数据库存储自检'),check,checked);
facility.append(node('option','全部设施',{value:''}));
request('/api/facilities').then(items=>facility.append(...items.map(f=>node('option',`${f.checkpoint_id} · ${f.facility_id}`,{value:f.facility_id})))).catch(e=>{created.textContent=`设施目录读取失败：${e.message}`;});
let offset=0,token=0;
const labels={NORMAL:'正常',WARNING:'预警',FAULT:'故障',SIMULATED:'模拟源',DEVICE:'设备源',ON_SITE:'现场',SYSTEM:'系统',ok:'成功',error:'失败',missing:'缺失',unavailable:'不可用',success:'成功',REMOTE:'远程'};
const human=v=>labels[v]??v??'未提供';
async function rounds(){const data=await request('/api/rounds?limit=200');
const value=round.value;round.replaceChildren(node('option','全部轮次',{value:''}),...data.items.map(r=>node('option',`${r.date} · ${r.round_id}`,{value:r.round_id})));round.value=value;}
async function load(){const mine=++token;search.disabled=true;prev.disabled=true;next.disabled=true;status.textContent='正在读取持久化记录…';results.replaceChildren();
try{const query=new URLSearchParams({limit:'20',offset:String(offset)});
if(facility.value.trim())query.set('facility_id',facility.value.trim());round.disabled=tab.value==='history';
if(round.value&&!round.disabled)query.set('inspection_round_id',round.value);
if(from.value)query.set('from',new Date(from.value).toISOString());
if(to.value)query.set('to',new Date(to.value).toISOString());
const data=await request(`/api/${tab.value}?${query}`);
if(mine!==token)return;status.textContent=`共 ${data.total} 条 · 第 ${Math.floor(offset/20)+1} 页${data.total?'':' · 暂无符合条件的记录'}`;
for(const row of data.items){const article=node('article','',{class:'evidence-record'});article.append(node('h3',row.evidence_id??row.inspection_id??row.observation_id),node('p',`设施 ${row.facility_id??'不适用'} · 来源 ${human(row.source_type??row.method??row.origin)} · 轮次 ${row.inspection_round_id??'未归入轮次'}`),node('p',`业务事实：${human(row.result??row.payload_json?.condition??row.value_json?.result??row.value_json?.condition)}${row.raw_result?` · 原始结论 ${row.raw_result}（不推定严重程度）`:''}`),node('p',`采集状态：${row.status?human(row.status):'记录已持久化（未提供独立采集状态）'}`));
for(const [key,text]of [['observed_at','观测时间'],['received_at','接收时间'],['inspected_at','现场检查时间'],['created_at','入库时间'],['retrieved_at','取证时间'],['valid_until','有效期截止']])if(key in row)article.append(node('p',`${text}：${row[key]??'未设定'}`));
if(row.result_semantics)article.append(node('p','结论语义：'+row.result_semantics));
if('window_eligible' in row)article.append(node('p','固定窗口资格：'+String(row.window_eligible)+'（记录仍留存）'));
const details=node('details',''),summary=node('summary','完整记录与来源详情'),pre=node('pre',JSON.stringify(row,null,2));details.append(summary,pre);article.append(details);results.append(article);}prev.disabled=offset===0;next.disabled=offset+20>=data.total;}catch(e){if(mine===token)status.textContent=`读取失败：${e.message}。请重试。`;}finally{if(mine===token)search.disabled=false;}}
controls.onsubmit=e=>{e.preventDefault();offset=0;load();};tab.onchange=()=>{offset=0;load();};prev.onclick=()=>{offset=Math.max(0,offset-20);load();};next.onclick=()=>{offset+=20;load();};create.onsubmit=async e=>{e.preventDefault();save.disabled=true;
try{await request('/api/rounds',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({round_id:rid.value,date:day.value})});roundDirty=false;created.textContent='轮次已保存。';await rounds();}catch(error){created.textContent=`创建失败：${error.message}。输入已保留，可重试。`;}finally{save.disabled=false;}};check.onclick=async()=>{check.disabled=true;checked.textContent='正在执行真实写入、读回和历史查询…';
try{checked.textContent='存储自检已通过，写入与读回已完成。详情：\\n'+JSON.stringify(await request('/api/evidence/storage-check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),null,2);}catch(e){checked.textContent=`存储自检失败：${e.message}。可重试；数据库错误不代表设施故障。`;}finally{check.disabled=false;}};open.onclick=()=>{if(showDialog)showDialog(dialog);else dialog.showModal();load();rounds().catch(e=>{created.textContent=`轮次读取失败：${e.message}。重新打开可重试。`;});};let roundDirty=false;create.addEventListener('input',()=>roundDirty=true);const allowClose=()=>!roundDirty||confirm('还有未提交的轮次信息。关闭将保留输入，是否继续？');close.onclick=()=>{if(allowClose())dialog.close();};dialog.addEventListener('cancel',e=>{if(!allowClose())e.preventDefault();});dialog.addEventListener('close',()=>{overlayChanged?.();open.focus();});
}



