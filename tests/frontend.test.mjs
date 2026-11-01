import test from 'node:test';
import assert from 'node:assert/strict';
let model = {};
try { model = await import('../frontend/model.js'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const missing = {point_id:'C07',device:'网络交换节点',building:'实训楼',zone_id:'Z3',required:true,covered:false,latest_status:'no-record',review:null};
const alarm = {point_id:'C01',device:'照明控制',building:'教学楼',zone_id:'Z1',required:true,covered:true,latest_status:'alarm',review:{status:'pending'}};
const ordinary = {point_id:'C03',device:'网络点',building:'教学楼',zone_id:'Z1',required:false,covered:false,latest_status:'unknown',review:{status:'completed'}};
const base={query:'',scope:'all',required:'all',status:'all'};
test('missing coverage excludes ordinary points and combines location filters',()=>{
 assert.equal(typeof model.matchesPoint,'function','shared filter must exist');
 assert.equal(model.matchesPoint(missing,{...base,status:'missing'}),true);
 assert.equal(model.matchesPoint(ordinary,{...base,status:'missing'}),false);
 assert.equal(model.matchesPoint(missing,{...base,status:'missing',scope:'building:教学楼'}),false);
 assert.equal(model.matchesPoint(missing,{...base,scope:'zone:Z3'}),true);
});
test('covered equipment can still have an alarm and pending review',()=>{
 assert.equal(typeof model.matchesPoint,'function');
 assert.equal(model.matchesPoint(alarm,{...base,status:'covered'}),true);
 assert.equal(model.matchesPoint(alarm,{...base,status:'alarm'}),true);
 assert.equal(model.matchesPoint(alarm,{...base,status:'pending'}),true);
});
test('search trims and ignores identifier case; status and required filters compose',()=>{
 assert.equal(typeof model.matchesPoint,'function');
 assert.equal(model.matchesPoint(missing,{...base,query:' c07 '}),true);
 assert.equal(model.matchesPoint(missing,{...base,query:'交换'}),true);
 assert.equal(model.matchesPoint(ordinary,{...base,required:'required'}),false);
 assert.equal(model.matchesPoint(ordinary,{...base,status:'completed',required:'optional'}),true);
 assert.equal(model.matchesPoint(missing,{...base,status:'unknown'}),true);
});
test('location search matches building floor and zone while preserving other filters',()=>{
 const point={...missing,floor:'二层',zone_name:'实训楼二层'};
 for(const query of ['实训楼','二层','z3','实训楼二层'])assert.equal(model.matchesPoint(point,{...base,query}),true,query);
 assert.equal(model.matchesPoint(point,{...base,query:'教学楼'}),false);
 assert.equal(model.matchesPoint(point,{...base,query:'实训楼',scope:'zone:Z1'}),false);
 assert.equal(model.matchesPoint(point,{...base,query:'实训楼',status:'covered'}),false);
});

test('expired or cancelled reviews do not remain in the pending point filter',()=>{
 for(const effective_status of ['timeout','cancelled'])assert.equal(model.matchesPoint({...missing,review:{status:'pending',effective_status}},{...base,status:'pending'}),false);
 assert.equal(model.matchesPoint({...missing,review:{status:'pending',effective_status:'completed'}},{...base,status:'completed'}),true);
});
