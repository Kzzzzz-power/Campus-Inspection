// Integrated 3D workbench acceptance: real API persistence, point actions, dialogs and keyboard navigation.
// MQTT is disabled here; dedicated twin-browser.cjs covers the real-time chain.
// Every process and file is owned by this isolated run, never the live database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','campus-workbench','flow-'+Date.now());
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
 async function board(id){await click('.board-nav [data-board="'+id+'"]');await cdp.wait('document.body.dataset.board==='+JSON.stringify(id));await sleep(250);}
 async function click(selector){
  const destinations={'#campus-tasks-open':'tasks','#evidence-browser-open':'evidence','#review-list-open':'evidence','#all-runs-btn':'evidence'};
  if(destinations[selector]&&await cdp.eval('document.body.dataset.board')!==destinations[selector])await board(destinations[selector]);
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);
  const r=await until(async()=>{await cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);await sleep(80);const hit=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(${JSON.stringify(selector)})===e};})()`);return hit.hit?hit:null;},'Pointer target unobstructed: '+selector,5000);
  assert(r.hit,'Pointer target obstructed: '+selector);
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:r.x,y:r.y});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:r.x,y:r.y});
 }
 async function set(selector,value){await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
 async function key(value,code=value,n=27){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:value,code,windowsVirtualKeyCode:n});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:value,code,windowsVirtualKeyCode:n});}
 async function shot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,name+'.png'),Buffer.from(r.data,'base64'));}
 const api=async path=>(await fetch(base+path)).json();
 async function settled(){await cdp.wait("document.querySelector('#campus-stage').dataset.transition!=='flying'");}
 let original,originalData,reviewId,newRun;
 try{
  start('api',PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(webPort)],{INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads'),INSPECTGO_MQTT_ENABLED:'false'});
  await until(async()=>(await fetch(base+'/health')).ok,'API');
  start('chrome',process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(OUT,'chrome-profile')}`,`--disk-cache-dir=${path.join(OUT,'chrome-cache')}`,`--remote-debugging-port=${debugPort}`,'about:blank']);
  const page=await until(async()=>{const list=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return list.find(t=>t.type==='page');},'Chrome');
  cdp=new CDP(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.navigate',{url:base});await cdp.wait("document.querySelector('#campus-stage')?.dataset.renderer==='webgl' && document.querySelectorAll('.twin-marker').length===8");await settled();await shot('overview');
  await check('business_entries_live_in_five_boards',async()=>{
   await cdp.wait("document.querySelectorAll('#board-overview .board-task-strip .campus-task-state').length===5");
   assert(await cdp.eval("[...document.querySelectorAll('.campus-task-state')].every(e=>e.textContent.includes('尚未生成判断'))"));
   assert(await cdp.eval("!!document.querySelector('#board-tasks #campus-tasks-open')"),'Tasks Board is missing its task/round entry');
   for(const id of ['evidence-browser-open','review-list-open','all-runs-btn'])assert(await cdp.eval(`!!document.querySelector('#board-evidence #${id}')`),id+' must be inside the evidence Board');
   await click('#campus-tasks-open');await cdp.wait("document.querySelector('#campus-task-dialog').open");
   await key('Escape');assert.equal(await cdp.eval('document.activeElement.id'),'campus-tasks-open');
  });
  await check('s3_run_and_three_plans_are_available_over_3d',async()=>{
   await click('#campus-tasks-open');await set('#judgment-scenario','S3');await click('#prepare-s1');await cdp.wait("document.querySelector('#judgment-status').textContent.includes('S3 教学实例已保存')");
   await click('#campus-generate-run');await cdp.wait("document.querySelector('#run-dialog').open && document.querySelectorAll('#run-body [data-plan]').length===3");
   original=await cdp.eval("document.querySelector('#run-body .run-id').textContent");originalData=await api('/api/runs/'+original);
   assert.equal(originalData.task_results.find(t=>t.task_id==='T1').state,'blocked');assert.deepEqual(originalData.plan_results.map(p=>p.state),['executable','not_executable','not_executable']);
   assert.equal(await cdp.eval("document.querySelector('#campus-run-context').dataset.runId"),original);await shot('s3-run');
   await click('#run-body [data-run-baseline]');await key('Escape');
   await click('#campus-task-dialog .planning-controls summary');await set('#planning-minutes','15');await click('#campus-generate-run');
   await cdp.wait(`document.querySelector('#run-dialog').open && document.querySelector('#run-body .run-id').textContent!==${JSON.stringify(original)}`);
   const current=await api('/api/runs/'+await cdp.eval("document.querySelector('#run-body .run-id').textContent"));assert(current.plan_results.every(p=>p.state==='not_executable'));assert.deepEqual(await api('/api/runs/'+original),originalData);
   await key('Escape');await cdp.eval("document.querySelector('#planning-comparison').scrollIntoView({block:'center'})");await shot('plans-comparison');await key('Escape');
  });
  await check('c07_3d_room_opens_linked_review_and_preserves_canvas',async()=>{
   await board('overview');await cdp.eval('window.scrollTo(0,0)');await click('.twin-marker[data-point-id="C07"]');await settled();await click('#twin-room-enter');await settled();
   assert.equal(await cdp.eval("document.querySelector('#campus-stage').dataset.selected"),'C07');
   await click('#twin-review-point');await cdp.wait("document.querySelector('#review-create-form')");
   assert.equal(await cdp.eval("document.querySelector('#review-create-form [name=point_id]').value"),'C07');
   await set('#review-create-form [name=task_id]','T4');await set('#review-create-form [name=reason]','自动化隔离验收：3D 机房补证链');await click('#review-create-form button[type=submit]');await cdp.wait("document.querySelector('#review-evidence-form')");
   reviewId=await cdp.eval("document.querySelector('#review-body code').textContent");assert.equal((await api('/api/reviews/'+reviewId)).review.facility_id,'switch-301');await shot('c07-review');
   await set('#review-evidence-form [name=inspector_id]','synthetic-test');await set('#review-evidence-form [name=notes]','仅自动化合成说明，不代表真实到场');await set('#review-evidence-form [name=conclusion]','fault');
   await cdp.eval("(()=>{const c=document.createElement('canvas');c.width=c.height=8;const t=new DataTransfer();t.items.add(new File([Uint8Array.from(atob(c.toDataURL().split(',')[1]),x=>x.charCodeAt(0))],'synthetic.png',{type:'image/png'}));const p=document.querySelector('#review-evidence-form [name=photos]');p.files=t.files;p.dispatchEvent(new Event('change',{bubbles:true}));})()");
   await click('#review-evidence-form [name=onsite_confirmed]');await click('#review-evidence-form button[type=submit]');await cdp.wait("!document.querySelector('#review-evidence-form') && document.querySelector('#review-body h3')?.textContent.includes('材料已处理') && document.querySelector('#review-rerun')?.textContent.includes('新 reality run 已保存')");
   const result=await api('/api/reviews/'+reviewId);assert.equal(result.review.status,'completed');assert(result.evidence.some(e=>e.value_json?.photos?.length));newRun=result.new_runs.at(-1).run_id;assert(newRun);assert.deepEqual(await api('/api/runs/'+original),originalData);await shot('review-saved');
   await click('#review-body .photo-thumb');await cdp.wait("document.querySelector('#photo-dialog').open && document.querySelector('#photo-ai-config').textContent.includes('尚未启用')");
   assert((await cdp.eval("document.querySelector('#photo-caption').textContent")).startsWith('C07'));await click('#photo-ai > summary');assert(await cdp.eval("document.querySelector('#photo-ai-submit').disabled"));
   await key('Escape');assert(await cdp.eval("document.querySelector('#review-dialog').contains(document.activeElement)"));
   await click('#review-rerun button');await cdp.wait(`document.querySelector('#run-body .run-id')?.textContent===${JSON.stringify(newRun)}`);await click('#run-body [data-run-adopt]');
   await cdp.wait(`document.querySelector('#campus-run-context').dataset.runId===${JSON.stringify(newRun)}`);assert.equal(await cdp.eval("document.querySelector('#campus-stage').dataset.selected"),'C07');
   await key('Escape');await key('Escape');await key('Escape');await settled();
  });
  await check('c01_inspection_and_photo_evidence_stay_in_3d',async()=>{
   await board('overview');await cdp.eval('window.scrollTo(0,0)');await click('.twin-marker[data-point-id="C01"]');await settled();await click('#twin-record-point');
   await cdp.wait("document.querySelector('#detail-body form[data-form=inspection]')");assert((await cdp.eval("document.querySelector('#detail-title').textContent")).includes('C01 · 照明控制'));
   const form='#detail-body form[data-form=inspection]';await set(form+' [name=inspector_id]','synthetic-test');await set(form+' [name=result]','NORMAL');await set(form+' [name=notes]','自动化合成记录，仅用于隔离验收');
   await cdp.eval("(()=>{const c=document.createElement('canvas');c.width=c.height=8;const t=new DataTransfer();t.items.add(new File([Uint8Array.from(atob(c.toDataURL().split(',')[1]),x=>x.charCodeAt(0))],'synthetic-c01.png',{type:'image/png'}));const p=document.querySelector('#detail-body [name=photos]');p.files=t.files;p.dispatchEvent(new Event('change',{bubbles:true}));})()");
   await click(form+' [name=onsite_confirmed]');await click(form+' button[type=submit]');await cdp.wait("!document.querySelector('#detail-body form') && document.querySelector('#detail-body .photo-thumb')");
   const saved=await api('/api/points/C01');assert.equal(saved.photos.length,1);assert(saved.records.some(r=>r.inspector_id==='synthetic-test'));await click('#detail-body .photo-thumb');await cdp.wait("document.querySelector('#photo-dialog').open && document.querySelector('#photo-image').complete && document.querySelector('#photo-image').naturalWidth>0");assert((await cdp.eval("document.querySelector('#photo-caption').textContent")).startsWith('C01'));await key('Escape');await key('Escape');
   assert.deepEqual(await api('/api/runs/'+original),originalData);
   await click('#evidence-browser-open');await cdp.wait("document.querySelector('#evidence-browser-dialog').open");await set('#evidence-browser-tab','evidence');await cdp.wait("!document.querySelector('#evidence-search').disabled");assert((await cdp.eval("document.querySelector('#evidence-results').textContent")).length>20);await key('Escape');
   await click('#review-list-open');await cdp.wait("document.querySelector('#review-body select')");await set('#review-body select','completed');await cdp.wait("document.querySelector('#review-body .queue-item')");await key('Escape');
   await click('#all-runs-btn');await cdp.wait("document.querySelector('#run-body .run-item')");await key('Escape');await key('Escape');
  });
  await check('board_switch_preserves_canvas_filters_and_strip_opener',async()=>{
   await board('overview');await cdp.eval("window.__boardCanvas=document.querySelector('#campus-canvas');if(!window.__boardCanvas)throw Error('Canvas missing before Board switch')");
   await set('#search','C07');await sleep(300);await board('coverage');await board('analysis');await board('overview');
   assert(await cdp.eval("window.__boardCanvas===document.querySelector('#campus-canvas')"),'Board navigation replaced canvas');
   assert.equal(await cdp.eval("document.querySelector('#search').value"),'C07');
   await board('coverage');assert(await cdp.eval("[...document.querySelectorAll('.point-card[data-point]')].filter(e=>!e.hidden).every(e=>e.dataset.point==='C07')"),'Search filter was lost across Boards');
   await set('#search','');await sleep(300);await board('overview');
   await click('#board-overview .campus-task-state');await cdp.wait("document.querySelector('#campus-task-dialog').open");await key('Escape');
   assert(await cdp.eval("document.activeElement.matches('#board-overview .campus-task-state')"),'Task dialog must restore actual overview strip opener');
  });
  await check('mobile_scene_controls_keyboard_and_drafts',async()=>{
   for(const width of [1440,1200,1024,768,440,390]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await cdp.eval('window.scrollTo(0,0)');await sleep(200);
    assert(await cdp.eval('document.documentElement.scrollWidth<=innerWidth+1'));
    for(const id of ['overview','coverage','tasks','evidence','analysis']){
     await board(id);await sleep(300);
     const layout=await cdp.eval(`(()=>{const grid=document.querySelector('#${id}-pins'),cards=[...grid.children].filter(e=>!e.hidden).map(e=>({id:e.id,r:e.getBoundingClientRect().toJSON()}));return {columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,overflow:document.documentElement.scrollWidth>innerWidth+1,overlaps:cards.flatMap((a,i)=>cards.slice(i+1).filter(b=>Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left)>1&&Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top)>1).map(b=>[a.id,b.id]))};})()`);
     assert.equal(layout.columns,width<=580?1:width<=850?2:width<=1100?3:4,`${id} columns at ${width}`);assert.equal(layout.overflow,false,`${id} overflow at ${width}`);assert.deepEqual(layout.overlaps,[],`${id} overlapping cards at ${width}`);
    }
    await click('#campus-tasks-open');await cdp.wait("document.querySelector('#campus-task-dialog').open");await set('#planning-minutes','17');await key('Escape');await click('#campus-tasks-open');await cdp.wait("document.querySelector('#campus-task-dialog').open");assert.equal(await cdp.eval("document.querySelector('#planning-minutes').value"),'17');
    const focusBefore=await cdp.eval("({open:document.querySelector('#campus-task-dialog').open,active:document.activeElement.id||document.activeElement.className})");await key('Tab','Tab',9);const focusAfter=await cdp.eval("({open:document.querySelector('#campus-task-dialog').open,active:document.activeElement.id||document.activeElement.className,inside:document.querySelector('#campus-task-dialog').contains(document.activeElement)})");(report.focusTrace||=[]).push({width,before:focusBefore,after:focusAfter});assert(focusAfter.inside,JSON.stringify({width,before:focusBefore,after:focusAfter}));await shot('tasks-'+width);await key('Escape');await board('overview');await shot('campus-'+width);
   }
  });
  assert.deepEqual(report.errors,[]);report.status='passed';
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;if(cdp)try{await shot('failure');}catch{}}
 finally{cdp?.ws?.close();for(const child of children.reverse())await stop(child);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
