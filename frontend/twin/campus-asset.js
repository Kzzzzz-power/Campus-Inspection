import * as THREE from '../vendor/three/three.module.js';
import {GLTFLoader} from '../vendor/three/GLTFLoader.js';
import {MeshoptDecoder} from '../vendor/three/meshopt_decoder.module.js';
import {CAMPUS_BUILDINGS,CAMPUS_LAYOUT,CAMPUS_BOUNDS} from './campus-layout.js';
import {createArchitecturalCampus,warmCampusTextures} from './campus-architecture.js';

function withLOD(model){
 // Drop complete distant tree crowns; never perforate the volume into arbitrary triangles.
 const foliage=[];model.group.traverse(o=>{if(o.isMesh&&o.userData.materialKind==='foliage'&&!o.geometry.index){const indices=[];let tree=0;for(const c of o.userData.components||[]){if(c.role==='tree'&&tree++%2)continue;for(let i=c.start;i<c.start+c.count;i++)indices.push(i);}foliage.push({mesh:o,index:new THREE.Uint32BufferAttribute(indices,1)});}});
 const forests=[];model.group.traverse(o=>{if(o.isInstancedMesh&&o.userData.role==='forest')forests.push(o);});
 let far=false;model.updateLOD=(distance,compact=false)=>{const next=compact||(far?distance>180:distance>210);if(next!==far){far=next;for(const mesh of forests)mesh.count=far?Math.ceil(mesh.userData.fullCount*.35):mesh.userData.fullCount;for(const f of foliage)f.mesh.geometry.setIndex(far?f.index:null);}return far?'distant':'detailed';};const dispose=model.dispose;model.dispose=()=>{for(const f of foliage)f.mesh.geometry.setIndex(f.index);dispose();};return model;
}
function release(group){
 const geometries=new Set(),materials=new Set(),textures=new Set();
 group.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of (Array.isArray(o.material)?o.material:[o.material]).filter(Boolean)){materials.add(m);for(const value of Object.values(m))if(value?.isTexture)textures.add(value);}});
 geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>{t.dispose();t.source?.data?.close?.();});group.removeFromParent();
}
// Load the versioned local asset; the original generator is a functional fallback.
export async function loadCampusAsset(){
 let group;
 try{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);let bytes;
  try{const response=await fetch('/static/assets/campus/campus-design.meshopt.glb',{signal:controller.signal});if(!response.ok)throw Error('GLB HTTP '+response.status);bytes=await response.arrayBuffer();}finally{clearTimeout(timer);}
  const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);await MeshoptDecoder.ready;
  const gltf=await loader.parseAsync(bytes,'/static/assets/campus/');group=gltf.scene;
  const roofs=new Map();group.traverse(o=>{if(o.name.startsWith('roof-'))roofs.set(o.name.slice(5),o);});
  if(CAMPUS_BUILDINGS.some(b=>!roofs.has(b.id)))throw Error('Incomplete campus roof semantics');
  group.traverse(o=>{if(!o.isMesh)return;const kind=o.userData.materialKind;o.castShadow=!['asphalt','paving','markings','forest'].includes(kind);o.receiveShadow=true;});
  let disposed=false;
  return withLOD({group,roofs,buildings:CAMPUS_BUILDINGS,assetType:'meshopt',assetBytes:bytes.byteLength,
   anchors:new Map(Object.entries(CAMPUS_LAYOUT).map(([id,e])=>[id,new THREE.Vector3(...e.position)])),
   bounds:new THREE.Box3(new THREE.Vector3(...CAMPUS_BOUNDS.min),new THREE.Vector3(...CAMPUS_BOUNDS.max)),target:new THREE.Vector3(-1.3,1.9,-1.1),cameraPosition:new THREE.Vector3(57,47,67),
   setRoofOpen(value){for(const r of roofs.values())r.visible=!value;},
   dispose(){if(!disposed){disposed=true;release(group);}}
  });
 }catch(error){if(group)release(group);console.info('Campus GLB fallback:',error.message);await warmCampusTextures().catch(()=>{});return withLOD({...createArchitecturalCampus(),assetType:'procedural-fallback',assetBytes:0});}
}
