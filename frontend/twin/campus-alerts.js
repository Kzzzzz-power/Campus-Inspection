import {createAlertQueue,alertFeedStatus} from './campus-alerts-model.js';
const names={WARNING:'警告',FAULT:'故障',UNAVAILABLE:'设备不可用'};
function el(tag,attrs={},text=''){const n=document.createElement(tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);n.textContent=text;return n;}
export function initCampusAlerts({host,onFocus,onInspect}){
 const q=createAlertQueue(),events=new AbortController();let key=null,previous=null,audio=null,sound=false,suspended=false;
 const panel=el('details',{class:'twin-alerts'}),summary=el('summary'),list=el('div',{class:'twin-alert-list'}),soundButton=el('button',{type:'button','aria-pressed':'false'},'告警声音：关闭');
 const connection=el('p',{class:'twin-alert-connection',role:'status'},'正在连接远程状态');
 const rule=el('p',{class:'twin-alert-rule'},'首次加载已有告警只列入列表；之后新告警弹窗提示。同一告警持续上报不重复弹出。待补检不等于设施故障。');
 summary.textContent='远程告警 · 正在连接';panel.append(summary,connection,rule,soundButton,list);host.querySelector('.twin-toolbar').after(panel);
 const popup=el('section',{class:'twin-alert-popup',role:'dialog','aria-modal':'false','aria-labelledby':'twin-alert-title',hidden:''});
 const heading=el('h3',{id:'twin-alert-title'}),body=el('p'),note=el('p',{class:'twin-alert-note'},'远程告警 ≠ 巡检覆盖。知道了仅关闭提示，不代表复核完成。'),actions=el('div',{class:'twin-alert-actions'}),announcement=el('span',{class:'sr-only','aria-live':'polite'});
 const focus=el('button',{type:'button'},'查看点位'),inspect=el('button',{type:'button'},'进入巡查'),close=el('button',{type:'button'},'知道了');actions.append(focus,inspect,close);popup.append(heading,body,note,actions);document.body.append(popup,announcement);
 const on=(e,t,f)=>e.addEventListener(t,f,{signal:events.signal});
 function dismiss(){const held=popup.contains(document.activeElement);q.dismiss();render();if(held)(previous?.isConnected?previous:summary).focus({preventScroll:true});}
 function ping(){if(!sound||!audio||document.hidden)return;const t=audio.currentTime,osc=audio.createOscillator(),gain=audio.createGain();osc.frequency.value=520;gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(.035,t+.03);gain.gain.exponentialRampToValueAtTime(.001,t+.24);osc.connect(gain).connect(audio.destination);osc.start(t);osc.stop(t+.25);osc.onended=()=>{osc.disconnect();gain.disconnect();};}
 function render(){
  const a=q.current,blocked=suspended||document.hidden||!!document.querySelector('dialog[open]')||document.getElementById('inspection-alert-popup')?.hidden===false;popup.hidden=!a||blocked;
  if(!a){key=null;return;}if(blocked)return;
  heading.textContent=`${a.pointId} · ${a.name} · ${names[a.kind]}`;
  body.textContent=`${a.condition} / ${a.availability}\n观测：${new Date(a.observedAt).toLocaleString('zh-CN',{hour12:false})}\n来源：${a.sourceType}${a.sourceType==='SIMULATED'?' · 教学模拟':''}\n待查看 ${q.pending} 条`;
  popup.dataset.pointId=a.pointId;popup.dataset.key=a.key;
  if(key!==a.key){key=a.key;previous=document.activeElement;announcement.textContent=heading.textContent;ping();}
 }
 on(close,'click',dismiss);on(focus,'click',()=>{if(q.current){onFocus(q.current.pointId);dismiss();}});on(inspect,'click',()=>{if(q.current){const id=q.current.pointId;dismiss();onInspect(id);}});
 on(document,'keydown',e=>{if(e.key==='Escape'&&!popup.hidden&&!document.querySelector('dialog[open]')){e.preventDefault();e.stopImmediatePropagation();dismiss();}});
 on(document,'inspectgo:inspection-reminder',render);on(document,'visibilitychange',render);on(document,'inspectgo:overlay',e=>{suspended=!!e.detail.open;render();});
 on(soundButton,'click',async()=>{sound=!sound;if(sound){try{audio??=new(window.AudioContext||window.webkitAudioContext)();await audio.resume();}catch{sound=false;}}soundButton.textContent=`告警声音：${sound?'开启':'关闭'}`;soundButton.setAttribute('aria-pressed',String(sound));});
 return {sync(snapshot){
      q.sync(snapshot.nodes);const feed=alertFeedStatus(snapshot);host.dataset.alertStream=feed.ready?'ready':'unavailable';
   const source=snapshot.nodes.some(n=>n.quality==='live'&&n.sourceType==='SIMULATED')?' · 含教学模拟数据':'';
   const status=feed.label+source;if(connection.textContent!==status)connection.textContent=status;
   summary.textContent=feed.ready?`当前告警 ${q.active.length} · 查看列表`:`${feed.label.split('，')[0].split('；')[0]} · 查看说明`;
   // Preserve keyboard focus across repeating telemetry frames.
   const identity=q.active.map(a=>a.pointId+a.kind).join('|');
   if(list.dataset.identity!==identity){list.replaceChildren();for(const a of q.active){const row=el('button',{type:'button','data-alert-point':a.pointId});on(row,'click',()=>onFocus(a.pointId));list.append(row);}list.dataset.identity=identity;}
   for(const a of q.active){const row=list.querySelector(`[data-alert-point="${a.pointId}"]`);row.textContent=`${a.pointId} ${a.name} · ${names[a.kind]} · ${a.observedAt} · ${a.sourceType}`;}
   if(!q.active.length)list.textContent=feed.ready?'暂无当前有效告警；过期或断线保留最后已知，不作为新告警。':'当前不能确认远程告警；链路恢复前不将未知、过期或待补检点当作故障。';
   host.dataset.alertCount=String(q.active.length);host.dataset.alertPending=String(q.pending);render();
  },dispose(){events.abort();audio?.close();panel.remove();popup.remove();announcement.remove();}};
}
