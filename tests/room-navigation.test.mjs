import test from 'node:test';
import assert from 'node:assert/strict';
import {planWalk,isWalkable} from '../frontend/twin/room-navigation.js';
const room={walkBounds:{minX:-4,maxX:4,minZ:-3,maxZ:3},obstacles:[{minX:-1,maxX:1,minZ:-1,maxZ:1}]};
test('walking stays within the enclosed room and rejects equipment interiors',()=>{
 assert.equal(isWalkable({x:4.1,z:0},room),false);
 assert.equal(isWalkable({x:0,z:0},room),false);
 assert.equal(planWalk({x:-3,z:0},{x:0,z:0},room),null);
});
test('room route goes around a rack instead of clipping through it',()=>{
 const path=planWalk({x:-3,z:0},{x:3,z:0},room);
 assert(path.length>2);
 assert.deepEqual(path.at(-1),{x:3,z:0});
 for(let i=1;i<path.length;i++)for(let t=0;t<=1;t+=.02){
  assert(isWalkable({x:path[i-1].x+(path[i].x-path[i-1].x)*t,z:path[i-1].z+(path[i].z-path[i-1].z)*t},room));
 }
});
test('an impassable wall cannot be traversed or escaped around room bounds',()=>{
 const blocked={...room,obstacles:[{minX:-.1,maxX:.1,minZ:-3,maxZ:3}]};
 assert.equal(planWalk({x:-3,z:0},{x:3,z:0},blocked),null);
});