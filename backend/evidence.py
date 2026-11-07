"""Stage 02 immutable facts. No task, coverage, or scenario judgments."""
from datetime import datetime, date, timezone, timedelta
import json
import math
import sqlite3
from time import perf_counter
from uuid import uuid4
from fastapi import HTTPException
if __package__:
    from . import service
    from .configuration import FACILITIES, CONFIG_HASH
else:
    import service
    from configuration import FACILITIES, CONFIG_HASH

SHANGHAI = timezone(timedelta(hours=8))
CATALOG = {f['checkpoint_id']: f for f in FACILITIES}

def stamp(value, local=False):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            if not local or 'T' not in value:
                raise ValueError()
            parsed = parsed.replace(tzinfo=SHANGHAI)
        return parsed.astimezone(timezone.utc).isoformat(timespec='microseconds')
    except (ValueError, TypeError, AttributeError, OverflowError):
        raise HTTPException(422, '时间必须是有效 ISO 日期时间；无时区现场时间按 Asia/Shanghai。') from None

def now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')

def initialize(conn):
    statements = [
        '''CREATE TABLE IF NOT EXISTS inspection_rounds (
        inspection_round_id TEXT PRIMARY KEY, round_id TEXT NOT NULL UNIQUE CHECK(round_id=inspection_round_id),
        scenario_instance_id TEXT, config_hash TEXT NOT NULL, date TEXT NOT NULL, timezone TEXT NOT NULL,
        window_start TEXT NOT NULL, window_end TEXT NOT NULL, created_at TEXT NOT NULL)''',
        '''CREATE TABLE IF NOT EXISTS facility_observations (
        observation_id TEXT PRIMARY KEY, facility_id TEXT NOT NULL, zone_id TEXT NOT NULL,
        observed_at TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('SIMULATED','DEVICE')),
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL, retrieved_at TEXT NOT NULL,
        event_id TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(source_type,event_id),
        UNIQUE(facility_id,observed_at))''',
        '''CREATE TABLE IF NOT EXISTS inspection_records (
        inspection_id TEXT PRIMARY KEY, inspection_round_id TEXT REFERENCES inspection_rounds(inspection_round_id),
        checkpoint_id TEXT NOT NULL, facility_id TEXT NOT NULL, zone_id TEXT NOT NULL,
        inspector_id TEXT NOT NULL, inspected_at TEXT NOT NULL, method TEXT NOT NULL CHECK(method='ON_SITE'),
        result TEXT CHECK(result IN ('NORMAL','WARNING','FAULT')),
        notes TEXT NOT NULL, created_at TEXT NOT NULL, legacy_record_id INTEGER UNIQUE REFERENCES records(id),
        raw_result TEXT NOT NULL, origin TEXT NOT NULL, result_semantics TEXT,
        started_at TEXT, duration_seconds REAL CHECK(duration_seconds>=0), source_type TEXT NOT NULL CHECK(source_type='ON_SITE'),
        request_id TEXT NOT NULL UNIQUE, supersedes_id TEXT REFERENCES inspection_records(inspection_id))''',
        '''CREATE TABLE IF NOT EXISTS evidence (
        evidence_id TEXT PRIMARY KEY, evidence_type TEXT NOT NULL, source_type TEXT NOT NULL,
        source_id TEXT NOT NULL, zone_id TEXT, observed_at TEXT NOT NULL, retrieved_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok','unavailable','error')), value_json TEXT, error TEXT,
        review_id TEXT REFERENCES reviews(review_id), created_at TEXT NOT NULL,
        inspection_round_id TEXT REFERENCES inspection_rounds(inspection_round_id), checkpoint_id TEXT,
        facility_id TEXT, observation_id TEXT REFERENCES facility_observations(observation_id),
        inspection_id TEXT REFERENCES inspection_records(inspection_id),
        valid_until TEXT, provenance_json TEXT NOT NULL, content_hash TEXT NOT NULL)''',
        'CREATE TABLE IF NOT EXISTS storage_probes (probe_id TEXT PRIMARY KEY, value TEXT NOT NULL)',
        'CREATE INDEX IF NOT EXISTS observation_history ON facility_observations(facility_id,observed_at,observation_id)',
        'CREATE INDEX IF NOT EXISTS inspection_round_history ON inspection_records(inspection_round_id,inspected_at,inspection_id)',
        'CREATE INDEX IF NOT EXISTS evidence_round_history ON evidence(inspection_round_id,observed_at,evidence_id)',
        """CREATE INDEX IF NOT EXISTS evidence_original_round_history
            ON evidence(inspection_round_id,observed_at,evidence_id)
            WHERE COALESCE(json_extract(provenance_json,'$.run_id'),'')=''""",
    ]
    for sql in statements:
        conn.execute(sql)
    for table in ('facility_observations','inspection_records','evidence','inspection_rounds'):
        for operation in ('UPDATE','DELETE'):
            conn.execute(f"CREATE TRIGGER IF NOT EXISTS immutable_{table}_{operation} BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT,'append-only facts'); END")

def insert(conn, table, value):
    conn.execute(f"INSERT INTO {table} ({','.join(value)}) VALUES ({','.join('?' for _ in value)})",tuple(value.values()))

def add(conn, evidence_type, source_type, source_id, observed_at, value, **extra):
    acquired = extra.pop('retrieved_at', now())
    provenance = extra.pop('provenance', {'source_id':source_id,'source_type':source_type})
    row = dict(evidence_id='E-'+uuid4().hex, evidence_type=evidence_type, source_type=source_type,
               source_id=source_id, zone_id=None, observed_at=stamp(observed_at), retrieved_at=stamp(acquired),
               status='ok', value_json=service.json_text(value) if value is not None else None,
               error=None,review_id=None,created_at=now(),inspection_round_id=None,checkpoint_id=None,
               facility_id=None,observation_id=None,inspection_id=None,valid_until=None,
               provenance_json=service.json_text(provenance),content_hash=service.fingerprint(value))
    row.update(extra)
    insert(conn,'evidence',row)
    return decode(row)

def decode(row):
    result=dict(row)
    for key in ('value_json','payload_json','provenance_json'):
        if key in result and result[key] is not None:
            result[key]=json.loads(result[key])
    return result

def create_round(store, payload):
    if set(payload)-{'round_id','date','scenario_instance_id'} or not {'round_id','date'} <= set(payload):
        raise HTTPException(422,'轮次接受 round_id、date 和可选 scenario_instance_id。')
    rid=service.request_key(payload['round_id'])
    instance=payload.get('scenario_instance_id')
    if instance is not None:
        instance=service.text(instance,'scenario_instance_id',128)
    config_hash=CONFIG_HASH
    try:
        day=date.fromisoformat(payload['date'])
        if day.isoformat()!=payload['date']:
            raise ValueError()
    except (ValueError,TypeError):
        raise HTTPException(422,'date 必须为 YYYY-MM-DD。') from None
    row=dict(inspection_round_id=rid,round_id=rid,scenario_instance_id=instance,config_hash=config_hash,date=day.isoformat(),timezone='Asia/Shanghai',
             window_start=stamp(day.isoformat()+'T09:00:00',True),
             window_end=stamp(day.isoformat()+'T09:45:00',True),created_at=now())
    with store.transaction(write=True) as conn:
        prior=conn.execute('SELECT * FROM inspection_rounds WHERE inspection_round_id=?',(rid,)).fetchone()
        if prior:
            if any(prior[k]!=row[k] for k in ('date','scenario_instance_id','config_hash')):
                raise HTTPException(409,'轮次标识已绑定另一日期。')
            return dict(prior)
        insert(conn,'inspection_rounds',row)
    return row

def round_row(conn, rid):
    if rid is None:
        return None
    row=conn.execute('SELECT * FROM inspection_rounds WHERE inspection_round_id=?',(rid,)).fetchone()
    if row is None:
        raise HTTPException(422,'请先明确创建巡检轮次。')
    return row

def eligible(conn, rid, inspected):
    row=round_row(conn,rid)
    return row['window_start'] <= inspected <= row['window_end'] if row else None

def canonical_fields(payload, key=None):
    allowed={'inspection_round_id','checkpoint_id','facility_id','zone_id','inspector_id','inspected_at','method','result','notes','request_id','started_at','duration_seconds','supersedes_id'}
    if not isinstance(payload,dict) or set(payload)-allowed:
        raise HTTPException(422,'巡检 JSON 包含不支持字段。')
    point=service.require_point(payload.get('checkpoint_id'))
    facility=CATALOG[point]
    if payload.get('facility_id')!=facility['facility_id'] or payload.get('zone_id')!=facility['zone_id']:
        raise HTTPException(422,'设施、区域和点位映射不一致。')
    if payload.get('method')!='ON_SITE' or payload.get('result') not in ('NORMAL','WARNING','FAULT'):
        raise HTTPException(422,'需明确 ON_SITE 与有效现场结果。')
    if key and payload.get('request_id',key)!=key:
        raise HTTPException(422,'两个幂等标识不一致。')
    inspected=stamp(payload.get('inspected_at'),True)
    result=payload['result']
    started=stamp(payload['started_at'],True) if payload.get('started_at') is not None else None
    duration=payload.get('duration_seconds')
    if (started is None) != (duration is None):
        raise HTTPException(422,'started_at 与 duration_seconds 必须一起提供。')
    if started is not None:
        actual=(datetime.fromisoformat(inspected)-datetime.fromisoformat(started)).total_seconds()
        if type(duration) not in (int,float) or not math.isfinite(duration) or duration<0 or abs(actual-duration)>0.000001:
            raise HTTPException(422,'现场开始、完成时间与耗时不一致。')
    supersedes=payload.get('supersedes_id')
    if supersedes is not None:
        supersedes=service.request_key(supersedes)
    assumed=any(datetime.fromisoformat(payload[k].replace('Z','+00:00')).tzinfo is None for k in ('inspected_at','started_at') if payload.get(k))
    return dict(point_id=point,inspector_id=payload.get('inspector_id'),inspected_at=inspected,
                result={'NORMAL':'ok','WARNING':'alarm','FAULT':'alarm','UNKNOWN':'unknown'}[result],
                notes=payload.get('notes',''),onsite_confirmed='true',
                request_id=service.request_key(payload.get('request_id',key)),
                inspection_round_id=payload.get('inspection_round_id'),canonical_result=result,
                started_at=started,duration_seconds=duration,supersedes_id=supersedes,
                assumed_timezone='Asia/Shanghai' if assumed else None)

def save_inspection(conn,value,record_id,review_id=None,photos=()):
    rid=value.get('inspection_round_id')
    inspected=stamp(value['inspected_at'])
    window=eligible(conn,rid,inspected)
    facility=CATALOG[value['point_id']]
    result=value.get('canonical_result') or ('FAULT' if value.get('conclusion')=='fault' else {'ok':'NORMAL','alarm':None,'unknown':None}[value['result']])
    supersedes=value.get('supersedes_id')
    if supersedes:
        prior=conn.execute('SELECT * FROM inspection_records WHERE inspection_id=?',(supersedes,)).fetchone()
        if not prior or prior['checkpoint_id']!=value['point_id'] or prior['inspection_round_id']!=rid:
            raise HTTPException(422,'更正记录必须引用同点位、同轮次的已有记录。')
    row=dict(inspection_id='I-'+uuid4().hex,inspection_round_id=rid,checkpoint_id=value['point_id'],
             facility_id=facility['facility_id'],zone_id=facility['zone_id'],inspector_id=value['inspector_id'],
             inspected_at=inspected,method='ON_SITE',result=result,notes=value['notes'],created_at=now(),
             legacy_record_id=record_id,raw_result=value.get('canonical_result',value['result']),
             origin='canonical_json' if 'canonical_result' in value else 'legacy_form',
             source_type='ON_SITE',request_id=value['request_id'],supersedes_id=supersedes,
             started_at=value.get('started_at'),duration_seconds=value.get('duration_seconds'),
             result_semantics=None if result else '旧表单未区分异常等级' if value['result']=='alarm' else '结果未确认')
    insert(conn,'inspection_records',row)
    proof=add(conn,'inspection_record','ON_SITE',row['inspection_id'],inspected,
              {**row,'photos':list(photos)},provenance={'legacy_record_id':record_id,'inspector_id':value['inspector_id'],
              'request_id':value['request_id'],'origin':row['origin'],'assumed_timezone':value.get('assumed_timezone')},review_id=review_id,inspection_round_id=rid,
              checkpoint_id=row['checkpoint_id'],facility_id=row['facility_id'],zone_id=row['zone_id'],inspection_id=row['inspection_id'])
    return dict(inspection_id=row['inspection_id'],inspection_round_id=rid,evidence_id=proof['evidence_id'],window_eligible=window)

def persist_observation(store,value,retrieved,event_id,derived):
    with store.transaction(write=True,timeout=0.15) as conn:
        prior=conn.execute('SELECT * FROM facility_observations WHERE source_type=? AND event_id=?',(value['source_type'],event_id)).fetchone()
        if prior and json.loads(prior['payload_json'])!=value:
            return 'rejected',prior['observation_id']
        latest=conn.execute('SELECT * FROM facility_observations WHERE facility_id=? ORDER BY observed_at DESC LIMIT 1',(value['facility_id'],)).fetchone()
        if latest:
            if value['observed_at']<latest['observed_at']:
                return 'out_of_order',latest['observation_id']
            if value['observed_at']==latest['observed_at']:
                return ('duplicate' if json.loads(latest['payload_json'])==value else 'rejected'),latest['observation_id']
        row=dict(observation_id='O-'+uuid4().hex,facility_id=value['facility_id'],zone_id=value['zone_id'],
                 observed_at=value['observed_at'],source_type=value['source_type'],payload_json=service.json_text(value),
                 created_at=now(),retrieved_at=stamp(retrieved),event_id=event_id,received_at=stamp(retrieved))
        insert(conn,'facility_observations',row)
        point=next(f['checkpoint_id'] for f in FACILITIES if f['facility_id']==value['facility_id'])
        add(conn,'facility_status',value['source_type'],value['facility_id'],value['observed_at'],value,
            retrieved_at=retrieved,provenance={'event_id':event_id,'event_id_derived':derived,
            'observation_id':row['observation_id'],'received_at':row['received_at']},facility_id=value['facility_id'],checkpoint_id=point,zone_id=value['zone_id'],observation_id=row['observation_id'])
        return 'accepted',row['observation_id']

def query(store,table,params):
    definitions={
      'facility_observations':('observed_at','observation_id',{'facility_id','zone_id','source_type'}),
      'inspection_records':('inspected_at','inspection_id',{'facility_id','zone_id','inspection_round_id','checkpoint_id','inspector_id','result'}),
      'evidence':('observed_at','evidence_id',{'facility_id','zone_id','inspection_round_id','checkpoint_id','source_type','source_id','evidence_type','review_id','status'}),
      'inspection_rounds':('window_start','inspection_round_id',{'round_id','inspection_round_id'})}
    time_col,id_col,filters=definitions[table]
    if set(params)-filters-{'from','to','limit','offset'} or len(params)!=len(list(params.multi_items())):
        raise HTTPException(422,'查询包含未知或重复字段。')
    try:
        limit=int(params.get('limit','50')); offset=int(params.get('offset','0'))
        if not 1<=limit<=200 or not 0<=offset<=1000000:
            raise ValueError()
    except ValueError:
        raise HTTPException(422,'limit 应为 1–200，offset 应为 0–1000000。') from None
    clauses=[]; values=[]
    for key in filters:
        if key in params:
            clauses.append(key+'=?'); values.append(service.text(params[key],key,128))
    start=stamp(params['from']) if 'from' in params else None
    end=stamp(params['to']) if 'to' in params else None
    if start and end and start>end:
        raise HTTPException(422,'起始时间晚于结束时间。')
    for value,operator in ((start,'>='),(end,'<=')):
        if value:
            clauses.append(time_col+operator+'?');values.append(value)
    where=' WHERE '+' AND '.join(clauses) if clauses else ''
    with store.transaction() as conn:
        total=conn.execute(f'SELECT COUNT(*) FROM {table}'+where,values).fetchone()[0]
        rows=[decode(r) for r in conn.execute(f'SELECT * FROM {table}'+where+f' ORDER BY {time_col} DESC,{id_col} DESC LIMIT ? OFFSET ?',values+[limit,offset])]
        if table=='inspection_records':
            for row in rows:
                row['window_eligible']=eligible(conn,row['inspection_round_id'],row['inspected_at'])
    return dict(items=rows,total=total,limit=limit,offset=offset)

def storage_check(store):
    proof=[]; probe=uuid4().hex; start=perf_counter(); observed=now()
    try:
        with store.transaction(write=True) as conn:
            conn.execute('INSERT INTO storage_probes VALUES (?,?)',(probe,probe))
        write_ms=(perf_counter()-start)*1000
        start=perf_counter()
        with store.transaction() as conn:
            row=conn.execute('SELECT value FROM storage_probes WHERE probe_id=?',(probe,)).fetchone()
            count=conn.execute('SELECT COUNT(*) FROM facility_observations').fetchone()[0]
            if row is None or row[0]!=probe:
                raise sqlite3.DatabaseError('Probe readback mismatch')
        read_ms=(perf_counter()-start)*1000
        with store.transaction(write=True) as conn:
            write_proof=add(conn,'sqlite_write','SYSTEM',probe,observed,{'write_ms':write_ms,'committed':True})
            query_proof=add(conn,'history_query','SYSTEM',probe,observed,{'query_ms':read_ms,'readback_matched':True,'observation_count':count})
            conn.execute('DELETE FROM storage_probes WHERE probe_id=?',(probe,))
        # Publish IDs only after the context manager successfully commits.
        proof=[write_proof,query_proof]
        return {'evidence':proof}
    except sqlite3.Error as error:
        try:
            with store.transaction(write=True) as conn:
                error_proof=add(conn,'storage_check','SYSTEM',probe,observed,None,status='error',error=str(error))
                conn.execute('DELETE FROM storage_probes WHERE probe_id=?',(probe,))
            proof=[error_proof]
        except sqlite3.Error:
            pass
        raise HTTPException(503,{'message':'SQLite probe failed; persistence not confirmed','evidence':proof}) from None
