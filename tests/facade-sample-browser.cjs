const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','facade-review','run-'+Date.now());
fs.mkdirSync(OUT,{recursive:true});
const BASE=process.env.FACADE_BASE||'http://127.0.0.1:8016',PAGE=BASE+'/static/facade-sample/index.html';
const report={url:PAGE,status:'failed',checks:[],errors:[],screenshots:[],out:OUT},sleep=ms=>new Promise(r=>setTimeout(r,ms));
let chrome,ws,seq=0;const pending=new Map();
async function until(fn,label,ms=25000){const end=Date.now()+ms;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await sleep(100);}throw Error(label+' timed out '+(last||''));}
async function port(){return new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});}
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},30000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function check(name,fn){const detail=await fn();report.checks.push({name,detail});console.log('PASS '+name);}
async function click(selector){await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');}
async function shot(name){await sleep(250);const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const file=path.join(OUT,name+'.png');fs.writeFileSync(file,Buffer.from(r.data,'base64'));report.screenshots.push(file);}
async function size(width,height){await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await sleep(300);}
async function settled(){await sleep(850);}
(async()=>{
 try{
 const response=await fetch(PAGE);assert(response.ok,'preview page not reachable');
 const debug=await port(),log=fs.openSync(path.join(OUT,'chrome.log'),'a');
 chrome=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter','--user-data-dir='+path.join(OUT,'chrome-profile'),'--disk-cache-dir='+path.join(OUT,'chrome-cache'),'--remote-debugging-port='+debug,'about:blank'],{windowsHide:true,cwd:ROOT,env:{...process.env,TEMP:OUT,TMP:OUT},stdio:['ignore',log,log]});fs.closeSync(log);
 const target=await until(async()=>{const r=await fetch('http://127.0.0.1:'+debug+'/json/list');return(await r.json()).find(t=>t.type==='page');},'Chrome');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params);});
 await send('Page.enable');await send('Runtime.enable');await size(1440,1200);await send('Page.navigate',{url:PAGE});
 await until(()=>evaluate("document.querySelector('#viewer')?.dataset.ready==='true'"),'WebGL sample');
 await check('local_hdr_lighting',async()=>{
 await until(()=>evaluate("document.querySelector('#viewer').dataset.environment==='hdr'"),'HDR environment');
 return await evaluate("document.querySelector('#lighting-source').textContent");
 });

 await check('real_webgl_and_explicit_estimated_dimensions',async()=>{const state=await evaluate("({state:facadeSample.state(),dataset:{...document.querySelector('#viewer').dataset},text:document.body.innerText})");assert.equal(state.state.components,19);assert(state.text.includes('非测绘'));assert(state.text.includes('原图不是本次三维渲染结果'));assert(+state.dataset.triangles>100);assert(+state.dataset.calls<=100);return state.dataset;});
 await shot('sample-1440');
 await check('camera_presets_and_keyboard',async()=>{
 const start=await evaluate('facadeSample.state().camera');await click('[data-view="front"]');await settled();const front=await evaluate('facadeSample.state().camera');assert.notDeepEqual(front,start);await shot('sample-front');
 await click('[data-view="detail"]');await settled();await shot('sample-detail');
 await evaluate("document.querySelector('#sample-canvas').focus()");await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
 assert.equal(await evaluate("document.activeElement.id"),'sample-canvas');await click('[data-view="side"]');await settled();await shot('sample-depth');return{start,front};
 });
 await check('component_selection_focus_and_escape',async()=>{
 await evaluate("(()=>{const e=document.querySelector('#component-select');e.value='window_outer_frame';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
 assert.equal(await evaluate('facadeSample.state().selected'),'window_outer_frame');assert((await evaluate("document.querySelector('#part-evidence').innerText")).includes('未获近照'));
 await click('#focus-part');await settled();assert((await evaluate('facadeSample.state().camera'))[2]>.8);await shot('sample-picked');
 await evaluate("document.querySelector('#sample-canvas').focus()");await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});assert.equal(await evaluate('facadeSample.state().selected'),null);return'keyboard and component details';
 });
 await check('canvas_pointer_picking',async()=>{
 await click('#reset-camera');await settled();
 const r=await evaluate("(()=>{const r=document.querySelector('#sample-canvas').getBoundingClientRect();return{x:r.x+r.width*.5,y:r.y+r.height*.5};})()");
 await send('Input.dispatchMouseEvent',{type:'mousePressed',...r,button:'left',clickCount:1});
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',...r,button:'left',clickCount:1});
 const selected=await evaluate('facadeSample.state().selected');assert(selected,'canvas click must pick actual geometry');
 assert.equal(await evaluate("document.querySelector('#part-id').textContent"),selected);await click('#reset-camera');await settled();return selected;
 });

 await check('reference_dialog_closes_and_returns_focus',async()=>{
 await evaluate("document.querySelector('#show-reference').focus()");await click('#show-reference');assert(await evaluate("document.querySelector('#reference-dialog').open"));
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 assert(!(await evaluate("document.querySelector('#reference-dialog').open")));assert.equal(await evaluate('document.activeElement.id'),'show-reference');return'passed';
 });
 await check('light_and_dimension_controls',async()=>{await click('#lighting');assert(await evaluate('facadeSample.state().soft'));await click('#lighting');await click('#dimensions');assert(await evaluate("document.querySelector('#measurements').hidden"));await click('#dimensions');return'passed';});
 await check('editable_glb_and_scene_export',async()=>{
 const encoded=await evaluate("(async()=>{const b=new Uint8Array(await facadeSample.exportModel());let s='';for(let i=0;i<b.length;i+=16384)s+=String.fromCharCode(...b.subarray(i,i+16384));return btoa(s);})()");
 const bytes=Buffer.from(encoded,'base64');assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(4),2);assert.equal(bytes.readUInt32LE(8),bytes.length);
 const length=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+length).toString().trim());assert(json.nodes.some(n=>n.name==='window_outer_frame'));assert(json.nodes.some(n=>n.extras?.dimensions==='ESTIMATED_NOT_SURVEYED'));
 assert(bytes.length<20*1024*1024);const modelFile=path.join(ROOT,'frontend','facade-sample','assets','facade-bay.glb');fs.writeFileSync(modelFile,bytes);
 const editable=await evaluate('facadeSample.snapshot()');fs.writeFileSync(path.join(ROOT,'frontend','facade-sample','assets','facade-bay.three.json'),JSON.stringify(editable));
 report.model={bytes:bytes.length,nodes:json.nodes.length,meshes:json.meshes.length,materials:json.materials.length};return report.model;
 });
 await check('responsive_layouts',async()=>{const results=[];for(const [width,height]of [[1440,1200],[1024,1000],[768,1100],[440,1000],[390,844]]){await size(width,height);await click('#reset-camera');await settled();await evaluate('scrollTo(0,0)');const dimensions=await evaluate("({viewport:innerWidth,page:document.documentElement.scrollWidth,canvas:document.querySelector('#sample-canvas').getBoundingClientRect().width,calls:+document.querySelector('#viewer').dataset.calls,triangles:+document.querySelector('#viewer').dataset.triangles})");assert(dimensions.page<=width+1,JSON.stringify(dimensions));assert(dimensions.calls<=100);results.push(dimensions);await shot('sample-'+width);}return results;});
 await check('reduced_motion_presets',async()=>{await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await click('[data-view="front"]');const p=await evaluate('facadeSample.state().camera');assert(Math.abs(p[0])<.001);return p;});
 await check('offscreen_render_pause',async()=>{await size(440,700);await evaluate("document.querySelector('.sample-footer').scrollIntoView()");await sleep(200);const before=await evaluate('facadeSample.state()');await sleep(600);const after=await evaluate('facadeSample.state()');assert.equal(after.visible,false);assert.equal(after.frames,before.frames);await evaluate('scrollTo(0,0)');return{before:before.frames,after:after.frames};});
 await check('context_loss_and_restore',async()=>{await evaluate("window.sampleGL=document.querySelector('#sample-canvas').getContext('webgl2');window.sampleLoss=sampleGL.getExtension('WEBGL_lose_context');sampleLoss.loseContext()");await until(()=>evaluate('facadeSample.state().lost'),'lost');await evaluate('sampleLoss.restoreContext()');await until(()=>evaluate("document.querySelector('#viewer').dataset.context==='restored'&&!facadeSample.state().lost"),'restore');return'recovered';});
 await check('hdr_failure_has_usable_fallback',async()=>{
 await send('Network.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});
 await send('Network.setBlockedURLs',{urls:['*kloofendal-sky-1k.hdr*']});
 await send('Page.reload',{ignoreCache:true});
 await until(()=>evaluate("document.querySelector('#viewer')?.dataset.environment==='fallback'"),'procedural fallback');
 assert(await evaluate("document.querySelector('#viewer').dataset.ready==='true'"));
 await evaluate("facadeSample.select('window_outer_frame')");assert.equal(await evaluate('facadeSample.state().selected'),'window_outer_frame');
 await send('Network.setBlockedURLs',{urls:[]});await send('Page.reload',{ignoreCache:true});
 await until(()=>evaluate("document.querySelector('#viewer')?.dataset.environment==='hdr'"),'HDR recovery');
 return'fallback is labelled; geometry selection remains available; HDR reload succeeds';
 });

 await check('original_workbench_remains_accessible',async()=>{const main=await fetch(BASE+'/');assert(main.ok);const text=await main.text();assert(text.includes('detail-dialog'));const dashboard=await(await fetch(BASE+'/api/dashboard')).json();assert.equal(dashboard.points.length,8);return{points:dashboard.points.length,detailDialog:true};});
 assert.equal(report.errors.length,0,JSON.stringify(report.errors));report.status='passed';
 }catch(error){report.error=String(error.stack||error);console.error(report.error);}
 finally{
 if(ws)ws.close();if(chrome?.pid)spawnSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
 fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks.length,out:OUT,error:report.error}));if(report.status!=='passed')process.exitCode=1;
 }
})();