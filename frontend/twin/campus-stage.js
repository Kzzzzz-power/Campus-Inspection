import {initDesignControls} from './campus-design-controls.js';
import {createTwinStore} from './twin-store.js';
import {CAMPUS_LAYOUT} from './campus-layout.js';
import {facilityState,coverageState,matchesPoint} from '../model.js';

const qualityNames={live:'新鲜观察',stale:'最后已知 · 已过期',missing:'暂无远程观察',disabled:'实时未启用',connecting:'正在同步'};
const reviewNames={pending:'待复核',completed:'已完成确认',timeout:'已超时',cancelled:'已取消'};
const conditionNames={NORMAL:'正常',WARNING:'警告',FAULT:'故障'};
const availabilityNames={AVAILABLE:'可用',UNAVAILABLE:'不可用',UNKNOWN:'可用性未知'};
const palette={normal:0x167c78,alarm:0xa34532,unknown:0x6b7d89,missing:0xa46720,covered:0x167c78};
const fmt=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未提供';
function dom(tag,attrs={},...children){const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='class')e.className=v;else if(k==='text')e.textContent=v;else e.setAttribute(k,v);}e.append(...children);return e;}
function text(e,value){if(e.textContent!==value)e.textContent=value;}
export function initCampusStage({getPoints,getRealtime,onSelect,onEnter,onReturn}){
 const host=document.getElementById('campus-stage');if(!host)return{sync(){},filter(){}};
 const store=createTwinStore(),markers=new Map(),films=new Map(),events=new AbortController();
 const viewport=host.querySelector('.twin-viewport'),markerLayer=host.querySelector('.twin-markers'),filmstrip=host.querySelector('.twin-filmstrip');
 const inspector=host.querySelector('#twin-inspector'),live=host.querySelector('#twin-announcement'),enter=host.querySelector('#twin-enter'),back=host.querySelector('#twin-back'),enable=host.querySelector('#twin-enable-3d');
 const inspectorToggle=dom('button',{type:'button',class:'twin-inspector-toggle','aria-expanded':'true','aria-label':'收起点位依据'},'收起');
 inspector.querySelector('h3').append(inspectorToggle);
 inspectorToggle.addEventListener('click',()=>{const expanded=inspectorToggle.getAttribute('aria-expanded')==='true';inspectorToggle.setAttribute('aria-expanded',String(!expanded));inspectorToggle.setAttribute('aria-label',expanded?'展开点位依据':'收起点位依据');inspectorToggle.textContent=expanded?'展开':'收起';inspector.querySelector('dl').hidden=expanded;inspector.querySelector('.twin-inspector-note').hidden=expanded;});
 const leaders=document.createElementNS('http://www.w3.org/2000/svg','svg');leaders.setAttribute('class','twin-leaders');leaders.setAttribute('aria-hidden','true');markerLayer.prepend(leaders);
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),mobile=matchMedia('(max-width:767px)');
 let selected=null,layer='remote',filters={query:'',scope:'all',required:'all',status:'all'},snapshot=store.getSnapshot(),disposed=false;
 let renderer,scene,camera,controls,THREE,campus,pointScene,makePoint,beaconGroup,beacons=new Map(),frame=0,flight=null,visible=true,loading=false,overlay=false;
 let observer,resizeObserver,roomControls,savedOverview=null,sunLight,daylight,fillLight,skyLight;
 const curtain=dom('div',{class:'twin-curtain','aria-hidden':'true'});viewport.append(curtain);
 const viewTools=dom('div',{class:'twin-view-tools',role:'group','aria-label':'视角控制'});
 for(const [action,title]of [['zoom-in','放大'],['zoom-out','缩小'],['reset','复位视角']])viewTools.append(dom('button',{type:'button','data-view-action':action},title));
 viewport.append(viewTools);
 const roomTools=dom('div',{class:'twin-room-tools',role:'group','aria-label':'室内移动',hidden:''});
 for(const[action,title]of [['left','左转'],['forward','前进'],['back','后退'],['right','右转']])roomTools.append(dom('button',{type:'button','data-room-action':action},title));
 const roomHelp=dom('p',{class:'twin-camera-help'},'拖动旋转 · 滚轮缩放');viewport.append(roomTools,roomHelp);
 let overviewPosition=[46,44,63],overviewTarget=[0,0,0];
 const on=(target,type,fn)=>target.addEventListener(type,fn,{signal:events.signal});
 let environmentLoad=0;
 const design=initDesignControls({host,getScene:()=>({THREE,renderer,scene,camera,controls,campus,pointScene,selected,sunLight,fillLight,skyLight,resetCampus:()=>{fitCampus();invalidate();}}),fly,invalidate,
  modeChanged:open=>{if(!pointScene?.interior)return;roomControls.setEnabled(!open&&!overlay);controls.enabled=open&&!overlay;controls.enablePan=open;controls.minDistance=open?3:.1;controls.maxDistance=open?35:12;camera.fov=open?42:61;camera.updateProjectionMatrix();syncCameraTools();}
 });
 const walkingRoom=()=>!!pointScene?.interior&&!design.roofOpen;
 async function upgradeEnvironment(){
  const load=++environmentLoad;try{const {loadSampleHDREnvironment}=await import('../facade-sample/lighting.js');if(disposed||load!==environmentLoad)return;const next=await loadSampleHDREnvironment(renderer,()=>!disposed&&load===environmentLoad);if(!next)return;const previous=daylight;daylight=next;scene.environment=next.texture;scene.userData.hdrRotation=next.rotation;host.dataset.environment='hdr';design.applyLight();previous?.dispose();invalidate();}
  catch(error){if(!disposed&&load===environmentLoad){host.dataset.environment='fallback';console.info('Local environment fallback:',error.message);}}
 }

 const motion=()=>!reduced.matches&&document.documentElement.dataset.motion!=='off';
 function selectedNode(){return snapshot.byId?.get(selected)||null;}
 function label(node){
  if(layer==='coverage')return coverageState(node.point)[0];
  if(layer==='review')return node.review?reviewNames[node.review.effective_status||node.review.status]||'复核状态未知':'尚未发起复核';
  if(node.quality!=='live')return qualityNames[node.quality]||'状态未知';
  return facilityState(node.projectedPoint)[0];
 }
 function tone(node){
  if(layer==='coverage')return node.coverage==='covered'?'covered':node.coverage==='missing'?'missing':'unknown';
  if(layer==='review')return (node.review?.effective_status||node.review?.status)==='pending'?'missing':(node.review?.effective_status||node.review?.status)==='completed'?'covered':'unknown';
  return node.quality!=='live'?'unknown':node.currentAlarm===true?'alarm':node.currentAlarm===false?'normal':'unknown';
 }
 function updateInspector(){
  const node=selectedNode();inspector.hidden=!node;back.hidden=!node;enter.disabled=!node;host.dataset.selected=selected||'';
  host.querySelector('#twin-scene-title').textContent=node?`${node.pointId} · ${node.point.device}`:'校园设施空间总览';
  if(!node)return;
  const concept=host.querySelector('.twin-fallback-device');concept.src='/static/assets/campus/'+node.pointId+'.svg';concept.alt=node.point.device+'概念示意，非现场照片';
  const p=node.point,o=node.observation,rows=[['位置',`${p.building} · ${p.floor} / ${p.zone_id}`],['资产',node.facilityId],['数据质量',qualityNames[node.quality]||'状态未知'],['远程观察',o?`${availabilityNames[o.availability]} / ${conditionNames[o.condition]}${node.quality==='live'?'':'（最后已知，非当前结论）'}`:'未提供'],['观测时间',fmt(o?.observed_at)],['接收时间',fmt(node.receivedAt)],['数据来源',o?.source_type==='SIMULATED'?'SIMULATED · 教学模拟':o?.source_type==='DEVICE'?'DEVICE · 设备源':'未提供'],['现场覆盖',coverageState(p)[0]],['复核处理',node.review?(reviewNames[node.review.effective_status||node.review.status]||'复核状态未知'):'尚未发起']];
  if(node.review?.conclusion)rows.push(['复核结论',({normal:'确认正常',fault:'确认异常',unknown:'仍无法确认'})[node.review.conclusion]||'未识别结论']);
  if(o)for(const[key,value]of Object.entries(o.metrics||{}))rows.push([key,String(value)+(key==='latency_ms'?' ms':'')]);
  const list=inspector.querySelector('dl');list.replaceChildren(...rows.flatMap(([key,value])=>[dom('dt',{},key),dom('dd',{},value)]));
 }
 function publish(){
  snapshot=store.getSnapshot();const nodes=snapshot.nodes||[],ids=new Set(nodes.map(n=>n.pointId));
  for(const[id,el]of markers)if(!ids.has(id)){el.remove();markers.delete(id);films.get(id)?.remove();films.delete(id);}
  if(selected&&!ids.has(selected))returnCampus(false);
  for(const node of nodes){
   if(!CAMPUS_LAYOUT[node.pointId])continue;
   let marker=markers.get(node.pointId),film=films.get(node.pointId);
   if(!marker){
    marker=dom('button',{type:'button',class:'twin-marker','data-point-id':node.pointId,'data-twin-id':node.twinId},dom('span',{class:'twin-marker-code'},node.pointId),dom('span',{class:'twin-marker-name'},node.point.device));
    marker.addEventListener('click',()=>select(node.pointId));markers.set(node.pointId,marker);markerLayer.append(marker);
    film=dom('button',{type:'button',class:'twin-film','data-point-id':node.pointId},dom('img',{src:`/static/assets/campus/${node.pointId}.svg`,alt:`${node.point.device}概念示意`,width:'180',height:'112'}),dom('span',{class:'twin-film-caption'},dom('b',{},node.pointId),dom('span',{},node.point.device)),dom('small',{class:'twin-film-status'}),dom('small',{class:'twin-concept'},'概念示意'));
    film.addEventListener('click',()=>select(node.pointId));films.set(node.pointId,film);filmstrip.append(film);
   }
   for(const element of [marker,film]){element.dataset.quality=node.quality;element.dataset.alarm=node.currentAlarm===null?'unknown':String(node.currentAlarm);element.dataset.tone=tone(node);element.setAttribute('aria-pressed',String(selected===node.pointId));element.setAttribute('aria-label',`${node.pointId} ${node.point.device}，${label(node)}，${qualityNames[node.quality]}`);element.classList.toggle('is-filtered',!matchesPoint(node.projectedPoint,filters));}
   text(film.querySelector('.twin-film-status'),label(node));
  }
  host.querySelector('#twin-empty').hidden=nodes.length>0;
  const c=snapshot.counts||{};
  text(host.querySelector('#twin-hud'),`全范围点位 ${c.total||0} · 新鲜 ${c.fresh||0} · 过期 ${c.stale||0} · 当前告警 ${c.alarm||0}`);
  const broker=snapshot.brokerState||'connecting',connection=snapshot.connection||'connecting';
  text(host.querySelector('#twin-quality'),`WebSocket ${connection} / Broker ${broker} · ${snapshot.transport==='http'?'HTTP 快照':snapshot.transport==='websocket'?'WebSocket 推送':'等待快照'} · ${broker==='disabled'?'实时未启用':`模拟源 ${c.simulated||0} / 设备源 ${c.device||0}`}`);
  text(host.querySelector('#twin-updated'),`快照时间 ${fmt(snapshot.asOf)}`);
  updateInspector();syncBeacons();positionMarkers();invalidate();
 }
 function syncBeacons(){
  if(!beaconGroup)return;
  for(const[id,mesh]of beacons)if(!snapshot.byId.has(id)){beaconGroup.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();beacons.delete(id);}
  for(const node of snapshot.nodes){if(!CAMPUS_LAYOUT[node.pointId])continue;let mesh=beacons.get(node.pointId);
   if(!mesh){mesh=new THREE.Mesh(new THREE.CylinderGeometry(.105,.105,1.3,12),new THREE.MeshBasicMaterial({color:palette.unknown}));mesh.position.fromArray(CAMPUS_LAYOUT[node.pointId].position);mesh.position.y+=.65;mesh.userData={twinId:node.twinId,pointId:node.pointId,facilityId:node.facilityId,zoneId:node.zoneId};beacons.set(node.pointId,mesh);beaconGroup.add(mesh);}
   mesh.material.color.setHex(palette[tone(node)]);mesh.visible=!selected||node.pointId===selected;
  }
 }
 function positionMarkers(){
  const w=viewport.clientWidth,h=viewport.clientHeight;
  if(!w||!h)return;
  leaders.setAttribute('viewBox',`0 0 ${w} ${h}`);
  leaders.style.display=selected?'none':'';
  const projected=[];
  // Batch measurements before positioning labels; avoid interleaved layout reads/writes.
  for(const[id,marker]of markers){
   marker.hidden=!!selected;if(selected)continue;
   const pos=CAMPUS_LAYOUT[id].position;
   let x,y;
   if(renderer&&camera&&host.dataset.renderer==='webgl'){
    const v=new THREE.Vector3(pos[0],pos[1]+1.1,pos[2]).project(camera);x=(v.x*.5+.5)*w;y=(-v.y*.5+.5)*h;
   }else{const fallback={C01:[14,37],C02:[26,31],C03:[38,37],C04:[55,70],C05:[68,77],C06:[81,70],C07:[65,24],C08:[82,31]}[id];x=fallback[0]*w/100;y=fallback[1]*h/100;}
   projected.push({id,marker,x,y,width:marker.offsetWidth,height:marker.offsetHeight});
  }
  projected.sort((a,b)=>a.y-b.y||a.x-b.x);
  const viewportRect=viewport.getBoundingClientRect();
  const occupied=[...viewport.querySelectorAll('.twin-view-tools,.twin-camera-help,.twin-map-label,.twin-orientation,#twin-enable-3d')].filter(e=>!e.hidden&&e.offsetWidth>0).map(e=>{const r=e.getBoundingClientRect();return{left:r.left-viewportRect.left,right:r.right-viewportRect.left,top:r.top-viewportRect.top,bottom:r.bottom-viewportRect.top};}),segments=[];
  for(const p of projected){
   let chosen;
   for(const column of [0,-1,1,-2,2]){
    for(const row of [0,-1,1,-2,2,-3,3,-4,4]){
     const x=Math.max(p.width/2+8,Math.min(w-p.width/2-8,p.x+column*(p.width+12)));
     const y=p.y+row*(p.height+10);
     const box={left:x-p.width/2,right:x+p.width/2,top:y-p.height,bottom:y};
     if(box.top<10||box.bottom>h-18)continue;
     if(occupied.some(b=>box.left<b.right+6&&box.right>b.left-6&&box.top<b.bottom+6&&box.bottom>b.top-6))continue;
     chosen={x,y,box};break;
    }
    if(chosen)break;
   }
   chosen??={x:Math.max(p.width/2,Math.min(w-p.width/2,p.x)),y:Math.max(p.height+10,Math.min(h-18,p.y))};
   if(chosen.box)occupied.push(chosen.box);
   p.marker.style.transform=`translate3d(${chosen.x}px,${chosen.y}px,0) translate(-50%,-100%)`;
   const line=p.marker._leader||(p.marker._leader=document.createElementNS('http://www.w3.org/2000/svg','line'));
   line.setAttribute('x1',chosen.x);line.setAttribute('y1',chosen.y-p.height/2);
   line.setAttribute('x2',p.x);line.setAttribute('y2',p.y+12);segments.push(line);
  }
  if(segments.length!==leaders.childElementCount||segments.some((line,i)=>leaders.children[i]!==line))leaders.replaceChildren(...segments);
 }
 function invalidate(){if(!frame&&!disposed&&visible&&!document.hidden&&!overlay&&renderer&&host.dataset.renderer==='webgl')frame=requestAnimationFrame(render);}
 function render(now){
  frame=0;if(disposed||document.hidden||!visible||overlay||!renderer)return;
  if(flight){const current=flight,t=Math.min(1,(now-current.start)/current.duration),k=t*t*(3-2*t);camera.position.lerpVectors(current.from,current.to,k);controls.target.lerpVectors(current.targetFrom,current.targetTo,k);camera.lookAt(controls.target);if(t>=1){flight=null;host.dataset.transition='idle';current.complete?.();controls.enabled=!overlay&&!flight&&!walkingRoom();syncCameraTools();}}
  const walking=roomControls?.tick(now),decorative=design.tick(now,motion());
  if(!walkingRoom()&&!flight)controls.update();
  if(!selected)host.dataset.lod=campus.updateLOD?.(camera.position.distanceTo(controls.target))||'detailed';renderer.info.reset();renderer.render(scene,camera);host.dataset.fanAngle=String(pointScene?.fan?.rotation.z||0);host.dataset.calls=String(renderer.info.render.calls);host.dataset.triangles=String(renderer.info.render.triangles);host.dataset.camera=camera.position.toArray().map(n=>n.toFixed(3)).join(',');positionMarkers();
  if(flight||walking||decorative)invalidate();
 }
 function fly(position,target,duration=1000,complete){
  if(!renderer){complete?.();return;}const to=new THREE.Vector3(...position),targetTo=new THREE.Vector3(...target);
  if(!motion()||!visible||document.hidden||overlay||host.dataset.renderer!=='webgl'){camera.position.copy(to);controls.target.copy(targetTo);camera.lookAt(targetTo);flight=null;host.dataset.transition='idle';complete?.();controls.enabled=!overlay&&!flight&&!walkingRoom();}
  else{controls.enabled=false;flight={from:camera.position.clone(),to,targetFrom:controls.target.clone(),targetTo,start:performance.now(),duration,complete};host.dataset.transition='flying';}
  syncCameraTools();invalidate();
 }
 function fitCampus(){
  if(!campus||!renderer)return;
  const bounds=campus.bounds||new THREE.Box3().setFromObject(campus.group),center=bounds.getCenter(new THREE.Vector3());const extent=bounds.getSize(new THREE.Vector3());center.y=.7;center.x+=extent.x*.045;center.z+=extent.z*.08;
  const direction=new THREE.Vector3(.56,.65,1.1).normalize(),corners=[];
  for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])corners.push(new THREE.Vector3(x,y,z));
  camera.fov=42;camera.updateProjectionMatrix();let low=20,high=180;
  for(let i=0;i<20;i++){const distance=(low+high)/2;camera.position.copy(center).addScaledVector(direction,distance);camera.lookAt(center);camera.updateMatrixWorld();const projected=corners.map(c=>c.clone().project(camera));
   if(projected.some(p=>Math.abs(p.x)>.94||Math.abs(p.y)>.88||p.z>1||p.z<0))low=distance;else high=distance;
  }
  camera.position.copy(center).addScaledVector(direction,high*(mobile.matches?1:.92));controls.target.copy(center);camera.lookAt(center);overviewPosition=camera.position.toArray();overviewTarget=center.toArray();
 }
 function releaseRoom(){roomControls?.leave();if(pointScene){scene.remove(pointScene.group);pointScene.dispose();pointScene=null;}}
 function syncCameraTools(){const inside=!!walkingRoom();host.dataset.interior=String(inside);roomTools.hidden=!inside||host.dataset.renderer!=='webgl';viewTools.hidden=host.dataset.renderer!=='webgl';
  for(const e of viewTools.querySelectorAll('[data-view-action]')){e.hidden=inside&&e.dataset.viewAction!=='reset';e.disabled=!!flight;}for(const e of roomTools.querySelectorAll('button'))e.disabled=!!flight;
  text(roomHelp,host.dataset.renderer!=='webgl'?'点击点位编号查看 · 可开启 3D':inside?'拖动观察 · 点击走道移动 · 方向键 / WASD':selected?'拖动旋转 · 滚轮缩放':'拖动旋转 · 滚轮缩放 · 点击信标进入');
 }
 function showRoom(id){
  releaseRoom();pointScene=makePoint(id);scene.add(pointScene.group);campus.group.visible=false;beaconGroup.visible=false;
  scene.environmentIntensity=.65;skyLight.intensity=1.0;fillLight.intensity=.65;sunLight.intensity=2.1;
  renderer.shadowMap.needsUpdate=true;Object.assign(sunLight.shadow.camera,{left:-12,right:12,top:12,bottom:-12});sunLight.shadow.camera.updateProjectionMatrix();
  design.sceneChanged();const inside=!!pointScene.interior;controls.enabled=!inside&&!overlay;controls.enablePan=false;controls.minDistance=inside ? .1 : 4;controls.maxDistance=inside ? 12 : 65;
  camera.fov=inside?61:42;camera.updateProjectionMatrix();
  syncCameraTools();
  if(inside){
   pointScene.setDoorOpen?.(1);camera.position.copy(pointScene.entryPosition||pointScene.cameraPosition);controls.target.copy(pointScene.target);camera.lookAt(pointScene.target);
   fly(pointScene.cameraPosition.toArray(),pointScene.target.toArray(),450,()=>{pointScene?.setDoorOpen?.(0);renderer.shadowMap.needsUpdate=true;roomControls.enter(pointScene);roomControls.setEnabled(!overlay);});
  }else fly(pointScene.cameraPosition.toArray(),pointScene.target.toArray(),750);
  if(motion()){curtain.getAnimations().forEach(a=>a.cancel());curtain.animate([{opacity:.85},{opacity:0}],{duration:250,easing:'ease-out'});}
  invalidate();
 }
 function activatePoint(id,fromCampus=false){
  if(!renderer||!makePoint||host.dataset.renderer!=='webgl')return;
  flight=null;roomControls?.leave();controls.enabled=false;
  if(fromCampus&&motion()&&host.dataset.renderer==='webgl'){
   const entry=CAMPUS_LAYOUT[id].entryPosition||CAMPUS_LAYOUT[id].position,approach=[entry[0],entry[1],entry[2]];
   fly(approach,[entry[0],entry[1],entry[2]-3],750,()=>{if(selected===id)showRoom(id);});
  }else showRoom(id);
 }
 function select(id){
  const node=snapshot.byId?.get(id);if(!node||!CAMPUS_LAYOUT[id])return;
  const fromCampus=!selected;
  if(fromCampus&&camera)savedOverview=flight?.returning?{position:flight.to.toArray(),target:flight.targetTo.toArray()}:{position:camera.position.toArray(),target:controls.target.toArray()};
  selected=id;host.dataset.mode='point';host.dataset.scene=CAMPUS_LAYOUT[id].sceneKind;
  activatePoint(id,fromCampus);onSelect?.(node.point);publish();text(live,`已选择 ${id} ${node.point.device}。可进入巡查或返回校园。`);
  back.focus({preventScroll:true});
 }
 function returnCampus(focus=true){
  const wasInside=!!pointScene;
  const previous=selected;selected=null;flight=null;curtain.getAnimations().forEach(a=>a.cancel());host.dataset.mode='campus';host.dataset.scene='campus';
  releaseRoom();
  if(campus){scene.environmentIntensity=.45;skyLight.intensity=.85;fillLight.intensity=.35;sunLight.intensity=2.5;renderer.shadowMap.needsUpdate=true;Object.assign(sunLight.shadow.camera,{left:-48,right:48,top:42,bottom:-42});sunLight.shadow.camera.updateProjectionMatrix();campus.group.visible=true;beaconGroup.visible=true;controls.enabled=!overlay;controls.minDistance=15;controls.maxDistance=160;camera.fov=42;camera.updateProjectionMatrix();
   const pose=savedOverview||{position:overviewPosition,target:overviewTarget};
   if(wasInside){const entry=CAMPUS_LAYOUT[previous]?.entryPosition||CAMPUS_LAYOUT[previous]?.position;if(entry){camera.position.set(entry[0],entry[1]+4,entry[2]+8);controls.target.set(entry[0],entry[1]+1,entry[2]-3);camera.lookAt(controls.target);}if(motion())curtain.animate([{opacity:1},{opacity:0}],{duration:280,easing:'ease-out'});}
   fly(pose.position,pose.target,950);if(flight)flight.returning=true;}
  design.sceneChanged();syncCameraTools();onReturn?.();publish();if(focus)(films.get(previous)||markers.values().next().value)?.focus({preventScroll:true});text(live,'已返回校园总览');
 }
 function fallback(reason){
  roomControls?.setEnabled(false);roomTools.hidden=true;viewTools.hidden=true;text(roomHelp,'点击点位编号查看 · 可开启 3D');
  if(flight){camera.position.copy(flight.to);controls.target.copy(flight.targetTo);}flight=null;host.dataset.transition='idle';
  host.dataset.renderer='fallback';host.querySelector('#twin-render-message').textContent=reason;enable.hidden=false;enable.disabled=false;enable.textContent='开启 3D';text(host.querySelector('.twin-orientation'),'示意');
  host.querySelector('#campus-canvas')?.setAttribute('hidden','');positionMarkers();
 }
 async function start3d(){
  if(loading||renderer||disposed)return;loading=true;enable.disabled=true;text(host.querySelector('#twin-render-message'),'正在加载校园三维场景…');
  try{
   const [three,orbit,models,roomModule,lighting]=await Promise.all([import('../vendor/three/three.module.js'),import('../vendor/three/OrbitControls.js'),import('./campus-scenes.js'),import('./room-controls.js'),import('./architectural-lighting.js')]);
   if(disposed)return;THREE=three;makePoint=models.createPointScene;
   renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'default'});renderer.setPixelRatio(Math.min(devicePixelRatio||1,mobile.matches?1.25:1.6));
   renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.08;renderer.shadowMap.enabled=!mobile.matches;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;renderer.info.autoReset=false;
   renderer.domElement.id='campus-canvas';renderer.domElement.setAttribute('aria-hidden','true');viewport.prepend(renderer.domElement);
   scene=new THREE.Scene();scene.background=new THREE.Color(0xe2ecef);scene.fog=new THREE.Fog(0xe2ecef,100,245);camera=new THREE.PerspectiveCamera(42,1,.06,300);camera.position.fromArray(overviewPosition);
   daylight=lighting.createDaylightEnvironment(renderer);scene.environment=daylight.texture;scene.environmentIntensity=.45;
   skyLight=new THREE.HemisphereLight(0xe9f3ff,0xd6ddd3,.85);scene.add(skyLight);fillLight=new THREE.DirectionalLight(0xf5f7ff,.35);fillLight.position.set(18,12,-20);scene.add(fillLight);
   const key=sunLight=new THREE.DirectionalLight(0xfff6e9,2.5);key.position.set(-35,55,30);key.castShadow=true;key.shadow.mapSize.set(mobile.matches?1024:2048,mobile.matches?1024:2048);Object.assign(key.shadow.camera,{left:-48,right:48,top:42,bottom:-42,near:1,far:150});key.shadow.bias=-.00015;key.shadow.normalBias=.008;key.shadow.camera.updateProjectionMatrix();scene.add(key);
   controls=new orbit.OrbitControls(camera,renderer.domElement);controls.target.fromArray(overviewTarget);controls.enableDamping=false;controls.enablePan=false;controls.minDistance=15;controls.maxDistance=160;controls.minPolarAngle=.2;controls.maxPolarAngle=Math.PI*.46;
   controls.addEventListener('change',()=>{design.constrain();invalidate();});controls.addEventListener('start',()=>{flight=null;host.dataset.transition='idle';});
   const {loadCampusAsset}=await import('./campus-asset.js');campus=await loadCampusAsset();if(disposed){campus.dispose();return;}host.dataset.asset=campus.assetType;host.dataset.assetBytes=String(campus.assetBytes);scene.add(campus.group);beaconGroup=new THREE.Group();scene.add(beaconGroup);
   roomControls=roomModule.createRoomControls({camera,canvas:renderer.domElement,viewport,invalidate,motion,announce:message=>text(live,message)});
   const resize=()=>{if(!renderer)return;const w=viewport.clientWidth,h=viewport.clientHeight;if(!w||!h)return;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();if(!selected)fitCampus();invalidate();};
   resizeObserver=new ResizeObserver(resize);resizeObserver.observe(viewport);resize();
   on(renderer.domElement,'webglcontextlost',event=>{event.preventDefault();cancelAnimationFrame(frame);frame=0;fallback('三维上下文暂不可用 · 当前为简化示意视图');enable.disabled=true;});
   on(renderer.domElement,'webglcontextrestored',()=>{daylight?.dispose();daylight=lighting.createDaylightEnvironment(renderer);scene.environment=daylight.texture;upgradeEnvironment();renderer.shadowMap.needsUpdate=true;renderer.domElement.hidden=false;host.dataset.renderer='webgl';text(host.querySelector('.twin-orientation'),'3D');enable.hidden=true;text(host.querySelector('#twin-render-message'),'空间分组示意 · 非真实平面图');if(selected)activatePoint(selected);else{releaseRoom();campus.group.visible=true;beaconGroup.visible=true;controls.enabled=!overlay;fitCampus();}syncCameraTools();invalidate();});
   host.dataset.renderer='webgl';text(host.querySelector('.twin-orientation'),'3D');enable.hidden=true;enable.disabled=false;text(host.querySelector('#twin-render-message'),'空间分组示意 · 非真实平面图');syncBeacons();design.sceneChanged();upgradeEnvironment();if(selected)activatePoint(selected);syncCameraTools();invalidate();
  }catch(error){roomControls?.dispose();resizeObserver?.disconnect();controls?.dispose();pointScene?.dispose();campus?.dispose();daylight?.dispose();for(const mesh of beacons.values()){mesh.geometry.dispose();mesh.material.dispose();}beacons.clear();beaconGroup=null;campus=null;pointScene=null;renderer?.domElement.remove();renderer?.dispose();renderer=null;fallback('3D 加载失败 · 简化示意仍可进入巡查');console.warn('Campus 3D unavailable:',error.message);}
  finally{loading=false;}
 }
 on(back,'click',()=>returnCampus());
 on(viewTools,'click',e=>{const action=e.target.closest('[data-view-action]')?.dataset.viewAction;if(!action||!camera)return;if(walkingRoom()){roomControls.action('reset');return;}flight=null;host.dataset.transition='idle';if(action==='reset'){if(selected)activatePoint(selected);else{fitCampus();savedOverview=null;}}else{const offset=camera.position.clone().sub(controls.target);offset.multiplyScalar(action==='zoom-in' ? .82 : 1.2);offset.clampLength(controls.minDistance,controls.maxDistance);camera.position.copy(controls.target).add(offset);}invalidate();});
 on(roomTools,'click',e=>{const action=e.target.closest('[data-room-action]')?.dataset.roomAction;if(action)roomControls?.action(action);});
 on(enter,'click',()=>{const node=selectedNode();if(node)onEnter?.(node.point);});
 on(enable,'click',start3d);
 for(const b of host.querySelectorAll('[data-twin-layer]'))on(b,'click',()=>{layer=b.dataset.twinLayer;host.dataset.layer=layer;for(const other of host.querySelectorAll('[data-twin-layer]'))other.setAttribute('aria-pressed',String(other===b));text(host.querySelector('#twin-legend'),layer==='remote'?'实线：新鲜观察 · 虚线：过期 · 空心：未知 · 红褐：当前告警':layer==='coverage'?'青色：现场记录有效 · 琥珀：待补检 · 灰色：普通点':'琥珀：待复核 · 青色：已完成确认 · 灰色：未发起或已结束');publish();});
 on(document,'keydown',event=>{if(event.key==='Escape'&&selected&&!document.querySelector('dialog[open]')){event.preventDefault();returnCampus();}});
 on(document,'inspectgo:overlay',event=>{overlay=event.detail.open;if(controls)controls.enabled=!overlay&&!flight&&!walkingRoom();roomControls?.setEnabled(!overlay&&walkingRoom()&&host.dataset.transition!=='flying');if(overlay){cancelAnimationFrame(frame);frame=0;}else invalidate();});
 const stopMotion=()=>{invalidate();if(flight&&(!motion()||!visible||document.hidden)){camera.position.copy(flight.to);controls.target.copy(flight.targetTo);camera.lookAt(flight.targetTo);const complete=flight.complete;flight=null;host.dataset.transition='idle';complete?.();controls.enabled=!overlay&&!flight&&!walkingRoom();syncCameraTools();invalidate();}};
 on(document,'inspectgo:feedback',stopMotion);on(reduced,'change',stopMotion);
 on(document,'visibilitychange',()=>{if(document.hidden){stopMotion();cancelAnimationFrame(frame);frame=0;}else invalidate();});
 observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(!visible){stopMotion();cancelAnimationFrame(frame);frame=0;}else invalidate();});observer.observe(viewport);
 on(window,'resize',positionMarkers);
 function dispose(){disposed=true;environmentLoad++;design.dispose();cancelAnimationFrame(frame);events.abort();observer.disconnect();resizeObserver?.disconnect();unsubscribe();roomControls?.dispose();controls?.dispose();pointScene?.dispose();campus?.dispose();daylight?.dispose();for(const mesh of beacons.values()){mesh.geometry.dispose();mesh.material.dispose();}renderer?.dispose();}
 on(window,'pagehide',event=>{if(!event.persisted)dispose();else{cancelAnimationFrame(frame);frame=0;}});on(window,'pageshow',invalidate);
 const unsubscribe=store.subscribe(publish);
 if(mobile.matches)fallback('轻量空间示意 · 可开启 3D');else start3d();
 return{sync(){store.sync(getPoints(),getRealtime());},filter(next){filters={...next};publish();},dispose};
}
