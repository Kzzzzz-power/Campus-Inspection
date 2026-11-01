import * as THREE from '../vendor/three/three.module.js';
import {createTreeCrown} from './architectural-lighting.js';

function ellipse(x,z,rx,rz){const s=new THREE.Shape();for(let i=0;i<=64;i++){const a=i/64*Math.PI*2,r=1+.045*Math.sin(a*3);const xx=x+Math.cos(a)*rx*r,yy=-z+Math.sin(a)*rz*r;i?s.lineTo(xx,yy):s.moveTo(xx,yy);}return s;}
function surface(b,shape,kind,color,y){b.add(new THREE.ShapeGeometry(shape,48),kind,color,[0,y,0],[-Math.PI/2,0,0]);}
function path(b,points,width,color=0xd6ceba){
 const curve=new THREE.CatmullRomCurve3(points.map(([x,z])=>new THREE.Vector3(x,.18,z))),positions=[],uv=[];
 for(let i=0;i<=48;i++){const t=i/48,p=curve.getPoint(t),d=curve.getTangent(t),n=new THREE.Vector3(-d.z,0,d.x).multiplyScalar(width/2);positions.push(p.x+n.x,p.y,p.z+n.z,p.x-n.x,p.y,p.z-n.z);uv.push(0,t*16,1,t*16);}
 const indices=[];for(let i=0;i<48;i++){const a=i*2;indices.push(a,a+2,a+1,a+1,a+2,a+3);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();b.add(g,'paving',color,[0,0,0]);
}
function shrub(b,x,z,height,seed){
 b.tag('shrub-'+seed,'灌木与地被 · 设计示意','planting');
 const g=createTreeCrown(height,seed,{volume:true,shrub:true});g.translate(0,-height*.35,0);b.add(g,'foliage',0xffffff,[x,.2,z]);
}
export function addGardenDetails(b){
 b.tag('garden-water','水岸花园 · 设计示意','landscape');
 for(const [x,z,rx,rz]of [[28,25,7.6,5.2],[-41,28,4.9,6.2]]){
  const shore=ellipse(x,z,rx+1.0,rz+1.0);surface(b,shore,'paving',0xc1b8a1,.12);
  surface(b,ellipse(x,z,rx,rz),'water',0x477d79,.2);
  for(let i=0;i<15;i++){const a=i/15*6.28,px=x+Math.cos(a)*(rx+1.25),pz=z+Math.sin(a)*(rz+1.25);if(i%3===0){const g=new THREE.IcosahedronGeometry(.45,0);g.scale(1.2,.6,.9);b.add(g,'concrete',0x979b88,[px,.35,pz]);}else shrub(b,px,pz,.65+(i%3)*.2,3000+i+x);}
 }
 path(b,[[16,35],[20,31],[20,23],[25,17],[36,17],[39,25],[38,34]],1.6);
 path(b,[[-47,19],[-45,22],[-46,29],[-44,35],[-35,36]],1.3);
 path(b,[[18,6],[25,8],[32,6],[39,1]],2);
 // Courtyard planting follows the existing raised beds, keeping the centre walkway clear.
 for(const x of [-19,-6])for(let i=0;i<7;i++)shrub(b,x-2.65+i*.88,21.2,.85+(i%3)*.14,1000+i+x*7);
 for(const x of [-19,-6])for(let i=0;i<7;i++)shrub(b,x-2.65+i*.88,26.5,.7+(i%2)*.2,1100+i+x*9);
 // Low planting strips define the road edges without occupying the carriageway.
 for(const x of [-45.5,38.5])for(let z=-46;z<=30;z+=4.3){if((x<0&&z>18)||(x>0&&z>16))continue;shrub(b,x,z,.7,2000+Math.round(z*4+x));}
 b.tag('sports-fence','运动场围网 · 设计示意','sport');
 for(let x=-12;x<=9;x+=3)b.cylinder(.04,3,[x,1.65,-51],0x50635b,'metal',undefined,.04,6);
 for(const y of [.6,1.3,2,2.8])b.box([22,.025,.025],[-1.5,y,-51],0x768d7a,'metal');
 b.tag('courtyard-pergola','庭院遮阴廊架','landscape');
 for(const x of [-22,-2]){
  for(const z of [18,23])b.box([.12,2.8,.12],[x,1.4,z],0x5c6357,'metal');
  for(let z=17.5;z<=23.5;z+=.55)b.box([3.5,.12,.16],[x,2.85,z],0x9c8a68,'wood');
 }
}
