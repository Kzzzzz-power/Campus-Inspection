import * as THREE from '../vendor/three/three.module.js';
import {OrbitControls} from '../vendor/three/OrbitControls.js';
import {createFacadeSample,SAMPLE} from './model.js';
import {createSampleEnvironment,loadSampleHDREnvironment} from './lighting.js';

const $=id=>document.getElementById(id),host=$('viewer'),canvas=$('sample-canvas');
const media=matchMedia('(max-width:600px)'),reduced=matchMedia('(prefers-reduced-motion:reduce)');
const model=createFacadeSample(),scene=new THREE.Scene(),raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
const camera=new THREE.PerspectiveCamera(38,1,.05,100);
let renderer,controls,environment,sun,fill,outline,selected=null,flight=null,raf=0,visible=true,lost=false,disposed=false,lastTime=0,dragStart=null,referenceTrigger=null;
let view='perspective',soft=false,frames=0,environmentRequest=0;
scene.background=new THREE.Color(0xe7e9e2);scene.add(model.group);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(180,180),new THREE.MeshStandardMaterial({color:0xdfe3d8,roughness:1}));
ground.rotation.x=-Math.PI/2;ground.position.y=-.025;ground.receiveShadow=true;scene.add(ground);
const materialNames={concrete:'混凝土／涂层 · 高粗糙度',trim:'浅色收口 · 哑光',panel:'窗下板 · 材质待核实',frame:'深色金属型材',gasket:'密封条 · 构造推断',flashing:'金属压边 · 构造推断',glass:'玻璃 · 环境反射与简化透射'};
const presets={perspective:{target:[0,1.85,0],direction:[.8,.08,1.7]},front:{target:[0,1.9,0],direction:[0,0,2]},side:{target:[0,1.85,0],direction:[1.5,.2,1.6]},detail:{target:[.9,2.0,-.07],position:[2.45,2.65,2.35]}};
const selection=new THREE.Box3(),projection=new THREE.Vector3();
function announce(message){$('viewport-status').textContent=message;}
function invalidate(){if(disposed||lost||!visible||document.hidden||raf)return;raf=requestAnimationFrame(render);}
function screenPoint(p){projection.copy(p).project(camera);return{x:(projection.x*.5+.5)*host.clientWidth,y:(-.5*projection.y+.5)*host.clientHeight};}
function labels(){
 if(!$('measurements').hidden){
  const a=screenPoint(new THREE.Vector3(0,.03,.38));
  $('width-note').style.left=Math.max(100,Math.min(host.clientWidth-100,a.x))+'px';$('width-note').style.top=Math.min(host.clientHeight-65,Math.max(100,a.y+13))+'px';
  const b=screenPoint(new THREE.Vector3(-1.8,3.8,.1));
  $('height-note').style.left=Math.max(108,Math.min(host.clientWidth-108,b.x))+'px';$('height-note').style.top=Math.max(85,Math.min(host.clientHeight-95,b.y-32))+'px';
 }
 if(selected){selection.setFromObject(selected);const center=selection.getCenter(new THREE.Vector3());center.y=selection.max.y;const p=screenPoint(center);
  $('selected-label').style.left=Math.max(115,Math.min(host.clientWidth-115,p.x))+'px';$('selected-label').style.top=Math.max(105,Math.min(host.clientHeight-70,p.y))+'px';}
}
function render(time){
 raf=0;if(disposed||lost||!visible||document.hidden)return;
 if(flight){
  const t=reduced.matches?1:Math.min(1,(time-flight.start)/flight.duration),e=1-Math.pow(1-t,3);
  camera.position.lerpVectors(flight.from,flight.to,e);controls.target.lerpVectors(flight.fromTarget,flight.target,e);controls.update();
  if(t===1)flight=null;
 }
 renderer.info.reset();renderer.render(scene,camera);labels();frames++;
 host.dataset.frames=String(frames);host.dataset.calls=String(renderer.info.render.calls);host.dataset.triangles=String(renderer.info.render.triangles);host.dataset.camera=camera.position.toArray().map(n=>n.toFixed(3)).join(',');
 $('render-status').textContent=renderer.info.render.calls+' 次绘制 · '+renderer.info.render.triangles.toLocaleString()+' 三角形';
 lastTime=time;if(flight)invalidate();
}
function move(position,target,duration=620){
 if(!controls)return;flight={from:camera.position.clone(),to:new THREE.Vector3(...position),fromTarget:controls.target.clone(),target:new THREE.Vector3(...target),start:performance.now(),duration};
 if(reduced.matches){camera.position.copy(flight.to);controls.target.copy(flight.target);flight=null;controls.update();}
 invalidate();
}
function fitted(direction,target){
 const h=SAMPLE.height,w=SAMPLE.width,vertical=THREE.MathUtils.degToRad(camera.fov),horizontal=2*Math.atan(Math.tan(vertical/2)*camera.aspect);
 const distance=Math.max(h/(2*Math.tan(vertical/2)),w/(2*Math.tan(horizontal/2)))*1.35;
 return new THREE.Vector3(...target).add(new THREE.Vector3(...direction).normalize().multiplyScalar(distance)).toArray();
}
function setView(name,instant=false){
 if(!controls)return;view=name;const p=presets[name];
 for(const b of document.querySelectorAll('[data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===name));
 const position=p.position||fitted(p.direction,p.target);
 if(instant){flight=null;camera.position.fromArray(position);controls.target.fromArray(p.target);controls.update();invalidate();}
 else move(position,p.target);
}
function constrainCamera(){
 // This sample is viewed only from the outside; the plane is the outer collision boundary.
 const minimumZ=.82;
 camera.position.z=Math.max(minimumZ,camera.position.z);camera.position.y=Math.max(.25,camera.position.y);
 controls.target.x=THREE.MathUtils.clamp(controls.target.x,-1.8,1.8);controls.target.y=THREE.MathUtils.clamp(controls.target.y,.2,3.8);controls.target.z=0;
 camera.lookAt(controls.target);
}
function resize(){if(!renderer)return;const w=host.clientWidth,h=host.clientHeight;renderer.setPixelRatio(Math.min(devicePixelRatio,media.matches?1.25:1.6));renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();setView(view,true);invalidate();}
function removeOutline(){if(!outline)return;scene.remove(outline);outline.geometry.dispose();outline.material.dispose();outline=null;}
function highlight(mesh){
 removeOutline();if(!mesh)return;
 outline=new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry,35),new THREE.LineBasicMaterial({color:0x427968,transparent:true,opacity:.88,depthTest:false}));
 outline.renderOrder=10;outline.position.copy(mesh.position);outline.rotation.copy(mesh.rotation);scene.add(outline);
}
function select(mesh){
 selected=mesh;host.dataset.selected=mesh?.name||'';$('component-select').value=mesh?.name||'';$('focus-part').disabled=!mesh;$('selected-label').hidden=!mesh;
 highlight(mesh);
 if(mesh){
  const d=mesh.userData;$('part-name').textContent=d.name;$('part-id').textContent=mesh.name;$('part-material').textContent=materialNames[d.materialName];
  $('part-evidence').textContent=d.evidence;$('part-simplification').textContent=d.simplification;
  $('selection-title').textContent=d.name+' · 尺寸暂估';$('selected-label').textContent=d.name;
  const color='#'+mesh.material.color.getHexString();document.querySelector('.material-disc').style.background='radial-gradient(circle at 25% 20%, #f4f7ee, '+color+' 72%, #344137)';
 }else{
  $('part-name').textContent='外立面开间样板';$('part-id').textContent='未选择';$('part-material').textContent='请选择模型或下拉列表中的构件';
  $('part-evidence').textContent='可见立面轮廓';$('part-simplification').textContent='一个窗格开间，背面不作为实景还原';$('selection-title').textContent='选择一个构件，检查材料与依据';
 }
 invalidate();
}
function hit(event){const r=canvas.getBoundingClientRect();pointer.set((event.clientX-r.left)/r.width*2-1,-(event.clientY-r.top)/r.height*2+1);raycaster.setFromCamera(pointer,camera);return raycaster.intersectObjects(model.components,false)[0]?.object||null;}
function focusPart(){
 if(!selected)return;selection.setFromObject(selected);const center=selection.getCenter(new THREE.Vector3());center.z=0;
 move([center.x+.95,center.y+.35,2.05],center.toArray(),580);
 for(const b of document.querySelectorAll('[data-view]'))b.setAttribute('aria-pressed','false');
}
function referenceOpen(trigger){referenceTrigger=trigger;$('reference-dialog').showModal();$('close-reference').focus();}
function bindEnvironment(){
 scene.environment=environment.texture;scene.environmentRotation.set(0,environment.rotation||0,0);
 // With scene.environment alone, Three.js uses scene.environmentIntensity.
 // Explicit assignment preserves independently tuned glass reflection intensity.
 model.materials.glass.envMap=environment.texture;model.materials.glass.envMapRotation.copy(scene.environmentRotation);
 model.materials.glass.needsUpdate=true;
}

async function upgradeEnvironment(){
 const request=++environmentRequest;host.dataset.environment='loading';
 try{
  const next=await loadSampleHDREnvironment(renderer,()=>!disposed&&!lost&&request===environmentRequest);
  if(!next)return;
  const previous=environment;environment=next;bindEnvironment();previous?.dispose();
  if(sun)sun.position.copy(environment.sunDirection).multiplyScalar(9);
  renderer.shadowMap.needsUpdate=true;host.dataset.environment='hdr';
  $('lighting-source').textContent='纯天空 HDR · 非校园现场采集';invalidate();
 }catch(error){
  if(disposed||lost||request!==environmentRequest)return;
  host.dataset.environment='fallback';
  $('lighting-source').textContent='天空资源加载失败 · 已使用程序化光照';
  console.warn('Facade HDR unavailable; procedural lighting retained.',error);invalidate();
 }
}

function portableAsset(){
 const asset=model.group.clone(true);
 asset.traverse(object=>{if(object.isMesh){object.material=object.material.clone();object.material.envMap=null;}});
 return asset;
}
function disposeAssetMaterials(asset){asset.traverse(object=>{if(object.isMesh)object.material.dispose();});}
function setup(){
 try{
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:media.matches?'low-power':'high-performance'});
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=media.matches?THREE.PCFSoftShadowMap:THREE.VSMShadowMap;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;
  environment=createSampleEnvironment(renderer);bindEnvironment();scene.environmentIntensity=.85;
  scene.add(new THREE.HemisphereLight(0xd5e6f2,0xb0a28b,.3));
  sun=new THREE.DirectionalLight(0xfff1e2,3);sun.position.set(-4.5,6,5);sun.castShadow=true;sun.shadow.mapSize.set(media.matches?1024:2048,media.matches?1024:2048);
  Object.assign(sun.shadow.camera,{left:-5,right:5,top:6,bottom:-4,near:.5,far:25});sun.shadow.bias=-.00012;sun.shadow.normalBias=.004;sun.shadow.radius=3.5;sun.shadow.blurSamples=8;scene.add(sun);
  fill=new THREE.DirectionalLight(0xd3e3f4,.45);fill.position.set(4,3,1);scene.add(fill);
  controls=new OrbitControls(camera,canvas);controls.enableDamping=false;controls.minDistance=1.5;controls.maxDistance=17;controls.minPolarAngle=.3;controls.maxPolarAngle=Math.PI*.49;controls.minAzimuthAngle=-1.15;controls.maxAzimuthAngle=1.15;
  controls.addEventListener('start',()=>{flight=null;});controls.addEventListener('change',()=>{constrainCamera();invalidate();});
  resize();host.dataset.ready='true';$('loading').hidden=true;upgradeEnvironment();
 }catch(error){host.dataset.ready='error';$('loading').textContent='此设备无法显示 WebGL 样板。仍可查看参考图、构件说明和下载模型。';for(const b of document.querySelectorAll('[data-view],#reset-camera,#lighting'))b.disabled=true;console.error(error);}
}
for(const mesh of model.components){const o=document.createElement('option');o.value=mesh.name;o.textContent=mesh.userData.name;$('component-select').append(o);}
$('component-count').textContent=model.components.length+' 个构件';
$('component-select').addEventListener('change',e=>select(model.components.find(m=>m.name===e.target.value)||null));
$('focus-part').addEventListener('click',focusPart);
for(const b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>{announce('');setView(b.dataset.view);});
$('reset-camera').addEventListener('click',()=>{select(null);setView('perspective');announce('');});
$('dimensions').addEventListener('click',e=>{const hidden=!$('measurements').hidden;$('measurements').hidden=hidden;e.currentTarget.setAttribute('aria-pressed',String(!hidden));invalidate();});
$('lighting').addEventListener('click',e=>{if(!sun)return;soft=!soft;sun.intensity=soft?1.6:3;fill.intensity=soft?.8:.45;scene.environmentIntensity=soft?1.1:.85;renderer.shadowMap.needsUpdate=true;e.currentTarget.textContent=soft?'日光：柔光':'日光：侧光';e.currentTarget.setAttribute('aria-pressed',String(soft));invalidate();});
canvas.addEventListener('pointerdown',e=>{dragStart={x:e.clientX,y:e.clientY};});
canvas.addEventListener('pointerup',e=>{if(!controls||!dragStart)return;const distance=Math.hypot(e.clientX-dragStart.x,e.clientY-dragStart.y);dragStart=null;if(distance<5&&e.button===0)select(hit(e));});
canvas.addEventListener('pointermove',e=>{if(!controls||e.buttons)return;const mesh=hit(e);canvas.style.cursor=mesh?'pointer':'grab';if(!selected){highlight(mesh);invalidate();}});
canvas.addEventListener('pointerleave',()=>{if(!selected){removeOutline();invalidate();}});
canvas.addEventListener('dblclick',e=>{if(!controls)return;select(hit(e));focusPart();});
canvas.addEventListener('keydown',e=>{
 if(!controls)return;if(e.key==='Escape'){select(null);return;}
 if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','='].includes(e.key)){e.preventDefault();flight=null;const offset=camera.position.clone().sub(controls.target),s=new THREE.Spherical().setFromVector3(offset);
 if(e.key==='ArrowLeft')s.theta-=.08;if(e.key==='ArrowRight')s.theta+=.08;if(e.key==='ArrowUp')s.phi-=.06;if(e.key==='ArrowDown')s.phi+=.06;
 if(e.key==='+'||e.key==='=')s.radius*=.88;if(e.key==='-')s.radius*=1.12;
 s.theta=THREE.MathUtils.clamp(s.theta,-1.15,1.15);s.phi=THREE.MathUtils.clamp(s.phi,.3,Math.PI*.49);s.radius=THREE.MathUtils.clamp(s.radius,1.5,17);
 camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(s));constrainCamera();controls.update();invalidate();}
});
for(const id of ['show-reference','reference-zoom'])$(id).addEventListener('click',e=>referenceOpen(e.currentTarget));
$('close-reference').addEventListener('click',()=>$('reference-dialog').close());
$('reference-dialog').addEventListener('close',()=>referenceTrigger?.focus());
$('reference-dialog').addEventListener('click',e=>{if(e.target===$('reference-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(!visible){if(raf)cancelAnimationFrame(raf);raf=0;flight=null;}else invalidate();},{threshold:.05});observer.observe(host);
const resizer=new ResizeObserver(resize);resizer.observe(host);
const visibility=()=>{if(document.hidden){if(raf)cancelAnimationFrame(raf);raf=0;flight=null;}else invalidate();};document.addEventListener('visibilitychange',visibility);
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();lost=true;environmentRequest++;flight=null;if(raf)cancelAnimationFrame(raf);raf=0;announce('图形上下文暂时丢失，等待浏览器恢复。参考图与构件信息仍可查看。');host.dataset.context='lost';});
canvas.addEventListener('webglcontextrestored',()=>{lost=false;environment?.dispose();environment=createSampleEnvironment(renderer);bindEnvironment();renderer.shadowMap.needsUpdate=true;host.dataset.context='restored';announce('图形显示已恢复。');invalidate();upgradeEnvironment();});
async function exportModel(){
 const {GLTFExporter}=await import('../vendor/three/GLTFExporter.js');
  const asset=portableAsset();
 try{return await new GLTFExporter().parseAsync(asset,{binary:true,onlyVisible:true,maxTextureSize:2048});}
 finally{disposeAssetMaterials(asset);}
}
// A read-only review hook for asset export and isolated browser acceptance; no business API access.
window.facadeSample={exportModel,select:id=>select(model.components.find(m=>m.name===id)||null),state:()=>({view,selected:selected?.name||null,frames,visible,disposed,lost,soft,components:model.components.length,dimensions:SAMPLE.dimensions,camera:camera.position.toArray(),target:controls?.target.toArray()}),snapshot:()=>{const asset=portableAsset();try{return asset.toJSON();}finally{disposeAssetMaterials(asset);}}};
function cleanup(){disposed=true;environmentRequest++;if(raf)cancelAnimationFrame(raf);observer.disconnect();resizer.disconnect();document.removeEventListener('visibilitychange',visibility);controls?.dispose();removeOutline();environment?.dispose();model.group.traverse(o=>o.geometry?.dispose());for(const m of Object.values(model.materials))m.dispose();ground.geometry.dispose();ground.material.dispose();renderer?.dispose();}
window.addEventListener('pagehide',cleanup,{once:true});
window.addEventListener('pageshow',event=>{if(event.persisted&&disposed)location.reload();});
setup();
