// Stage03 browser acceptance: fixed rounds, immutable task runs, evidence and retained UI.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','stage05-browser','browser-'+Date.now());
fs.mkdirSync(OUT,{recursive:true});
const env={...process.env,TEMP:OUT,TMP:OUT,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',INSPECTGO_SEED_DEMO:'false'};
const PY=process.env.INSPECTGO_PYTHON||'D:\\校园设施巡检与复核\\.venv\\Scripts\\python.exe',BPY=process.env.INSPECTGO_BROKER_PYTHON||path.join(ROOT,'.runtime','broker-venv','Scripts','python.exe');
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
 let cdp;
 const webPort=await port(),debugPort=await port(),BASE=`http://127.0.0.1:${webPort}`;
 async function check(name,fn){await fn();report.checks.push({name,status:'passed'});console.log('PASS '+name);}
 async function click(selector){await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.click();})()`);}
 async function set(selector,value){await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
 async function key(key){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:({Escape:27,Tab:9})[key]});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:({Escape:27,Tab:9})[key]});}
 async function run(variation){await set('#judgment-variation',variation);await click('#run-btn');await cdp.wait("document.querySelector('#run-dialog').open && document.querySelectorAll('#run-body [data-task]').length===5");}
 try{
  start('api',PY,['-B','-m','uvicorn','main:app','--app-dir','backend','--host','127.0.0.1','--port',String(webPort)],{INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads'),INSPECTGO_MQTT_ENABLED:'false'});
  await until(async()=>(await fetch(BASE+'/health')).ok,'API');
  start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const page=await until(async()=>{const pages=await(await fetch(`http://127.0.0.1:${debugPort}/json`)).json();return pages.find(p=>p.type==='page');},'Chrome');
  cdp=new CDP(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Page.enable');await cdp.send('Page.navigate',{url:BASE});
  await cdp.wait("document.querySelectorAll('.point-card[data-point]').length===8 && document.querySelector('#judgment-round')");
  await check('review_queue_is_accessible',async()=>{
    assert.equal(await cdp.eval("!!document.querySelector('#review-list-open')"),true,'现场复核列表入口缺失');
    await click('#review-list-open');await cdp.wait("document.querySelector('#review-dialog').open");
    await key('Escape');assert.equal(await cdp.eval("document.activeElement.id"),'review-list-open');
  });
  let original,originalData,reviewId;
  await check('task_creates_linked_request_without_mutating_original_run',async()=>{
    await click('#prepare-s1');await cdp.wait("document.querySelector('#judgment-status').textContent.includes('S1 教学实例已保存')");await run('base');
    original=await cdp.eval("document.querySelector('#run-body .run-id').textContent");originalData=await(await fetch(BASE+'/api/runs/'+original)).json();await key('Escape');
    await click('#task-results [data-task=T2] summary');await click('#task-results [data-task=T2] > button');await cdp.wait("document.querySelector('#review-create-form')");
    await set('#review-create-form [name=point_id]','C07');await set('#review-create-form [name=reason]','浏览器测试复核需求，不代表现场记录');await click('#review-create-form button[type=submit]');
    await cdp.wait("document.querySelector('#review-evidence-form')");reviewId=await cdp.eval("document.querySelector('#review-body code').textContent");
    const data=await(await fetch(BASE+'/api/reviews/'+reviewId)).json();assert.equal(data.review.trigger_run_id,original);assert.equal(data.review.task_id,'T2');assert.equal(data.review.zone_id,'Z3');assert(data.review.facility_id);
    assert.deepEqual(await(await fetch(BASE+'/api/runs/'+original)).json(),originalData);
    assert.equal(await cdp.eval("document.querySelector('#review-evidence-form [name=photos]').getAttribute('capture')"),'environment');
  });
  await check('failed_upload_preserves_draft_and_retry_id_and_persists_separate_evidence',async()=>{
    await set('#review-evidence-form [name=inspector_id]','browser-test');await set('#review-evidence-form [name=notes]','网络重试用合成测试说明，不代表真实到场');await set('#review-evidence-form [name=conclusion]','unknown');
        await cdp.eval("(()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const ctx=canvas.getContext('2d');ctx.fillStyle='#23744b';ctx.fillRect(0,0,32,32);const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([bytes],'synthetic-browser-test.png',{type:'image/png'}));const input=document.querySelector('#review-evidence-form [name=photos]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await click('#review-evidence-form [name=onsite_confirmed]');
    await cdp.eval("window._actualFetch=fetch;window._uploadIds=[];window.fetch=async(url,o)=>{if(String(url).endsWith('/evidence')&&o?.method==='POST'){window._uploadIds.push(o.body.get('request_id'));if(window._uploadIds.length===1)throw new TypeError('test connection lost');}return window._actualFetch(url,o);}");
    await click('#review-evidence-form button[type=submit]');await cdp.wait("document.querySelector('#review-evidence-form').textContent.includes('保存结果未确认')");assert.equal(await cdp.eval("document.querySelector('#review-evidence-form [name=notes]').value"),'网络重试用合成测试说明，不代表真实到场');
    await click('#review-evidence-form button[type=submit]');await cdp.wait("document.querySelector('#review-evidence-form [name=notes]')?.value==='' && document.querySelector('#review-rerun').textContent.includes('新 reality run 已保存')");
    const ids=await cdp.eval('window._uploadIds');assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);await cdp.eval('window.fetch=window._actualFetch');
    const data=await(await fetch(BASE+'/api/reviews/'+reviewId)).json();assert(data.evidence.length);assert(data.evidence.some(e=>e.evidence_type==='review_confirmation'));assert(data.evidence.some(e=>e.value_json?.photos?.length));await cdp.eval("document.querySelector('#review-body img').scrollIntoView()");await cdp.wait("document.querySelector('#review-body img')?.complete && document.querySelector('#review-body img')?.naturalWidth>0");await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:false});await cdp.eval("document.querySelector('#review-body img').scrollIntoView()");assert(await cdp.eval("document.querySelector('#review-body').scrollWidth<=document.querySelector('#review-body').clientWidth+1"));const photoShot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,'stage05-evidence-390.png'),Buffer.from(photoShot.data,'base64'));await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});assert.equal(data.review.conclusion,'unknown');assert.equal(data.review.status,'pending');
    const latest=data.new_runs.at(-1).run_id;assert(latest&&latest!==original);const newRun=await(await fetch(BASE+'/api/runs/'+latest)).json();assert(newRun.evidence.some(e=>e.review_id===reviewId));assert.deepEqual(await(await fetch(BASE+'/api/runs/'+original)).json(),originalData);
  });
  await check('cancel_reason_is_saved_and_no_longer_pending',async()=>{
    await set('#review-transition-form [name=reason]','合成测试取消原因');await click('#review-transition-form button[type=submit]');await cdp.wait("document.querySelector('#review-body').textContent.includes('已取消')&&!document.querySelector('#review-transition-form')");
    const data=await(await fetch(BASE+'/api/reviews/'+reviewId)).json();assert.equal(data.review.status,'cancelled');assert.equal(data.review.close_reason,'合成测试取消原因');assert.deepEqual(await(await fetch(BASE+'/api/runs/'+original)).json(),originalData);await key('Escape');
  });
  await check('timeout_is_visible_and_does_not_allow_evidence',async()=>{
    const response=await fetch(BASE+'/api/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({point_id:'C08',task_id:'T4',reason:'合成超时验收',trigger_run_id:original,request_id:crypto.randomUUID(),expires_at:new Date(Date.now()+1500).toISOString()})});assert(response.ok);const created=await response.json();await sleep(1700);
    await fetch(BASE+'/api/reviews/expire',{method:'POST'});
    await click('#review-list-open');await cdp.wait("document.querySelector('#review-body select')");await set('#review-body select','timeout');await cdp.wait("document.querySelector('#review-body .queue-item')");await click('#review-body .queue-item');await cdp.wait("document.querySelector('#review-body').textContent.includes('已超时')&&!document.querySelector('#review-evidence-form')");
    const data=await(await fetch(BASE+'/api/reviews/'+created.review.review_id)).json();assert.equal(data.review.status,'timeout');assert(data.review.close_reason);await key('Escape');
  });
  await check('unsupported_voice_falls_back_and_review_drawer_fits_three_widths',async()=>{
    await cdp.eval("window.SpeechRecognition=undefined;window.webkitSpeechRecognition=undefined;");
    await click('#task-results [data-task=T2] > button');await cdp.wait("document.querySelector('#review-create-form')");await set('#review-create-form [name=point_id]','C06');await set('#review-create-form [name=reason]','语音降级验收');await click('#review-create-form button[type=submit]');await cdp.wait("document.querySelector('#review-evidence-form')");
    assert.equal(await cdp.eval("document.querySelector('#review-asr').disabled"),true);assert(await cdp.eval("document.querySelector('#review-body').textContent.includes('请手写现场说明')"));
    for(const width of [390,768,1440]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await sleep(150);assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));assert(await cdp.eval("document.querySelector('#review-body').scrollWidth<=document.querySelector('#review-body').clientWidth+1"));const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,`stage05-review-${width}.png`),Buffer.from(shot.data,'base64'));}
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await key('Tab');assert(await cdp.eval("document.querySelector('#review-dialog').contains(document.activeElement)"));await key('Escape');
    assert(await cdp.eval("document.querySelector('#room-carousel')!==null && document.querySelectorAll('.point-card[data-point]').length===8"));
  });
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));report.status='passed';
 }catch(error){try{report.visible=await cdp.eval("document.querySelector('#review-body')?.innerText");console.error(report.visible);}catch{}report.error=error.stack;console.error(error.stack);process.exitCode=1;}
 finally{cdp?.ws?.close();for(const child of [...children].reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
