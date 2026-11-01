import * as THREE from '../vendor/three/three.module.js';
import {GLTFExporter} from '../vendor/three/GLTFExporter.js';
// Split render batches back into named editable components only for export.
export async function exportCampus(source,{editable=true}={}){
 if(!editable){const clone=source.clone(true),materials=[];clone.traverse(o=>{if(o.isMesh){o.material=o.material.clone();o.material.envMap=null;materials.push(o.material);}});try{return await new GLTFExporter().parseAsync(clone,{binary:true,onlyVisible:false});}finally{materials.forEach(m=>m.dispose());}}
 const root=new THREE.Group();root.name='campus-original-design';root.userData={basis:'原创建筑设计示意，非实景测绘',units:'metres',upAxis:'Y'};
 const materials=new Map(),geometries=[];source.updateMatrixWorld(true);
 function material(original){if(!materials.has(original)){const value=original.clone();value.envMap=null;materials.set(original,value);}return materials.get(original);}
 source.traverse(mesh=>{
  if(!mesh.isMesh)return;
  if(mesh.isInstancedMesh){for(let i=0;i<mesh.count;i++){const matrix=new THREE.Matrix4();mesh.getMatrixAt(i,matrix);matrix.premultiply(mesh.matrixWorld);const item=new THREE.Mesh(mesh.geometry,material(mesh.material));item.matrix.copy(matrix);item.matrixAutoUpdate=false;item.name=mesh.name+'-'+i;item.userData={...mesh.userData};root.add(item);}return;}
  const components=mesh.userData.components||[{id:mesh.name,start:0,count:mesh.geometry.attributes.position.count}];
  const groups=new Map();for(const c of components){if(!groups.has(c.id))groups.set(c.id,[]);groups.get(c.id).push(c);}
  for(const[id,parts]of groups){
   const geometry=new THREE.BufferGeometry();
   for(const[key,a]of Object.entries(mesh.geometry.attributes)){
    const count=parts.reduce((n,p)=>n+p.count,0),array=new Float32Array(count*a.itemSize);let offset=0;
    for(const p of parts)for(let i=p.start;i<p.start+p.count;i++)for(let c=0;c<a.itemSize;c++)array[offset++]=a.getComponent(i,c);
    geometry.setAttribute(key,new THREE.BufferAttribute(array,a.itemSize));
   }
   geometry.applyMatrix4(mesh.matrixWorld);geometries.push(geometry);
   const item=new THREE.Mesh(geometry,material(mesh.material));item.name=id;item.userData={...parts[0],basis:'原创设计，尺寸暂估',materialKind:mesh.userData.materialKind};delete item.userData.start;delete item.userData.count;root.add(item);
  }
 });
 try{return await new GLTFExporter().parseAsync(root,{binary:true,onlyVisible:false});}
 finally{geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());}
}