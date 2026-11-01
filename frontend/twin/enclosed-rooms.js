import { CAMPUS_LAYOUT } from './campus-layout.js';
import { createTreeCrown } from './architectural-lighting.js';
import * as THREE from '../vendor/three/three.module.js';
import { RoundedBoxGeometry } from '../vendor/three/RoundedBoxGeometry.js';
import { mergeGeometries } from '../vendor/three/BufferGeometryUtils.js';

// Metres; every surface and label is an architectural concept, never live telemetry.
const SURFACES = {
  plaster: [0xebece7, .9, 0, 'plaster'], ceiling: [0xf6f6f0, .92, 0],
  floor: [0xd6dcd9, .48, 0, 'tile'], trim: [0x8e9691, .66, .12],
  wood: [0xc4ac88, .64, 0, 'wood'], edge: [0x8d7758, .8, 0],
  steel: [0x81908f, .48, .38], chair: [0x637b79, .68, 0],
  board: [0x2d4540, .93, 0, 'plaster'], dark: [0x435259, .52, .24, 'metal'],
  panel: [0x859499, .42, .3, 'metal'], port: [0x10171c, .83, .12],
  blue: [0x4e8299, .68, .04], green: [0x708375, .97, 0],
  facade: [0xc7c7bd, .98, 0], outsideGlass: [0x708e98, .32, .2],
  light: [0xe7ece3, .42, 0], glass: [0xc5e0e0, .14, .12],
};

function canvasTexture(width, height, draw) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  let context;
  try { context = canvas.getContext('2d'); } catch { return null; }
  if (!context) return null;
  draw(context, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function surfaceTexture(kind) {
  const texture = canvasTexture(128, 128, (ctx, w, h) => {
    let seed = 173;
    const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    ctx.fillStyle = '#efefeb'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 2400; i++) {
      const shade = Math.floor(211 + noise() * 35);
      ctx.fillStyle = `rgba(${shade},${shade},${shade},.35)`;
      ctx.fillRect(noise() * w, noise() * h, kind === 'metal' ? 8 : 1, 1);
    }
    if (kind === 'tile') {
      ctx.fillStyle = '#afb6b2'; ctx.fillRect(0, 0, w, 1); ctx.fillRect(0, 0, 1, h);
      ctx.fillStyle = '#f5f6f1'; ctx.fillRect(1, 1, w, 1); ctx.fillRect(1, 1, 1, h);
    }
    if (kind === 'plank') {
      ctx.fillStyle='#e7e5df'; ctx.fillRect(0,0,w,h);
      for(let column=0;column<8;column++){
        const start=column*w/8, offset=column%3*h/3;
        ctx.fillStyle=['#dedbd3','#d4d0c7','#e9e5dd'][column%3];ctx.fillRect(start,0,w/8,h);
        ctx.strokeStyle='#bab6ad';ctx.lineWidth=.5;
        ctx.beginPath();ctx.moveTo(start,0);ctx.lineTo(start,h);ctx.moveTo(start,offset);ctx.lineTo(start+w/8,offset);ctx.stroke();
        for(let line=1;line<9;line++){ctx.strokeStyle='rgba(100,86,67,.10)';ctx.beginPath();ctx.moveTo(start+line*w/72,0);ctx.bezierCurveTo(start+line*w/72+1,h/3,start+line*w/72-1,h*.7,start+line*w/72,h);ctx.stroke();}
      }
    }
    if (kind === 'wood') {
      for (let y = 0; y < h; y += 2) {
        ctx.strokeStyle = `rgba(103,86,59,${.025 + noise() * .09})`;
        ctx.beginPath(); ctx.moveTo(0, y);
        ctx.bezierCurveTo(40, y + noise() * 3, 90, y - noise() * 3, w, y); ctx.stroke();
      }
    }
    if (kind === 'metal') {
      ctx.fillStyle = '#bfc2c0';
      for (let y = 4; y < h; y += 8) for (let x = 4; x < w; x += 8) ctx.fillRect(x, y, 1, 1);
    }
  });
  if (texture) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
  }
  return texture;
}

const LABELS = [
  ['C01  照明教室', 'CLASSROOM · CONCEPT'], ['照明开关', 'LIGHTING CONTROL'],
  ['C07  网络机房', 'NETWORK ROOM · CONCEPT'], ['配线架', 'PATCH PANEL'],
  ['交换设备', 'NETWORK SWITCH'], ['设备机柜', 'EQUIPMENT RACK'],
  ['维护工作台', 'SERVICE DESK'], ['校园教学楼', 'CAMPUS · CONCEPT'],
  ['照明设施', 'LIGHTING SYSTEM'], ['维护通道', 'SERVICE AISLE'],
];

const CLASSROOM_SURFACES = {
  plaster: [0xece9e1, .9, 0], ceiling: [0xd0bea0, .9, 0],
  floor: [0x9a9182, .55, 0, 'plank'], wood: [0xcdb18a, .48, 0, 'wood'],
  chair: [0xc3a27b, .54, 0, 'wood'], edge: [0x9e8060, .64, 0],
  board: [0xeeeeea, .34, 0], steel: [0x9ba5a6, .32, .72],
  ceilingGrid: [0x78594b, .72, .08], housing: [0x202a30, .34, .4],
};
function makeBuilder(pointId) {
  const surfaces = pointId === 'C01' ? {...SURFACES, ...CLASSROOM_SURFACES} : SURFACES;
  const group = new THREE.Group(); group.name = `point-${pointId}-interior`;
  group.userData = { pointId, conceptual: true, interior: true };
  const roof = new THREE.Group(); roof.name = 'closed-ceiling'; group.add(roof);
  const door = new THREE.Group(); door.name = 'entrance-door'; group.add(door);
  const window = new THREE.Group(); window.name = 'operable-window'; group.add(window);
  const portal = new THREE.Group(); portal.name = 'access-portal-door'; group.add(portal);
  const fan = new THREE.Group(); fan.name = 'illustrative-ventilation-fan'; group.add(fan);
  const sections = { room: group, roof, door, window, fan, portal };
  const batches = new Map(), textures = new Map(), materials = new Set();
  let section = 'room', frame = new THREE.Matrix4(), semantic = 'architecture';
  function texture(kind) {
    if (!textures.has(kind)) textures.set(kind, surfaceTexture(kind));
    return textures.get(kind);
  }
  function material(key) {
    if (key === 'label') {
      if (!textures.has('label')) textures.set('label', canvasTexture(1024, 512, ctx => {
        LABELS.forEach(([title, sub], index) => {
          const x = (index % 4) * 256, y = Math.floor(index / 4) * 128;
          ctx.fillStyle = '#e3e7df'; ctx.fillRect(x, y, 256, 128);
          ctx.fillStyle = '#334946'; ctx.fillRect(x + 15, y + 20, 3, 87);
          ctx.font = '500 25px "Microsoft YaHei", sans-serif'; ctx.fillText(title, x + 29, y + 57);
          ctx.fillStyle = '#6b7771'; ctx.font = '12px Arial'; ctx.fillText(sub, x + 29, y + 87);
        });
      }));
      return new THREE.MeshStandardMaterial({ color: 0xffffff, map: textures.get('label'), roughness: .9 });
    }
    if (key === 'sky') {
      if (!textures.has('sky')) textures.set('sky', canvasTexture(16, 256, (ctx, w, h) => {
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, '#93b9ce'); gradient.addColorStop(.65, '#c7dae2'); gradient.addColorStop(1, '#e3e9e7');
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
      }));
      return new THREE.MeshBasicMaterial({ color: textures.get('sky') ? 0xffffff : 0xc9dfe8, map: textures.get('sky'), side: THREE.DoubleSide, fog: false });
    }
    if (key === 'contact') {
      if (!textures.has('contact')) textures.set('contact', canvasTexture(64, 64, (ctx, w, h) => {
        const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
        gradient.addColorStop(0, 'rgba(34,44,40,.22)'); gradient.addColorStop(.5, 'rgba(34,44,40,.13)'); gradient.addColorStop(1, 'rgba(34,44,40,0)');
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
      }));
      return new THREE.MeshBasicMaterial({ color: 0x434a46, map: textures.get('contact'), transparent: true, opacity: textures.get('contact') ? 1 : .12, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    }
    const [color, roughness, metalness, map] = surfaces[key];
    const result = new THREE.MeshStandardMaterial({ color, roughness, metalness, map: map ? texture(map) : null });
    if (map && ['wood','plank'].includes(map)) { result.bumpMap = result.map; result.bumpScale = .001; }
    if (key === 'glass') { result.transparent = true; result.opacity = .15; result.depthWrite = false; }
    if (key === 'light') { result.emissive.set(0xf5f8ff); result.emissiveIntensity = .45; }
    return result;
  }
  function add(geometry, key, position = [0, 0, 0], rotation = [0, 0, 0]) {
    const transform = new THREE.Matrix4().compose(new THREE.Vector3(...position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1));
    const plain = geometry.index ? geometry.toNonIndexed() : geometry.clone(); geometry.dispose();
    plain.applyMatrix4(transform); plain.applyMatrix4(frame);
    const batchId = `${section}:${key}`;
    if (!batches.has(batchId)) batches.set(batchId, { section, key, parts: [], ids: new Set() });
    const batch = batches.get(batchId); batch.parts.push(plain); batch.ids.add(semantic);
  }

  function box(size, position, key, rotation) {
    const geometry = new THREE.BoxGeometry(...size);
    if (surfaces[key]?.[3]) {
      const uv = geometry.getAttribute('uv'), normals = geometry.getAttribute('normal');
      const tile = surfaces[key]?.[3] === 'plank' ? 1.6 : key === 'floor' ? .6 : 1;
      for (let i = 0; i < uv.count; i++) {
        const x = Math.abs(normals.getX(i)), y = Math.abs(normals.getY(i));
        uv.setXY(i, uv.getX(i) * (x > .5 ? size[2] : size[0]) / tile, uv.getY(i) * (y > .5 ? size[2] : size[1]) / tile);
      }
    }
    add(geometry, key, position, rotation);
  }
  function label(index, position, width = .8, rotation) {
    const geometry = new THREE.PlaneGeometry(width, width / 2);
    const uv = geometry.getAttribute('uv'), col = index % 4, row = Math.floor(index / 4);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (col + .01 + uv.getX(i) * .98) / 4, 1 - (row + .99 - uv.getY(i) * .98) / 4);
    add(geometry, 'label', position, rotation);
  }
  function node(id, position) {
    const anchor = new THREE.Object3D(); anchor.name = id; anchor.position.set(...position);
    anchor.userData = { conceptual: true, pointId, id }; sections[section].add(anchor); semantic = id;
  }
  function inSection(next, fn) { const before = section; section = next; fn(); section = before; }
  function inFrame(position, yaw, fn) {
    const before = frame; frame = new THREE.Matrix4().makeRotationY(yaw); frame.setPosition(...position); fn(); frame = before;
  }
  function cable(points, key = 'blue', radius = .009) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    add(new THREE.TubeGeometry(curve, 10, radius, 5, false), key);
  }
  function contact(x, z, width, depth) { add(new THREE.PlaneGeometry(width, depth), 'contact', [x, .004, z], [-Math.PI / 2, 0, 0]); }
  function finish() {
    for (const batch of batches.values()) {
      const geometry = mergeGeometries(batch.parts, false); batch.parts.forEach(part => part.dispose());
      geometry.computeBoundingSphere();
      const surface = material(batch.key); materials.add(surface);
      const mesh = new THREE.Mesh(geometry, surface); mesh.name = `${pointId}:${batch.section}:${batch.key}`;
      mesh.userData = { pointId, conceptual: true, sourceIds: [...batch.ids] };
      mesh.castShadow = !['glass', 'light', 'sky', 'contact', 'label'].includes(batch.key);
      mesh.receiveShadow = !['glass', 'light', 'sky', 'contact'].includes(batch.key);
      sections[batch.section].add(mesh);
    }
    let disposed = false;
    return {
      group, roof, door, window, fan, portal,
      setWindowOpen(fraction) { window.rotation.y = THREE.MathUtils.clamp(fraction,0,1)*.85; },
      setPortalOpen(fraction) { portal.rotation.y = THREE.MathUtils.clamp(fraction,0,1)*Math.PI*.46; },
      setDoorOpen(fraction) { door.userData.open=fraction>.5; door.rotation.y = -THREE.MathUtils.clamp(fraction, 0, 1) * Math.PI * .48; },
      dispose() {
        if (disposed) return; disposed = true;
        group.traverse(object => { if (object.isMesh) object.geometry.dispose(); });
        materials.forEach(value => value.dispose());
        new Set(textures.values()).forEach(value => value?.dispose());
        group.removeFromParent();
      },
    };
  }
  return { group, roof, door, window, fan, portal, add, box, label, node, inSection, inFrame, cable, contact, finish, surfaces };
}

function exterior(b, width, depth) {
  b.node('conceptual-campus-exterior', [-width / 2 - 10, 0, 0]);
  b.add(new THREE.PlaneGeometry(60, 34), 'sky', [-35, 9, 0], [0, Math.PI / 2, 0]);
  b.box([30, .2, depth + 32], [-width / 2 - 15, -3.25, 0], 'facade');
  b.box([4, .015, depth + 28], [-width / 2 - 5, -3.14, 0], 'floor');
  b.box([4.8, 7.4, 22], [-24, .5, -2], 'facade');
  for (const y of [-1.2, 1.4, 4]) {
    b.box([.08, .16, 22.2], [-21.55, y - .94, -2], 'trim');
    for (let z = -12; z <= 8; z += 2.4) {
      b.box([.08, 1.55, 1.55], [-21.55, y, z], 'outsideGlass');
      b.box([.12, 1.6, .045], [-21.47, y, z], 'facade');
    }
  }
  for (const z of [-6, -.5, 5]) {
    b.box([.22, 3.5, .22], [-12, -1.45, z], 'edge');
    b.add(createTreeCrown(4.2, Math.round(z*10+100)), 'green', [-12,-3.2,z]);

  }
}

function shell(b, { width, depth, height, doorX, windowSill, windowHeight, windowCentres, windowWidth, portal=false }) {
  const left = -width / 2, right = width / 2, front = -depth / 2, back = depth / 2, doorWidth = 1.2, doorHeight = 2.25;
  b.node('complete-room-shell', [0, 0, 0]);
  b.box([width + .36, .2, depth + .36], [0, -.1, 0], 'floor');
  if(portal){
    for(const side of [-1,1])b.box([(width-3.5)/2,height,.18],[side*(width+3.5)/4,height/2,front-.09],'plaster');
    b.box([3.5,height-2.85,.18],[0,(height+2.85)/2,front-.09],'plaster');
    b.box([4,.2,2.4],[0,-.1,front-1.2],'floor');
  }else b.box([width + .36, height, .18], [0, height / 2, front - .09], 'plaster');
  b.box([.18, height, depth], [right + .09, height / 2, 0], 'plaster');
  b.box([.18, windowSill, depth], [left - .09, windowSill / 2, 0], 'plaster');
  const top = windowSill + windowHeight;
  b.box([.18, height - top, depth], [left - .09, (height + top) / 2, 0], 'plaster');
  let end = front;
  for (const z of windowCentres) {
    const start = z - windowWidth / 2;
    if (start > end) b.box([.18, windowHeight, start - end], [left - .09, windowSill + windowHeight / 2, (start + end) / 2], 'plaster');
    if(z===windowCentres[0]){
      b.window.position.set(left-.09, windowSill, z-windowWidth/2);
      b.inSection('window',()=>{
        b.box([.045,windowHeight-.08,windowWidth-.08],[0,windowHeight/2,windowWidth/2],'glass');
        for(const zz of [0,windowWidth])b.box([.07,windowHeight,.04],[0,windowHeight/2,zz],'steel');
        for(const yy of [0,windowHeight])b.box([.07,.04,windowWidth],[0,yy,windowWidth/2],'steel');
      });
    }else b.box([.045, windowHeight - .08, windowWidth - .08], [left - .09, windowSill + windowHeight / 2, z], 'glass');
    for (const dz of [-windowWidth / 2, 0, windowWidth / 2]) b.box([.1, windowHeight + .06, .045], [left, windowSill + windowHeight / 2, z + dz], 'steel');
    for (const y of [windowSill, top, windowSill + windowHeight * .72]) b.box([.1, .045, windowWidth], [left, y, z], 'steel');
    b.box([.34, .045, windowWidth + .15], [left + .03, windowSill - .02, z], 'trim');
    for(const edge of [-windowWidth/2,windowWidth/2]) b.box([.22,windowHeight,.035],[left+.015,windowSill+windowHeight/2,z+edge],'ceiling');
    b.box([.17,.08,windowWidth+.14],[left+.04,top+.04,z],'ceiling');
    for(let strip=0;strip<4;strip++) b.box([.12,.025,windowWidth-.08],[left+.045,top-.08-strip*.045,z],'ceiling',[0,0,.15]);
    end = z + windowWidth / 2;
  }
  if (end < back) b.box([.18, windowHeight, back - end], [left - .09, windowSill + windowHeight / 2, (back + end) / 2], 'plaster');
  const doorLeft = doorX - doorWidth / 2, doorRight = doorX + doorWidth / 2;
  b.box([doorLeft - left, height, .18], [(doorLeft + left) / 2, height / 2, back + .09], 'plaster');
  b.box([right - doorRight, height, .18], [(right + doorRight) / 2, height / 2, back + .09], 'plaster');
  b.box([doorWidth, height - doorHeight, .18], [doorX, (height + doorHeight) / 2, back + .09], 'plaster');
  for (const x of [doorLeft - .035, doorRight + .035]) b.box([.07, doorHeight + .04, .24], [x, doorHeight / 2, back], 'steel');
  b.box([doorWidth + .14, .075, .24], [doorX, doorHeight + .02, back], 'steel');
  b.box([doorWidth, .014, .25], [doorX, .007, back], 'trim');
  b.door.position.set(doorLeft, 0, back + .02);
  b.door.userData = { conceptual: true, width: doorWidth, height: doorHeight, hinge: 'left', opens: 'outward' };
  b.inSection('door', () => {
    b.node('hinged-door-leaf', [doorWidth / 2, 1.1, 0]);
    b.box([doorWidth - .025, doorHeight - .025, .05], [doorWidth / 2, doorHeight / 2, 0], 'wood');
    b.box([.3, .045, .07], [doorWidth - .23, 1.04, -.055], 'steel');
    for (const y of [.3, 1.9]) b.box([.035, .12, .065], [0, y, 0], 'steel');
  });
  b.box([width + .35, .2, 2.1], [0, -.1, back + 1.15], 'floor');
  b.box([width + .35, height, .16], [0, height / 2, back + 2.2], 'plaster');
  for (const x of [left - .09, right + .09]) b.box([.18, height, 2.2], [x, height / 2, back + 1.1], 'plaster');
  b.label(7, [doorX, 1.5, back + 2.1], .85, [0, Math.PI, 0]);
  for (const x of [left, right]) b.box([.035, .11, depth], [x, .055, 0], 'trim');
  b.box([width, .11, .035], [0, .055, front], 'trim');
  for (const [a, z] of [[doorLeft - left, (doorLeft + left) / 2], [right - doorRight, (right + doorRight) / 2]]) b.box([a, .11, .035], [z, .055, back], 'trim');
  b.inSection('roof', () => {
    b.node('closed-roof', [0, height, 0]);
    b.box([width + .36, .18, depth + 2.55], [0, height + .09, 1.1], 'ceiling');
    for (let x = left + .6; x < right; x += .6) b.box([.004, .004, depth], [x, height - .005, 0], b.surfaces.ceilingGrid?'ceilingGrid':'trim');
    for (let z = front + .6; z < back; z += .6) b.box([width, .004, .004], [0, height - .005, z], b.surfaces.ceilingGrid?'ceilingGrid':'trim');
  });
  exterior(b, width, depth);
}

function desk(b, x, z) {
  b.add(new RoundedBoxGeometry(1.36,.045,.58,1,.008),'wood',[x,.747,z]);
  b.box([1.365, .018, .585], [x, .718, z], 'edge');
  for (const dx of [-.57, .57]) for (const dz of [-.22, .22]) b.box([.035, .69, .035], [x + dx, .35, z + dz], 'steel');
  b.box([1.13, .045, .035], [x, .25, z - .22], 'steel');
  b.box([1.12, .1, .02], [x, .61, z - .21], 'steel');
  for (const dx of [-.34, .34]) {
    const cx = x + dx, cz = z + .51;
    b.add(new RoundedBoxGeometry(.39,.035,.36,1,.008),'chair',[cx,.445,cz]);
    b.add(new RoundedBoxGeometry(.39,.31,.025,1,.01),'chair',[cx,.65,cz+.17],[-.08,0,0]);
    for (const sx of [-.15, .15]) {
      b.box([.024, .76, .024], [cx + sx, .39, cz + .13], 'steel', [-.06, 0, 0]);
      b.box([.024, .43, .024], [cx + sx, .22, cz - .12], 'steel');
    }
  }
  b.contact(x, z + .25, 1.7, 1.5);
}

function classroom(b) {
  const dimensions = { width: 8.4, depth: 10, height: 3.35 };
  shell(b, { ...dimensions, doorX: 3.3, windowSill: .9, windowHeight: 1.8, windowCentres: [-3.6, -1.2, 1.2, 3.6], windowWidth: 1.95 });
  b.node('C01-writing-board', [0, 1.8, -4.9]);
  b.box([4.4, 1.38, .065], [-.25, 1.83, -4.94], 'steel');
  b.box([4.29, 1.27, .025], [-.25, 1.83, -4.89], 'board');
  b.box([4.4, .035, .12], [-.25, 1.125, -4.82], 'steel');
  for(const x of [-3.35,3.15]){
    b.box([1.0,.61,.065],[x,2.25,-4.87],'housing');
    b.box([.92,.51,.012],[x,2.25,-4.83],'port');
  }
  b.label(0, [3.04, 2.05, -4.892], 1.35);
  b.box([3.6,.08,.08],[-.25,2.65,-4.86],'ceiling');
  b.inSection('roof',()=>{
    b.box([.035,.3,.035],[-.25,3.2,-1.5],'steel');
    b.box([.38,.12,.28],[-.25,2.99,-1.5],'ceiling');
    b.box([.08,.07,.02],[-.25,2.98,-1.65],'dark');
  });
  b.node('C01-teacher-podium', [-.25, 0, -3.75]);
  b.box([1.4, .06, .72], [-.25, .94, -3.75], 'wood');
  b.box([1.17, .88, .55], [-.25, .44, -3.75], 'steel');
  b.box([1.08, .69, .025], [-.25, .44, -3.455], 'wood');
  b.contact(-.25, -3.75, 1.75, 1.1);
  b.node('C01-classroom-desks', [0, 0, 0]);
  const obstacles = [{ minX: -.95, maxX: .45, minZ: -4.13, maxZ: -3.37 }];
  for (const x of [-2.5, -.25, 2]) for (const z of [-2.4, -1, .4, 1.8, 3.2]) {
    desk(b, x, z); obstacles.push({ minX: x - .7, maxX: x + .7, minZ: z - .3, maxZ: z + .73 });
  }
  b.inSection('roof', () => {
    b.node('C01-ceiling-luminaires', [0, 3.1, 0]);
    for (const x of [-2.5, -.25, 2]) for (const z of [-2.65, .1, 2.85]) {
      b.box([.56,.055,.56],[x,3.30,z],'housing');
      b.add(new THREE.CylinderGeometry(.12,.15,.13,20),'housing',[x,3.21,z]);
      b.add(new THREE.CircleGeometry(.145,20),'light',[x,3.14,z],[Math.PI/2,0,0]);
    }
  });
  b.node('C01-lighting-switch', [2.3, 1.3, 4.94]);
  b.box([.28, .16, .045], [2.3, 1.24, 4.955], 'ceiling');
  for (const x of [2.22, 2.3, 2.38]) b.box([.055, .1, .018], [x, 1.24, 4.923], 'trim');
  b.label(1, [2.3, 1.52, 4.918], .46, [0, Math.PI, 0]);
  b.box([.026, 1.83, .026], [2.3, 2.26, 4.966], 'trim');
  return { dimensions, obstacles, walkBounds: { minX: -3.92, maxX: 3.92, minZ: -4.72, maxZ: 4.72 }, cameraPosition: new THREE.Vector3(3.3, 1.62, 4.25), target: new THREE.Vector3(-.35, 1.28, -3.7), entryPosition: new THREE.Vector3(3.3, 1.62, 4.58) };
}

function equipmentRack(b, x, z, yaw, network) {
  b.inFrame([x, 0, z], yaw, () => {
    const width = .8, front = .552;
    b.box([width+.04,.07,1.14],[0,.07,0],'steel');
    b.box([width, .1, 1.1], [0, .11, 0], 'dark');
    b.box([width, .075, 1.1], [0, 2.18, 0], 'dark');
    b.box([width - .04, 2.02, .025], [0, 1.13, -.54], 'dark');
    for (const dx of [-.38, .38]) {
      b.box([.025, 2.02, 1.05], [dx, 1.13, 0], 'dark');
      b.box([.028, 1.95, .04], [dx * .87, 1.14, .51], 'steel');
      for (const dz of [-.42, .42]) b.box([.07, .08, .07], [dx, .04, dz], 'steel');
    }
    for (let row = 0; row < 6; row++) {
      const y = .35 + row * .2;
      b.box([.65, .16, .92], [0, y, .015], 'dark');
      b.box([.64, .145, .035], [0, y, front], 'panel');
      for (let slit = 0; slit < 10; slit++) b.box([.016, .082, .006], [-.245 + slit * .046, y, front + .021], 'port');
      for (const dx of [-.296, .296]) b.box([.018, .072, .028], [dx, y, front + .035], 'steel');
    }
    for (const y of [1.68, 1.94]) {
      b.box([.65, .145, .45], [0, y, .335], 'panel');
      for (let port = 0; port < 12; port++) b.box([.034, .032, .008], [-.257 + port * .046, y, front + .016], 'port');
    }
    b.label(network ? 4 : 5, [0, 2.105, front + .013], .34);
    if (network) {
      for (let port = 0; port < 6; port++) {
        const px = -.25 + port * .092;
        b.cable([[px, 1.94, front + .029], [px, 1.83, front + .14], [px + .025, 1.6, front + .2], [px + .045, 1.68, front + .029]], 'blue');
      }
      b.box([.05, .6, .12], [.305, 1.77, front + .045], 'dark');
    } else {
      b.box([.57, .43, .025], [0, 1.81, front + .027], 'dark');
      for (let slit = 0; slit < 14; slit++) b.box([.008, .35, .005], [-.245 + slit * .038, 1.81, front + .042], 'port');
    }
  });
  b.contact(x, z, 1.45, 1.18);
}

function serverRoom(b) {
  const dimensions = { width: 7.2, depth: 8.8, height: 3.15 };
  shell(b, { ...dimensions, doorX: 0, windowSill: 1.4, windowHeight: 1.3, windowCentres: [-2.8, -.3, 2.2], windowWidth: 1.7 });
  const obstacles = [];
  b.node('C07-network-rack-rows', [0, 0, 0]);
  for (const x of [-1.65, 1.65]) for (const z of [-2.7, -1.55, -.4, .75]) {
    equipmentRack(b, x, z, x < 0 ? Math.PI / 2 : -Math.PI / 2, x < 0);
    obstacles.push({ minX: x - .76, maxX: x + .76, minZ: z - .41, maxZ: z + .41 });
  }
  b.box([1.25,.002,7.6],[0,.002,-.15],'trim');
  b.label(2, [0, 2.06, -4.382], 1.35);
  b.label(9, [0, 1.25, -4.381], .8);
  b.node('C07-cable-trays', [0, 2.75, 0]);
  for (const x of [-1.65, 1.65]) {
    for (const dx of [-.22, .22]) b.box([.035, .12, 4.8], [x + dx, 2.73, -.85], 'steel');
    for (let z = -3.2; z < 1.6; z += .3) b.box([.46, .025, .035], [x, 2.68, z], 'steel');
    for (const z of [-2.8, 1.1]) for (const dx of [-.22, .22]) b.box([.018, .37, .018], [x + dx, 2.945, z], 'steel');
    for (const dx of [-.13, 0, .13]) b.box([.018, .018, 4.6], [x + dx, 2.71, -.85], 'blue');
    for (const z of [-2.7, -1.55, -.4, .75]) b.cable([[x, 2.18, z], [x, 2.47, z], [x + .08, 2.73, z - .16]], 'blue', .015);
  }
  b.inSection('roof', () => {
    b.node('C07-ceiling-lighting', [0, 2.96, 0]);
    for (const z of [-2.7, -.4, 1.9]) {
      b.box([.28, .065, 1.25], [0, 3.1, z], 'steel');
      b.box([.22, .025, 1.17], [0, 3.054, z], 'light');
    }
  });
  b.node('C07-service-station', [2.65, 0, 2.65]);
  b.box([1.25, .045, .65], [2.65, .82, 2.65], 'wood');
  for (const x of [2.13, 3.17]) for (const z of [2.4, 2.9]) b.box([.035, .78, .035], [x, .39, z], 'steel');
  b.box([.48, .026, .33], [2.65, .857, 2.65], 'panel');
  b.box([.48, .3, .025], [2.65, 1.005, 2.51], 'dark', [-.13, 0, 0]);
  b.box([.41, .235, .006], [2.65, 1.01, 2.53], 'port', [-.13, 0, 0]);
  b.label(6, [2.65, .72, 2.984], .45);
  b.contact(2.65, 2.65, 1.5, .95);
  obstacles.push({ minX: 2.01, maxX: 3.29, minZ: 2.31, maxZ: 2.99 });
  return { dimensions, obstacles, walkBounds: { minX: -3.32, maxX: 3.32, minZ: -4.12, maxZ: 4.12 }, cameraPosition: new THREE.Vector3(.05, 1.62, 3.45), target: new THREE.Vector3(-.3, 1.35, -2.4), entryPosition: new THREE.Vector3(.05, 1.62, 4.02) };
}


// Six distinct designed interiors. Dimensions/layouts are illustrative; no equipment state lives here.
function serviceRoom(b, pointId) {
  const dimensions = {width:pointId==='C04'?10.8:pointId==='C05'?10:9.6,depth:pointId==='C06'?12:pointId==='C05'?9:11,height:pointId==='C06'?4.2:3.8};
  shell(b,{...dimensions,doorX:2.65,windowSill:1.1,windowHeight:1.65,windowCentres:[-3.6,-1.2,1.2,3.6],windowWidth:1.9,portal:pointId==='C05'});
  const obstacles=[];
  const obstruction=(x,z,w,d)=>obstacles.push({minX:x-w/2,maxX:x+w/2,minZ:z-d/2,maxZ:z+d/2});
  const bench=(x,z,w=2.2)=>{
    b.box([w,.06,.82],[x,.86,z],'wood');
    for(const dx of [-w/2+.12,w/2-.12])for(const dz of [-.3,.3])b.box([.055,.82,.055],[x+dx,.41,z+dz],'steel');
    b.contact(x,z,w+.2,1.05);obstruction(x,z,w,.85);
  };
  const grille=(x,y,z,w,h)=>{
    b.box([w+.1,h+.1,.12],[x,y,z],'steel');
    b.box([w,h,.025],[x,y,z+.075],'port');
    for(let i=0;i<Math.round(h/.075);i++)b.box([w,.025,.035],[x,y-h/2+.04+i*.075,z+.1],'panel');
  };
  const monitor=(x,y,z)=>{
    b.box([.51,.33,.04],[x,y,z],'dark');b.box([.46,.27,.008],[x,y,z+.026],'port');
    b.box([.025,.19,.025],[x,y-.23,z],'steel');b.box([.27,.025,.17],[x,y-.32,z],'dark');
  };
  const ac=(x,y,z)=>{
    b.node(pointId+'-air-conditioning-unit',[x,y,z]);
    b.add(new RoundedBoxGeometry(1.55,.48,.31,2,.04),'ceiling',[x,y,z]);
    grille(x,y-.13,z+.16,1.3,.12);b.box([.025,.8,.025],[x+.65,y-.6,z-.13],'trim');
  };
  b.inSection('roof',()=>{
    b.node(pointId+'-designed-luminaires',[0,3.2,0]);
    for(const x of [-1.8,1.8])for(const z of [-2.5,.2,2.8]){
      b.box([.61,.055,.61],[x,dimensions.height-.05,z],'steel');b.box([.55,.015,.55],[x,dimensions.height-.085,z],'light');
    }
  });
  if(pointId==='C02'){
    // HVAC seminar room: wall-mounted units, thermostat, meeting table, ventilation register.
    ac(-1.85,2.72,-dimensions.depth/2+.18);ac(1.55,2.72,-dimensions.depth/2+.18);
    b.node('C02-thermostat',[3.52,1.35,1.3]);
    b.box([.07,.19,.13],[dimensions.width/2-.04,1.35,1.3],'ceiling');b.box([.01,.08,.09],[dimensions.width/2-.085,1.38,1.3],'port');
    grille(0,3.3,-dimensions.depth/2+.08,.92,.25);
    bench(-.5,-.7,3.4);bench(-.5,.8,3.4);
    for(const x of [-1.7,-.5,.7])for(const z of [-1.38,1.48]){
      b.box([.43,.055,.43],[x,.46,z],'chair');b.box([.43,.42,.045],[x,.68,z+(z<0?-.2:.2)],'chair');
      for(const xx of [-.16,.16])for(const zz of [-.16,.16])b.box([.027,.44,.027],[x+xx,.22,z+zz],'steel');
      obstruction(x,z,.46,.48);
    }
  } else if(pointId==='C03'){
    // Network classroom: desk terminals, ceiling AP and visible cable route to the wall patch box.
    for(const x of [-1.8,1.1])for(const z of [-2.6,-.7,1.2]){bench(x,z,1.8);monitor(x,1.23,z-.2);b.box([.45,.025,.14],[x,.91,z+.19],'panel');}
    b.inSection('roof',()=>{
      b.node('C03-wireless-access-point',[0,3.18,0]);b.add(new THREE.CylinderGeometry(.17,.17,.055,24),'ceiling',[0,dimensions.height-.065,0]);
      b.box([.025,.025,dimensions.depth/2],[0,dimensions.height-.03,-dimensions.depth/4],'trim');
    });
    b.node('C03-patch-box',[2.8,1.45,-dimensions.depth/2+.1]);b.box([.46,.65,.16],[2.8,1.45,-dimensions.depth/2+.1],'panel');
    b.box([.025,1.5,.025],[2.8,2.5,-dimensions.depth/2+.1],'steel');
    for(const x of [2.65,2.75,2.85,2.95])b.box([.045,.035,.015],[x,1.3,-dimensions.depth/2+.19],'port');
  } else if(pointId==='C04'){
    // Electrical practice lab: independent main isolator cabinet, conduit, work benches and equipment.
    b.node('C04-main-power-cabinet',[-1.7,1.2,-3.75]);
    for(const x of [-2.6,-1.6,-.6]){
      b.box([.92,2.12,.5],[x,1.12,-3.72],'panel');b.box([.83,1.99,.025],[x,1.12,-3.45],'ceiling');
      b.box([.18,.22,.025],[x,1.62,-3.42],'port');b.add(new THREE.CylinderGeometry(.07,.07,.06,16),'dark',[x,1.13,-3.39],[Math.PI/2,0,0]);
      b.box([.02,.23,.04],[x+.29,1.08,-3.39],'steel');
    }
    b.box([2.95,.17,.19],[-1.6,2.5,-3.8],'steel');b.box([.14,.7,.14],[-1.6,2.95,-3.8],'steel');
    obstruction(-1.6,-3.7,3,.6);
    for(const z of [-1.1,1.2]){bench(-1.2,z,3.5);for(const x of [-2.35,-1.2,-.05]){b.box([.48,.37,.35],[x,1.075,z],'ceiling');b.box([.25,.14,.02],[x,1.14,z+.185],'port');}}
  } else if(pointId==='C05'){
    // Entrance vestibule: two glazed door leaves, reader, door closer and reception counter.
    b.node('C05-access-controlled-portal',[0,1.4,-dimensions.depth/2]);
    for(const x of [-1.7,0,1.7])b.box([.1,2.75,.16],[x,1.375,-dimensions.depth/2],'steel');
    b.box([3.5,.1,.16],[0,2.75,-dimensions.depth/2],'steel');
    // Real opening in the perimeter wall; the two leaves share a visible swing pivot.
    b.portal.position.set(-1.68,0,-dimensions.depth/2+.03);
    b.portal.userData={interaction:'portal',open:false,conceptual:true};
    b.inSection('portal',()=>{
      for(const x of [.83]){
        b.box([1.59,2.58,.055],[x,1.35,0],'glass');
        for(const xx of [x-.8,x+.8])b.box([.055,2.65,.08],[xx,1.35,0],'steel');
        for(const yy of [.05,2.68])b.box([1.65,.055,.08],[x,yy,0],'steel');
        b.box([.04,.65,.08],[x+.6,1.3,.08],'steel');
      }
    });
    b.box([1.59,2.58,.055],[.81,1.35,-dimensions.depth/2+.03],'glass');
    b.box([.04,.65,.08],[.2,1.3,-dimensions.depth/2+.11],'steel');
    b.node('C05-card-reader',[2.06,1.28,-dimensions.depth/2+.02]);b.box([.15,.24,.07],[2.06,1.28,-dimensions.depth/2+.02],'dark');
    b.box([.095,.08,.013],[2.06,1.32,-dimensions.depth/2+.07],'port');
    b.box([1.5,1.0,.85],[-2.2,.5,.7],'wood');b.box([1.65,.05,.95],[-2.2,1.025,.7],'ceiling');monitor(-2.2,1.35,.55);
    obstruction(-2.2,.7,1.65,.95);
    b.box([2.6,.009,1.4],[0,.008,-2.6],'dark');
    for(const z of [-.8,1.2]){b.box([.64,.13,1.5],[2.6,.48,z],'wood');for(const zz of [-.55,.55])b.box([.05,.43,.05],[2.6,.22,z+zz],'steel');obstruction(2.6,z,.7,1.5);}
  } else if(pointId==='C06'){
    // Ventilation lab: fume hood, transparent sash, canopy and round exhaust duct.
    b.node('C06-exhaust-hood',[-1.7,1.7,-3.4]);
    b.box([2.65,.85,1.15],[-1.65,.425,-3.35],'panel');b.box([2.7,.065,1.22],[-1.65,.89,-3.35],'dark');
    for(const x of [-2.95,-.35])b.box([.1,1.5,1.12],[x,1.67,-3.35],'ceiling');
    b.box([2.65,.4,1.15],[-1.65,2.56,-3.35],'ceiling');
    b.box([2.39,1.25,.035],[-1.65,1.63,-2.79],'glass');
    b.box([2.4,.045,.07],[-1.65,1.05,-2.74],'steel');
    b.add(new THREE.CylinderGeometry(.3,.3,.65,24),'steel',[-1.65,3.08,-3.35]);
    b.box([.8,.8,.19],[1.7,2.55,-dimensions.depth/2+.12],'steel');
    b.fan.position.set(1.7,2.55,-dimensions.depth/2+.25);b.inSection('fan',()=>{
      b.add(new THREE.CylinderGeometry(.09,.09,.12,16),'dark',[0,0,0],[Math.PI/2,0,0]);
      for(let i=0;i<4;i++)b.box([.12,.55,.03],[0,0,0],'panel',[0,0,i*Math.PI/2+.35]);
    });
    obstruction(-1.65,-3.35,2.7,1.25);bench(-1.1,.25,3.5);bench(2.0,-1.1,1.35);
  } else if(pointId==='C08'){
    // Equipment environment: two tall cooling cabinets, two racks and an independent wall sensor.
    for(const x of [-2.25,-.65]){
      b.node('C08-cooling-cabinet-'+x,[x,1.3,-3.4]);b.box([1.25,2.55,.9],[x,1.325,-3.45],'ceiling');
      grille(x,1.12,-2.98,1.08,1.48);b.box([.27,.16,.025],[x,2.35,-2.97],'port');
      b.box([1.32,.12,.96],[x,.06,-3.45],'dark');obstruction(x,-3.45,1.32,1.0);
    }
    equipmentRack(b,1.9,-2.65,0,false);equipmentRack(b,1.9,-.9,0,false);
    obstruction(1.9,-2.65,.86,1.2);obstruction(1.9,-.9,.86,1.2);
    b.node('C08-environment-sensor',[dimensions.width/2-.08,1.5,1.0]);b.box([.12,.38,.25],[dimensions.width/2-.08,1.5,1.0],'ceiling');
    b.box([.025,.13,.16],[dimensions.width/2-.155,1.56,1.0],'port');b.box([.025,1.5,.025],[dimensions.width/2-.07,2.6,1],'trim');
    for(const z of [-2.5,-1,.5,2])b.box([1.5,.007,.035],[0,.008,z],'steel');
  }
  // Each service space has its own perimeter equipment and a continuous circulation aisle.
  const back=-dimensions.depth/2+.24,side=dimensions.width/2-.35;
  b.node(pointId+'-specialist-space',[0,0,0]);
  if(pointId==='C02'){
    b.box([5.8,.06,2.8],[-.5,.015,-.1],'floor');
    b.box([3.2,1.65,.08],[0,1.9,back],'board');
    for(const x of [-2.4,0,2.4]){b.box([1.9,.32,.7],[x,dimensions.height-.3,-2.8],'ceiling');b.box([1.6,.035,.5],[x,dimensions.height-.48,-2.8],'steel');}
    b.box([.12,.45,dimensions.depth-1],[side,dimensions.height-.45,0],'panel');
  }else if(pointId==='C03'){
    for(const z of [-3,-.5,2]){bench(-3.5,z,1.35);monitor(-3.5,1.23,z-.2);}
    b.box([3.4,1.6,.08],[0,1.9,back],'board');
    b.box([.08,.12,dimensions.depth-1],[side,2.9,0],'blue');
    b.box([1.1,1.4,.45],[3.6,.9,back+.15],'panel');obstruction(3.6,back+.15,1.1,.5);
  }else if(pointId==='C04'){
    for(const z of [-3,0,2.7]){bench(3.6,z,2);b.box([1.65,.9,.15],[3.6,1.35,z-.3],'panel');for(let i=0;i<6;i++)b.box([.12,.12,.045],[2.95+i*.25,1.45,z-.2],'port');}
    b.box([3.6,.008,1],[-1.6,.012,-2.7],'dark');
    for(let i=0;i<9;i++)b.box([.15,.009,.75],[-3.1+i*.4,.022,-2.7],'wood',[0,.45,0]);
    b.box([1.4,2.3,.55],[-4.3,1.15,2.4],'panel');obstruction(-4.3,2.4,1.4,.55);
  }else if(pointId==='C05'){
    b.box([3.1,.018,3.6],[0,.015,-2.0],'floor');
    b.box([.12,2.5,2.3],[-3.4,1.25,-2.4],'glass');
    b.box([.05,.9,1.3],[side,1.7,0],'panel');
    b.box([1.7,1.2,.5],[-3.5,.6,2.7],'wood');obstruction(-3.5,2.7,1.7,.5);
  }else if(pointId==='C06'){
    b.box([.65,.45,6],[-1.65,3.5,-1.6],'steel');
    for(const z of [-3.7,-1.8,.1,2]){b.box([.8,.08,.12],[-1.65,3.8,z],'dark');b.box([.035,.35,.035],[-1.98,3.9,z],'steel');}
    for(const z of [-3.3,.3,3]){bench(3.0,z,2);b.box([.75,.48,.55],[3,1.13,z],'ceiling');b.box([.35,.15,.03],[3,1.18,z+.29],'port');}
    b.box([1.3,2.3,.6],[-3.6,1.15,2.6],'panel');obstruction(-3.6,2.6,1.3,.6);
  }else if(pointId==='C08'){
    b.box([2,.008,7],[0,.015,-.5],'blue');
    for(const z of [-3,-1,1,3])for(let i=0;i<9;i++)b.box([1.7,.009,.035],[0,.026,z+i*.055],'steel');
    for(const x of [-3.6,3.6]){b.box([.26,.18,8],[x,2.95,-.5],'steel');b.box([.075,2.8,.075],[x,1.4,-4.4],'blue');}
    bench(-3.3,2.2,1.8);monitor(-3.3,1.25,2);
  }
  return {dimensions,obstacles,hasFan:pointId==='C06',hasPortal:pointId==='C05',walkBounds:{minX:-dimensions.width/2+.28,maxX:dimensions.width/2-.28,minZ:-dimensions.depth/2+.28,maxZ:dimensions.depth/2-.28},cameraPosition:new THREE.Vector3(2.65,1.62,dimensions.depth/2-1.3),entryPosition:new THREE.Vector3(2.65,1.62,dimensions.depth/2-.38),target:new THREE.Vector3(-.7,1.45,-2.5)};
}

export function createEnclosedRoom(pointId) {
  if (!CAMPUS_LAYOUT[pointId]) throw new RangeError(`No enclosed room for campus point: ${pointId}`);
  const b = makeBuilder(pointId);
  const room = pointId === 'C01' ? classroom(b) : pointId === 'C07' ? serverRoom(b) : serviceRoom(b, pointId);
  for(const z of [-1.8,1.8]){const light=new THREE.PointLight(0xfff1de,9,11,2);light.name='illustrative-interior-fill';light.position.set(0,2.8,z);b.group.add(light);}
  b.group.userData.dimensions = room.dimensions;
  b.group.userData.basis = '原创建筑设计示意；尺寸暂估，非测绘；设备外形不代表实时状态';
  const result = b.finish();
  const {facilityId,zoneId,buildingId,floorId}=CAMPUS_LAYOUT[pointId];
  result.group.traverse(object=>{object.userData={facilityId,zoneId,buildingId,floorId,...object.userData};});
  return { ...result, ...room, interior: true };
}

