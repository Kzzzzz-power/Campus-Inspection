import * as THREE from '../vendor/three/three.module.js';
import {GLTFLoader} from '../vendor/three/GLTFLoader.js';
import {MeshoptDecoder} from '../vendor/three/meshopt_decoder.module.js';
import {CAMPUS_BUILDINGS,CAMPUS_LAYOUT} from './campus-layout.js';
import {createArchitecturalCampus} from './campus-architecture.js';

function withLOD(model){
 // Keep complete leaf shapes; only alternate leaves are removed at long range.
 const foliage=[];model.group.traverse(o=>{if(o.isMesh&&o.userData.materialKind==='foliage'&&!o.geometry.index){const indices=[];for(let i=0;i<o.geometry.attributes.position.count;i+=24)for(let j=0;j<12&&i+j<o.geometry.attributes.position.count;j++)indices.push(i+j);foliage.push({mesh:o,index:new THREE.Uint32BufferAttribute(indices,1)});}});
 let far=false;model.updateLOD=distance=>{const next=far?distance>100:distance>115;if(next!==far){far=next;for(const f of foliage)f.mesh.geometry.setIndex(far?f.index:null);}return far?'distant':'detailed';};const dispose=model.dispose;model.dispose=()=>{for(const f of foliage)f.mesh.geometry.setIndex(f.index);dispose();};return model;
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
  const roofs=new Map(CAMPUS_BUILDINGS.map(b=>[b.id,group.getObjectByName('roof-'+b.id)]));
  if([...roofs.values()].some(r=>!r))throw Error('Incomplete campus roof semantics');
  group.traverse(o=>{if(!o.isMesh)return;const kind=o.userData.materialKind;o.castShadow=!['asphalt','paving','markings'].includes(kind);o.receiveShadow=true;});
  let disposed=false;
  return withLOD({group,roofs,buildings:CAMPUS_BUILDINGS,assetType:'meshopt',assetBytes:bytes.byteLength,
   anchors:new Map(Object.entries(CAMPUS_LAYOUT).map(([id,e])=>[id,new THREE.Vector3(...e.position)])),
   bounds:new THREE.Box3(new THREE.Vector3(-30.7,0,-22.5),new THREE.Vector3(29.1,9.5,21.5)),target:new THREE.Vector3(-1.3,1.9,-1.1),cameraPosition:new THREE.Vector3(57,47,67),
   setRoofOpen(value){for(const r of roofs.values())r.visible=!value;},
   dispose(){if(!disposed){disposed=true;release(group);}}
  });
 }catch(error){if(group)release(group);console.info('Campus GLB fallback:',error.message);return withLOD({...createArchitecturalCampus(),assetType:'procedural-fallback',assetBytes:0});}
}
