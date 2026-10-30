// Real Broker -> MQTT probe -> API -> WebSocket -> browser verification.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','stage01','e2e-'+Date.now());
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
 const mqttPort=await port(),webPort=await port(),debugPort=await port(),BASE=`http://127.0.0.1:${webPort}`;
 report.ports={mqttPort,webPort,debugPort};
 const overrides=path.join(OUT,'input-overrides.json');fs.writeFileSync(overrides,'{}');
 const api=async(url,body)=>{const r=await fetch(BASE+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);assert(r.ok,`${url}: ${r.status}`);return r.json();};
 const current=()=>api('/api/current');
 const item=s=>s.facilities.find(f=>f.facility_id==='switch-301');
 const change=(condition,latency)=>fs.writeFileSync(overrides,JSON.stringify({'switch-301':{condition,metrics:{latency_ms:latency}}}));
 const backendEnv={INSPECTGO_MQTT_ENABLED:'true',INSPECTGO_MQTT_HOST:'127.0.0.1',INSPECTGO_MQTT_PORT:String(mqttPort),INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads')};
 const brokerStart=()=>start('broker',BPY,['-B','-m','simulators.broker','--port',String(mqttPort)]);
 const apiStart=()=>start('api',PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(webPort)],backendEnv);
 const simStart=()=>start('simulator',PY,['-B','-m','simulators.facility_status','--port',String(mqttPort),'--interval','2','--overrides',overrides]);
 let broker,backend,sim;
 async function check(name,fn){const details=await fn();report.checks.push({name,status:'passed',details});console.log('PASS '+name);}
 try{
 broker=brokerStart();backend=apiStart();
 await until(async()=>{const s=await current();return s.broker.state==='connected'&&s;},'API subscribed');
 const probeCode=`import json\nimport paho.mqtt.client as m\nc=m.Client(m.CallbackAPIVersion.VERSION2)\nc.on_connect=lambda client,data,flags,code,props: client.subscribe('nova/bb02/facility/+/status',qos=1)\ndef received(client,data,msg):\n try: value=json.loads(msg.payload)\n except (ValueError,RecursionError): return\n print(json.dumps({'topic':msg.topic,'payload':value}),flush=True)\nc.on_message=received\nc.connect_async('127.0.0.1',${mqttPort},keepalive=5)\nc.loop_forever()`;
 const probe=start('probe',PY,['-B','-c',probeCode]);let buffer='';probe.stdout.on('data',chunk=>{buffer+=chunk.toString();let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{probeMessages.push(JSON.parse(line));if(probeMessages.length>400)probeMessages.shift();}catch{}}});
 await check('initial_unknown_eight_configured_facilities',async()=>{const s=await current();assert.equal(s.facilities.length,8);assert(s.facilities.every(p=>p.observation===null));return{ids:s.facilities.map(p=>p.facility_id)};});
 const frozen=await api('/api/runs',{request_id:'stage01-before-stream'});
 start('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
 const target=await until(async()=>{const list=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return list.find(t=>t.type==='page');},'Chrome debug');
 cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Page.enable');
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await cdp.send('Page.navigate',{url:BASE});await cdp.wait('document.querySelectorAll(".point-card").length===8');
 await cdp.eval("window.__stage01_marker='same-page'");
 sim=simStart();
 await check('eight_simulated_facilities_reach_broker_api_ws_dom',async()=>{
 const snapshot=await until(async()=>{const s=await current();return s.facilities.every(p=>p.freshness==='fresh')&&s;},'eight fresh observations');
 await until(()=>new Set(probeMessages.map(m=>m.payload.facility_id)).size===8,'MQTT probe eight');
 await cdp.wait("document.querySelector('[data-point=\"C07\"] .realtime-meta').textContent.includes('18')");
 assert(frames.some(s=>s.facilities.every(f=>f.observation)),'actual WS frames must contain all eight observations');
 assert.equal(await cdp.eval("document.getElementById('covered-count').textContent"),'0');
 for(const f of snapshot.facilities)assert(await cdp.eval(`document.querySelector('[data-point="${f.checkpoint_id}"]').textContent.includes(${JSON.stringify(f.facility_id)})`));
 return {facility_count:8,probe_topic_count:8,websocket_frames:frames.length};});
 await check('modify_warning_and_latency_crosses_all_four_boundaries_without_reload',async()=>{
 change('WARNING',87);
 const snapshot=await until(async()=>{const s=await current();return item(s).observation?.metrics.latency_ms===87&&s;},'API modified observation');
 await until(()=>probeMessages.some(m=>m.payload.facility_id==='switch-301'&&m.payload.metrics.latency_ms===87),'MQTT modified observation');
 await cdp.wait("document.querySelector('[data-point=\"C07\"]').textContent.includes('87') && document.querySelector('[data-point=\"C07\"]').textContent.includes('警告')");
 assert(frames.some(s=>item(s).observation?.metrics.latency_ms===87),'WS modified observation');
 assert.equal(await cdp.eval('window.__stage01_marker'),'same-page');
 return {topic:'nova/bb02/facility/switch-301/status',condition:'WARNING',latency_ms:87,observed_at:item(snapshot).observation.observed_at};});
 await check('remote_data_does_not_change_site_records_review_or_archived_run',async()=>{
 assert.equal((await api('/api/dashboard')).covered,0);
 const d=await api('/api/points/C07');assert.deepEqual(d.records,[]);assert.deepEqual(d.reviews,[]);
 assert.deepEqual((await api('/api/runs/'+frozen.run_id)).snapshot,frozen.snapshot);});
 await check('active_inspection_draft_and_focus_survive_live_update',async()=>{
 await cdp.eval("document.querySelector('[data-point=\"C07\"] .point-actions button:last-child').click()");
 await cdp.wait("document.querySelector('#detail-dialog textarea[name=notes]')");
 await cdp.eval("(()=>{const t=document.querySelector('#detail-dialog textarea[name=notes]');t.value='未提交现场草稿';t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();})()");
 change('NORMAL',31);await cdp.wait("document.getElementById('detail-realtime-meta').textContent.includes('31')");
 assert.equal(await cdp.eval("document.querySelector('#detail-dialog textarea[name=notes]').value"),'未提交现场草稿');
 assert.equal(await cdp.eval('document.activeElement.name'),'notes');
 await cdp.eval("window.confirm=()=>true;document.getElementById('detail-close').click()");});
 await check('alarm_filter_and_location_search_follow_remote_state',async()=>{
 change('WARNING',88);await cdp.wait("document.querySelector('[data-point=\"C07\"]').textContent.includes('88')");
 await cdp.eval("(()=>{const s=document.getElementById('status-filter');s.value='alarm';s.dispatchEvent(new Event('change',{bubbles:true}));const q=document.getElementById('search');q.value='switch-301';q.dispatchEvent(new Event('input',{bubbles:true}));q.focus();})()");
 await cdp.wait("document.querySelectorAll('.point-card').length===1");
 await sleep(2300);assert.equal(await cdp.eval("document.activeElement.id"),'search');assert.equal(await cdp.eval("document.getElementById('search').value"),'switch-301');
 await cdp.eval("document.getElementById('reset-filters').click()");});
 await check('bad_mqtt_payload_is_rejected_without_marking_fault',async()=>{
 const before=(await current()).diagnostics;
 const badCode=`from paho.mqtt.publish import single\nsingle('nova/bb02/facility/switch-301/status',payload='['*2000+'0'+']'*2000,hostname='127.0.0.1',port=${mqttPort},qos=1)`;
 const bad=start('invalid-publisher',PY,['-B','-c',badCode]);await until(()=>bad.exitCode!==null,'invalid publisher exit');assert.equal(bad.exitCode,0);
 await until(async()=>(await current()).diagnostics.rejected>before.rejected,'rejected counter');
 await until(async()=>(await current()).diagnostics.accepted>before.accepted,'valid messages after deeply nested JSON');
 assert.equal(item(await current()).observation.condition,'WARNING');});
 await check('publisher_stop_expires_data_without_changing_last_business_condition',async()=>{
 await stop(sim);await until(async()=>item(await current()).freshness==='stale','stale after publisher stop',18000);
 const s=await current();assert.equal(s.broker.state,'connected');assert.equal(item(s).observation.condition,'WARNING');
 await cdp.wait("document.querySelector('[data-point=\"C07\"]').textContent.includes('数据已过期')");
 assert(await cdp.eval("document.querySelector('[data-point=\"C07\"]').textContent.includes('状态未知')"));
 sim=simStart();await until(async()=>item(await current()).freshness==='fresh','publisher recovery');});
 await check('broker_disconnect_and_reconnect_are_visible_and_resubscribe',async()=>{
 await stop(broker);await until(async()=>(await current()).broker.state==='disconnected','broker disconnect');
 await cdp.wait("document.getElementById('broker-status').textContent.includes('已断开')");
 assert.equal(item(await current()).observation.condition,'WARNING');
 broker=brokerStart();await until(async()=>{const s=await current();return s.broker.state==='connected'&&s.facilities.every(f=>f.freshness==='fresh');},'broker reconnect',25000);
 await cdp.wait("document.getElementById('broker-status').textContent.includes('已连接')");});
 await check('backend_restart_resyncs_websocket_and_preserves_archived_run',async()=>{
 await stop(backend);await cdp.wait("document.getElementById('realtime-status').textContent.includes('断开') || document.getElementById('realtime-status').textContent.includes('连接中') || document.getElementById('realtime-status').textContent.includes('正在连接')");
 backend=apiStart();await until(async()=>{const s=await current();return s.facilities.every(f=>f.freshness==='fresh');},'backend restart current');
 await cdp.wait("document.getElementById('realtime-status').textContent==='实时 WebSocket 已连接'");
 assert.deepEqual((await api('/api/runs/'+frozen.run_id)).snapshot,frozen.snapshot);
 assert.equal(await cdp.eval('window.__stage01_marker'),'same-page');});
 await check('responsive_layout_and_actual_screenshots',async()=>{
 const widths=[];for(const width of [390,768,1440]){
 await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:false});await sleep(350);
 const dimensions=await cdp.eval('({width:innerWidth,scroll:document.documentElement.scrollWidth,cards:document.querySelectorAll(".point-card").length})');
 assert(dimensions.scroll<=width,JSON.stringify(dimensions));assert.equal(dimensions.cards,8);widths.push(dimensions);
 await cdp.eval("scrollTo({top:0,behavior:'instant'})");
 const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(OUT,`stage01-${width}.png`),Buffer.from(shot.data,'base64'));
 }return widths;});
 assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
 finally{
 cdp?.ws.close();for(const child of [...children].reverse())await stop(child);
 report.finished_at=new Date().toISOString();report.probe_examples=probeMessages.filter(m=>m.payload.facility_id==='switch-301').slice(-10);report.websocket_frame_count=frames.length;
 fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));
 }
})();
