const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','web-polish','results');
const BASE=process.env.INSPECTGO_TEST_URL||'http://127.0.0.1:8012/',CDP_URL=process.env.INSPECTGO_CDP_URL||'http://127.0.0.1:9342';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
fs.mkdirSync(OUT,{recursive:true});
class CDP {
 constructor(url){this.url=url;this.id=0;this.pending=new Map();this.errors=[];}
 async open(){this.ws=new WebSocket(this.url);await new Promise((r,j)=>{this.ws.addEventListener('open',r,{once:true});this.ws.addEventListener('error',j,{once:true});});this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')this.errors.push(m.params);});}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id,timer=setTimeout(()=>reject(Error(method+' timeout')),15000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
 async wait(expression){const end=Date.now()+12000;while(Date.now()<end){if(await this.eval(expression))return;await sleep(50);}throw Error('Timed out: '+expression);}
}
(async()=>{
 const targets=await(await fetch(CDP_URL+'/json/list')).json(),target=targets.find(t=>t.type==='page');assert(target);
 const p=new CDP(target.webSocketDebuggerUrl);await p.open();
 const report={at:new Date().toISOString(),base:BASE,status:'failed',checks:[],errors:p.errors};
 const click=s=>p.eval('document.querySelector('+JSON.stringify(s)+').click()');
 const reset=async()=>{await click('#reset-filters');await sleep(350);};
 const shot=async name=>{const r=await p.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(OUT,name),Buffer.from(r.data,'base64'));};
 async function check(name,fn){try{const details=await fn();report.checks.push({name,status:'passed',...details});}catch(e){report.checks.push({name,status:'failed',failure:e.message});}}
 try{
  await p.send('Page.enable');await p.send('Runtime.enable');await p.send('Network.enable');await p.send('Network.setCacheDisabled',{cacheDisabled:true});
  await p.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await p.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await p.send('Page.navigate',{url:BASE});await p.wait("document.querySelectorAll('.point-card').length===8");
  await p.eval("if(!document.getElementById('motion-toggle').checked)document.getElementById('motion-toggle').click()");
  await sleep(1100);await shot(process.env.POLISH_BASELINE?'before-1440.png':'after-1440.png');
  await check('discrete_filter_has_synchronous_results_and_card_flip',async()=>{
   await click('#missing-shortcut');
   const r=await p.eval("({count:document.querySelectorAll('.point-card').length,groups:[...document.querySelectorAll('.zone-group')].every(g=>g.querySelector('.point-card')),frames:[...document.querySelectorAll('.point-card')].flatMap(e=>e.getAnimations().flatMap(a=>a.effect.getKeyframes()))})");
   const dashboard=await(await fetch(BASE+'api/dashboard')).json();
   assert.equal(r.count,dashboard.missing.length);assert(r.groups);assert(r.frames.some(f=>f.transform&&f.transform!=='none'),'Surviving cards should move between their old and new positions.');
   return {count:r.count};
  });await reset();
  await check('typing_keeps_results_steady',async()=>{
   await p.eval("var search=document.getElementById('search');search.value='C0';search.dispatchEvent(new Event('input',{bubbles:true}))");
   assert.equal(await p.eval("document.getElementById('facility-groups').getAnimations().length+document.getElementById('result-count').getAnimations().length"),0,'Typing must not fade the whole result area on every key.');
  });await reset();
  await check('search_matches_location_and_preserves_scope',async()=>{
   await p.eval("var search=document.getElementById('search');search.value='实训楼';search.dispatchEvent(new Event('input',{bubbles:true}))");
   assert.equal(await p.eval("document.querySelectorAll('.point-card').length"),5);
   await p.eval("const scope=document.getElementById('mobile-scope');scope.value='zone:Z3';scope.dispatchEvent(new Event('change',{bubbles:true}))");
   assert.equal(await p.eval("document.querySelectorAll('.point-card').length"),2);
  });await reset();
  await check('ambient_pause_preserves_current_position',async()=>{
   await p.eval("document.querySelector('.ambient span').getAnimations()[0].currentTime=18000");
   await sleep(30);const before=await p.eval("getComputedStyle(document.querySelector('.ambient span')).transform");
   await click('#motion-toggle');
   const after=await p.eval("({transform:getComputedStyle(document.querySelector('.ambient span')).transform,paused:document.querySelector('.ambient span').getAnimations().every(a=>a.playState==='paused'),count:document.querySelector('.ambient span').getAnimations().length})");
   assert.notEqual(after.transform,'none');assert(after.count>0&&after.paused);const numbers=s=>(s.match(/-?\d+(?:\.\d+)?/g)||[]).map(Number);
   const a=numbers(before),b=numbers(after.transform);assert.equal(a.length,b.length);assert(a.every((v,i)=>Math.abs(v-b[i])<.4),'Background should hold its pose when paused.');
  });await p.eval("if(!document.getElementById('motion-toggle').checked)document.getElementById('motion-toggle').click()");
  await check('summary_avoids_backdrop_sampling',async()=>{assert.equal(await p.eval("getComputedStyle(document.querySelector('.summary-strip')).backdropFilter"),'none');});
  await check('saved_run_toast_visible_above_modal',async()=>{
   await click('#run-btn');await p.wait("document.getElementById('run-dialog').open && document.querySelector('.run-id')");
   await sleep(250);
   const visible=await p.eval("(()=>{const t=document.getElementById('toast');const r=t.getBoundingClientRect();t.style.pointerEvents='auto';const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);t.style.removeProperty('pointer-events');return {text:t.textContent,hit:hit===t||t.contains(hit),inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight};})()");
   assert(visible.text.includes('已保存'));assert(visible.hit&&visible.inside,'The success notice must be visible above the modal.');
   await shot('run-toast.png');
  });await click('#run-close');
  await check('rapid_changes_keep_latest_view_and_filter',async()=>{
   await p.eval("for(let i=0;i<10;i++)document.getElementById(i%2?'view-grid':'view-list').click();document.getElementById('view-list').click();document.getElementById('missing-shortcut').click()");
   await p.wait("document.getElementById('facility-groups').classList.contains('list-view')");await sleep(550);
   const d=await(await fetch(BASE+'api/dashboard')).json();assert.equal(await p.eval("document.querySelectorAll('.point-card').length"),d.missing.length);
   assert.equal(await p.eval("[...document.head.querySelectorAll('style')].filter(s=>s.textContent.includes('::view-transition-group(card-')).length"),0);
  });await click('#view-grid');await sleep(400);await reset();
  await check('reduced_motion_keeps_all_controls_without_animations',async()=>{
   await p.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await p.wait("document.documentElement.dataset.feedback==='off'");
   await click('#missing-shortcut');assert.equal(await p.eval("[...document.querySelectorAll('.point-card,#facility-groups,#result-count')].flatMap(e=>e.getAnimations()).length"),0);
   await click('#view-list');assert(await p.eval("document.getElementById('facility-groups').classList.contains('list-view')"));
   assert.equal(await p.eval("document.querySelectorAll('.click-ring').length"),0);
  });await click('#view-grid');await reset();await p.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await check('view_transition_unavailable_falls_back_synchronously',async()=>{
   const result=await p.eval("(()=>{const original=document.startViewTransition;document.startViewTransition=undefined;try{document.getElementById('view-list').click();const list=document.getElementById('facility-groups').classList.contains('list-view');document.getElementById('view-grid').click();return {list,grid:!document.getElementById('facility-groups').classList.contains('list-view')};}finally{document.startViewTransition=original;}})()");
   assert(result.list&&result.grid);
  });
  await check('responsive_layout_and_mobile_primary_action',async()=>{
   const widths=[1440,1250,1101,1100,1024,768,580,390,320],values=[];
   for(const width of widths){
    await p.send('Emulation.setDeviceMetricsOverride',{width,height:width<=390?844:1000,deviceScaleFactor:1,mobile:false});await p.eval("scrollTo({top:0,behavior:'instant'})");await sleep(150);
    const r=await p.eval("({width:innerWidth,scroll:document.documentElement.scrollWidth,firstActionBottom:Math.round(document.querySelector('.point-card .point-actions').getBoundingClientRect().bottom)})");assert(r.scroll<=width);if(width===390)assert(r.firstActionBottom<=844,JSON.stringify(r));values.push(r);
    if([1440,768,390].includes(width))await shot((process.env.POLISH_BASELINE?'before-':'after-')+width+'.png');
   }return {widths:values};
  });
  assert.equal(p.errors.length,0,JSON.stringify(p.errors));report.status=report.checks.every(c=>c.status==='passed')?'passed':'failed';
 }catch(error){report.failure=error.stack;}
 finally {fs.writeFileSync(path.join(OUT,process.env.POLISH_BASELINE?'baseline.json':'polish.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));p.ws.close();if(report.status!=='passed')process.exitCode=1;}
})();