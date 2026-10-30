// Real Broker -> MQTT probe -> API -> WebSocket -> browser verification.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','room-stage-fix','browser-'+Date.now());
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
 const db=path.join(OUT,'isolated.db'),uploads=path.join(OUT,'uploads');
 const seed=`from backend.storage import Store\nfrom datetime import datetime,timezone\ns=Store(${JSON.stringify(db)},${JSON.stringify(uploads)})\ns.initialize(False)\nwith s.transaction(write=True) as c:\n c.execute("INSERT INTO records(point_id,status,source,evidence,created_at) VALUES (?,?,?,?,?)",('C01','ok','remote','test remote observation',datetime.now(timezone.utc).isoformat()))`;
 function python(code){const r=spawnSync(PY,['-B','-c',code],{cwd:ROOT,env,windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr||r.error?.message);}
 function publish(condition='NORMAL'){
   const data={facility_id:'lighting-201',zone_id:'Z1',observed_at:new Date().toISOString(),source_type:'SIMULATED',availability:'AVAILABLE',condition,metrics:{latency_ms:18}};
   python(`import paho.mqtt.client as m\nc=m.Client(m.CallbackAPIVersion.VERSION2)\nc.connect('127.0.0.1',${mqttPort})\nc.loop_start()\nc.publish('nova/bb02/facility/lighting-201/status',${JSON.stringify(JSON.stringify(data))},qos=1,retain=True).wait_for_publish(5)\nc.disconnect()\nc.loop_stop()`);
 }
 async function check(name,fn){try{const details=await fn();report.checks.push({name,status:'passed',details});console.log('PASS '+name);}catch(error){report.checks.push({name,status:'failed',error:error.message});console.log('FAIL '+name+': '+error.message);}}
 async function viewport(width){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:width===390});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width===390,maxTouchPoints:1});}
 async function load(width=1440){await viewport(width);await cdp.send('Page.navigate',{url:BASE});await cdp.wait('document.querySelectorAll(".room-card").length===8');await cdp.eval("localStorage.setItem('inspectgo:motion','off');if(document.getElementById('motion-toggle').checked)document.getElementById('motion-toggle').click()");}
 async function key(key,code=key){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key,code});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code});}
 async function click(selector){const r=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...r});await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...r,button:'left',clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...r,button:'left',clickCount:1});}
 try{
 python(seed);
 start('broker',BPY,['-B','-m','simulators.broker','--port',String(mqttPort)]);
 start('api',PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(webPort)],{INSPECTGO_DB:db,INSPECTGO_UPLOADS:uploads,INSPECTGO_MQTT_ENABLED:'true',INSPECTGO_MQTT_PORT:String(mqttPort),INSPECTGO_STALE_SECONDS:'4'});
 await until(async()=>{const r=await fetch(BASE+'/api/current');return r.ok&&(await r.json()).broker.state==='connected';},'API/Broker ready');
 start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
 const target=await until(async()=>{const list=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return list.find(t=>t.type==='page');},'Chrome');
 cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Page.enable');
 await check('live_warning_matches_room_and_list_without_refresh',async()=>{
   await load();publish('WARNING');await cdp.wait("document.querySelector('.point-card[data-point=C01]').textContent.includes('警告')");
   assert.match(await cdp.eval("document.querySelector('.room-card[data-point=C01]').textContent"),/警告/);
   assert.match(await cdp.eval("document.getElementById('room-selected-status').textContent"),/警告/);
 });
 await check('missing_coverage_never_uses_success_icon',async()=>{
   await load();publish();await cdp.wait("document.querySelector('.point-card[data-point=C01]').textContent.includes('可用 · 正常')");
   const data=await cdp.eval("(()=>{const c=document.querySelector('.room-card[data-point=C01] .room-card__status');return{text:c.textContent,warn:c.classList.contains('status-warn'),success:!!c.querySelector('.status-check')};})()");
   assert.match(data.text,/缺少/);assert.equal(data.warn,true);assert.equal(data.success,false);
 });
 await check('keyboard_arrow_then_enter_opens_selected_point',async()=>{
   await load();await cdp.eval("document.querySelector('.room-card[data-point=C01]').focus()");await key('ArrowRight');
   assert.equal(await cdp.eval("document.querySelector('.room-card.is-active').dataset.point"),'C02');
   assert.equal(await cdp.eval('document.activeElement.dataset.point'),'C02');await key('Enter');await cdp.wait("document.getElementById('detail-dialog').open");assert.match(await cdp.eval("document.getElementById('detail-title').textContent"),/C02/);
 });
 await check('real_mouse_click_selects_then_enters_card',async()=>{
   await load();await click('.room-card[data-point=C02]');await sleep(150);assert.equal(await cdp.eval("document.querySelector('.room-card.is-active').dataset.point"),'C02');
   await click('.room-card[data-point=C02]');await cdp.wait("document.getElementById('detail-dialog').open");assert.match(await cdp.eval("document.getElementById('detail-title').textContent"),/C02/);
 });
 await check('expired_remote_state_becomes_unknown_in_both_views',async()=>{
   await load();publish();await cdp.wait("document.querySelector('.point-card[data-point=C01]').textContent.includes('可用 · 正常')");await sleep(5100);
   assert.match(await cdp.eval("document.querySelector('.point-card[data-point=C01]').textContent"),/状态未知/);
   assert.match(await cdp.eval("document.querySelector('.room-card[data-point=C01]').textContent"),/状态未知/);
 });
 await check('touch_swipe_selects_visible_point_and_enters_it',async()=>{
   await load(390);const pos=await cdp.eval("(()=>{const e=document.getElementById('room-ring');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.right-30,y:r.top+80};})()");
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...pos,id:1}]});
   for(let step=1;step<=8;step++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:pos.x-step*24,y:pos.y,id:1}]});await sleep(35);}
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(700);
   assert(await cdp.eval("document.getElementById('room-ring').scrollLeft>60"),'swipe did not scroll horizontally');
   const visible=await cdp.eval("(()=>{const ring=document.getElementById('room-ring'),r=ring.getBoundingClientRect(),x=r.left+r.width/2;return [...ring.children].sort((a,b)=>{const ca=a.getBoundingClientRect(),cb=b.getBoundingClientRect();return Math.abs(ca.left+ca.width/2-x)-Math.abs(cb.left+cb.width/2-x)})[0].dataset.point;})()");
   assert.notEqual(visible,'C01');assert.equal(await cdp.eval("document.querySelector('.room-card.is-active').dataset.point"),visible);
   await click('#room-enter');await cdp.wait("document.getElementById('detail-dialog').open");assert((await cdp.eval("document.getElementById('detail-title').textContent")).includes(visible));
 });
 await check('responsive_layout_and_reduced_motion_entry',async()=>{
   for(const width of [390,768,1440]){await load(width);assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth'));const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,`room-${width}.png`),Buffer.from(shot.data,'base64'));}
   await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await click('#room-enter');await cdp.wait("document.getElementById('detail-dialog').open");assert.equal(await cdp.eval("document.querySelectorAll('#warp-layer,#room-spark').length"),0);
 });
 await check('mobile_selection_survives_remote_card_update',async()=>{
   await load(390);await click('.room-arrow[data-dir="1"]');await sleep(500);
   assert.equal(await cdp.eval("document.querySelector('.room-card.is-active').dataset.point"),'C02');
   publish('FAULT');await cdp.wait("document.querySelector('.room-card[data-point=C01]').textContent.includes('故障')");await sleep(300);
   assert.equal(await cdp.eval("getComputedStyle(document.querySelector('.room-card[data-point=C01] .room-card__facility')).color"),'rgb(180, 35, 24)');
   assert.equal(await cdp.eval("document.querySelector('.room-card.is-active').dataset.point"),'C02');
   assert(await cdp.eval("document.getElementById('room-ring').scrollLeft>60"),'live update reset the mobile position');
 });
 await check('card_titles_and_status_rows_are_not_clipped',async()=>{
   for(const width of [390,768,1440]){await load(width);assert(await cdp.eval("[...document.querySelectorAll('.room-card__name,.room-card__status')].every(e=>e.clientHeight>=e.scrollHeight)"),'card text clipped at '+width);}
 });
 await check('record_form_draft_survives_remote_update',async()=>{
   await load();await click('#room-enter');await cdp.wait("document.querySelector('#detail-dialog textarea[name=notes]')");
   await cdp.eval("(()=>{const t=document.querySelector('textarea[name=notes]');t.value='保留未提交输入';t.dispatchEvent(new Event('input',{bubbles:true}));t.focus()})()");publish('FAULT');await sleep(1300);
   assert.equal(await cdp.eval("document.querySelector('textarea[name=notes]').value"),'保留未提交输入');assert.equal(await cdp.eval('document.activeElement.name'),'notes');
 });
 assert.equal(report.errors.length,0,JSON.stringify(report.errors));
 report.status=report.checks.every(c=>c.status==='passed')?'passed':'failed';
 if(report.status!=='passed')process.exitCode=1;
 }catch(error){report.failure=error.stack;process.exitCode=1;console.error(error.stack);}
 finally{cdp?.ws.close();for(const child of [...children].reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1});
