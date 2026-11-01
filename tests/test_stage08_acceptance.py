"""Stage08 fixed acceptance; all fixtures, processes and provider injections are test-only."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from backend.main import create_app

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {
    'S1': ['established'] * 5,
    'S2': ['blocked', 'established', 'established', 'established', 'established'],
    'S3': ['blocked', 'established', 'established', 'established', 'established'],
    'S4': ['blocked', 'established', 'established', 'established', 'established'],
    'S5': ['established', 'unknown', 'established', 'pending_verification', 'established'],
}


def artifact(name, value):
    output = os.environ.get('INSPECTGO_STAGE08_OUT')
    if output:
        directory = Path(output).resolve()
        assert directory.is_relative_to(ROOT / '.runtime')
        directory.mkdir(parents=True, exist_ok=True)
        (directory / (name + '.json')).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def post(c, path, payload):
    response = c.post(path, json=payload)
    assert response.status_code in (200, 202), response.text
    return response.json()


def prepare(c, scenario):
    return post(c, '/api/scenarios/' + scenario + '/prepare',
                {'instance_id': 'stage08-' + scenario, 'request_id': 'prepare-' + scenario})


def run(c, p, key, **extra):
    return post(c, '/api/runs', {'request_id': key, 'scenario_id': p['scenario_id'],
        'inspection_round_id': p['inspection_round_id'], 'as_of': p['as_of'], **extra})


def states(value):
    assert [t['task_id'] for t in value['task_results']] == ['T1', 'T2', 'T3', 'T4', 'T5']
    return [t['state'] for t in value['task_results']]


def record_ids(store):
    with store.transaction() as db:
        return [r[0] for r in db.execute('SELECT inspection_id FROM inspection_records ORDER BY inspection_id')]


def test_r01_r05_four_inputs_and_frozen_snapshots(tmp_path):
    app = create_app(tmp_path / 'acceptance.db', tmp_path / 'uploads', False, False)
    saved, prepared, changes = {}, {}, {}
    with TestClient(app) as c:
        for scenario in ('S1', 'S2', 'S3', 'S5'):
            prepared[scenario] = prepare(c, scenario)
            saved[scenario] = run(c, prepared[scenario], 'base-' + scenario)
            assert states(saved[scenario]) == EXPECTED[scenario]
        assert [p['state'] for p in saved['S3']['plan_results']] == ['executable', 'not_executable', 'not_executable']
        assert saved['S1']['coverage']['covered'] == 6
        history = [e for e in saved['S1']['evidence'] if e['checkpoint_id'] == 'C03' and e['evidence_type'] == 'historical_observation']
        assert history and any(e['value_json']['condition'] == 'WARNING' for e in history)
        assert any('C03' in x for x in saved['S5']['task_results'][4]['limitations'])
        assert next(e for e in saved['S5']['evidence'] if e['evidence_type'] == 'current_status')['status'] == 'unavailable'
        parent = saved['S3']
        with app.state.store.transaction() as db:
            parent_bytes = db.execute('SELECT result_json FROM runs WHERE run_id=?', (parent['run_id'],)).fetchone()[0]
        presets = json.loads((ROOT / 'config/scenarios/S4.json').read_text(encoding='utf-8-sig'))['presets']
        plan_states = [['executable', 'executable', 'not_executable'],
                       ['executable', 'not_executable', 'executable'],
                       ['not_executable', 'not_executable', 'not_executable']]
        for preset, expected in zip(presets, plan_states, strict=True):
            child = post(c, '/api/runs', {'request_id': 'whatif-' + preset['id'], 'scenario_id': 'S4',
                'run_type': 'what_if', 'parent_run_id': parent['run_id'], 'assumptions': preset['assumptions'], 'input_overrides': {}})
            assert states(child) == EXPECTED['S4']
            assert child['task_results'] == parent['task_results']
            assert [p['state'] for p in child['plan_results']] == expected
            assert {e['evidence_id']: e for e in parent['evidence']}.items() <= {e['evidence_id']: e for e in child['evidence']}.items()
            assert child['coverage'] == parent['coverage']
            saved['S4-' + preset['id']] = child
        with app.state.store.transaction() as db:
            assert db.execute('SELECT result_json FROM runs WHERE run_id=?', (parent['run_id'],)).fetchone()[0] == parent_bytes
        for name, scenario, override in [
            ('C07-access', 'S3', {'zone_access': [{'zone_id': 'Z3', 'access': 'ALLOWED'}]}),
            ('remaining-35-to-15', 'S3', {'remaining_minutes': 15}),
            ('P2-availability', 'S3', {'resources': {'P2': 'AVAILABLE'}}),
            ('C03-query-availability', 'S5', {'current_status_available': True}),
        ]:
            new = run(c, prepared[scenario], name, input_overrides=override)
            assert new['run_id'] != saved[scenario]['run_id']
            assert new['input_snapshot']['input_overrides'] != saved[scenario]['input_snapshot']['input_overrides']
            changes[name] = new
        access = next(x for x in changes['C07-access']['task_results'][0]['checks'] if x['dependency_id'] == 'T1.access')
        assert access['status'] == 'satisfied'
        assert all(p['state'] == 'not_executable' for p in changes['remaining-35-to-15']['plan_results'])
        assert changes['P2-availability']['plan_results'][1]['state'] == 'unknown'
        assert states(changes['C03-query-availability']) == EXPECTED['S5']
        assert any(e['evidence_type'] == 'current_status' and e['status'] == 'ok' for e in changes['C03-query-availability']['evidence'])
        for old in saved.values():
            assert c.get('/api/runs/' + old['run_id']).json() == old
            ids = {e['evidence_id'] for e in old['evidence']}
            for task in old['task_results']:
                for check in task['checks']:
                    assert check['evidence_refs'] and set(check['evidence_refs']) <= ids
        artifact('acceptance', {'test_only': True, 'db': str(app.state.store.path),
            'uploads': str(app.state.store.uploads), 'matrix_25_cells': EXPECTED, 'runs': saved,
            'input_changes': changes, 'inspection_ids': record_ids(app.state.store)})


@pytest.mark.parametrize('failure', ['weather', 'rag', 'ml', 'llm'])
def test_f03_f06_independent_test_only_provider_failure(tmp_path, monkeypatch, failure):
    from backend import analysis
    # Stub every provider: this acceptance never sends a paid or external AI request.
    for name in ('weather', 'rag', 'ml', 'llm'):
        monkeypatch.setattr(analysis, name, lambda *a, **k: {
            'status': 'ok', 'provider': 'test-only-stub', 'value': {'test_only': True}, 'error': None})
    app = create_app(tmp_path / 'analysis.db', tmp_path / 'uploads', False, False)
    with TestClient(app) as c:
        old = run(c, prepare(c, 'S3'), 'base')
        job = post(c, '/api/analyses', {'request_id': 'failure-' + failure,
            'source_run_id': old['run_id'], 'question': '测试：解释覆盖缺口', 'failure_mode': failure})
        new = c.get('/api/runs/' + job['run_id']).json()
        assert new['status'] == 'completed' and new['analysis']['status'] == 'degraded'
        assert [s['name'] for s in new['analysis']['steps'] if s['status'] != 'ok'] == [failure]
        assert states(new) == states(old)
        assert new['coverage'] == old['coverage']
        assert c.get('/api/runs/' + old['run_id']).json() == old
        artifact('failure-' + failure, {'test_only': True, 'real_provider_success_claimed': False,
            'source_run_id': old['run_id'], 'run_id': new['run_id'], 'analysis': new['analysis']})


def until(check, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.1)
    raise AssertionError('Timed out waiting for owned broker/receiver')


def test_f01_real_broker_stop_and_reconnect(tmp_path, monkeypatch):
    from paho.mqtt.publish import single
    from scripts.start_realtime import stop_child, WINDOW_FLAGS
    broker_python = Path(os.environ.get('INSPECTGO_BROKER_PYTHON', ROOT / '.runtime/broker-venv/Scripts/python.exe'))
    assert broker_python.is_file(), 'Set INSPECTGO_BROKER_PYTHON to the installed broker interpreter'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    monkeypatch.setenv('INSPECTGO_MQTT_HOST', '127.0.0.1')
    monkeypatch.setenv('INSPECTGO_MQTT_PORT', str(port))
    children = []
    with (tmp_path / 'broker.log').open('wb') as log:
        def start():
            child = subprocess.Popen([str(broker_python), '-B', '-m', 'simulators.broker', '--port', str(port)],
                cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, creationflags=WINDOW_FLAGS)
            children.append(child)
            return child
        broker = start()
        try:
            app = create_app(tmp_path / 'realtime.db', tmp_path / 'uploads', False, True)
            with TestClient(app) as c:
                until(lambda: c.get('/api/current').json()['broker']['state'] == 'connected')
                old = run(c, prepare(c, 'S1'), 'freeze')
                message = {'facility_id': 'switch-301', 'zone_id': 'Z3', 'observed_at': datetime.now(timezone.utc).isoformat(),
                    'source_type': 'SIMULATED', 'availability': 'AVAILABLE', 'condition': 'WARNING', 'metrics': {'latency_ms': 18}}
                def publish():
                    message['observed_at'] = datetime.now(timezone.utc).isoformat()
                    single('nova/bb02/facility/switch-301/status', json.dumps(message), hostname='127.0.0.1', port=port, qos=1)
                def point():
                    return next(f for f in c.get('/api/current').json()['facilities'] if f['facility_id'] == 'switch-301')
                publish()
                until(lambda: point()['freshness'] == 'fresh')
                before_ids = record_ids(app.state.store)
                dashboard_params = {'inspection_round_id': old['inspection_round_id'], 'as_of': old['as_of']}
                before_coverage = c.get('/api/dashboard', params=dashboard_params).json()
                stop_child('stage08-test-broker', broker)
                until(lambda: c.get('/api/current').json()['broker']['state'] == 'disconnected')
                disconnected = point()
                assert disconnected['freshness'] in ('stale', 'unavailable')
                assert disconnected['observation']['condition'] == 'WARNING'
                assert record_ids(app.state.store) == before_ids
                assert c.get('/api/dashboard', params=dashboard_params).json() == before_coverage
                assert c.get('/api/runs/' + old['run_id']).json() == old
                broker = start()
                until(lambda: c.get('/api/current').json()['broker']['state'] == 'connected')
                assert point()['freshness'] in ('stale', 'unavailable')
                publish()
                until(lambda: point()['freshness'] == 'fresh')
                assert c.get('/api/runs/' + old['run_id']).json() == old
                artifact('failure-broker', {'test_only': True, 'actual_broker_stopped': True, 'port': port,
                    'owned_pids': [p.pid for p in children], 'run_id': old['run_id'],
                    'disconnected': disconnected, 'recovered': point(), 'inspection_ids_unchanged': True})
        finally:
            for child in reversed(children):
                stop_child('stage08-test-broker', child)


@pytest.mark.parametrize('drift', ['modified', 'missing'])
def test_frozen_manifest_rejects_drift_without_rewriting(monkeypatch, drift):
    from scripts import verify_stage08
    original = (ROOT / 'config/scenarios/manifest.json').read_bytes()
    changed = verify_stage08.hashes()
    if drift == 'modified':
        changed['config/scenarios/S3.json'] = 'test-only-invalid-hash'
    else:
        del changed['config/scenarios/S5.json']
    monkeypatch.setattr(verify_stage08, 'hashes', lambda: changed)
    with pytest.raises(AssertionError, match='hash mismatch'):
        verify_stage08.verify_manifest()
    assert (ROOT / 'config/scenarios/manifest.json').read_bytes() == original

def test_manifest_hash_accepts_lf_and_crlf_checkout(tmp_path, monkeypatch):
    from scripts import verify_stage08
    monkeypatch.setattr(verify_stage08, 'ROOT', tmp_path)
    config = tmp_path / 'config'
    config.mkdir()
    source = config / 'test-only.json'
    source.write_bytes(b'{\n  "test_only": true\n}\n')
    lf_hashes = verify_stage08.hashes()
    source.write_bytes(source.read_bytes().replace(b'\n', b'\r\n'))
    assert verify_stage08.hashes() == lf_hashes


def freeze_test_only_manifest(tmp_path, monkeypatch):
    from scripts import verify_stage08
    monkeypatch.setattr(verify_stage08, 'ROOT', tmp_path)
    scenarios = tmp_path / 'config/scenarios'
    scenarios.mkdir(parents=True)
    for index in range(1, 6):
        (scenarios / ('S' + str(index) + '.json')).write_bytes(b'{"test_only": true}\n')
    manifest = {'schema_version': 1, 'algorithm': 'sha256-utf8-lf', 'files': verify_stage08.hashes()}
    (scenarios / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    return verify_stage08


def test_manifest_rejects_non_newline_content_change(tmp_path, monkeypatch):
    verifier = freeze_test_only_manifest(tmp_path, monkeypatch)
    verifier.verify_manifest()
    (tmp_path / 'config/scenarios/S3.json').write_bytes(b'{"test_only": false}\n')
    with pytest.raises(AssertionError, match='hash mismatch'):
        verifier.verify_manifest()


def test_manifest_runtime_rejects_eol_only_mutation(tmp_path, monkeypatch):
    from types import SimpleNamespace
    verifier = freeze_test_only_manifest(tmp_path, monkeypatch)
    monkeypatch.setattr(sys, 'argv', ['verify_stage08.py'])

    def failed_test_run(*args, **kwargs):
        # Test-only stand-in for a test process changing config while it runs.
        source = tmp_path / 'config/scenarios/S3.json'
        source.write_bytes(source.read_bytes().replace(b'\n', b'\r\n'))
        return SimpleNamespace(returncode=1)

    monkeypatch.setattr(verifier.subprocess, 'run', failed_test_run)
    with pytest.raises(AssertionError, match='Regression changed frozen configuration or manifest'):
        verifier.main()
    report_path = next((tmp_path / '.runtime/stage08-tests').glob('*/result.json'))
    report = json.loads(report_path.read_text(encoding='utf-8'))
    assert report['status'] == 'failed' and report['configuration_unchanged'] is False
    # The portable frozen hash still matches; the independent raw-byte guard caught this.
    verifier.verify_manifest()
