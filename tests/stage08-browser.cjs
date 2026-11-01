// Integrated 3D workbench acceptance: real API persistence, point actions, dialogs and keyboard navigation.
// MQTT is disabled here; dedicated twin-browser.cjs covers the real-time chain.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','stage08-browser','flow-'+Date.now());
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
 let parent,oldS5,followup,child;
 const whatifIds=[];
 async function prepare(scenario){
  await click('#campus-tasks-open');await set('#judgment-scenario',scenario);await click('#prepare-s1');
  await cdp.wait(`document.querySelector('#judgment-status').textContent.includes('${scenario} 教学实例已保存')`);
  await click('#campus-generate-run');await cdp.wait("document.querySelector('#run-dialog').open && document.querySelector('#run-body .run-id')");
  const id=await cdp.eval("document.querySelector('#run-body .run-id').textContent");
  const run=await api('/api/runs/'+id);await key('Escape');await key('Escape');return run;
 }
 try{
  start('api',PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(webPort)],{INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads'),INSPECTGO_MQTT_ENABLED:'false',INSPECTGO_LLM_ENABLED:'false',INSPECTGO_VLM_ENABLED:'false'});
  await until(async()=>(await fetch(base+'/health')).ok,'API');
  start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const page=await until(async()=>{const list=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return list.find(t=>t.type==='page');},'Chrome');
  cdp=new CDP(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Page.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__sockets=[];window.WebSocket=class extends WebSocket{constructor(...args){super(...args);window.__sockets.push(this);}};`});
  await cdp.send('Page.navigate',{url:base});await cdp.wait("document.querySelector('#campus-stage')?.dataset.renderer==='webgl' && document.querySelectorAll('.twin-marker').length===8");await settled();
  async function adopt(run){
   await click('#all-runs-btn');await cdp.wait("document.querySelector('#run-body .run-item')");
   const runs=await api('/api/runs'),index=runs.findIndex(r=>r.run_id===run.run_id);assert(index>=0);
   await click('#run-body .run-item:nth-of-type('+(index+1)+')');await cdp.wait("document.querySelector('#run-body [data-run-adopt]')");
   await click('#run-body [data-run-adopt]');await key('Escape');
   await cdp.wait(`document.querySelector('#campus-run-context').dataset.runId===${JSON.stringify(run.run_id)}`);
  }
  async function assertSource(run){
   assert.equal(await cdp.eval("document.querySelector('#campus-run-context').dataset.runId"),run.run_id);
   assert.equal(await cdp.eval("document.querySelector('#covered-count').textContent"),String(run.coverage.covered));
   for(const point of run.coverage.points)if(point.required)assert.equal(await cdp.eval(`document.querySelector('#coverage-strip [aria-label^="${point.checkpoint_id} "]').classList.contains('is-covered')`),point.covered);
  }
  let A,B;
  await check('empty_fourview_entries_focus_and_overlay',async()=>{
   for(const [entry,kind] of [['campus-coverage-open','覆盖与阻塞'],['campus-run-evidence-open','本次判断证据']]){
    assert(await cdp.eval(`!!document.querySelector('#campus-stage #${entry}')`));await click('#'+entry);
    assert.equal(await cdp.eval("document.querySelector('#campus-frozen-title').textContent"),kind);
    assert((await cdp.eval("document.querySelector('#campus-frozen-body').textContent")).includes('尚未选择'));
    await key('Tab','Tab',9);assert(await cdp.eval("document.querySelector('#campus-frozen-dialog').contains(document.activeElement)"));
    await key('Escape');assert.equal(await cdp.eval('document.activeElement.id'),entry);
   }
   A=await prepare('S1');B=await prepare('S2');await assertSource(B);
  });
  await check('teaching_zone_access_changes_both_directions_new_runs_only',async()=>{
   const frozen=await api('/api/runs/'+B.run_id);
   for(const value of ['ALLOWED','DENIED']){
    await click('#campus-tasks-open');await cdp.eval("document.querySelector('.planning-controls').open=true");await set('#judgment-zone-access',value);
    await click('#campus-generate-run');await cdp.wait("document.querySelector('#run-dialog').open && document.querySelector('#run-body .run-id')");
    const id=await cdp.eval("document.querySelector('#run-body .run-id').textContent"),run=await api('/api/runs/'+id);
    assert.equal(run.input_snapshot.input_overrides.zone_access[0].access,value);assert.notEqual(id,B.run_id);
    assert.equal(run.task_results[0].checks.find(d=>d.dependency_id==='T1.access').status,value==='ALLOWED'?'satisfied':'unsatisfied');
    await key('Escape');await key('Escape');
   }
   assert.deepEqual(await api('/api/runs/'+B.run_id),frozen);
  });
  await check('delayed_A_response_cannot_overwrite_B_and_realtime_keeps_B',async()=>{
   await adopt(A);await cdp.wait("!document.querySelector('#refresh-btn').disabled");
   await cdp.eval(`window.__fetch=window.fetch;window.__hold=true;window.__pending=[];window.fetch=async(...args)=>{if(String(args[0]).startsWith('/api/dashboard')&&window.__hold){const response=await window.__fetch(...args);return new Promise(resolve=>window.__pending.push(()=>resolve(response)));}return window.__fetch(...args);};`);
   const lastSuccess=await cdp.eval("document.querySelector('#updated-at').textContent");await sleep(1100);
   await click('#refresh-btn');await cdp.wait('window.__pending.length===1');await adopt(B);await assertSource(B);assert.equal(await cdp.eval("document.querySelector('#updated-at').textContent"),lastSuccess);
   await cdp.eval(`(async()=>{const snapshot=await (await window.__fetch('/api/current')).json();window.__sockets.forEach(s=>s.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(snapshot)})));})()`);await assertSource(B);
   await cdp.eval('window.__hold=false;window.__pending.shift()()');await cdp.wait("!document.querySelector('#refresh-btn').disabled");await assertSource(B);
  });
  await check('rapid_A_B_A_rejects_old_identical_query_and_failed_current_read_is_honest',async()=>{
   await adopt(A);await cdp.wait("!document.querySelector('#refresh-btn').disabled");await cdp.eval('window.__hold=true');await click('#refresh-btn');await cdp.wait('window.__pending.length===1');
   const lastSuccess=await cdp.eval("document.querySelector('#updated-at').textContent");await sleep(1100);await adopt(B);await adopt(A);await assertSource(A);
   await cdp.eval(`window.__hold=false;window.fetch=async(...args)=>String(args[0]).startsWith('/api/dashboard')?new Response(JSON.stringify({detail:'isolated current read failure'}),{status:503,headers:{'Content-Type':'application/json'}}):window.__fetch(...args);window.__pending.shift()();`);
   await cdp.wait("document.querySelector('#connection-status').textContent.includes('刷新失败')");await assertSource(A);assert.equal(await cdp.eval("document.querySelector('#updated-at').textContent"),lastSuccess);
   assert((await cdp.eval("document.querySelector('#connection-status').textContent")).includes('上次数据'));
   await cdp.eval('window.fetch=window.__fetch');
  });
  await check('deselection_while_pending_clears_old_coverage_and_stale_reply',async()=>{
   await cdp.wait("!document.querySelector('#refresh-btn').disabled");await cdp.eval('window.__hold=true;window.fetch=async(...args)=>{if(String(args[0]).startsWith("/api/dashboard")&&window.__hold){const response=await window.__fetch(...args);return new Promise(resolve=>window.__pending.push(()=>resolve(response)));}return window.__fetch(...args);}');
   await click('#refresh-btn');await cdp.wait('window.__pending.length===1');await click('#campus-tasks-open');await set('#judgment-round','');await key('Escape');
   assert.equal(await cdp.eval("document.querySelector('#campus-run-context').dataset.runId"),'');assert.equal(await cdp.eval("document.querySelector('#covered-count').textContent"),'—');
   await cdp.eval('window.__hold=false;window.__pending.shift()()');await cdp.wait("!document.querySelector('#refresh-btn').disabled");assert.equal(await cdp.eval("document.querySelector('#covered-count').textContent"),'—');await cdp.eval('window.fetch=window.__fetch');
  });
  await check('fourview_frozen_source_modal_keyboard_and_responsive',async()=>{
   const viewRun=await prepare('S3');
   for(const width of [1440,1024,440,390]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1200,deviceScaleFactor:1,mobile:false});await cdp.eval('window.scrollTo(0,0)');await sleep(150);
    assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));
    for(const entry of ['campus-coverage-open','campus-run-evidence-open']){
     await click('#'+entry);assert.equal(await cdp.eval("document.querySelector('#campus-frozen-body').dataset.runId"),viewRun.run_id);
     await key('Tab','Tab',9);assert(await cdp.eval("document.querySelector('#campus-frozen-dialog').contains(document.activeElement)"));
     assert(await cdp.eval("document.querySelector('#campus-frozen-dialog').scrollWidth<=document.querySelector('#campus-frozen-dialog').clientWidth+1"));
     assert(await cdp.eval("document.querySelector('#campus-frozen-body').scrollWidth<=document.querySelector('#campus-frozen-body').clientWidth+1"));
     if(entry==='campus-coverage-open')assert.equal(await cdp.eval("document.querySelector('[data-effective-access]').dataset.effectiveAccess"),viewRun.task_results[0].checks.find(d=>d.dependency_id==='T1.access').status);
     if(width===1440){
      await cdp.eval(`window.__focus=document.activeElement;document.dispatchEvent(new Event('visibilitychange'));`);
      await cdp.wait("!document.querySelector('#refresh-btn').disabled");assert(await cdp.eval('document.activeElement===window.__focus'));
     }
     await shot(entry+'-'+width);await key('Escape');assert.equal(await cdp.eval('document.activeElement.id'),entry);
    }
    await click('#campus-plans-open');assert(await cdp.eval("document.querySelector('#campus-task-dialog').open"));await key('Escape');
   }
   const S5=await prepare('S5');await click('#campus-run-evidence-open');assert((await cdp.eval("document.querySelector('#campus-frozen-body').textContent")).includes('review_snapshot'));
   await click('#campus-frozen-body button.btn-secondary');await cdp.wait("document.querySelector('#review-dialog').open");await key('Escape');assert.equal(await cdp.eval("document.querySelector('#campus-frozen-body').dataset.runId"),S5.run_id);await key('Escape');
  });
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;if(cdp)try{await shot('failure');}catch{}}
 finally{cdp?.ws?.close();for(const child of children.reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
