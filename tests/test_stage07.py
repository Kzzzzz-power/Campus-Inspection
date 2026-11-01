from datetime import datetime, timezone
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app

@pytest.fixture
def ctx(tmp_path):
    app=create_app(tmp_path/'db.sqlite',tmp_path/'uploads',False,False)
    with TestClient(app) as c: yield c,app.state.store

def prepare(c,scenario='S3',instance='stage07'):
    p=c.post('/api/scenarios/'+scenario+'/prepare',json={'instance_id':instance,'request_id':'prep-'+instance})
    assert p.status_code==200,p.text
    return p.json()

def run(c,p,key='run',**extra):
    r=c.post('/api/runs',json={'request_id':key,'scenario_id':p['scenario_id'],'inspection_round_id':p['inspection_round_id'],'as_of':p['as_of'],**extra})
    assert r.status_code==200,r.text
    return r.json()

@pytest.mark.parametrize('assumptions,states',[
    ({'resources':{'P2':'AVAILABLE'},'p2_z3_access':'ALLOWED'},['executable','executable','not_executable']),
    ({'remaining_minutes':60,'resources':{'access_coordinator':'AVAILABLE'}},['executable','not_executable','executable']),
    ({'resources':{'access_coordinator':'UNAVAILABLE'}},['not_executable','not_executable','not_executable'])])
def test_whatif_matrix_and_immutable_parent(ctx,assumptions,states):
    c,s=ctx;p=prepare(c);parent=run(c,p)
    payload={'request_id':'whatif','scenario_id':'S4','run_type':'what_if','parent_run_id':parent['run_id'],'assumptions':assumptions,'input_overrides':{}}
    r=c.post('/api/runs',json=payload);assert r.status_code==200,r.text
    child=r.json()
    assert [x['state'] for x in child['plan_results']]==states
    assert child['task_results']==parent['task_results']
    assert child['parent_run_id']==parent['run_id'] and child['run_id']!=parent['run_id']
    assert c.post('/api/runs',json=payload).json()==child
    assert c.get('/api/runs/'+parent['run_id']).json()==parent
    assert c.get('/api/dashboard',params={'run_id':child['run_id']}).status_code==422
    assert run(c,p,'after')['plan_results']==parent['plan_results']

def test_whatif_rejects_input_and_non_parent(ctx):
    c,s=ctx;p=prepare(c);parent=run(c,p)
    base={'request_id':'w','scenario_id':'S4','run_type':'what_if','parent_run_id':parent['run_id'],'input_overrides':{},'assumptions':{}}
    for change in ({'input_overrides':{'remaining_minutes':60}},{'assumptions':{'zone_access':[]}},{'parent_run_id':'missing'}):
        assert c.post('/api/runs',json={**base,**change}).status_code in (404,422)

def test_s5_degrades_and_actual_review_recovers(ctx):
    c,s=ctx;p=prepare(c,'S5');old=run(c,p)
    assert [t['state'] for t in old['task_results']]==['established','unknown','established','pending_verification','established']
    proof=next(e for e in old['evidence'] if e['evidence_type']=='current_status')
    assert proof['status']=='unavailable' and proof['value_json'] is None
    q=next(r for r in old['input_snapshot']['review_snapshot'] if r['status']=='pending')
    assert q['trigger_run_id']==old['run_id']
    assert len([r for r in run(c,p,'repeat')['input_snapshot']['review_snapshot'] if r['status']=='pending'])==1
    now=datetime.now(timezone.utc).isoformat()
    response=c.post('/api/reviews/'+q['review_id']+'/evidence',data=dict(point_id='C03',inspection_round_id=p['inspection_round_id'],inspector_id='tester',inspected_at=now,result='ok',notes='现场核验设备',onsite_confirmed='true',conclusion='normal',version=str(q['version']),request_id='actual-proof'))
    assert response.status_code==200,response.text
    assert response.json()['rerun']['status']=='completed',response.text
    new=c.get('/api/runs/'+response.json()['rerun']['run_id']).json()
    assert new['task_results'][1]['state']=='established'
    assert new['task_results'][3]['state']=='established'
    assert c.get('/api/runs/'+old['run_id']).json()==old

def test_s5_closed_review_and_query_recovery(ctx):
    c,s=ctx;p=prepare(c,'S5');old=run(c,p)
    q=next(r for r in old['input_snapshot']['review_snapshot'] if r['status']=='pending')
    response=c.post('/api/reviews/'+q['review_id']+'/transition',json={'request_id':'cancel','version':q['version'],'status':'cancelled','reason':'现场无法进入'})
    assert response.status_code==200,response.text
    new=c.get('/api/runs/'+response.json()['rerun']['run_id']).json()
    assert new['task_results'][3]['state']=='unknown'
    again=run(c,p,'query-only',input_overrides={'current_status_available':True})
    assert again['task_results'][1]['state']=='unknown'
    assert not any(r['status']=='pending' for r in again['input_snapshot']['review_snapshot'])

def test_s5_analysis_keeps_frozen_review_and_ttl(ctx,monkeypatch):
    from backend import analysis
    c,s=ctx;p=prepare(c,'S5');old=run(c,p)
    q=next(r for r in old['input_snapshot']['review_snapshot'] if r['status']=='pending')
    for name in ('weather','rag','ml','llm'):
        monkeypatch.setattr(analysis,name,lambda *a,**k:{'status':'ok','provider':'test-only','value':{'test_only':True},'error':None})
    r=c.post('/api/analyses',json={'request_id':'analyze','source_run_id':old['run_id'],'question':'当前 C03 能确认吗？'})
    assert r.status_code==202,r.text
    new=c.get('/api/runs/'+r.json()['run_id']).json()
    assert new['as_of']==old['as_of']
    assert new['input_snapshot']['review_snapshot']==old['input_snapshot']['review_snapshot']
    assert [t['state'] for t in new['task_results']]==[t['state'] for t in old['task_results']]
    assert any('C03' in x for x in new['task_results'][4]['limitations'])
    assert any('C03' in x for x in new['analysis']['limitations'])
    with s.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM reviews WHERE inspection_round_id=? AND task_id='T2'",(p['inspection_round_id'],)).fetchone()[0]==1
    assert next(e for e in new['evidence'] if e['evidence_type']=='current_status')['valid_until']==next(e for e in old['evidence'] if e['evidence_type']=='current_status')['valid_until']


def test_s5_query_boolean_contract_and_s1_history(ctx):
    c,s=ctx;p1=prepare(c,'S1','baseline');baseline=run(c,p1,'baseline')
    p=prepare(c,'S5','degraded');old=run(c,p,'degraded')
    for available in (True,False):
        new=run(c,p,'available-'+str(available),input_overrides={'current_status_available':available})
        proof=max((e for e in new['evidence'] if e['evidence_type']=='current_status'),key=lambda e:e['observed_at'])
        assert proof['status']==('ok' if available else 'unavailable')
        assert new['task_results'][1]['state']=='unknown'
    assert c.post('/api/runs',json={'request_id':'bad','scenario_id':'S1','inspection_round_id':p1['inspection_round_id'],'as_of':p1['as_of'],'input_overrides':{'current_status_available':True}}).status_code==422
    assert c.get('/api/runs/'+baseline['run_id']).json()==baseline


def test_whatif_does_not_see_new_round_facts(ctx):
    from backend import evidence as ev
    c,s=ctx;p=prepare(c);parent=run(c,p)
    with s.transaction(write=True) as db:
        later=ev.add(db,'resource_availability','SIMULATED','late-edit',parent['as_of'],{'resource_id':'P2','availability':'AVAILABLE'},inspection_round_id=p['inspection_round_id'],retrieved_at=parent['as_of'],provenance={'subject':{'resource_id':'P2'}})
    r=c.post('/api/runs',json={'request_id':'isolated','scenario_id':'S4','run_type':'what_if','parent_run_id':parent['run_id'],'assumptions':{},'input_overrides':{}})
    assert r.status_code==200,r.text
    assert later['evidence_id'] not in {e['evidence_id'] for e in r.json()['evidence']}
    assert r.json()['plan_results']==parent['plan_results']
    with s.transaction() as db:
        assert db.execute('SELECT COUNT(*) FROM inspection_records').fetchone()[0]==len(parent['source_watermark']['inspection_ids'])

def test_whatif_references_and_plan_definitions_frozen(ctx,monkeypatch):
    from backend import planning
    c,s=ctx;p=prepare(c);parent=run(c,p)
    monkeypatch.setattr(planning,'DEFINITIONS',[])
    monkeypatch.setattr(planning,'PLAN_VERSION','future-version')
    child=c.post('/api/runs',json={'request_id':'frozen-defs','scenario_id':'S4','run_type':'what_if','parent_run_id':parent['run_id'],'assumptions':{'resources':{'P2':'AVAILABLE'},'p2_z3_access':'ALLOWED'},'input_overrides':{}})
    assert child.status_code==200,child.text
    child=child.json()
    assert len(child['plan_results'])==3
    assert child['input_snapshot']['plan_definitions']==parent['input_snapshot']['plan_definitions']
    ids={e['evidence_id'] for e in child['evidence']}
    for item in child['task_results']+child['plan_results']:
        for check in item['checks']:assert set(check['evidence_refs'])<=ids
    for blocker in child['blockers']:assert set(blocker['evidence_refs'])<=ids
    assert child['source_watermark']['assumption_evidence_ids']


def test_s5_valid_confirmation_ttl_not_downgraded_by_current_failure(ctx):
    from copy import deepcopy
    from datetime import timedelta
    from backend.judgment import evaluate
    c,s=ctx;p=prepare(c,'S5');old=run(c,p)
    proofs=deepcopy(old['evidence'])
    confirmation=next(e for e in proofs if e['evidence_type']=='review_confirmation')
    confirmation['valid_until']=(datetime.fromisoformat(old['as_of'])+timedelta(hours=1)).isoformat()
    result=evaluate({'coverage':old['coverage'],'evidence':proofs,'reviews':old['input_snapshot']['review_snapshot'],'inspection_records':[],'as_of':old['as_of']})
    assert result[1]['state']=='established'


def test_s5_structured_llm_context_carries_limit(ctx):
    from backend.analysis_llm import context
    c,s=ctx;p=prepare(c,'S5');old=run(c,p)
    output=context(old,[])
    assert any('C03' in x for x in output['limitations'])

def test_s5_timeout_does_not_reopen_and_override_validation(ctx):
    from datetime import timedelta
    c,s=ctx;p=prepare(c,'S5');old=run(c,p)
    q=next(r for r in old['input_snapshot']['review_snapshot'] if r['status']=='pending')
    with s.transaction(write=True) as db:
        db.execute('UPDATE reviews SET expires_at=? WHERE review_id=?',((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(),q['review_id']))
    response=c.post('/api/reviews/'+q['review_id']+'/transition',json={'request_id':'timeout','version':q['version'],'status':'timeout','reason':'期限结束'})
    assert response.status_code==200,response.text
    new=run(c,p,'after-timeout')
    assert new['task_results'][1]['state']=='unknown'
    assert new['task_results'][3]['state']=='unknown'
    assert not any(r['status']=='pending' for r in new['input_snapshot']['review_snapshot'])
    assert c.get('/api/runs/'+old['run_id']).json()==old
    for value in ('true',1,None,{}):
        assert c.post('/api/runs',json={'request_id':'bad-input','scenario_id':'S5','inspection_round_id':p['inspection_round_id'],'as_of':p['as_of'],'input_overrides':{'current_status_available':value}}).status_code==422

def test_multiple_s5_instances_and_legacy_pending_are_isolated(ctx):
    c,s=ctx
    legacy=c.post('/api/reviews',json={'point_id':'C03','reason':'真实复核','request_id':'legacy'})
    assert legacy.status_code==200,legacy.text
    # Reproduce an existing database with the former global-only pending index.
    with s.transaction(write=True) as db:
        legacy_before=dict(db.execute('SELECT * FROM reviews WHERE review_id=?',(legacy.json()['review']['review_id'],)).fetchone())
        db.execute('DROP INDEX one_pending_review')
        db.execute('DROP INDEX one_pending_teaching_review')
        db.execute("CREATE UNIQUE INDEX one_pending_review ON reviews(point_id) WHERE status='pending'")
    s.initialize(False)
    with s.transaction() as db:
        assert dict(db.execute('SELECT * FROM reviews WHERE review_id=?',(legacy.json()['review']['review_id'],)).fetchone())==legacy_before
    runs=[]
    for name in ('one','two'):
        p=prepare(c,'S5',name);runs.append(run(c,p,'run-'+name))
    assert all(r['task_results'][3]['state']=='pending_verification' for r in runs)
    assert len({r['inspection_round_id'] for r in runs})==2
    assert c.post('/api/reviews',json={'point_id':'C03','reason':'重复真实复核','request_id':'legacy-duplicate'}).status_code==409
    for r in runs:
        assert c.post('/api/reviews',json={'point_id':'C03','reason':'同轮次重复','request_id':'dup-'+r['run_id'],'task_id':'T2','trigger_run_id':r['run_id']}).status_code==409
    # Migration/reopen must preserve all three active requests and frozen histories.
    s.initialize(False)
    with s.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM reviews WHERE point_id='C03' AND status='pending'").fetchone()[0]==3
    for r in runs:assert c.get('/api/runs/'+r['run_id']).json()==r


def test_valid_confirmation_before_s5_first_run_needs_no_new_review(ctx):
    from datetime import timedelta
    from backend import evidence as ev
    c,s=ctx;p=prepare(c,'S5')
    with s.transaction(write=True) as db:
        old=ev.decode(db.execute("SELECT * FROM evidence WHERE inspection_round_id=? AND evidence_type='review_confirmation'",(p['inspection_round_id'],)).fetchone())
        ev.add(db,'review_confirmation','SIMULATED','test-confirmation',ev.now(),old['value_json'],inspection_round_id=p['inspection_round_id'],checkpoint_id='C03',facility_id='ap-2f',zone_id='Z1',valid_until=(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat(),provenance={'fixture':'test-valid-confirmation'})
    result=run(c,p)
    assert result['task_results'][1]['state']=='established'
    assert result['task_results'][3]['state']=='established'
    assert not any(r['status']=='pending' for r in result['input_snapshot']['review_snapshot'])


@pytest.mark.parametrize('invalid',[False,True])
def test_whatif_never_expires_real_reviews(ctx,invalid):
    from datetime import timedelta
    c,s=ctx;parent=run(c,prepare(c,'S3','parent'))
    old=run(c,prepare(c,'S5','review-round'),'s5')
    q=next(r for r in old['input_snapshot']['review_snapshot'] if r['status']=='pending')
    with s.transaction(write=True) as db:
        db.execute('UPDATE reviews SET expires_at=? WHERE review_id=?',((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(),q['review_id']))
    with s.transaction() as db:
        before=dict(db.execute('SELECT * FROM reviews WHERE review_id=?',(q['review_id'],)).fetchone())
        count=db.execute("SELECT COUNT(*) FROM runs WHERE run_type='reality'").fetchone()[0]
    payload={'request_id':'w','scenario_id':'S4','run_type':'what_if','parent_run_id':parent['run_id'],'assumptions':{},'input_overrides':{}}
    if invalid:payload['input_overrides']={'remaining_minutes':60}
    result=c.post('/api/runs',json=payload)
    assert result.status_code==(422 if invalid else 200),result.text
    with s.transaction() as db:
        assert dict(db.execute('SELECT * FROM reviews WHERE review_id=?',(q['review_id'],)).fetchone())==before
        assert db.execute("SELECT COUNT(*) FROM runs WHERE run_type='reality'").fetchone()[0]==count
    assert c.get('/api/runs/'+parent['run_id']).json()==parent
