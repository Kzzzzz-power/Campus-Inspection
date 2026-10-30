"""A probe response may reference only evidence whose transaction committed."""
import sqlite3
import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.main import create_app

@pytest.mark.parametrize('failure_sql', [
    "CREATE TRIGGER reject_history BEFORE INSERT ON evidence WHEN NEW.evidence_type='history_query' BEGIN SELECT RAISE(ABORT,'history proof rejected'); END",
    "CREATE TRIGGER reject_cleanup BEFORE DELETE ON storage_probes BEGIN SELECT RAISE(ABORT,'cleanup rejected'); END",
])
def test_probe_failure_never_returns_rolled_back_evidence(tmp_path, failure_sql):
    with TestClient(create_app(tmp_path/'db.sqlite', tmp_path/'uploads', False, False)) as client:
        with sqlite3.connect(client.app.state.store.path) as conn:
            conn.execute(failure_sql)
        response = client.post('/api/evidence/storage-check', json={})
        assert response.status_code == 503
        saved = {item['evidence_id']: item for item in client.get('/api/evidence').json()['items']}
        for item in response.json()['detail']['evidence']:
            assert item['evidence_id'] in saved, 'Response exposed an uncommitted evidence ID'
            assert saved[item['evidence_id']] == item
