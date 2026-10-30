"""Stage04 acceptance: independent rounds, plans never complete tasks."""
from copy import deepcopy
import sqlite3
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app

@pytest.fixture
def ctx(tmp_path):
    app=create_app(tmp_path/'stage04.db',tmp_path/'uploads',False,False)
    with TestClient(app,raise_server_exceptions=False) as client:
        yield client,app.state.store

def prepare(client,scenario):
    response=client.post('/api/scenarios/'+scenario+'/prepare',json={'instance_id':'test-'+scenario,'request_id':'prepare-'+scenario})
    assert response.status_code==200,response.text
    return response.json()

def run(client,scenario,prepared,key,overrides=None):
    response=client.post('/api/runs',json={'scenario_id':scenario,'inspection_round_id':prepared['inspection_round_id'],
        'as_of':prepared['as_of'],'request_id':key,'input_overrides':overrides or {}})
    assert response.status_code==200,response.text
    return response.json()

def test_independent_s2_s3_and_time_override_preserve_s1(ctx):
    client,store=ctx
    s1=prepare(client,'S1');r1=run(client,'S1',s1,'r1')
    s2=prepare(client,'S2');r2=run(client,'S2',s2,'r2')
    s3=prepare(client,'S3');r3=run(client,'S3',s3,'r3')
    for result in (r2,r3):
        assert result['coverage']['covered']==5 and result['coverage']['missing']==['C07']
        assert [t['state'] for t in result['task_results']]==['blocked']+['established']*4
        assert any(b['task_id']=='T1' and b['point_ids']==['C07'] and b['evidence_refs'] for b in result['blockers'])
        access=next(e for e in result['evidence'] if e['evidence_type']=='zone_access' and e['zone_id']=='Z3')
        assert access['status']=='ok' and access['value_json']['access']=='DENIED'
    assert [p['state'] for p in r3['plan_results']]==['executable','not_executable','not_executable']
    assert [p['estimated_minutes'] for p in r3['plan_results']]==[25,20,55]
    changed=run(client,'S3',s3,'r3-change',{'remaining_minutes':15})
    assert all(p['state']=='not_executable' for p in changed['plan_results'])
    assert changed['task_results'][0]['state']=='blocked'
    for result in (r1,r2,r3):assert client.get('/api/runs/'+result['run_id']).json()==result
    assert len({s1['inspection_round_id'],s2['inspection_round_id'],s3['inspection_round_id']})==3
    assert client.get('/api/inspections',params={'inspection_round_id':s2['inspection_round_id'],'checkpoint_id':'C07'}).json()['total']==0
    ids={e['evidence_id'] for e in r3['evidence']}
    for plan in r3['plan_results']:
        for check in plan['checks']:assert set(check['evidence_refs'])<=ids
    with store.transaction() as db:
        assert db.execute('SELECT COUNT(*) FROM plan_results WHERE run_id=?',(r3['run_id'],)).fetchone()[0]==3
        assert db.execute('SELECT COUNT(*) FROM blockers WHERE run_id=?',(r2['run_id'],)).fetchone()[0]>0

@pytest.mark.parametrize('value',[-1,True,'15',None,100000])
def test_invalid_time_input_rejected(ctx,value):
    client,_=ctx;s3=prepare(client,'S3')
    response=client.post('/api/runs',json={'scenario_id':'S3','inspection_round_id':s3['inspection_round_id'],'as_of':s3['as_of'],'request_id':'bad','input_overrides':{'remaining_minutes':value}})
    assert response.status_code==422


def test_frozen_plan_children_and_retry(ctx):
    client,store=ctx;s3=prepare(client,'S3');saved=run(client,'S3',s3,'stable')
    assert run(client,'S3',s3,'stable')==saved
    for table in ('plan_results','blockers'):
        for sql in ('DELETE FROM '+table,'INSERT OR REPLACE INTO '+table+' SELECT * FROM '+table):
            with pytest.raises(sqlite3.DatabaseError),store.transaction(write=True) as db:db.execute(sql)
    assert client.get('/api/runs/'+saved['run_id']).json()==saved


def test_s3_missing_time_still_returns_three_unknown_plans(ctx):
    client,_=ctx;s3=prepare(client,'S3')
    s3['as_of']='2026-10-29T09:09:00+08:00'
    result=run(client,'S3',s3,'early')
    assert len(result['plan_results'])==3
    assert all(p['state']=='unknown' for p in result['plan_results'])

@pytest.mark.parametrize('mode',['error','expired','conflict','future_acquisition'])
def test_access_latest_invalid_evidence_cannot_reuse_old_denial(ctx,mode):
    from backend.judgment import evaluate
    client,store=ctx;s2=prepare(client,'S2');saved=run(client,'S2',s2,'access')
    proofs=deepcopy(saved['evidence'])
    old=next(e for e in proofs if e['evidence_type']=='zone_access' and e['zone_id']=='Z3')
    old['observed_at']=old['retrieved_at']='2026-10-29T01:05:00+00:00'
    newer={**deepcopy(old),'evidence_id':'latest-access','observed_at':'2026-10-29T01:10:00+00:00','retrieved_at':'2026-10-29T01:10:00+00:00'}
    if mode=='error':newer.update(status='error',value_json=None)
    if mode=='expired':newer['valid_until']='2026-10-29T01:09:00+00:00'
    if mode=='conflict':
        old['observed_at']=old['retrieved_at']=newer['observed_at'];newer['value_json']['access']='ALLOWED'
    if mode=='future_acquisition':
        proofs.remove(old);newer['retrieved_at']='2026-10-29T01:11:00+00:00'
    proofs.append(newer)
    with store.transaction() as db:records=[dict(r) for r in db.execute('SELECT * FROM inspection_records')]
    tasks=evaluate({'coverage':saved['coverage'],'evidence':proofs,'inspection_records':records,'reviews':saved['input_snapshot']['review_snapshot'],'as_of':saved['as_of']})
    access=next(c for c in tasks[0]['checks'] if c['dependency_id']=='T1.access')
    assert access['status']=='unknown' and access['point_ids']==[]
    if mode!='future_acquisition':assert 'latest-access' in access['evidence_refs']

def test_resource_permission_unknown_and_explicit_failure(ctx):
    client,_=ctx;s3=prepare(client,'S3')
    available=run(client,'S3',s3,'available',{'resources':{'P2':'AVAILABLE'}})
    assert available['plan_results'][1]['state']=='unknown'
    allowed=run(client,'S3',s3,'allowed',{'resources':{'P2':'AVAILABLE'},'p2_z3_access':'ALLOWED'})
    assert allowed['plan_results'][1]['state']=='executable'
    assert allowed['task_results'][0]['state']=='blocked'
    no_coordinator=run(client,'S3',s3,'no-coordinator',{'remaining_minutes':60,'resources':{'access_coordinator':'UNAVAILABLE'}})
    assert [p['state'] for p in no_coordinator['plan_results']]==['not_executable']*3
    unknown=run(client,'S3',s3,'unknown',{'resources':{'P1':None}})
    assert unknown['plan_results'][0]['state']=='unknown'
    assert unknown['plan_results'][1]['state']=='not_executable'
    assert all(e['value_json'] is None for e in unknown['evidence'] if e['evidence_type']=='resource_availability' and e['status']=='unavailable')


@pytest.mark.parametrize('mode',['error','expired','conflict','other_round','future','missing_expiry'])
def test_plan_evidence_freshness_and_scope(ctx,mode):
    from backend.feasibility import evaluate_plans
    from backend.planning import DEFINITIONS
    client,_=ctx;s3=prepare(client,'S3');saved=run(client,'S3',s3,'proof-scope')
    proofs=deepcopy(saved['evidence']);rid=saved['inspection_round_id']
    old=next(e for e in proofs if e['evidence_type']=='resource_availability' and e['value_json'] and e['value_json']['resource_id']=='P1')
    newest={**deepcopy(old),'evidence_id':'latest-p1','observed_at':'2026-10-29T01:11:00+00:00','retrieved_at':'2026-10-29T01:11:00+00:00'}
    if mode=='error':newest.update(status='error',value_json=None)
    if mode=='expired':newest['valid_until']='2026-10-29T01:10:30+00:00'
    if mode=='missing_expiry':newest['valid_until']=None
    if mode=='conflict':
        old['observed_at']=old['retrieved_at']=newest['observed_at'];newest['value_json']['availability']='UNAVAILABLE'
    if mode=='other_round':proofs.remove(old);newest['inspection_round_id']='another-round'
    if mode=='future':proofs.remove(old);newest['retrieved_at']='2026-10-29T01:12:00+00:00'
    proofs.append(newest)
    result=evaluate_plans(DEFINITIONS,proofs,rid,'2026-10-29T01:11:00+00:00')
    assert result[0]['state']=='unknown'
    assert result[1]['state']=='not_executable' # explicit P2 unavailability dominates unknown
    assert result[2]['state']=='not_executable' # explicit insufficient time dominates unknown

@pytest.mark.parametrize('minutes',[25,24.9,0])
def test_plan_time_boundary(ctx,minutes):
    client,_=ctx;s3=prepare(client,'S3')
    saved=run(client,'S3',s3,'boundary',{'remaining_minutes':minutes})
    assert saved['plan_results'][0]['state']==('executable' if minutes>=25 else 'not_executable')
    assert saved['task_results'][0]['state']=='blocked'


@pytest.mark.parametrize('override',[{'remaining_minutes':0},{'p2_z3_access':None},{'resources':{}}])
def test_falsy_teaching_overrides_rejected_on_ordinary_round(ctx,override):
    client,store=ctx
    assert client.post('/api/rounds',json={'round_id':'real-round','date':'2026-10-29'}).status_code==200
    response=client.post('/api/runs',json={'inspection_round_id':'real-round','as_of':'2026-10-29T09:10:00+08:00','request_id':'forbidden','input_overrides':override})
    assert response.status_code==422
    with store.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM evidence WHERE source_type='SIMULATED'").fetchone()[0]==0
