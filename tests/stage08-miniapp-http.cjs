// Actual FastAPI + native client adapter bridge, not WeChat simulator/device validation.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {Client}=require('../miniapp/lib/client');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.runtime','stage08-miniapp-http',String(Date.now()));fs.mkdirSync(OUT,{recursive:true});
const PY=process.env.INSPECTGO_PYTHON||path.resolve(ROOT,'../../.venv/Scripts/python.exe');
const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',TEMP:OUT,TMP:OUT,INSPECTGO_DB:path.join(OUT,'isolated.db'),INSPECTGO_UPLOADS:path.join(OUT,'uploads'),INSPECTGO_SEED_DEMO:'false',INSPECTGO_MQTT_ENABLED:'false',INSPECTGO_LLM_ENABLED:'false',INSPECTGO_VLM_ENABLED:'false'};
const report={status:'failed',test_only:true,kind:'Node wx adapter + actual FastAPI HTTP',checks:[],output:OUT};let child;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){try{if(await fn())return;}catch(_){}await sleep(100);}throw Error('API readiness/cleanup timeout');}
async function port(){return new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});}
(async()=>{const PORT=await port(),BASE='http://127.0.0.1:'+PORT,storage=new Map(),requests=[];let loseResponse=true;
 const api=async(url,body)=>{const r=await fetch(BASE+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);const data=await r.json();assert(r.ok,JSON.stringify(data));return data;};
 const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,JSON.parse(JSON.stringify(v))),removeStorageSync:k=>storage.delete(k),
  saveFile:o=>{const saved=path.join(OUT,'owned-draft.png');fs.copyFileSync(o.tempFilePath,saved);o.success({savedFilePath:saved});},removeSavedFile:o=>{if(fs.existsSync(o.filePath))fs.unlinkSync(o.filePath);},
  getFileSystemManager:()=>({readFile:o=>{try{const b=fs.readFileSync(o.filePath);o.success({data:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)});}catch(e){o.fail({errMsg:e.message});}}}),
  request:o=>{requests.push(o);fetch(o.url,{method:o.method,headers:o.header,body:o.method==='GET'?undefined:o.data}).then(async r=>{const data=await r.json();if(o.method==='POST'&&loseResponse&&r.ok){loseResponse=false;o.fail({errMsg:'request:fail timeout (test intentionally discarded actual saved response)'});}else o.success({statusCode:r.status,data});}).catch(e=>o.fail({errMsg:e.message}));}};
 const c=new Client(wx,BASE);
 try{
  const log=fs.openSync(path.join(OUT,'api.log'),'a');child=spawn(PY,['-B','-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',String(PORT)],{cwd:ROOT,env,windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);child.on('error',e=>report.process_error=e.message);
  await until(async()=>(await api('/health')).status==='ok');
  const fixture=path.join(OUT,'labeled-test-fixture.png');const generated=spawnSync(PY,['-B','-c','from PIL import Image,ImageDraw; import sys; im=Image.new("RGB",(320,100),(230,240,230)); ImageDraw.Draw(im).text((10,40),"AUTOMATED TEST FIXTURE - NOT ONSITE",fill=(0,0,0)); im.save(sys.argv[1])',fixture],{cwd:ROOT,env,windowsHide:true,encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);const bytes=fs.readFileSync(fixture);
  const prepared=await api('/api/scenarios/S2/prepare',{instance_id:'native-client-bridge',request_id:'native-prepare'});
  const old=await api('/api/runs',{inspection_round_id:prepared.inspection_round_id,as_of:prepared.as_of,scenario_id:'S2',request_id:'native-run'});
  assert.deepEqual(await c.get('/api/runs/'+old.run_id),old);report.checks.push('native client immutable GET matches direct API response used by Web');
  const q=(await api('/api/reviews',{point_id:'C07',task_id:'T4',trigger_run_id:old.run_id,reason:'自动化适配测试，不是真实巡检',request_id:'native-review'})).review;
  assert((await c.get('/api/reviews?status=pending')).items.some(r=>r.review_id===q.review_id));assert((await c.get('/api/facilities')).some(p=>p.checkpoint_id==='C07'));
  const d=c.draft(q.review_id);Object.assign(d.fields,{inspector_id:'适配测试🧭',inspected_at:new Date().toISOString(),notes:'中文现场草稿🧭。自动化标记图片，非现场验收。',result:'unknown',conclusion:'unknown',onsite_confirmed:'true'});
  await c.addPhoto(d,fixture);c.save(q.review_id,d);await assert.rejects(c.submit(q.review_id,d,q),e=>e.kind==='timeout');assert(d.attempt);const submitted=requests.find(r=>r.method==='POST');
  const saved=await c.submit(q.review_id,d,q);assert.equal(saved.review.status,'pending');assert.equal(saved.photo_count,1);assert.equal(saved.rerun.status,'completed');assert.deepEqual(Buffer.from(await(await fetch(BASE+saved.photos[0].url)).arrayBuffer()),bytes);assert.equal(fs.readdirSync(env.INSPECTGO_UPLOADS).length,1);
  assert.deepEqual(await c.request('/api/reviews/'+q.review_id+'/evidence','POST',submitted.data,submitted.header),saved);assert.equal(fs.readdirSync(env.INSPECTGO_UPLOADS).length,1);report.checks.push('actual client-generated Unicode multipart + durable PNG saved, lost response exact retry deduplicates, unknown remains pending');
  const detail=await c.get('/api/reviews/'+q.review_id);assert(detail.evidence.some(e=>e.provenance_json.inspector_id==='适配测试🧭'));assert(detail.evidence.some(e=>JSON.stringify(e).includes('中文现场草稿')));const next=await c.get('/api/runs/'+saved.rerun.run_id);assert.equal(next.run_type,'reality');assert.notEqual(next.run_id,old.run_id);assert.deepEqual(await c.get('/api/runs/'+old.run_id),old);report.checks.push('live evidence contains Unicode and new reality run; old frozen run unchanged');
  const conflict=c.draft(q.review_id);Object.assign(conflict.fields,d.fields,{result:'alarm',conclusion:'fault',inspected_at:new Date().toISOString()});await assert.rejects(c.submit(q.review_id,conflict,q),e=>e.status===409);assert(conflict.attempt&&conflict.conflict);const notes=conflict.fields.notes;c.reconcile(q.review_id,conflict,detail.review);assert.equal(conflict.fields.notes,notes);const confirmed=await c.submit(q.review_id,conflict,detail.review);assert.equal(confirmed.review.status,'completed');report.checks.push('actual server version 409 retains draft; explicit reconcile uses latest version then saves');
  report.run_id=old.run_id;report.new_run_id=saved.rerun.run_id;report.review_id=q.review_id;report.photo_sha256=require('node:crypto').createHash('sha256').update(bytes).digest('hex');report.status='passed';
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;}
 finally{if(child&&child.exitCode===null&&child.pid){spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await until(()=>child.exitCode!==null||child.signalCode!==null);}await until(()=>new Promise(resolve=>{const s=net.connect(PORT,'127.0.0.1');s.once('error',()=>resolve(true));s.once('connect',()=>{s.destroy();resolve(false);});}));report.owned_port_closed=true;fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
