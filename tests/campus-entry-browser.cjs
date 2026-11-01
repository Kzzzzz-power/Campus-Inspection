// Digital twin acceptance: real Broker -> MQTT -> API -> WebSocket -> WebGL and accessible UI.
// Bootstrap/CDP lifecycle follows realtime-e2e.cjs; kept independent so its acceptance remains unchanged.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','campus-entry','entry-'+Date.now());
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
 let cdp;
 const debugPort=await port(),base=process.env.INSPECTGO_ENTRY_BASE||'http://127.0.0.1:8016';
 async function click(selector){
  const r=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(${JSON.stringify(selector)})===e};})()`);
  assert(r.hit,'Pointer target obstructed: '+selector);
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x,y:r.y});
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:r.x,y:r.y});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:r.x,y:r.y});
 }
 async function shot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,name+'.png'),Buffer.from(r.data,'base64'));}
 async function settled(){await cdp.wait("document.querySelector('#campus-stage').dataset.transition==='idle'");}
 async function escape(){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await settled();}
 try{
  start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const target=await until(async()=>{const list=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return list.find(t=>t.type==='page');},'Chrome debug');
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.navigate',{url:base});await cdp.wait("document.querySelector('#campus-stage')?.dataset.renderer==='webgl' && document.querySelectorAll('.twin-marker').length===8");
  for(const id of ['C07','C01','C02','C03','C04','C05','C06','C08']){
   await click(`.twin-marker[data-point-id="${id}"]`);await settled();
   const state=await cdp.eval(`(()=>{const s=document.querySelector('#campus-stage'),e=document.querySelector('#twin-room-enter'),r=e.getBoundingClientRect(),v=document.querySelector('.twin-viewport').getBoundingClientRect();return{mode:s.dataset.mode,focused:s.dataset.focused,title:document.querySelector('#twin-scene-title').textContent,entryText:e.textContent,entryVisible:!e.hidden&&r.top>=v.top&&r.bottom<=Math.min(v.bottom,innerHeight),entryTop:r.top,viewportBottom:v.bottom};})()`);
   console.log(JSON.stringify({point:id,...state}));if(id==='C07')await shot('focused-C07');
   assert.equal(state.mode,'campus');assert.equal(state.focused,id);assert(state.entryVisible,'Room entry must be visible inside the 3D viewport without scrolling');
   if(id==='C01')await click(`.twin-marker[data-point-id="${id}"]`);else await click('#twin-room-enter');
   await settled();await cdp.wait(`document.querySelector('#campus-stage').dataset.interior==='true' && document.querySelector('#campus-stage').dataset.selected==='${id}'`);
   if(id==='C07'||id==='C01')await shot('entered-'+id);
   report.checks.push({name:'pointer_focus_and_enter_'+id,status:'passed'});await escape();
  }
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  for(const width of [440,390]){
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   await cdp.wait("document.querySelector('#campus-stage').dataset.viewportWidth===String(document.querySelector('.twin-viewport').clientWidth)");
   await click('.twin-marker[data-point-id="C07"]');await settled();await shot('focused-'+width);await click('#twin-room-enter');await settled();
   assert(await cdp.eval("document.querySelector('#campus-stage').dataset.interior==='true'"));report.checks.push({name:'mobile_entry_'+width,status:'passed'});await escape();
  }
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;if(cdp)try{await shot('failure');}catch{}}
 finally{cdp?.ws?.close();for(const child of children.reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
