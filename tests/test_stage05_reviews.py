from datetime import datetime, timezone, timedelta
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app

@pytest.fixture
def ctx(tmp_path):
    app=create_app(tmp_path/'db.sqlite',tmp_path/'uploads',False,False)
    with TestClient(app) as c:
        yield c,app.state.store

def setup(c):
    p=c.post('/api/scenarios/S1/prepare',json={'instance_id':'s05','request_id':'prep'}).json()
    r=c.post('/api/runs',json={'inspection_round_id':p['inspection_round_id'],'scenario_id':'S1','as_of':p['as_of'],'request_id':'run'}).json()
    q=c.post('/api/reviews',json={'point_id':'C03','reason':'现场确认','trigger_run_id':r['run_id'],'task_id':'T2','request_id':'review'})
    assert q.status_code==200,q.text
    return p,r,q.json()['review']

def submit(c,p,q,conclusion='normal',**changes):
    data=dict(point_id='C03',inspection_round_id=p['inspection_round_id'],inspector_id='tester',inspected_at=datetime.now(timezone.utc).isoformat(),result={'normal':'ok','fault':'alarm','unknown':'unknown'}[conclusion],notes='现场实际核验',onsite_confirmed='true',conclusion=conclusion,version=str(q['version']),request_id='proof')
    data.update(changes)
    return c.post('/api/reviews/'+q['review_id']+'/evidence',data=data)

def test_roundtrip_and_frozen_run(ctx):
    c,s=ctx;p,old,q=setup(c)
    assert q['facility_id'] and q['inspection_round_id']==p['inspection_round_id']
    assert any(x['review_id']==q['review_id'] for x in c.get('/api/reviews?status=pending').json()['items'])
    response=submit(c,p,q);assert response.status_code==200,response.text
    result=response.json();assert result['review']['status']=='completed'
    assert result['rerun']['status']=='completed'
    new=c.get('/api/runs/'+result['rerun']['run_id']).json()
    assert new['as_of']>=result['created_at']
    assert new['coverage']['covered']==old['coverage']['covered']
    assert c.get('/api/runs/'+old['run_id']).json()==old
    detail=c.get('/api/reviews/'+q['review_id']).json()
    assert any(e['evidence_type']=='review_confirmation' for e in detail['evidence'])
    assert new['task_results'][3]['state']=='established'

def test_unknown_and_validation(ctx):
    c,s=ctx;p,old,q=setup(c)
    assert submit(c,p,q,inspected_at=old['as_of']).status_code==422
    r=submit(c,p,q,'unknown');assert r.status_code==200,r.text
    assert r.json()['review']['status']=='pending'
    new=c.get('/api/runs/'+r.json()['rerun']['run_id']).json()
    assert new['task_results'][1]['state']!='established'

def test_cancel_version_and_no_get_writes(ctx):
    c,s=ctx;p,old,q=setup(c)
    payload={'version':q['version'],'status':'cancelled','reason':'现场暂不可达','request_id':'cancel'}
    url='/api/reviews/'+q['review_id']+'/transition'
    r=c.post(url,json=payload);assert r.status_code==200,r.text
    assert r.json()['review']['status']=='cancelled'
    assert c.post(url,json=payload).json()==r.json()
    assert submit(c,p,q).status_code==409
    new=c.get('/api/runs/'+r.json()['rerun']['run_id']).json()
    assert new['task_results'][3]['state']!='pending_verification'

def test_idempotency_cross_scope_and_retry(ctx,monkeypatch):
    from backend import runs
    c,s=ctx;p,old,q=setup(c)
    assert submit(c,p,q,point_id='C04').status_code==422
    assert submit(c,p,q,inspection_round_id='wrong').status_code==422
    real=runs.create
    def failure(*args,**kwargs):raise OSError('temporary offline')
    monkeypatch.setattr(runs,'create',failure)
    at=datetime.now(timezone.utc).isoformat()
    r=submit(c,p,q,inspected_at=at);assert r.status_code==200,r.text
    assert r.json()['rerun']['status']=='failed'
    monkeypatch.setattr(runs,'create',real)
    repeated=submit(c,p,q,inspected_at=at).json()
    assert repeated['record_id']==r.json()['record_id']
    assert repeated['rerun']['status']=='completed'
    assert submit(c,p,q,inspected_at=at).json()==repeated

def test_timeout_and_unknown_version_retry(ctx,monkeypatch):
    from backend import reviews,runs
    c,s=ctx;p,old,q=setup(c)
    real=runs.create
    monkeypatch.setattr(runs,'create',lambda *a,**kw: (_ for _ in ()).throw(OSError('offline')))
    response=submit(c,p,q,'unknown').json()
    assert response['review']['version']==2
    # Old failed scheduling cannot reinterpret new mutable review versions.
    with s.transaction(write=True) as conn:
        conn.execute('UPDATE reviews SET version=3 WHERE review_id=?',(q['review_id'],))
    stale=c.post('/api/reviews/'+q['review_id']+'/rerun',json={'version':2})
    response['review']['version']=3
    assert stale.status_code==409,stale.text
    monkeypatch.setattr(runs,'create',real)
    with s.transaction(write=True) as conn:
        conn.execute('UPDATE reviews SET expires_at=? WHERE review_id=?',((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(),q['review_id']))
    assert submit(c,p,response['review'],request_id='later').status_code==409
    expired=c.post('/api/reviews/expire').json()
    assert expired['total']==1
    detail=c.get('/api/reviews/'+q['review_id']).json()['review']
    assert detail['status']=='timeout' and detail['close_reason']

def test_completed_window_and_confirmation_expiry(ctx):
    from backend import runs
    c,s=ctx;p,old,q=setup(c)
    r=submit(c,p,q).json();new=c.get('/api/runs/'+r['rerun']['run_id']).json()
    assert new['task_results'][0]['state']=='established'
    proof=next(e for e in new['evidence'] if e['evidence_type']=='review_confirmation' and e['review_id']==q['review_id'])
    assert proof['valid_until']>proof['observed_at']
    from backend.judgment import evaluate
    snapshot={'coverage':new['coverage'],'evidence':new['evidence'],'reviews':new['input_snapshot']['review_snapshot'],'inspection_records':[],'as_of':(datetime.fromisoformat(proof['valid_until'])+timedelta(seconds=1)).isoformat()}
    assert evaluate(snapshot)[1]['state']=='unknown'

def test_cancel_recreate_restores_t4_and_new_abnormal_in_list(ctx):
    c,s=ctx;p,old,q=setup(c)
    result=c.post('/api/reviews/'+q['review_id']+'/transition',json={'request_id':'close','version':1,'status':'cancelled','reason':'需重新安排'});assert result.status_code==200,result.text
    q2=c.post('/api/reviews',json={'point_id':'C03','reason':'重新核验','trigger_run_id':old['run_id'],'task_id':'T2','request_id':'reopen'}).json()['review']
    result=submit(c,p,q2,'fault').json()
    new=c.get('/api/runs/'+result['rerun']['run_id']).json()
    assert new['task_results'][3]['state']=='established'
    q3=c.post('/api/reviews',json={'point_id':'C01','reason':'新发现异常','trigger_run_id':new['run_id'],'task_id':'T2','request_id':'new-point'}).json()['review']
    result=submit(c,p,q3,'fault',point_id='C01',request_id='new-proof').json()
    newest=c.get('/api/runs/'+result['rerun']['run_id']).json()
    assert 'C01' in newest['statistics']['anomaly_points']

def test_failed_rerun_freezes_snapshot(ctx,monkeypatch):
    from backend import runs
    c,s=ctx;p,old,q=setup(c)
    real=runs.create
    monkeypatch.setattr(runs,'create',lambda *a,**kw: (_ for _ in ()).throw(OSError('offline')))
    saved=submit(c,p,q).json()
    with s.transaction(write=True) as conn:
        conn.execute("UPDATE reviews SET reason='changed-after-queue' WHERE review_id=?",(q['review_id'],))
    monkeypatch.setattr(runs,'create',real)
    retried=c.post('/api/reviews/'+q['review_id']+'/rerun',json={'version':2}).json()
    result=c.get('/api/runs/'+retried['rerun']['run_id']).json()
    assert next(r for r in result['input_snapshot']['review_snapshot'] if r['review_id']==q['review_id'])['reason']!='changed-after-queue'

def test_valid_confirmation_survives_later_acquisition_failure(ctx):
    from copy import deepcopy
    from backend.judgment import evaluate
    c,s=ctx;p,old,q=setup(c)
    saved=submit(c,p,q).json();new=c.get('/api/runs/'+saved['rerun']['run_id']).json()
    confirmation=next(e for e in new['evidence'] if e['evidence_id']==saved['confirmation_evidence_id'])
    after=(datetime.fromisoformat(confirmation['observed_at'])+timedelta(seconds=1)).isoformat()
    snapshot={'coverage':new['coverage'],'evidence':deepcopy(new['evidence']),'reviews':new['input_snapshot']['review_snapshot'],'inspection_records':[],'as_of':after}
    anomaly=next(e for e in snapshot['evidence'] if e['evidence_type']=='anomaly_list')
    anomaly['value_json']['checkpoint_ids']=['C03']
    failure={**confirmation,'evidence_id':'later-failure','evidence_type':'remote_status','source_type':'DEVICE','source_id':'test-device','observed_at':after,'retrieved_at':after,'status':'unavailable','value_json':None}
    snapshot['evidence'].append(failure)
    assert evaluate(snapshot)[1]['state']=='established'
    failure.update(status='ok',value_json={'condition':'NORMAL'})
    assert evaluate(snapshot)[1]['state']=='established'
    failure['value_json']={'condition':'FAULT'}
    assert evaluate(snapshot)[1]['state']=='unknown'
    failure.update(status='unavailable',value_json=None)
    snapshot['as_of']=(datetime.fromisoformat(confirmation['valid_until'])+timedelta(seconds=1)).isoformat()
    assert evaluate(snapshot)[1]['state']=='unknown'
