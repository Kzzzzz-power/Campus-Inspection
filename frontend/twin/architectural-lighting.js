import * as THREE from '../vendor/three/three.module.js';

// Deterministic botanical geometry. Appearance is illustrative, never facility state.
export function createTreeCrown(height, seed = 1) {
  let state = seed >>> 0;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 4294967296);
  const positions = [], colors = [], uvs = [];
  const rotation = new THREE.Quaternion(), point = new THREE.Vector3();
  for (let cluster = 0; cluster < 27; cluster++) {
    const angle = cluster * 2.39996 + random() * .35;
    const level = cluster / 26, radius = Math.sqrt(1 - level * level) * height * .28;
    const center = new THREE.Vector3(Math.cos(angle) * radius, height * (.61 + level * .33), Math.sin(angle) * radius);
    for (let leaf = 0; leaf < 14; leaf++) {
      const origin = center.clone().add(new THREE.Vector3((random() - .5) * height * .26, (random() - .5) * height * .17, (random() - .5) * height * .26));
      const length = height * (.095 + random() * .04), width = length * (.42 + random() * .2);
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

