import * as THREE from '../vendor/three/three.module.js';
import { RoundedBoxGeometry } from '../vendor/three/RoundedBoxGeometry.js';
import { mergeGeometries } from '../vendor/three/BufferGeometryUtils.js';
import { createTreeCrown } from './architectural-lighting.js';
import { CAMPUS_BUILDINGS, CAMPUS_LAYOUT } from './campus-layout.js';

const C = {
  concrete: 0xd3d1c8, light: 0xe9e5d9, brick: 0xb8a48c, stone: 0xa9aaa3,
  metal: 0x424e55, frame: 0x526068, glass: 0x667c88, glassLight: 0x7d929c,
  roof: 0x889a96, asphalt: 0x727f83, paving: 0xd7d6c9, grass: 0x6c805c,
  leaf: 0xffffff, leafLight: 0x829a65, bark: 0x75685a, white: 0xeeeadd,
};
const BASE = 0.28;

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function surfaceTexture(kind) {
  const size = 128, data = new Uint8Array(size * size * 4), rng = random(19);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / 16), offset = row % 2 ? 32 : 0;
      const joint = kind === 'brick' && (y % 16 < 1 || (x + offset) % 64 < 1);
      const value = joint ? 158 : Math.round(246 - rng() * (kind === 'asphalt' ? 20 : 8));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function signageTexture() {
  if(typeof document === 'undefined')return null;
  const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=256;
  const ctx=canvas.getContext('2d');if(!ctx)return null;
  ['教学楼','实验空间','实训楼','校园教学实训空间'].forEach((name,i)=>{
    const x=i*512;ctx.fillStyle='#eceee7';ctx.fillRect(x,0,512,256);
    ctx.fillStyle='#355257';ctx.textAlign='center';ctx.font='500 56px "Microsoft YaHei", sans-serif';ctx.fillText(name,x+256,123);
    ctx.fillStyle='#627876';ctx.font='26px sans-serif';ctx.fillText('校园空间 · 概念示意',x+256,181);
  });
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;return texture;
}

function createMaterials() {
  const concrete = surfaceTexture('concrete'), brick = surfaceTexture('brick'), asphalt = surfaceTexture('asphalt');
  const sign=signageTexture();
  const common = { vertexColors: true };
  return {
    textures: [concrete, brick, asphalt, sign].filter(Boolean),
    materials: {
      sign: new THREE.MeshStandardMaterial({map:sign,color:sign?0xffffff:0xdce3dc,roughness:.8}),
      concrete: new THREE.MeshStandardMaterial({ ...common, roughness: .82 }),
      brick: new THREE.MeshStandardMaterial({ ...common, roughness: .76 }),
      metal: new THREE.MeshStandardMaterial({ ...common, roughness: 0.38, metalness: 0.42 }),
      glass: new THREE.MeshPhysicalMaterial({ ...common, roughness: .045, metalness: .12, envMapIntensity: 1.05, clearcoat: 1, clearcoatRoughness: .035 }),
      paving: new THREE.MeshStandardMaterial({ ...common, map: concrete, roughness: 0.96 }),
      asphalt: new THREE.MeshStandardMaterial({ ...common, map: asphalt, roughness: 0.98 }),
      vegetation: new THREE.MeshStandardMaterial({ ...common, roughness: 1 }),
      foliage: new THREE.MeshStandardMaterial({ ...common, roughness: .94, side: THREE.DoubleSide }),
      wood: new THREE.MeshStandardMaterial({ ...common, map: concrete, roughness: 0.96 }),
      markings: new THREE.MeshStandardMaterial({ ...common, roughness: 0.9 }),
    },
  };
}

function batch(group, materials) {
  const buckets = new Map(), matrix = new THREE.Matrix4();
  let component = {id:group.name, name:'校园场地', role:'site', buildingId:null};
  function tag(id,name,role,buildingId){component={id,name,role,buildingId,conceptual:true};}
  function add(geometry, material, color, position, rotation = [0, 0, 0]) {
    const plain = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geometry.dispose();
    matrix.compose(new THREE.Vector3(...position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1));
    plain.applyMatrix4(matrix);
    const points = plain.attributes.position, normals = plain.attributes.normal;
    const rgb = new THREE.Color(color), colors = new Float32Array(points.count * 3), uv = new Float32Array(points.count * 2);
    for (let i = 0; i < points.count; i++) {
      const leafColor = plain.attributes.color;
      colors.set(leafColor ? [rgb.r * leafColor.getX(i), rgb.g * leafColor.getY(i), rgb.b * leafColor.getZ(i)] : [rgb.r, rgb.g, rgb.b], i * 3);
      const nx = Math.abs(normals.getX(i)), ny = Math.abs(normals.getY(i)), nz = Math.abs(normals.getZ(i));
      uv[i * 2] = (nx > nz ? points.getZ(i) : points.getX(i)) * (material === 'brick' ? 1.7 : 0.65);
      uv[i * 2 + 1] = (ny > 0.7 ? points.getZ(i) : points.getY(i)) * (material === 'brick' ? 1.7 : 0.65);
    }
    plain.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if(material!=='sign')plain.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (!buckets.has(material)) buckets.set(material, []);
    buckets.get(material).push({geometry:plain,component:{...component}});
  }
  function box(size, position, color = C.concrete, material = 'concrete', rotation) {
    add(new THREE.BoxGeometry(...size), material, color, position, rotation);
  }
  function bevel(size, position, color=C.concrete, material='concrete') { add(new RoundedBoxGeometry(...size,1,.025),material,color,position); }
  function cylinder(radius, height, position, color, material = 'metal', rotation, topRadius = radius, segments = 10) {
    add(new THREE.CylinderGeometry(topRadius, radius, height, segments), material, color, position, rotation);
  }
  function rod(start, end, radius, color = C.metal, material = 'metal') {
    const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end), delta = b.clone().sub(a);
    const geometry = new THREE.CylinderGeometry(radius, radius, delta.length(), 7);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
    add(geometry, material, color, a.add(b).multiplyScalar(0.5).toArray());
  }
  function sign(index,position,width=4.6){
    const geometry=new THREE.PlaneGeometry(width,width*.23),uv=geometry.attributes.uv;
    for(let i=0;i<uv.count;i++)uv.setX(i,(index+uv.getX(i)) /4);
    add(geometry,'sign',0xffffff,position);
  }
  function finish() {
    for (const [key, geometries] of buckets) {
      const geometry = mergeGeometries(geometries.map(p=>p.geometry), false);
      let offset=0;const components=geometries.map(p=>{const count=p.geometry.attributes.position.count;const item={...p.component,start:offset,count};offset+=count;return item;});
      geometries.forEach(part => part.geometry.dispose());
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, materials[key]);
      mesh.name = group.name + ':' + key;
      mesh.castShadow = !['asphalt', 'paving', 'markings'].includes(key);
      mesh.receiveShadow = true;
      mesh.userData = { conceptual: true, materialKind: key, components };
      group.add(mesh);
    }
    buckets.clear();
  }
  return { add, box, bevel, cylinder, rod, sign, finish, tag };
}

function facade(b, building, face) {
  const [cx, , cz] = building.position, [w, d] = building.size;
  const yaw = { front: 0, back: Math.PI, right: Math.PI / 2, left: -Math.PI / 2 }[face];
  const normal = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const across = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const origin = new THREE.Vector3(cx, 0, cz).addScaledVector(normal, face === 'front' || face === 'back' ? d / 2 : w / 2);
  return (size, [u, y, offset], color = C.concrete, material = 'concrete') => {
    const point = origin.clone().addScaledVector(across, u).addScaledVector(normal, offset);
    point.y = y;
    b.box(size, point.toArray(), color, material, [0, yaw, 0]);
  };
}

function windowBay(draw, x, y, width, height, variation = 0, louvers = false) {
  draw([width, height, .025], [x,y,-.18], variation%3?C.glass:C.glassLight,'glass');
  for(const side of [-1,1]){
    draw([.09,height+.18,.32],[x+side*(width/2+.045),y,-.14],C.light);
    draw([width+.18,.09,.32],[x,y+side*(height/2+.045),-.14],C.light);
    draw([.055,height,.09],[x+side*(width/2-.03),y,-.095],C.frame,'metal');
    draw([width,.055,.09],[x,y+side*(height/2-.03),-.095],C.frame,'metal');
  }
  draw([.065,height,.12],[x,y,-.075],C.frame,'metal');
  draw([width,.055,.12],[x,y+height*.21,-.075],C.frame,'metal');
  draw([width+.28,.09,.49],[x,y-height/2-.13,.03],C.light);
  if(louvers)for(let i=0;i<3;i++)draw([width+.3,.045,.65],[x,y+height/2+.13+i*.14,.28],C.frame,'metal');
}


function entrance(b, building) {
  const [x, , z] = building.position, front = z + building.size[1] / 2;
  b.tag('door_'+building.id+'_main','主入口玻璃门','door',building.id);
  const draw = facade(b, building, 'front'), h = building.id === 'laboratory' ? 3.2 : 2.95;
  draw([3.4, h + 0.12, 0.22], [0, BASE + h / 2, 0.13], C.metal, 'metal');
  draw([3.12, h - 0.1, 0.08], [0, BASE + h / 2, 0.28], C.glassLight, 'glass');
  for (const dx of [-1.56, 0, 1.56]) draw([0.065, h, 0.09], [dx, BASE + h / 2, 0.35], C.frame, 'metal');
  draw([3.16, 0.07, 0.1], [0, BASE + 2.36, 0.35], C.frame, 'metal');
  for (const dx of [-0.17, 0.17]) draw([0.035, 0.65, 0.06], [dx, 1.45, 0.43], C.light, 'metal');
  b.tag('awning_'+building.id+'_main','入口雨棚','awning',building.id);
  b.bevel([5.1, 0.14, 2.4], [x, h + 0.57, front + 0.85], C.metal, 'metal');
  b.box([4.95, 0.045, 2.25], [x, h + 0.48, front + 0.85], C.light);
  for (const dx of [-2.25, 2.25]) b.box([0.12, h + 0.37, 0.12], [x + dx, (h + 0.37) / 2 + 0.1, front + 1.85], C.frame, 'metal');
  for (let step = 0; step < 3; step++) b.box([5.3, 0.1, 1.65 - step * 0.38], [x, 0.05 + step * 0.1, front + 0.9 - step * 0.19], C.stone);
  b.box([1.35, 0.12, 3.7], [x + 3.45, 0.14, front + 1.8], C.paving, 'paving', [0.075, 0, 0]);
  for (const dx of [2.8, 4.1]) {
    b.rod([x + dx, 1.2, front + 0.1], [x + dx, 0.93, front + 3.5], 0.027, C.frame);
    for (const dz of [0.2, 1.85, 3.4]) b.rod([x + dx, 0.1, front + dz], [x + dx, 1.2 - dz * 0.08, front + dz], 0.024, C.frame);
  }
}

function buildingShell(b, building) {
  const [x, , z] = building.position, [w, d] = building.size, h = building.floors * building.floorHeight;
  b.tag('plinth_'+building.id,'建筑勒脚','plinth',building.id);
  b.bevel([w + 0.55, 0.28, d + 0.55], [x, 0.14, z], C.stone);
  for (const face of ['front', 'back', 'left', 'right']) {
    const length = face === 'front' || face === 'back' ? w : d, draw = facade(b, building, face);
    for (let floor = 0; floor < building.floors; floor++) {
      const lower = BASE + floor * building.floorHeight, brick = building.id === 'teaching' && floor === 0;
      const count=Math.max(2,Math.round((length-1.2)/(building.id==='laboratory'?3.2:2.9))),step=(length-1.5)/count;
      const openingHeight=building.id==='laboratory'?2.45:1.9, center=lower+(building.id==='laboratory'?2.42:2.03), openings=[];
      for(let index=0;index<count;index++){
        const u=(index-(count-1)/2)*step;
        if(face==='front'&&(floor===0||building.id==='teaching')&&Math.abs(u)<2)continue;
        openings.push({left:u-(step-.62)/2,right:u+(step-.62)/2,bottom:center-openingHeight/2,top:center+openingHeight/2,index,u});
      }
      if(face==='front'&&floor===0)openings.push({left:-1.7,right:1.7,bottom:lower,top:lower+(building.id==='laboratory'?3.2:2.95),door:true});
      if(face==='front'&&floor>0&&building.id==='teaching')openings.push({left:-1.85,right:1.85,bottom:lower,top:lower+building.floorHeight,door:true});
      openings.sort((a,b)=>a.left-b.left);
      b.tag(`facade_${building.id}_${face}_${floor+1}F`,`${face}立面 · ${floor+1}F 墙体`,'wall',building.id);
      let cursor=-length/2;
      for(const hole of openings){
        if(hole.left>cursor)draw([hole.left-cursor,building.floorHeight,.3],[(hole.left+cursor)/2,lower+building.floorHeight/2,-.15],brick?C.brick:C.concrete,brick?'brick':'concrete');
        const w=hole.right-hole.left;
        if(hole.bottom>lower)draw([w,hole.bottom-lower,.3],[(hole.left+hole.right)/2,(lower+hole.bottom)/2,-.15],brick?C.brick:C.concrete,brick?'brick':'concrete');
        const upper=lower+building.floorHeight;
        if(hole.top<upper)draw([w,upper-hole.top,.3],[(hole.left+hole.right)/2,(hole.top+upper)/2,-.15],brick?C.brick:C.concrete,brick?'brick':'concrete');
        cursor=hole.right;
      }
      if(cursor<length/2)draw([length/2-cursor,building.floorHeight,.3],[(length/2+cursor)/2,lower+building.floorHeight/2,-.15],brick?C.brick:C.concrete,brick?'brick':'concrete');
      draw([length+.14,.18,.4],[0,lower+.08,.015],C.light);
      for(const hole of openings){
        if(hole.door)continue;
        b.tag(`window_${building.id}_${face}_${floor+1}F_${hole.index+1}`,`${floor+1}F ${face}窗 ${hole.index+1}`,'window',building.id);
        windowBay(draw,hole.u,center,hole.right-hole.left,openingHeight,hole.index+floor,building.id==='laboratory');
      }
      b.tag(`facade_${building.id}_${face}_trim`,`${face}立面檐口与分缝`,'trim',building.id);
      if (building.id === 'training') draw([length + 0.2, 0.42, 0.4], [0, lower + building.floorHeight - 0.37, 0.06], C.frame, 'metal');
    }
    draw([length + 0.28, 0.2, 0.48], [0, BASE + h - 0.08, 0.035], C.light);
    for (const side of [-1, 1]) draw([0.3, h, 0.42], [side * (length / 2 - 0.14), BASE + h / 2, 0.025], C.light);
  }
  for (let floor = 0; floor < building.floors; floor++) b.box([w - 0.3, 0.18, d - 0.3], [x, BASE + floor * building.floorHeight, z], C.stone);
  if (building.id === 'teaching') for (let i = 0; i <= 8; i++) b.box([0.19, building.floorHeight, 0.62], [x - w / 2 + 0.65 + i * (w - 1.3) / 8, BASE + building.floorHeight * 1.5, z + d / 2 + 0.15], C.light);
  if (building.id === 'training') {
    const draw = facade(b, building, 'right');
    for (let i = 0; i < 10; i++) draw([0.065, h - 0.8, 0.25], [(i - 4.5) * 0.23, BASE + h / 2, 0.33], C.frame, 'metal');
  }
  if (building.id === 'teaching') {
    for (const dx of [-w/2+.3,w/2-.3]) b.box([.5,h,.65],[x+dx,BASE+h/2,z+d/2+.2],C.light);
    const side=facade(b,building,'left');
    for(let seam=0;seam<8;seam++) side([d,.025,.015],[0,BASE+.45+seam*.85,.16],C.stone);
  }
  if(building.id === 'training'){
    const front=facade(b,building,'front');
    for(const edge of [-w/2+.8,w/2-.8]) for(let i=0;i<4;i++)
      front([.075,h-.6,.55],[edge+(i-1.5)*.17,BASE+h/2,.28],C.frame,'metal');
  }
  if(building.id==='teaching'){
    b.tag('window_teaching_front_entrybay','入口通高玻璃幕墙','window',building.id);
    // Enclosed glazed entrance bay; scale comes from the door and floor heights.
    const draw=facade(b,building,'front');
    draw([3.7,h-.18,.15],[0,BASE+h/2,.48],C.glassLight,'glass');
    for(const dx of [-1.87,0,1.87])draw([.095,h,.23],[dx,BASE+h/2,.6],C.frame,'metal');
    for(const y of [2.7,building.floorHeight,h-.06])draw([3.9,.1,.23],[0,BASE+y,.6],C.light,'metal');
    for(const dx of [-2.14,2.14])draw([.28,h,.78],[dx,BASE+h/2,.31],C.light);
  }
  entrance(b, building);
}

function roofGroup(building, materials) {
  const group = new THREE.Group();
  group.name = 'roof-' + building.id;
  group.userData = { conceptual: true, buildingId: building.id, closedY: 0, role: 'roof' };
  const b = batch(group, materials), [x, , z] = building.position, [w, d] = building.size;
  const y = BASE + building.floors * building.floorHeight;
  b.tag('roof_'+building.id,'完整屋面与女儿墙','roof',building.id);
  b.bevel([w + 0.42, 0.24, d + 0.42], [x, y + 0.09, z], C.light);
  b.box([w - 0.38, 0.06, d - 0.38], [x, y + 0.24, z], C.roof, 'metal');
  for (const dz of [-d / 2, d / 2]) {
    b.box([w + 0.28, 0.38, 0.16], [x, y + 0.35, z + dz], C.concrete);
    b.box([w + 0.42, 0.07, 0.26], [x, y + 0.57, z + dz], C.frame, 'metal');
  }
  for (const dx of [-w / 2, w / 2]) {
    b.box([0.16, 0.38, d], [x + dx, y + 0.35, z], C.concrete);
    b.box([0.26, 0.07, d + 0.3], [x + dx, y + 0.57, z], C.frame, 'metal');
  }
  b.tag('roof_equipment_'+building.id,'屋面通风设备 · 设计示意','equipment',building.id);
  for (let i = 0; i < 2; i++) {
    const vx = x + w * 0.22 + i * 1.8, vz = z - d * 0.22;
    b.box([1.35, 0.82, 1.45], [vx, y + 0.7, vz], C.stone, 'metal');
    b.cylinder(0.42, 0.055, [vx, y + 1.15, vz], C.metal, 'metal', undefined, 0.42, 16);
    for (let j = 0; j < 5; j++) b.box([1.12, 0.035, 0.035], [vx, y + 0.43 + j * 0.12, vz + 0.75], C.metal, 'metal');
  }
  if (building.id === 'laboratory') {
    for (const dx of [-4, -2.4]) {
      b.cylinder(0.24, 1.5, [x + dx, y + 0.94, z - 1.6], C.frame, 'metal');
      b.cylinder(0.36, 0.1, [x + dx, y + 1.73, z - 1.6], C.frame, 'metal');
    }
    for (const dx of [-3.4, 0, 3.4]) {
      b.box([2.5, 0.22, 1.8], [x + dx, y + 0.43, z + 1.2], C.frame, 'metal');
      b.box([2.3, 0.055, 1.65], [x + dx, y + 0.57, z + 1.2], C.glassLight, 'glass');
    }
  }
  b.finish();
  return group;
}

function broadleaf(b, x, z, height, seed) {
  const rng = random(seed);
  b.cylinder(.13, height * .68, [x,height*.34,z],C.bark,'wood',[0,0,.025],.055);
  for(let branch=0;branch<9;branch++){
    const angle=branch*2.399+seed,reach=height*(.2+rng()*.08);
    const end=[x+Math.cos(angle)*reach,height*(.61+rng()*.22),z+Math.sin(angle)*reach];
    const start=[x,height*(.32+branch*.025),z];
    b.rod(start,end,.035,C.bark,'wood');
    for(const side of [-1,1]) b.rod(end,[end[0]+side*.35,end[1]+.4,end[2]+.25],.014,C.bark,'wood');
  }
  b.add(createTreeCrown(height,seed),'foliage',0xffffff,[x,0,z]);
}

function bench(b, x, z, angle = 0) {
  const base = new THREE.Vector3(x, 0, z), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
  const part = (size, offset, color, material) => b.box(size, new THREE.Vector3(...offset).applyQuaternion(q).add(base).toArray(), color, material, [0, angle, 0]);
  for (let i = 0; i < 5; i++) part([1.9, 0.055, 0.08], [0, 0.48, -0.21 + i * 0.105], C.bark, 'wood');
  for (let i = 0; i < 3; i++) part([1.9, 0.09, 0.045], [0, 0.68 + i * 0.14, -0.28], C.bark, 'wood');
  for (const dx of [-0.72, 0.72]) {
    part([0.065, 0.44, 0.5], [dx, 0.22, 0], C.metal, 'metal');
    part([0.065, 0.88, 0.065], [dx, 0.44, -0.28], C.metal, 'metal');
  }
}


function site(b) {
  b.box([500, 0.12, 500], [0, -0.14, 0], 0xd6ded1, 'vegetation');
  b.box([59, 0.06, 43], [-1, -0.045, -1], C.grass, 'vegetation');
  b.box([58, 0.055, 4.2], [-1, -0.002, 15.2], C.asphalt, 'asphalt');
  b.box([4.2, 0.055, 35], [25.2, -0.002, -3.2], C.asphalt, 'asphalt');
  b.box([55, 0.055, 3.8], [-1.8, -0.002, -20.9], C.asphalt, 'asphalt');
  b.box([3.5, 0.055, 35], [-28.5, -0.002, -3.2], C.asphalt, 'asphalt');
  b.box([27, 0.08, 11.5], [-11.3, 0.02, 6.1], C.paving, 'paving');
  b.box([4.4, 0.08, 31.5], [0.5, 0.022, -3], C.paving, 'paving');
  b.box([22, 0.08, 3.7], [13.1, 0.022, -5.7], C.paving, 'paving');
  b.box([22, 0.08, 3], [13, 0.022, 12], C.paving, 'paving');
  b.box([6.2, 0.08, 7.5], [-0.3, 0.022, 16.7], C.paving, 'paving');
  for (let x = -24; x <= 1; x += 1.5) b.box([0.018, 0.008, 11.5], [x, 0.065, 6.1], C.stone, 'paving');
  for (let z = 0.5; z < 12; z += 1.5) b.box([27, 0.008, 0.018], [-11.3, 0.065, z], C.stone, 'paving');
  b.box([18,.012,.36],[-12,.072,2.35],0x9da99e,'paving');
  b.box([18,.012,.36],[-12,.072,10.9],0x9da99e,'paving');
  for (const x of [-27, 23]) b.box([0.16, 0.18, 33.6], [x, 0.065, -3.2], C.stone);
  for (const z of [12.9, 17.4, -18.9]) for (const [x, width] of [[-15.2, 23], [15, 23]]) b.box([width, 0.18, 0.16], [x, 0.065, z], C.stone);
  for (let x = -25; x <= 26; x += 4) if (Math.abs(x) >= 5) b.box([1.7, 0.008, 0.09], [x, 0.031, 15.2], C.white, 'markings');
  for (let i = 0; i < 7; i++) b.box([0.38, 0.012, 3.8], [-2.5 + i * 0.72, 0.036, 15.2], C.white, 'markings');
  for (const [x, z, w, d] of [[-19.7, 8.3, 7.5, 3.4], [-8.4, 8.3, 7.5, 3.4], [20, -5.5, 4, 1.6]]) {
    b.box([w, 0.25, d], [x, 0.125, z], C.stone);
    b.box([w - 0.3, 0.08, d - 0.3], [x, 0.29, z], 0x526247, 'vegetation');
    for (let i = 0; i < Math.floor(w * 2); i++) {
      const geometry = new THREE.SphereGeometry(0.35, 8, 5);
      geometry.scale(1, 0.65, 0.8);
      b.add(geometry, 'vegetation', i % 3 ? 0x667751 : 0x79835e, [x - w / 2 + 0.45 + i * 0.48, 0.48, z]);
    }
  }
  for (const [x, z, angle] of [[-19.5, 5.9, 0], [-8.5, 5.9, 0], [-19.5, 10.6, Math.PI], [-8.5, 10.6, Math.PI], [20, -3.8, 0]]) bench(b, x, z, angle);
  for (const [x, z] of [[-25.6, 4], [-3.1, 3], [3.1, -4.3], [23.1, 2.3], [-24, 12.2], [21, 12.2]]) {
    b.cylinder(0.075, 4.5, [x, 2.25, z], C.metal);
    b.box([0.95, 0.075, 0.26], [x + 0.3, 4.52, z], C.metal, 'metal');
    b.box([0.65, 0.025, 0.19], [x + 0.36, 4.47, z], C.light, 'markings');
  }
  b.box([8, 0.08, 3.3], [15.7, 0.035, 19.2], C.paving, 'paving');
  b.box([8.1, 0.12, 3.4], [15.7, 2.6, 19.2], C.frame, 'metal', [0.045, 0, 0]);
  for (const x of [12, 19.4]) for (const z of [17.9, 20.5]) b.box([0.07, 2.55, 0.07], [x, 1.3, z], C.metal, 'metal');
  for (let i = 0; i < 8; i++) {
    const x = 12.6 + i * 0.9;
    b.rod([x, 0.07, 18.9], [x, 0.72, 18.9], 0.025);
    b.rod([x, 0.72, 18.9], [x, 0.72, 19.8], 0.025);
    b.rod([x, 0.72, 19.8], [x, 0.07, 19.8], 0.025);
    if (i % 3 === 0) continue;
    for (const z of [18.75, 19.85]) {
      b.add(new THREE.TorusGeometry(0.3, 0.025, 5, 16), 'metal', C.metal, [x + 0.15, 0.37, z], [0, Math.PI / 2, 0]);
      b.rod([x + 0.15, 0.37, z], [x + 0.15, 0.7, 19.3], 0.018, C.frame);
    }
    b.rod([x + 0.15, 0.7, 19.3], [x + 0.15, 0.37, 19.1], 0.023, C.frame);
    b.box([0.2, 0.045, 0.27], [x + 0.15, 0.85, 19.45], C.metal, 'metal');
    b.rod([x + 0.15, 0.7, 18.85], [x + 0.15, 1.05, 18.85], 0.018);
    b.rod([x - 0.08, 1.05, 18.85], [x + 0.38, 1.05, 18.85], 0.018);
  }
  for (const [x, z, w, d] of [[-30.3, -0.5, 0.22, 43], [28.7, -0.5, 0.22, 43], [-0.8, -22.2, 59, 0.22], [-17.4, 21.2, 25.5, 0.22], [17.2, 21.2, 23, 0.22]]) {
    b.box([w, 0.48, d], [x, 0.24, z], C.stone);
    b.box([w, 0.06, d], [x, 1.45, z], C.metal, 'metal');
    const count = Math.floor(Math.max(w, d) / 0.55);
    for (let i = 0; i <= count; i++) b.box([0.035, 1, 0.035], [x + (w > d ? (i / count - 0.5) * w : 0), 0.98, z + (d > w ? (i / count - 0.5) * d : 0)], C.metal, 'metal');
  }
  for (const x of [-5, 5.2]) b.box([0.65, 3.8, 0.8], [x, 1.9, 20.9], C.light);
  b.sign(3,[.1,3.9,21.45],3.2);
  b.box([10.9, 0.32, 1.05], [0.1, 3.85, 20.9], C.metal, 'metal');
  b.box([2.8, 2.8, 2.7], [-7.6, 1.4, 19.5], C.concrete);
  b.box([3.25, 0.18, 3.1], [-7.6, 2.89, 19.5], C.metal, 'metal');
  b.box([2.3, 1.25, 0.06], [-7.6, 1.8, 20.89], C.glassLight, 'glass');
  b.box([0.06, 1.25, 2.1], [-6.17, 1.8, 19.5], C.glassLight, 'glass');
  b.box([0.07, 1.3, 0.1], [-7.6, 1.8, 20.95], C.frame, 'metal');
  b.box([0.95, 2.1, 0.08], [-7.6, 1.05, 18.11], C.metal, 'metal');
  b.box([0.28, 1.04, 0.28], [3.8, 0.52, 19.4], C.frame, 'metal');
  b.box([5.4, 0.1, 0.1], [1.2, 0.98, 19.4], C.white, 'markings');
  const trees = [
    [-26.7, -15.1, 5.1], [-26.6, -8, 4.7], [-26.4, -0.3, 4.3],
    [-23, -16, 4.4], [-16.5, -16, 4.7], [-10, -16, 4.4], [-4.5, -16, 4.5],
    [3, -19, 4.7], [10, -19.2, 4.4], [20, -19.2, 5],
    [22.8, -13, 4.6], [22.7, -4.6, 4.5], [22.6, 7.3, 4.1],
    [-21, 8.3, 4.1], [-9.6, 8.3, 4.2], [-24.4, 19.2, 4.4], [-17, 19.1, 4.7],
  ];
  trees.forEach(([x, z, h], index) => broadleaf(b, x, z, h, index + 61));
}

export function createArchitecturalCampus() {
  const group = new THREE.Group();
  group.name = 'campus-architecture';
  group.userData = { conceptual: true, closed: true, basis:'原创建筑设计示意，非真实校园测绘' };
  const { materials, textures } = createMaterials(), b = batch(group, materials), roofs = new Map(), anchors = new Map();
  site(b);
  for (const building of CAMPUS_BUILDINGS) {
    const semantic = new THREE.Object3D();
    semantic.name = building.id;
    semantic.position.set(...building.position);
    semantic.userData = { ...building, conceptual: true, role: 'building' };
    group.add(semantic);
    buildingShell(b, building);
    const [bx,,bz]=building.position;
    b.tag('sign_'+building.id,'楼栋标识','sign',building.id);
    b.sign(CAMPUS_BUILDINGS.indexOf(building),[bx,building.id==='laboratory'?4.16:4.13,bz+building.size[1]/2+.81],building.id==='laboratory'?3.2:3.5);
    const roof = roofGroup(building, materials);
    roofs.set(building.id, roof);
    group.add(roof);
  }
  for (const [id, entry] of Object.entries(CAMPUS_LAYOUT)) {
    const position = new THREE.Vector3(...entry.position), node = new THREE.Object3D();
    anchors.set(id, position);
    node.name = id;
    node.position.copy(position);
    node.userData = { ...entry, pointId: id, conceptual: true };
    group.add(node);
  }
  b.finish();
  let disposed = false;
  return {
    group, anchors, roofs, buildings:CAMPUS_BUILDINGS,
    setRoofOpen(value){for(const roof of roofs.values()){roof.visible=!value;}},
    bounds: new THREE.Box3(new THREE.Vector3(-30.7, 0, -22.5), new THREE.Vector3(29.1, 9.5, 21.5)),
    target: new THREE.Vector3(-1.3, 1.9, -1.1),
    cameraPosition: new THREE.Vector3(57, 47, 67),
    dispose() {
      if (disposed) return;
      disposed = true;
      group.traverse(object => { if (object.isMesh) object.geometry.dispose(); });
      Object.values(materials).forEach(material => material.dispose());
      textures.forEach(texture => texture.dispose());
      group.removeFromParent();
    },
  };
}

