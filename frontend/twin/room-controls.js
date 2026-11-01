import * as THREE from '../vendor/three/three.module.js';
import {planWalk} from './room-navigation.js';
export function createRoomControls({camera,canvas,viewport,invalidate,motion,announce,onDoor}){
 const events=new AbortController(),ray=new THREE.Raycaster(),plane=new THREE.Plane(new THREE.Vector3(0,1,0),-.06),hit=new THREE.Vector3();
 let model=null,enabled=false,drag=null,route=null,lastTime=0,arrival=null;
 const on=(target,type,fn,options={})=>target.addEventListener(type,fn,{...options,signal:events.signal});
 function look(dx,dy){if(camera.rotation.order!=='YXZ')camera.rotation.reorder('YXZ');camera.rotation.y-=dx*.003;camera.rotation.x=THREE.MathUtils.clamp(camera.rotation.x-dy*.003,-1.08,1.08);camera.rotation.z=0;invalidate();}
 function walk(to){if(!enabled||!model)return;arrival=null;const path=planWalk(camera.position,to,model);if(!path){announce('这里没有可通行的路径，请选择走道。');return;}
  if(!motion()){camera.position.x=to.x;camera.position.z=to.z;route=null;}else{route=path.slice(1);lastTime=0;}invalidate();
 }
 function action(name){if(!enabled||!model)return;
  if(name==='left'||name==='right'){look(name==='left'?-110:110,0);return;}
  if(name==='reset'){route=null;arrival=null;camera.position.copy(model.cameraPosition);camera.lookAt(model.target);invalidate();return;}
  const forward=new THREE.Vector3();camera.getWorldDirection(forward);forward.y=0;forward.normalize().multiplyScalar(name==='back'?-0.85:.85);walk(camera.position.clone().add(forward));
 }
 on(canvas,'pointerdown',e=>{if(!enabled||e.button!==0)return;viewport.focus({preventScroll:true});drag={id:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false};route=null;arrival=null;canvas.setPointerCapture(e.pointerId);});
 on(canvas,'pointermove',e=>{if(!enabled||!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>5)drag.moved=true;if(drag.moved)look(dx,dy);drag.x=e.clientX;drag.y=e.clientY;});
 on(canvas,'pointerup',e=>{if(!drag||drag.id!==e.pointerId)return;const clicked=!drag.moved;drag=null;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);if(!enabled||!clicked)return;
  const r=canvas.getBoundingClientRect();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),camera);
  const hits=ray.intersectObject(model.group,true);const first=hits[0]?.object;
  if(first){let parent=first;while(parent&&parent!==model.group){if(parent===model.door||parent===model.portal){onDoor?.(parent===model.portal?'portal':'door');return;}parent=parent.parent;}}
  if(ray.ray.intersectPlane(plane,hit))walk(hit);
 });
 on(canvas,'pointercancel',()=>{drag=null;});
 on(viewport,'keydown',e=>{if(!enabled||e.target!==viewport)return;const name={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'forward',ArrowDown:'back',w:'forward',s:'back',a:'left',d:'right',Home:'reset'}[e.key];if(name){e.preventDefault();action(name);}});
 return{
  enter(next){model=next;enabled=true;route=null;viewport.tabIndex=0;viewport.setAttribute('aria-label','房间漫游：拖动观察，点击地面移动；方向键移动或转向，Home 复位');},
  leave(){model=null;enabled=false;route=null;arrival=null;drag=null;viewport.removeAttribute('tabindex');viewport.setAttribute('aria-label','校园空间展示');},
  setEnabled(value){enabled=value&&!!model;if(!enabled){route=null;drag=null;arrival=null;}},
  action,
  exit(callback){if(!enabled||!model)return;const path=planWalk(camera.position,model.entryPosition,model);if(!path){announce('请先回到入口走道。');return;}if(!motion()){camera.position.copy(model.entryPosition);callback();return;}route=path.slice(1);arrival=callback;lastTime=0;invalidate();},
  tick(now){if(!enabled||!route?.length)return false;if(!motion()){const end=route.at(-1);camera.position.x=end.x;camera.position.z=end.z;route=null;if(arrival){const done=arrival;arrival=null;done();}return false;}
   const dt=lastTime?Math.min((now-lastTime)/1000,.05):.016;lastTime=now;let travel=dt*2.8;
   while(route.length&&travel>0){const target=route[0],dx=target.x-camera.position.x,dz=target.z-camera.position.z,d=Math.hypot(dx,dz);
    if(d<=travel){camera.position.x=target.x;camera.position.z=target.z;travel-=d;route.shift();}else{camera.position.x+=dx/d*travel;camera.position.z+=dz/d*travel;travel=0;}}
   if(!route.length&&arrival){const done=arrival;arrival=null;done();}
   return !!route?.length;
  },
  dispose(){events.abort();route=null;model=null;}
 };
}