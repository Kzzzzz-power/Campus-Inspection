import test from 'node:test';
import * as THREE from '../frontend/vendor/three/three.module.js';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CAMPUS_LAYOUT,CAMPUS_BUILDINGS} from '../frontend/twin/campus-layout.js';
import {isWalkable} from '../frontend/twin/room-navigation.js';
import {createCampus,createPointScene} from '../frontend/twin/campus-scenes.js';
const facilities=JSON.parse(readFileSync(new URL('../config/facilities.json',import.meta.url),'utf8'));
function checkBudget(model,maxCalls,maxTriangles=30000){
 let calls=0,triangles=0,geometries=0,materials=0;
 model.group.traverse(object=>{
  if(!object.isMesh)return;
  calls++;const position=object.geometry.getAttribute('position');
  assert([...position.array].every(Number.isFinite));
  triangles+=(object.geometry.index?.count||position.count)/3;
  object.geometry.addEventListener('dispose',()=>geometries++);
  object.material.addEventListener('dispose',()=>materials++);
 });
 assert(calls>0&&calls<=maxCalls);assert(triangles<maxTriangles);
 model.dispose();model.dispose();assert.equal(geometries,calls);assert.equal(materials,calls);
}
test('conceptual layout matches the canonical eight assets and three conceptual buildings without changing canonical zones',()=>{
 assert.equal(CAMPUS_BUILDINGS.length,3);
 assert.deepEqual(Object.keys(CAMPUS_LAYOUT),facilities.map(p=>p.checkpoint_id));
 for(const p of facilities){const layout=CAMPUS_LAYOUT[p.checkpoint_id];assert.equal(layout.facilityId,p.facility_id);assert.equal(layout.zoneId,p.zone_id);assert(layout.position.every(Number.isFinite));assert(CAMPUS_BUILDINGS.find(b=>b.id===layout.buildingId).zoneIds.includes(p.zone_id));}
});
test('campus anchors match semantic points and meet geometry/resource budgets',()=>{
 const campus=createCampus();assert.equal(campus.anchors.size,8);
 for(const[id,layout]of Object.entries(CAMPUS_LAYOUT))assert.deepEqual(campus.anchors.get(id).toArray(),layout.position);
 checkBudget(campus,60,250000);
});
test('all eight independent equipment scenes have finite cameras and release resources',()=>{
 assert.equal(new Set(Object.values(CAMPUS_LAYOUT).map(p=>p.sceneKind)).size,8);
 for(const p of facilities){const model=createPointScene(p.checkpoint_id);assert(model.cameraPosition.toArray().every(Number.isFinite));assert(model.target.toArray().every(Number.isFinite));checkBudget(model,32);}
 assert.throws(()=>createPointScene('C99'));
});
test('all eight rooms have closed geometry, valid identity and walkable eye-level entry',()=>{
 for(const id of Object.keys(CAMPUS_LAYOUT)){const room=createPointScene(id);assert.equal(room.interior,true);for(const field of ["facilityId","zoneId","buildingId","floorId"])assert.equal(room.group.userData[field],CAMPUS_LAYOUT[id][field]);assert(room.roof);assert(room.door);assert(room.cameraPosition.y>1.4&&room.cameraPosition.y<1.9);assert(isWalkable(room.cameraPosition,room));assert(isWalkable(room.entryPosition,room));assert(room.obstacles.length>0);room.setDoorOpen(1);assert(Math.abs(room.door.rotation.y)>.5);room.setDoorOpen(0);assert.equal(Math.abs(room.door.rotation.y),0);room.dispose();}
});

test('entry doors are actual raycast targets; C05 portal swings independently of shell',()=>{
 for(const id of Object.keys(CAMPUS_LAYOUT)){
  const room=createPointScene(id);room.group.updateMatrixWorld(true);
  const target=room.door.localToWorld(new THREE.Vector3(.6,1.2,0)),origin=room.entryPosition.clone();
  const hit=new THREE.Raycaster(origin,target.clone().sub(origin).normalize()).intersectObject(room.group,true)[0];
  let object=hit?.object;while(object&&object!==room.door)object=object.parent;assert.equal(object,room.door,id+' door occluded');
  if(id==='C05'){assert(room.hasPortal);const shell=room.group.children.filter(o=>o!==room.portal).map(o=>o.matrixWorld.toArray());room.setPortalOpen(1);assert(room.portal.rotation.y>1);room.group.updateMatrixWorld(true);assert.deepEqual(room.group.children.filter(o=>o!==room.portal).map(o=>o.matrixWorld.toArray()),shell);}
  room.dispose();
 }
});


test('peripheral forest uses reproducible shared instances outside the operational campus',()=>{
 const a=createCampus(),b=createCampus();
 const forest=model=>model.group.children.filter(o=>o.isInstancedMesh);
 const left=forest(a),right=forest(b);assert.equal(left.length,1);assert.equal(right.length,1);
 for(let i=0;i<left.length;i++){
  assert(left[i].count>100);assert.equal(left[i].count,right[i].count);assert.deepEqual(left[i].instanceMatrix.array,right[i].instanceMatrix.array);
  assert(left[i].material.alphaTest>=.3,'The baked far-LOD crown must use a cutout material');
  for(let j=0;j<left[i].count;j++){const m=new THREE.Matrix4();left[i].getMatrixAt(j,m);const x=m.elements[12],z=m.elements[14];assert(x<-55||x>48||z<-61||z>44,'Forest instance intersects the operational campus');}
 }
 a.dispose();b.dispose();
});
