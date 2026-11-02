// Isolated reminder acceptance: controlled test clock, real APIs and native pointer events.
// Integrated 3D workbench acceptance: real API persistence, point actions, dialogs and keyboard navigation.
// MQTT is disabled here; dedicated twin-browser.cjs covers the real-time chain.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','inspection-alerts-browser','flow-'+Date.now());
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
 async function board(id){
  await click('.board-nav [data-board="'+id+'"]');
  await cdp.wait('document.body.dataset.board==='+JSON.stringify(id));
 }
 async function click(selector){
  const destinations={'#campus-tasks-open':'tasks','#campus-plans-open':'tasks',
   '#campus-coverage-open':'coverage','#campus-run-evidence-open':'coverage',
   '#all-runs-btn':'evidence','#campus-whatif-open':'analysis'};
  if(destinations[selector]&&await cdp.eval('document.body.dataset.board')!==destinations[selector])await board(destinations[selector]);
  let previousBounds=null;
  const r=await until(async()=>{
   await cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);
   const target=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,bounds:[r.x,r.y,r.width,r.height].map(n=>Math.round(n*10)/10).join(','),hit:r.width>0&&r.height>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(${JSON.stringify(selector)})===e};})()`);
   const ready=target?.hit&&target.bounds===previousBounds;previousBounds=target?.bounds;
   return ready?target:null;
  },'stable unobstructed pointer target '+selector,5000);
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:r.x,y:r.y});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:r.x,y:r.y});
 }
 async function set(selector,value){await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
 async function key(value,code=value,n=27){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:value,code,windowsVirtualKeyCode:n});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:value,code,windowsVirtualKeyCode:n});}
 async function shot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,name+'.png'),Buffer.from(r.data,'base64'));}
 const api=async path=>(await fetch(base+path)).json();
 async function settled(){await cdp.wait("document.querySelector('#campus-stage').dataset.transition!=='flying'");}

 const clockFile=path.join(OUT,'test-clock.txt');
 const clock=value=>fs.writeFileSync(clockFile,value);
 clock('2026-10-29T01:10:01+00:00');
 const clockServer=`from datetime import datetime
from pathlib import Path
import os
from backend import service, evidence
service.utcnow=lambda:datetime.fromisoformat(Path(os.environ['TEST_CLOCK_FILE']).read_text())
evidence.now=lambda:service.utcnow().isoformat(timespec='microseconds')
import uvicorn
uvicorn.run('backend.main:app',host='127.0.0.1',port=int(os.environ['TEST_PORT']))`;
 let oldRun,followup;
 async function dismiss(){if(await cdp.eval("!document.querySelector('#inspection-alert-popup').hidden"))await click('#inspection-alert-dismiss');}
 async function prepare(scenario,generate=true){
  await dismiss();await click('#campus-tasks-open');await set('#judgment-scenario',scenario);await click('#prepare-s1');
  await cdp.wait(`document.querySelector('#judgment-status').textContent.includes('${scenario} 教学实例已保存')`);
  if(!generate){await key('Escape');return;}
  await click('#campus-generate-run');await cdp.wait("document.querySelector('#run-dialog').open && document.querySelector('#run-body .run-id')");
  const id=await cdp.eval("document.querySelector('#run-body .run-id').textContent"),run=await api('/api/runs/'+id);
  await key('Escape');await key('Escape');return run;
 }
 async function createReview(){
  if(await cdp.eval("document.querySelector('#inspection-alert-popup').hidden"))await click('#inspection-alert-open');
  await click('[data-inspection-action=review][data-point-id=C07]');
  await cdp.wait("document.querySelector('#review-create-form')");
  assert.equal(await cdp.eval("document.querySelector('#review-create-form [name=point_id]').value"),'C07');
  assert.equal(await cdp.eval("document.querySelector('#review-create-form [name=task_id]').value"),'T1');
  assert(await cdp.eval("document.querySelector('#inspection-alert-popup').hidden"));
  await set('#review-create-form [name=reason]','隔离自动化验收：C07 现场补证，不是真实巡检。');
  await click('#review-create-form button[type=submit]');await cdp.wait("document.querySelector('#review-evidence-form')");
 }
 async function fillProof(at){
  await set('#review-evidence-form [name=inspector_id]','isolated-browser-test');
  await set('#review-evidence-form [name=notes]','自动化隔离样本，测试有效现场证据与新运行联动，不代表真实现场。');
  await set('#review-evidence-form [name=conclusion]','normal');
  const local=await cdp.eval(`(()=>{const d=new Date(${JSON.stringify(at)});return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,23)})()`);
  await set('#review-evidence-form [name=inspected_at]',local);
  if(!await cdp.eval("document.querySelector('#review-evidence-form [name=onsite_confirmed]').checked"))await click('#review-evidence-form [name=onsite_confirmed]');
 }
 async function saveProof(){
  await click('#review-evidence-form button[type=submit]');
  await cdp.wait("document.querySelector('#review-rerun')?.textContent.includes('新 reality run 已保存') && !document.querySelector('#review-evidence-form')");
  const text=await cdp.eval("document.querySelector('#review-rerun').textContent");
  return api('/api/runs/'+text.match(/run-[a-f0-9]+/)[0]);
 }
 try{
  start('api',PY,['-B','-c',clockServer],{TEST_CLOCK_FILE:clockFile,TEST_PORT:String(webPort),INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads'),INSPECTGO_MQTT_ENABLED:'false',INSPECTGO_LLM_ENABLED:'false',INSPECTGO_VLM_ENABLED:'false'});
  await until(async()=>(await fetch(base+'/health')).ok,'API');
  start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const page=await until(async()=>{const list=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return list.find(t=>t.type==='page');},'Chrome');
  cdp=new CDP(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.navigate',{url:base});await cdp.wait("document.querySelector('#campus-stage')?.dataset.renderer==='webgl' && document.querySelectorAll('.twin-marker').length===8");await settled();
  await check('no_round_and_S1_have_no_business_warning',async()=>{
   assert.equal(await cdp.eval("document.querySelector('#inspection-alert-open').dataset.count"),'0');
   const r=await prepare('S1');assert(r.task_results.every(t=>t.state==='established'));
   assert.equal(await cdp.eval("document.querySelector('#inspection-alert-open').dataset.count"),'0');
   assert(await cdp.eval("document.querySelector('#inspection-alert-popup').hidden"));
  });
  await check('prepared_S2_missing_record_notifies_without_fake_facility_fault',async()=>{
   await prepare('S2',false);await cdp.wait("!document.querySelector('#inspection-alert-popup').hidden");
   assert.equal(await cdp.eval("document.querySelector('#inspection-alert-open').dataset.count"),'1');
   assert.equal(await cdp.eval("document.querySelector('[data-inspection-issue]').dataset.kind"),'missing');
   assert((await cdp.eval("document.querySelector('#inspection-alert-items').textContent")).includes('C07'));
   assert.equal(await cdp.eval("document.querySelectorAll('[data-inspection-issue]').length"),1);
   await shot('01-prepared-missing');await click('#inspection-alert-dismiss');await click('#refresh-btn');await sleep(500);
   assert(await cdp.eval("document.querySelector('#inspection-alert-popup').hidden"));
   assert.equal(await cdp.eval("document.querySelector('#inspection-alert-open').dataset.count"),'1');
  });
  await check('T1_blocked_alert_with_real_point_action_and_keyboard',async()=>{
   await click('#campus-tasks-open');await click('#campus-generate-run');await cdp.wait("document.querySelector('#run-dialog').open && document.querySelector('#run-body .run-id')");
   oldRun=await api('/api/runs/'+await cdp.eval("document.querySelector('#run-body .run-id').textContent"));
   await key('Escape');await key('Escape');await cdp.wait("!document.querySelector('#inspection-alert-popup').hidden");
   assert.equal(await cdp.eval("document.querySelector('[data-inspection-issue]').dataset.kind"),'blocked');
   assert.equal(oldRun.task_results[0].state,'blocked');await shot('02-T1-blocked');
   await key('Escape');assert(await cdp.eval("document.querySelector('#inspection-alert-popup').hidden"));
   await click('#inspection-alert-open');assert.equal(await cdp.eval('document.activeElement.id'),'inspection-alert-popup');
   await click('[data-inspection-action=inspect][data-point-id=C07]');await cdp.wait("document.querySelector('#detail-dialog').open && document.querySelector('#detail-title').textContent.includes('C07')");
   assert(await cdp.eval("document.querySelector('#inspection-alert-popup').hidden"));await key('Escape');
  });
  await check('invalid_evidence_keeps_draft_and_reminder',async()=>{
   clock('2026-10-29T01:11:00+00:00');await createReview();await fillProof('2026-11-02T01:10:00Z');
   await click('#review-evidence-form button[type=submit]');await cdp.wait("document.querySelector('#review-evidence-form [role=alert]')");
   assert.equal(await cdp.eval("document.querySelector('#inspection-alert-open').dataset.count"),'1');
   assert.equal(await cdp.eval("document.querySelector('#review-evidence-form [name=inspector_id]').value"),'isolated-browser-test');
   await shot('03-validation-keeps-reminder');
  });
  await check('valid_window_review_clears_reminder_with_immutable_old_run',async()=>{
   await fillProof('2026-10-29T01:11:00Z');
   // Server writes succeed but the browser loses its first confirmation read.
   let failedRead=false;
   const intercept=async event=>{
    const m=JSON.parse(event.data);if(m.method!=='Fetch.requestPaused')return;
    if(!failedRead&&m.params.request.method==='GET'){
     failedRead=true;await cdp.send('Fetch.failRequest',{requestId:m.params.requestId,errorReason:'ConnectionReset'});await cdp.send('Fetch.disable');
    }else await cdp.send('Fetch.continueRequest',{requestId:m.params.requestId});
   };
   cdp.ws.addEventListener('message',intercept);
   await cdp.send('Fetch.enable',{patterns:[{urlPattern:base+'/api/runs/*',requestStage:'Request'}]});
   followup=await saveProof();cdp.ws.removeEventListener('message',intercept);
   assert(failedRead);assert.equal(await cdp.eval("document.querySelector('#inspection-alert-open').dataset.count"),'1');
   assert((await cdp.eval("document.querySelector('#inspection-alert-warning').textContent")).includes('读取失败'));
   await shot('04a-unconfirmed-read-retains-warning');
   // Re-open the actual saved review; successful server read now confirms resolution.
   await click('#review-body > .form-actions button');await cdp.wait("document.querySelector('#review-body select')");
   await set('#review-body select','all');await click('#review-body .queue-item');
   await cdp.wait("document.querySelector('#review-body h3')?.textContent.includes('材料已处理')");
   assert.equal(followup.task_results[0].state,'established');assert.deepEqual(followup.coverage.missing,[]);
   assert.equal(await cdp.eval("document.querySelector('#inspection-alert-open').dataset.count"),'0');
   assert.equal(await cdp.eval("document.querySelector('#campus-run-context').dataset.runId"),oldRun.run_id);
   assert.deepEqual(await api('/api/runs/'+oldRun.run_id),oldRun);
   assert(followup.evidence.some(e=>e.review_id&&e.evidence_type==='review_confirmation'));
   await shot('04-proof-saved');await key('Escape');await click('#inspection-alert-open');
   assert((await cdp.eval("document.querySelector('#inspection-alert-source').textContent")).includes(followup.run_id));
   await shot('05-resolved-latest-run');await key('Escape');
   assert.equal(await cdp.eval('document.activeElement.id'),'inspection-alert-open');await click('#refresh-btn');await sleep(500);
   assert.equal(await cdp.eval("document.querySelector('#inspection-alert-open').dataset.count"),'0');
  });
  await check('late_evidence_is_saved_but_cannot_clear_expired_round_gap',async()=>{
   clock('2026-10-30T01:11:00+00:00');oldRun=await prepare('S2');await createReview();await fillProof('2026-10-30T01:11:00Z');
   const late=await saveProof();assert.equal(late.task_results[0].state,'blocked');assert(late.coverage.missing.includes('C07'));
   assert.equal(await cdp.eval("document.querySelector('#inspection-alert-open').dataset.count"),'1');
   assert.deepEqual(await api('/api/runs/'+oldRun.run_id),oldRun);await key('Escape');await click('#inspection-alert-open');await shot('06-late-proof-retains-warning');
  });
  await check('responsive_business_popup_uses_native_pointer_and_keyboard',async()=>{
   for(const width of [1440,768,390]){
    await dismiss();await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await sleep(180);
    await click('#inspection-alert-open');
    assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));
    assert(await cdp.eval("(()=>{const e=document.querySelector('#inspection-alert-popup'),r=e.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&r.top>=0&&e.scrollWidth<=e.clientWidth+1})()"));
    await key('Tab','Tab',9);assert(await cdp.eval("document.querySelector('#inspection-alert-popup').contains(document.activeElement)"));
    await shot('07-reminder-'+width);await key('Escape');assert.equal(await cdp.eval('document.activeElement.id'),'inspection-alert-open');
   }
  });
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;if(cdp)try{await shot('failure');}catch{}}
 finally{cdp?.ws?.close();for(const child of children.reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
