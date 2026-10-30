// Stage 02: real MQTT + HTTP + process restart, isolated from live records.
const fs=require('node:fs'), path=require('node:path'), net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'), assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'), OUT=path.join(ROOT,'.runtime','stage02-integration',String(Date.now()));
fs.mkdirSync(OUT,{recursive:true});
const PY=process.env.INSPECTGO_PYTHON||path.join(ROOT,'.venv','Scripts','python.exe');
const BPY=process.env.INSPECTGO_BROKER_PYTHON||path.join(ROOT,'.runtime','broker-venv','Scripts','python.exe');
const env={...process.env,TEMP:OUT,TMP:OUT,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',INSPECTGO_SEED_DEMO:'false'};
const children=[], report={checks:[],out:OUT,status:'failed'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+20000;let last;while(Date.now()<end){try{const x=await fn();if(x)return x;}catch(e){last=e;}await sleep(100);}throw Error(label+' timeout '+(last?.message||''));}
async function port(){return new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});}
function start(name,exe,args,extra={}){const out=fs.openSync(path.join(OUT,name+'.log'),'a');const c=spawn(exe,args,{cwd:ROOT,env:{...env,...extra},windowsHide:true,stdio:['ignore',out,out]});fs.closeSync(out);children.push(c);c.on('error',e=>report.process_error=e.message);return c;}
async function stop(c){if(!c||c.exitCode!==null||c.signalCode!==null)return;if(process.platform==='win32')spawnSync('taskkill',['/PID',String(c.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else c.kill('SIGTERM');await until(()=>c.exitCode!==null||c.signalCode!==null,'process exit');}
function python(code){const r=spawnSync(PY,['-B','-c',code],{cwd:ROOT,env,windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr||r.error?.message);return r.stdout;}
async function check(name,fn){await fn();report.checks.push({name,status:'passed'});console.log('PASS '+name);}
(async()=>{
 const mqttPort=await port(), webPort=await port(), BASE=`http://127.0.0.1:${webPort}`;
 const db=path.join(OUT,'isolated.db'),uploads=path.join(OUT,'uploads');
 const api=async(url,body)=>{const r=await fetch(BASE+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const value=await r.json();assert(r.ok,url+': '+r.status+' '+JSON.stringify(value));return value;};
 const startAPI=(enabled=true)=>start('api',PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(webPort)],{INSPECTGO_MQTT_ENABLED:String(enabled),INSPECTGO_MQTT_PORT:String(mqttPort),INSPECTGO_DB:db,INSPECTGO_UPLOADS:uploads});
 const ready=()=>until(async()=>await api('/health'),'API ready');
 const publish=value=>python(`import paho.mqtt.client as m\nc=m.Client(m.CallbackAPIVersion.VERSION2)\nc.connect('127.0.0.1',${mqttPort})\nc.loop_start()\nc.publish('nova/bb02/facility/switch-301/status',${JSON.stringify(JSON.stringify(value))},qos=1,retain=True).wait_for_publish(5)\nc.disconnect()\nc.loop_stop()`);
 let backend,observed,inspection,proof,photo,run,review;
 try{
  start('broker',BPY,['-B','-m','simulators.broker','--port',String(mqttPort)]);backend=startAPI();await ready();
  await until(async()=>(await api('/api/current')).broker.state==='connected','MQTT connected');
  run=await api('/api/runs',{request_id:'before-stage02'});
  const message={facility_id:'switch-301',zone_id:'Z3',observed_at:new Date().toISOString(),source_type:'SIMULATED',availability:'AVAILABLE',condition:'WARNING',metrics:{latency_ms:87},event_id:'integration-event'};
  await check('real_mqtt_persists_observation_and_linked_evidence_not_coverage',async()=>{
   publish(message);observed=await until(async()=>{const p=await api('/api/history?facility_id=switch-301');return p.items[0];},'history persisted');
   assert.equal(observed.payload_json.condition,'WARNING');assert.equal(observed.payload_json.metrics.latency_ms,87);
   proof=(await api('/api/evidence?evidence_type=facility_status')).items[0];assert.equal(proof.observation_id,observed.observation_id);assert.equal(proof.status,'ok');
   assert.equal((await api('/api/dashboard')).covered,0);assert.equal((await api('/api/inspections')).total,0);
   publish(message);await sleep(250);assert.equal((await api('/api/history')).total,1);
  });
  await check('fixed_rounds_site_records_idempotency_and_window_boundaries',async()=>{
   const round=await api('/api/rounds',{round_id:'integration-A',date:'2026-10-01'});assert.equal(round.window_start,'2026-10-01T01:00:00.000000+00:00');assert.equal(round.window_end,'2026-10-01T01:45:00.000000+00:00');
   await api('/api/rounds',{round_id:'integration-B',date:'2026-10-01'});
   const input={inspection_round_id:'integration-A',checkpoint_id:'C07',facility_id:'switch-301',zone_id:'Z3',inspector_id:'integration-check',inspected_at:'2026-10-01T09:25:00+08:00',method:'ON_SITE',result:'WARNING',notes:'Isolated acceptance check',request_id:'integration-site'};
   inspection=await api('/api/inspections',input);assert.equal(inspection.window_eligible,true);assert.deepEqual(await api('/api/inspections',input),inspection);
   assert.equal((await api('/api/inspections?inspection_round_id=integration-B')).total,0);
   assert.equal((await api('/api/evidence?inspection_round_id=integration-A')).items[0].value_json.result,'WARNING');
   const outside=await api('/api/inspections',{...input,request_id:'integration-outside',inspected_at:'2026-10-01T09:46:00+08:00'});assert.equal(outside.window_eligible,false);
   const conflict=await fetch(BASE+'/api/inspections',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,result:'FAULT'})});assert.equal(conflict.status,409);
  });
  await check('legacy_photos_reviews_and_snapshot_remain_queryable',async()=>{
   const bytes=Buffer.from(python("import io,base64\nfrom PIL import Image\nb=io.BytesIO();Image.new('RGB',(3,3),'blue').save(b,format='PNG');print(base64.b64encode(b.getvalue()).decode())").trim(),'base64');
   const form=new FormData();for(const[k,v]of Object.entries({point_id:'C07',inspector_id:'integration-check',inspected_at:new Date().toISOString(),result:'alarm',notes:'Photo acceptance only',onsite_confirmed:'true',request_id:'integration-photo'}))form.append(k,v);
   form.append('photos',new Blob([bytes],{type:'image/png'}),'test.png');const response=await fetch(BASE+'/api/inspections',{method:'POST',body:form});assert.equal(response.status,200,await response.clone().text());photo=(await response.json()).photos[0];assert.equal((await fetch(BASE+photo.url)).status,200);
   review=(await api('/api/reviews',{point_id:'C07',reason:'Evidence check',request_id:'integration-review'})).review;
   assert((await api('/api/points/C07')).reviews.some(r=>r.review_id===review.review_id));assert.deepEqual((await api('/api/runs/'+run.run_id)).snapshot,run.snapshot);
  });
  await check('sqlite_actual_write_readback_produces_traceable_evidence',async()=>{
   const result=await api('/api/evidence/storage-check',{});assert.deepEqual(result.evidence.map(e=>e.evidence_type).sort(),['history_query','sqlite_write']);assert(result.evidence.every(e=>e.status==='ok'));
  });
  await check('sqlite_write_lock_never_reports_success_and_resend_recovers',async()=>{
   const locked=path.join(OUT,'locked'),unlock=path.join(OUT,'unlock');
   const locker=start('lock',PY,['-B','-c',`import sqlite3,time\nfrom pathlib import Path\nc=sqlite3.connect(${JSON.stringify(db)})\nc.execute('BEGIN IMMEDIATE')\nPath(${JSON.stringify(locked)}).touch()\nend=time.time()+12\nwhile not Path(${JSON.stringify(unlock)}).exists() and time.time()<end: time.sleep(.05)\nc.rollback()`]);
   await until(()=>fs.existsSync(locked),'SQLite lock');const later={...message,event_id:'locked-event',observed_at:new Date().toISOString(),condition:'NORMAL'};
   publish(later);await until(async()=>{const f=(await api('/api/current')).facilities.find(f=>f.facility_id==='switch-301');return f.storage.status==='error'&&f.observation.condition==='NORMAL';},'storage error separate from business fact');
   assert.equal((await api('/api/history')).total,1);
   fs.writeFileSync(unlock,'');await until(()=>locker.exitCode!==null,'unlock');publish(later);
   await until(async()=>(await api('/api/history')).total===2,'resend persisted');
  });
  const before={history:await api('/api/history'),inspections:await api('/api/inspections'),evidence:await api('/api/evidence')};
  await check('process_restart_retains_ids_and_history_does_not_restore_live_freshness',async()=>{
   await stop(backend);backend=startAPI(false);await ready();
   assert.deepEqual(await api('/api/history'),before.history);assert.deepEqual(await api('/api/inspections'),before.inspections);assert.deepEqual(await api('/api/evidence'),before.evidence);
   const current=await api('/api/current');assert(current.facilities.every(f=>f.freshness!=='fresh'));
   assert.equal((await fetch(BASE+photo.url)).status,200);assert.deepEqual((await api('/api/runs/'+run.run_id)).snapshot,run.snapshot);
   assert((await api('/api/points/C07')).reviews.some(r=>r.review_id===review.review_id));
  });
  report.status='passed';
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;}
 finally{for(const c of [...children].reverse())await stop(c);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
