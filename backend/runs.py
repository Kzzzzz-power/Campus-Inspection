"""One immutable, structured judgment run; UI and history read this same result."""
import json
import subprocess
import sys
from datetime import datetime, timezone
from uuid import uuid4
from fastapi import HTTPException
from . import evidence as ev, service
from .configuration import FACILITIES, ZONES, CONFIG_HASH
from .coverage import calculate_coverage
from .run_schema import RULE_VERSION, TASKS
from . import planning
from .feasibility import evaluate_plans, derive_blockers


def inputs(payload):
    if not isinstance(payload,dict) or set(payload)-{'request_id','inspection_round_id','as_of','scenario_id','run_type','input_overrides'}:
        raise HTTPException(422,'运行仅接受轮次、截止时间、场景、reality 类型和输入覆盖。')
    key=service.request_key(payload.get('request_id'))
    rid=service.request_key(payload.get('inspection_round_id'))
    cutoff=ev.stamp(payload.get('as_of'))
    if cutoff>ev.now():
        raise HTTPException(422,'运行截止时间不能晚于当前时间。')
    if payload.get('run_type','reality')!='reality' or payload.get('scenario_id') not in (None,'S1','S2','S3','S5'):
        raise HTTPException(422,'现实运行支持 S1、S2、S3、S5；S4 需指定 what_if 和已完成的 S3 父运行。')
    overrides=payload.get('input_overrides',{})
    if not isinstance(overrides,dict) or set(overrides)-{'exclude_inspection_points','zone_access','remaining_minutes','resources','p2_z3_access','current_status_available'}:
        raise HTTPException(422,'输入覆盖字段无效。')
    if 'current_status_available' in overrides and (payload.get('scenario_id')!='S5' or type(overrides['current_status_available']) is not bool):
        raise HTTPException(422,'current_status_available 仅接受 S5 教学轮次布尔值。')
    excluded=overrides.get('exclude_inspection_points',[])
    if not isinstance(excluded,list) or len(excluded)>8 or any(not isinstance(p,str) or p not in service.POINTS for p in excluded):
        raise HTTPException(422,'排除点位无效。')
    accesses=overrides.get('zone_access',[])
    if not isinstance(accesses,list) or len(accesses)>3:
        raise HTTPException(422,'区域访问输入无效。')
    seen=set()
    for item in accesses:
        if (not isinstance(item,dict) or set(item)!={'zone_id','access'} or item['zone_id'] not in ZONES
                or item['access'] not in ('ALLOWED','DENIED') or item['zone_id'] in seen):
            raise HTTPException(422,'区域访问输入必须唯一，取值 ALLOWED / DENIED。')
        seen.add(item['zone_id'])
    return {'request_id':key,'inspection_round_id':rid,'as_of':cutoff,'scenario_id':payload.get('scenario_id'),
            'run_type':'reality','input_overrides':{'exclude_inspection_points':sorted(set(excluded)),
            'zone_access':sorted(accesses,key=lambda x:x['zone_id']),**planning.validate(overrides),**({'current_status_available':overrides['current_status_available']} if 'current_status_available' in overrides else {})}}


def storage_proof(store, rid):
    proof=ev.storage_check(store)['evidence']
    # Independent process reopens committed history: this is more than connection reuse.
    history=next(p for p in proof if p['evidence_type']=='history_query')
    script='import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(c.execute("SELECT content_hash FROM evidence WHERE evidence_id=?",(sys.argv[2],)).fetchone()[0])'
    result=subprocess.run([sys.executable,'-B','-c',script,str(store.path.resolve()),history['evidence_id']],
                          capture_output=True,text=True,timeout=10)
    matched=result.returncode==0 and result.stdout.strip()==history['content_hash']
    if not matched:
        raise HTTPException(503,'独立进程重新查询失败，尚不能确认历史可靠留存。')
    with store.transaction(write=True) as conn:
        saved=ev.add(conn,'history_query','SYSTEM',history['source_id'],ev.now(),
            {**history['value_json'],'process_readback_matched':True},
            inspection_round_id=rid,provenance={'basis_evidence_ids':[history['evidence_id']],'probe':'fresh_python_process'})
        original=next(p for p in proof if p['evidence_type']=='sqlite_write')
        write=ev.add(conn,'sqlite_write','SYSTEM',original['source_id'],original['observed_at'],original['value_json'],inspection_round_id=rid,provenance={'basis_evidence_ids':[original['evidence_id']]})
    return [write,saved]


def round_facts(conn,rid,cutoff):
    round_value=dict(ev.round_row(conn,rid))
    if round_value['config_hash']!=CONFIG_HASH:
        raise HTTPException(409,'当前设施配置与该轮次不一致；请选择相同配置或创建新轮次。已有运行仍可查阅。')
    records=[dict(r) for r in conn.execute('SELECT * FROM inspection_records WHERE inspection_round_id=?',(rid,))]
    proofs=[ev.decode(r) for r in conn.execute('''SELECT * FROM evidence WHERE
        (inspection_round_id=? OR (inspection_round_id IS NULL AND evidence_type IN ('facility_status','remote_status','historical_observation')))
        AND observed_at<=? ORDER BY observed_at,evidence_id''',(rid,cutoff))]
    proofs=[p for p in proofs if p['evidence_type'] not in ('configuration','coverage_check','anomaly_list','sqlite_write',
        'history_query','aggregation','review_channel','basic_statistics')
        # Enrichment remains independently queryable, outside core judgment facts.
        and p['source_type'] not in ('MODEL_OUTPUT','LLM_OUTPUT','RAG','TOOL_OUTPUT','WEB_API')
        and not p['provenance_json'].get('run_id')]
    reviews=[dict(r) for r in conn.execute('''SELECT DISTINCT r.* FROM reviews r
        LEFT JOIN evidence e ON e.review_id=r.review_id LEFT JOIN runs run ON run.run_id=r.trigger_run_id
        WHERE (e.inspection_round_id=? OR run.inspection_round_id=? OR r.inspection_round_id=?) AND r.created_at<=?''',(rid,rid,rid,cutoff))]
    return round_value,records,proofs,reviews


def basic_statistics(coverage,records,proofs,reviews):
    selected={ref for p in coverage['points'] for ref in p['inspection_refs']}
    valid=[r for r in records if r['inspection_id'] in selected]
    durations=[r['duration_seconds'] for r in valid if r.get('duration_seconds') is not None]
    anomaly_points=sorted({p['checkpoint_id'] for p in proofs if p.get('checkpoint_id') and p['status']=='ok'
                           and ((p.get('value_json') or {}).get('condition') in ('WARNING','FAULT')
                                or p['evidence_type']=='inspection_record' and (p.get('value_json') or {}).get('result') in ('WARNING','FAULT')
                                or p['evidence_type']=='review_confirmation' and (p.get('value_json') or {}).get('conclusion')=='confirmed_abnormal')}
                         | {r['checkpoint_id'] for r in valid if r['result'] in ('WARNING','FAULT')})
    average=sum(durations)/len(durations) if durations else None
    limitations=[]
    if not durations:
        limitations.append('无可追溯的有效巡检耗时样本，平均耗时不推算。')
    if len(durations)!=len(valid):
        limitations.append(f'耗时仅有 {len(durations)}/{len(valid)} 条可追溯样本；未记录的耗时不推算。')
    limitations.append('当前仅提供基础统计，AI 增强尚未接入。')
    return {'coverage_rate':coverage['coverage_rate'],'required':coverage['required'],'covered':coverage['covered'],
            'zone_completion':{z:{'required':sum(p['required'] for p in coverage['points'] if p['zone_id']==z),
                                  'covered':sum(p['required'] and p['covered'] for p in coverage['points'] if p['zone_id']==z)} for z in ZONES},
            'inspection_count':len(valid),'anomaly_count':len(anomaly_points),'anomaly_points':anomaly_points,
            'duration_seconds':average,'average_inspection_seconds':average,'duration_sample_count':len(durations),
            'pending_review_count':sum(r['status']=='pending' for r in reviews),'limitations':limitations}


def create(store,payload,frozen=None,analysis_context=None):
    if not isinstance(payload,dict):
        raise HTTPException(422,'请提供包含轮次或父运行的 JSON 请求对象。')
    if payload.get('run_type')=='what_if':
        if analysis_context is not None:raise HTTPException(422,'条件推演不能提交现实分析。')
        from .what_if import create as branch
        return branch(store,payload)
    value=inputs(payload)
    if analysis_context is not None:
        value['analysis_context']=analysis_context
    key=value['request_id']; digest=service.fingerprint(value)
    with store.transaction() as conn:
        prior=service.receipt(conn,key,'formal-run',digest)
        if prior is not None:
            return prior
        existing=conn.execute('SELECT content_hash,result_json FROM runs WHERE request_id=?',(key,)).fetchone()
        if existing:
            if existing['content_hash']!=digest:raise HTTPException(409,'该请求标识已用于不同输入。')
            return json.loads(existing['result_json'])
        round_value=dict(ev.round_row(conn,value['inspection_round_id']))
        if (value['scenario_id'] is not None or any(value['input_overrides'].values())
            or any(k in value['input_overrides'] for k in ('remaining_minutes','resources','p2_z3_access'))) and not round_value['scenario_instance_id']:
            raise HTTPException(422,'场景输入覆盖只用于显式建立的教学实例。')
    if value['scenario_id'] and not value['inspection_round_id'].startswith(value['scenario_id']+'.'):
        raise HTTPException(422,'场景标识与独立教学轮次不一致。')
    probes=storage_proof(store,value['inspection_round_id'])
    run_id='run-'+uuid4().hex
    with store.transaction(write=True) as conn:
        prior=service.receipt(conn,key,'formal-run',digest)
        if prior is not None:
            return prior
        existing=conn.execute('SELECT content_hash,result_json FROM runs WHERE request_id=?',(key,)).fetchone()
        if existing:
            if existing['content_hash']!=digest:raise HTTPException(409,'该请求标识已用于不同输入。')
            return json.loads(existing['result_json'])
        if analysis_context is not None:
            from datetime import timedelta
            recent=(datetime.now(timezone.utc)-timedelta(minutes=1)).isoformat()
            if conn.execute('SELECT COUNT(*) FROM analysis_jobs WHERE created_at>?',(recent,)).fetchone()[0]>=10:
                raise HTTPException(429,'分析请求过于频繁，请一分钟后重试。')
            if conn.execute("SELECT COUNT(*) FROM analysis_jobs WHERE status='queued' OR (status='running' AND lease_until>?)",(ev.now(),)).fetchone()[0]>=2:
                raise HTTPException(429,'已有分析正在执行，请稍后重试。')
        rid=value['inspection_round_id']; cutoff=value['as_of']
        if value['scenario_id']=='S5' and frozen is None:
            value['requested_as_of']=cutoff
            cutoff=ev.now();value['as_of']=cutoff
        round_value,records,proofs,reviews=round_facts(conn,rid,cutoff)
        if frozen is not None:
            records=frozen['records'];proofs=frozen['proofs'];reviews=frozen['reviews']
        overrides=value['input_overrides']
        coverage=calculate_coverage(FACILITIES,records,round_value,cutoff,overrides['exclude_inspection_points'])
        excluded=set(overrides['exclude_inspection_points'])
        proofs=[p for p in proofs if not (p['evidence_type']=='inspection_record' and p['checkpoint_id'] in excluded)]
        scoped=[]
        for p in proofs:
            if p['inspection_round_id'] is None:
                scoped.append(ev.add(conn,p['evidence_type'],p['source_type'],p['source_id'],p['observed_at'],p['value_json'],
                    status=p['status'],error=p['error'],retrieved_at=p['retrieved_at'],inspection_round_id=rid,
                    checkpoint_id=p['checkpoint_id'],facility_id=p['facility_id'],zone_id=p['zone_id'],
                    provenance={'run_id':run_id,'basis_evidence_ids':[p['evidence_id']]}))
            else:
                scoped.append(p)
        proofs=planning.apply_overrides(conn,scoped,overrides,rid,cutoff,round_value['window_end'],run_id)
        if value['scenario_id']=='S5' and frozen is None and 'current_status_available' in overrides:
            from .degradation import status_evidence
            proofs.append(status_evidence(conn,rid,cutoff,overrides['current_status_available'],run_id=run_id,input_override=True))
        source_watermark={'captured_at':ev.now(),'inspection_ids':[r['inspection_id'] for r in records],
                          'evidence_ids':[p['evidence_id'] for p in proofs]}
        snapshot={**value,'round':round_value,'facilities':FACILITIES,'rule_version':RULE_VERSION,
                  'aggregation_limit_seconds':120,'review_snapshot':reviews,
                  'plan_definitions':planning.DEFINITIONS,'plan_version':planning.PLAN_VERSION}
        created=ev.now()
        ev.insert(conn,'runs',dict(run_id=run_id,schema_version=3,scenario_id=value['scenario_id'],
            inspection_round_id=rid,run_type='reality',parent_run_id=None,rule_version=RULE_VERSION,
            status='running',as_of=cutoff,created_at=created,completed_at=None,
            input_snapshot=service.json_text(snapshot),source_watermark=service.json_text(source_watermark),
            request_id=key,content_hash=digest,summary=None,result_json=None))
        conn.execute('INSERT INTO run_references VALUES (?,?)',(run_id,'formal'))
        def derived(kind,business,**extra):
            p=ev.add(conn,kind,'SYSTEM',run_id,ev.now(),business,inspection_round_id=rid,
                     provenance={'run_id':run_id,'rule_version':RULE_VERSION},**extra)
            proofs.append(p)
            return p
        derived('configuration',{'facilities':FACILITIES,'config_hash':round_value['config_hash']})
        derived('coverage_check',coverage)
        for item in overrides['zone_access']:
            proofs=[p for p in proofs if not (p['evidence_type']=='zone_access' and p['zone_id']==item['zone_id'])]
            proofs.append(ev.add(conn,'zone_access','SIMULATED',run_id,cutoff,item,
                inspection_round_id=rid,zone_id=item['zone_id'],retrieved_at=cutoff,
                provenance={'run_id':run_id,'input_override':True}))
        proofs.extend(probes)
        lag_samples=[]
        for p in proofs:
            if p['evidence_type']=='inspection_record' and p['status']=='ok':
                lag_samples.append(max(0,(datetime.fromisoformat(p['retrieved_at'])-datetime.fromisoformat(p['observed_at'])).total_seconds()))
        derived('aggregation',{'lag_seconds':max(lag_samples) if lag_samples else None,'local_durable':True,
                              'limit_seconds':120,'sample_count':len(lag_samples),
                              'semantics':'SIMULATED uses original source acquisition times; ON_SITE uses actual acquisition.'})
        manual_proofs=[p for p in proofs if p['status']=='ok' and (p['evidence_type']=='inspection_record' and p['source_type']=='ON_SITE'
            or p['evidence_type']=='field_note' and p['provenance_json'].get('port')=='/api/evidence/manual')
            and any(r['review_id']==p['review_id'] and r['point_id']==p['checkpoint_id'] for r in reviews)]
        derived('review_channel',{'saved':bool(manual_proofs),'linked':bool(manual_proofs),
            'readback_matched':bool(manual_proofs),'basis_evidence_ids':[p['evidence_id'] for p in manual_proofs],
            'inspection_round_id':rid,'port':'/api/evidence/manual','verification':'committed entry read in new run transaction'},
            status='ok' if manual_proofs else 'unavailable')
        stats=basic_statistics(coverage,records,proofs,reviews)
        if value['scenario_id']=='S5':
            stats['limitations'].append('C03｜ap-2f 当前状态须有有效的新确认；查询恢复不能替代人工确认。')
        if analysis_context is not None:
            stats['limitations']=[s for s in stats['limitations'] if s!='当前仅提供基础统计，AI 增强尚未接入。']
        derived('anomaly_list',{'checkpoint_ids':stats['anomaly_points'],'complete':True,
                              'scope':'recorded anomalies visible in selected evidence snapshot'})
        from .judgment import evaluate
        if value['scenario_id']=='S5' and frozen is None:
            preliminary=evaluate({'coverage':coverage,'evidence':proofs,'reviews':reviews,'inspection_records':records,'as_of':cutoff})
            confirmation=next(t for t in preliminary if t['task_id']=='T2')
            if 'C03' in confirmation['unresolved_checkpoint_ids']:
                from .degradation import ensure_review
                ensure_review(conn,rid,run_id,cutoff)
                _,_,_,reviews=round_facts(conn,rid,cutoff)
                stats['pending_review_count']=sum(r['status']=='pending' for r in reviews)
                snapshot['review_snapshot']=reviews
                conn.execute('UPDATE runs SET input_snapshot=? WHERE run_id=?',(service.json_text(snapshot),run_id))
        derived('basic_statistics',stats)

        tasks=evaluate({'coverage':coverage,'evidence':proofs,'reviews':reviews,'inspection_records':records,'as_of':cutoff})
        plans=evaluate_plans(planning.DEFINITIONS,proofs,rid,cutoff) if (rid.startswith('S3.') or any(p['evidence_type'] in ('time_budget','resource_availability','access_permission') for p in proofs)) else []
        blockers=derive_blockers(tasks)
        for plan in planning.DEFINITIONS:
            definition=service.json_text(plan)
            previous=conn.execute('SELECT definition_json FROM plan_definitions WHERE plan_version=? AND plan_id=?',(planning.PLAN_VERSION,plan['plan_id'])).fetchone()
            if previous and previous[0]!=definition:raise HTTPException(409,'方案定义已变化，必须更新方案版本。')
            conn.execute('INSERT OR IGNORE INTO plan_definitions VALUES (?,?,?)',(planning.PLAN_VERSION,plan['plan_id'],definition))
        for plan in plans:
            ev.insert(conn,'plan_results',dict(run_id=run_id,plan_id=plan['plan_id'],plan_version=planning.PLAN_VERSION,state=plan['state'],result_json=service.json_text(plan)))
        for blocker in blockers:
            ev.insert(conn,'blockers',{**blocker,'run_id':run_id,'evidence_refs':service.json_text(blocker['evidence_refs']),'point_ids':service.json_text(blocker['point_ids'])})
        for proof in proofs:
            conn.execute('INSERT OR IGNORE INTO run_evidence VALUES (?,?)',(run_id,proof['evidence_id']))
        for task in tasks:
            for check in task['checks']:
                conn.execute('INSERT OR IGNORE INTO dependency_definitions VALUES (?,?,?,?,1)',
                    (RULE_VERSION,task['task_id'],check['dependency_id'],check.get('name',check['dependency_id'])))
                ev.insert(conn,'dependency_checks',dict(run_id=run_id,task_id=task['task_id'],dependency_id=check['dependency_id'],
                    status=check['status'],reason=check['reason'],evidence_refs=service.json_text(check['evidence_refs']),missing_kind=check.get('missing_kind')))
            ev.insert(conn,'task_results',dict(run_id=run_id,task_id=task['task_id'],state=task['state'],result_json=service.json_text(task)))
        summary=f"必检覆盖 {coverage['covered']}/{coverage['required']}；任务成立 {sum(t['state']=='established' for t in tasks)}/5"
        result=dict(run_id=run_id,schema_version=3,legacy=False,status='completed',run_status='completed',
            scenario_id=value['scenario_id'],inspection_round_id=rid,run_type='reality',parent_run_id=None,
            rule_version=RULE_VERSION,as_of=cutoff,created_at=created,completed_at=ev.now(),input_snapshot=snapshot,
            source_watermark=source_watermark,coverage=coverage,statistics=stats,task_results=tasks,evidence=proofs,summary=summary,
            implementation_stage=7 if value['scenario_id']=='S5' else 5,plan_results=plans,blockers=blockers)
        if analysis_context is not None:
            # Commit the frozen core before any external I/O; terminal runs are never reopened.
            result.update(status='running',run_status='running',completed_at=None,implementation_stage=6)
            ev.insert(conn,'analysis_jobs',dict(run_id=run_id,request_id=key,options_json=service.json_text(analysis_context),
                status='queued',lease_until=None,worker_id=None,error=None,created_at=created,updated_at=created))
        conn.execute('UPDATE runs SET status=?,completed_at=?,summary=?,result_json=? WHERE run_id=?',
                     (result['status'],result['completed_at'],summary,service.json_text(result),run_id))
        service.save_receipt(conn,key,'formal-run',digest,result)
    return result


def detail(conn,run_id):
    row=conn.execute('SELECT result_json,status FROM runs WHERE run_id=?',(run_id,)).fetchone()
    if row:
        if row['result_json'] is None:
            raise HTTPException(409,'该次判断尚未完成。')
        return json.loads(row['result_json'])
    row=conn.execute('''SELECT r.*,s.snapshot_json FROM legacy_runs r LEFT JOIN run_snapshots s ON s.run_id=r.run_id WHERE r.run_id=?''',(run_id,)).fetchone()
    if row is None:
        raise HTTPException(404,'运行不存在。')
    return {'run_id':row['run_id'],'created_at':row['created_at'],'summary':row['summary'],
            'legacy':True,'schema_version':'legacy','snapshot':json.loads(row['snapshot_json']) if row['snapshot_json'] else None}


def listing(conn):
    return [dict(r) for r in conn.execute('''SELECT run_id,created_at,summary,3 schema_version FROM runs
        UNION ALL SELECT run_id,created_at,summary,0 schema_version FROM legacy_runs ORDER BY created_at DESC,run_id DESC LIMIT 50''')]


def dashboard(conn,inspection_round_id=None,as_of=None,run_id=None):
    cutoff=ev.stamp(as_of) if as_of else ev.now()
    coverage=None
    if run_id:
        run=detail(conn,run_id)
        if run['legacy']:
            raise HTTPException(422,'旧运行仅提供原始快照，不能转换成正式轮次。')
        if run.get('run_type')=='what_if':raise HTTPException(422,'条件推演不能用作现实覆盖。')
        coverage=run['coverage']; cutoff=run['as_of']; inspection_round_id=run['inspection_round_id']
    elif inspection_round_id:
        round_value,records,_,_=round_facts(conn,inspection_round_id,cutoff)
        coverage=calculate_coverage(FACILITIES,records,round_value,cutoff)
    # Current facility and review facts remain independent from the frozen judgment.
    base=service.point_projection(conn)
    by_point={p['checkpoint_id']:p for p in coverage['points']} if coverage else {}
    for point in base:
        point['covered']=by_point[point['point_id']]['covered'] if coverage else None
    return {'round_state':'selected' if coverage else 'no_round','run_id':run_id,'inspection_round_id':inspection_round_id,
            'as_of':cutoff,'window_start':coverage['window_start'] if coverage else None,
            'window_end':coverage['window_end'] if coverage else None,'window_minutes':45,
            'required_total':coverage['required'] if coverage else sum(f['critical'] for f in FACILITIES),
            'covered':coverage['covered'] if coverage else None,'missing':coverage['missing'] if coverage else [],'points':base}
