// Local PCM capture. No audio leaves the current project origin.
export function encodeWav(samples){
 const bytes=new ArrayBuffer(44+samples.length*2),v=new DataView(bytes);
 const text=(offset,s)=>[...s].forEach((c,i)=>v.setUint8(offset+i,c.charCodeAt(0)));
 text(0,'RIFF');v.setUint32(4,36+samples.length*2,true);text(8,'WAVE');text(12,'fmt ');
 v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);
 v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,samples.length*2,true);
 samples.forEach((s,i)=>v.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,s))*(s<0?32768:32767)),true));
 return bytes;
}
export function mergeTranscript(current,text,limit){
 if(!text.trim())return current;
 const next=current+(current?'\n':'')+text.trim();
 if(limit>0&&next.length>limit)throw new RangeError('转写与原说明合计超过字数限制，请先整理原说明；下面的转写可复制。');
 return next;
}
async function request(url,options={},signal){
 const r=await fetch(url,{...options,signal});let data;try{data=await r.json();}catch{throw Error('语音服务返回无效响应，请重试。');}
 if(!r.ok)throw Error(data.detail||`语音服务请求失败（${r.status}），请重试。`);return data;
}
export function mountVoiceInput({notes,form,el,button}){
 let state='idle',generation=0,session=null,audio=null,controller=null,available=false,disposed=false,timeout=null;
 const message=el('p',{role:'status',class:'form-message',id:'review-voice-status'},'正在检查本地中文识别…');
 const preview=el('textarea',{'aria-label':'待整理的转写文字',readOnly:true,rows:3,hidden:true});
 const start=button('开始语音转写',startRecording,'btn btn-secondary');start.id='review-asr';
 const stop=button('停止并转写',stopRecording,'btn btn-ghost');stop.id='review-asr-stop';
 const retry=button('重试这段录音',()=>transcribe(generation),'btn btn-secondary');retry.id='review-asr-retry';retry.hidden=true;
 const recheck=button('重新检查语音服务',check,'btn btn-ghost');recheck.hidden=true;
 const controls=el('div',{class:'form-actions'},start,stop,retry,recheck);
 form.append(el('p',{class:'field-hint'},'本地中文转写：音频仅发送到当前项目后端，不保存录音、不调用浏览器在线识别。最长 60 秒；结果仅填入草稿，须人工核对。'),message,controls,preview);
 const supported=()=>isSecureContext&&!!navigator.mediaDevices?.getUserMedia&&!!window.AudioContext&&!!window.AudioWorkletNode;
 function update(next){state=next;start.disabled=!available||!['idle','failed'].includes(state);stop.disabled=!['requesting','recording'].includes(state);stop.textContent=state==='requesting'?'取消录音':'停止并转写';retry.hidden=!(state==='failed'&&audio);}
 async function check(){
  available=false;update('idle');recheck.hidden=true;
  if(!supported()){message.textContent='此浏览器或连接不支持麦克风录音，请使用 HTTPS / localhost 的现代浏览器，或请手写现场说明。';return;}
  const checkGeneration=generation;
  try{const r=await request('/api/speech/status',{},AbortSignal.timeout(10000));if(disposed||generation!==checkGeneration)return;available=r.available;message.textContent=r.message;recheck.hidden=available;update('idle');}
  catch{if(!disposed&&generation===checkGeneration){message.textContent='无法连接本地语音服务，草稿可继续手写。';recheck.hidden=false;}}
 }
 function release(s){
  if(!s)return;clearTimeout(s.timer);s.node?.disconnect();s.source?.disconnect();s.stream?.getTracks().forEach(t=>t.stop());
  if(s.context&&s.context.state!=='closed')s.context.close().catch(()=>{});
 }
 function cancel(){
  generation++;clearTimeout(timeout);controller?.abort();controller=null;release(session);session=null;audio=null;
  update('idle');recheck.hidden=available||!supported();message.textContent='录音或转写已取消，麦克风已释放，原草稿保留。';
 }
 async function startRecording(){
  if(!available||!['idle','failed'].includes(state))return;
  const token=++generation;audio=null;preview.hidden=true;update('requesting');message.textContent='请允许麦克风权限…';
  const s={chunks:[],frames:0,context:null};session=s;
  try{
   s.context=new AudioContext();
   await s.context.resume();
   s.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
   if(token!==generation){release(s);return;}
   await s.context.audioWorklet.addModule('/static/voice-capture-worklet.js');
   if(token!==generation){release(s);return;}
   s.source=s.context.createMediaStreamSource(s.stream);s.node=new AudioWorkletNode(s.context,'campus-voice-capture');
   s.node.port.onmessage=({data})=>{
    if(token!==generation)return;
    if(data.type==='samples'){
     const remaining=Math.max(0,Math.floor(s.context.sampleRate*60)-s.frames),chunk=data.samples.subarray(0,remaining);
     s.chunks.push(chunk);s.frames+=chunk.length;
     if(state==='recording')message.textContent=`正在录音 ${Math.floor(s.frames/s.context.sampleRate)} / 60 秒，点击停止后转写。`;
    }
    if(data.type==='flushed')s.flushed?.();
   };
   s.source.connect(s.node);s.node.connect(s.context.destination);update('recording');message.textContent='正在录音，请说出现场情况…';
   s.timer=setTimeout(stopRecording,60000);
  }catch(e){
   release(s);if(token!==generation)return;session=null;update('idle');
   message.textContent=({NotAllowedError:'未取得麦克风权限。请在地址栏的站点设置允许麦克风后重试。',NotFoundError:'未找到麦克风，请连接录音设备后重试。',NotReadableError:'麦克风无法读取，可能正被其他程序独占。'})[e.name]||'录音未能启动，请检查浏览器与麦克风后重试。';
  }
 }
 async function stopRecording(){
  if(state==='requesting'){cancel();return;}if(state!=='recording')return;
  const token=generation,s=session;update('processing');message.textContent='正在整理录音…';clearTimeout(s.timer);
  try{
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('录音处理超时，请重录。')),2000);s.flushed=()=>{clearTimeout(timer);resolve();};s.node.port.postMessage('flush');});
   release(s);session=null;if(token!==generation)return;
   if(s.frames<.1*s.context.sampleRate)throw Error('录音太短，请重新录音。');
   const samples=new Float32Array(s.frames);let offset=0;for(const c of s.chunks){samples.set(c,offset);offset+=c.length;}
   const offline=new OfflineAudioContext(1,Math.min(960000,Math.ceil(samples.length*16000/s.context.sampleRate)),16000);
   const buffer=offline.createBuffer(1,samples.length,s.context.sampleRate);buffer.copyToChannel(samples,0);
   const source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start();
   const rendered=await offline.startRendering();if(token!==generation)return;
   audio=new Blob([encodeWav(rendered.getChannelData(0))],{type:'audio/wav'});await transcribe(token);
  }catch(e){release(s);if(token===generation){session=null;update('idle');message.textContent=e.message;}}
 }
 async function transcribe(token){
  if(!audio||disposed||token!==generation||state==='transcribing')return;
  update('transcribing');message.textContent='正在本地识别，首次需要加载模型…';const abort=new AbortController();controller=abort;const deadline=setTimeout(()=>abort.abort(),60000);timeout=deadline;
  try{
   const data=await request('/api/speech/transcribe',{method:'POST',headers:{'Content-Type':'audio/wav'},body:audio},abort.signal);
   if(token!==generation||disposed)return;
   if(data.status!=='ok'||!data.text){audio=null;update('idle');message.textContent=data.message||'未识别到清晰语音，请重新录音。';return;}
   try{notes.value=mergeTranscript(notes.value,data.text,notes.maxLength);notes.dispatchEvent(new Event('input',{bubbles:true}));message.textContent='转写已追加到草稿，请人工核对设备编号和内容。尚未保存或提交现场证据。';}
   catch(e){preview.value=data.text;preview.hidden=false;message.textContent=e.message;}
   audio=null;update('idle');
  }catch(e){if(token===generation&&!disposed){update('failed');message.textContent=e.name==='AbortError'?'本地识别超时，原草稿保留；可重试这段录音。':e instanceof TypeError?'与项目语音服务的连接中断，原草稿保留；可重试这段录音。':e.message;}}
  finally{clearTimeout(deadline);if(controller===abort)controller=null;}
 }
 check();return {cancel,destroy(){disposed=true;cancel();}};
}
