import {createArchitecturalCampus} from './campus-architecture.js';
import {createEnclosedRoom} from './enclosed-rooms.js';
import * as THREE from '../vendor/three/three.module.js';
import { mergeGeometries } from '../vendor/three/BufferGeometryUtils.js';
import { CAMPUS_LAYOUT } from './campus-layout.js';

const PALETTE = {
  paper: 0xf2f2e9, white: 0xfafbf6, stone: 0xd5ddd7, floor: 0xe5e9e2,
  teal: 0x558d87, mint: 0xa9c8bc, dark: 0x344d50, metal: 0x84999a,
  glass: 0xc4dcdc, sand: 0xd8c7a8, copper: 0xb58e6d, blue: 0x7da3b8,
  leaf: 0x91ad91,
};

// Each palette colour is one draw call. Semantic nodes survive geometry batching.
function builder(name, metadata = {}) {
  const group = new THREE.Group();
  group.name = name;
  group.userData = { conceptual: true, ...metadata };
  const batches = new Map();
  const materials = new Map();
  let semanticId = name;
  function node(id, position, data = {}) {
    const anchor = new THREE.Object3D();
    anchor.name = id;
    anchor.position.set(...position);
    anchor.userData = { id, conceptual: true, ...metadata, ...data };
    group.add(anchor);
    semanticId = id;
    return anchor;
  }
  function add(geometry, color, position, rotation = [0, 0, 0]) {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
      new THREE.Vector3(1, 1, 1),
    );
    const plain = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geometry.dispose();
    plain.applyMatrix4(matrix);
    // Uniform attributes allow boxes, curves, and bevelled equipment to batch.
    plain.deleteAttribute('uv');
    if (!batches.has(color)) batches.set(color, []);
    batches.get(color).push({ geometry: plain, id: semanticId });
  }
  function box(size, position, color = 'white', rotation) {
    add(new THREE.BoxGeometry(...size), color, position, rotation);
  }
  function rounded(size, position, color = 'white', radius = 0.06, rotation) {
    const [w, h, d] = size;
    const r = Math.min(radius, w / 4, h / 4, d / 4);
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 + r, -h / 2);
    shape.lineTo(w / 2 - r, -h / 2);
    shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    shape.lineTo(w / 2, h / 2 - r);
    shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    shape.lineTo(-w / 2 + r, h / 2);
    shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    shape.lineTo(-w / 2, -h / 2 + r);
    shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(d - r * 2, 0.005), bevelEnabled: true,
      bevelSegments: 1, steps: 1, bevelSize: r / 2, bevelThickness: r, curveSegments: 3,
    });
    geometry.translate(0, 0, -d / 2 + r);
    add(geometry, color, position, rotation);
  }
  function cylinder(radius, height, position, color = 'metal', rotation, segments = 16) {
    add(new THREE.CylinderGeometry(radius, radius, height, segments), color, position, rotation);
  }
  function line(points, radius = 0.03, color = 'metal') {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    add(new THREE.TubeGeometry(curve, Math.max(8, points.length * 4), radius, 6, false), color, [0, 0, 0]);
  }
  function finish() {
    for (const [color, parts] of batches) {
      const geometry = mergeGeometries(parts.map(p => p.geometry), false);
      parts.forEach(p => p.geometry.dispose());
      geometry.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial({
        color: PALETTE[color], roughness: color === 'glass' ? 0.3 : 0.76,
        metalness: color === 'metal' || color === 'copper' ? 0.22 : 0,
      });
      materials.set(color, material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `${name}:${color}`;
      mesh.userData = { conceptual: true, ...metadata, sourceIds: [...new Set(parts.map(p => p.id))] };
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    let disposed = false;
    return {
      group,
      dispose() {
        if (disposed) return;
        disposed = true;
        group.traverse(object => { if (object.isMesh) object.geometry.dispose(); });
        materials.forEach(material => material.dispose());
        group.removeFromParent();
      },
    };
  }
  return { node, box, rounded, cylinder, line, add, finish };
}

function desk(b, x, y, z, scale = 1) {
  b.box([1.45 * scale, 0.1 * scale, 0.78 * scale], [x, y + 0.76 * scale, z], 'sand');
  for (const dx of [-0.58, 0.58]) {
    b.box([0.07 * scale, 0.73 * scale, 0.6 * scale], [x + dx * scale, y + 0.36 * scale, z], 'metal');
  }
  b.rounded([0.5 * scale, 0.08 * scale, 0.49 * scale], [x, y + 0.4 * scale, z + 0.66 * scale], 'teal');
  b.rounded([0.5 * scale, 0.44 * scale, 0.07 * scale], [x, y + 0.64 * scale, z + 0.89 * scale], 'teal');
  for (const dx of [-0.19, 0.19]) b.box([0.05 * scale, 0.4 * scale, 0.4 * scale], [x + dx * scale, y + 0.2 * scale, z + 0.66 * scale], 'metal');
}

function roomShell(b, { width = 7.6, depth = 5.6, height = 3.8 } = {}) {
  b.node('room-shell', [0, 0, 0]);
  b.box([width + 0.35, 0.24, depth + 0.35], [0, -0.15, 0], 'stone');
  b.box([width, 0.08, depth], [0, 0.015, 0], 'floor');
  b.box([width, height, 0.15], [0, height / 2, -depth / 2], 'paper');
  b.box([0.14, height, depth * 0.57], [-width / 2, height / 2, -depth * 0.215], 'paper');
  b.box([width, 0.1, 0.09], [0, 0.12, -depth / 2 + 0.1], 'metal');
  for (let x = -width / 2 + 0.8; x < width / 2; x += 0.8) {
    b.box([0.012, 0.008, depth], [x, 0.061, 0], 'stone');
  }
  for (let z = -depth / 2 + 0.8; z < depth / 2; z += 0.8) {
    b.box([width, 0.008, 0.012], [0, 0.062, z], 'stone');
  }
}

function panel(b, x, y, z, width = 1.2, height = 1.6) {
  b.rounded([width, height, 0.25], [x, y, z], 'stone');
  b.box([width - 0.14, height - 0.16, 0.04], [x, y, z + 0.145], 'white');
  b.box([width - 0.25, 0.08, 0.035], [x, y + height * 0.31, z + 0.18], 'dark');
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 4; i++) {
      const px = x + (i - 1.5) * (width - 0.3) / 4;
      b.box([0.13, 0.24, 0.055], [px, y + 0.04 - row * 0.36, z + 0.19], 'metal');
      b.box([0.065, 0.1, 0.07], [px, y + 0.06 - row * 0.36, z + 0.235], 'dark');
    }
  }
}

function fan(b, x, y, z, radius = 0.55) {
  b.cylinder(radius, 0.12, [x, y, z], 'dark', [Math.PI / 2, 0, 0], 24);
  b.add(new THREE.TorusGeometry(radius * 0.9, radius * 0.045, 6, 24), 'metal', [x, y, z + 0.075]);
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI * 2 / 5;
    b.rounded([radius * 0.3, radius * 0.73, 0.055], [x + Math.sin(angle) * radius * 0.37, y + Math.cos(angle) * radius * 0.37, z + 0.09], 'metal', 0.05, [0, 0, -angle + 0.3]);
  }
  b.cylinder(radius * 0.18, 0.16, [x, y, z + 0.12], 'stone', [Math.PI / 2, 0, 0]);
  for (let i = -2; i <= 2; i++) {
    const span = Math.sqrt(radius * radius * 0.82 - (i * radius * 0.25) ** 2) * 2;
    b.box([span, 0.018, 0.018], [x, y + i * radius * 0.25, z + 0.2], 'stone');
  }
}

function rack(b, x, z, { width = 1.25, height = 2.75, cables = false } = {}) {
  const front = z + 0.58;
  b.box([width, 0.15, 1.18], [x, 0.15, z], 'dark');
  b.box([width, 0.12, 1.18], [x, height, z], 'dark');
  for (const dx of [-width / 2 + 0.055, width / 2 - 0.055]) {
    for (const dz of [-0.52, 0.52]) b.box([0.08, height - 0.13, 0.08], [x + dx, height / 2 + 0.06, z + dz], 'metal');
  }
  b.box([width - 0.12, height - 0.2, 0.06], [x, height / 2 + 0.05, z - 0.56], 'dark');
  for (let row = 0; row < 9; row++) {
    const y = 0.42 + row * 0.24;
    b.box([width - 0.18, 0.2, 0.82], [x, y, z], row > 5 ? 'metal' : 'dark');
    b.box([width - 0.22, 0.17, 0.05], [x, y, front], row > 5 ? 'stone' : 'metal');
    for (let p = 0; p < 8; p++) {
      b.box([0.065, row > 5 ? 0.075 : 0.018, 0.018], [x + (p - 3.5) * (width - 0.28) / 8, y, front + 0.04], 'dark');
    }
    if (cables && row > 5) {
      for (let p = 0; p < 4; p++) {
        const px = x + (p - 1.5) * 0.19;
        b.line([[px, y, front + 0.06], [px, y - 0.09, front + 0.22], [x + width / 2 + 0.08, y - 0.16, front + 0.23], [x + width / 2 + 0.12, 0.25, front]], 0.018, p % 2 ? 'blue' : 'teal');
      }
    }
  }
  b.box([0.045, 0.5, 0.06], [x + width / 2 - 0.1, height * 0.45, front + 0.05], 'dark');
}

export const createCampus = createArchitecturalCampus;
function lighting(b) {
  roomShell(b);
  b.node('C01-luminaires', [0, 3.25, -0.5]);
  for (const x of [-1.6, 1.35]) {
    for (const z of [-1.15, 1.2]) {
      b.rounded([2.2, 0.12, 0.46], [x, 3.28, z], 'stone');
      b.box([2.06, 0.035, 0.35], [x, 3.205, z], 'white');
      for (const dx of [-0.75, 0.75]) b.cylinder(0.014, 0.45, [x + dx, 3.56, z], 'metal', undefined, 6);
    }
  }
  b.node('C01-lighting-switchboard', [-2.5, 1.8, -2.55]);
  panel(b, -2.5, 1.8, -2.55, 1.05, 1.35);
  b.line([[-2.5, 2.5, -2.59], [-2.5, 3.5, -2.59], [1.4, 3.5, -2.59]], 0.035, 'metal');
  b.box([3.05, 1.25, 0.1], [0.8, 2, -2.64], 'teal');
  b.box([3.15, 0.07, 0.18], [0.8, 1.34, -2.6], 'metal');
  b.node('C01-classroom-desks', [0, 0, 0]);
  for (const x of [-1.4, 1.25]) for (const z of [-0.65, 1.25]) desk(b, x, 0.06, z);
}

function hvac(b) {
  roomShell(b);
  b.node('C02-indoor-unit', [-0.8, 2.8, -2.46]);
  b.rounded([2.8, 0.7, 0.55], [-0.8, 2.8, -2.44], 'white', 0.12);
  b.box([2.55, 0.19, 0.09], [-0.8, 2.59, -2.12], 'dark');
  for (let i = 0; i < 4; i++) b.box([2.48, 0.022, 0.075], [-0.8, 2.54 + i * 0.043, -2.06], 'metal');
  b.box([0.3, 0.06, 0.01], [0.1, 2.96, -2.15], 'stone');
  b.node('C02-refrigerant-pipes', [1.2, 1.5, -2.4]);
  for (const offset of [0, 0.12]) {
    b.line([[0.62, 2.8 - offset, -2.48], [1.25 + offset, 2.8 - offset, -2.48], [1.42 + offset, 2.55, -2.48], [1.42 + offset, 0.75, -2.48], [1.83, 0.7, -1.6]], 0.043, offset ? 'copper' : 'stone');
  }
  b.node('C02-outdoor-unit', [2.15, 0.87, -1.1]);
  b.rounded([1.8, 1.3, 0.85], [2.05, 0.95, -1.1], 'white');
  fan(b, 1.8, 0.98, -0.61, 0.48);
  for (let i = 0; i < 7; i++) b.box([0.34, 0.035, 0.03], [2.65, 0.6 + i * 0.1, -0.65], 'metal');
  for (const x of [1.45, 2.65]) b.box([0.2, 0.28, 1.05], [x, 0.2, -1.1], 'metal');
  b.rounded([0.4, 0.6, 0.12], [-2.85, 1.55, -2.64], 'white');
  b.box([0.26, 0.18, 0.015], [-2.85, 1.67, -2.57], 'glass');
  desk(b, -1.35, 0.06, 0.9, 1.2);
}

function network(b) {
  roomShell(b);
  b.node('C03-wall-access-point', [-0.25, 2.65, -2.45]);
  b.rounded([1.15, 1.15, 0.32], [-0.25, 2.65, -2.48], 'white', 0.16);
  b.add(new THREE.TorusGeometry(0.28, 0.012, 6, 28), 'stone', [-0.25, 2.65, -2.29]);
  b.box([0.26, 0.025, 0.018], [-0.25, 2.25, -2.29], 'metal');
  b.node('C03-network-patch', [2.15, 1.4, -2.4]);
  b.box([1.45, 1.3, 0.42], [2.1, 1.65, -2.48], 'stone');
  b.box([1.3, 1.15, 0.05], [2.1, 1.65, -2.23], 'white');
  for (let row = 0; row < 3; row++) {
    b.box([1.15, 0.22, 0.1], [2.1, 1.32 + row * 0.31, -2.16], 'metal');
    for (let col = 0; col < 6; col++) b.box([0.12, 0.1, 0.025], [1.65 + col * 0.18, 1.32 + row * 0.31, -2.09], 'dark');
  }
  b.line([[-0.25, 2.05, -2.53], [-0.25, 1.65, -2.53], [0.6, 1.65, -2.53], [0.6, 0.4, -2.53], [2, 0.4, -2.53], [2, 1.25, -2.12]], 0.035, 'teal');
  for (let i = 0; i < 4; i++) b.line([[1.65 + i * 0.18, 1.94, -2.08], [1.65 + i * 0.18, 1.7, -1.91], [1.83 + i * 0.18, 1.63, -2.08]], 0.022, 'blue');
  desk(b, -1.45, 0.06, 0.6, 1.4);
  b.rounded([1.05, 0.7, 0.065], [-1.45, 1.57, 0.54], 'dark');
  b.box([0.92, 0.56, 0.012], [-1.45, 1.58, 0.582], 'glass');
  b.box([0.08, 0.22, 0.08], [-1.45, 1.15, 0.54], 'metal');
  b.rounded([0.9, 0.035, 0.3], [-1.45, 1.18, 0.92], 'stone');
}

function power(b) {
  roomShell(b);
  b.node('C04-main-electrical-cabinet', [-0.8, 1.55, -2]);
  b.box([2.1, 2.9, 0.65], [-0.85, 1.55, -2.2], 'stone');
  b.box([1.86, 2.62, 0.04], [-0.85, 1.55, -1.85], 'dark');
  for (let i = 0; i < 3; i++) {
    b.box([0.09, 2.15, 0.08], [-1.44 + i * 0.58, 1.6, -1.72], 'copper');
    for (let j = 0; j < 3; j++) {
      b.rounded([0.4, 0.46, 0.24], [-1.44 + i * 0.58, 0.74 + j * 0.76, -1.56], 'white', 0.025);
      b.box([0.13, 0.22, 0.05], [-1.44 + i * 0.58, 0.78 + j * 0.76, -1.39], 'dark');
    }
  }
  b.box([2.15, 0.18, 0.8], [-0.85, 0.15, -2.18], 'metal');
  // Door shown open; there is no implied inspection outcome.
  b.box([1.9, 2.75, 0.07], [-2.48, 1.55, -1.45], 'paper', [0, -0.75, 0]);
  b.box([0.06, 0.45, 0.09], [-3.08, 1.53, -0.86], 'metal');
  b.node('C04-lab-bench', [1.85, 0, 0.3]);
  desk(b, 1.6, 0.06, 0.4, 1.45);
  b.rounded([1.05, 0.62, 0.55], [1.55, 1.5, 0.36], 'white');
  b.box([0.48, 0.3, 0.03], [1.36, 1.55, 0.66], 'glass');
  b.cylinder(0.07, 0.06, [1.85, 1.55, 0.7], 'dark', [Math.PI / 2, 0, 0]);
  b.line([[0.1, 2.85, -2.3], [1.2, 2.85, -2.3], [1.2, 1.3, -2.3], [2.5, 1.3, -2.3]], 0.055, 'metal');
}

function access(b) {
  roomShell(b);
  b.node('C05-door-frame', [0, 1.6, -0.75]);
  for (const x of [-1.1, 1.1]) b.box([0.18, 3.15, 0.3], [x, 1.65, -0.8], 'dark');
  b.box([2.38, 0.18, 0.3], [0, 3.15, -0.8], 'dark');
  b.box([2, 0.08, 0.5], [0, 0.1, -0.8], 'metal');
  b.box([1.97, 2.87, 0.085], [-0.1, 1.63, -0.44], 'glass', [0, -0.25, 0]);
  for (const y of [0.22, 3.05]) b.box([2.04, 0.07, 0.12], [-0.1, y, -0.44], 'metal', [0, -0.25, 0]);
  b.box([0.055, 0.65, 0.085], [0.63, 1.5, -0.14], 'dark');
  b.box([0.4, 0.13, 0.22], [0.67, 3.08, -0.55], 'metal');
  b.line([[0.65, 3.1, -0.4], [0.3, 3.1, -0.15], [-0.05, 3.1, -0.42]], 0.024, 'dark');
  b.node('C05-card-reader', [1.64, 1.55, -0.75]);
  b.box([0.67, 2.25, 0.17], [1.65, 1.19, -0.83], 'paper');
  b.rounded([0.32, 0.62, 0.13], [1.65, 1.6, -0.69], 'dark');
  b.box([0.22, 0.16, 0.012], [1.65, 1.74, -0.61], 'glass');
  for (let i = 0; i < 3; i++) b.add(new THREE.TorusGeometry(0.04 + i * 0.025, 0.006, 4, 14, Math.PI), 'stone', [1.61, 1.49, -0.61], [0, 0, -Math.PI / 2]);
  b.rounded([0.22, 0.22, 0.09], [-1.5, 1.5, -0.8], 'stone');
  b.box([4.8, 0.015, 0.75], [0, 0.076, 1.6], 'mint');
  b.box([1.3, 0.5, 1.3], [-2.75, 0.3, -1.6], 'stone');
  b.add(new THREE.IcosahedronGeometry(0.6, 1), 'leaf', [-2.75, 1.2, -1.6]);
}

function exhaust(b) {
  roomShell(b, { height: 4.4 });
  b.node('C06-duct-network', [0, 3.4, -1.1]);
  b.box([4.7, 0.7, 0.8], [-0.4, 3.62, -1.75], 'metal');
  for (const x of [-2.55, -1.1, 0.5, 1.8]) {
    b.box([0.05, 0.79, 0.89], [x, 3.62, -1.75], 'stone');
    for (const z of [-2.12, -1.38]) b.cylinder(0.02, 0.55, [x, 4.23, z], 'dark', undefined, 6);
  }
  b.box([0.8, 0.7, 1.4], [1.55, 3.62, -0.68], 'metal');
  b.node('C06-inline-extractor', [1.55, 2.6, 0]);
  b.cylinder(0.7, 1.15, [1.55, 2.92, 0], 'stone');
  b.cylinder(0.8, 0.1, [1.55, 3.39, 0], 'metal');
  b.cylinder(0.8, 0.1, [1.55, 2.38, 0], 'metal');
  b.box([1.25, 1.25, 0.35], [1.55, 2.85, 0.55], 'metal');
  fan(b, 1.55, 2.85, 0.79, 0.56);
  b.node('C06-extraction-hood', [-1.55, 1.8, -0.9]);
  b.box([0.45, 1.15, 0.45], [-1.55, 2.75, -1.3], 'stone');
  const hood = new THREE.CylinderGeometry(0.32, 1.15, 0.65, 4, 1);
  b.add(hood, 'metal', [-1.55, 1.9, -1.3], [0, Math.PI / 4, 0]);
  b.box([1.7, 0.09, 1.7], [-1.55, 1.55, -1.3], 'dark');
  b.box([2.3, 0.12, 1.3], [-1.55, 0.98, -1.2], 'stone');
  for (const x of [-2.5, -0.6]) b.box([0.1, 0.92, 1.15], [x, 0.53, -1.2], 'metal');
  b.rounded([0.56, 0.8, 0.16], [2.9, 1.45, -2.63], 'white');
  b.box([0.36, 0.17, 0.015], [2.9, 1.63, -2.53], 'glass');
}

function networkRack(b) {
  roomShell(b);
  b.node('C07-network-rack', [-0.9, 1.4, -0.7]);
  rack(b, -0.9, -0.7, { width: 1.65, height: 3.25, cables: true });
  b.node('C07-cable-tray', [-0.9, 3.5, -1.1]);
  for (const z of [-1.8, -1.35]) b.box([5.3, 0.12, 0.055], [0, 3.5, z], 'metal');
  for (let i = 0; i < 16; i++) b.box([0.045, 0.05, 0.5], [-2.6 + i * 0.35, 3.46, -1.58], 'metal');
  for (let i = 0; i < 6; i++) b.line([[-1.3 + i * 0.12, 2.95, -1], [-1.3 + i * 0.12, 3.6, -1.55], [2.5, 3.6, -1.55 + i * 0.035]], 0.022, i % 2 ? 'blue' : 'teal');
  b.node('C07-service-station', [2, 0, 0.6]);
  desk(b, 2, 0.06, 0.5, 0.95);
  b.rounded([0.85, 0.58, 0.05], [2, 1.18, 0.5], 'dark');
  b.box([0.74, 0.46, 0.01], [2, 1.18, 0.535], 'glass');
  b.box([0.9, 0.045, 0.5], [2, 0.86, 0.7], 'metal');
  b.box([1.85, 0.018, 1.2], [-0.9, 0.073, 1.1], 'mint');
}

function environment(b) {
  roomShell(b, { width: 8.4, depth: 6.4, height: 4 });
  b.node('C08-cold-aisle', [-0.7, 0, 0]);
  b.box([1.28, 0.018, 5.3], [-0.6, 0.074, 0], 'blue');
  b.box([1.05, 0.018, 5.3], [2.25, 0.074, 0], 'sand');
  for (let i = 0; i < 7; i++) {
    b.box([0.9, 0.015, 0.055], [-0.6, 0.089, -2.2 + i * 0.7], 'glass');
    b.box([0.7, 0.015, 0.055], [2.25, 0.089, -2.2 + i * 0.7], 'paper');
  }
  b.node('C08-server-rows', [0, 1.4, -0.4]);
  for (const x of [-2, 0.87]) for (const z of [-1.7, 0.1, 1.9]) rack(b, x, z, { width: 1.13, height: 2.7 });
  b.node('C08-precision-air-conditioner', [2.85, 1.6, -2.2]);
  b.rounded([1.45, 3.05, 1.1], [2.95, 1.61, -2.4], 'white');
  b.box([1.2, 0.63, 0.035], [2.95, 2.63, -1.81], 'metal');
  for (let i = 0; i < 12; i++) b.box([1.18, 0.04, 0.04], [2.95, 0.55 + i * 0.115, -1.81], 'dark');
  b.box([0.34, 0.2, 0.025], [2.95, 2.66, -1.78], 'glass');
  b.box([1.32, 0.12, 1.2], [2.95, 0.13, -2.4], 'metal');
  b.node('C08-environment-sensor', [3.78, 1.7, -3.04]);
  b.rounded([0.3, 0.5, 0.15], [3.78, 1.7, -3.04], 'white');
  b.box([0.19, 0.14, 0.02], [3.78, 1.79, -2.95], 'glass');
  b.line([[3.78, 1.45, -3.04], [3.78, 0.3, -3.04], [2.95, 0.3, -2.96]], 0.025, 'metal');
}

const SCENES = { C01: lighting, C02: hvac, C03: network, C04: power, C05: access, C06: exhaust, C07: networkRack, C08: environment };

export function createPointScene(pointId) {
  if(CAMPUS_LAYOUT[pointId])return createEnclosedRoom(pointId);
  const entry = CAMPUS_LAYOUT[pointId];
  if (!entry || !SCENES[pointId]) throw new RangeError(`Unknown campus point: ${pointId}`);
  const b = builder(`point-${pointId}`, { pointId, ...entry });
  SCENES[pointId](b);
  return {
    ...b.finish(),
    target: new THREE.Vector3(0, pointId === 'C06' ? 1.8 : 1.55, -0.15),
    cameraPosition: new THREE.Vector3(8.8, pointId === 'C06' ? 7.6 : 6.7, 10.6),
  };
}
