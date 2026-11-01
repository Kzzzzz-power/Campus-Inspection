// Digital twin acceptance: real Broker -> MQTT -> API -> WebSocket -> WebGL and accessible UI.
// Bootstrap/CDP lifecycle follows realtime-e2e.cjs; kept independent so its acceptance remains unchanged.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','twin-browser','browser-'+Date.now());
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
   const result=await cdp.eval(`(()=>{const canvas=document.querySelector('#campus-canvas'),gl=canvas.getContext('webgl2')||canvas.getContext('webgl');return{stage:{...document.querySelector('#campus-stage').dataset},webgl:!!gl,contextLost:gl?.isContextLost(),films:[...document.querySelectorAll('button.twin-film')].map(e=>{const r=e.getBoundingClientRect();return{id:e.dataset.pointId,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};}),markers:[...document.querySelectorAll('button.twin-marker')].map(e=>({id:e.dataset.pointId,quality:e.dataset.quality,alarm:e.dataset.alarm})),height:innerHeight};})()`);
   assert(result.webgl&&!result.contextLost);assert.equal(result.stage.asset,'meshopt');assert(Number(result.stage.assetBytes)<20*1024*1024);assert.equal(result.stage.mode,'campus');assert.equal(result.films.length,8);assert.equal(new Set(result.films.map(p=>p.id)).size,8);
   assert(result.films.every(p=>p.width>0&&p.height>0&&p.x>=0&&p.right<=1441&&p.y>=0&&p.bottom<=1200),JSON.stringify(result.films));
   assert(result.markers.every(m=>m.alarm==='unknown'),'No initial observations must remain unknown');
   assert(Number(result.stage.calls)>0 && Number(result.stage.calls)<=120,`Campus draw calls including shadow passes: ${result.stage.calls}`);assert(Number(result.stage.triangles)<=500000,`Rendered triangles including shadow passes: ${result.stage.triangles}`);result.markerLayout=await markerLayout();report.screenshots=[await shot('campus-1440')];return result;
  });
  let c07Scene,c01Scene;
  await check('point_selection_distinct_scene_and_return_path',async()=>{
   await point('C07','.twin-marker');c07Scene=(await stage()).scene;
   assert(await cdp.eval("document.querySelector('#twin-scene-title').textContent.includes('C07') && document.querySelector('#twin-inspector').textContent.includes('switch-301')"));
   const c07Image=await canvasShot();report.screenshots.push(await shot('point-C07'));
   await click('#twin-enter');await cdp.wait("document.querySelector('#detail-dialog').open && document.querySelector('#detail-title').textContent.includes('C07')");
   await key('Escape');await cdp.wait("!document.querySelector('#detail-dialog').open");assert.equal((await stage()).mode,'point','First Escape closes modal, not point scene');
   await key('Escape');await cdp.wait("document.querySelector('#campus-stage').dataset.mode==='campus'");
   await point('C01');c01Scene=(await stage()).scene;
   assert(await cdp.eval("document.querySelector('#twin-inspector').textContent.includes('lighting-201')"));assert(c07Scene&&c01Scene);assert.notEqual(c07Scene,c01Scene,'Point archetypes must differ');assert.notEqual(await canvasShot(),c07Image,'Point scenes must actually render differently');
   report.screenshots.push(await shot('point-C01'));await point('C08');assert(await cdp.eval("document.querySelector('#twin-inspector').textContent.includes('hvac-301')"));report.screenshots.push(await shot('point-C08'));await campus();return{C07:c07Scene,C01:c01Scene};
  });
  await check('inspector_can_collapse_without_losing_point_or_keyboard_focus',async()=>{
   await point('C07');
   await click('.twin-inspector-toggle');
   assert(await cdp.eval("document.querySelector('#twin-inspector dl').hidden && document.activeElement.matches('.twin-inspector-toggle')"));
   assert.equal((await stage()).selected,'C07');
   await key('Enter');
   assert(await cdp.eval("!document.querySelector('#twin-inspector dl').hidden && document.querySelector('#twin-inspector').textContent.includes('switch-301')"));
   await campus();return{collapsed:true,expandedWithKeyboard:true,identity:'C07 / switch-301'};
  });
  const coverageBefore=await api('/api/dashboard');
  await check('enclosed_room_walk_reset_rapid_switch_and_keyboard',async()=>{
   await point('C07');assert.equal((await stage()).interior,'true');
   const before=(await stage()).camera;assert(await cdp.eval("!document.querySelector('.twin-room-tools').hidden"));
   await click('[data-room-action="forward"]');await cdp.wait(`document.querySelector('#campus-stage').dataset.camera!==${JSON.stringify(before)}`);await sleep(500);
   const moved=(await stage()).camera;assert.notEqual(moved,before);assert.equal(moved.split(',')[1],before.split(',')[1],'Eye height must remain stable');
   await click('[data-view-action="reset"]');await cdp.wait(`document.querySelector('#campus-stage').dataset.camera===${JSON.stringify(before)}`);
   await cdp.eval("document.querySelector('.twin-viewport').focus()");await key('ArrowUp');await cdp.wait(`document.querySelector('#campus-stage').dataset.camera!==${JSON.stringify(before)}`);
   await click('[data-view-action="reset"]');await point('C01');assert.equal((await stage()).interior,'true');
   await click('.twin-film[data-point-id="C07"]');await click('.twin-film[data-point-id="C01"]');await click('.twin-film[data-point-id="C07"]');
   await cdp.wait("document.querySelector('#campus-stage').dataset.selected==='C07' && document.querySelector('#campus-stage').dataset.transition==='idle'");
   assert(await cdp.eval("document.querySelector('#twin-inspector').textContent.includes('switch-301')"));await campus();
   return {before,moved,finalPoint:'C07',eyeHeight:'stable'};
  });
  await check('room_canvas_drag_and_floor_click_move_the_actual_camera',async()=>{
   await point('C07');const pose=(await stage()).camera,imageBefore=await canvasShot();
   const r=await cdp.eval("(()=>{const r=document.querySelector('#campus-canvas').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};})()");
   const x=r.x+r.w*.38,y=r.y+r.h*.42;
   await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
   await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
   await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+70,y:y+15,button:'left',buttons:1});
   await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+70,y:y+15,button:'left',buttons:0,clickCount:1});
   await sleep(180);assert.equal((await stage()).camera,pose,'Looking must not change eye position');assert.notEqual(await canvasShot(),imageBefore,'Dragging must visibly change view direction');
   await click('[data-view-action="reset"]');await sleep(100);
   const gx=r.x+r.w*.5,gy=r.y+r.h*.79;
   await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:gx,y:gy,button:'left',buttons:1,clickCount:1});
   await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:gx,y:gy,button:'left',buttons:0,clickCount:1});
   await cdp.wait(`document.querySelector('#campus-stage').dataset.camera!==${JSON.stringify(pose)}`);
   assert.equal((await stage()).camera.split(',')[1],pose.split(',')[1]);await campus();return{drag:'view changed',floorClick:'walked',eyeHeight:'stable'};
  });
  await check('camera_transition_cannot_be_cancelled_by_zoom_and_return_keeps_overview',async()=>{
   const overview=(await stage()).camera;
   await click('.twin-film[data-point-id="C07"]');
   assert(await cdp.eval("document.querySelector('[data-view-action=\"zoom-in\"]').disabled"));
   await click('[data-view-action="zoom-in"]');
   await cdp.wait("document.querySelector('#campus-stage').dataset.interior==='true' && document.querySelector('#campus-stage').dataset.transition==='idle'");
   await click('#twin-back');await click('.twin-film[data-point-id="C01"]');
   await cdp.wait("document.querySelector('#campus-stage').dataset.selected==='C01' && document.querySelector('#campus-stage').dataset.transition==='idle'");
   await campus();assert.equal((await stage()).camera,overview,'Returning during a flight must restore the original overview');
   return{overview,returned:(await stage()).camera};
  });

  await check('all_eight_designed_interiors_keep_real_point_identity',async()=>{
   const result=[];await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   for(const id of ['C01','C02','C03','C04','C05','C06','C07','C08']){
    await point(id);assert.equal((await stage()).interior,'true');
    await click('#twin-enter');await cdp.wait(`document.querySelector('#detail-dialog').open && document.querySelector('#detail-title').textContent.includes('${id}')`);
    await key('Escape');await cdp.wait("!document.querySelector('#detail-dialog').open");await sleep(120);
    report.screenshots.push(await shot('designed-'+id));result.push({id,scene:(await stage()).scene,calls:(await stage()).calls,triangles:(await stage()).triangles});
   }
   await campus();await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});return result;
  });
  await check('roof_window_fan_and_language_are_visual_controls_only',async()=>{
   const before=await api('/api/dashboard');await point('C06');
   await cdp.eval("document.querySelector('.twin-design-tools').open=true");
   await click('#twin-design-window');assert.equal(await cdp.eval("document.querySelector('#twin-design-window').getAttribute('aria-pressed')"),'true');
   await click('#twin-design-roof');await cdp.wait("document.querySelector('#campus-stage').dataset.transition==='idle' && document.querySelector('#campus-stage').dataset.interior==='false'");
   await cdp.eval("document.querySelector('.twin-design-tools').open=false");report.screenshots.push(await shot('room-roof-revealed'));
   await cdp.eval("document.querySelector('.twin-design-tools').open=true");await click('#twin-design-roof');await cdp.wait("document.querySelector('#campus-stage').dataset.transition==='idle' && document.querySelector('#campus-stage').dataset.interior==='true'");
   await click('#twin-design-fan');assert.equal(await cdp.eval("document.querySelector('#twin-design-fan').getAttribute('aria-pressed')"),'true');
   await cdp.eval("document.querySelector('.twin-design-tools').open=false");await sleep(250);const spinning=await canvasShot();await sleep(250);assert((await canvasShot())!==spinning,'Fan must visibly rotate');
   await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await cdp.wait("matchMedia('(prefers-reduced-motion: reduce)').matches");await sleep(300);const still=(await stage()).fanAngle;await sleep(400);assert.equal((await stage()).fanAngle,still,'Reduced motion must stop illustrative fan');
   await cdp.eval("document.querySelector('.twin-design-tools').open=true;var s=document.querySelector('#twin-design-language');s.value='en';s.dispatchEvent(new Event('change'))");assert(await cdp.eval("document.querySelector('.twin-design-tools summary').textContent.includes('Concept')"));
   await cdp.eval("var s=document.querySelector('#twin-design-language');s.value='zh';s.dispatchEvent(new Event('change'));document.querySelector('.twin-design-tools').open=false");
   await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await campus();
   const after=await api('/api/dashboard');assert.deepEqual(after.points.map(p=>[p.point_id,p.covered]),before.points.map(p=>[p.point_id,p.covered]));return{roof:'revealed and closed',window:'opened',fan:'rotates; reduced motion pauses',coverage:'unchanged'};
  });
  await check('building_elevations_roof_near_views_and_component_pick',async()=>{
   await cdp.wait("document.querySelector('#campus-stage').dataset.environment==='hdr'");
   await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   const views=[];
   for(const building of ['teaching','laboratory','training'])for(const view of ['front','back','left','right','roof']){
    await cdp.eval(`(()=>{document.querySelector('.twin-design-tools').open=true;const b=document.querySelector('#twin-design-building'),v=document.querySelector('#twin-design-view');b.value='${building}';v.value='${view}';v.dispatchEvent(new Event('change'));document.querySelector('.twin-design-tools').open=false;})()`);await sleep(140);
    const state=await stage();assert(state.camera.split(',').map(Number).every(Number.isFinite));report.screenshots.push(await shot(building+'-'+view));views.push({building,view,camera:state.camera});
   }
   await cdp.eval("document.querySelector('#twin-design-building').value='teaching';var v=document.querySelector('#twin-design-view');v.value='entry';v.dispatchEvent(new Event('change'))");await sleep(150);report.screenshots.push(await shot('teaching-entry'));
   const box=await cdp.eval("(()=>{const r=document.querySelector('#campus-canvas').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()");
   for(const [px,py]of [[.48,.48],[.5,.55],[.55,.45],[.4,.5]]){
    const x=box.x+box.w*px,y=box.y+box.h*py;await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});if((await stage()).component)break;
   }
   assert((await stage()).component,'Canvas hit must identify a named component');report.screenshots.push(await shot('component-pick'));
   await cdp.eval("var v=document.querySelector('#twin-design-view');v.value='overall';v.dispatchEvent(new Event('change'))");await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});return views;
  });
  await check('editable_campus_glb_exports_named_parts_under_asset_budget',async()=>{
   await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:OUT});await cdp.eval("document.querySelector('.twin-design-tools').open=true");await click('#twin-design-export');
   const file=path.join(OUT,'campus-design-estimated.glb');await until(()=>fs.existsSync(file),'GLB download',30000);
   const bytes=fs.readFileSync(file);assert.equal(bytes.toString('ascii',0,4),'glTF');assert.equal(bytes.readUInt32LE(8),bytes.length);assert(bytes.length<40*1024*1024);
   const length=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+length).toString());assert(json.nodes.some(n=>n.name?.startsWith('window_teaching')));assert(json.nodes.some(n=>n.name==='roof_laboratory'));
   await cdp.eval("document.querySelector('.twin-design-tools').open=false");return{file,bytes:bytes.length,nodes:json.nodes.length};
  });

  await check('eight_distinct_rooms_operable_doors_and_exit',async()=>{
   const results=[];
   for(const id of ['C01','C02','C03','C04','C05','C06','C07','C08']){
    await point(id);await click('[data-room-action="door"]');await cdp.wait("document.querySelector('#campus-stage').dataset.doorOpen==='true'");await sleep(450);
    if(id==='C05'){await click('[data-room-action="portal"]');await cdp.wait("document.querySelector('#campus-stage').dataset.portalOpen==='true'");await sleep(450);}
    report.screenshots.push(await shot('room-'+id));results.push({id,scene:(await stage()).scene,door:(await stage()).doorOpen});
    await click('[data-room-action="exit"]');await cdp.wait("document.querySelector('#campus-stage').dataset.mode==='campus' && document.querySelector('#campus-stage').dataset.transition==='idle'");
   }
   return results;
  });
  const pointBefore=await api('/api/points/C07');
  await check('real_mqtt_warning_87_reaches_websocket_twin_inspector_and_list',async()=>{
   sim=simStart();await until(async()=>(await current()).facilities.every(f=>f.freshness==='fresh'),'eight fresh MQTT observations');
   await point('C07');change('WARNING',87);
   await until(async()=>item(await current()).observation?.metrics.latency_ms===87,'API warning 87');
   await cdp.wait(`document.querySelector(${JSON.stringify(marker)}).dataset.quality==='live' && document.querySelector(${JSON.stringify(marker)}).dataset.alarm==='true'`);
   await cdp.wait("document.querySelector('#twin-inspector').textContent.includes('87') && document.querySelector('[data-point=\"C07\"]').textContent.includes('87')");
   assert(frames.some(s=>item(s)?.observation?.metrics.latency_ms===87),'Actual WebSocket frames must contain 87');
   await cdp.wait("document.querySelector('#twin-hud').textContent.includes('新鲜 8') && document.querySelector('#twin-hud').textContent.includes('当前告警 1')");
   await cdp.wait("document.querySelector('#twin-quality').textContent.includes('WebSocket 推送')");const snapshot=await current();report.screenshots.push(await shot('live-warning-87'));await campus();report.screenshots.push(await shot('live-campus'));await point('C07');return{observation:item(snapshot).observation,marker:await cdp.eval(`({...document.querySelector(${JSON.stringify(marker)}).dataset})`),hud:await cdp.eval("document.querySelector('#twin-hud').innerText")};
  });
  await check('remote_changes_preserve_coverage_and_no_records_are_fabricated',async()=>{
   await cdp.wait("!document.querySelector('.twin-alert-popup').hidden && document.querySelector('.twin-alert-popup').dataset.pointId==='C07'");
   await click('.twin-alert-actions button:last-child');await sleep(2300);assert(await cdp.eval("document.querySelector('.twin-alert-popup').hidden"),'Same alarm timestamp refresh must not repeat popup');
   const after=await api('/api/dashboard'),detail=await api('/api/points/C07');
   assert.equal(after.covered,coverageBefore.covered);assert.deepEqual(after.missing,coverageBefore.missing);
   assert.deepEqual(after.points.map(p=>[p.point_id,p.covered]),coverageBefore.points.map(p=>[p.point_id,p.covered]));
   assert.deepEqual(detail.records,pointBefore.records);assert.deepEqual(detail.reviews,pointBefore.reviews);
   return{covered:after.covered,records:detail.records.length,reviews:detail.reviews.length};
  });
  await check('keyboard_selection_live_focus_and_unsaved_draft_survive',async()=>{
   await campus();await cdp.eval(`document.querySelector(${JSON.stringify(film)}).focus({preventScroll:true})`);await key('Enter');await cdp.wait("document.querySelector('#campus-stage').dataset.selected==='C07'");
   await cdp.eval(`document.querySelector(${JSON.stringify(film)}).focus({preventScroll:true});window.__focusBefore=document.activeElement`);change('NORMAL',31);
   await cdp.wait("document.querySelector('#twin-inspector').textContent.includes('31')");assert.equal(await cdp.eval('document.activeElement===window.__focusBefore'),true,'Live sync must not replace keyboard target');
   await click('[data-point="C07"] .point-actions button:last-child');await cdp.wait("document.querySelector('#detail-dialog textarea[name=notes]')");
   await cdp.eval("(()=>{const t=document.querySelector('#detail-dialog textarea[name=notes]');t.value='数字孪生验收草稿，尚未提交';t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();})()");
   change('WARNING',87);await cdp.wait("document.querySelector('#detail-realtime-meta').textContent.includes('87')");
   assert.equal(await cdp.eval("document.querySelector('#detail-dialog textarea[name=notes]').value"),'数字孪生验收草稿，尚未提交');assert.equal(await cdp.eval('document.activeElement.name'),'notes');
   await cdp.eval('window.confirm=()=>true');await key('Escape');await cdp.wait("!document.querySelector('#detail-dialog').open");assert.equal((await stage()).mode,'point');
   return{draftPreserved:true,focusPreserved:true};
  });
  await check('stopped_publisher_stale_is_unknown_with_last_known_warning_then_recovers',async()=>{
   await until(async()=>{const f=item(await current());return f.observation?.condition==='WARNING'&&f.observation?.metrics.latency_ms===87;},'latest warning before publisher stop');
   await stop(sim);await until(async()=>item(await current()).freshness==='stale','stale publisher',18000);
   await cdp.wait(`document.querySelector(${JSON.stringify(marker)}).dataset.quality==='stale'`);
   const remote=item(await current());assert.equal(remote.observation.condition,'WARNING');assert.equal(await cdp.eval(`document.querySelector(${JSON.stringify(marker)}).dataset.alarm`),'unknown');
   assert(await cdp.eval("/过期|陈旧/.test(document.querySelector('#twin-inspector').textContent)"));
   assert(await cdp.eval("document.querySelector('#twin-inspector').textContent.includes('87')"),'Stale inspector retains last known observation');
   assert(await cdp.eval("document.querySelector('[data-point=\"C07\"]').textContent.includes('状态未知')"));
   await cdp.wait("document.querySelector('#twin-hud').textContent.includes('新鲜 0') && document.querySelector('#twin-hud').textContent.includes('过期 8') && document.querySelector('#twin-hud').textContent.includes('当前告警 0')");report.screenshots.push(await shot('stale-last-known'));
   sim=simStart();await cdp.wait(`document.querySelector(${JSON.stringify(marker)}).dataset.quality==='live' && document.querySelector(${JSON.stringify(marker)}).dataset.alarm==='true'`);
   return{lastKnown:remote.observation.condition,staleAlarm:'unknown',recovered:true};
  });
  await check('three_semantic_layers_are_accessible',async()=>{
   const states=[];
   for(const layer of ['remote','coverage','review']){await click('button[data-twin-layer="'+layer+'"]');const result=await cdp.eval("({layer:document.querySelector('#campus-stage').dataset.layer,selected:[...document.querySelectorAll('button[data-twin-layer][aria-pressed=true]')].map(e=>e.dataset.twinLayer),legend:document.querySelector('#twin-legend').textContent})");assert.equal(result.layer,layer);assert.deepEqual(result.selected,[layer]);assert(result.legend);states.push(result);}await click('button[data-twin-layer="remote"]');
   return states;
  });
  await check('five_viewport_widths_without_horizontal_overflow',async()=>{
   await campus();const dimensions=[];
   for(const width of [1440,1024,768,440,390]){await size(width,width>=768?1200:900);await cdp.eval("scrollTo({top:0,behavior:'instant'})");const d=await cdp.eval("({width:innerWidth,scroll:document.documentElement.scrollWidth,films:document.querySelectorAll('button.twin-film').length,stage:{...document.querySelector('#campus-stage').dataset}})");assert(d.scroll<=width+1,JSON.stringify(d));assert.equal(d.films,8);dimensions.push(d);await markerLayout();if(width===440)report.screenshots.push(await shot('campus-440'));await point('C07');assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));await campus();}
   return dimensions;
  });
  await check('reduced_motion_point_state_changes_immediately',async()=>{
   await size(1440);await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   const result=await cdp.eval(`(()=>{const t=performance.now();document.querySelector(${JSON.stringify(film)}).click();return{elapsed:performance.now()-t,mode:document.querySelector('#campus-stage').dataset.mode,selected:document.querySelector('#campus-stage').dataset.selected,transition:document.querySelector('#campus-stage').dataset.transition};})()`);
   assert.equal(result.mode,'point');assert.equal(result.selected,'C07');assert.notEqual(result.transition,'flying');await campus();await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});return result;
  });
  await check('mobile_starts_lightweight_and_can_enable_real_3d',async()=>{
   await size(440,900);await navigate();await cdp.wait("document.querySelector('#campus-stage').dataset.renderer==='fallback' && document.querySelectorAll('button.twin-film').length===8");
   assert(await cdp.eval("!document.querySelector('#twin-enable-3d').hidden && !document.querySelector('#twin-enable-3d').disabled"));const layout=await markerLayout();report.screenshots.push(await shot('mobile-lightweight-440'));
   await click('#twin-enable-3d');await cdp.wait("document.querySelector('#campus-stage').dataset.renderer==='webgl' && +document.querySelector('#campus-stage').dataset.triangles>0");await point('C07');assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));await campus();await size(1440);return{initial:'fallback',enabled:'webgl',markerLayout:layout};
  });
  await check('existing_webgl_context_loss_preserves_fallback_navigation',async()=>{
   const result=await cdp.eval("(()=>{const canvas=document.querySelector('#campus-canvas'),gl=canvas.getContext('webgl2')||canvas.getContext('webgl'),extension=gl.getExtension('WEBGL_lose_context');if(!extension)throw Error('WEBGL_lose_context missing');window.__contextExtension=extension;extension.loseContext();return{extension:true};})()");
   await cdp.wait("document.querySelector('#campus-stage').dataset.renderer==='fallback'");report.screenshots.push(await shot('webgl-context-lost'));
   await point('C07');await click('#twin-enter');await cdp.wait("document.querySelector('#detail-dialog').open && document.querySelector('#detail-title').textContent.includes('C07')");await key('Escape');assert.equal((await stage()).mode,'point');
   await cdp.eval('window.__contextExtension.restoreContext()');
   await cdp.wait("document.querySelector('#campus-stage').dataset.renderer==='webgl' && document.querySelector('#campus-stage').dataset.interior==='true' && document.querySelector('#campus-stage').dataset.transition==='idle'");
   assert(await cdp.eval("!document.querySelector('.twin-room-tools').hidden"));
   report.screenshots.push(await shot('webgl-restored-room'));
   const pose=(await stage()).camera;await click('[data-room-action="forward"]');
   await cdp.wait(`document.querySelector('#campus-stage').dataset.camera!==${JSON.stringify(pose)}`);
   await campus();return{...result,restored:true,roomMovementRestored:true};
  });
  await check('unavailable_webgl_falls_back_with_real_point_navigation',async()=>{
   const injection=await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:"(()=>{const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /webgl/.test(type)?null:get.call(this,type,...args);};})()"});
   await navigate();await cdp.wait("document.querySelector('#campus-stage').dataset.renderer==='fallback' && document.querySelectorAll('button.twin-film').length===8");await point('C07');await click('#twin-enter');await cdp.wait("document.querySelector('#detail-dialog').open && document.querySelector('#detail-title').textContent.includes('C07')");await key('Escape');assert.equal((await stage()).mode,'point');
   report.screenshots.push(await shot('webgl-fallback'));await cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:injection.identifier});return{renderer:'fallback',detailPoint:'C07'};
  });
  await check('three_asset_load_failure_keeps_business_app_and_fallback',async()=>{
   await cdp.send('Network.setBlockedURLs',{urls:['*/vendor/three/*']});
   await navigate();await cdp.wait("document.querySelectorAll('.point-card[data-point]').length===8 && document.querySelector('#campus-stage').dataset.renderer==='fallback'");
   await point('C07');await click('#twin-enter');await cdp.wait("document.querySelector('#detail-dialog').open && document.querySelector('#detail-title').textContent.includes('C07')");
   await key('Escape');await cdp.send('Network.setBlockedURLs',{urls:[]});return{businessCards:8,fallback:'usable',point:'C07'};
  });
  await check('glb_load_failure_uses_same_concept_generator_without_breaking_business',async()=>{
   await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Network.setBlockedURLs',{urls:['*campus-design.meshopt.glb']});
   await navigate();await cdp.wait("document.querySelector('#campus-stage').dataset.renderer==='webgl' && document.querySelector('#campus-stage').dataset.asset==='procedural-fallback'");
   await point('C01');await click('#twin-enter');await cdp.wait("document.querySelector('#detail-dialog').open && document.querySelector('#detail-title').textContent.includes('C01')");await key('Escape');
   await cdp.send('Network.setBlockedURLs',{urls:[]});return{fallback:'procedural model',businessDetail:'C01'};
  });
  await check('empty_dashboard_never_invents_markers_or_films',async()=>{
   const injection=await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:"(()=>{const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]).includes('/api/dashboard')){const data=await r.json();return new Response(JSON.stringify({...data,points:[],missing:[],covered:0,required_total:0}),{status:200,headers:{'Content-Type':'application/json'}});}return r;};})()"});
   await navigate();await cdp.wait("document.querySelector('#connection-status').textContent.includes('已连接')");await sleep(500);
   const data=await cdp.eval("({markers:document.querySelectorAll('button.twin-marker').length,films:document.querySelectorAll('button.twin-film').length,cards:document.querySelectorAll('.point-card').length,text:document.querySelector('#campus-stage').textContent})");assert.equal(data.markers,0);assert.equal(data.films,0);assert.equal(data.cards,0);assert(!/C0[1-8]/.test(data.text),'Empty dashboard must not fabricate configured point labels');await cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:injection.identifier});return data;
  });
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(error){report.failed_check=currentCheck;report.error=error.stack;console.error(error.stack);process.exitCode=1;try{report.failureDom=await cdp.eval("({stage:document.querySelector('#campus-stage')?.outerHTML,dialogs:[...document.querySelectorAll('dialog[open]')].map(e=>e.innerText)})");report.failureScreenshot=await shot('failure');}catch{}}
 finally{cdp?.ws?.close();for(const child of [...children].reverse())await stop(child);report.finished_at=new Date().toISOString();report.websocket_frame_count=frames.length;fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(error=>{console.error(error);process.exitCode=1;});