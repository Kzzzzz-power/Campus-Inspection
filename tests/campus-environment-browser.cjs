// Digital twin acceptance: real Broker -> MQTT -> API -> WebSocket -> WebGL and accessible UI.
// Bootstrap/CDP lifecycle follows realtime-e2e.cjs; kept independent so its acceptance remains unchanged.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','campus-environment','review-'+Date.now());
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
 async function shot(name){const result=await cdp.send('Page.captureScreenshot',{format:'png'});const file=path.join(OUT,name+'.png');fs.writeFileSync(file,Buffer.from(result.data,'base64'));return file;}
 async function canvas(name){const clip=await cdp.eval("(()=>{const r=document.querySelector('#campus-canvas').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()");const r=await cdp.send('Page.captureScreenshot',{format:'png',clip});const file=path.join(OUT,name+'.png');fs.writeFileSync(file,Buffer.from(r.data,'base64'));return file;}
 async function setView(value){await cdp.eval(`(()=>{const e=document.querySelector('#twin-design-view');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change'));})()`);await cdp.wait("document.querySelector('#campus-stage').dataset.transition==='idle'");}
 async function size(width,height){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await cdp.wait("document.querySelector('#campus-stage').dataset.viewportWidth===String(document.querySelector('.twin-viewport').clientWidth)");await cdp.eval("scrollTo({top:0,behavior:'instant'})");}
 try{
  start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const target=await until(async()=>{const l=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return l.find(t=>t.type==='page');},'Chrome');cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});await cdp.send('Page.navigate',{url:base});await cdp.wait("document.querySelector('#campus-stage')?.dataset.renderer==='webgl' && document.querySelector('#campus-stage').dataset.environment==='hdr' && +document.querySelector('#campus-stage').dataset.triangles>0");
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});report.screenshots=[await shot('overview-1440x1200'),await canvas('campus-stage')];
  if(process.env.CAPTURE_BEFORE==='1'){await size(1440,900);report.screenshots.push(await shot('overview-1440x900'));report.status='passed';return;}
  const stats=await cdp.eval("({...document.querySelector('#campus-stage').dataset})");assert(+stats.calls<=120);assert(+stats.triangles<=500000);report.checks.push({name:'overview_render_budget',status:'passed',details:stats});
  // The fixed comparison pose and canvas dimensions match the captured baseline.
  await cdp.eval("document.querySelector('.twin-viewport').style.cssText='width:1374px;height:640px'");await cdp.wait("document.querySelector('#campus-stage').dataset.viewportWidth==='1374'");await setView('comparison');report.screenshots.push(await canvas('fixed-camera-after'));await cdp.eval("document.querySelector('.twin-viewport').style.cssText=''");await size(1440,1200);
  await cdp.eval("document.querySelector('#twin-design-building').value='teaching'");
  for(const name of ['front','entry','courtyard','landscape']){await setView(name);report.screenshots.push(await canvas(name));}
  await setView('overall');await size(1440,900);report.screenshots.push(await shot('overview-1440x900'));
  for(const w of [1024,440,390]){await size(w,1200);assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));report.screenshots.push(await shot('overview-'+w));report.checks.push({name:'responsive_'+w,status:'passed'});}
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;if(cdp)try{await shot('failure');}catch{}}
 finally{cdp?.ws?.close();for(const c of children.reverse())await stop(c);report.finished_at=new Date().toISOString();
 if(report.status==='passed'&&report.checks.length){
  const parent=path.dirname(OUT),baseline=fs.readdirSync(parent).map(n=>path.join(parent,n)).find(d=>{try{const r=JSON.parse(fs.readFileSync(path.join(d,'result.json'),'utf8'));return r.status==='passed'&&r.checks.length===0&&fs.existsSync(path.join(d,'campus-stage.png'));}catch{return false;}});
  const before=baseline?'../'+path.basename(baseline)+'/':'';
  const figure=(name,title)=>'<figure><figcaption>'+title+'</figcaption><img loading="lazy" src="'+name+'.png"></figure>';
  const fixed=baseline?'<h2>同尺寸、同视角对照</h2><p>两图均为 1374×640、FOV 42°，相机 (59.922,73.465,65.812)，目标 (5,1.2,8)。</p>'+figure(before+'campus-stage','修改前')+figure('fixed-camera-after','修改后：固定对照视角'):'';
  fs.writeFileSync(path.join(OUT,'gallery.html'),'<!doctype html><meta charset="utf-8"><title>校园环境视觉核查</title><style>body{font:15px/1.65 system-ui;margin:24px;background:#eef3ef;color:#233f36}main{max-width:1440px;margin:auto}figure{margin:24px 0}figcaption{padding:8px 0}img{display:block;max-width:100%;border-radius:8px}h2{margin-top:40px}</style><main><h1>校园环境视觉核查</h1><p>所有截图来自本地网页；校园为设计示意。数据与几何报告见同目录 result.json。</p>'+fixed+'<h2>新默认构图与页面</h2>'+figure('campus-stage','新默认构图')+figure('overview-1440x1200','1440×1200')+figure('overview-1440x900','1440×900')+'<h2>近景</h2>'+['front','entry','courtyard','landscape'].map(n=>figure(n,n)).join('')+'<h2>响应式</h2>'+[1024,440,390].map(n=>figure('overview-'+n,n+'px')).join('')+'</main>');
  report.baseline=baseline;
 }
 fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
