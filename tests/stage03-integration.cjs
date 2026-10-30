// Stage03 acceptance uses real HTTP and process restarts with an isolated database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','stage03-integration',String(Date.now()));
fs.mkdirSync(OUT,{recursive:true});
const PY=process.env.INSPECTGO_PYTHON||path.join(ROOT,'.venv','Scripts','python.exe');
const LEGACY=process.env.INSPECTGO_STAGE02_ROOT||path.resolve(ROOT,'..','stage02-worktree');
const db=path.join(OUT,'acceptance.db'),uploads=path.join(OUT,'uploads');
const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',TEMP:OUT,TMP:OUT,INSPECTGO_DB:db,INSPECTGO_UPLOADS:uploads,INSPECTGO_SEED_DEMO:'false',INSPECTGO_MQTT_ENABLED:'false'};
const report={status:'failed',checks:[],out:OUT},children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+20000;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await sleep(100);}throw Error(label+': '+(last?.message||'timeout'));}
async function freePort(){return new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>r(port));});});}
function start(cwd,port,label){const fd=fs.openSync(path.join(OUT,label+'.log'),'a');const c=spawn(PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(port)],{cwd,env,windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);children.push(c);c.on('error',e=>{report.process_error=e.message;});return c;}
async function stop(c){if(!c||c.exitCode!==null||c.signalCode!==null)return;spawnSync('taskkill',['/PID',String(c.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await until(()=>c.exitCode!==null||c.signalCode!==null,'process stopped');}
function py(code){const r=spawnSync(PY,['-B','-c',code],{cwd:ROOT,env,encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(r.status,0,r.stderr||r.error?.message);return r.stdout.trim();}
async function check(name,fn){await fn();report.checks.push({name,status:'passed'});console.log('PASS '+name);}
(async()=>{
 const port=await freePort(),BASE=`http://127.0.0.1:${port}`;
 const api=async(url,body)=>{const r=await fetch(BASE+url,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert(r.ok,url+': '+r.status+' '+JSON.stringify(data));return data;};
 let server,legacy,photo,review,prepared,s1;
 try{
  server=start(LEGACY,port,'legacy');await until(async()=>(await api('/health')).status==='ok','legacy ready');
  const bytes=Buffer.from(py("from PIL import Image\nimport io,base64\nb=io.BytesIO();Image.new('RGB',(3,3),'blue').save(b,format='PNG');print(base64.b64encode(b.getvalue()).decode())"),'base64');
  const form=new FormData();for(const[k,v]of Object.entries({point_id:'C01',inspector_id:'migration-test',inspected_at:new Date().toISOString(),result:'ok',notes:'Isolated migration acceptance only',onsite_confirmed:'true',request_id:'legacy-photo'}))form.append(k,v);
  form.append('photos',new Blob([bytes],{type:'image/png'}),'test.png');const response=await fetch(BASE+'/api/inspections',{method:'POST',body:form});assert.equal(response.status,200);photo=(await response.json()).photos[0];
  review=(await api('/api/reviews',{point_id:'C01',reason:'Legacy review preservation',request_id:'legacy-review'})).review;
  legacy=await api('/api/runs',{request_id:'legacy-run'});await stop(server);server=start(ROOT,port,'stage03');await until(async()=>(await api('/health')).status==='ok','stage03 ready');
  await check('stage02_database_migration_preserves_legacy_run_photo_and_review',async()=>{
   const preserved=await api('/api/runs/'+legacy.run_id);assert.equal(preserved.legacy,true);assert.deepEqual(preserved.snapshot,legacy.snapshot);assert.equal(preserved.summary,legacy.summary);
   const detail=await api('/api/points/C01');assert(detail.reviews.some(r=>r.review_id===review.review_id));assert.deepEqual(Buffer.from(await(await fetch(BASE+photo.url)).arrayBuffer()),bytes);
   assert.equal((await api('/api/dashboard')).round_state,'no_round');
  });
  await check('explicit_s1_prepare_is_idempotent_and_preserves_simulated_provenance',async()=>{
   prepared=await api('/api/scenarios/S1/prepare',{instance_id:'integration-s1',request_id:'integration-prepare'});
   assert.equal(prepared.source_type,'SIMULATED');assert.deepEqual(await api('/api/scenarios/S1/prepare',{instance_id:'integration-s1',request_id:'integration-prepare'}),prepared);
   const rows=await api('/api/inspections?inspection_round_id='+encodeURIComponent(prepared.inspection_round_id));assert.equal(rows.total,8);assert(rows.items.every(r=>r.source_type==='SIMULATED'));
  });
  const run=async(key,overrides={},changes={})=>api('/api/runs',{inspection_round_id:prepared.inspection_round_id,as_of:prepared.as_of,scenario_id:'S1',run_type:'reality',input_overrides:overrides,request_id:key,...changes});
  const state=(r,id)=>r.task_results.find(t=>t.task_id===id)?.state;
  await check('s1_complete_run_computes_five_tasks_and_all_dependency_evidence_references',async()=>{
   s1=await run('s1-full');assert.equal(s1.schema_version,3);assert.equal(s1.task_results.length,5);assert(s1.task_results.every(t=>t.state==='established'));assert.equal(s1.coverage.required,6);assert.equal(s1.coverage.covered,6);
   const ids=new Set(s1.evidence.map(e=>e.evidence_id));assert(ids.size>0);for(const task of s1.task_results){assert(task.checks.length>0);for(const dep of task.checks){assert(['satisfied','unsatisfied','unknown'].includes(dep.status));assert(dep.reason);assert(dep.evidence_refs.length>0);for(const ref of dep.evidence_refs)assert(ids.has(ref),ref);}}
   assert(s1.evidence.some(e=>e.facility_id==='ap-2f'&&e.value_json?.condition==='WARNING'));
   assert.deepEqual(await api('/api/runs/'+s1.run_id),s1);assert.deepEqual(await run('s1-full'),s1);
  });
  await check('ordinary_exclusion_missing_critical_and_explicit_denial_produce_distinct_new_runs',async()=>{
   const ordinary=await run('exclude-ordinary',{exclude_inspection_points:['C03']});assert.equal(state(ordinary,'T1'),'established');
   const missing=await run('exclude-critical',{exclude_inspection_points:['C07']});assert.equal(state(missing,'T1'),'unknown');assert.equal(missing.coverage.covered,5);
   const blocked=await run('deny-critical',{exclude_inspection_points:['C07'],zone_access:[{zone_id:'Z3',access:'DENIED'}]});assert.equal(state(blocked,'T1'),'blocked');
   assert.equal(new Set([s1,ordinary,missing,blocked].map(r=>r.run_id)).size,4);assert.deepEqual(await api('/api/runs/'+s1.run_id),s1);
   assert.equal((await api('/api/inspections?inspection_round_id='+prepared.inspection_round_id)).total,8);
  });
  await check('request_conflict_and_caller_supplied_task_states_are_rejected',async()=>{
   const conflict=await fetch(BASE+'/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({inspection_round_id:prepared.inspection_round_id,as_of:prepared.as_of,scenario_id:'S1',run_type:'reality',input_overrides:{exclude_inspection_points:['C07']},request_id:'s1-full'})});assert.equal(conflict.status,409);
   const forged=await fetch(BASE+'/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({inspection_round_id:prepared.inspection_round_id,as_of:prepared.as_of,task_results:[{task_id:'T1',state:'established'}],request_id:'forged'})});assert.equal(forged.status,422);
  });
  await check('completed_run_and_archived_children_reject_direct_sql_update_delete_and_insert',async()=>{
   py(`import sqlite3,json\nc=sqlite3.connect(${JSON.stringify(db)})\nc.execute('PRAGMA foreign_keys=ON')\nr=${JSON.stringify(s1.run_id)}\nchecks=[('UPDATE runs SET scenario_id=? WHERE run_id=?',('changed',r)),('DELETE FROM runs WHERE run_id=?',(r,)),('UPDATE task_results SET state=? WHERE run_id=?',('unknown',r)),('DELETE FROM dependency_checks WHERE run_id=?',(r,)),('DELETE FROM run_evidence WHERE run_id=?',(r,)),('INSERT OR REPLACE INTO runs SELECT * FROM runs WHERE run_id=?',(r,)),('INSERT OR REPLACE INTO task_results SELECT * FROM task_results WHERE run_id=?',(r,)),('INSERT OR REPLACE INTO run_evidence SELECT * FROM run_evidence WHERE run_id=?',(r,))]\nfor sql,args in checks:\n try:\n  c.execute(sql,args);c.commit()\n except sqlite3.DatabaseError:\n  c.rollback()\n else: raise AssertionError(sql+' unexpectedly succeeded')\n`);
   assert.deepEqual(await api('/api/runs/'+s1.run_id),s1);
  });
  await check('process_restart_retains_complete_runs_and_legacy_assets',async()=>{
   const before=await api('/api/runs');await stop(server);server=start(ROOT,port,'restarted');await until(async()=>(await api('/health')).status==='ok','restarted ready');
   assert.deepEqual(await api('/api/runs/'+s1.run_id),s1);assert.deepEqual(await api('/api/runs'),before);assert.deepEqual((await api('/api/runs/'+legacy.run_id)).snapshot,legacy.snapshot);assert.equal((await fetch(BASE+photo.url)).status,200);
  });
  report.status='passed';
 }catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
 finally{for(const c of [...children].reverse())await stop(c);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
