"""Stage 01 current-state semantics, without writes to inspection history."""
from datetime import datetime, timedelta, timezone
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.runtime/stage01/unit'
RUNTIME.mkdir(parents=True, exist_ok=True)
os.environ['TEMP'] = os.environ['TMP'] = str(RUNTIME)
sys.path.insert(0, str(ROOT))
NOW = datetime(2026, 10, 29, 14, 0, tzinfo=timezone.utc)
TOPIC = 'nova/bb02/facility/switch-301/status'


def module():
    assert (ROOT / 'backend/realtime.py').is_file(), 'real-time receiver is not implemented'
    return importlib.import_module('backend.realtime')


def message(**changes):
    return {'facility_id':'switch-301','zone_id':'Z3','observed_at':NOW.isoformat(),
            'source_type':'SIMULATED','availability':'AVAILABLE','condition':'NORMAL',
            'metrics':{'latency_ms':18}, **changes}


def send(feed, value=None, topic=TOPIC, at=NOW):
    return feed.ingest(topic, json.dumps(value or message()).encode(), received_at=at)


def test_initial_state_contains_eight_unknown_points_not_invented_normality():
    feed = module().FacilityFeed()
    snapshot = feed.snapshot(NOW)
    assert len(snapshot['facilities']) == 8
    assert all(p['observation'] is None and p['freshness'] == 'missing' for p in snapshot['facilities'])
    assert snapshot['broker']['state'] == 'connecting'


@pytest.mark.parametrize('changes', [
    {'facility_id':'fake'}, {'zone_id':'Z1'}, {'condition':'OK'}, {'source_type':'LLM'},
    {'observed_at':'2026-10-29T14:00:00'}, {'observed_at':(NOW+timedelta(minutes=1)).isoformat()},
    {'metrics':{'latency_ms':float('nan')}}, {'metrics':{'latency_ms':True}}, {'covered':True},
    {'task_state':'established'}, {'availability':'ok'},
])
def test_untrusted_message_rejected_without_state_change(changes):
    feed = module().FacilityFeed()
    feed.mark_connection('connected')
    assert send(feed, message(**changes)) == 'rejected'
    assert all(p['observation'] is None for p in feed.snapshot(NOW)['facilities'])
    assert feed.snapshot(NOW)['diagnostics']['rejected'] == 1


def test_bad_json_unknown_topic_and_oversized_payload_do_not_crash_feed():
    feed = module().FacilityFeed()
    assert feed.ingest(TOPIC, b'{bad', received_at=NOW) == 'rejected'
    assert feed.ingest(TOPIC, b'['*2000+b'0'+b']'*2000, received_at=NOW) == 'rejected'
    assert send(feed, topic='nova/bb02/facility/hvac-2f/status') == 'rejected'
    assert feed.ingest(TOPIC, b'x'*20000, received_at=NOW) == 'rejected'
    assert send(feed) == 'accepted'


def test_order_duplicates_conflicts_stale_and_reconnection_preserve_business_value():
    feed = module().FacilityFeed(stale_after_seconds=10)
    feed.mark_connection('connected')
    assert send(feed, message(condition='WARNING', metrics={'latency_ms':87})) == 'accepted'
    assert send(feed, message(condition='WARNING', metrics={'latency_ms':87})) == 'duplicate'
    assert send(feed, message(condition='FAULT')) == 'rejected'
    assert send(feed, message(observed_at=(NOW-timedelta(seconds=1)).isoformat())) == 'out_of_order'
    def current(at=NOW):
        return next(p for p in feed.snapshot(at)['facilities'] if p['facility_id']=='switch-301')
    assert current()['observation']['condition'] == 'WARNING'
    assert current()['freshness'] == 'fresh'
    assert current(NOW+timedelta(seconds=11))['freshness'] == 'stale'
    feed.mark_connection('disconnected', 'test disconnect')
    assert current()['freshness'] == 'stale'
    assert current()['observation']['condition'] == 'WARNING'
    feed.mark_connection('connected')
    assert current()['freshness'] == 'stale', 'reconnect alone cannot claim a new observation'
    assert send(feed, message(observed_at=(NOW+timedelta(seconds=2)).isoformat()), at=NOW+timedelta(seconds=2)) == 'accepted'
    assert current(NOW+timedelta(seconds=2))['freshness'] == 'fresh'


def test_live_feed_http_websocket_do_not_write_records_or_coverage(monkeypatch):
    module()
    api = importlib.import_module('backend.main')
    with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
        root = Path(folder)
        app = api.create_app(root/'test.db', root/'uploads', seed_demo=False, realtime_enabled=False)
        with TestClient(app) as client:
            assert client.get('/api/current').status_code == 200
            before = client.get('/api/dashboard').json()
            run = client.post('/api/runs', json={'request_id':'stage01-freeze'}).json()
            app.state.facilities.mark_connection('connected')
            assert send(app.state.facilities) == 'accepted'
            with client.websocket_connect('/ws/facilities') as ws:
                pushed = ws.receive_json()
                assert pushed['type'] == 'facilities_snapshot'
                live = next(p for p in pushed['facilities'] if p['facility_id']=='switch-301')
                assert live['observation']['metrics']['latency_ms'] == 18
            assert client.get('/api/current').json()['diagnostics']['accepted'] == 1
            assert client.get('/api/dashboard').json()['covered'] == before['covered'] == 0
            assert client.get('/api/points/C07').json()['records'] == []
            assert client.get('/api/points/C07').json()['reviews'] == []
            assert client.get('/api/runs/'+run['run_id']).json()['snapshot'] == run['snapshot']
        with TestClient(api.create_app(root/'test.db', root/'uploads', seed_demo=False, realtime_enabled=False)) as restarted:
            assert all(p['observation'] is None for p in restarted.get('/api/current').json()['facilities'])


def test_simulator_uses_catalog_and_only_emits_observations():
    assert (ROOT/'simulators/facility_status.py').is_file(), 'MQTT simulator is missing'
    simulator = importlib.import_module('simulators.facility_status')
    rows = simulator.build_messages({'switch-301':{'condition':'WARNING','metrics':{'latency_ms':87}}}, at=NOW)
    assert len(rows) == 8
    changed = next(r for r in rows if r['facility_id']=='switch-301')
    assert changed['condition'] == 'WARNING' and changed['metrics']['latency_ms'] == 87
    assert changed['zone_id'] == 'Z3'
    assert all(not {'task_state','covered','required','critical'} & row.keys() for row in rows)
    with pytest.raises(ValueError):
        simulator.build_messages({'not-a-facility':{'condition':'NORMAL'}}, at=NOW)
    with pytest.raises(ValueError):
        simulator.build_messages({'switch-301':{'covered':True}}, at=NOW)


def test_deeply_nested_simulator_input_does_not_escape_validation():
    simulator = importlib.import_module('simulators.facility_status')
    with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
        override = Path(folder)/'overrides.json'
        override.write_text('['*2000+'0'+']'*2000, encoding='utf-8')
        with pytest.raises(ValueError):
            simulator.load_messages(override)
        override.write_text('{}', encoding='utf-8')
        assert len(simulator.load_messages(override)) == 8
