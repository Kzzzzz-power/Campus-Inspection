"""Pure dependency checks over one frozen evidence snapshot. No scenario states."""
from datetime import datetime
from .run_schema import TASKS

SYSTEM_TYPES={'configuration','coverage_check','anomaly_list','sqlite_write','history_query',
              'aggregation','review_channel','basic_statistics'}


def timestamp(value):
    try:
        result=datetime.fromisoformat(value.replace('Z','+00:00'))
        return result if result.utcoffset() is not None else None
    except (AttributeError,TypeError,ValueError):
        return None


def check(task,name,status,reason,refs=(),missing_kind=None):
    return {'dependency_id':task+'.'+name,'status':status,'reason':reason,
            'evidence_refs':sorted(set(refs)),'missing_kind':missing_kind if status=='unknown' else None}


def task_result(task,checks):
    unknown=[c for c in checks if c['status']=='unknown']
    if any(c['status']=='unsatisfied' for c in checks):
        state='blocked'
    elif any(c['missing_kind']!='post_action_proof' for c in unknown):
        state='unknown'
    elif unknown:
        state='pending_verification'
    else:
        state='established'
    return {'task_id':task,'name':TASKS[task],'state':state,'checks':checks,
            'reason':'；'.join(c['reason'] for c in checks if c['status']!='satisfied') or '全部必要依赖已满足'}


def evaluate(snapshot):
    coverage=snapshot['coverage']; evidence=snapshot['evidence']; records=snapshot['inspection_records']
    cutoff=timestamp(snapshot['as_of']); start=timestamp(coverage['window_start']); end=timestamp(coverage['window_end'])
    rid=coverage['inspection_round_id']; by_id={p['evidence_id']:p for p in evidence}
    if len(by_id)!=len(evidence) or None in (cutoff,start,end):
        raise ValueError('Invalid evidence identifiers or frozen times')
    def value(p):
        return p.get('value_json') or {} if p else {}
    def refs(items):
        return [p['evidence_id'] for p in items]
    def traceable(p):
        observed,retrieved=timestamp(p.get('observed_at')),timestamp(p.get('retrieved_at'))
        return (p.get('source_type') in ('SYSTEM','SIMULATED','ON_SITE','DEVICE') and bool(p.get('source_id'))
                and observed is not None and retrieved is not None and retrieved>=observed)
    def usable(p,historical=False):
        if p.get('inspection_round_id')!=rid or p.get('status')!='ok' or not traceable(p):
            return False
        if p['evidence_type'] in SYSTEM_TYPES:
            return p['source_type']=='SYSTEM'
        observed=timestamp(p['observed_at'])
        expiry=timestamp(p.get('valid_until')) if p.get('valid_until') else end
        return observed<=cutoff and (historical or (observed>=start and expiry is not None and cutoff<=expiry))
    def items(kind):
        return [p for p in evidence if p['evidence_type']==kind and usable(p)]
    def one(kind):
        found=items(kind)
        return found[0] if found and all(value(p)==value(found[0]) for p in found) else None
    def proof_check(task,name,kind,predicate,explanation):
        p=one(kind)
        candidates=[p for p in evidence if p['evidence_type']==kind and p.get('inspection_round_id')==rid]
        errors=[p for p in candidates if p['source_type']=='SYSTEM' and p['status']=='error' and traceable(p)]
        decision=predicate(value(p)) if p else None
        status=('unknown' if decision is None else 'satisfied' if decision else 'unsatisfied') if p else 'unsatisfied' if errors else 'unknown'
        return check(task,name,status,explanation+('' if status=='satisfied' else '：缺失、失败或不一致'),
                     [p['evidence_id']] if p else refs(errors or candidates),'reality')
    config=one('configuration'); cp=one('coverage_check'); cr=refs([cp]) if cp else []
    configured=value(config).get('facilities',[])
    config_ok=bool(configured) and {f['checkpoint_id'] for f in configured if f['critical']}=={
        p['checkpoint_id'] for p in coverage['points'] if p['required']}
    t1=[check('T1','configuration','satisfied' if config_ok else 'unknown','必检清单与覆盖输入核对',refs([config]) if config else [],'reality'),
        check('T1','window','satisfied' if start<=cutoff<=end else 'unsatisfied','判断截止时间位于固定巡检窗口',cr),
        check('T1','coverage','satisfied' if cp and value(cp)==coverage and not coverage['missing'] else 'unknown',
              '全部必检点有现场记录' if not coverage['missing'] else '缺少有效记录：'+','.join(coverage['missing']),cr,'reality')]
    access_state='satisfied'; ar=list(cr)
    for zone in {p['zone_id'] for p in coverage['points'] if p['required'] and not p['covered']}:
        candidates=[p for p in items('zone_access') if value(p).get('zone_id')==zone]
        latest=max((timestamp(p['observed_at']) for p in candidates),default=None)
        current=[p for p in candidates if timestamp(p['observed_at'])==latest]
        ar.extend(refs(current)); states={value(p).get('access') for p in current}
        if states=={'DENIED'}:
            access_state='unsatisfied'
        elif states!={'ALLOWED'} and access_state!='unsatisfied':
            access_state='unknown'
    t1.append(check('T1','access',access_state,{'satisfied':'已覆盖点有到达证据；缺口区域访问证据已核对',
        'unsatisfied':'必检缺口所在区域明确拒绝进入','unknown':'缺口所在区域访问条件未知'}[access_state],ar,'reality'))
    results=[task_result('T1',t1)]

    anomalies=one('anomaly_list'); targets=value(anomalies).get('checkpoint_ids')
    anomaly_ok=value(anomalies).get('complete') is True and isinstance(targets,list)
    arefs=refs([anomalies]) if anomalies else []
    t2=[check('T2','anomalies','satisfied' if anomaly_ok else 'unknown','已归档异常清单与来源核对',arefs,'reality')]
    unresolved=[]; confirmation_refs=list(arefs)
    for point in targets or []:
        candidates=[p for p in evidence if p['evidence_type']=='review_confirmation' and p.get('checkpoint_id')==point
                    and p.get('inspection_round_id')==rid and timestamp(p['observed_at'])<=cutoff]
        latest=max((timestamp(p['observed_at']) for p in candidates),default=None)
        current=[p for p in candidates if timestamp(p['observed_at'])==latest]
        confirmation_refs.extend(refs(current))
        good=bool(current) and len({value(p).get('conclusion') for p in current})==1
        for p in current:
            basis_ids=value(p).get('basis_evidence_ids',[])
            good=good and usable(p) and p['source_type'] in ('ON_SITE','SIMULATED') and value(p).get('conclusion') in ('confirmed_abnormal','ruled_out') and bool(basis_ids)
            for eid in basis_ids:
                basis=by_id.get(eid)
                valid=(basis is not None and usable(basis,True) and basis.get('checkpoint_id')==point
                       and basis['evidence_type'] in ('inspection_record','field_note','historical_observation','remote_status','facility_status')
                       and timestamp(basis['observed_at'])<=timestamp(p['observed_at']))
                good=good and valid
                if basis:
                    confirmation_refs.append(eid)
        # Later acquisition failures or conflicting current facts invalidate an earlier confirmation.
        statuses=[p for p in evidence if p.get('checkpoint_id')==point and p['evidence_type'] in ('remote_status','facility_status')
                  and p.get('inspection_round_id')==rid and timestamp(p['observed_at'])<=cutoff]
        if statuses:
            newest=max(timestamp(p['observed_at']) for p in statuses)
            latest_statuses=[p for p in statuses if timestamp(p['observed_at'])==newest]
            if any(p['status']!='ok' for p in latest_statuses) or (latest is not None and newest>latest):
                good=False
                confirmation_refs.extend(refs(latest_statuses))
        if not good:
            unresolved.append(point)
    confirmed=anomaly_ok and not unresolved
    t2.append(check('T2','confirmation','satisfied' if confirmed else 'unknown',
        '异常确认已完成；不代表设施均正常' if confirmed else '当前确认不足、冲突或无法取得：'+','.join(unresolved),confirmation_refs,'reality'))
    results.append(task_result('T2',t2))

    write,query=one('sqlite_write'),one('history_query')
    business=[p for p in evidence if p.get('inspection_round_id')==rid and p['evidence_type'] not in SYSTEM_TYPES]
    t3=[proof_check('T3','write','sqlite_write',lambda v:v.get('committed') is True,'SQLite 实际提交'),
        proof_check('T3','query','history_query',lambda v:v.get('readback_matched') is True and v.get('process_readback_matched') is True
                    and write is not None and query['source_id']==write['source_id'],'独立 Python 进程查询已提交历史'),
        check('T3','traceability','satisfied' if business and all(traceable(p) for p in business) else 'unknown',
              '业务证据来源与取证时间可追溯',refs(business),'reality'),
        proof_check('T3','aggregation','aggregation',lambda v:None if type(v.get('lag_seconds')) not in (int,float) else
                    0<=v['lag_seconds']<=120 and v.get('local_durable') is True,'汇聚延迟不超过 120 秒且本地持久保存')]
    results.append(task_result('T3',t3))

    reviews=[r for r in snapshot['reviews'] if timestamp(r['created_at']) and timestamp(r['created_at'])<=cutoff]
    linked=[p for p in evidence if p['evidence_type'] in ('inspection_record','field_note') and usable(p)
            and p['source_type'] in ('ON_SITE','SIMULATED') and any(r['review_id']==p.get('review_id')
            and r['point_id']==p.get('checkpoint_id') and timestamp(p['observed_at'])>=timestamp(r['created_at']) for r in reviews)]
    missing=[r for r in reviews if r['review_id'] not in {p['review_id'] for p in linked}]
    pending=bool(missing) and all(r['status']=='pending' and (not r.get('expires_at') or timestamp(r['expires_at'])>=cutoff) for r in missing)
    channel=one('review_channel'); chrefs=refs([channel]) if channel else []
    t4=[check('T4','object','satisfied' if reviews else 'unknown','复核请求关联具体点位',refs(linked)+chrefs,'reality'),
        proof_check('T4','channel','review_channel',lambda v:v.get('saved') is True and v.get('readback_matched') is True
                    and v.get('linked') is True,'补证保存与关联查询实际完成'),
        check('T4','linked_evidence','satisfied' if reviews and not missing else 'unknown',
              '已形成关联现场证据' if reviews and not missing else '等待已发起复核的新现场证据' if pending else '缺少可验证的现场补证',
              refs(linked)+chrefs,'post_action_proof' if pending else 'reality')]
    results.append(task_result('T4',t4))
    stats=one('basic_statistics'); sv=value(stats); srefs=refs([stats]) if stats else []
    stats_ok=all(type(sv.get(k)) is int and sv[k]>=0 for k in ('inspection_count','anomaly_count')) and 'duration_seconds' in sv and (
        type(sv['duration_seconds']) in (int,float) and sv['duration_seconds']>=0 or sv['duration_seconds'] is None and bool(sv.get('limitations')))
    t5=[check('T5','history','satisfied' if records and write and query else 'unknown','冻结历史记录及实际存取证明',refs([p for p in (write,query) if p]),'reality'),
        check('T5','task_results','satisfied','T1–T4 已计算；未知和受阻也可用于复盘',cr+srefs),
        check('T5','statistics','satisfied' if stats_ok else 'unknown','基础统计可复现；缺失耗时不推算',srefs,'reality')]
    result=task_result('T5',t5); result['limitations']=list(sv.get('limitations',[]))
    if results[1]['state']!='established':
        result['limitations'].append('异常项当前确认不足，不推断设施正常或故障。')
    results.append(result)
    return results
