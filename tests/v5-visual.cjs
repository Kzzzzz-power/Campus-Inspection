// Digital twin acceptance: real Broker -> MQTT -> API -> WebSocket -> WebGL and accessible UI.
// Bootstrap/CDP lifecycle follows realtime-e2e.cjs; kept independent so its acceptance remains unchanged.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','v5-visual','visual-'+Date.now());
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
 let cdp,sim,currentCheck;
 const mqttPort=await port(),webPort=await port(),debugPort=await port(),BASE=`http://127.0.0.1:${webPort}`;
 report.ports={mqttPort,webPort,debugPort};
 const overrides=path.join(OUT,'input-overrides.json');fs.writeFileSync(overrides,'{}');
 const api=async url=>{const r=await fetch(BASE+url);assert(r.ok,`${url}: ${r.status}`);return r.json();};
 const current=()=>api('/api/current');
 const item=s=>s.facilities.find(f=>f.facility_id==='switch-301');
 const change=(condition,latency)=>fs.writeFileSync(overrides,JSON.stringify({'switch-301':{condition,metrics:{latency_ms:latency}}}));
 const simStart=()=>start('simulator',PY,['-B','-m','simulators.facility_status','--port',String(mqttPort),'--interval','2','--overrides',overrides]);
 const marker='.twin-marker[data-point-id="C07"]',film='.twin-film[data-point-id="C07"]';
 async function check(name,fn){currentCheck=name;const details=await fn();report.checks.push({name,status:'passed',details});console.log('PASS '+name);}
 async function click(selector){await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.focus({preventScroll:true});e.click();})()`);}
 async function key(key){const code=({Escape:27,Tab:9,Enter:13,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39})[key];await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code,...(key==='Enter'?{text:'\r'}:{})});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});}
 async function size(width,height=1200){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await sleep(250);await cdp.wait("document.querySelector('#campus-stage')?.dataset.renderer!=='webgl'||document.querySelector('#campus-stage').dataset.viewportWidth===String(document.querySelector('.twin-viewport').clientWidth)");}
 async function shot(name){await cdp.wait("!document.querySelector('#brand-title')?.classList.contains('is-flipping')");await cdp.eval("scrollTo({top:0,behavior:'instant'})");await sleep(100);const r=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const file=path.join(OUT,name+'.png');fs.writeFileSync(file,Buffer.from(r.data,'base64'));return file;}
 async function canvasShot(){const clip=await cdp.eval("(()=>{const r=document.querySelector('#campus-canvas').getBoundingClientRect();return{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()");return (await cdp.send('Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:true})).data;}
 async function markerLayout(){
  await cdp.eval("scrollTo({top:0,behavior:'instant'})");
  const markers=await cdp.eval("[...document.querySelectorAll('button.twin-marker')].map(e=>{const r=e.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{id:e.dataset.pointId,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,clickable:top?.closest('.twin-marker')===e};})");
  assert(markers.every(m=>m.width>0&&m.height>0&&m.clickable),'Marker center occluded: '+JSON.stringify(markers));
  for(let a=0;a<markers.length;a++)for(let b=a+1;b<markers.length;b++){const m=markers[a],n=markers[b],overlap=Math.min(m.right,n.right)-Math.max(m.x,n.x)>.5&&Math.min(m.bottom,n.bottom)-Math.max(m.y,n.y)>.5;assert(!overlap,'Overlapping markers: '+m.id+'/'+n.id+' '+JSON.stringify([m,n]));}
  const controls=await cdp.eval("[...document.querySelectorAll('.twin-view-tools,.twin-camera-help,.twin-map-label,.twin-orientation,#twin-enable-3d')].filter(e=>!e.hidden&&e.offsetWidth>0).map(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom};})");
  for(const m of markers)for(const c of controls)assert(!(m.x<c.right&&m.right>c.left&&m.y<c.bottom&&m.bottom>c.top),'Marker overlaps fixed control: '+m.id);
  return markers;
 }
 async function stage(){return cdp.eval("({...document.querySelector('#campus-stage').dataset})");}
 async function point(id,via='.twin-film'){await click(`${via}[data-point-id="${id}"]`);if(via==='.twin-marker'){await cdp.wait("document.querySelector('#campus-stage').dataset.transition!=='flying'");await click('#twin-room-enter');}await cdp.wait(`document.querySelector('#campus-stage').dataset.mode==='point' && document.querySelector('#campus-stage').dataset.selected===${JSON.stringify(id)}`);await cdp.wait("document.querySelector('#campus-stage').dataset.transition!=='flying'");}
 async function campus(){await click('#twin-back');await cdp.wait("document.querySelector('#campus-stage').dataset.mode==='campus'");await cdp.wait("document.querySelector('#campus-stage').dataset.transition!=='flying'");}
 async function navigate(){await cdp.send('Page.navigate',{url:BASE});await cdp.wait("document.querySelector('#campus-stage') && document.querySelector('#campus-stage').dataset.renderer");}
 try{
  start('broker',BPY,['-B','-m','simulators.broker','--port',String(mqttPort)]);
  start('api',PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(webPort)],{INSPECTGO_MQTT_ENABLED:'true',INSPECTGO_MQTT_HOST:'127.0.0.1',INSPECTGO_MQTT_PORT:String(mqttPort),INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads')});
  await until(async()=>(await current()).broker.state==='connected','API and Broker');
  start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const target=await until(async()=>{const list=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return list.find(t=>t.type==='page');},'Chrome debug');
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Page.enable');await size(1440);
  await cdp.send('Page.navigate',{url:BASE});await cdp.wait("document.querySelectorAll('.point-card[data-point]').length===8");
  await check('digital_twin_contract_exists',async()=>{
   assert.equal(await cdp.eval("!!document.querySelector('#campus-stage')"),true,'Missing #campus-stage digital twin');
   await cdp.wait("document.querySelectorAll('button.twin-marker').length===8 && document.querySelectorAll('button.twin-film').length===8");
   return await stage();
  });
  await check('actual_webgl_eight_real_points_and_first_screen_films',async()=>{
   await cdp.wait("document.querySelector('#campus-stage').dataset.renderer==='webgl' && +document.querySelector('#campus-stage').dataset.triangles>0");
   await cdp.wait("document.querySelector('#campus-stage').dataset.environment==='hdr'");
   const result=await cdp.eval(`(()=>{const canvas=document.querySelector('#campus-canvas'),gl=canvas.getContext('webgl2')||canvas.getContext('webgl');return{stage:{...document.querySelector('#campus-stage').dataset},webgl:!!gl,contextLost:gl?.isContextLost(),films:[...document.querySelectorAll('button.twin-film')].map(e=>{const r=e.getBoundingClientRect();return{id:e.dataset.pointId,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};}),markers:[...document.querySelectorAll('button.twin-marker')].map(e=>({id:e.dataset.pointId,quality:e.dataset.quality,alarm:e.dataset.alarm})),height:innerHeight};})()`);
   assert(result.webgl&&!result.contextLost);assert.equal(result.stage.asset,'meshopt');assert(Number(result.stage.assetBytes)<20*1024*1024);assert.equal(result.stage.mode,'campus');assert.equal(result.films.length,8);assert.equal(new Set(result.films.map(p=>p.id)).size,8);
   assert(result.films.every(p=>p.width>0&&p.height>0&&p.x>=0&&p.right<=1441&&p.y>=0&&p.bottom<=1200),JSON.stringify(result.films));
   assert(result.markers.every(m=>m.alarm==='unknown'),'No initial observations must remain unknown');
   assert(Number(result.stage.calls)>0 && Number(result.stage.calls)<=120,`Campus draw calls including shadow passes: ${result.stage.calls}`);assert(Number(result.stage.triangles)<=500000,`Rendered triangles including shadow passes: ${result.stage.triangles}`);result.markerLayout=await markerLayout();report.screenshots=[await shot('campus-1440')];return result;
  });
  if(process.env.OVERVIEW_ONLY==='1'){report.status='passed';return;}
  const canvasFile=path.join(OUT,'campus-stage.png');fs.writeFileSync(canvasFile,Buffer.from(await canvasShot(),'base64'));report.screenshots.push(canvasFile);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await check('point_focus_light_and_eight_rooms',async()=>{
   for(const id of ['C01','C02','C03','C04','C05','C06','C07','C08']){
    await click('.twin-marker[data-point-id="'+id+'"]');await cdp.wait("document.querySelector('#campus-stage').dataset.transition==='idle'");report.screenshots.push(await shot('focus-'+id));await click('#twin-room-enter');await cdp.wait("document.querySelector('#campus-stage').dataset.interior==='true' && document.querySelector('#campus-stage').dataset.transition==='idle'");
    await click('[data-room-action="door"]');await sleep(500);if(id==='C05'){await click('[data-room-action="portal"]');await sleep(500);}report.screenshots.push(await shot('room-'+id));await campus();
   }
  });
  await check('actual_mqtt_alarm_popup_and_dismissal',async()=>{
   sim=simStart();await until(async()=>(await current()).facilities.every(f=>f.freshness==='fresh'),'fresh');await cdp.wait("document.querySelector('#twin-hud').textContent.includes('新鲜 8')");change('FAULT',90);await until(async()=>item(await current()).observation?.condition==='FAULT','MQTT fault');await cdp.wait("!document.querySelector('.twin-alert-popup').hidden && document.querySelector('.twin-alert-popup').dataset.pointId==='C07'");report.screenshots.push(await shot('alarm-C07'));
   await click('.twin-alert-actions button:first-child');await cdp.wait("document.querySelector('#campus-stage').dataset.transition==='idle'");await sleep(2400);assert(await cdp.eval("document.querySelector('.twin-alert-popup').hidden"));report.screenshots.push(await shot('alarm-C07-dismissed'));await campus();
  });
  await check('responsive_composition',async()=>{
   for(const width of [1024,440,390]){await size(width,1200);await sleep(300);assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));await markerLayout();report.screenshots.push(await shot('campus-'+width));}
  });
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(error){report.failed_check=currentCheck;report.error=error.stack;console.error(error.stack);process.exitCode=1;try{report.failureDom=await cdp.eval("({stage:document.querySelector('#campus-stage')?.outerHTML,dialogs:[...document.querySelectorAll('dialog[open]')].map(e=>e.innerText)})");report.failureScreenshot=await shot('failure');}catch{}}
 finally{cdp?.ws?.close();for(const child of [...children].reverse())await stop(child);report.finished_at=new Date().toISOString();report.websocket_frame_count=frames.length;fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));if(report.status==='passed')fs.writeFileSync(path.join(OUT,'gallery.html'),'<!doctype html><meta charset="utf-8"><title>校园空间与告警验收截图</title><style>body{background:#eef2ed;color:#203b37;font:16px system-ui;margin:24px}img{width:100%;max-width:1440px}figure{margin:24px 0}figcaption{padding:12px}</style><h1>校园空间与告警验收截图</h1><p>本地独立数据验收；校园为设计示意，告警来自教学 MQTT 输入。</p>'+report.screenshots.map(file=>'<figure><figcaption>'+path.basename(file)+'</figcaption><img loading="lazy" src="'+path.basename(file)+'"></figure>').join(''));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(error=>{console.error(error);process.exitCode=1;});