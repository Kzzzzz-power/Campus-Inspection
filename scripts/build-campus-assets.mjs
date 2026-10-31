// Rebuild: npm install --prefix .runtime/gltf-tools --ignore-scripts @gltf-transform/core@4.2.1 @gltf-transform/extensions@4.2.1 meshoptimizer@0.25.0
// Run with INSPECTGO_ASSET_BASE pointing at the local project service. All output stays below the project.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {spawn,spawnSync} from 'node:child_process';import net from 'node:net';import crypto from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'.runtime','campus-asset-build');fs.mkdirSync(out,{recursive:true});
const asset=path.join(root,'frontend','assets','campus');fs.mkdirSync(asset,{recursive:true});
const packageRoot=path.join(root,'.runtime','gltf-tools','node_modules');
const {NodeIO}=await import(pathToFileURL(path.join(packageRoot,'@gltf-transform/core/dist/index.modern.js')));
const {ALL_EXTENSIONS,EXTMeshoptCompression}=await import(pathToFileURL(path.join(packageRoot,'@gltf-transform/extensions/dist/index.modern.js')));
const {MeshoptEncoder,MeshoptDecoder}=await import(pathToFileURL(path.join(packageRoot,'meshoptimizer/index.module.js')));
const debug=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>r(port));});});
const child=spawn(process.env.INSPECTGO_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter',`--user-data-dir=${path.join(out,'chrome')}`,`--disk-cache-dir=${path.join(out,'cache')}`,`--remote-debugging-port=${debug}`,'about:blank'],{windowsHide:true,env:{...process.env,TEMP:out,TMP:out},stdio:'ignore'});
let ws,seq=0;const pending=new Map();const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;const timeout=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},60000);pending.set(id,{resolve,reject,timeout});ws.send(JSON.stringify({id,method,params}));});}
try{
 let target;for(let i=0;i<100&&!target;i++){try{target=(await(await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find(t=>t.type==='page');}catch{}if(!target)await sleep(100);}if(!target)throw Error('Chrome unavailable');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timeout);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 await send('Page.navigate',{url:(process.env.INSPECTGO_ASSET_BASE||'http://127.0.0.1:8016')+'/health'});await sleep(350);
 for(const editable of [false,true]){
  const result=await send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{const {createArchitecturalCampus}=await import('/static/twin/campus-architecture.js');const {exportCampus}=await import('/static/twin/export-campus.js');const model=createArchitecturalCampus();try{const bytes=await exportCampus(model.group,{editable:${editable}});return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(new Blob([bytes]));});}finally{model.dispose();}})()`});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));const name=editable?'campus-design-editable.glb':'campus-design.glb',raw=Buffer.from(result.result.value,'base64');fs.writeFileSync(path.join(editable?asset:out,name),raw);console.log(name,raw.length);
 }
 await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
 const source=path.join(out,'campus-design.glb'),doc=await io.read(source);doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
 // No reorder or quantize transform: face/component ranges and full precision remain intact.
 await io.write(path.join(asset,'campus-design.meshopt.glb'),doc);const decoded=await io.read(path.join(asset,'campus-design.meshopt.glb'));if(decoded.getRoot().listMeshes().length!==doc.getRoot().listMeshes().length)throw Error('Mesh count mismatch');
 const files=['campus-design-editable.glb','campus-design.meshopt.glb'].map(name=>{const data=fs.readFileSync(path.join(asset,name));return{name,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};});
 const manifest={basis:'原创建筑设计示意；非测绘；不作为巡检证据',generator:'scripts/build-campus-assets.mjs',tools:{three:'r180',gltfTransform:'4.2.1',meshoptimizer:'0.25.0'},files,sourceHash:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'frontend/twin/campus-architecture.js'))).digest('hex')};fs.writeFileSync(path.join(asset,'campus-design-manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(files));
}finally{ws?.close();if(child.exitCode===null)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}