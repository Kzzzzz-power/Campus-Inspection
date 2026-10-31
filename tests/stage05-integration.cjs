// Real stage04 -> stage05 migration, photo persistence and process restart.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','stage05-integration',String(Date.now()));
fs.mkdirSync(OUT,{recursive:true});
const PY=process.env.INSPECTGO_PYTHON||path.join(ROOT,'.venv','Scripts','python.exe');
const LEGACY=process.env.INSPECTGO_STAGE04_ROOT||path.resolve(ROOT,'..','stage04-worktree');
const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',TEMP:OUT,TMP:OUT,INSPECTGO_DB:path.join(OUT,'acceptance.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads'),INSPECTGO_SEED_DEMO:'false',INSPECTGO_MQTT_ENABLED:'false'};
const report={status:'failed',checks:[],out:OUT},children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+20000;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await sleep(100);}throw Error(label+': '+(last?.message||'timeout'));}
async function freePort(){return new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>r(port));});});}
function start(cwd,port,label){const fd=fs.openSync(path.join(OUT,label+'.log'),'a');const c=spawn(PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(port)],{cwd,env,windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);children.push(c);c.on('error',e=>{report.process_error=e.message;});return c;}
async function stop(c){if(!c||c.exitCode!==null||c.signalCode!==null)return;spawnSync('taskkill',['/PID',String(c.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await until(()=>c.exitCode!==null||c.signalCode!==null,'process stopped');}
async function check(name,fn){await fn();report.checks.push({name,status:'passed'});console.log('PASS '+name);}
(async()=>{
 const port=await freePort(),BASE=`http://127.0.0.1:${port}`;
 const api=async(url,body)=>{const r=await fetch(BASE+url,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert(r.ok,url+': '+r.status+' '+JSON.stringify(data));return data;};
 let server,old,request,round,review,saved,newRun;
 const fixture=path.join(OUT,'synthetic-fixture.png');
 const generated=spawnSync(PY,['-B','-c','from PIL import Image; import sys; Image.new("RGB",(3,3),(20,80,100)).save(sys.argv[1])',fixture],{cwd:ROOT,env,encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(generated.status,0,generated.stderr);
 const image=fs.readFileSync(fixture),observed=()=>new Date().toISOString();
 let evidenceTime;
 async function evidence(){const body=new FormData();for(const [k,v] of Object.entries({point_id:'C07',inspection_round_id:round.inspection_round_id,inspector_id:'integration-test',inspected_at:evidenceTime,result:'alarm',notes:'Automated synthetic fixture: not an actual inspection.',onsite_confirmed:'true',conclusion:'fault',version:String(review.version),request_id:'stage05-proof'}))body.set(k,v);body.set('photos',new Blob([image],{type:'image/png'}),'synthetic-fixture.png');const response=await fetch(BASE+'/api/reviews/'+review.review_id+'/evidence',{method:'POST',body});const result=await response.json();assert(response.ok,JSON.stringify(result));return result;}
 try{
  server=start(LEGACY,port,'stage04');await until(async()=>(await api('/health')).status==='ok','stage04 ready');
  round=await api('/api/scenarios/S2/prepare',{instance_id:'migration-stage05',request_id:'prepare'});
  request={inspection_round_id:round.inspection_round_id,as_of:round.as_of,scenario_id:'S2',request_id:'stage04-run'};
  old=await api('/api/runs',request);assert.equal(old.coverage.covered,5);await stop(server);
  server=start(ROOT,port,'stage05');await until(async()=>(await api('/health')).status==='ok','stage05 ready');
  await check('stage04_snapshot_and_idempotency_survive_stage05_migration',async()=>{assert.deepEqual(await api('/api/runs/'+old.run_id),old);assert.deepEqual(await api('/api/runs',request),old);});
  await check('c07_review_photo_confirmation_and_new_run_are_linked',async()=>{
    review=(await api('/api/reviews',{point_id:'C07',task_id:'T4',trigger_run_id:old.run_id,reason:'Integration test of on-site evidence chain',request_id:'stage05-review'})).review;
    evidenceTime=observed();saved=await evidence();assert.equal(saved.review.status,'completed');assert.equal(saved.rerun.status,'completed');
    newRun=await api('/api/runs/'+saved.rerun.run_id);assert.equal(newRun.rule_version,'b02-stage05-v1');assert.equal(newRun.coverage.covered,5);assert.equal(newRun.task_results.find(t=>t.task_id==='T1').state,'blocked');assert.equal(newRun.task_results.find(t=>t.task_id==='T4').state,'established');
    const detail=await api('/api/reviews/'+review.review_id);assert(detail.evidence.some(e=>e.evidence_type==='review_confirmation'&&e.value_json.conclusion==='confirmed_abnormal'));
    assert(detail.evidence.every(e=>e.review_id===review.review_id));assert(newRun.evidence.some(e=>e.review_id===review.review_id));assert.equal(saved.photos.length,1);
    assert.deepEqual(Buffer.from(await(await fetch(BASE+saved.photos[0].url)).arrayBuffer()),image);
    assert.deepEqual(await evidence(),saved);assert.equal(fs.readdirSync(env.INSPECTGO_UPLOADS).length,1);
  });
  await check('records_images_reviews_and_both_runs_survive_process_restart',async()=>{
    const before=await api('/api/reviews/'+review.review_id);await stop(server);server=start(ROOT,port,'stage05-restart');await until(async()=>(await api('/health')).status==='ok','restart ready');
    assert.deepEqual(await api('/api/reviews/'+review.review_id),before);assert.deepEqual(await api('/api/runs/'+old.run_id),old);assert.deepEqual(await api('/api/runs/'+newRun.run_id),newRun);
    assert.deepEqual(Buffer.from(await(await fetch(BASE+saved.photos[0].url)).arrayBuffer()),image);assert.deepEqual(await evidence(),saved);
    assert.equal((await api('/api/reviews?status=completed')).items.filter(r=>r.review_id===review.review_id).length,1);
  });
  report.status='passed';
 }catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
 finally{for(const c of [...children].reverse())await stop(c);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
