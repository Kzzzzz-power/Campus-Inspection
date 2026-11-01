import test from 'node:test';
import assert from 'node:assert/strict';
import {photoJobMessage} from '../frontend/photo-description.js';

test('photo summary never labels queued or interrupted jobs as saved', () => {
  for (const status of ['queued','running']) assert.match(photoJobMessage({status}), /正在生成/);
  assert.match(photoJobMessage({status:'interrupted'}), /尚未取得保存确认/);
});
test('only successful evidence gets a saved summary with explicit human review boundary', () => {
  assert.match(photoJobMessage({status:'completed',evidence:{status:'ok'}}), /不代表现场覆盖或复核通过/);
  assert.equal(photoJobMessage({status:'completed',evidence:{status:'unavailable',error:'视觉模型未配置'}}), '视觉模型未配置');
  assert.match(photoJobMessage({status:'completed',evidence:{status:'error'}}), /没有生成替代结论/);
});
