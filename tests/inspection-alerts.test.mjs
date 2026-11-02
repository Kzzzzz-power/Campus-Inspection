import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectionIssues,createInspectionAlertState} from '../frontend/inspection-alerts-model.js';

const data=(round='round-a',missing=['C07'])=>({inspection_round_id:round,round_state:'selected',as_of:'2026-11-02T01:30:00Z',missing,
  points:[{point_id:'C07',required:true,covered:!missing.includes('C07'),device:'网络交换节点'},{point_id:'C03',required:false,covered:false}]});
const run=(id='r1',missing=['C07'],state='blocked',round='round-a')=>({
  run_id:id,run_type:'reality',status:'completed',inspection_round_id:round,as_of:'2026-11-02T01:30:00Z',completed_at:'2026-11-02T01:30:01Z',
  coverage:{missing,points:[{checkpoint_id:'C07',required:true,covered:!missing.includes('C07')}]},
  input_snapshot:{review_snapshot:[]},
  task_results:[{task_id:'T1',name:'关键设施巡检覆盖',state,reason:'缺少有效记录：C07；Z3 拒绝进入'},
    {task_id:'T2',name:'异常项复核与确认',state:'established',reason:'确认已完成'}]});

test('no selected round and optional points never create missing-inspection alerts',()=>{
  assert.deepEqual(inspectionIssues(null,{...data(),round_state:'no_round'}),[]);
  assert.deepEqual(inspectionIssues(null,data('round-a',[])),[]);
  assert.equal(inspectionIssues(null,data()).length,1);
  assert.equal(inspectionIssues(null,data())[0].pointId,'C07');
});
test('S2 combines coverage and T1 blocker without inventing facility fault',()=>{
  const issues=inspectionIssues(run(),data());
  assert.equal(issues.length,1);assert.equal(issues[0].kind,'blocked');
  assert.equal(issues[0].taskId,'T1');assert.equal(issues[0].pointId,'C07');
  assert.match(issues[0].reason,/Z3/);
  assert.deepEqual(inspectionIssues(run('s1',[],'established'),{...data(),latest_status:'alarm'}),[]);
});
test('unknown and pending-verification are not blocked task alarms',()=>{
  const r=run('s5',[],'established');r.task_results[1].state='unknown';
  r.task_results.push({task_id:'T4',state:'pending_verification'});
  assert.deepEqual(inspectionIssues(r,data()),[]);
  r.task_results[1]={task_id:'T3',state:'blocked',reason:'SQLite 写入失败'};
  assert.equal(inspectionIssues(r,data())[0].taskId,'T3');
});
test('fresh instance notifies, refreshes do not repeat, dismiss does not resolve',()=>{
  const s=createInspectionAlertState();s.sync(null,data());
  assert.equal(s.snapshot.pending,true);s.dismiss();s.sync(null,data());
  assert.equal(s.snapshot.pending,false);assert.equal(s.snapshot.issues.length,1);
  s.sync(run(),data());assert.equal(s.snapshot.pending,true);
  s.dismiss();s.sync(run('r2'),data());assert.equal(s.snapshot.pending,false);
  s.sync(null,data('round-b'));assert.equal(s.snapshot.pending,true);
});
test('photo upload or live dashboard changes cannot erase frozen blockers',()=>{
  const s=createInspectionAlertState(),r=run();s.sync(r,data());
  s.sync(r,{...data('round-a',[]),photos:[{image_id:'p1'}],review:{status:'completed'}});
  assert.equal(s.snapshot.issues.length,1);assert.equal(s.snapshot.run.run_id,'r1');
});
test('completed follow-up resolves reminder while original run stays unchanged',()=>{
  const s=createInspectionAlertState(),original=run(),copy=structuredClone(original);
  s.sync(original,data());const ticket=s.ticket();
  const next=run('r2',[],'established');next.completed_at='2026-11-02T01:32:00Z';
  assert.equal(s.acceptReviewRun(next,ticket),true);
  assert.equal(s.snapshot.issues.length,0);assert.equal(s.snapshot.pending,false);
  s.sync(original,data());assert.equal(s.snapshot.run.run_id,'r2');assert.deepEqual(original,copy);
});
test('unresolved follow-up keeps reminders; errors never announce resolution',()=>{
  const s=createInspectionAlertState();s.sync(run(),data());
  const next=run('r2');s.acceptReviewRun(next,s.ticket());s.warn('重判失败');
  assert.equal(s.snapshot.issues.length,1);assert.match(s.snapshot.warning,/失败/);
});
test('what-if, incomplete and another-round follow-ups cannot clear alerts',()=>{
  const s=createInspectionAlertState();s.sync(run(),data());const ticket=s.ticket();
  for(const patch of [{run_type:'what_if'},{status:'running'},{inspection_round_id:'other'}]){
    assert.equal(s.acceptReviewRun({...run('r2',[],'established'),...patch},ticket),false);
    assert.equal(s.snapshot.issues.length,1);
  }
});
test('async review from abandoned selection cannot affect current round or reselected old run',()=>{
  const s=createInspectionAlertState(),a=run();s.sync(a,data());const ticket=s.ticket();
  s.sync(run('b',[],'established','round-b'),data('round-b',[]));
  s.sync(a,data());assert.equal(s.acceptReviewRun(run('r2',[],'established'),ticket),false);
});
test('older follow-up cannot replace a newer confirmed follow-up',()=>{
  const s=createInspectionAlertState();s.sync(run(),data());const ticket=s.ticket();
  s.acceptReviewRun({...run('r3',[],'established'),completed_at:'2026-11-02T01:40:00Z'},ticket);
  assert.equal(s.acceptReviewRun({...run('r2'),completed_at:'2026-11-02T01:35:00Z'},ticket),false);
  assert.equal(s.snapshot.issues.length,0);
});
test('resolved then recurring gap notifies again and different-round selection resets scope',()=>{
  const s=createInspectionAlertState();s.sync(run(),data());s.dismiss();
  s.sync(run('r2',[],'established'),data());assert.equal(s.snapshot.issues.length,0);
  s.sync(run('r3'),data());assert.equal(s.snapshot.pending,true);
  s.sync(null,null);assert.equal(s.snapshot.issues.length,0);
});
