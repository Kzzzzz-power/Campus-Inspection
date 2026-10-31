import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSkyPixels} from '../frontend/facade-sample/lighting.js';
const {width,height,pixels}=createSkyPixels();
function sample(x,y,z){
 const length=Math.hypot(x,y,z);
 // Same directional convention required by the renderer's equirectUv shader.
 const u=Math.atan2(z,x)/(2*Math.PI)+.5,v=Math.asin(y/length)/Math.PI+.5;
 const col=Math.min(width-1,Math.max(0,Math.floor(u*width))),row=Math.min(height-1,Math.max(0,Math.floor(v*height)));
 return Array.from(pixels.subarray((row*width+col)*4,(row*width+col)*4+3));
}
test('environment: sky is overhead, ground is below',()=>{
 const sky=sample(0,1,0),ground=sample(0,-1,0);
 assert(sky[2]>sky[0]*1.4,'zenith must be blue, not ground-grey');
 assert(sky[2]>ground[2]*3,'zenith must be brighter than the ground');
});
test('environment: brightest sun follows the directional light, not its mirror',()=>{
 const toward=sample(-4.5,6,5),mirror=sample(-4.5,6,-5);
 assert(toward.reduce((a,b)=>a+b)>mirror.reduce((a,b)=>a+b)*5,'sun position must not be mirrored');
});
