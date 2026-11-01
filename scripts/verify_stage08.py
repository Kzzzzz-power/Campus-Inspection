"""Reproduce Stage08 in isolated storage; never rewrite the frozen scenario manifest.
Run with the project Python; set INSPECTGO_BROKER_PYTHON for a shared broker venv.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


def config_bytes():
    return {p.relative_to(ROOT).as_posix(): p.read_bytes()
            for p in sorted((ROOT / 'config').rglob('*.json'))}


def hashes():
    # Portable checkout hash: normalize only line endings, never JSON content.
    return {name: hashlib.sha256(raw.decode('utf-8').replace('\r\n', '\n').replace('\r', '\n').encode('utf-8')).hexdigest()
            for name, raw in config_bytes().items() if name != 'config/scenarios/manifest.json'}


def verify_manifest():
    manifest = json.loads((ROOT / 'config/scenarios/manifest.json').read_text(encoding='utf-8-sig'))
    assert manifest['algorithm'] == 'sha256-utf8-lf'
    assert manifest['files'] == hashes(), 'Frozen config/scenario hash mismatch; do not regenerate at runtime'
    assert all('config/scenarios/S' + str(n) + '.json' in manifest['files'] for n in range(1, 6))
    return manifest


def cold_read(path):
    from fastapi.testclient import TestClient
    from backend.main import create_app
    expected = json.loads(path.read_text(encoding='utf-8'))
    db = Path(expected['db']).resolve()
    uploads = Path(expected['uploads']).resolve()
    assert db.is_relative_to(ROOT / '.runtime') and uploads.is_relative_to(ROOT / '.runtime')
    with TestClient(create_app(db, uploads, False, False)) as client:
        for value in [*expected['runs'].values(), *expected['input_changes'].values()]:
            actual = client.get('/api/runs/' + value['run_id'])
            assert actual.status_code == 200 and actual.json() == value, value['run_id']
        with client.app.state.store.transaction() as conn:
            ids = [r[0] for r in conn.execute('SELECT inspection_id FROM inspection_records ORDER BY inspection_id')]
        assert ids == expected['inspection_ids']
    print('Fresh-process cold read preserved all snapshots and inspection IDs', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cold-read', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    frozen = verify_manifest()
    original_config_bytes = config_bytes()
    if args.cold_read:
        cold_read(args.cold_read)
        return 0
    output = ROOT / '.runtime/stage08-tests' / datetime.now(timezone.utc).strftime('verify-%Y%m%dT%H%M%S-%fZ')
    output.mkdir(parents=True)
    env = os.environ.copy()
    env.update(PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8', PYTHONPATH=str(ROOT),
               TMP=str(output), TEMP=str(output), INSPECTGO_STAGE08_OUT=str(output), INSPECTGO_SEED_DEMO='false')
    env.pop('INSPECTGO_MAINTENANCE_FILE', None)
    env.pop('INSPECTGO_DB', None)
    env.pop('INSPECTGO_UPLOADS', None)
    tests = ['tests/test_stage08_acceptance.py', 'tests/test_storage_failure_receipts.py',
        'tests/test_stage03_runs.py::test_run_write_failure_never_reports_completed_or_consumes_request',
        'tests/test_stage06_weather.py', 'tests/test_stage06_rag.py', 'tests/test_stage06_ml.py', 'tests/test_stage06_llm.py']
    command = [sys.executable, '-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--basetemp', str(output / 'pytest'),
               '--junitxml', str(output / 'pytest.xml'), *[str(ROOT / p) for p in tests]]
    result = {'test_only': True, 'output': str(output), 'manifest': frozen, 'command': command,
              'miniapp': 'not_checked_by_this_entry', 'real_external_AI': 'not_called', 'status': 'failed'}
    try:
        with (output / 'pytest.log').open('w', encoding='utf-8') as log:
            code = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=FLAGS).returncode
        result['pytest_exit_code'] = code
        print((output / 'pytest.log').read_text(encoding='utf-8'), flush=True)
        if code:
            return code
        cold_command = [sys.executable, '-B', str(Path(__file__).resolve()), '--cold-read', str(output / 'acceptance.json')]
        with (output / 'cold-start.log').open('w', encoding='utf-8') as log:
            for _ in range(2):
                check = subprocess.run(cold_command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=FLAGS)
                assert check.returncode == 0, 'Fresh-process cold read failed; inspect cold-start.log'
        result['cold_start_fresh_processes'] = 2
        verify_manifest()
        result['status'] = 'passed'
        return 0
    finally:
        try:
            result['configuration_unchanged'] = config_bytes() == original_config_bytes
            if not result['configuration_unchanged']:
                result['status'] = 'failed'
                raise AssertionError('Regression changed frozen configuration or manifest')
        finally:
            (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            print('REPORT ' + str(output / 'result.json'), flush=True)


if __name__ == '__main__':
    raise SystemExit(main())
