"""Explicit teaching instances and the minimal, traceable manual evidence port."""
from datetime import datetime
from uuid import uuid4
from fastapi import HTTPException
from . import evidence as ev, service
from .baseline import load_s1
from .configuration import FACILITIES, CONFIG, read_json

CATALOG = {f['checkpoint_id']:f for f in FACILITIES}


def _prepare_s1(store, payload):
    if set(payload) != {'instance_id','request_id'}:
        raise HTTPException(422,'需要 instance_id 和 request_id。')
    instance = service.request_key(payload['instance_id'])
    key = service.request_key(payload['request_id'])
    fixture = load_s1()
    digest = service.fingerprint({'instance_id':instance,'fixture':fixture})
    rid = 'S1.' + instance
    prefix = rid + '.'
    original = fixture['inspection_round']
    response = {'scenario_id':'S1','source_type':'SIMULATED','inspection_round_id':rid,
                'as_of':fixture['as_of'],'instance_id':instance}
    with store.transaction(write=True) as conn:
        prior = service.receipt(conn,key,'prepare-S1',digest)
        if prior is not None:
            return prior
        existing = conn.execute('SELECT * FROM scenario_instances WHERE instance_id=?',(instance,)).fetchone()
        if existing:
            if existing['fixture_hash'] != service.fingerprint(fixture):
                raise HTTPException(409,'该实例绑定另一版教学输入。')
            service.save_receipt(conn,key,'prepare-S1',digest,response)
            return response
        if conn.execute('SELECT 1 FROM inspection_rounds WHERE inspection_round_id=?',(rid,)).fetchone():
            raise HTTPException(409,'教学轮次标识已被其他数据占用。')
        ev.insert(conn,'inspection_rounds',dict(inspection_round_id=rid,round_id=rid,scenario_instance_id=instance,
            config_hash=service.fingerprint({n:read_json(CONFIG/(n+'.json')) for n in ('facilities','zones')}),
            date=original['window_start'][:10],timezone='Asia/Shanghai',window_start=ev.stamp(original['window_start']),
            window_end=ev.stamp(original['window_end']),created_at=ev.now()))
        observation_ids = {}
        for original_row in fixture['historical_observations']+fixture['facility_observations']:
            row = dict(original_row)
            row['observation_id'] = prefix+row['observation_id']
            row['observed_at'] = ev.stamp(row['observed_at'])
            old = conn.execute('SELECT * FROM facility_observations WHERE facility_id=? AND observed_at=?',
                               (row['facility_id'],row['observed_at'])).fetchone()
            if old:
                if old['source_type']!='SIMULATED' or ev.decode(old)['payload_json']!=row['payload_json']:
                    raise HTTPException(409,'原始教学时间已有不同设施观察，请使用独立演示数据库。')
                row['observation_id'] = old['observation_id']
            else:
                ev.insert(conn,'facility_observations',{**row,'payload_json':service.json_text(row['payload_json']),
                    'created_at':ev.now(),'retrieved_at':row['observed_at'],'received_at':ev.now(),
                    'event_id':row['observation_id']})
            observation_ids[original_row['observation_id']] = row['observation_id']
            f = next(f for f in FACILITIES if f['facility_id']==row['facility_id'])
            ev.add(conn,'historical_observation' if original_row in fixture['historical_observations'] else 'remote_status',
                'SIMULATED',row['observation_id'],row['observed_at'],row['payload_json'],
                inspection_round_id=rid,checkpoint_id=f['checkpoint_id'],facility_id=f['facility_id'],zone_id=f['zone_id'],
                observation_id=row['observation_id'],retrieved_at=row['observed_at'],
                provenance={'fixture':'config/scenarios/S1.json','original_id':original_row['observation_id'],'instance_id':instance})
        for source in fixture['inspection_records']:
            row = {k:source[k] for k in ('checkpoint_id','facility_id','zone_id','inspector_id','method','result','notes','source_type')}
            row.update(inspection_id=prefix+source['inspection_id'],inspection_round_id=rid,
                inspected_at=ev.stamp(source['inspected_at']),created_at=ev.now(),legacy_record_id=None,
                raw_result=source['result'],origin='teaching_fixture',result_semantics=None,
                started_at=None,duration_seconds=None,request_id=prefix+source['inspection_id'],supersedes_id=None)
            ev.insert(conn,'inspection_records',row)
            ev.add(conn,'inspection_record','SIMULATED',row['inspection_id'],row['inspected_at'],row,
                inspection_round_id=rid,checkpoint_id=row['checkpoint_id'],facility_id=row['facility_id'],zone_id=row['zone_id'],
                inspection_id=row['inspection_id'],retrieved_at=row['inspected_at'],
                provenance={'fixture':'config/scenarios/S1.json','original_id':source['inspection_id'],'instance_id':instance})
        for source in fixture['review_requests']:
            f=next(f for f in FACILITIES if f['facility_id']==source['facility_id'])
            ev.insert(conn,'reviews',dict(review_id=prefix+source['review_id'],point_id=f['checkpoint_id'],
                reason=source['reason'],status=source['status'],version=1,conclusion='normal',
                created_at=ev.stamp(source['created_at']),updated_at=ev.stamp(source['completed_at']),trigger_run_id=None))
        for source in fixture['evidence']:
            value=dict(source['value_json'])
            for field in ('observation_id','historical_observation_id','current_observation_id'):
                if field in value:
                    value[field]=observation_ids[value[field]]
            if 'inspection_id' in value:
                value['inspection_id']=prefix+value['inspection_id']
            if 'basis_evidence_ids' in value:
                value['basis_evidence_ids']=[prefix+e for e in value['basis_evidence_ids']]
            ev.add(conn,source['evidence_type'],'SIMULATED',prefix+source['evidence_id'],source['observed_at'],value,
                evidence_id=prefix+source['evidence_id'],status=source['status'],retrieved_at=source['retrieved_at'],
                inspection_round_id=rid,checkpoint_id='C03',facility_id=source['facility_id'],zone_id='Z1',
                review_id=prefix+source['review_id'] if source['review_id'] else None,
                inspection_id=value.get('inspection_id') if source['evidence_type']=='inspection_record' else None,
                provenance={'fixture':'config/scenarios/S1.json','original_id':source['evidence_id'],
                            'original_created_at':source['created_at'],'instance_id':instance})
        for access in fixture['context']['zone_access']:
            ev.add(conn,'zone_access','SIMULATED',prefix+access['zone_id'],fixture['as_of'],access,
                inspection_round_id=rid,zone_id=access['zone_id'],retrieved_at=fixture['as_of'],
                provenance={'fixture':'config/scenarios/S1.json','instance_id':instance})
        ev.insert(conn,'scenario_instances',dict(instance_id=instance,inspection_round_id=rid,
            fixture_hash=service.fingerprint(fixture),response_json=service.json_text(response)))
        service.save_receipt(conn,key,'prepare-S1',digest,response)
    return response


def prepare_s1(store, payload):
    response=_prepare_s1(store,payload)
    prefix=response['inspection_round_id']+'.'
    # Exercise the same validated entry as the manual API; these remain simulated facts.
    manual(store,{'request_id':prefix+'manual-proof','inspection_round_id':response['inspection_round_id'],
        'checkpoint_id':'C03','inspector_id':'P1','observed_at':'2026-10-29T09:09:00+08:00',
        'evidence_type':'field_note','status':'ok','value_json':{'notes':'教学补证入口验证：核对 C03 历史告警及现场记录。'},
        'review_id':prefix+'S1-REVIEW-C03','notes':'教学模拟补证；不代表真实检查。'},source_type='SIMULATED')
    return response


def manual(store, payload, source_type='ON_SITE'):
    allowed={'request_id','inspection_round_id','checkpoint_id','inspector_id','observed_at','evidence_type','status','value_json','review_id','notes'}
    if set(payload)-allowed:
        raise HTTPException(422,'人工证据包含不支持字段；任务状态不能由提交人指定。')
    key=service.request_key(payload.get('request_id'))
    rid=service.request_key(payload.get('inspection_round_id'))
    point=service.require_point(payload.get('checkpoint_id'))
    person=service.text(payload.get('inspector_id'),'记录人',80)
    notes=service.text(payload.get('notes'),'说明',2000)
    observed=ev.stamp(payload.get('observed_at'))
    if observed>ev.now():
        raise HTTPException(422,'现场时间不能晚于当前时间。')
    kind=payload.get('evidence_type')
    status=payload.get('status','ok')
    value=payload.get('value_json')
    if kind not in ('field_note','review_confirmation') or status not in ('ok','unavailable','error'):
        raise HTTPException(422,'仅接受现场说明或人工复核确认；取得状态无效。')
    if status!='ok' and value is not None:
        raise HTTPException(422,'未取得的证据不得携带业务结论。')
    if status=='ok' and (not isinstance(value,dict) or len(service.json_text(value))>10000):
        raise HTTPException(422,'业务内容必须是有效 JSON 对象。')
    digest=service.fingerprint(payload)
    with store.transaction(write=True) as conn:
        prior=service.receipt(conn,key,'manual-evidence',digest)
        if prior is not None:
            return prior
        round_value=dict(ev.round_row(conn,rid))
        if not round_value['window_start']<=observed<=round_value['window_end']:
            raise HTTPException(422,'人工补证时间必须位于所选轮次窗口。')
        review_id=payload.get('review_id')
        if review_id:
            review=conn.execute('SELECT * FROM reviews WHERE review_id=?',(review_id,)).fetchone()
            if not review or review['point_id']!=point:
                raise HTTPException(422,'复核请求与点位不一致。')
            bound_round=service.review_round(conn,review)
            if bound_round and bound_round!=rid:
                raise HTTPException(422,'补证轮次与复核请求所属轮次不一致。')
            if ev.stamp(review['created_at'])>observed:
                raise HTTPException(422,'补证时间不得早于复核请求。')
        if kind=='review_confirmation' and status=='ok':
            if not review_id or set(value)-{'conclusion','basis_evidence_ids'}:
                raise HTTPException(422,'确认需要复核请求，内容仅接受 conclusion 和 basis_evidence_ids。')
            if value.get('conclusion') not in ('confirmed_abnormal','ruled_out','unable_to_confirm'):
                raise HTTPException(422,'结论需区分已确认异常、已排除异常、当前无法确认。')
            refs=value.get('basis_evidence_ids')
            if not isinstance(refs,list) or not 1<=len(refs)<=20 or any(not isinstance(e,str) for e in refs):
                raise HTTPException(422,'必须选择 1–20 项已有判断证据。')
            for ref in refs:
                item=conn.execute('SELECT * FROM evidence WHERE evidence_id=?',(ref,)).fetchone()
                if not item or item['inspection_round_id']!=rid or item['checkpoint_id']!=point or item['observed_at']>observed or item['status']!='ok':
                    raise HTTPException(422,'依据须为同轮次、同点位且不晚于确认时刻的有效证据。')
        f=CATALOG[point]
        proof=ev.add(conn,kind,source_type,person,observed,value,status=status,
            error=notes if status!='ok' else None,review_id=review_id,inspection_round_id=rid,
            checkpoint_id=point,facility_id=f['facility_id'],zone_id=f['zone_id'],
            provenance={'inspector_id':person,'request_id':key,'notes':notes,'port':'/api/evidence/manual'})
        response={'evidence':proof}
        service.save_receipt(conn,key,'manual-evidence',digest,response)
    return response
