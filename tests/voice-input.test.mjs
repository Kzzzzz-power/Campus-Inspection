import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const code=fs.readFileSync(new URL('../frontend/voice-input.js',import.meta.url),'utf8');
const {encodeWav,mergeTranscript}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('WAV is 16-bit mono with correct length and clipped samples',()=>{
 const data=encodeWav(new Float32Array([-2,-.5,0,.5,2]));const view=new DataView(data);
 assert.equal(view.getUint32(24,true),16000);assert.equal(view.getUint16(22,true),1);
 assert.equal(view.getUint32(40,true),10);assert.equal(data.byteLength,54);
 assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(52,true),32767);
});
test('transcription appends without losing manual notes or inventing text',()=>{
 assert.equal(mergeTranscript('人工备注','照明正常',2000),'人工备注\n照明正常');
 assert.equal(mergeTranscript('人工备注','   ',2000),'人工备注');
 assert.throws(()=>mergeTranscript('已经很长','不能截断',5),RangeError);
});
