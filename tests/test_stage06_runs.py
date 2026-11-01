"""Analysis must create a new reality run without reopening any terminal snapshot."""
import importlib.util
import json
import sqlite3
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app


@pytest.fixture
def ctx(tmp_path):
    app=create_app(tmp_path/'analysis.db',tmp_path/'photos',False,False)
    with TestClient(app) as c:
        p=c.post('/api/scenarios/S3/prepare',json={'instance_id':'analysis','request_id':'prepare'}).json()
        old=c.post('/api/runs',json={'request_id':'base','inspection_round_id':p['inspection_round_id'],'as_of':p['as_of'],'scenario_id':'S3'}).json()
        yield c,app.state.store,old


def module():
    assert importlib.util.find_spec('backend.analysis'), '阶段06尚无增强运行编排'
    from backend import analysis
    return analysis


def test_prepare_recomputes_shared_core_and_retry_preserves_original(ctx):
    c,s,old=ctx;a=module()
    payload={'request_id':'analysis-one','source_run_id':old['run_id'],'question':'现在哪还没巡？','failure_mode':'none'}
    job=a.prepare(s,payload)
    assert job['status']=='queued' and job['run_id']!=old['run_id']
    assert a.prepare(s,payload)['run_id']==job['run_id']
    with s.transaction() as conn:
        draft=json.loads(conn.execute('SELECT result_json FROM runs WHERE run_id=?',(job['run_id'],)).fetchone()[0])
        assert draft['status']=='running' and draft['completed_at'] is None
        assert draft['coverage']==old['coverage']
        assert [x['state'] for x in draft['task_results']]==[x['state'] for x in old['task_results']]
    assert c.get('/api/runs/'+old['run_id']).json()==old
    with pytest.raises(Exception) as err:a.prepare(s,{**payload,'question':'不同输入'})
    assert getattr(err.value,'status_code',None)==409


def test_steps_are_serial_and_failure_does_not_rewrite_states(ctx,monkeypatch):
    c,s,old=ctx;a=module();seen=[]
    def step(name):
        def provider(*args,**kw):
            seen.append(name)
            return {'status':'unavailable','provider':name,'value':None,'error':'测试注入：服务不可用'}
        return provider
    for name in ('weather','rag','ml','llm'):monkeypatch.setattr(a,name,step(name))
    job=a.prepare(s,{'request_id':'degraded','source_run_id':old['run_id'],'question':'现在哪还没巡？'})
    a.execute(s,job['run_id'])
    assert seen==['weather','rag','ml','llm']
    result=c.get('/api/runs/'+job['run_id']).json()
    assert result['status']=='completed' and result['analysis']['status']=='degraded'
    assert [x['name'] for x in result['analysis']['steps']]==['statistics','weather','rag','ml','tools','llm']
    assert [t['state'] for t in result['task_results']]==[t['state'] for t in old['task_results']]
    assert c.get('/api/runs/'+old['run_id']).json()==old
    assert a.status(s,job['run_id'])['status']=='completed'
    a.execute(s,job['run_id'])
    assert len(seen)==4
    with s.transaction() as conn:
        for item in result['analysis']['steps']:
            assert conn.execute('SELECT 1 FROM run_evidence WHERE run_id=? AND evidence_id=?',(result['run_id'],item['evidence_id'])).fetchone()
        with pytest.raises(sqlite3.IntegrityError):conn.execute('UPDATE runs SET summary=? WHERE run_id=?',('changed',result['run_id']))
    log=s.path.parent/'logs'/'tool_calls.jsonl'
    calls=[json.loads(x) for x in log.read_text(encoding='utf-8').splitlines()]
    assert len(calls)==3 and all(x['run_id']==result['run_id'] for x in calls)
    gaps=next(x for x in calls if x['name']=='coverage_gaps')
    assert gaps['result']['point_ids']==['C07']


def test_non_teaching_run_cannot_inject_failures(ctx):
    c,s,old=ctx;a=module()
    with pytest.raises(Exception) as err:a.prepare(s,{'request_id':'bad','source_run_id':old['run_id'],'question':'x','failure_mode':'database'})
    assert getattr(err.value,'status_code',None)==422


@pytest.mark.parametrize('failure',['weather','rag','ml','llm'])
def test_each_independent_failure_is_saved_without_changing_t1_t5(ctx,monkeypatch,failure):
    c,s,old=ctx;a=module()
    for name in ('weather','rag','ml','llm'):
        monkeypatch.setattr(a,name,lambda *args,**kw:{'status':'ok','provider':'test-only','value':{'test_only':True},'error':None})
    reply=c.post('/api/analyses',json={'request_id':'failure-'+failure,'source_run_id':old['run_id'],'question':'交换机通风巡检','failure_mode':failure})
    assert reply.status_code==202,reply.text
    run_id=reply.json()['run_id'];new=c.get('/api/runs/'+run_id).json()
    assert c.get('/api/analyses/'+run_id).json()['status']=='completed'
    assert [x['name'] for x in new['analysis']['steps'] if x['status']!='ok']==[failure]
    assert [t['state'] for t in new['task_results']]==[t['state'] for t in old['task_results']]
    assert new['statistics']['coverage_rate']==old['statistics']['coverage_rate']
    assert c.get('/api/runs/'+old['run_id']).json()==old
    assert c.post('/api/analyses',json={'request_id':'failure-'+failure,'source_run_id':old['run_id'],'question':'交换机通风巡检','failure_mode':failure}).json()['run_id']==run_id
    assert c.post('/api/analyses/'+run_id+'/retry').json()['status']=='completed'
    # Restart and read the same immutable result.
    with TestClient(create_app(s.path,s.uploads,False,False)) as restarted:
        assert restarted.get('/api/runs/'+run_id).json()==new


def test_interrupted_job_resumes_without_reopening_completed_run(ctx,monkeypatch):
    c,s,old=ctx;a=module()
    for name in ('weather','rag','ml','llm'):
        monkeypatch.setattr(a,name,lambda *args,**kw:{'status':'unavailable','provider':'test-only','value':None,'error':'测试不可用'})
    job=a.prepare(s,{'request_id':'resume','source_run_id':old['run_id'],'question':'解释'})
    with s.transaction(write=True) as conn:
        conn.execute("UPDATE analysis_jobs SET status='running',lease_until='2000-01-01T00:00:00+00:00',worker_id='crashed' WHERE run_id=?",(job['run_id'],))
    assert c.get('/api/analyses/'+job['run_id']).json()['status']=='interrupted'
    assert c.post('/api/analyses/'+job['run_id']+'/retry').status_code==202
    result=c.get('/api/runs/'+job['run_id']).json()
    assert result['status']=='completed' and result['analysis']['status']=='degraded'


def test_tool_best_candidate_is_not_a_task_completion(ctx):
    c,s,old=ctx;a=module();out=a.tools(old,s,'test')
    plan=next(x['result'] for x in out['value']['items'] if x['name']=='plan_feasibility')
    assert plan['fastest_executable_plan_ids']==['PLAN_A']
    assert old['task_results'][0]['state']=='blocked'


def test_analysis_reserves_global_request_key(ctx):
    c,s,old=ctx;a=module()
    payload={'request_id':'shared-key','source_run_id':old['run_id'],'question':'解释'}
    job=a.prepare(s,payload)
    reply=c.post('/api/reviews',json={'request_id':'shared-key','point_id':'C07','reason':'不能复用分析请求标识'})
    assert reply.status_code==409
    assert a.prepare(s,payload)['run_id']==job['run_id']


def test_recovery_obeys_same_concurrency_limit(ctx):
    c,s,old=ctx;a=module()
    job=a.prepare(s,{'request_id':'interrupted-first','source_run_id':old['run_id'],'question':'解释'})
    with s.transaction(write=True) as conn:conn.execute("UPDATE analysis_jobs SET status='interrupted' WHERE run_id=?",(job['run_id'],))
    for key in ('queued-a','queued-b'):a.prepare(s,{'request_id':key,'source_run_id':old['run_id'],'question':'解释'})
    a.execute(s,job['run_id'])
    assert a.status(s,job['run_id'])['status']=='interrupted'
    assert '名额' in a.status(s,job['run_id'])['error']


def test_empty_duration_limit_does_not_depend_on_ai_availability():
    from backend.runs import basic_statistics
    cov={'points':[],'coverage_rate':0,'required':6,'covered':0}
    value=basic_statistics(cov,[],[],[])
    limits=[x for x in value['limitations'] if 'AI' not in x]
    assert value['duration_seconds'] is None and any('耗时' in x for x in limits)
