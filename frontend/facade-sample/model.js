import * as THREE from '../vendor/three/three.module.js';
import {RoundedBoxGeometry} from '../vendor/three/RoundedBoxGeometry.js';
import {mergeGeometries} from '../vendor/three/BufferGeometryUtils.js';

// User-approved photo-based sample, not measured dimensions or a surveyed campus asset.
// Source: QQ20261031-211246.png, middle building. All depths/profiles require close-up verification.
export const SAMPLE = Object.freeze({width:3.6,height:3.8,depth:.64,units:'metre',dimensions:'ESTIMATED_NOT_SURVEYED',
  reference:'QQ20261031-211246.png',scope:'one visible facade bay; no interior or point assignment'});
export function createFacadeSample(){
 const group=new THREE.Group();group.name='facade_photo_sample';group.userData={...SAMPLE};
 const materials={
  concrete:new THREE.MeshStandardMaterial({color:0xc6c5bd,roughness:.78,metalness:0}),
  trim:new THREE.MeshStandardMaterial({color:0xd0cfc7,roughness:.7,metalness:0}),
  panel:new THREE.MeshStandardMaterial({color:0x939a98,roughness:.64,metalness:0}),
  frame:new THREE.MeshStandardMaterial({color:0x46515a,roughness:.23,metalness:.82}),
  gasket:new THREE.MeshStandardMaterial({color:0x202825,roughness:.9,metalness:0}),
  flashing:new THREE.MeshStandardMaterial({color:0x959b9e,roughness:.26,metalness:.9}),
  glass:new THREE.MeshPhysicalMaterial({color:0x658595,roughness:.025,metalness:.12,ior:1.52,transmission:.12,thickness:.024,specularIntensity:1,clearcoat:.85,clearcoatRoughness:.035,envMapIntensity:1.2})
 };
 for(const [name,material] of Object.entries(materials))material.name='pbr_'+name;
 const components=[];
 function part(id,name,materialName,boxes,evidence,simplification){
  const geometries=boxes.map(([size,position,radius=.006])=>{
   const g=new RoundedBoxGeometry(...size,2,Math.min(radius,...size.map(v=>v/4)));
   g.translate(...position);return g;
  });
  const geometry=mergeGeometries(geometries,false);geometries.forEach(g=>g.dispose());
  const mesh=new THREE.Mesh(geometry,materials[materialName]);mesh.name=id;mesh.castShadow=materialName!=='glass';mesh.receiveShadow=materialName!=='glass';
  mesh.userData={componentId:id,name,materialName,evidence,simplification,dimensions:'暂估，非测绘'};
  group.add(mesh);components.push(mesh);return mesh;
 }
 const structural='照片可见框架与进退关系；宽度、厚度与边缘构造暂估。';
 const window='照片可见深色窗格；分格、型材截面及开启方式未获近照核实。';
 part('column_left','左侧立面框架','concrete',[[[.29,3.8,.64],[-1.655,1.9,0],.009]],structural,'保留截面厚度与小倒角，不推断内部配筋。');
 part('column_right','右侧立面框架','concrete',[[[.29,3.8,.64],[1.655,1.9,0],.009]],structural,'样板截取边界，不能据此推定整栋柱网。');
 part('beam_top','上部横梁','concrete',[[[3.02,.32,.64],[0,3.64,0],.009]],structural,'截面和悬挑均为样板暂估。');
 part('slab_base','下部楼板边缘','concrete',[[[3.02,.16,.64],[0,.08,0],.006]],structural,'仅表现外立面截取层，不是实际首层基础。');
 part('spandrel_left','窗下墙板 · 左','panel',[[[1.496,.56,.24],[-.758,.45,-.04],.004]],'照片中窗下不透明区域可见；板材品种和分缝暂估。','使用干净纯色 PBR，未添加污渍或噪声贴图。');
 part('spandrel_right','窗下墙板 · 右','panel',[[[1.496,.56,.24],[.758,.45,-.04],.004]],'同左侧窗下墙板。','分缝只作构造示意，需近照确认。');
 part('return_left','左侧洞口收口','trim',[[[.11,2.67,.3],[-1.46,2.125,.01],.004]],structural,'窗面后退形成真实遮挡，墙体不封死洞口。');
 part('return_right','右侧洞口收口','trim',[[[.11,2.67,.3],[1.46,2.125,.01],.004]],structural,'侧壁厚度暂估。');
 part('head_return','窗上口','trim',[[[2.82,.10,.3],[0,3.43,.01],.004]],structural,'可检查上口阴影与收口深度。');
 part('sill_stone','窗台挑板','trim',[[[3.10,.085,.43],[0,.805,.105],.005]],'照片支持窗台水平构件；挑出量和滴水做法未确认。','不添加照片无法确认的雨棚。');
 part('flashing','窗台金属压边','flashing',[[[2.86,.026,.24],[0,.86,-.005],.002],[[2.86,.05,.025],[0,.837,.103],.002]],'构造推断：压边与折弯，需现场近照确认。','折边简化，不表现螺栓。');
 const x=1.39,bottom=.91,top=3.33,z=-.102,w=2.78;
 part('window_outer_frame','窗框外框','frame',[
  [[.074,top-bottom+.074,.11],[-x,(top+bottom)/2,z],.004],
  [[.074,top-bottom+.074,.11],[x,(top+bottom)/2,z],.004],
  [[w,.074,.11],[0,top,z],.004],
  [[w,.074,.11],[0,bottom,z],.004],
  [[.052,top-bottom+.052,.024],[-x,(top+bottom)/2,z+.068],.002],
  [[.052,top-bottom+.052,.024],[x,(top+bottom)/2,z+.068],.002],
  [[w,.052,.024],[0,top,z+.068],.002],
  [[w,.052,.024],[0,bottom,z+.068],.002]],window,'四边型材与面盖作为独立可选构件；面盖、退槽和截面为暂估。');
 part('window_mullion','竖向中梃','frame',[[[.066,top-bottom,.105],[0,(top+bottom)/2,z+.006],.004],[[.040,top-bottom,.024],[0,(top+bottom)/2,z+.068],.002]],window,'双分格为截图轮廓近似，不代表已确认窗扇数量。');
 part('window_transom','横向分格','frame',[[[w,.055,.105],[0,2.78,z+.006],.003],[[w,.036,.024],[0,2.78,z+.068],.002]],window,'上亮窗高度暂估；本轮不实现开窗。');
 const seals=[];
 for(const xx of [-1.345,-.043,.043,1.345])seals.push([[.014,2.31,.02],[xx,2.12,z+.01],.001]);
 for(const yy of [.957,2.738,2.823,3.283])seals.push([[2.67,.014,.02],[0,yy,z+.01],.001]);
 part('window_seals','玻璃周边密封线','gasket',seals,'构造推断：密封条，截图分辨率不足以核实截面。','只保留连续轮廓，不表现安装五金。');
 for(const [side,cx] of [['left',-.694],['right',.694]]){
  part('glass_'+side+'_lower',side==='left'?'左侧玻璃':'右侧玻璃','glass',[[[1.292,1.77,.018],[cx,1.845,z-.022],.001]],window,'玻璃颜色、透射及厚度为视觉近似；无室内资产。');
  part('glass_'+side+'_upper',side==='left'?'左侧上亮玻璃':'右侧上亮玻璃','glass',[[[1.292,.446,.018],[cx,3.054,z-.022],.001]],window,'未模拟隔热指标或真实光学性能。');
 }
 group.updateMatrixWorld(true);
 return {group,components,materials,bounds:new THREE.Box3().setFromObject(group)};
}
