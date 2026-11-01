// Integrated 3D workbench acceptance: real API persistence, point actions, dialogs and keyboard navigation.
// MQTT is disabled here; dedicated twin-browser.cjs covers the real-time chain.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','stage06-browser','flow-'+Date.now());
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

 let original,originalData;
 const runAnalysis=async mode=>{
  await set('#analysis-question','交换机通风巡检需要关注什么？');await set('#analysis-failure',mode);
  await click('#analysis-submit');await cdp.wait("document.querySelector('#analysis-adopt')?.hidden===false");
  const text=await cdp.eval("document.querySelector('#analysis-request').textContent");
  const id=text.match(/run-[a-f0-9]+/)[0];return api('/api/runs/'+id);
 };
 try{
  start('api',PY,['-B','tests/stage06_browser_app.py',String(webPort)],{INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads'),INSPECTGO_MQTT_ENABLED:'false',INSPECTGO_LLM_ENABLED:'false'});
  await until(async()=>(await fetch(base+'/health')).ok,'API');
  start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const page=await until(async()=>{const list=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return list.find(t=>t.type==='page');},'Chrome');
  cdp=new CDP(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.navigate',{url:base});await cdp.wait("document.querySelector('#campus-stage')?.dataset.renderer==='webgl' && document.querySelectorAll('.twin-marker').length===8");await settled();
  await check('analysis_entry_inside_latest_3d_and_empty_guard',async()=>{
   assert(await cdp.eval("!!document.querySelector('#campus-stage #campus-analysis-open')"));
   await click('#campus-analysis-open');await cdp.wait("document.querySelector('#analysis-dialog').open");assert(await cdp.eval("document.querySelector('#analysis-submit').disabled"));await key('Escape');
   assert.equal(await cdp.eval('document.activeElement.id'),'campus-analysis-open');await shot('3d-entry');
  });
  await check('s3_serial_analysis_creates_new_run_and_explicit_adoption',async()=>{
   await click('#campus-tasks-open');await set('#judgment-scenario','S3');await click('#prepare-s1');await cdp.wait("document.querySelector('#judgment-status').textContent.includes('S3 教学实例已保存')");
   await click('#campus-generate-run');await cdp.wait("document.querySelector('#run-dialog').open && document.querySelector('#run-body .run-id')");
   original=await cdp.eval("document.querySelector('#run-body .run-id').textContent");originalData=await api('/api/runs/'+original);await key('Escape');await key('Escape');
   await click('#campus-analysis-open');const saved=await runAnalysis('none');
   assert.notEqual(saved.run_id,original);assert.equal(saved.analysis.status,'complete');assert.deepEqual(saved.task_results.map(t=>t.state),originalData.task_results.map(t=>t.state));
   assert.equal(await cdp.eval("document.querySelector('#campus-run-context').dataset.runId"),original);
   assert.deepEqual(saved.analysis.steps.map(s=>s.name),['statistics','weather','rag','ml','tools','llm']);
   assert.equal(saved.analysis.steps.find(s=>s.name==='ml').source_type,'MODEL_OUTPUT');
   await click('#analysis-output .analysis-answer .analysis-evidence-link');
   assert(await cdp.eval("document.activeElement.tagName==='SUMMARY' && document.activeElement.parentElement.open"));
   assert((await cdp.eval("document.activeElement.closest('[data-analysis-step]').dataset.analysisStep"))==='tools');
   await cdp.eval("document.querySelector('#analysis-output').scrollIntoView({block:'start'})");await shot('analysis-six-stages');
   await click('#analysis-adopt');await cdp.wait(`document.querySelector('#campus-run-context').dataset.runId===${JSON.stringify(saved.run_id)}`);
   assert.deepEqual(await api('/api/runs/'+original),originalData);
  });
  for(const mode of ['weather','rag','ml','llm'])await check(mode+'_independent_degradation_keeps_task_states',async()=>{
   await click('#campus-analysis-open');await click('#analysis-new');const saved=await runAnalysis(mode);
   assert.deepEqual(saved.analysis.steps.filter(s=>s.status!=='ok').map(s=>s.name),[mode]);
   assert.deepEqual(saved.task_results.map(t=>t.state),originalData.task_results.map(t=>t.state));
   await key('Escape');
  });
  await check('saved_analysis_history_and_mobile_keyboard',async()=>{
   await click('#campus-analysis-open');await click('#analysis-history');await cdp.wait("document.querySelector('#run-body [data-analysis-step=statistics]')");await shot('analysis-history');await key('Escape');
   for(const width of [1440,1024,440,390]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await cdp.eval('window.scrollTo(0,0)');await sleep(150);
    assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));
    await click('#campus-analysis-open');await key('Tab','Tab',9);
    assert(await cdp.eval("document.querySelector('#analysis-dialog').contains(document.activeElement)"));
    assert(await cdp.eval("document.querySelector('#analysis-dialog').scrollWidth<=document.querySelector('#analysis-dialog').clientWidth+1"));
    await shot('analysis-'+width);await key('Escape');assert.equal(await cdp.eval('document.activeElement.id'),'campus-analysis-open');
   }
  });
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;if(cdp)try{await shot('failure');}catch{}}
 finally{cdp?.ws?.close();for(const child of children.reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
