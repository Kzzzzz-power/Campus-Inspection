// Integrated 3D workbench acceptance: real API persistence, point actions, dialogs and keyboard navigation.
// MQTT is disabled here; dedicated twin-browser.cjs covers the real-time chain.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','photo-description-browser','flow-'+Date.now());
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

 // Header with CDP/process helpers is prepended from the existing acceptance harness.
 let original, originalData, savedPoint, photoId;
 try {
  start('api',PY,['-B','tests/photo_description_browser_app.py',String(webPort)],{INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads'),INSPECTGO_MQTT_ENABLED:'false'});
  await until(async()=>(await fetch(base+'/health')).ok,'API');
  start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const page=await until(async()=>{const list=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return list.find(t=>t.type==='page');},'Chrome');
  cdp=new CDP(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.navigate',{url:base});await cdp.wait("document.querySelector('#campus-stage')?.dataset.renderer==='webgl'");await settled();
  await check('photo_preview_reached_from_real_3d_c01_record',async()=>{
   await click('#campus-tasks-open');await set('#judgment-scenario','S1');await click('#prepare-s1');await cdp.wait("document.querySelector('#judgment-status').textContent.includes('S1 教学实例已保存')");
   await click('#campus-generate-run');await cdp.wait("document.querySelector('#run-dialog').open && document.querySelector('#run-body .run-id')");
   original=await cdp.eval("document.querySelector('#run-body .run-id').textContent");originalData=await api('/api/runs/'+original);await key('Escape');await key('Escape');
   await click('.twin-marker[data-point-id="C01"]');await settled();await click('#twin-room-enter');await settled();await click('#twin-record-point');
   await cdp.wait("document.querySelector('#detail-body form')");
   const form='#detail-body form';await set(form+' [name=inspector_id]','synthetic-photo-test');await set(form+' [name=notes]','合成图片验收，不是真实现场记录');await set(form+' [name=result]','NORMAL');
   await cdp.eval("(()=>{const c=document.createElement('canvas');c.width=c.height=8;const t=new DataTransfer();for(let i=0;i<2;i++){c.getContext('2d').fillStyle=i?'#345678':'#abcdef';c.getContext('2d').fillRect(0,0,8,8);t.items.add(new File([Uint8Array.from(atob(c.toDataURL().split(',')[1]),x=>x.charCodeAt(0))],'synthetic-'+i+'.png',{type:'image/png'}));}const p=document.querySelector('#detail-body [name=photos]');p.files=t.files;p.dispatchEvent(new Event('change',{bubbles:true}));})()");
   await click(form+' [name=onsite_confirmed]');await click(form+' button[type=submit]');await cdp.wait("!document.querySelector('#detail-body form') && document.querySelectorAll('#detail-body .photo-thumb').length===2");
   savedPoint=await api('/api/points/C01');photoId=savedPoint.photos[0].image_id;
   await click('#detail-body .photo-thumb');await cdp.wait("document.querySelector('#photo-dialog').open && document.querySelector('#photo-ai-config').textContent.includes('TEST_FIXTURE')");
  });
  await check('explicit_consent_saved_job_recovery_and_safe_text',async()=>{
   await click('#photo-ai > summary');assert(await cdp.eval("document.querySelector('#photo-ai-submit').disabled"));
   assert.equal((await api('/api/evidence/images/'+photoId+'/descriptions')).items.length,0);
   await click('#photo-ai-consent');await click('#photo-ai-submit');await cdp.wait("document.querySelector('#photo-ai-status').textContent.includes('正在生成')");
   await key('Escape');await click('#detail-body .photo-thumb');await cdp.wait("document.querySelector('#photo-ai-status').textContent.includes('辅助描述已保存')");
   const data=await api('/api/evidence/images/'+photoId+'/descriptions');assert.equal(data.items.length,1);assert.equal(data.items[0].evidence.source_type,'MODEL_OUTPUT');assert.equal(data.items[0].evidence.provenance_json.image_id,photoId);
   assert.equal(await cdp.eval("document.querySelectorAll('#photo-ai-output img').length"),0);
   assert((await cdp.eval("document.querySelector('#photo-ai-output').textContent")).includes('<img src=x'));
   assert.deepEqual(await api('/api/runs/'+original),originalData);
   const after=await api('/api/points/C01');assert.deepEqual(after.records,savedPoint.records);assert.deepEqual(after.photos,savedPoint.photos);assert.deepEqual(after.reviews,savedPoint.reviews);
   await shot('photo-summary-desktop');
  });
  await check('photo_switch_keeps_summary_binding_and_consent_separate',async()=>{
   await click('#photo-next');await cdp.wait("document.querySelector('#photo-ai-status').textContent.includes('尚未生成')");
   assert.equal(await cdp.eval("document.querySelector('#photo-ai-output').textContent"),'');assert(await cdp.eval("document.querySelector('#photo-ai-submit').disabled && !document.querySelector('#photo-ai-consent').checked"));
   await click('#photo-prev');await cdp.wait("document.querySelector('#photo-ai-output').textContent.includes('TEST_FIXTURE')");
  });
  await check('late_submission_survives_a_b_a_photo_switch',async()=>{
   await cdp.eval("window.__originalFetch=window.fetch;window.fetch=async(...args)=>{if(args[1]?.method==='POST'&&String(args[0]).endsWith('/descriptions'))await new Promise(r=>setTimeout(r,2200));return window.__originalFetch(...args);}");
   await click('#photo-ai-consent');await click('#photo-ai-submit');
   await click('#photo-next');await cdp.wait("document.querySelector('#photo-ai-status').textContent.includes('尚未生成')");
   await click('#photo-prev');await cdp.wait("document.querySelector('#photo-ai-status').textContent.includes('结果尚未确认')");
   await cdp.wait("document.querySelector('#photo-ai-status').textContent.includes('辅助描述已保存') && document.querySelector('#photo-ai-submit').getAttribute('aria-busy')==='false'");
   assert.equal((await api('/api/evidence/images/'+photoId+'/descriptions')).items.length,2);
   await cdp.eval('window.fetch=window.__originalFetch');
  });
  await check('late_read_cannot_replace_newly_confirmed_submission',async()=>{
   await cdp.eval(`window.__delayList=true;window.fetch=async(...args)=>{const url=String(args[0]);if(args[1]?.method==='POST'&&url.endsWith('/descriptions'))await new Promise(r=>setTimeout(r,400));const response=await window.__originalFetch(...args);if(!args[1]?.method&&url==='/api/evidence/images/${photoId}/descriptions'&&window.__delayList){window.__delayList=false;await new Promise(r=>setTimeout(r,900));}return response;}`);
   await click('#photo-ai-consent');await click('#photo-ai-submit');await click('#photo-next');await cdp.wait("document.querySelector('#photo-ai-status').textContent.includes('尚未生成')");await click('#photo-prev');
   await until(async()=>{const jobs=await api('/api/evidence/images/'+photoId+'/descriptions');return jobs.items.length===3&&jobs.items[0].status==='completed';},'third saved summary');
   const newest=(await api('/api/evidence/images/'+photoId+'/descriptions')).items[0].evidence.evidence_id;
   await cdp.wait(`document.querySelector('#photo-ai-output').textContent.includes(${JSON.stringify(newest)})`);
   await cdp.eval('window.fetch=window.__originalFetch');
  });
  await check('responsive_photo_preview_and_keyboard_return',async()=>{
   for(const width of [1440,1024,440,390]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await sleep(150);
    assert(await cdp.eval("document.querySelector('#photo-dialog').scrollWidth<=document.querySelector('#photo-dialog').clientWidth+1"));
    await key('Tab','Tab',9);assert(await cdp.eval("document.querySelector('#photo-dialog').contains(document.activeElement)"));
    await cdp.eval("document.querySelector('#photo-ai').scrollIntoView({block:'start'})");await shot('photo-summary-'+width);
   }
   await key('Escape');assert(await cdp.eval("!document.querySelector('#photo-dialog').open && document.querySelector('#detail-body').contains(document.activeElement)"));
  });
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;if(cdp)try{await shot('failure');}catch{}}
 finally{cdp?.ws?.close();for(const child of children.reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
