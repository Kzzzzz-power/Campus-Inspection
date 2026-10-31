"""Review lifecycle over the existing reviews table; GET endpoints never mutate."""
from datetime import datetime, timedelta
from uuid import uuid4
from fastapi import HTTPException
from . import evidence as ev, service, runs

# Engineering defaults, not prescribed by the B02 case.
DEFAULT_REVIEW_HOURS = 24
CONFIRMATION_MINUTES = 60

def initialize(conn):
    columns={r['name'] for r in conn.execute('PRAGMA table_info(reviews)')}
    for name,kind in {'task_id':'TEXT','inspection_round_id':'TEXT','facility_id':'TEXT','zone_id':'TEXT','expires_at':'TEXT','completed_at':'TEXT','close_reason':'TEXT'}.items():
        if name not in columns: conn.execute(f'ALTER TABLE reviews ADD COLUMN {name} {kind}')
    conn.execute('CREATE TABLE IF NOT EXISTS review_runs (review_id TEXT NOT NULL REFERENCES reviews(review_id), version INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, run_id TEXT, PRIMARY KEY(review_id,version))')
    queue_columns={r['name'] for r in conn.execute('PRAGMA table_info(review_runs)')}
    for name in ('error','last_attempt_at'):
        if name not in queue_columns:conn.execute(f'ALTER TABLE review_runs ADD COLUMN {name} TEXT')
    conn.execute('CREATE VIEW IF NOT EXISTS review_requests AS SELECT * FROM reviews')

def project(conn,row):
    r=dict(row)
    f=ev.CATALOG[r['point_id']]
    r['facility_id']=r.get('facility_id') or f['facility_id'];r['zone_id']=r.get('zone_id') or f['zone_id']
    r['inspection_round_id']=r.get('inspection_round_id') or service.review_round(conn,r)
    r['effective_status']='timeout' if r['status']=='pending' and r.get('expires_at') and r['expires_at']<=service.utcnow().isoformat() else r['status']
    return r

def get(conn,rid):
    row=conn.execute('SELECT * FROM reviews WHERE review_id=?',(rid,)).fetchone()
    if not row:raise HTTPException(404,'复核请求不存在。')
    return project(conn,row)

def listing(store,status=None):
    if status not in (None,'pending','completed','timeout','cancelled'):raise HTTPException(422,'无效复核状态。')
    with store.transaction() as conn:
        rows=[project(conn,r) for r in conn.execute('SELECT * FROM reviews ORDER BY created_at DESC,review_id')]
    rows=[r for r in rows if status is None or r['effective_status']==status]
    return {'items':rows,'total':len(rows)}

def detail(store,rid):
    with store.transaction() as conn:
        return {'review':get(conn,rid),'evidence':[ev.decode(r) for r in conn.execute('SELECT * FROM evidence WHERE review_id=? ORDER BY observed_at,evidence_id',(rid,))],
                'new_runs':[dict(r) for r in conn.execute('SELECT version,run_id,error,last_attempt_at FROM review_runs WHERE review_id=? ORDER BY version',(rid,))]}

def schedule(conn,r):
    if not r.get('inspection_round_id'):return
    trigger=runs.detail(conn,r['trigger_run_id'])
    payload={'request_id':'review-run-'+uuid4().hex,'inspection_round_id':r['inspection_round_id'],'as_of':service.utcnow().isoformat(),
             'scenario_id':trigger.get('scenario_id'),'input_overrides':trigger['input_snapshot'].get('input_overrides',{})}
    _,records,proofs,reviews=runs.round_facts(conn,r['inspection_round_id'],payload['as_of'])
    payload['_frozen']={'records':records,'proofs':proofs,'reviews':reviews}
    conn.execute('INSERT OR IGNORE INTO review_runs (review_id,version,request_id,payload_json,run_id) VALUES (?,?,?,?,NULL)',(r['review_id'],r['version'],payload['request_id'],service.json_text(payload)))

def rerun(store,rid,version):
    import json
    with store.transaction() as conn:
        current=get(conn,rid)
        row=conn.execute('SELECT * FROM review_runs WHERE review_id=? AND version=?',(rid,version)).fetchone()
    if row and row['run_id']:
        return {'status':'completed','run_id':row['run_id'],'error':None}
    if current['version']!=version:raise HTTPException(409,'该版本已被更新，请按最新版本重判。')
    if not row:return {'status':'not_applicable','run_id':None,'error':None}
    try:
        payload=json.loads(row['payload_json']);frozen=payload.pop('_frozen',None)
        result=runs.create(store,payload,frozen=frozen)
        with store.transaction(write=True) as conn:
            conn.execute('UPDATE review_runs SET run_id=?,error=NULL,last_attempt_at=? WHERE review_id=? AND version=?',(result['run_id'],ev.now(),rid,version))
        return {'status':'completed','run_id':result['run_id'],'error':None}
    except (HTTPException,OSError,__import__('sqlite3').Error) as error:
        message=str(getattr(error,'detail',error))
        try:
            with store.transaction(write=True) as conn:
                conn.execute('UPDATE review_runs SET error=?,last_attempt_at=? WHERE review_id=? AND version=?',(message,ev.now(),rid,version))
        except (OSError,__import__('sqlite3').Error):pass
        return {'status':'failed','run_id':None,'error':message}

def finish(store,response):
    r=response['review']
    try:result=rerun(store,r['review_id'],r['version'])
    except HTTPException as error:
        if error.status_code!=409:raise
        result={'status':'failed','run_id':None,'error':str(error.detail)}
    return {**response,'rerun':result}

def create(store,payload):
    if 'task_id' not in payload and 'expires_at' not in payload:
        # Historical clients may still create unbound requests.
        if not payload.get('trigger_run_id'):return service.create_review(store,payload)
    if set(payload)-{'point_id','reason','request_id','trigger_run_id','task_id','expires_at'}:raise HTTPException(422,'不支持的复核字段。')
    point=service.require_point(payload.get('point_id'));key=service.request_key(payload.get('request_id'))
    reason=service.text(payload.get('reason'),'复核原因',1000)
    if payload.get('task_id','T2') not in ('T1','T2','T3','T4','T5'):raise HTTPException(422,'关联任务无效。')
    digest=service.fingerprint(payload)
    with store.transaction(write=True) as conn:
        prior=service.receipt(conn,key,'review-v5',digest)
        if prior is not None:response=prior
        else:
            trigger=runs.detail(conn,payload.get('trigger_run_id'))
            if trigger.get('legacy') or trigger.get('run_type')!='reality':raise HTTPException(422,'需选择已完成现实运行。')
            if conn.execute("SELECT 1 FROM reviews WHERE point_id=? AND status='pending'",(point,)).fetchone():raise HTTPException(409,'点位已有待处理复核。')
            now=service.utcnow().isoformat();expiry=ev.stamp(payload['expires_at']) if payload.get('expires_at') else (datetime.fromisoformat(now)+timedelta(hours=DEFAULT_REVIEW_HOURS)).isoformat()
            if expiry<=now:raise HTTPException(422,'到期时间必须晚于创建时间。')
            f=ev.CATALOG[point]
            r=dict(review_id='review-'+uuid4().hex,point_id=point,reason=reason,status='pending',version=1,conclusion=None,created_at=now,updated_at=now,trigger_run_id=trigger['run_id'],task_id=payload.get('task_id','T2'),inspection_round_id=trigger['inspection_round_id'],facility_id=f['facility_id'],zone_id=f['zone_id'],expires_at=expiry,completed_at=None,close_reason=None)
            ev.insert(conn,'reviews',r);schedule(conn,r)
            response={'review':r};service.save_receipt(conn,key,'review-v5',digest,response)
    return finish(store,response)

def transition(store,rid,payload):
    if set(payload)!={'request_id','version','status','reason'} or payload['status'] not in ('cancelled','timeout') or type(payload['version']) is not int:raise HTTPException(422,'无效复核状态变更。')
    key=service.request_key(payload['request_id']);reason=service.text(payload['reason'],'结束原因',1000);digest=service.fingerprint(payload)
    with store.transaction(write=True) as conn:
        prior=service.receipt(conn,key,'review-transition:'+rid,digest)
        if prior is not None:response=prior
        else:
            r=get(conn,rid)
            if r['version']!=payload['version'] or r['status']!='pending':raise HTTPException(409,'复核已更新，请刷新。')
            if payload['status']=='timeout' and (not r['expires_at'] or r['expires_at']>service.utcnow().isoformat()):raise HTTPException(422,'复核尚未到期。')
            now=service.utcnow().isoformat();r.update(status=payload['status'],version=r['version']+1,updated_at=now,completed_at=now,close_reason=reason)
            conn.execute('UPDATE reviews SET status=?,version=?,updated_at=?,completed_at=?,close_reason=? WHERE review_id=?',(r['status'],r['version'],now,now,reason,rid))
            schedule(conn,r);response={'review':get(conn,rid)};service.save_receipt(conn,key,'review-transition:'+rid,digest,response)
    return finish(store,response)

def expire(store):
    with store.transaction() as conn:
        rows=[dict(r) for r in conn.execute("SELECT review_id,version FROM reviews WHERE status='pending' AND expires_at<=?",(service.utcnow().isoformat(),))]
    results=[]
    for r in rows:
        try:results.append(transition(store,r['review_id'],{'request_id':f"expire-{r['review_id']}-{r['version']}",'version':r['version'],'status':'timeout','reason':'已超过复核截止时间（工程默认期限或创建时指定期限）。'}))
        except HTTPException as error:
            if error.status_code!=409:raise
    return {'items':results,'total':len(results)}


def maintain(store):
    result=expire(store)
    with store.transaction() as conn:
        pending=[dict(r) for r in conn.execute('SELECT rr.review_id,rr.version FROM review_runs rr JOIN reviews r ON r.review_id=rr.review_id AND r.version=rr.version WHERE rr.run_id IS NULL')]
    for row in pending:
        try:rerun(store,row['review_id'],row['version'])
        except HTTPException as error:
            if error.status_code!=409:raise
    return result
