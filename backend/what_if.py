"""Planning-only branches of an immutable S3 judgment."""
from copy import deepcopy
from uuid import uuid4
from fastapi import HTTPException
from . import evidence as ev, service, planning
from .feasibility import evaluate_plans


def create(store,payload):
    allowed={'request_id','scenario_id','run_type','parent_run_id','input_overrides','assumptions','inspection_round_id','as_of'}
    if set(payload)-allowed or payload.get('scenario_id')!='S4' or payload.get('input_overrides',{})!={}:
        raise HTTPException(422,'S4 仅允许规划假设，input_overrides 必须为空。')
    assumptions=payload.get('assumptions',{})
    if not isinstance(assumptions,dict) or set(assumptions)-{'remaining_minutes','resources','p2_z3_access'}:
        raise HTTPException(422,'推演假设仅允许时间、资源及 P2 Z3 权限。')
    assumptions=planning.validate(assumptions)
    key=service.request_key(payload.get('request_id'))
    parent_id=service.request_key(payload.get('parent_run_id'))
    from .runs import detail
    with store.transaction(write=True) as conn:
        parent=detail(conn,parent_id)
        if parent.get('run_type')!='reality' or parent.get('scenario_id')!='S3' or parent.get('status')!='completed':
            raise HTTPException(422,'S4 必须基于已完成的 S3 reality。')
        rid=parent['inspection_round_id'];cutoff=parent['as_of']
        if payload.get('inspection_round_id',rid)!=rid or ev.stamp(payload.get('as_of',cutoff))!=cutoff:
            raise HTTPException(422,'推演轮次和事实截止时间必须与父运行一致。')
        normalized={'request_id':key,'scenario_id':'S4','run_type':'what_if','parent_run_id':parent_id,
                    'inspection_round_id':rid,'as_of':cutoff,'input_overrides':{},'assumptions':assumptions}
        digest=service.fingerprint(normalized)
        prior=service.receipt(conn,key,'formal-run',digest)
        if prior is not None:return prior
        if conn.execute('SELECT 1 FROM runs WHERE request_id=?',(key,)).fetchone():
            raise HTTPException(409,'请求标识已被使用。')
        run_id='run-'+uuid4().hex;created=ev.now()
        effective=planning.apply_overrides(conn,deepcopy(parent['evidence']),assumptions,rid,cutoff,
                                       parent['input_snapshot']['round']['window_end'],run_id)
        assumption_proofs=[p for p in effective if p['evidence_id'] not in {e['evidence_id'] for e in parent['evidence']}]
        proofs=deepcopy(parent['evidence'])+assumption_proofs
        effective_ids={p['evidence_id'] for p in effective}
        overridden_ids=[p['evidence_id'] for p in parent['evidence'] if p['evidence_id'] not in effective_ids]
        definitions=deepcopy(parent['input_snapshot']['plan_definitions'])
        plan_version=parent['input_snapshot']['plan_version']
        snapshot={**deepcopy(parent['input_snapshot']),**normalized,'frozen_parent_run_id':parent_id,
                  'task_results_basis':'parent_reality','assumption_created_at':created,'overridden_parent_planning_evidence_ids':overridden_ids}
        watermark={**deepcopy(parent['source_watermark']),'parent_run_id':parent_id,'assumption_evidence_ids':[p['evidence_id'] for p in assumption_proofs]}
        result={**deepcopy(parent),'run_id':run_id,'scenario_id':'S4','run_type':'what_if','parent_run_id':parent_id,
                'input_snapshot':snapshot,'source_watermark':watermark,'created_at':created,'completed_at':created,
                'evidence':proofs,'implementation_stage':7,'assumptions':assumptions,
                'plan_results':evaluate_plans(definitions,effective,rid,cutoff),
                'summary':'条件推演；事实任务沿用父现实运行，方案仅在假设下评估。'}
        result.pop('analysis',None)
        ev.insert(conn,'runs',dict(run_id=run_id,schema_version=3,scenario_id='S4',inspection_round_id=rid,
            run_type='what_if',parent_run_id=parent_id,rule_version=parent['rule_version'],status='running',as_of=cutoff,
            created_at=created,completed_at=None,input_snapshot=service.json_text(snapshot),source_watermark=service.json_text(watermark),
            request_id=key,content_hash=digest,summary=None,result_json=None))
        conn.execute('INSERT INTO run_references VALUES (?,?)',(run_id,'formal'))
        for p in proofs:conn.execute('INSERT INTO run_evidence VALUES (?,?)',(run_id,p['evidence_id']))
        for task in result['task_results']:
            ev.insert(conn,'task_results',dict(run_id=run_id,task_id=task['task_id'],state=task['state'],result_json=service.json_text(task)))
            for ch in task['checks']:
                ev.insert(conn,'dependency_checks',dict(run_id=run_id,task_id=task['task_id'],dependency_id=ch['dependency_id'],status=ch['status'],reason=ch['reason'],evidence_refs=service.json_text(ch['evidence_refs']),missing_kind=ch.get('missing_kind')))
        for plan in result['plan_results']:
            ev.insert(conn,'plan_results',dict(run_id=run_id,plan_id=plan['plan_id'],plan_version=plan_version,state=plan['state'],result_json=service.json_text(plan)))
        for b in result['blockers']:
            ev.insert(conn,'blockers',{**b,'run_id':run_id,'evidence_refs':service.json_text(b['evidence_refs']),'point_ids':service.json_text(b['point_ids'])})
        conn.execute('UPDATE runs SET status=?,completed_at=?,summary=?,result_json=? WHERE run_id=?',('completed',created,result['summary'],service.json_text(result),run_id))
        service.save_receipt(conn,key,'formal-run',digest,result)
        return result
