// Integrated 3D workbench acceptance: real API persistence, point actions, dialogs and keyboard navigation.
// MQTT is disabled here; dedicated twin-browser.cjs covers the real-time chain.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','stage07-browser','flow-'+Date.now());
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
  const boards={'#campus-tasks-open':'tasks','#campus-whatif-open':'analysis','#campus-analysis-open':'analysis','#review-list-open':'evidence','#all-runs-btn':'evidence'};
  if(boards[selector]&&await cdp.eval('document.body.dataset.board')!==boards[selector]){
   await click('.board-nav [data-board="'+boards[selector]+'"]');await cdp.wait('document.body.dataset.board==='+JSON.stringify(boards[selector]));await sleep(260);
  }
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);
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
  cdp=new CDP(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.navigate',{url:base});await cdp.wait("document.querySelector('#campus-stage')?.dataset.renderer==='webgl' && document.querySelectorAll('.twin-marker').length===8");await settled();
  await check('whatif_empty_guard_inside_latest_3d',async()=>{
   assert(await cdp.eval("!!document.querySelector('#board-analysis #campus-whatif-open')"));
   await click('#campus-whatif-open');await cdp.wait("document.querySelector('#whatif-dialog').open");
   assert(await cdp.eval("document.querySelector('#whatif-submit').disabled"));await key('Escape');
   assert.equal(await cdp.eval('document.activeElement.id'),'campus-whatif-open');
   parent=await prepare('S3');assert.equal(parent.task_results[0].state,'blocked');
  });
  await check('s4_three_branches_keep_parent_and_selected_reality',async()=>{
   await click('#campus-whatif-open');await cdp.wait("document.querySelector('#whatif-preset').options.length>=3");
   for(const [preset,expected] of [['A',['executable','executable','not_executable']],['B',['executable','not_executable','executable']],['C',['not_executable','not_executable','not_executable']]]){
    await set('#whatif-preset',preset);await click('#whatif-submit');
    await until(async()=>{const id=await cdp.eval("document.querySelector('#whatif-run-id')?.textContent");return id?.startsWith('run-')&&!whatifIds.includes(id);},'new whatif');
    const id=await cdp.eval("document.querySelector('#whatif-run-id').textContent");whatifIds.push(id);child=await api('/api/runs/'+id);
    assert.equal(child.run_type,'what_if');assert.equal(child.parent_run_id,parent.run_id);
    assert.deepEqual(child.plan_results.map(p=>p.state),expected);assert.deepEqual(child.task_results,parent.task_results);
    assert.equal(await cdp.eval("document.querySelector('#campus-run-context').dataset.runId"),parent.run_id);
    assert((await cdp.eval("document.querySelector('#whatif-output').textContent")).includes('推演条件下'));
    assert.deepEqual(await api('/api/runs/'+parent.run_id),parent);await cdp.eval("document.querySelector('#whatif-output').scrollIntoView({block:'start',behavior:'instant'})");await shot('s4-'+preset);
   }
   await key('Escape');assert.equal(await cdp.eval('document.activeElement.id'),'campus-whatif-open');
  });
  await check('whatif_history_cannot_adopt_or_request_field_review',async()=>{
   await click('#all-runs-btn');await cdp.wait("document.querySelector('#run-dialog').open && document.querySelector('#run-body .run-item')");await click('#run-body .run-item');
   await cdp.wait("document.querySelector('#run-body .run-id')");
   assert.equal(await cdp.eval("document.querySelector('#run-body .run-id').textContent"),child.run_id);
   assert(await cdp.eval("!document.querySelector('#run-body [data-run-adopt]')"));
   assert(await cdp.eval("![...document.querySelectorAll('#run-body button')].some(b=>b.textContent==='发起现场复核')"));
   assert.equal(await cdp.eval("document.querySelector('#campus-run-context').dataset.runId"),parent.run_id);await shot('whatif-history');await key('Escape');
  });
  await check('s5_specific_limits_and_real_existing_review_entry',async()=>{
   oldS5=await prepare('S5');assert.deepEqual(oldS5.task_results.map(t=>t.state),['established','unknown','established','pending_verification','established']);
   assert(oldS5.task_results[4].limitations.some(s=>s.includes('C03')));
   await shot('s5-campus-task-states');
   await click('#campus-tasks-open');await click('#task-results [data-task="T2"] summary');
   await click('#task-results [data-task="T2"] [data-existing-review-id]');await cdp.wait("document.querySelector('#review-dialog').open && document.querySelector('#review-evidence-form')");
   assert((await cdp.eval("document.querySelector('#review-body').textContent")).includes('C03'));
   await shot('s5-existing-review');
  });
  await check('s5_actual_field_confirmation_creates_new_reality_old_unknown_preserved',async()=>{
   await set('#review-evidence-form [name=inspector_id]','browser-isolated-test');
   await set('#review-evidence-form [name=notes]','自动化隔离验收说明，不是真实现场检查。');await set('#review-evidence-form [name=conclusion]','normal');
   await click('#review-evidence-form [name=onsite_confirmed]');await click('#review-evidence-form button[type=submit]');
   await cdp.wait("document.querySelector('#review-rerun')?.textContent.includes('新 reality run 已保存')");
   const text=await cdp.eval("document.querySelector('#review-rerun').textContent");followup=await api('/api/runs/'+text.match(/run-[a-f0-9]+/)[0]);
   assert.equal(followup.run_type,'reality');assert.equal(followup.task_results[1].state,'established');assert.equal(followup.task_results[3].state,'established');
   assert.deepEqual(await api('/api/runs/'+oldS5.run_id),oldS5);assert.equal(await cdp.eval("document.querySelector('#campus-run-context').dataset.runId"),oldS5.run_id);
   await shot('s5-proof-followup');await key('Escape');await key('Escape');
  });
  await check('responsive_whatif_dialog_keyboard_and_focus',async()=>{
   // Adopt an existing reality via the real history UI, leaving what-if isolated.
   await click('#all-runs-btn');await click('#run-body .run-item');await cdp.wait("document.querySelector('#run-body [data-run-adopt]')");await click('#run-body [data-run-adopt]');await key('Escape');
   // Prepare a fresh S3 so the comparison has a valid frozen parent.
   parent=await prepare('S3');
   for(const width of [1440,1024,440,390]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await cdp.eval('window.scrollTo(0,0)');await sleep(150);
    assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));
    await click('#campus-whatif-open');await key('Tab','Tab',9);
    assert(await cdp.eval("document.querySelector('#whatif-dialog').contains(document.activeElement)"));
    assert(await cdp.eval("document.querySelector('#whatif-dialog').scrollWidth<=document.querySelector('#whatif-dialog').clientWidth+1"));
    await shot('whatif-'+width);await key('Escape');assert.equal(await cdp.eval('document.activeElement.id'),'campus-whatif-open');
   }
  });
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;if(cdp)try{await shot('failure');}catch{}}
 finally{cdp?.ws?.close();for(const child of children.reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
