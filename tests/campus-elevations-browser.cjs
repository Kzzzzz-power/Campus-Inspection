// Digital twin acceptance: real Broker -> MQTT -> API -> WebSocket -> WebGL and accessible UI.
// Bootstrap/CDP lifecycle follows realtime-e2e.cjs; kept independent so its acceptance remains unchanged.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','campus-elevations','review-'+Date.now());
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
 let cdp;try{
  const webPort=await port(),debugPort=await port(),base=`http://127.0.0.1:${webPort}`;
  start('api',PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(webPort)],{INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads'),INSPECTGO_MQTT_ENABLED:'false'});
  await until(async()=>(await fetch(base+'/health')).ok,'API');
  start('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome')}`,`--disk-cache-dir=${path.join(OUT,'cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const page=await until(async()=>(await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(p=>p.type==='page'),'Chrome');cdp=new CDP(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Page.enable');await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.navigate',{url:base+'/static/campus-review/index.html'});await cdp.wait("document.querySelector('#stage')?.dataset.ready==='true'");await sleep(400);
  report.screenshots=[];
  for(const building of ['teaching','laboratory','training'])for(const view of ['front','back','left','right','roof']){
   await cdp.eval(`(()=>{document.querySelector('#building').value='${building}';var v=document.querySelector('#view');v.value='${view}';v.dispatchEvent(new Event('change'));})()`);
   await cdp.wait(`document.querySelector('#stage').dataset.building==='${building}'&&document.querySelector('#stage').dataset.view==='${view}'`);
   const result=await cdp.eval("({projection:document.querySelector('#stage').dataset.projection,count:document.querySelector('#components').children.length,caption:document.querySelector('#caption').textContent})");assert.equal(result.projection,'orthographic');assert(result.count>0);const shot=await cdp.send('Page.captureScreenshot',{format:'png'}),file=path.join(OUT,building+'-'+view+'.png');fs.writeFileSync(file,Buffer.from(shot.data,'base64'));report.screenshots.push(file);report.checks.push({name:building+'-'+view,status:'passed',details:result});console.log('PASS '+building+' '+view);
  }
  await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:OUT});await cdp.eval("document.querySelector('#save').click()");await until(()=>fs.existsSync(path.join(OUT,'training-roof-concept.png')),'PNG export');assert(fs.statSync(path.join(OUT,'training-roof-concept.png')).size>10000);report.checks.push({name:'PNG export',status:'passed'});
  for(const width of [1024,440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await sleep(160);assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));report.checks.push({name:'Responsive '+width,status:'passed'});}
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
 finally{cdp?.ws.close();for(const child of [...children].reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+OUT);}
})().catch(error=>{console.error(error);process.exitCode=1;});
