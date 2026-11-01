import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../frontend/analysis-workbench.js',import.meta.url),'utf8');
const {coverageRows,analysisSteps,durationSummary,pendingAnalysis,analysisConfigSummary,analysisAnswer,toolSummary}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

test('coverage bars use frozen counts and distinguish no required points from zero coverage',()=>{
  const statistics={coverage_rate:0.75,covered:3,required:4,zone_completion:{Z1:{covered:3,required:3},Z2:{covered:0,required:1},Z3:{covered:0,required:0}}};
  assert.deepEqual(coverageRows(statistics),[
    {label:'必检覆盖',covered:3,required:4,rate:0.75},
    {label:'Z1',covered:3,required:3,rate:1},
    {label:'Z2',covered:0,required:1,rate:0},
    {label:'Z3',covered:0,required:0,rate:null}
  ]);
  assert.equal(coverageRows({covered:0,required:4,coverage_rate:null})[0].rate,null);
  assert.equal(coverageRows({covered:9,required:4,coverage_rate:2.25})[0].rate,null);
});

test('unknown durations remain unknown and a measured zero remains zero',()=>{
  assert.match(durationSummary({duration_seconds:null,duration_sample_count:0,inspection_count:6}),/未记录/);
  assert.doesNotMatch(durationSummary({duration_seconds:null,duration_sample_count:0,inspection_count:6}),/0 秒/);
  assert.match(durationSummary({duration_seconds:0,duration_sample_count:2,inspection_count:6}),/0 秒/);
  assert.match(durationSummary({duration_seconds:35,duration_sample_count:2,inspection_count:6}),/2\/6/);
});

test('missing stages cannot appear successful and returned provenance is preserved',()=>{
  const weather={name:'weather',label:'外部天气',status:'error',provider:'Open-Meteo',observed_at:null,retrieved_at:'2026-11-01T10:00:00Z',value:null,error:'单位无法核验',evidence_id:'E-weather'};
  const input={steps:[weather]},before=JSON.stringify(input),steps=analysisSteps(input);
  assert.equal(steps.length,6);
  assert.deepEqual(steps.map(s=>s.name),['statistics','weather','rag','ml','tools','llm']);
  assert.deepEqual(steps[1],weather);
  assert.equal(steps[5].status,'unavailable');
  assert.equal(steps[5].evidence_id,null);
  assert.equal(steps[5].observed_at,null);
  assert.equal(JSON.stringify(input),before);
});

test('unfinished analysis restores its original request and never invents one from a job-only history entry',()=>{
  const run={run_id:'analysis-1',status:'running',implementation_stage:6,input_snapshot:{request_id:'request-1',analysis_context:{basis_run_id:'base-1',question:'哪些点未巡？',failure_mode:'weather'}}};
  assert.deepEqual(pendingAnalysis(run),{run_id:'analysis-1',basis_run_id:'base-1',question:'哪些点未巡？',failure_mode:'weather',request:{request_id:'request-1',source_run_id:'base-1',question:'哪些点未巡？',failure_mode:'weather'}});
  assert.equal(pendingAnalysis({...run,input_snapshot:{}}).request,null);
  assert.equal(pendingAnalysis({...run,status:'completed'}),null);
  assert.equal(pendingAnalysis({run_id:'formal-1',status:'running',implementation_stage:5}),null);
});

test('configuration summary distinguishes disabled from unconfigured and never displays extra server fields',()=>{
  const off=analysisConfigSummary({enabled:false,configured:true,model_label:null,key:'secret-value',base:'private-address'});
  assert.match(off,/未启用/);assert.match(off,/已配置/);assert.match(off,/模型未提供/);
  assert.doesNotMatch(off,/secret-value|private-address/);
  const incomplete=analysisConfigSummary({enabled:true,configured:false,model_label:'demo-model'});
  assert.match(incomplete,/已启用/);assert.match(incomplete,/配置不完整/);assert.match(incomplete,/demo-model/);
  assert.match(analysisConfigSummary({}),/未知/);
});

test('assistant answer requires a successful LLM step and preserves typed claims with evidence references',()=>{
  const claims=[{kind:'fact',text:'冻结运行中 C07 未巡。',evidence_refs:['E-tools']},{kind:'limitation',text:'天气未取得。',evidence_refs:['E-weather']}];
  const analysis={answer:{claims},steps:[{name:'llm',status:'error',error:'引用未通过校验',value:{claims}}]};
  assert.deepEqual(analysisAnswer(analysis).claims,[]);
  assert.match(analysisAnswer(analysis).message,/未生成.*引用未通过校验/);
  const success=analysisAnswer({...analysis,steps:[{name:'llm',status:'ok',value:{claims}}]});
  assert.deepEqual(success.claims.map(c=>[c.kindLabel,c.text,c.evidence_refs]),[['事实','冻结运行中 C07 未巡。',['E-tools']],['限制','天气未取得。',['E-weather']]]);
  assert.deepEqual(analysisAnswer({}).claims,[]);
});

test('tool summaries preserve snapshot gaps and never invent a fastest plan from missing results',()=>{
  assert.match(toolSummary({name:'coverage_gaps',result:{point_ids:['C07']}}),/C07/);
  assert.match(toolSummary({name:'coverage_gaps',result:{point_ids:[]}}),/冻结运行.*必检.*已覆盖/);
  assert.match(toolSummary({name:'coverage_gaps',result:{}}),/未提供/);
  assert.match(toolSummary({name:'plan_feasibility',result:{fastest_executable_plan_ids:['PLAN-A','PLAN-C']}}),/PLAN-A、PLAN-C/);
  assert.match(toolSummary({name:'plan_feasibility',result:{fastest_executable_plan_ids:[]}}),/未给出/);
});
