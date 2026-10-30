// Real Broker -> MQTT probe -> API -> WebSocket -> browser verification.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','stage02-browser','browser-'+Date.now());
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
 const webPort=await port(),debugPort=await port(),BASE=`http://127.0.0.1:${webPort}`,db=path.join(OUT,'isolated.db');
 const api=async(url,body)=>{const r=await fetch(BASE+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);assert(r.ok,url+': '+r.status+' '+await r.clone().text());return r.json();};
 function python(code){const r=spawnSync(PY,['-B','-c',code],{cwd:ROOT,env,windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr||r.error?.message);}
 async function check(name,fn){await fn();report.checks.push({name,status:'passed'});console.log('PASS '+name);}
 async function set(selector,value){await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
 async function click(selector){await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);}
 async function key(key){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,text:key==='Enter'?'\r':undefined,windowsVirtualKeyCode:({Enter:13,Escape:27,Tab:9})[key]});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:({Enter:13,Escape:27,Tab:9})[key]});}
 try{
  start('api',PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(webPort)],{INSPECTGO_DB:db,INSPECTGO_UPLOADS:path.join(OUT,'uploads'),INSPECTGO_MQTT_ENABLED:'false'});
  await until(async()=>(await fetch(BASE+'/health')).ok,'API');
  start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const target=await until(async()=>{const list=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return list.find(t=>t.type==='page');},'Chrome');
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Page.enable');
  await cdp.send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await cdp.send('Page.navigate',{url:BASE});await cdp.wait('document.querySelectorAll(".point-card").length===8 && document.getElementById("evidence-browser-open")');
  await check('evidence_entry_round_creation_and_keyboard_return',async()=>{
   await cdp.eval("document.getElementById('evidence-browser-open').focus()");await key('Enter');await cdp.wait("document.getElementById('evidence-browser-dialog').open");
   await click('#round-tools > summary');await set('#round-create-id','browser-round');await set('#round-create-date','2026-10-01');await click('#round-create-submit');
   await until(async()=>(await api('/api/rounds?round_id=browser-round')).total===1,'round saved');
   assert.match(await cdp.eval("document.getElementById('evidence-browser-dialog').textContent"),/09:00/);
   await key('Escape');await cdp.wait("!document.getElementById('evidence-browser-dialog').open");assert.equal(await cdp.eval('document.activeElement.id'),'evidence-browser-open');
  });
  await check('round_save_confirmation_survives_refresh_failure_and_freezes_inputs',async()=>{
   await click('#evidence-browser-open');await cdp.wait("!document.getElementById('round-refresh').disabled");
   await set('#round-create-id','saved-with-refresh-failure');await set('#round-create-date','2026-10-01');
   await cdp.send('Network.setBlockedURLs',{urls:['*://127.0.0.1:*/api/rounds?*']});
   await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:600,downloadThroughput:-1,uploadThroughput:-1});
   await click('#round-create-submit');
   assert(await cdp.eval("document.getElementById('round-create-id').disabled && document.getElementById('round-create-date').disabled"));
   await cdp.wait("document.getElementById('round-tools').textContent.includes('已保存') && document.getElementById('round-tools').textContent.includes('刷新失败')");
   assert.equal((await api('/api/rounds?round_id=saved-with-refresh-failure')).total,1);
   assert(!(await cdp.eval("document.getElementById('round-tools').textContent.includes('创建失败')")));
   await cdp.send('Network.setBlockedURLs',{urls:[]});await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
   await click('#round-refresh');await cdp.wait("document.querySelector('#evidence-round-filter option[value=saved-with-refresh-failure]')");
   await key('Escape');
  });
  await check('site_form_round_photo_failure_keeps_input_then_retry_saves_once',async()=>{
   await click('.point-card[data-point="C07"] .point-actions button:last-child');await cdp.wait("document.querySelector('#detail-dialog form[data-form=inspection] select[name=inspection_round_id] option[value=browser-round]')");
   await set('#detail-dialog input[name=inspector_id]','浏览器隔离验收');await set('#detail-dialog input[name=inspected_at]','2026-10-01T09:25');await set('#detail-dialog select[name=result]','ok');await set('#detail-dialog textarea[name=notes]','验收：失败保留输入，重试只保存一次');await set('#detail-dialog select[name=inspection_round_id]','browser-round');await click('#detail-dialog input[name=onsite_confirmed]');
   const picture=path.join(OUT,'test-photo.png');python(`from PIL import Image\nImage.new('RGB',(3,3),'blue').save(${JSON.stringify(picture)})`);
   const doc=await cdp.send('DOM.getDocument');const node=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#detail-dialog input[name=photos]'});await cdp.send('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[picture]});
   python(`import sqlite3\nc=sqlite3.connect(${JSON.stringify(db)})\nc.execute("CREATE TRIGGER browser_fail BEFORE INSERT ON inspection_records BEGIN SELECT RAISE(ABORT,'browser injected failure'); END")\nc.commit()`);
   await click('#detail-dialog form[data-form=inspection] button[type=submit]');await cdp.wait("document.querySelector('#detail-dialog .form-message.is-error')");
   assert.match(await cdp.eval("document.querySelector('#detail-dialog textarea[name=notes]').value"),/失败保留输入/);assert.equal((await api('/api/inspections')).total,0);
   python(`import sqlite3\nc=sqlite3.connect(${JSON.stringify(db)})\nc.execute('DROP TRIGGER browser_fail')\nc.commit()`);
   await click('#detail-dialog form[data-form=inspection] button[type=submit]');await until(async()=>(await api('/api/inspections')).total===1,'site save');await cdp.wait("document.querySelector('#detail-dialog .photo-thumb')");
   assert.equal((await api('/api/inspections')).items[0].inspection_round_id,'browser-round');await click('#detail-dialog .photo-thumb');await cdp.wait("document.getElementById('photo-dialog').open && document.getElementById('photo-image').naturalWidth>0");await key('Escape');await click('#detail-close');
  });
  await check('archive_filter_pagination_storage_check_and_safe_rendering',async()=>{
   for(let i=0;i<25;i++)await api('/api/inspections',{inspection_round_id:'browser-round',checkpoint_id:'C07',facility_id:'switch-301',zone_id:'Z3',inspector_id:'browser-seed',inspected_at:'2026-10-01T09:25:00+08:00',method:'ON_SITE',result:'NORMAL',notes:i===0?'<img src=x onerror="window.injected=true">':'分页验收 '+i,request_id:'browser-seed-'+i});
   await click('#evidence-browser-open');await cdp.wait("document.getElementById('evidence-browser-dialog').open");
   await set('#evidence-browser-tab','inspections');await cdp.wait("!document.getElementById('evidence-search').disabled");await set('#evidence-facility-filter','switch-301');await set('#evidence-round-filter','browser-round');await click('#evidence-search');
   await cdp.wait("!document.getElementById('evidence-next').disabled");await click('#evidence-next');await cdp.wait("!document.getElementById('evidence-prev').disabled");assert.equal(await cdp.eval('window.injected===true'),false);
   await click('#storage-tools > summary');await click('#storage-check-submit');await cdp.wait("document.getElementById('storage-check-status').textContent.includes('保存') || document.getElementById('storage-check-status').textContent.includes('通过')");
   assert.equal((await api('/api/evidence?evidence_type=sqlite_write')).total,1);
  });
  await check('evidence_load_failure_and_retry',async()=>{
   await cdp.send('Network.setBlockedURLs',{urls:['*://127.0.0.1:*/api/evidence?*']});await set('#evidence-browser-tab','evidence');await click('#evidence-search');await cdp.wait("document.getElementById('evidence-status').textContent.includes('失败') || document.getElementById('evidence-results').textContent.includes('失败')");
   await cdp.send('Network.setBlockedURLs',{urls:[]});await click('#evidence-search');await cdp.wait("document.getElementById('evidence-results').textContent.includes('E-')");
  });
  await check('responsive_archive_keyboard_and_reduced_motion',async()=>{
   for(const width of [390,768,1440]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:width===390});await sleep(250);assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth'));assert(await cdp.eval("document.getElementById('evidence-browser-dialog').scrollWidth<=document.getElementById('evidence-browser-dialog').clientWidth+1"),'dialog overflow '+width);const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,`evidence-${width}.png`),Buffer.from(shot.data,'base64'));}
   await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await key('Escape');await cdp.wait("!document.getElementById('evidence-browser-dialog').open");assert.equal(await cdp.eval('document.activeElement.id'),'evidence-browser-open');
  });
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(e){report.error=e.stack;try{report.ui=await cdp.eval('({active:document.activeElement?.outerHTML,dialogs:[...document.querySelectorAll("dialog")].map(d=>({id:d.id,open:d.open,text:d.textContent.slice(0,800)}))})');const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,'failure.png'),Buffer.from(shot.data,'base64'));}catch{}console.error(e.stack);process.exitCode=1;}
 finally{cdp?.ws.close();for(const child of [...children].reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});