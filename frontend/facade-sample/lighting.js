import * as THREE from '../vendor/three/three.module.js';

// Procedural lighting reference only. This is not the photographed campus environment.
// Rows follow DataTexture's bottom-up UV convention, matching Three.js equirectUv.
export function createSkyPixels(width=512,height=256){
 const pixels=new Float32Array(width*height*4),dir=new THREE.Vector3();
 const sun=new THREE.Vector3(-4.5,6,5).normalize();
 const horizon=new THREE.Color(0xe2ebf1),zenith=new THREE.Color(0x6c9bcb),ground=new THREE.Color(0x363b3d);
 const white=new THREE.Color(0xf8f9f6);
 // Broad, soft cloud bands are light sources/reflections, never facade surface detail.
 const clouds=[[-.65,.17,.73,.42,.085],[.05,.30,.95,.48,.09],[.65,.20,.72,.30,.07],[-.20,.58,.77,.30,.12]];
 for(let y=0;y<height;y++){
  const latitude=((y+.5)/height-.5)*Math.PI,vertical=Math.sin(latitude),radial=Math.cos(latitude);
  for(let x=0;x<width;x++){
   const azimuth=((x+.5)/width-.5)*2*Math.PI;
   dir.set(radial*Math.cos(azimuth),vertical,radial*Math.sin(azimuth));
   const color=vertical>=0?horizon.clone().lerp(zenith,Math.pow(vertical,.45)):horizon.clone().lerp(ground,Math.min(1,-vertical*8));
   let cloud=0;
   for(const [cx,cy,cz,sx,sy]of clouds){
    const d=((dir.x-cx)/sx)**2+((dir.y-cy)/sy)**2+((dir.z-cz)/.32)**2;
    cloud=Math.max(cloud,Math.exp(-d*1.2));
   }
   color.lerp(white,Math.min(.92,cloud));
   const glow=Math.pow(Math.max(0,dir.dot(sun)),450)*12,offset=(y*width+x)*4;
   pixels.set([color.r+glow,color.g+glow*.93,color.b+glow*.8,1],offset);
  }
 }
 return{width,height,pixels};
}
export function createSampleEnvironment(renderer){
 const {width,height,pixels}=createSkyPixels();
 const source=new THREE.DataTexture(pixels,width,height,THREE.RGBAFormat,THREE.FloatType);
 source.mapping=THREE.EquirectangularReflectionMapping;source.needsUpdate=true;
 const generator=new THREE.PMREMGenerator(renderer),target=generator.fromEquirectangular(source);
 source.dispose();generator.dispose();
 let disposed=false;return{texture:target.texture,dispose(){if(!disposed){disposed=true;target.dispose();}}};
}

export async function loadSampleHDREnvironment(renderer,isCurrent=()=>true){
 const {HDRLoader}=await import('../vendor/three/HDRLoader.js');
 const source=await new HDRLoader().setDataType(THREE.FloatType).loadAsync(new URL('./assets/kloofendal-sky-1k.hdr',import.meta.url).href);
 if(!isCurrent()){source.dispose();return null;}
 source.mapping=THREE.EquirectangularReflectionMapping;
 // Align the visible sun in the HDR with the shadow-casting light.
 const {data,width,height}=source.image;let peak=-1,peakIndex=0;
 for(let i=0;i<data.length;i+=4){const light=data[i]+data[i+1]+data[i+2];if(light>peak){peak=light;peakIndex=i/4;}}
 const u=(peakIndex%width+.5)/width,v=(Math.floor(peakIndex/width)+.5)/height;
 const latitude=(.5-v)*Math.PI,azimuth=(u-.5)*2*Math.PI;
 const rotation=azimuth-Math.atan2(5,-4.5);
 const sunDirection=new THREE.Vector3(Math.cos(latitude)*Math.cos(azimuth),Math.sin(latitude),Math.cos(latitude)*Math.sin(azimuth)).applyAxisAngle(new THREE.Vector3(0,1,0),rotation);
 const generator=new THREE.PMREMGenerator(renderer),target=generator.fromEquirectangular(source);
 generator.dispose();source.dispose();
 let disposed=false;
 return{texture:target.texture,rotation,sunDirection,dispose(){if(!disposed){disposed=true;target.dispose();}}};
}
