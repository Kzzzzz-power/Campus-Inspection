"""Stage03 acceptance beyond coverage: immutable runs, proof lineage and failure boundaries."""
from copy import deepcopy
from datetime import datetime, timezone
import sqlite3
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app
from backend import service, evidence
from backend.judgment import evaluate, check, task_result

@pytest.fixture
def context(tmp_path):
    app=create_app(tmp_path/'stage03.db',tmp_path/'photos',False,False)
    with TestClient(app,raise_server_exceptions=False) as client:
        prepared=client.post('/api/scenarios/S1/prepare',json={'instance_id':'unit','request_id':'prepare'}).json()
        payload={'inspection_round_id':prepared['inspection_round_id'],'as_of':prepared['as_of'],'scenario_id':'S1','request_id':'run'}
        yield client,app.state.store,payload

def execute(context,**changes):
    client,store,payload=context
    response=client.post('/api/runs',json={**payload,**changes})
    assert response.status_code==200,response.text
    return response.json()

def state(run,task):
    return next(t['state'] for t in run['task_results'] if t['task_id']==task)

def test_s1_is_derived_and_references_are_resolvable(context):
    run=execute(context)
    assert [t['state'] for t in run['task_results']]==['established']*5
    ids={e['evidence_id'] for e in run['evidence']}
    for task in run['task_results']:
        for dependency in task['checks']:
            assert dependency['evidence_refs'] and set(dependency['evidence_refs'])<=ids
    assert run['statistics']['duration_seconds'] is None
    assert run['statistics']['limitations']
    assert any(e['source_type']=='SIMULATED' and e['value_json'].get('condition')=='WARNING' for e in run['evidence'] if isinstance(e['value_json'],dict))

@pytest.mark.parametrize('conclusion',['confirmed_abnormal','ruled_out'])
def test_t2_confirmation_means_confirmation_task_not_normal_facility(context,conclusion):
    run=execute(context)
    target=next(e for e in run['evidence'] if e['evidence_type']=='review_confirmation')
    target['value_json']['conclusion']=conclusion
    snapshot={'coverage':run['coverage'],'evidence':run['evidence'],'reviews':run['input_snapshot']['review_snapshot'],
              'inspection_records':[{'inspection_id':'unit'}],'as_of':run['as_of']}
    assert state({'task_results':evaluate(snapshot)},'T2')=='established'

def test_new_pending_review_is_included_before_any_field_evidence(context,monkeypatch):
    client,store,payload=context
    first=execute(context)
    monkeypatch.setattr(service,'utcnow',lambda:datetime.fromisoformat('2026-10-29T09:09:30+08:00').astimezone(timezone.utc))
    response=client.post('/api/reviews',json={'point_id':'C07','reason':'等待新的现场补证','request_id':'new-review','trigger_run_id':first['run_id']})
    assert response.status_code==200,response.text
    second=execute(context,request_id='pending-run')
    assert state(second,'T4')=='pending_verification'
    assert second['statistics']['pending_review_count']==1
    assert client.get('/api/runs/'+first['run_id']).json()==first


def test_manual_save_retry_conflict_validation_and_no_old_run_mutation(context):
    client,store,payload=context
    run=execute(context)
    manual={'request_id':'manual','inspection_round_id':payload['inspection_round_id'],'checkpoint_id':'C03',
            'inspector_id':'P1','observed_at':'2026-10-29T09:09:30+08:00','evidence_type':'field_note','status':'ok',
            'review_id':'S1.unit.S1-REVIEW-C03','notes':'现场说明','value_json':{'notes':'现场说明'}}
    response=client.post('/api/evidence/manual',json=manual)
    assert response.status_code==200,response.text
    assert client.post('/api/evidence/manual',json=manual).json()==response.json()
    assert client.post('/api/evidence/manual',json={**manual,'notes':'changed'}).status_code==409
    assert client.post('/api/evidence/manual',json={**manual,'request_id':'forged','evidence_type':'sqlite_write'}).status_code==422
    assert client.post('/api/evidence/manual',json={**manual,'request_id':'wrong-point','checkpoint_id':'C07'}).status_code==422
    assert client.post('/api/evidence/manual',json={**manual,'request_id':'unavailable','status':'unavailable'}).status_code==422
    assert client.get('/api/runs/'+run['run_id']).json()==run


def test_run_write_failure_never_reports_completed_or_consumes_request(context):
    client,store,payload=context
    with store.transaction(write=True) as conn:
        conn.execute("CREATE TRIGGER reject_tasks BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT,'test write failure'); END")
    assert client.post('/api/runs',json=payload).status_code==503
    with store.transaction(write=True) as conn:
        assert conn.execute('SELECT COUNT(*) FROM runs').fetchone()[0]==0
        assert conn.execute("SELECT 1 FROM request_receipts WHERE request_id='run'").fetchone() is None
        conn.execute('DROP TRIGGER reject_tasks')
    assert execute(context)['status']=='completed'


def test_no_manual_channel_proof_is_not_claimed_success(context):
    run=execute(context)
    snapshot={'coverage':run['coverage'],'evidence':[e for e in run['evidence'] if e['evidence_type']!='review_channel'],
              'reviews':run['input_snapshot']['review_snapshot'],'inspection_records':[{'inspection_id':'unit'}],'as_of':run['as_of']}
    assert state({'task_results':evaluate(snapshot)},'T4')=='unknown'


def test_no_delay_samples_remain_unknown(context):
    run=execute(context)
    target=next(e for e in run['evidence'] if e['evidence_type']=='aggregation');target['value_json']['lag_seconds']=None
    snapshot={'coverage':run['coverage'],'evidence':run['evidence'],'reviews':run['input_snapshot']['review_snapshot'],
              'inspection_records':[{'inspection_id':'unit'}],'as_of':run['as_of']}
    # An absent measurement cannot be proof of a zero-delay healthy path.
    assert state({'task_results':evaluate(snapshot)},'T3')=='unknown'


def test_terminal_and_fact_replace_are_rejected(context):
    client,store,payload=context
    run=execute(context)
    with store.transaction(write=True) as conn:
        conn.execute("INSERT INTO legacy_runs VALUES ('legacy','2020-01-01','original')")
        conn.execute("INSERT INTO run_snapshots VALUES ('legacy','{}')")
    for sql in ["INSERT OR REPLACE INTO run_snapshots VALUES ('legacy','{\"changed\":true}')",
                "INSERT OR REPLACE INTO legacy_runs VALUES ('legacy','2020-01-01','changed')",
                "UPDATE runs SET status='running'",
                "DELETE FROM dependency_checks",
                "INSERT OR REPLACE INTO inspection_records SELECT 'changed',inspection_round_id,checkpoint_id,facility_id,zone_id,inspector_id,inspected_at,method,result,notes,created_at,legacy_record_id,raw_result,origin,result_semantics,started_at,duration_seconds,source_type,request_id,supersedes_id FROM inspection_records LIMIT 1"]:
        with pytest.raises(sqlite3.DatabaseError),store.transaction(write=True) as conn:
            conn.execute(sql)
    assert client.get('/api/runs/'+run['run_id']).json()==run


def test_explicit_state_precedence():
    pending=check('T4','a','unknown','等待动作证据',missing_kind='post_action_proof')
    unknown=check('T4','b','unknown','缺少现实证据',missing_kind='reality')
    failed=check('T4','c','unsatisfied','明确失败')
    assert task_result('T4',[pending])['state']=='pending_verification'
    assert task_result('T4',[pending,unknown])['state']=='unknown'
    assert task_result('T4',[pending,unknown,failed])['state']=='blocked'


def test_manual_evidence_cannot_attach_another_rounds_review(context):
    client,store,payload=context
    other=client.post('/api/scenarios/S1/prepare',json={'instance_id':'other','request_id':'other-prepare'}).json()
    body={'request_id':'cross-round','inspection_round_id':other['inspection_round_id'],'checkpoint_id':'C03',
          'inspector_id':'P1','observed_at':'2026-10-29T09:09:30+08:00','evidence_type':'field_note','status':'ok',
          'review_id':'S1.unit.S1-REVIEW-C03','notes':'错误轮次','value_json':{'notes':'错误轮次'}}
    assert client.post('/api/evidence/manual',json=body).status_code==422


def test_catalog_drift_does_not_reinterpret_existing_round(context,monkeypatch):
    from backend import runs
    client,store,payload=context
    saved=execute(context)
    monkeypatch.setattr(runs,'CONFIG_HASH','changed-config',raising=False)
    assert client.post('/api/runs',json={**payload,'request_id':'after-drift'}).status_code==409
    assert client.get('/api/dashboard',params={'inspection_round_id':payload['inspection_round_id'],'as_of':payload['as_of']}).status_code==409
    assert client.get('/api/runs/'+saved['run_id']).json()==saved


def test_replace_using_existing_run_request_is_rejected_without_foreign_keys(context):
    client,store,payload=context
    saved=execute(context)
    conn=sqlite3.connect(store.path)
    try:
        row=conn.execute('SELECT * FROM runs WHERE run_id=?',(saved['run_id'],)).fetchone()
        with pytest.raises(sqlite3.DatabaseError):
            conn.execute('INSERT OR REPLACE INTO runs VALUES ('+','.join('?' for _ in row)+')',('different-id',*row[1:]))
        conn.rollback()
    finally:
        conn.close()
    assert client.get('/api/runs/'+saved['run_id']).json()==saved


@pytest.mark.parametrize('result',['WARNING','FAULT'])
def test_precise_multipart_abnormal_record_counts_as_coverage(context,result):
    client,store,payload=context
    client.post('/api/rounds',json={'round_id':'precise','date':'2026-10-29'})
    response=client.post('/api/inspections',data={'point_id':'C01','inspection_round_id':'precise','inspector_id':'P1',
        'inspected_at':'2026-10-29T09:05:00+08:00','result':result,'notes':'现场异常也属于已巡检',
        'onsite_confirmed':'true','request_id':'precise-'+result})
    assert response.status_code==200,response.text
    rows=client.get('/api/inspections',params={'inspection_round_id':'precise'}).json()['items']
    assert rows[0]['result']==result
    data=client.get('/api/dashboard',params={'inspection_round_id':'precise','as_of':'2026-10-29T09:10:00+08:00'}).json()
    assert data['covered']==1


def test_legacy_review_upload_inherits_scope_and_rejects_cross_round(context,monkeypatch):
    client,store,payload=context
    run=execute(context)
    monkeypatch.setattr(service,'utcnow',lambda:datetime.fromisoformat('2026-10-29T09:10:00+08:00').astimezone(timezone.utc))
    review=client.post('/api/reviews',json={'point_id':'C07','reason':'scope test','request_id':'scoped-review','trigger_run_id':run['run_id']}).json()['review']
    client.post('/api/rounds',json={'round_id':'wrong-scope','date':'2026-10-29'})
    form={'point_id':'C07','inspector_id':'P1','inspected_at':'2026-10-29T09:10:00+08:00','result':'ok',
          'conclusion':'normal','notes':'scope test','onsite_confirmed':'true','version':'1','request_id':'review-proof'}
    endpoint='/api/reviews/'+review['review_id']+'/evidence'
    assert client.post(endpoint,data={**form,'inspection_round_id':'wrong-scope'}).status_code==422
    response=client.post(endpoint,data=form)
    assert response.status_code==200,response.text
    assert response.json()['inspection_round_id']==payload['inspection_round_id']
    assert client.post(endpoint,data=form).json()==response.json()
