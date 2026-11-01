// Integrated 3D workbench acceptance: real API persistence, point actions, dialogs and keyboard navigation.
// MQTT is disabled here; dedicated twin-browser.cjs covers the real-time chain.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','speech-browser','flow-'+Date.now());
fs.mkdirSync(OUT,{recursive:true});
const env={...process.env,TEMP:OUT,TMP:OUT,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',INSPECTGO_SEED_DEMO:'false'};
const PY=process.env.INSPECTGO_PYTHON||path.resolve(ROOT,'..','..','.venv','Scripts','python.exe'),BPY=process.env.INSPECTGO_BROKER_PYTHON||path.resolve(ROOT,'..','broker-venv','Scripts','python.exe');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),children=[],probeMessages=[],frames=[];
const report={started_at:new Date().toISOString(),out:OUT,status:'failed',checks:[],errors:[]};
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await sleep(100);}throw Error(label+' timed out'+(last?' '+last.message:''));}
async function port(){return new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});}
function start(name,exe,args,extra={}){
 const out=fs.openSync(path.join(OUT,name+'.out.log'),'a'),err=fs.openSync(path.join(OUT,name+'.err.log'),'a');
 const child=spawn(exe,args,{cwd:ROOT,env:{...env,...extra},windowsHide:true,stdio:['ignore','pipe',err]});
 fs.closeSync(err);children.push(child);
 child.stdout.on('data',chunk=>fs.writeSync(out,chunk));child.once('close',()=>fs.closeSync(out));
 child.on('error',e=>report.errors.push(name+': '+e.message));return child;
}
async function stop(child){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
 else child.kill('SIGTERM');
 await until(()=>child.exitCode!==null||child.signalCode!==null,'child stopped',10000);
}
class CDP {
 constructor(url){this.url=url;this.id=0;this.pending=new Map();}
 async open(){this.ws=new WebSocket(this.url);await new Promise((r,j)=>{this.ws.addEventListener('open',r,{once:true});this.ws.addEventListener('error',j,{once:true});});this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params);if(m.method==='Network.webSocketFrameReceived'){try{const data=JSON.parse(m.params.response.payloadData);if(data.type==='facilities_snapshot'){frames.push(data);if(frames.length>200)frames.shift();}}catch{}}});}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id,timer=setTimeout(()=>reject(Error(method+' timeout')),15000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
 async wait(expression){return until(()=>this.eval(expression),expression);}
}
(async()=>{
 let cdp;const webPort=await port(),debugPort=await port(),base=`http://127.0.0.1:${webPort}`;
 async function check(name,fn){await fn();report.checks.push({name,status:'passed'});console.log('PASS '+name);}
 async function click(selector){
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',behavior:'instant'})`);
  let previousBounds=null;
  await until(async()=>{
   const bounds=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(n=>Math.round(n*10)/10).join(',');})()`);
   const stable=bounds&&bounds===previousBounds;previousBounds=bounds;return stable;
  },'stable pointer target '+selector);
  const r=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(${JSON.stringify(selector)})===e};})()`);
  assert(r.hit,'Pointer target obstructed: '+selector);
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:r.x,y:r.y});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:r.x,y:r.y});
 }
 async function set(selector,value){await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
 async function key(value,code=value,n=27){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:value,code,windowsVirtualKeyCode:n});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:value,code,windowsVirtualKeyCode:n});}
 async function shot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,name+'.png'),Buffer.from(r.data,'base64'));}
 const api=async path=>(await fetch(base+path)).json();
 async function settled(){await cdp.wait("document.querySelector('#campus-stage').dataset.transition!=='flying'");}


 const request=async(url,payload)=>{const response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json();assert(response.ok,url+': '+JSON.stringify(data));return data;};

 try{
  start('api',PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(webPort)],{INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads'),INSPECTGO_MQTT_ENABLED:'false',INSPECTGO_LLM_ENABLED:'false',INSPECTGO_VLM_ENABLED:'false'});
  await until(async()=>(await fetch(base+'/health')).ok,'API');
  assert((await api('/api/speech/status')).available,'Install local model first');
  const prep=await request('/api/scenarios/S2/prepare',{instance_id:'speech-test',request_id:'speech-test-prepare'});
  const original=await request('/api/runs',{scenario_id:'S2',inspection_round_id:prep.inspection_round_id,as_of:prep.as_of,request_id:'speech-test-run'});
  const made=await request('/api/reviews',{point_id:'C07',task_id:'T4',reason:'本地语音隔离验收',trigger_run_id:original.run_id,request_id:'speech-test-review',expires_at:new Date(Date.now()+86400000).toISOString()});
  const originalReview=await api('/api/reviews/'+made.review.review_id);
  const audio=process.env.INSPECTGO_ASR_TEST_AUDIO||path.join(ROOT,'.runtime/asr-fix/mandarin-test.wav');assert(fs.existsSync(audio));
  start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${audio}`,'--autoplay-policy=no-user-gesture-required',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const page=await until(async()=>{const list=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return list.find(t=>t.type==='page');},'Chrome');
  cdp=new CDP(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__tracks=[];window.__getMic=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async(...args)=>{const s=await window.__getMic(...args);window.__tracks.push(...s.getTracks());return s;};window.SpeechRecognition=window.webkitSpeechRecognition=class{constructor(){throw Error('Browser online speech must not be used');}};`});
  await cdp.send('Page.navigate',{url:base});await cdp.wait("document.querySelector('#review-list-open')");
  await click('#review-list-open');await cdp.wait("document.querySelector('#review-body .queue-item')");
  await cdp.eval("[...document.querySelectorAll('#review-body .queue-item')].find(e=>e.textContent.includes('本地语音隔离验收')).id='voice-test-review'");await click('#voice-test-review');
  await cdp.wait("document.querySelector('#review-asr')&&!document.querySelector('#review-asr').disabled");
  await set('#review-evidence-form [name=notes]','原有手写草稿');
  await check('real_capture_resample_vosk_and_append_without_business_write',async()=>{
   await click('#review-asr');await cdp.wait("document.querySelector('#review-voice-status').textContent.includes('正在录音')");
   assert(await cdp.eval("document.querySelector('#review-asr').disabled"));await sleep(6100);await click('#review-asr-stop');
   await cdp.wait("document.querySelector('#review-voice-status').textContent.includes('转写已追加')");
   const draft=await cdp.eval("document.querySelector('#review-evidence-form [name=notes]').value");assert(draft.startsWith('原有手写草稿\n'));assert(draft.includes('语音识别'),draft);report.real_transcript=draft;
   assert(await cdp.eval("window.__tracks.length>0&&window.__tracks.every(t=>t.readyState==='ended')"));
   assert.deepEqual(await api('/api/reviews/'+made.review.review_id),originalReview);assert.deepEqual(await api('/api/runs/'+original.run_id),original);
   await shot('local-transcription-1440');
  });
  await check('network_failure_retains_draft_and_retries_same_audio',async()=>{
   await cdp.eval("window.__fetch=window.fetch;window.__audios=[];window.fetch=async(url,o)=>{if(String(url)==='/api/speech/transcribe'){window.__audios.push(o.body);if(window.__audios.length===1)throw new TypeError('isolated network failure');}return window.__fetch(url,o);}");
   const draft=await cdp.eval("document.querySelector('#review-evidence-form [name=notes]').value");
   await click('#review-asr');await cdp.wait("document.querySelector('#review-voice-status').textContent.includes('正在录音')");await sleep(6100);await click('#review-asr-stop');
   await cdp.wait("!document.querySelector('#review-asr-retry').hidden");assert.equal(await cdp.eval("document.querySelector('#review-evidence-form [name=notes]').value"),draft);
   await click('#review-asr-retry');await cdp.wait("document.querySelector('#review-voice-status').textContent.includes('转写已追加')");
   assert(await cdp.eval('window.__audios.length===2&&window.__audios[0]===window.__audios[1]'));await cdp.eval('window.fetch=window.__fetch');
  });
  await check('microphone_permission_denied_is_actionable',async()=>{
   await cdp.eval("window.__wrappedMic=navigator.mediaDevices.getUserMedia;navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('test denied','NotAllowedError');}");
   await click('#review-asr');await cdp.wait("document.querySelector('#review-voice-status').textContent.includes('未取得麦克风权限')");assert.equal(await cdp.eval("document.querySelector('#review-asr').disabled"),false);
   await cdp.eval('navigator.mediaDevices.getUserMedia=window.__wrappedMic');
  });
  await check('escape_releases_microphone_preserves_draft_and_reopens',async()=>{
   const draft=await cdp.eval("document.querySelector('#review-evidence-form [name=notes]').value");await click('#review-asr');await cdp.wait("document.querySelector('#review-voice-status').textContent.includes('正在录音')");
   await key('Escape');await cdp.wait("!document.querySelector('#review-dialog').open");assert(await cdp.eval("window.__tracks.every(t=>t.readyState==='ended')"));
   await click('#review-list-open');assert.equal(await cdp.eval("document.querySelector('#review-evidence-form [name=notes]').value"),draft);assert.equal(await cdp.eval("document.querySelector('#review-asr').disabled"),false);
  });
  await check('late_transcription_after_close_cannot_modify_draft',async()=>{
   await cdp.eval("window.__fetch=window.fetch;window.fetch=(url,o)=>String(url)==='/api/speech/transcribe'?new Promise(resolve=>window.__late=()=>resolve(new Response(JSON.stringify({status:'ok',text:'LATE_TEST_ONLY'}),{headers:{'Content-Type':'application/json'}}))):window.__fetch(url,o)");
   const draft=await cdp.eval("document.querySelector('#review-evidence-form [name=notes]').value");await click('#review-asr');await cdp.wait("document.querySelector('#review-voice-status').textContent.includes('正在录音')");await sleep(300);await click('#review-asr-stop');await cdp.wait('!!window.__late');
   await key('Escape');await cdp.eval('window.__late();window.fetch=window.__fetch');await sleep(250);await click('#review-list-open');assert.equal(await cdp.eval("document.querySelector('#review-evidence-form [name=notes]').value"),draft);
  });
  await check('mobile_layout_and_final_business_state_unchanged',async()=>{
   await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:false});await cdp.eval("document.querySelector('#review-asr').scrollIntoView({block:'center',behavior:'instant'})");await sleep(180);
   assert(await cdp.eval("document.querySelector('#review-body').scrollWidth<=document.querySelector('#review-body').clientWidth+1"));await shot('local-transcription-390');
   assert.deepEqual(await api('/api/reviews/'+made.review.review_id),originalReview);assert.deepEqual(await api('/api/runs/'+original.run_id),original);
  });
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));report.status='passed';
 }catch(error){try{report.visible=await cdp.eval("document.querySelector('#review-body')?.innerText");console.error(report.visible);}catch{}report.error=error.stack;console.error(error.stack);process.exitCode=1;}
 finally{cdp?.ws?.close();for(const child of [...children].reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
