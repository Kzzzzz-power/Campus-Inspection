import sys, json, sqlite3
from pathlib import Path
from datetime import datetime, timezone
import pytest
from fastapi.testclient import TestClient
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from backend.main import create_app

@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path/'db.sqlite',tmp_path/'photos',False,False)) as c:
        yield c

def round_(c, name='R1'):
    r=c.post('/api/rounds',json={'round_id':name,'date':'2026-10-01'})
    assert r.status_code==200, r.text
    return r.json()

def inspection(**kw):
    return dict(inspection_round_id='R1',checkpoint_id='C07',facility_id='switch-301',zone_id='Z3',inspector_id='P1',inspected_at='2026-10-01T09:25:00',method='ON_SITE',result='NORMAL',notes='现场检查',request_id='i1',**kw)

def test_round_json_lineage_restart(client):
    r=round_(client)
    assert r['window_start']=='2026-10-01T01:00:00.000000+00:00'
    response=client.post('/api/inspections',json=inspection())
    assert response.status_code==200,response.text
    saved=response.json()
    assert saved['window_eligible'] is True
    assert client.post('/api/inspections',json=inspection()).json()==saved
    rows=client.get('/api/inspections?inspection_round_id=R1').json()['items']
    assert rows[0]['result']=='NORMAL'
    evidence=client.get('/api/evidence?inspection_round_id=R1').json()['items'][0]
    assert evidence['status']=='ok' and evidence['value_json']['result']=='NORMAL'
    assert evidence['source_id']==saved['inspection_id']
    assert client.get('/api/inspections?inspection_round_id=R2').json()['total']==0
    store=client.app.state.store
    with TestClient(create_app(store.path,store.uploads,False,False)) as reopened:
        assert reopened.get('/api/inspections').json()['total']==1
        assert reopened.get('/api/evidence').json()['items']==[evidence]

@pytest.mark.parametrize('change',[{'zone_id':'Z1'},{'facility_id':'fake'},{'method':'REMOTE'},{'result':'ok'},{'inspection_round_id':'missing'},{'inspected_at':'bad'}])
def test_invalid_inspection_no_rows(client,change):
    round_(client)
    body=inspection(); body.update(change)
    assert client.post('/api/inspections',json=body).status_code in (404,422)
    assert client.get('/api/inspections').json()['total']==0

def test_mqtt_persistence_normalized_dedupe_restart(client):
    feed=client.app.state.facilities
    now=datetime(2026,10,1,1,25,tzinfo=timezone.utc)
    value=dict(facility_id='switch-301',zone_id='Z3',observed_at='2026-10-01T09:25:00+08:00',source_type='SIMULATED',availability='AVAILABLE',condition='NORMAL',metrics={})
    topic='nova/bb02/facility/switch-301/status'
    assert feed.ingest(topic,json.dumps(value).encode(),now)=='accepted'
    assert client.get('/api/history').json()['total']==1
    store=client.app.state.store
    with TestClient(create_app(store.path,store.uploads,False,False)) as reopened:
        value['observed_at']='2026-10-01T01:25:00Z'
        assert reopened.app.state.facilities.ingest(topic,json.dumps(value).encode(),now)=='duplicate'
        assert reopened.get('/api/history').json()['total']==1
        assert reopened.get('/api/evidence').json()['total']==1
        assert all(x['freshness']!='fresh' for x in reopened.get('/api/current').json()['facilities'])

def test_storage_check(client):
    r=client.post('/api/evidence/storage-check',json={})
    assert r.status_code==200,r.text
    assert {x['evidence_type'] for x in r.json()['evidence']}=={'sqlite_write','history_query'}
    assert all(x['status']=='ok' for x in r.json()['evidence'])

@pytest.mark.parametrize('query',['limit=201','offset=-1','from=bad','from=2026-10-02&to=2026-10-01','surprise=yes'])
def test_query_validation(client,query):
    assert client.get('/api/history?'+query).status_code==422

def test_round_window_boundaries_and_unassigned(client):
    round_(client)
    round_(client,'R2')
    for i,(when,want) in enumerate([('09:00:00',True),('09:45:00',True),('08:59:59',False),('09:45:01',False)]):
        body=inspection();body.update(request_id='boundary'+str(i),inspected_at='2026-10-01T'+when)
        assert client.post('/api/inspections',json=body).json()['window_eligible'] is want
    body=inspection();body.update(request_id='other',inspection_round_id='R2')
    assert client.post('/api/inspections',json=body).status_code==200
    body.update(request_id='none',inspection_round_id=None)
    assert client.post('/api/inspections',json=body).json()['window_eligible'] is None
    assert client.get('/api/inspections?inspection_round_id=R1').json()['total']==4
    assert client.get('/api/evidence?inspection_round_id=R1').json()['total']==4
    assert client.get('/api/inspections',params={'from':'2026-10-01T09:00:00+08:00','to':'2026-10-01T01:00:00Z'}).json()['total']==1

@pytest.mark.parametrize('payload',[{'round_id':'R','date':'bad'},{'round_id':'R','date':'2026-10-01','window_start':'08:00'},{'round_id':'bad space','date':'2026-10-01'}])
def test_round_validation(client,payload):
    assert client.post('/api/rounds',json=payload).status_code==422
    assert client.get('/api/rounds').json()['total']==0

def test_round_and_inspection_conflicts(client):
    round_(client)
    assert client.post('/api/rounds',json={'round_id':'R1','date':'2026-10-02'}).status_code==409
    body=inspection()
    saved=client.post('/api/inspections',json=body).json()
    body['result']='FAULT'
    assert client.post('/api/inspections',json=body).status_code==409
    body['request_id']='fault-new'
    assert client.post('/api/inspections',json=body).status_code==200
    assert client.get('/api/evidence?status=ok').json()['total']==2
    assert client.get('/api/evidence?status=error').json()['total']==0

def test_legacy_alarm_and_photo_atomic_receipt(client):
    import io
    from PIL import Image
    image=io.BytesIO();Image.new('RGB',(2,2),'red').save(image,format='PNG')
    fields=dict(point_id='C07',inspector_id='P1',inspected_at='2026-10-01T01:25:00Z',result='alarm',notes='现场原始告警',onsite_confirmed='true',request_id='photo')
    saved=client.post('/api/inspections',data=fields,files={'photos':('photo.png',image.getvalue(),'image/png')})
    assert saved.status_code==200,saved.text
    record=client.get('/api/inspections').json()['items'][0]
    assert record['result'] is None and record['raw_result']=='alarm'
    assert record['inspection_round_id'] is None
    proof=client.get('/api/evidence').json()['items'][0]
    assert proof['value_json']['photos'][0]['image_id']==saved.json()['photos'][0]['image_id']
    assert client.get(saved.json()['photos'][0]['url']).status_code==200
    store=client.app.state.store
    with sqlite3.connect(store.path) as db:
        db.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON request_receipts BEGIN SELECT RAISE(ABORT,'forced receipt failure'); END")
    fields['request_id']='rollback'
    failure=client.post('/api/inspections',data=fields,files={'photos':('photo.png',image.getvalue(),'image/png')})
    assert failure.status_code==503
    assert client.get('/api/inspections').json()['total']==1
    assert client.get('/api/evidence').json()['total']==1
    assert len(list(store.uploads.iterdir()))==1
    with sqlite3.connect(store.path) as db:
        assert db.execute('SELECT COUNT(*) FROM records').fetchone()[0]==1
        assert db.execute('SELECT COUNT(*) FROM photos').fetchone()[0]==1

def test_migration_preserves_old_rows_without_round_backfill(client):
    store=client.app.state.store
    with sqlite3.connect(store.path) as db:
        db.execute("INSERT INTO records (point_id,status,source,evidence,created_at) VALUES ('C07','alarm','onsite','old','2020-01-01')")
        db.execute("INSERT INTO runs VALUES ('oldrun','2020-01-01','old summary')")
        before={t:db.execute('SELECT * FROM '+t).fetchall() for t in ('records','runs','reviews','photos')}
    store.initialize(True);store.initialize(True)
    with sqlite3.connect(store.path) as db:
        assert before=={t:db.execute('SELECT * FROM '+t).fetchall() for t in before}
    assert client.get('/api/inspections').json()['total']==0
    assert client.get('/api/rounds').json()['total']==0


def mqtt_value(at='2026-10-01T01:25:00Z', **kw):
    return dict(facility_id='switch-301',zone_id='Z3',observed_at=at,source_type='SIMULATED',availability='AVAILABLE',condition='NORMAL',metrics={},**kw)

def ingest(client,value):
    return client.app.state.facilities.ingest('nova/bb02/facility/switch-301/status',json.dumps(value).encode(),datetime(2026,10,1,2,tzinfo=timezone.utc))

def test_mqtt_lock_live_status_retry_and_no_callback_crash(client):
    import time
    store=client.app.state.store
    blocker=sqlite3.connect(store.path)
    blocker.execute('BEGIN IMMEDIATE')
    start=time.monotonic()
    try:
        assert ingest(client,mqtt_value())=='accepted'
        assert time.monotonic()-start<1
        current=next(x for x in client.get('/api/current').json()['facilities'] if x['facility_id']=='switch-301')
        assert current['observation']['condition']=='NORMAL'
        assert current['storage']['status']=='error'
        assert current['storage']['observation_id'] is None
    finally:
        blocker.rollback();blocker.close()
    assert client.get('/api/history').json()['total']==0
    assert ingest(client,mqtt_value())=='duplicate'
    assert client.get('/api/history').json()['total']==1
    current=next(x for x in client.get('/api/current').json()['facilities'] if x['facility_id']=='switch-301')
    assert current['storage']['status']=='ok'

def test_failed_newer_live_message_rejects_older_without_insertion(client):
    blocker=sqlite3.connect(client.app.state.store.path);blocker.execute('BEGIN IMMEDIATE')
    try:
        assert ingest(client,mqtt_value())=='accepted'
    finally:
        blocker.rollback();blocker.close()
    assert ingest(client,mqtt_value('2026-10-01T01:24:00Z'))=='out_of_order'
    assert client.get('/api/history').json()['total']==0

def test_mqtt_invalid_conflict_and_old_message_never_insert(client):
    assert ingest(client,mqtt_value())=='accepted'
    assert ingest(client,{**mqtt_value(),'condition':'FAULT'})=='rejected'
    assert ingest(client,mqtt_value('2026-10-01T01:24:00Z'))=='out_of_order'
    assert ingest(client,{**mqtt_value(),'zone_id':'Z1'})=='rejected'
    assert client.get('/api/history').json()['total']==1
    assert client.get('/api/evidence').json()['total']==1

def test_storage_probe_failure_never_invents_fault(client):
    store=client.app.state.store
    with sqlite3.connect(store.path) as db:
        db.execute("CREATE TRIGGER fail_probe BEFORE INSERT ON storage_probes BEGIN SELECT RAISE(ABORT,'forced write failure'); END")
    result=client.post('/api/evidence/storage-check')
    assert result.status_code==503
    proof=client.get('/api/evidence').json()['items'][0]
    assert proof['status']=='error' and proof['value_json'] is None
    assert 'forced write failure' in proof['error']

def test_plan_round_event_provenance_and_immutability(client):
    r=client.post('/api/rounds',json={'round_id':'R1','date':'2026-10-01','scenario_instance_id':None})
    assert r.status_code==200
    assert r.json()['round_id']==r.json()['inspection_round_id']=='R1'
    assert len(r.json()['config_hash'])==64
    assert ingest(client,{**mqtt_value(),'event_id':'device-event-1'})=='accepted'
    row=client.get('/api/history').json()['items'][0]
    assert row['event_id']=='device-event-1' and row['received_at']!=row['observed_at']
    proof=client.get('/api/evidence').json()['items'][0]
    assert len(proof['content_hash'])==64 and proof['valid_until'] is None
    assert proof['provenance_json']['event_id']=='device-event-1'
    with sqlite3.connect(client.app.state.store.path) as db:
        for table in ('facility_observations','evidence'):
            with pytest.raises(sqlite3.IntegrityError):
                db.execute('DELETE FROM '+table)
            with pytest.raises(sqlite3.IntegrityError):
                db.execute('UPDATE '+table+' SET created_at=created_at')

def test_duration_supersession_and_assumed_timezone(client):
    client.post('/api/rounds',json={'round_id':'R1','date':'2026-10-01'})
    body=inspection();body.update(started_at='2026-10-01T09:20:00',duration_seconds=300)
    r=client.post('/api/inspections',json=body)
    assert r.status_code==200,r.text
    prior=r.json()['inspection_id']
    row=client.get('/api/inspections').json()['items'][0]
    assert row['duration_seconds']==300 and row['source_type']=='ON_SITE' and row['request_id']=='i1'
    proof=client.get('/api/evidence').json()['items'][0]
    assert proof['provenance_json']['assumed_timezone']=='Asia/Shanghai'
    body.update(request_id='correction',supersedes_id=prior,result='FAULT')
    assert client.post('/api/inspections',json=body).status_code==200
    assert client.get('/api/inspections').json()['total']==2
    body.update(request_id='invalid-duration',duration_seconds=301)
    assert client.post('/api/inspections',json=body).status_code==422
    body.update(request_id='invalid-parent',duration_seconds=300,supersedes_id='missing')
    assert client.post('/api/inspections',json=body).status_code==422

def test_restart_event_order_collision_and_normalized_identity(client):
    assert ingest(client,{**mqtt_value(),'event_id':'one'})=='accepted'
    assert ingest(client,{**mqtt_value('2026-10-01T01:26:00Z'),'event_id':'two'})=='accepted'
    store=client.app.state.store
    with TestClient(create_app(store.path,store.uploads,False,False)) as reopened:
        assert ingest(reopened,{**mqtt_value(),'event_id':'one'})=='out_of_order'
        assert ingest(reopened,{**mqtt_value('2026-10-01T01:27:00Z'),'event_id':'two'})=='rejected'
        assert ingest(reopened,{**mqtt_value('2026-10-01T09:26:00+08:00'),'event_id':'two'})=='duplicate'
        assert reopened.get('/api/history').json()['total']==2
        assert reopened.get('/api/evidence').json()['total']==2

@pytest.mark.parametrize('value',['UNKNOWN','ALARM',None,[]])
def test_json_only_declared_business_dictionary(client,value):
    round_(client)
    body=inspection();body['result']=value
    assert client.post('/api/inspections',json=body).status_code==422

def test_correction_cross_round_rejected_and_original_immutable(client):
    round_(client);round_(client,'R2')
    original=client.post('/api/inspections',json=inspection()).json()
    body=inspection();body.update(request_id='cross-round',inspection_round_id='R2',supersedes_id=original['inspection_id'])
    assert client.post('/api/inspections',json=body).status_code==422
    with sqlite3.connect(client.app.state.store.path) as db:
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE inspection_records SET result='FAULT'")
    assert client.get('/api/inspections').json()['total']==1

def test_round_config_digest_and_evidence_hash_match_actual_values(client):
    import hashlib
    r=round_(client)
    configs={name:json.loads((ROOT/'config'/(name+'.json')).read_text(encoding='utf-8-sig')) for name in ('facilities','zones')}
    digest=lambda obj:hashlib.sha256(json.dumps(obj,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
    assert r['config_hash']==digest(configs)
    assert ingest(client,mqtt_value())=='accepted'
    proof=client.get('/api/evidence').json()['items'][0]
    assert proof['content_hash']==digest(proof['value_json'])
    assert proof['provenance_json']['event_id_derived'] is True

def test_idempotency_header_and_naive_timezone_metadata(client):
    round_(client)
    body=inspection();body.pop('request_id');body['inspected_at']='2026-10-01T01:25:00Z'
    result=client.post('/api/inspections',json=body,headers={'Idempotency-Key':'header'})
    assert result.status_code==200
    assert client.post('/api/inspections',json=body,headers={'Idempotency-Key':'header'}).json()==result.json()
    assert client.get('/api/evidence').json()['items'][0]['provenance_json']['assumed_timezone'] is None
