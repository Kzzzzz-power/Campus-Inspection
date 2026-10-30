// Stage03 acceptance uses real HTTP and process restarts with an isolated database.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','stage04-integration',String(Date.now()));
fs.mkdirSync(OUT,{recursive:true});
const PY=process.env.INSPECTGO_PYTHON||path.join(ROOT,'.venv','Scripts','python.exe');
const LEGACY=process.env.INSPECTGO_STAGE03_ROOT||path.resolve(ROOT,'..','stage03-worktree');
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
 let server,old,request,s3;
 try{
  server=start(LEGACY,port,'stage03');await until(async()=>(await api('/health')).status==='ok','stage03 ready');
  const s1=await api('/api/scenarios/S1/prepare',{instance_id:'migration-stage03',request_id:'migration-prepare'});
  request={inspection_round_id:s1.inspection_round_id,as_of:s1.as_of,scenario_id:'S1',request_id:'stage03-run'};old=await api('/api/runs',request);
  assert.equal(old.rule_version,'b02-stage03-v1');await stop(server);
  server=start(ROOT,port,'stage04');await until(async()=>(await api('/health')).status==='ok','stage04 ready');
  await check('stage03_snapshot_and_idempotency_survive_stage04_migration',async()=>{
    assert.deepEqual(await api('/api/runs/'+old.run_id),old);assert.deepEqual(await api('/api/runs',request),old);
    assert.equal((await api('/api/inspections?inspection_round_id='+s1.inspection_round_id)).total,8);
  });
  await check('new_stage04_plans_survive_restart_without_changing_old_run',async()=>{
    const prepared=await api('/api/scenarios/S3/prepare',{instance_id:'migration-stage04',request_id:'stage04-prepare'});
    s3=await api('/api/runs',{inspection_round_id:prepared.inspection_round_id,as_of:prepared.as_of,scenario_id:'S3',request_id:'stage04-run'});
    assert.deepEqual(s3.plan_results.map(p=>p.state),['executable','not_executable','not_executable']);
    await stop(server);server=start(ROOT,port,'restarted');await until(async()=>(await api('/health')).status==='ok','restarted ready');
    assert.deepEqual(await api('/api/runs/'+s3.run_id),s3);assert.deepEqual(await api('/api/runs/'+old.run_id),old);
  });
  report.status='passed';
 }catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
 finally{for(const c of [...children].reverse())await stop(c);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log('REPORT '+path.join(OUT,'result.json'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
