"""Regression: a current S5 run must not copy the entire MQTT archive."""
from datetime import datetime, timedelta, timezone
import pytest
from fastapi.testclient import TestClient
from backend import evidence as ev, runs
from backend.main import create_app

@pytest.fixture
def ctx(tmp_path):
    app = create_app(tmp_path/'db.sqlite', tmp_path/'uploads', False, False)
    with TestClient(app) as client:
        yield client, app.state.store

def prepare(client):
    response = client.post('/api/scenarios/S5/prepare',
        json={'instance_id':'bounded-history', 'request_id':'prepare-history'})
    assert response.status_code == 200, response.text
    return response.json()

def observed(conn, when, condition='NORMAL', **extra):
    status = extra.pop('status', 'ok')
    return ev.add(conn, 'facility_status', 'DEVICE', 'mqtt-regression', when,
        {'condition':condition} if status == 'ok' else None,
        status=status, checkpoint_id='C01', facility_id='lighting-201',
        zone_id='Z1', retrieved_at=when, **extra)

def test_s5_snapshot_bounded_and_repeat_preserves_history(ctx):
    client, store = ctx
    prepared = prepare(client)
    start = datetime.now(timezone.utc) - timedelta(hours=2)
    with store.transaction(write=True) as db:
        for n in range(2000):
            last = observed(db, (start + timedelta(seconds=n)).isoformat())
    payload = {'request_id':'bounded-run', 'scenario_id':'S5',
        'inspection_round_id':prepared['inspection_round_id'], 'as_of':prepared['as_of']}
    response = client.post('/api/runs', json=payload)
    assert response.status_code == 200, response.text[:500]
    result = response.json()
    assert len(result['evidence']) < 100
    assert len(response.content) < 200_000
    assert [t['state'] for t in result['task_results']] == [
        'established', 'unknown', 'established', 'pending_verification', 'established']
    assert any(last['evidence_id'] in e['provenance_json'].get('basis_evidence_ids', [])
               for e in result['evidence'])
    assert client.post('/api/runs', json=payload).json() == result
    second = client.post('/api/runs', json={**payload, 'request_id':'next-run'}).json()
    assert len(second['evidence']) < 100
    assert client.get('/api/runs/'+result['run_id']).json() == result
    with store.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM evidence WHERE inspection_round_id IS NULL AND source_id='mqtt-regression'").fetchone()[0] == 2000

def test_selection_keeps_anomaly_failure_ties_and_cutoff(ctx):
    client, store = ctx
    prepared = prepare(client)
    when = datetime.now(timezone.utc) - timedelta(minutes=10)
    with store.transaction(write=True) as db:
        alert = observed(db, when.isoformat(), 'WARNING')
        old = observed(db, (when+timedelta(seconds=1)).isoformat())
        current = observed(db, (when+timedelta(seconds=2)).isoformat(), status='unavailable')
        tie = observed(db, current['observed_at'], 'FAULT')
        future = observed(db, (when+timedelta(seconds=3)).isoformat())
        historical = ev.add(db, 'historical_observation', 'DEVICE', 'archive',
            when.isoformat(), {'condition':'WARNING'}, checkpoint_id='C02', facility_id='hvac-2f',
            retrieved_at=when.isoformat())
        _, _, proofs, _ = runs.round_facts(db, prepared['inspection_round_id'], current['observed_at'])
    ids = {p['evidence_id'] for p in proofs}
    assert {alert['evidence_id'], current['evidence_id'], tie['evidence_id'], historical['evidence_id']} <= ids
    assert old['evidence_id'] not in ids
    assert future['evidence_id'] not in ids

def test_selection_retains_manual_basis_from_earlier_run(ctx):
    client, store = ctx
    prepared = prepare(client)
    rid = prepared['inspection_round_id']
    when = ev.now()
    with store.transaction(write=True) as db:
        basis = observed(db, when, 'WARNING', inspection_round_id=rid, provenance={'run_id':'old-run'})
        unused = observed(db, when, inspection_round_id=rid, provenance={'run_id':'old-run'})
        confirmation = ev.add(db, 'review_confirmation', 'ON_SITE', 'inspector', when,
            {'conclusion':'confirmed_abnormal','basis_evidence_ids':[basis['evidence_id']]}, inspection_round_id=rid, checkpoint_id='C01',
            facility_id='lighting-201', retrieved_at=when,
            provenance={'port':'/api/evidence/manual'},
            valid_until=(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat())
        _, _, proofs, _ = runs.round_facts(db, rid, when)
    ids = {p['evidence_id'] for p in proofs}
    assert {basis['evidence_id'], confirmation['evidence_id']} <= ids
    assert unused['evidence_id'] not in ids
    response = client.post('/api/runs', json={'request_id':'manual-basis-run',
        'scenario_id':'S5', 'inspection_round_id':rid, 'as_of':prepared['as_of']})
    assert response.status_code == 200, response.text[:500]
    result = response.json()
    assert 'C01' in result['statistics']['anomaly_points']
    assert 'C01' not in result['task_results'][1]['unresolved_checkpoint_ids']

def test_selection_does_not_hide_untraceable_history(ctx):
    client, store = ctx
    prepared = prepare(client)
    when = ev.now()
    with store.transaction(write=True) as db:
        broken = ev.add(db, 'facility_status', 'DEVICE', '', '2026-01-01T00:00:00+00:00',
            {'condition':'NORMAL'}, checkpoint_id='C01', facility_id='lighting-201')
        observed(db, when)
        _, _, proofs, _ = runs.round_facts(db, prepared['inspection_round_id'], when)
    assert broken['evidence_id'] in {p['evidence_id'] for p in proofs}



def test_selection_retains_microsecond_traceability_failure(ctx):
    client, store = ctx
    prepared = prepare(client)
    with store.transaction(write=True) as db:
        broken = ev.add(db, 'facility_status', 'DEVICE', 'clock-skew',
            '2026-10-29T01:10:00.000002+00:00', {'condition':'NORMAL'},
            checkpoint_id='C01', facility_id='lighting-201',
            retrieved_at='2026-10-29T01:10:00.000001+00:00')
        observed(db, ev.now())
        _, _, proofs, _ = runs.round_facts(db, prepared['inspection_round_id'], ev.now())
    assert broken['evidence_id'] in {p['evidence_id'] for p in proofs}