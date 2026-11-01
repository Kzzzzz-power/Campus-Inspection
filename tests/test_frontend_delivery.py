"""Entry resources must revalidate; task definitions never invent a judgment."""
from test_api import state
import pytest

@pytest.mark.parametrize('url', ['/', '/static/app.js', '/static/task-workbench.js', '/static/twin/campus-workbench.js', '/static/twin/campus-stage.css'])
def test_entry_resources_revalidate(state, url):
    client, *_ = state
    response = client.get(url)
    assert response.status_code == 200
    assert response.headers.get('cache-control') == 'no-cache, must-revalidate'
    again = client.get(url, headers={'If-None-Match': response.headers['etag']})
    assert again.status_code in (200,304)
    assert again.headers['cache-control'] == 'no-cache, must-revalidate'

def test_task_definitions_are_not_judgments(state):
    client, *_ = state
    result = client.get('/api/task-definitions')
    assert result.status_code == 200
    items = result.json()['items']
    assert [item['task_id'] for item in items] == ['T1','T2','T3','T4','T5']
    assert all(set(item) == {'task_id','name'} for item in items)
