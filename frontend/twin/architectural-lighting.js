import * as THREE from '../vendor/three/three.module.js';

// Deterministic botanical geometry. Appearance is illustrative, never facility state.
export function createTreeCrown(height, seed = 1, detail = {}) {
  if(detail.volume)return volumeCrown(height,seed,detail);
  let state = seed >>> 0;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 4294967296);
  const positions = [], colors = [], uvs = [];
  const rotation = new THREE.Quaternion(), point = new THREE.Vector3();
  for (let cluster = 0; cluster < (detail.clusters || 27); cluster++) {
    const angle = cluster * 2.39996 + random() * .35;
    const level = cluster / ((detail.clusters || 27)-1), radius = Math.sqrt(1 - level * level) * height * .28;
    const center = new THREE.Vector3(Math.cos(angle) * radius, height * (.61 + level * .33), Math.sin(angle) * radius);
    for (let leaf = 0; leaf < (detail.leaves || 11); leaf++) {
      const origin = center.clone().add(new THREE.Vector3((random() - .5) * height * .26, (random() - .5) * height * .17, (random() - .5) * height * .26));
      const length = height * (.095 + random() * .04) * (detail.leafScale || 1), width = length * (.42 + random() * .2);
      rotation.setFromEuler(new THREE.Euler((random() - .5) * 2.4, random() * Math.PI * 2, (random() - .5) * 1.2));
      const vertices = [[0,0,-length/2],[-width/2,0,0],[0,length*.07,0],[width/2,0,0],[0,0,length/2]];
      const shade = new THREE.Color().setHSL(.235 + random() * .055, .28 + random() * .18, .055 + random() * .09);
      for (const index of [0,1,2,0,2,3,1,4,2,2,4,3]) {
        point.fromArray(vertices[index]).applyQuaternion(rotation).add(origin);
        positions.push(point.x,point.y,point.z);colors.push(shade.r,shade.g,shade.b);
        uvs.push(vertices[index][0]/width+.5,vertices[index][2]/length+.5);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  geometry.computeVertexNormals();return geometry;
}

// A small local lighting environment: no HDR download, no baked business indicators.
export function createDaylightEnvironment(renderer) {
  const width = 256, height = 128, pixels = new Float32Array(width * height * 4);
  const direction = new THREE.Vector3();
  const sun = new THREE.Vector3(-.45,.72,.42).normalize();
  const zenith = new THREE.Color(0xbdd8ec), horizon = new THREE.Color(0xf2f2e9), ground = new THREE.Color(0x929e8b);
  for (let y = 0; y < height; y++) {
    const latitude = ((y + .5) / height - .5) * Math.PI, vertical = Math.sin(latitude), radial = Math.cos(latitude);
    for (let x = 0; x < width; x++) {
      const phi = ((x + .5) / width - .5) * Math.PI * 2;
      direction.set(radial*Math.cos(phi),vertical,radial*Math.sin(phi));
      const color = vertical >= 0 ? horizon.clone().lerp(zenith,Math.pow(vertical,.55)) : horizon.clone().lerp(ground,Math.min(1,-vertical*4));
      const glow = Math.pow(Math.max(0,direction.dot(sun)),120)*3.5;
      const offset = (y*width+x)*4;
      pixels.set([color.r+glow,color.g+glow*.95,color.b+glow*.82,1],offset);
    }
  }
  const source = new THREE.DataTexture(pixels,width,height,THREE.RGBAFormat,THREE.FloatType);
  source.mapping = THREE.EquirectangularReflectionMapping;source.needsUpdate=true;
  const generator = new THREE.PMREMGenerator(renderer);
  const target = generator.fromEquirectangular(source);generator.dispose();source.dispose();
  let disposed=false;
  return {texture:target.texture,dispose(){if(!disposed){disposed=true;target.dispose();}}};
}


// Hundreds of small folded leaves form a crown without a spherical shell.
function volumeCrown(height,seed,detail){
 let state=seed>>>0;const rand=()=>((state=(1664525*state+1013904223)>>>0)/4294967296);
 const positions=[],colors=[],uvs=[],color=new THREE.Color(),point=new THREE.Vector3(),q=new THREE.Quaternion();
 const phase=rand()*6.28,count=detail.shrub?76:270,clusters=detail.shrub?8:24,kind=seed%3;
 for(let i=0;i<count;i++){
  const cluster=i%clusters,a=cluster*2.39996+phase,level=(cluster+.5)/clusters;
  const r=Math.sqrt(1-Math.pow(level*.94,2))*height*(detail.shrub?.36:.29);
  const center=new THREE.Vector3(Math.cos(a)*r,height*(.55+level*(kind===1?.43:.36)),Math.sin(a)*r);
  center.add(new THREE.Vector3((rand()-.5)*height*.22,(rand()-.5)*height*.17,(rand()-.5)*height*.22));
  const length=height*(.045+rand()*.025)*(detail.shrub?1.1:1),width=length*(.5+rand()*.2);
  q.setFromEuler(new THREE.Euler((rand()-.5)*2.5,rand()*6.28,(rand()-.5)*1.8));
  color.setHSL(.225+rand()*.05,.38+rand()*.18,.045+rand()*.055);
  for(const v of [[0,0,-length/2],[-width/2,length*.09,0],[width/2,length*.09,0],[-width/2,length*.09,0],[0,0,length/2],[width/2,length*.09,0]]){
   point.fromArray(v).applyQuaternion(q).add(center);positions.push(point.x,point.y,point.z);colors.push(color.r,color.g,color.b);uvs.push(0,0);
  }
 }
 // Small shaded inner lobes fill gaps; the leaf clusters define the outer silhouette.
 for(let lobe=0;lobe<(detail.shrub?1:2);lobe++){
  const core=new THREE.SphereGeometry(1,6,4).toNonIndexed(),p=core.attributes.position;
  for(let i=0;i<p.count;i++){
   const x=p.getX(i),y=p.getY(i),z=p.getZ(i),r=height*(detail.shrub?.25:.18)*(1+.18*Math.sin(x*8+z*5+phase));
   positions.push(x*r+height*(lobe===0?-.05:.05),height*(.65+lobe*.13)+y*r,z*r);
   color.setHSL(.25,.48,.045+(y+1)*.017);colors.push(color.r,color.g,color.b);uvs.push(0,0);
  }core.dispose();
 }
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));g.computeVertexNormals();return g;
}
