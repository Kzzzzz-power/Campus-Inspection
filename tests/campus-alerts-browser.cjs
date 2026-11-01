// Digital twin acceptance: real Broker -> MQTT -> API -> WebSocket -> WebGL and accessible UI.
// Bootstrap/CDP lifecycle follows realtime-e2e.cjs; kept independent so its acceptance remains unchanged.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','campus-alerts','alerts-'+Date.now());
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
 let cdp,sim,broker;const mqttPort=await port(),webPort=await port(),debugPort=await port(),base=`http://127.0.0.1:${webPort}`;
 const overrides=path.join(OUT,'input-overrides.json');
 const change=condition=>fs.writeFileSync(overrides,JSON.stringify({'switch-301':{condition,metrics:{latency_ms:87}}}));change('WARNING');
 const api=async url=>{const r=await fetch(base+url);assert(r.ok);return r.json();};
 const current=()=>api('/api/current');
 const item=s=>s.facilities.find(f=>f.facility_id==='switch-301');
 const popup="document.querySelector('.twin-alert-popup')";
 const mark='.twin-marker[data-point-id="C07"]';
 const simStart=()=>start('simulator',PY,['-B','-m','simulators.facility_status','--port',String(mqttPort),'--interval','1','--overrides',overrides]);
 async function click(selector){const r=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(${JSON.stringify(selector)})===e};})()`);assert(r.hit,'Pointer blocked '+selector);for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:r.x,y:r.y});}
 async function escape(){for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});}
 async function shot(name){fs.writeFileSync(path.join(OUT,name+'.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));}
 function pass(name){report.checks.push(name);console.log('PASS '+name);}
 async function remote(condition){await until(async()=>item(await current())?.observation?.condition===condition,'remote '+condition);await cdp.wait(`document.querySelector('#campus-stage').dataset.alertStream==='ready'`);}
 try{
  broker=start('broker',BPY,['-B','-m','simulators.broker','--port',String(mqttPort)]);
  start('api',PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(webPort)],{INSPECTGO_MQTT_ENABLED:'true',INSPECTGO_MQTT_HOST:'127.0.0.1',INSPECTGO_MQTT_PORT:String(mqttPort),INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads')});
  await until(async()=>(await current()).broker.state==='connected','Broker connected');sim=simStart();await until(async()=>item(await current())?.observation?.condition==='WARNING','initial warning');
  const businessBefore=(await api('/api/dashboard')).points.map(p=>[p.point_id,p.covered,p.review]);const runsBefore=await api('/api/runs');
  start('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const page=await until(async()=>{const p=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return p.find(t=>t.type==='page');},'Chrome');cdp=new CDP(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await cdp.send('Page.navigate',{url:base});
  await cdp.wait("document.querySelector('#campus-stage')?.dataset.renderer==='webgl' && document.querySelector('#campus-stage').dataset.alertCount==='1'");
  assert(await cdp.eval(popup+'.hidden'));await click('.twin-alerts summary');assert((await cdp.eval("document.querySelector('.twin-alert-list').textContent")).includes('C07'));await shot('initial-list');await click('.twin-alerts summary');pass('initial_existing_warning_list_only');
  change('FAULT');await remote('FAULT');await cdp.wait('!'+popup+'.hidden');assert.equal(await cdp.eval(popup+'.dataset.pointId'),'C07');assert((await cdp.eval(popup+'.textContent')).includes('教学模拟'));await shot('new-fault-popup');pass('new_fault_from_MQTT_API_WebSocket_opens_popup');
  await click('.twin-alert-actions button:first-child');await cdp.wait("document.querySelector('#campus-stage').dataset.focused==='C07'");assert(await cdp.eval(popup+'.hidden'));const seq=(await current()).revision;await until(async()=>(await current()).revision>seq+10,'repeat telemetry');assert(await cdp.eval(popup+'.hidden'));pass('view_point_and_duplicate_messages_do_not_repeat');
  change('NORMAL');await remote('NORMAL');await cdp.wait("document.querySelector('#campus-stage').dataset.alertCount==='0'");await click('#campus-tasks-open');await cdp.wait("document.querySelector('#campus-task-dialog').open");change('WARNING');await remote('WARNING');await cdp.wait("document.querySelector('#campus-stage').dataset.alertPending==='1'");assert(await cdp.eval(popup+'.hidden'));await escape();await cdp.wait('!'+popup+'.hidden');pass('new_warning_waits_for_form_to_close');
  await click('.twin-alert-actions button:nth-child(2)');await cdp.wait("document.querySelector('#detail-dialog').open");assert((await cdp.eval("document.querySelector('#detail-dialog').textContent")).includes('C07'));await escape();pass('inspect_opens_real_C07_detail');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:false});change('FAULT');await remote('FAULT');await cdp.wait('!'+popup+'.hidden');const rect=await cdp.eval(`(()=>{const r=${popup}.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()`);assert(rect.left>=0&&rect.right<=390&&rect.top>=0&&rect.bottom<=900);await shot('mobile-popup');await click('.twin-alert-actions button:last-child');pass('mobile_popup_and_dismiss');
  await stop(sim);await until(async()=>item(await current()).freshness==='stale','stale',18000);await cdp.wait("document.querySelector('#campus-stage').dataset.alertStream==='unavailable'");assert(await cdp.eval(popup+'.hidden'));assert.equal(await cdp.eval(`document.querySelector(${JSON.stringify(mark)}).dataset.alarm`),'unknown');pass('stale_is_unknown_without_popup');
  sim=simStart();await remote('FAULT');await cdp.wait("document.querySelector('#campus-stage').dataset.alertCount==='1'");assert(await cdp.eval(popup+'.hidden'));pass('same_alarm_after_reconnect_does_not_repeat');
  await stop(broker);await cdp.wait("document.querySelector('#campus-stage').dataset.alertStream==='unavailable'");assert(await cdp.eval(popup+'.hidden'));pass('broker_disconnect_is_not_a_facility_fault');
  assert.deepEqual((await api('/api/dashboard')).points.map(p=>[p.point_id,p.covered,p.review]),businessBefore);assert.deepEqual(await api('/api/runs'),runsBefore);assert(frames.some(s=>item(s)?.observation?.condition==='FAULT'));assert.deepEqual(report.errors,[]);pass('coverage_reviews_and_runs_unchanged');report.status='passed';
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;if(cdp)try{await shot('failure');}catch{}}
 finally{cdp?.ws.close();for(const c of children.reverse())await stop(c);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})();