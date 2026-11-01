const {labels}=require('./client');
const names={...labels,pending_verification:'待验证',executable:'可执行',not_executable:'不可执行',satisfied:'已满足',unsatisfied:'不满足',unavailable:'未取得',failed:'失败',error:'错误',expired:'已过期',ok:'已取得',ON_SITE:'现场证据',SIMULATED:'教学模拟',SYSTEM:'系统取证',REMOTE:'远程观察',MQTT:'MQTT 远程观察'};
const label=value=>names[value]||value||'未提供';
const taskStates={established:'成立',blocked:'受阻',pending_verification:'待验证',unknown:'状态未知'};
function checks(rows){return (rows||[]).map(c=>({...c,statusText:label(c.status),refs:(c.evidence_refs||[]).join('、')}));}
function evidence(rows){return (rows||[]).map(e=>({...e,sourceText:label(e.source_type),statusText:label(e.status),valueText:JSON.stringify(e.value_json),provenanceText:JSON.stringify(e.provenance_json)}));}
function run(value){return {...value,tasks:(value.task_results||[]).map(t=>({...t,stateText:taskStates[t.state]||t.state,checks:checks(t.checks)})),plans:(value.plan_results||[]).map(p=>({...p,stateText:label(p.state),checks:checks(p.checks)})),proofs:evidence(value.evidence),missingText:((value.coverage||{}).missing||[]).join('、')};}
module.exports={label,evidence,run};
