// Stage03 browser acceptance: fixed rounds, immutable task runs, evidence and retained UI.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','stage03-browser','browser-'+Date.now());
fs.mkdirSync(OUT,{recursive:true});
const env={...process.env,TEMP:OUT,TMP:OUT,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',INSPECTGO_SEED_DEMO:'false'};
const PY=process.env.INSPECTGO_PYTHON||path.join(ROOT,'.venv','Scripts','python.exe'),BPY=process.env.INSPECTGO_BROKER_PYTHON||path.join(ROOT,'.runtime','broker-venv','Scripts','python.exe');
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
  await check('no_round_is_explicit_without_false_missing_points',async()=>{assert.equal(await cdp.eval("document.querySelector('#covered-count').textContent"),'—');assert.equal(await cdp.eval("document.querySelector('#missing-shortcut').disabled"),true);});
  let original;
  await check('prepare_and_compute_s1_five_tasks',async()=>{
    await click('#prepare-s1');await cdp.wait("document.querySelector('#judgment-status').textContent.includes('S1 教学实例已保存')");await run('base');
    assert.equal(await cdp.eval("[...document.querySelectorAll('#run-body .task-result summary .status-badge')].every(e=>e.textContent==='成立')"),true);
    original=await cdp.eval("document.querySelector('#run-body .run-id').textContent");await click('#run-close');assert.equal(await cdp.eval("document.querySelector('#covered-count').textContent"),'6');
  });
  await check('dependency_links_show_source_and_business_values_with_escape',async()=>{
    await click('#task-results [data-task="T1"] summary');await click('#task-results [data-task="T1"] .evidence-links button');await cdp.wait("document.querySelector('#judgment-proof-dialog').open");
    assert(await cdp.eval("document.querySelector('#judgment-proof-body').textContent.includes('SYSTEM')"));await key('Escape');assert.equal(await cdp.eval("document.querySelector('#judgment-proof-dialog').open"),false);
    assert.equal(await cdp.eval("document.activeElement.closest('.evidence-links')!==null"),true);
  });
  await check('input_variations_create_unknown_and_blocked_without_overwriting_s1',async()=>{
    await run('missing');assert.equal(await cdp.eval("document.querySelector('#run-body [data-task=T1] summary .status-badge').textContent"),'状态未知');await click('#run-close');
    await run('denied');assert.equal(await cdp.eval("document.querySelector('#run-body [data-task=T1] summary .status-badge').textContent"),'受阻');await click('#run-close');
    const r=await(await fetch(BASE+'/api/runs/'+original)).json();assert(r.task_results.every(t=>t.state==='established'));assert.equal(r.coverage.covered,6);
    assert.equal(await cdp.eval("document.querySelector('#covered-count').textContent"),'5');
  });
  await check('search_and_missing_filter_remain_functional',async()=>{await click('#missing-shortcut');await cdp.wait("document.querySelectorAll('.point-card[data-point]').length===1");assert.equal(await cdp.eval("document.querySelector('.point-card').dataset.point"),'C07');await click('#reset-filters');await set('#search','空调');await cdp.wait("document.querySelectorAll('.point-card[data-point]').length===2");await click('#reset-filters');});
  await check('manual_evidence_persists_and_keeps_saved_run_frozen',async()=>{
    await click('#manual-evidence-open');await cdp.wait("document.querySelector('#manual-evidence-dialog').open");await set('#manual-evidence-form [name=checkpoint_id]','C03');await set('#manual-evidence-form [name=inspector_id]','browser-test');await set('#manual-evidence-form [name=notes]','真实浏览器提交路径测试，不代表现场检查');
    await click('#manual-evidence-form button[type=submit]');await cdp.wait("document.querySelector('#manual-message').textContent.startsWith('保存已确认：')");
    await key('Escape');const r=await(await fetch(BASE+'/api/runs/'+original)).json();assert.equal(r.coverage.covered,6);
  });
  await check('failed_manual_save_retains_draft_round_and_request_for_retry',async()=>{
    const priorRound=await cdp.eval("document.querySelector('#judgment-round').value");
    await click('#manual-evidence-open');await set('#manual-evidence-form [name=notes]','弱网重试检查');
    await cdp.eval("window._actualFetch=window.fetch;window._manualBodies=[];window.fetch=async(url,options)=>{if(String(url)==='/api/evidence/manual'){window._manualBodies.push(JSON.parse(options.body));if(window._manualBodies.length===1)throw new TypeError('test network failure');}return window._actualFetch(url,options);}");
    await click('#manual-evidence-form button[type=submit]');await cdp.wait("document.querySelector('#manual-message').textContent.includes('保存结果未确认')");
    assert.equal(await cdp.eval("document.querySelector('#manual-evidence-form [name=notes]').value"),'弱网重试检查');
    await cdp.eval("window.confirm=()=>true");await key('Escape');
    await click('#prepare-s1');await cdp.wait("document.querySelector('#judgment-status').textContent.includes('S1 教学实例已保存')");
    assert.notEqual(await cdp.eval("document.querySelector('#judgment-round').value"),priorRound);
    await click('#manual-evidence-open');assert((await cdp.eval("document.querySelector('#manual-round').textContent")).includes(priorRound));
    await click('#manual-evidence-form button[type=submit]');await cdp.wait("document.querySelector('#manual-message').textContent.startsWith('保存已确认：')");
    const bodies=await cdp.eval('window._manualBodies');assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);assert.equal(bodies[1].inspection_round_id,priorRound);
    await cdp.eval('window.fetch=window._actualFetch');await key('Escape');
  });
  await check('run_permission_failure_is_not_success_and_retry_keeps_id',async()=>{
    await cdp.eval("window._actualFetch=window.fetch;window._runBodies=[];window.fetch=async(url,options)=>{if(String(url)==='/api/runs'&&options?.method==='POST'){window._runBodies.push(JSON.parse(options.body));if(window._runBodies.length===1)return new Response(JSON.stringify({detail:'test permission denied'}),{status:403,headers:{'Content-Type':'application/json'}});}return window._actualFetch(url,options);}");
    await click('#run-btn');await cdp.wait("!document.querySelector('#run-btn').disabled && window._runBodies.length===1");
    assert.equal(await cdp.eval("document.querySelector('#run-dialog').open"),false);
    await click('#run-btn');await cdp.wait("document.querySelector('#run-dialog').open && document.querySelectorAll('#run-body [data-task]').length===5");
    const bodies=await cdp.eval('window._runBodies');assert.deepEqual(bodies[0],bodies[1]);
    await cdp.eval('window.fetch=window._actualFetch');await key('Escape');
  });
  await check('responsive_390_768_1440_and_reduced_motion',async()=>{
    for(const width of [390,768,1440]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await sleep(200);assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'),'overflow at '+width);await cdp.eval("document.querySelector('.task-workbench').scrollIntoView({block:'start',behavior:'instant'})");await sleep(200);const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,`stage03-${width}.png`),Buffer.from(shot.data,'base64'));}
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await run('ordinary');assert.equal(await cdp.eval("document.querySelector('#run-body [data-task=T1] summary .status-badge').textContent"),'成立');await key('Escape');
  });
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));report.status='passed';
 }catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
 finally{cdp?.ws?.close();for(const child of [...children].reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
