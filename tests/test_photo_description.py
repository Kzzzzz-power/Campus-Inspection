"""Synthetic pixel fixtures and MockTransport only; no real model or live data."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
from io import BytesIO
import json
from threading import Event

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from backend import photo_description as m, evidence as ev
from backend.main import create_app
from backend.storage import Store


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    monkeypatch.setenv('INSPECTGO_VLM_ENABLED', 'false')
    store = Store(tmp_path/'test.db', tmp_path/'photos')
    store.initialize(False)
    store.uploads.mkdir()
    stream = BytesIO()
    image = Image.new('RGB', (1800, 30), 'blue')
    exif = Image.Exif(); exif[270] = 'PRIVATE METADATA FIXTURE'
    image.save(stream, 'JPEG', exif=exif)
    raw = stream.getvalue()
    ids = ['a'*32, 'b'*32]
    with store.transaction(write=True) as conn:
        for iid in ids:
            rid = conn.execute("INSERT INTO records(point_id,status,source,created_at) VALUES ('C07','ok','onsite',?)", (ev.now(),)).lastrowid
            conn.execute('INSERT INTO photos VALUES (?,?,?,?,?,?,?)', (iid, rid, 'C07', iid+'.jpg', 'image/jpeg', ev.now(), hashlib.sha256(raw).hexdigest()))
            (store.uploads/(iid+'.jpg')).write_bytes(raw)
    return store, ids


def configured(monkeypatch):
    for key, value in {'ENABLED':'true','BASE_URL':'https://vision.example.invalid/v1','MODEL':'fixture-vision','API_KEY':'fixture-private-key'}.items():
        monkeypatch.setenv('INSPECTGO_VLM_'+key, value)


def test_reuse_is_explicit_atomic_and_still_needs_photo_opt_in(monkeypatch,tmp_path):
    for name in ('ENABLED','BASE_URL','MODEL','API_KEY','REUSE_LLM'):
        monkeypatch.delenv('INSPECTGO_VLM_'+name,raising=False)
    for name in ('BASE_URL','MODEL','API_KEY'):
        monkeypatch.delenv('INSPECTGO_LLM_'+name,raising=False)
    config=tmp_path/'server.env'
    config.write_text('LLM_BASE_URL=https://api.deepseek.com\nLLM_MODEL=deepseek-flash\nLLM_API_KEY=private-fixture\n')
    monkeypatch.setenv('INSPECTGO_LLM_ENV_FILE',str(config))
    monkeypatch.setenv('INSPECTGO_LLM_ENABLED','true')
    assert not m.public_status()['configured']
    monkeypatch.setenv('INSPECTGO_VLM_REUSE_LLM','true')
    assert m.public_status()['configured'] and not m.public_status()['enabled']
    monkeypatch.setenv('INSPECTGO_VLM_ENABLED','true')
    assert m.settings()['key']=='private-fixture'
    assert 'private-fixture' not in json.dumps(m.public_status())
    monkeypatch.setenv('INSPECTGO_VLM_BASE_URL','https://other.example.invalid')
    assert not m.public_status()['configured']
    assert m.settings()['key']==''  # Never send the reused key to a partial override.
    configured(monkeypatch)
    assert m.settings()['key']=='fixture-private-key'


def test_deepseek_photo_request_disables_default_thinking(ctx,monkeypatch):
    store,ids=ctx; configured(monkeypatch)
    monkeypatch.setenv('INSPECTGO_VLM_BASE_URL','https://api.deepseek.com')
    def reply(req):
        assert json.loads(req.content)['thinking']=={'type':'disabled'}
        value={'description':'蓝色平面。','observations':['蓝色背景。'],'limitations':['未显示设施。']}
        return httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'content':json.dumps(value)}}]})
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        assert m.describe(store,photo(store,ids[0]),client=client)['status']=='ok'


def photo(store, iid):
    with store.transaction() as conn:
        return m.source(conn, iid)


def request(store, iid, key='description-one'):
    return m.prepare(store, iid, {'request_id':key, 'consent':True})


def test_unconfigured_persists_unavailable_and_idempotency_survives_restart(ctx):
    store, ids = ctx
    before = snapshot(store)
    first = request(store, ids[0])
    assert request(store, ids[0])['description_id'] == first['description_id']
    with pytest.raises(HTTPException) as err:
        request(store, ids[1])
    assert err.value.status_code == 409
    m.execute(store, first['description_id'])
    reopened = Store(store.path, store.uploads); reopened.initialize(False)
    m.execute(reopened, first['description_id'])
    result = m.status(reopened, first['description_id'])
    assert result['status'] == 'completed' and result['evidence']['status'] == 'unavailable'
    assert result['evidence']['value_json'] is None
    assert result['evidence']['source_id'] == ids[0]
    assert result['evidence']['provenance_json']['image_sha256'] == photo(store,ids[0])['sha256']
    assert snapshot(store) == before
    assert len(m.listing(reopened, ids[0])['items']) == 1
    with store.transaction() as conn:
        assert conn.execute("SELECT COUNT(*) FROM evidence WHERE evidence_type='photo_ai_description'").fetchone()[0] == 1
        assert conn.execute('SELECT COUNT(*) FROM run_evidence').fetchone()[0] == 0


def snapshot(store):
    with store.transaction() as conn:
        return {t:[tuple(r) for r in conn.execute('SELECT * FROM '+t)] for t in
                ('records','inspection_records','reviews','runs','run_snapshots','task_results','facility_observations')}


def test_opt_in_only_consent_and_invalid_image_id(ctx):
    store, ids = ctx
    for body in ({'request_id':'a'}, {'request_id':'a','consent':False}, {'request_id':'a','consent':1}):
        with pytest.raises(HTTPException) as err:
            m.prepare(store,ids[0],body)
        assert err.value.status_code == 422
    with pytest.raises(HTTPException) as err:
        request(store,'../file')
    assert err.value.status_code == 404


def test_valid_multimodal_request_reencodes_and_strips_metadata(ctx,monkeypatch):
    store, ids = ctx; configured(monkeypatch)
    calls=[]
    def reply(req):
        calls.append(req)
        payload=json.loads(req.content)
        assert 'PRIVATE METADATA' not in req.content.decode() and ids[0] not in req.content.decode()
        uri=payload['messages'][1]['content'][1]['image_url']['url']
        with Image.open(BytesIO(base64.b64decode(uri.split(',')[1]))) as image:
            assert max(image.size)<=1536 and not image.getexif()
        value={'description':'蓝色平面。','observations':['画面呈蓝色。'],'limitations':['照片未显示设备标识。']}
        return httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'content':json.dumps(value)}}]})
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        result=m.describe(store,photo(store,ids[0]),client=client)
    assert result['status']=='ok' and result['value']['description']=='蓝色平面。' and len(calls)==1
    assert m.SCOPE in result['value']['limitations']


@pytest.mark.parametrize('body',[
    {'description':'text','observations':[],'limitations':[],'status':'normal'},
    {'description':'','observations':[],'limitations':[]},
    {'description':'fixture-private-key','observations':[],'limitations':[]},
    {'description':'x','observations':['x'*301],'limitations':[]},
    {'description':'x','observations':{},'limitations':[]},
    'malformed',
])
def test_malformed_provider_or_key_echo_not_saved(ctx,monkeypatch,body):
    store,ids=ctx; configured(monkeypatch)
    with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'content':json.dumps(body)}}]}))) as client:
        result=m.describe(store,photo(store,ids[0]),client=client)
    assert result['status']=='error' and result['value'] is None
    assert 'fixture-private-key' not in str(result)


@pytest.mark.parametrize('kind',['missing','corrupt','path','media','hash'])
def test_invalid_saved_photo_never_sent(ctx,monkeypatch,kind):
    store,ids=ctx; configured(monkeypatch); data=photo(store,ids[0])
    if kind=='missing': (store.uploads/data['stored_name']).unlink()
    elif kind=='corrupt':
        raw=b'not an image'; (store.uploads/data['stored_name']).write_bytes(raw); data['sha256']=hashlib.sha256(raw).hexdigest()
    elif kind=='path': data['stored_name']='../test.db'
    elif kind=='media': data['media_type']='image/png'
    else: data['sha256']='0'*64
    def forbidden(req): raise AssertionError('must not transmit invalid saved photo')
    with httpx.Client(transport=httpx.MockTransport(forbidden)) as client:
        assert m.describe(store,data,client=client)['status']=='error'


def test_lease_prevents_duplicate_worker_and_recovers_restart(ctx,monkeypatch):
    store,ids=ctx; first=request(store,ids[0]); entered=Event(); release=Event(); calls=[]
    def fake_description(*args):
        calls.append(1); entered.set(); assert release.wait(5)
        return {'status':'ok','value':{'description':'合成测试图像','observations':[],'limitations':[m.SCOPE]},'error':None,'provider':'fixture','model':'fixture'}
    monkeypatch.setattr(m,'describe',fake_description)
    with ThreadPoolExecutor(2) as executor:
        future=executor.submit(m.execute,store,first['description_id'])
        assert entered.wait(5)
        m.execute(store,first['description_id'])
        release.set(); future.result()
    assert len(calls)==1
    second=request(store,ids[1],'second')
    with store.transaction(write=True) as conn:
        conn.execute("UPDATE photo_description_jobs SET status='running',worker_id='crashed',lease_until='2000-01-01' WHERE description_id=?", (second['description_id'],))
    reopened=Store(store.path,store.uploads)
    assert m.listing(reopened,ids[1])['items'][0]['status']=='interrupted'
    m.execute(reopened,second['description_id'])
    assert m.status(reopened,second['description_id'])['status']=='completed'
    assert len(calls)==2


def test_routes_recover_existing_job_and_retry_completed_no_duplicate(ctx):
    store,ids=ctx
    app=create_app(store.path,store.uploads,False,False)
    with TestClient(app) as client:
        assert client.get('/api/photo-descriptions/config').json()['enabled'] is False
        url='/api/evidence/images/'+ids[0]+'/descriptions'
        assert client.post(url,json={'request_id':'api','consent':False}).status_code==422
        response=client.post(url,json={'request_id':'api','consent':True})
        assert response.status_code==202
        did=response.json()['description_id']
        result=client.get('/api/photo-descriptions/'+did).json()
        assert result['status']=='completed' and result['evidence']['status']=='unavailable'
        assert client.get(url).json()['items'][0]['description_id']==did
        assert client.post('/api/photo-descriptions/'+did+'/retry').json()==result
        assert client.post(url,json={'request_id':'api','consent':True}).json()==result


def test_concurrent_request_receipts_rate_limit_and_newest_first(ctx):
    store,ids=ctx
    with ThreadPoolExecutor(2) as executor:
        results=list(executor.map(lambda _:request(store,ids[0]),range(2)))
    assert results[0]['description_id']==results[1]['description_id']
    assert results[0]['request_id']=='description-one'
    second=request(store,ids[0],'second')
    assert m.listing(store,ids[0])['items'][0]['description_id']==second['description_id']
    with pytest.raises(HTTPException) as err:
        request(store,ids[0],'third')
    assert err.value.status_code==429


@pytest.mark.parametrize('kind',['oversized','http-error','timeout','key-echo','escaped-key'])
def test_response_budget_and_exceptions_never_expose_secrets(ctx,monkeypatch,kind):
    store,ids=ctx; configured(monkeypatch)
    def reply(req):
        if kind=='oversized': return httpx.Response(200,content=b'x'*(128*1024+1))
        if kind=='http-error': return httpx.Response(401,text='fixture-private-key')
        if kind=='timeout': raise httpx.ReadTimeout('fixture-private-key',request=req)
        if kind=='escaped-key':
            content=json.dumps({'description':'fixture-private-key','observations':[],'limitations':[]}).replace('fixture','\\u0066ixture')
            return httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'content':content}}]})
        return httpx.Response(200,text='fixture-private-key')
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        result=m.describe(store,photo(store,ids[0]),client=client)
    assert result['status']=='error' and result['value'] is None
    assert 'fixture-private-key' not in json.dumps(result)


@pytest.mark.parametrize('reason',['length','content_filter',None])
def test_truncated_or_unfinished_provider_output_rejected(ctx,monkeypatch,reason):
    store,ids=ctx; configured(monkeypatch)
    content=json.dumps({'description':'完整外观文字也不能掩盖截断标志','observations':[],'limitations':[]})
    with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'choices':[{'finish_reason':reason,'message':{'content':content}}]}))) as client:
        result=m.describe(store,photo(store,ids[0]),client=client)
    assert result['status']=='error' and result['value'] is None


def test_missing_credentials_and_bad_base_send_nothing(ctx,monkeypatch):
    store,ids=ctx; configured(monkeypatch)
    def forbidden(req): pytest.fail('configuration must prevent network request')
    with httpx.Client(transport=httpx.MockTransport(forbidden)) as client:
        monkeypatch.setenv('INSPECTGO_VLM_API_KEY','')
        assert m.describe(store,photo(store,ids[0]),client=client)['status']=='unavailable'
        monkeypatch.setenv('INSPECTGO_VLM_API_KEY','fixture-private-key')
        monkeypatch.setenv('INSPECTGO_VLM_BASE_URL','http://vision.example.invalid')
        assert m.describe(store,photo(store,ids[0]),client=client)['status']=='unavailable'
        monkeypatch.setenv('INSPECTGO_VLM_BASE_URL','https://invalid[')
        assert m.describe(store,photo(store,ids[0]),client=client)['status']=='unavailable'


def test_canonical_photo_provenance_is_independent_of_run(ctx):
    store,ids=ctx
    ev.create_round(store,{'round_id':'photo-round','date':'2026-10-01'})
    with store.transaction(write=True) as conn:
        conn.execute("INSERT INTO reviews(review_id,point_id,reason,status,version,created_at,updated_at) VALUES ('review-photo','C07','fixture','pending',1,?,?)",(ev.now(),ev.now()))
        record_id=photo_record=conn.execute('SELECT record_id FROM photos WHERE image_id=?',(ids[0],)).fetchone()[0]
        conn.execute("UPDATE records SET review_id='review-photo' WHERE id=?",(record_id,))
        saved=ev.save_inspection(conn,{'point_id':'C07','inspector_id':'P1','inspected_at':'2026-10-01T01:25:00+00:00',
            'result':'ok','notes':'fixture','request_id':'canonical-photo','inspection_round_id':'photo-round'},photo_record,'review-photo')
    before=snapshot(store)
    task=request(store,ids[0]); m.execute(store,task['description_id'])
    proof=m.status(store,task['description_id'])['evidence']
    assert proof['source_type']=='MODEL_OUTPUT' and proof['evidence_type']=='photo_ai_description'
    assert proof['inspection_id']==saved['inspection_id'] and proof['review_id']=='review-photo'
    assert proof['inspection_round_id']=='photo-round'
    assert proof['provenance_json']['image_inspected_at']=='2026-10-01T01:25:00.000000+00:00'
    assert proof['observed_at']!=proof['provenance_json']['image_inspected_at']
    assert snapshot(store)==before


def test_crash_before_worker_times_out_queue_without_blocking_and_retry_once(ctx):
    store,ids=ctx
    original=request(store,ids[0],'crashed-before-start')
    abandoned=request(store,ids[1],'also-abandoned')
    with store.transaction(write=True) as conn:
        conn.execute("UPDATE photo_description_jobs SET created_at='2000-01-01T00:00:00.000000+00:00'")
    reopened=Store(store.path,store.uploads)
    assert m.status(reopened,original['description_id'])['status']=='interrupted'
    assert m.listing(reopened,ids[1])['items'][0]['status']=='interrupted'
    with store.transaction() as conn:
        assert {r[0] for r in conn.execute('SELECT status FROM photo_description_jobs')}=={'queued'}
    assert request(reopened,ids[0],'crashed-before-start')['description_id']==original['description_id']
    fresh=request(reopened,ids[0],'capacity-after-crash')
    assert fresh['status']=='queued'
    app=create_app(reopened.path,reopened.uploads,False,False)
    with TestClient(app) as client:
        url='/api/photo-descriptions/'+original['description_id']+'/retry'
        assert client.post(url,json={}).status_code==202
        completed=client.get('/api/photo-descriptions/'+original['description_id']).json()
        assert completed['status']=='completed'
        assert client.post(url,json={}).json()==completed
    with store.transaction() as conn:
        assert conn.execute("SELECT COUNT(*) FROM evidence WHERE evidence_type='photo_ai_description'").fetchone()[0]==1
    assert m.status(reopened,abandoned['description_id'])['status']=='interrupted'


def test_worker_capacity_failure_is_explicitly_recoverable(ctx,monkeypatch):
    store,ids=ctx
    first=request(store,ids[0],'one'); second=request(store,ids[1],'two')
    with store.transaction(write=True) as conn:
        conn.execute("UPDATE photo_description_jobs SET created_at='2000-01-01T00:00:00.000000+00:00'")
    third=request(store,ids[0],'three')
    with store.transaction(write=True) as conn:
        conn.execute("UPDATE photo_description_jobs SET status='running',lease_until='2099-01-01T00:00:00+00:00' WHERE description_id IN (?,?)",(first['description_id'],second['description_id']))
    def forbidden(*args): pytest.fail('busy workers must not invoke provider')
    monkeypatch.setattr(m,'describe',forbidden)
    m.execute(store,third['description_id'])
    result=m.status(store,third['description_id'])
    assert result['status']=='interrupted' and '稍后恢复' in result['error'] and result['evidence'] is None


@pytest.mark.parametrize('summary_status',['ok','unavailable','error'])
def test_photo_summary_never_enters_next_s1_core_run(ctx,monkeypatch,summary_status):
    store,ids=ctx
    app=create_app(store.path,store.uploads,False,False)
    with TestClient(app) as client:
        prepared=client.post('/api/scenarios/S1/prepare',json={'instance_id':'photo-isolation','request_id':'prepare-photo-isolation'}).json()
        rid=prepared['inspection_round_id']
        # Freeze this isolated teaching clock so the summary is included at the same
        # cutoff, without unrelated freshness changes between compared runs.
        monkeypatch.setattr(ev,'now',lambda:ev.stamp(prepared['as_of']))
        with store.transaction(write=True) as conn:
            record_id=conn.execute('SELECT record_id FROM photos WHERE image_id=?',(ids[0],)).fetchone()[0]
            ev.save_inspection(conn,{'point_id':'C07','inspector_id':'P1','inspected_at':'2026-10-29T01:25:00+00:00',
                'result':'ok','notes':'合成照片夹具，不代表实际检查','request_id':'photo-core-isolation',
                'inspection_round_id':rid},record_id)
        def run(key):
            response=client.post('/api/runs',json={'request_id':key,'inspection_round_id':rid,'as_of':ev.now(),'scenario_id':'S1'})
            assert response.status_code==200,response.text
            return response.json()
        original=run('before-photo-description')
        states=[t['state'] for t in original['task_results']]
        assert len(states)==5
        assert next(t for t in original['task_results'] if t['task_id']=='T3')['state']=='established'
        def fixture_description(*args):
            return {'status':summary_status,'value':{'description':'合成蓝色画面','observations':[],'limitations':[m.SCOPE]} if summary_status=='ok' else None,
                    'error':None if summary_status=='ok' else '测试注入：照片摘要不可用','model':'fixture','provider':'fixture'}
        monkeypatch.setattr(m,'describe',fixture_description)
        task=request(store,ids[0],'photo-core-description'); m.execute(store,task['description_id'])
        proof=m.status(store,task['description_id'])['evidence']
        assert proof['inspection_round_id']==rid and proof['status']==summary_status
        subsequent=run('after-photo-description')
        assert proof['observed_at']<=subsequent['as_of']
        assert [t['state'] for t in subsequent['task_results']]==states
        assert proof['evidence_id'] not in subsequent['source_watermark']['evidence_ids']
        assert client.get('/api/runs/'+original['run_id']).json()==original
        assert client.get('/api/evidence/images/'+ids[0]+'/descriptions').json()['items'][0]['evidence']==proof
