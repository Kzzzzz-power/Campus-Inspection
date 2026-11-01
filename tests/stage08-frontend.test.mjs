import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCoverage,createReadGuard,accessDependency} from '../frontend/run-projection.js';
const data={run_id:'A',required_total:2,points:[{point_id:'C07',covered:true,latest_status:'alarm',review:{status:'pending'}}]};
const run={run_id:'B',inspection_round_id:'round-B',as_of:'cutoff',coverage:{required:2,covered:1,missing:['C07'],points:[{checkpoint_id:'C07',covered:false}]}};
test('immediate frozen projection replaces coverage and retains independent live facts without mutation',()=>{
 const projected=projectCoverage(data,run);assert.equal(projected.run_id,'B');assert.equal(projected.covered,1);assert.equal(projected.points[0].covered,false);
 assert.equal(projected.points[0].latest_status,'alarm');assert.equal(projected.points[0].review,data.points[0].review);assert.equal(data.points[0].covered,true);
 const cleared=projectCoverage(projected,null);assert.equal(cleared.run_id,null);assert.equal(cleared.points[0].covered,null);assert.equal(cleared.covered,null);assert.deepEqual(cleared.missing,[]);
 assert.equal(projectCoverage(null,run),null);
});
test('read guard rejects A to B to A, deselection, and changed query while permitting a fresh current read',()=>{
 const guard=createReadGuard(),a=guard.capture('?A');guard.invalidate();assert(!guard.current(a,'?B'));guard.invalidate();assert(!guard.current(a,'?A'));
 const fresh=guard.capture('?A');assert(guard.current(fresh,'?A'));assert(!guard.current(fresh,'?round'));guard.invalidate();assert(!guard.current(fresh,''));
});
test('business access is exactly the frozen dependency, never recalculated from raw stale DENIED',()=>{
 const dep={dependency_id:'T1.access',status:'unknown',reason:'expired or conflict',evidence_refs:['stale']};
 const value={evidence:[{evidence_type:'zone_access',status:'ok',value_json:{access:'DENIED'}}],task_results:[{task_id:'T1',checks:[dep]}]};
 assert.equal(accessDependency(value),dep);assert.equal(accessDependency({...value,task_results:[]}),null);
 dep.status='satisfied';assert.equal(accessDependency(value).status,'satisfied');
});
