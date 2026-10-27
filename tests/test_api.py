"""API contracts use real SQLite/files in project .runtime, never the live DB."""
from contextlib import contextmanager
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.runtime' / 'api-tests'
RUNTIME.mkdir(parents=True, exist_ok=True)
os.environ['TEMP'] = str(RUNTIME)
os.environ['TMP'] = str(RUNTIME)
tempfile.tempdir = str(RUNTIME)
sys.path.insert(0, str(ROOT / 'backend'))
_spec = importlib.util.spec_from_file_location('inspectgo_api', ROOT / 'backend/main.py')
api = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(api)


def stamp(minutes=0):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


def png_bytes(format='PNG'):
    stream = io.BytesIO()
    Image.new('RGB', (8, 8), '#1155aa').save(stream, format=format)
    return stream.getvalue()


@contextmanager
def local_db(path):
    connection = sqlite3.connect(path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()

def legacy_database(path):
    with local_db(path) as db:
        db.executescript('''CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT,
        point_id TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
        evidence TEXT, created_at TEXT NOT NULL);
        CREATE TABLE runs (run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, summary TEXT);''')
        db.executemany('INSERT INTO records (point_id,status,source,evidence,created_at) VALUES (?,?,?,?,?)', [
            ('C01', 'ok', 'onsite', 'older onsite', stamp(-20)),
            ('C01', 'alarm', 'remote', 'new remote alarm', stamp(-2)),
            ('C03', 'unknown', 'remote', 'timeout is not fault', stamp(-3)),
            ('C06', 'alarm', 'remote', 'unconfirmed alarm', stamp(-5)),
            ('C04', 'ok', 'onsite', 'expired onsite', stamp(-60)),
        ])
        db.execute('INSERT INTO runs VALUES (?,?,?)', ('legacy-run', stamp(-60), 'original summary'))


@pytest.fixture
def state(monkeypatch):
    with tempfile.TemporaryDirectory(prefix='case-', dir=RUNTIME) as directory:
        root = Path(directory)
        database, uploads = root / 'test.db', root / 'uploads'
        legacy_database(database)
        monkeypatch.setenv('INSPECTGO_DB', str(database))
        monkeypatch.setenv('INSPECTGO_UPLOADS', str(uploads))
        if hasattr(api, 'create_app'):
            application = api.create_app(db_path=database, uploads_dir=uploads, seed_demo=False)
        else:
            monkeypatch.setattr(api, 'DB', database)
            application = api.app
        with TestClient(application, raise_server_exceptions=False) as client:
            yield client, database, uploads, application


def form(request_id='inspection-one', **changes):
    value = dict(point_id='C07', inspector_id='P1', inspected_at=stamp(-1),
                 result='ok', notes='onsite result', onsite_confirmed='true', request_id=request_id)
    value.update(changes)
    return value


def inspect(client, data=None, photos=None, path='/api/inspections'):
    options = {'data': data or form()}
    if photos is not None:
        options['files'] = [('photos', (name, body, mime)) for name, body, mime in photos]
    return client.post(path, **options)


def create_review(client, point='C03', request_id='review-one'):
    response = client.post('/api/reviews', json={'point_id': point, 'reason': 'verify current condition', 'request_id': request_id})
    assert response.status_code == 200, response.text
    return response.json()['review']


def test_dashboard_uses_correct_required_set_and_keeps_onsite_under_remote_alarm(state):
    client, *_ = state
    response = client.get('/api/dashboard')
    assert response.status_code == 200
    value = response.json()
    points = {p['point_id']: p for p in value['points']}
    assert set(points) == {'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08'}
    assert {p['point_id'] for p in points.values() if p['required']} == {'C01', 'C02', 'C04', 'C05', 'C07', 'C08'}
    assert value['covered'] == 1
    assert value['missing'] == ['C02', 'C04', 'C05', 'C07', 'C08']
    assert points['C01']['covered'] is True
    assert points['C01']['latest_status'] == 'alarm'
    assert points['C01']['record_source'] == 'remote'
    assert points['C03']['latest_status'] == 'unknown'
    assert points['C06']['latest_status'] == 'alarm'
    assert points['C04']['covered'] is False
    assert datetime.fromisoformat(value['window_end']) - datetime.fromisoformat(value['window_start']) == timedelta(minutes=45)
    assert value['as_of'] == value['window_end']
    assert client.get('/api/coverage').json()['covered'] == 1


def test_migration_preserves_legacy_rows_and_summary_across_restart(state):
    client, database, uploads, application = state
    response = client.get('/api/points/C01')
    assert response.status_code == 200
    rows = response.json()['records']
    assert len(rows) == 2 and all(row['is_legacy'] for row in rows)
    assert {r['evidence'] for r in rows} == {'older onsite', 'new remote alarm'}
    old = client.get('/api/runs/legacy-run').json()
    assert old['legacy'] is True and old['snapshot'] is None
    assert old['summary'] == 'original summary'
    with TestClient(api.create_app(db_path=database, uploads_dir=uploads, seed_demo=False)) as restarted:
        assert restarted.get('/api/runs/legacy-run').json() == old
        assert len(restarted.get('/api/points/C01').json()['records']) == 2
    with local_db(database) as db:
        assert db.execute('SELECT COUNT(*) FROM records').fetchone()[0] == 5


@pytest.mark.parametrize('format,name,mime', [('PNG','field.png','image/png'), ('JPEG','field.jpg','image/jpeg'), ('WEBP','field.webp','image/webp')])
def test_inspection_saves_real_photo_and_returns_it_after_restart(state, format, name, mime):
    client, database, uploads, _ = state
    data = form()
    payload = png_bytes(format)
    response = inspect(client, data, [(name, payload, mime)])
    assert response.status_code == 200, response.text
    record_id = response.json()['record_id']
    detail = client.get('/api/points/C07').json()
    record = next(r for r in detail['records'] if r['id'] == record_id)
    assert record['inspector_id'] == 'P1' and record['is_legacy'] is False
    assert detail['point']['covered'] is True
    assert detail['point']['photo_count'] == 1
    assert len(detail['photos']) == 1
    photo = detail['photos'][0]
    assert photo['record_id'] == record_id and photo['point_id'] == 'C07'
    assert photo['url'].startswith('/api/evidence/images/')
    fetched = client.get(photo['url'])
    assert fetched.status_code == 200 and fetched.content == payload
    assert fetched.headers['content-type'].startswith(mime)
    with TestClient(api.create_app(db_path=database, uploads_dir=uploads, seed_demo=False)) as restarted:
        assert restarted.get(photo['url']).content == payload
        assert restarted.get('/api/points/C07').json()['records'][0]['id'] == record_id


@pytest.mark.parametrize('changes', [
    {'point_id':'C99'}, {'inspector_id':' '}, {'inspected_at':'2026-10-27T12:00:00'},
    {'inspected_at':'invalid'}, {'inspected_at':stamp(60)}, {'onsite_confirmed':'false'},
    {'result':'FAULT'}, {'request_id':''}, {'notes':'x' * 2001}, {'notes':'   '},
])
def test_invalid_inspection_is_rejected_without_writing(state, changes):
    client, database, *_ = state
    response = inspect(client, form(**changes))
    assert response.status_code == 422, response.text
    with local_db(database) as db:
        assert db.execute('SELECT COUNT(*) FROM records').fetchone()[0] == 5


@pytest.mark.parametrize('photos,expected', [
    ([('fake.png', b'not an image', 'image/png')], 422),
    ([('field.svg', b'<svg/>', 'image/svg+xml')], 422),
    ([('wrong.jpg', png_bytes(), 'image/jpeg')], 422),
    ([('too-big.png', b'x' * (10 * 1024 * 1024 + 1), 'image/png')], 413),
    ([('field.png', png_bytes(), 'image/png')] * 6, 422),
])
def test_invalid_photos_leave_no_records_or_files(state, photos, expected):
    client, database, uploads, _ = state
    response = inspect(client, form(), photos)
    assert response.status_code == expected, response.text
    with local_db(database) as db:
        assert db.execute('SELECT COUNT(*) FROM records').fetchone()[0] == 5
    assert not uploads.exists() or not list(uploads.iterdir())


def test_identical_inspection_retries_return_one_record_and_mismatched_retry_conflicts(state):
    client, database, *_ = state
    data, photo = form(), [('p.png', png_bytes(), 'image/png')]
    first = inspect(client, data, photo)
    assert first.status_code == 200
    second = inspect(client, data, photo)
    assert second.json() == first.json()
    assert inspect(client, {**data, 'notes':'different'}, photo).status_code == 409
    with local_db(database) as db:
        assert db.execute('SELECT COUNT(*) FROM records WHERE point_id="C07"').fetchone()[0] == 1
    assert len(client.get('/api/points/C07').json()['photos']) == 1


def test_concurrent_same_request_cannot_duplicate_inspection(state):
    client, database, *_ = state
    data = form()
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: inspect(client, data), range(2)))
    assert [r.status_code for r in responses] == [200, 200]
    assert responses[0].json()['record_id'] == responses[1].json()['record_id']
    with local_db(database) as db:
        assert db.execute('SELECT COUNT(*) FROM records WHERE point_id="C07"').fetchone()[0] == 1


def test_review_unknown_stays_pending_then_fault_completes_without_rewriting_alarm(state):
    client, *_ = state
    review = create_review(client, point='C06')
    assert review['status'] == 'pending' and review['version'] == 1
    path = '/api/reviews/' + review['review_id'] + '/evidence'
    unknown = form(request_id='review-evidence-one', point_id='C06', result='unknown', conclusion='unknown', version='1')
    response = inspect(client, unknown, path=path)
    assert response.status_code == 200, response.text
    pending = response.json()['review']
    assert pending['status'] == 'pending' and pending['version'] == 2
    assert inspect(client, unknown, path=path).json() == response.json()
    stale = form(request_id='stale-review', point_id='C06', result='alarm', conclusion='fault', version='1')
    assert inspect(client, stale, path=path).status_code == 409
    done = inspect(client, {**stale, 'request_id':'review-evidence-two', 'version':'2'}, path=path)
    assert done.status_code == 200
    assert done.json()['review']['status'] == 'completed'
    assert done.json()['review']['conclusion'] == 'fault'
    detail = client.get('/api/points/C06').json()
    assert any(r['source'] == 'remote' and r['evidence'] == 'unconfirmed alarm' for r in detail['records'])
    assert detail['point']['review']['status'] == 'completed'
    assert len(detail['reviews']) == 1


def test_duplicate_pending_review_is_explicit_and_does_not_drop_original_reason(state):
    client, *_ = state
    first = create_review(client)
    response = client.post('/api/reviews', json={'point_id':'C03','reason':'different reason','request_id':'review-two'})
    assert response.status_code == 409
    detail = client.get('/api/points/C03').json()
    assert len(detail['reviews']) == 1 and detail['reviews'][0]['reason'] == 'verify current condition'
    repeated = client.post('/api/reviews', json={'point_id':'C03','reason':'verify current condition','request_id':'review-one'})
    assert repeated.json()['review'] == first


def test_review_requires_matching_point_and_conclusion(state):
    client, *_ = state
    review = create_review(client)
    path = '/api/reviews/' + review['review_id'] + '/evidence'
    assert inspect(client, form(point_id='C07', conclusion='normal', version='1'), path=path).status_code == 422
    assert inspect(client, form(point_id='C03', result='alarm', conclusion='normal', version='1'), path=path).status_code == 422
    assert client.get('/api/points/C03').json()['point']['review']['version'] == 1


def test_run_freezes_snapshot_without_changing_records_and_idempotent_retry_returns_same(state):
    client, database, *_ = state
    first = client.post('/api/runs', json={'request_id':'run-once'})
    assert first.status_code == 200
    run = first.json()
    assert run['snapshot']['covered'] == 1 and run['coverage']['covered'] == 1
    with local_db(database) as db:
        assert db.execute('SELECT COUNT(*) FROM records').fetchone()[0] == 5
    assert inspect(client, form()).status_code == 200
    saved = client.get('/api/runs/' + run['run_id']).json()
    assert saved['snapshot'] == run['snapshot'] and saved['legacy'] is False
    assert client.get('/api/dashboard').json()['covered'] == 2
    assert client.post('/api/runs', json={'request_id':'run-once'}).json() == run
    assert client.post('/api/runs').status_code == 200
    assert isinstance(client.get('/api/runs').json(), list)


def test_sqlite_commit_failure_rolls_back_record_photo_and_request_for_safe_retry(state):
    client, database, uploads, _ = state
    assert client.get('/api/dashboard').status_code == 200
    with local_db(database) as db:
        db.execute("CREATE TRIGGER fail_request BEFORE INSERT ON request_receipts BEGIN SELECT RAISE(ABORT, 'storage failure'); END")
    data, photo = form(), [('p.png', png_bytes(), 'image/png')]
    response = inspect(client, data, photo)
    assert response.status_code == 503, response.text
    with local_db(database) as db:
        assert db.execute('SELECT COUNT(*) FROM records').fetchone()[0] == 5
        assert db.execute('SELECT COUNT(*) FROM photos').fetchone()[0] == 0
        db.execute('DROP TRIGGER fail_request')
    assert not uploads.exists() or not list(uploads.iterdir())
    assert inspect(client, data, photo).status_code == 200


def test_upload_storage_failure_never_reports_success(state):
    client, database, uploads, _ = state
    uploads.write_text('not a directory', encoding='utf-8')
    response = inspect(client, form(), [('p.png', png_bytes(), 'image/png')])
    assert response.status_code == 503
    with local_db(database) as db:
        assert db.execute('SELECT COUNT(*) FROM records').fetchone()[0] == 5


def test_cross_origin_mutations_are_rejected_and_missing_objects_are_404(state):
    client, *_ = state
    assert client.post('/api/runs', headers={'Origin':'https://other.example'}).status_code == 403
    assert client.get('/api/points/C99').status_code == 404
    assert client.get('/api/runs/missing').status_code == 404
    assert client.get('/api/evidence/images/not-an-image').status_code == 404

def test_dashboard_keeps_completed_review_visible_and_prefers_new_pending(state):
    client, *_ = state
    original = create_review(client)
    path = '/api/reviews/' + original['review_id'] + '/evidence'
    response = inspect(client, form(point_id='C03',conclusion='normal',version='1'),path=path)
    assert response.status_code == 200
    points = {p['point_id']:p for p in client.get('/api/dashboard').json()['points']}
    assert points['C03']['review']['status'] == 'completed'
    assert points['C03']['review']['conclusion'] == 'normal'
    pending = create_review(client,request_id='new-review')
    points = {p['point_id']:p for p in client.get('/api/dashboard').json()['points']}
    assert points['C03']['review']['review_id'] == pending['review_id']
    assert points['C03']['review']['status'] == 'pending'
    assert len(client.get('/api/points/C03').json()['reviews']) == 2

def test_existing_empty_records_are_not_reseeded_during_migration(state):
    client, database, uploads, _ = state
    with local_db(database) as db:
        db.execute('DELETE FROM records')
    with TestClient(api.create_app(db_path=database,uploads_dir=uploads,seed_demo=True)) as restarted:
        assert restarted.get('/api/dashboard').json()['covered'] == 0
        assert restarted.get('/api/points/C01').json()['records'] == []
        assert restarted.get('/api/runs/legacy-run').json()['summary'] == 'original summary'

@pytest.mark.parametrize('declared_length',[None,'1'])
def test_streamed_upload_limit_stops_reading_and_closes_spooled_files(state,monkeypatch,declared_length):
    # Catch limits applied only after parsing, or trust in missing/false Content-Length.
    import asyncio
    import httpx
    import starlette.formparsers as formparsers
    client,database,uploads,application = state
    monkeypatch.setattr(api.service,'PHOTO_LIMIT',256*1024)
    spool_directory = database.parent/'multipart-spools'
    spool_directory.mkdir()
    original_spool = formparsers.SpooledTemporaryFile
    opened = []
    def recorded_spool(*args,**kwargs):
        handle = original_spool(*args,dir=spool_directory,**kwargs)
        opened.append(handle)
        return handle
    monkeypatch.setattr(formparsers,'SpooledTemporaryFile',recorded_spool)
    boundary='inspection-stream-test'
    fields=form()
    preamble=''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n' for key,value in fields.items()).encode()
    preamble+=f'--{boundary}\r\nContent-Disposition: form-data; name="photos"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
    chunks=[preamble]+[b'x'*(64*1024)]*40+[f'\r\n--{boundary}--\r\n'.encode()]
    consumed=[]
    async def body():
        for chunk in chunks:
            consumed.append(len(chunk))
            yield chunk
    async def send():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application),base_url='http://testserver') as streaming:
            headers={'Content-Type':f'multipart/form-data; boundary={boundary}'}
            if declared_length is not None:
                headers['Content-Length']=declared_length
            request=streaming.build_request('POST','/api/inspections',content=body(),headers=headers)
            assert request.headers.get('content-length') == declared_length
            return await streaming.send(request)
    response=asyncio.run(send())
    assert response.status_code == 413,response.text
    assert sum(consumed) < sum(map(len,chunks)), 'server consumed the whole oversized stream before rejection'
    assert sum(consumed) <= 5*api.service.PHOTO_LIMIT+65536+64*1024
    assert opened and any(handle._rolled for handle in opened), 'fixture must exercise real disk-backed spool cleanup'
    assert all(handle.closed for handle in opened)
    assert list(spool_directory.iterdir()) == []
    with local_db(database) as db:
        assert db.execute('SELECT COUNT(*) FROM records').fetchone()[0] == 5
        assert db.execute('SELECT COUNT(*) FROM photos').fetchone()[0] == 0
        assert db.execute('SELECT COUNT(*) FROM request_receipts').fetchone()[0] == 0
    assert not uploads.exists() or not list(uploads.iterdir())