"""B02 facility configuration and confirmed-alert fixture contracts."""
import copy
from datetime import datetime
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.runtime' / 'baseline-tests'
RUNTIME.mkdir(parents=True, exist_ok=True)
os.environ['TEMP'] = os.environ['TMP'] = str(RUNTIME)
tempfile.tempdir = str(RUNTIME)
sys.path.insert(0, str(ROOT / 'backend'))
import main as api

EXPECTED = [
    ('C01', 'lighting-201', 'Z1', True),
    ('C02', 'hvac-2f', 'Z1', True),
    ('C03', 'ap-2f', 'Z1', False),
    ('C04', 'lab-power-101', 'Z2', True),
    ('C05', 'access-101', 'Z2', True),
    ('C06', 'exhaust-101', 'Z2', False),
    ('C07', 'switch-301', 'Z3', True),
    ('C08', 'hvac-301', 'Z3', True),
]


@pytest.fixture
def baseline_state():
    with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
        root = Path(folder)
        app = api.create_app(root / 'test.db', root / 'uploads', seed_demo=False)
        with TestClient(app) as client:
            yield client, app, root


def get_s1(client):
    response = client.get('/api/scenarios/S1')
    assert response.status_code == 200, 'the frozen teaching baseline must be queryable'
    return response.json()


def test_facility_config_drives_all_read_interfaces(baseline_state):
    client, app, root = baseline_state
    response = client.get('/api/facilities')
    assert response.status_code == 200, 'facility configuration API is missing'
    facilities = response.json()
    assert [(f['checkpoint_id'], f['facility_id'], f['zone_id'], f['critical']) for f in facilities] == EXPECTED
    zones = client.get('/api/zones').json()
    assert {z: [p['id'] for p in value['points']] for z, value in zones.items()} == {
        'Z1': ['C01', 'C02', 'C03'], 'Z2': ['C04', 'C05', 'C06'], 'Z3': ['C07', 'C08']}
    assert [zones[z]['name'] for z in zones] == ['教学楼二层', '实训楼一层', '实训楼二层']
    points = client.get('/api/dashboard').json()['points']
    for point, expected in zip(points, EXPECTED):
        assert (point['point_id'], point['facility_id'], point['zone_id'], point['required']) == expected
        assert client.get('/api/points/' + point['point_id']).json()['point']['facility_id'] == expected[1]
    assert client.get('/api/coverage').json()['required_total'] == 6


def catalog_module():
    assert (ROOT / 'backend' / 'configuration.py').is_file(), 'validated configuration loader is missing'
    return importlib.import_module('configuration')


@pytest.mark.parametrize('damage', ['duplicate_point', 'duplicate_facility', 'unknown_zone', 'string_flag', 'missing_point', 'bad_distribution'])
def test_invalid_catalog_fails_without_hardcoded_fallback(damage):
    module = catalog_module()
    facilities = json.loads((ROOT / 'config/facilities.json').read_text(encoding='utf-8'))
    zones = json.loads((ROOT / 'config/zones.json').read_text(encoding='utf-8'))
    if damage == 'duplicate_point': facilities[1]['checkpoint_id'] = facilities[0]['checkpoint_id']
    if damage == 'duplicate_facility': facilities[1]['facility_id'] = facilities[0]['facility_id']
    if damage == 'unknown_zone': facilities[0]['zone_id'] = 'Z99'
    if damage == 'string_flag': facilities[0]['critical'] = 'false'
    if damage == 'missing_point': facilities.pop()
    if damage == 'bad_distribution': facilities[0]['zone_id'] = 'Z2'
    with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
        path = Path(folder)
        (path / 'facilities.json').write_text(json.dumps(facilities), encoding='utf-8')
        (path / 'zones.json').write_text(json.dumps(zones), encoding='utf-8')
        with pytest.raises(ValueError):
            module.load_catalog(path)


def test_required_flags_are_read_from_config_not_a_second_python_list():
    module = catalog_module()
    with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
        path = Path(folder)
        facilities = json.loads((ROOT / 'config/facilities.json').read_text(encoding='utf-8'))
        facilities[0]['critical'], facilities[2]['critical'] = False, True
        (path / 'facilities.json').write_text(json.dumps(facilities), encoding='utf-8')
        (path / 'zones.json').write_bytes((ROOT / 'config/zones.json').read_bytes())
        catalog = module.load_catalog(path)
        assert catalog['points']['C01']['required'] is False
        assert catalog['points']['C03']['required'] is True


def test_s1_is_frozen_input_with_linked_alarm_and_confirmation_not_task_results(baseline_state):
    client, app, root = baseline_state
    digest = hashlib.sha256((root / 'test.db').read_bytes()).hexdigest()
    scenario = get_s1(client)
    assert scenario['source_type'] == 'SIMULATED'
    assert scenario['scope'] == 'facility_baseline_input'
    assert not {'task_results', 'run_id', 'coverage_rate'} & scenario.keys()
    round_ = scenario['inspection_round']
    assert round_['window_start'].endswith('T09:00:00+08:00')
    assert round_['window_end'].endswith('T09:45:00+08:00')
    assert len(scenario['facility_observations']) == 8
    alarm = scenario['historical_observations'][0]
    assert (alarm['facility_id'], alarm['payload_json']['condition']) == ('ap-2f', 'WARNING')
    current = next(o for o in scenario['facility_observations'] if o['facility_id'] == 'ap-2f')
    assert current['payload_json']['condition'] == 'NORMAL'
    review = scenario['review_requests'][0]
    assert review['status'] == 'completed'
    assert review['trigger_run_id'] is None
    evidence = {e['evidence_id']: e for e in scenario['evidence']}
    confirmation = evidence[review['completion_evidence_id']]
    assert confirmation['review_id'] == review['review_id']
    assert confirmation['status'] == 'ok'
    assert confirmation['value_json']['conclusion'] == 'ruled_out'
    assert confirmation['value_json']['historical_alarm_confirmed'] is True
    assert confirmation['value_json']['historical_observation_id'] == alarm['observation_id']
    assert datetime.fromisoformat(alarm['observed_at']) < datetime.fromisoformat(confirmation['observed_at']) <= datetime.fromisoformat(scenario['as_of'])
    assert client.get('/api/scenarios/S2').status_code == 404
    assert hashlib.sha256((root / 'test.db').read_bytes()).hexdigest() == digest
    assert get_s1(client) == scenario


@pytest.mark.parametrize('damage', ['missing_confirmation', 'wrong_facility', 'unavailable_as_normal', 'outside_round', 'wrong_round', 'future_observation', 'wrong_basis', 'late_basis', 'late_confirmation', 'unlinked_review'])
def test_broken_s1_evidence_chain_is_rejected(baseline_state, damage):
    client, *_ = baseline_state
    scenario = copy.deepcopy(get_s1(client))
    if damage == 'missing_confirmation': scenario['evidence'].pop()
    if damage == 'wrong_facility': scenario['inspection_records'][2]['facility_id'] = 'hvac-2f'
    if damage == 'unavailable_as_normal': scenario['evidence'][-1]['status'] = 'unavailable'
    if damage == 'outside_round': scenario['inspection_records'][0]['inspected_at'] = '2026-10-29T08:00:00+08:00'
    if damage == 'wrong_round': scenario['inspection_records'][0]['inspection_round_id'] = 'ANOTHER-ROUND'
    if damage == 'future_observation': scenario['facility_observations'][0]['observed_at'] = '2026-10-29T09:40:00+08:00'
    if damage == 'wrong_basis':
        row = scenario['evidence'][1]
        row['observed_at'] = scenario['historical_observations'][0]['observed_at']
        row['value_json'].update(observation_id='S1-HISTORY-C03-NETWORK', condition='WARNING')
    if damage == 'late_basis':
        scenario['evidence'][1]['retrieved_at'] = scenario['evidence'][1]['created_at'] = '2026-10-29T09:09:30+08:00'
    if damage == 'late_confirmation':
        scenario['evidence'][-1]['created_at'] = '2026-10-29T09:09:30+08:00'
    if damage == 'unlinked_review':
        scenario['evidence'][2]['review_id'] = None
    module = importlib.import_module('baseline')
    with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
        path = Path(folder) / 'S1.json'
        path.write_text(json.dumps(scenario), encoding='utf-8')
        with pytest.raises(ValueError):
            module.load_s1(path)


def test_s1_records_and_review_survive_restart_without_erasing_historical_alarm(baseline_state, monkeypatch):
    client, app, root = baseline_state
    scenario = get_s1(client)
    monkeypatch.setattr(api.service, 'utcnow', lambda: datetime.fromisoformat(scenario['as_of']))
    with app.state.store.transaction(write=True) as conn:
        for row in scenario['historical_observations'] + scenario['facility_observations']:
            point = next(p for p, f, _, _ in EXPECTED if f == row['facility_id'])
            conn.execute('INSERT INTO records (point_id,status,source,evidence,created_at,inspected_at,is_legacy) VALUES (?,?,?,?,?,?,0)',
                         (point, {'NORMAL':'ok','WARNING':'alarm'}[row['payload_json']['condition']], 'remote',
                          row['observation_id'], row['observed_at'], row['observed_at']))
    client.post('/api/rounds',json={'round_id':'baseline-round','date':'2026-10-29'})
    query='?inspection_round_id=baseline-round&as_of=2026-10-29T01:10:00Z'
    assert client.get('/api/dashboard'+query).json()['covered'] == 0, 'remote observations cannot cover required points'
    for row in scenario['inspection_records']:
        result = client.post('/api/inspections', data={
            'point_id': row['checkpoint_id'], 'inspector_id': row['inspector_id'], 'inspected_at': row['inspected_at'],
            'result': 'ok', 'notes': row['notes'], 'onsite_confirmed': 'true', 'request_id': row['inspection_id'],'inspection_round_id':'baseline-round'})
        assert result.status_code == 200, result.text
    fixture_review = scenario['review_requests'][0]
    review = client.post('/api/reviews', json={'point_id': 'C03', 'reason': fixture_review['reason'], 'request_id': 's1-review'}).json()['review']
    result = client.post('/api/reviews/' + review['review_id'] + '/evidence', data={
        'point_id': 'C03', 'inspector_id': 'P1', 'inspected_at': fixture_review['completed_at'],
        'result': 'ok', 'conclusion': 'normal', 'notes': 'SIMULATED: historical alert confirmed; current abnormality ruled out',
        'onsite_confirmed': 'true', 'version': '1', 'request_id': 's1-review-confirmation'})
    assert result.status_code == 200, result.text
    assert client.get('/api/dashboard'+query).json()['covered'] == 6
    detail = client.get('/api/points/C03').json()
    assert detail['point']['latest_status'] == 'ok'
    assert detail['point']['review']['status'] == 'completed'
    assert any(r['status'] == 'alarm' and r['source'] == 'remote' for r in detail['records'])
    with TestClient(api.create_app(root / 'test.db', root / 'uploads', seed_demo=False)) as restarted:
        assert restarted.get('/api/points/C03').json() == detail
        assert restarted.get('/api/dashboard'+query).json()['covered'] == 6
        assert get_s1(restarted) == scenario
