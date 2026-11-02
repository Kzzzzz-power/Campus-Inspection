"""Reproduce Stage08 cold restart using the actual supervisor and fresh test-only data.

Run: python -B tests/stage08-coldstart.py
Set INSPECTGO_PYTHON / INSPECTGO_BROKER_PYTHON when sharing installed environments.
Artifacts stay in a new .runtime/stage08-coldstart directory; existing runs are untouched.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, ProxyHandler
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.runtime'
WINDOW_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
HTTP = build_opener(ProxyHandler({}))


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def until(check, label, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.15)
    raise AssertionError('Timed out: ' + label)


def port_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=.3):
            return True
    except OSError:
        return False


def random_ports():
    # Reserve both simultaneously so the OS cannot hand the same port back twice.
    sockets = []
    try:
        for _ in range(2):
            sock = socket.socket()
            sockets.append(sock)
            sock.bind(('127.0.0.1', 0))
        ports = [sock.getsockname()[1] for sock in sockets]
        require(not {8016, 1886}.intersection(ports), 'Refuse the live service ports')
        return ports
    finally:
        for sock in sockets:
            sock.close()


def request(port, path, payload=None, content_type=None):
    if payload is not None and not isinstance(payload, bytes):
        payload = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        content_type = 'application/json'
    headers = {'Content-Type': content_type} if content_type else {}
    req = Request(f'http://127.0.0.1:{port}{path}', data=payload, headers=headers)
    try:
        with HTTP.open(req, timeout=5) as response:
            return response.read()
    except HTTPError as error:
        raise AssertionError(f'{req.method} {path}: HTTP {error.code}: '
                             + error.read().decode('utf-8', errors='replace')) from error


def api(port, path, payload=None):
    return json.loads(request(port, path, payload))


def multipart(fields, photo):
    boundary = 'stage08-' + uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode('utf-8'))
    parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="photos"; filename="test-only-not-onsite.png"\r\nContent-Type: image/png\r\n\r\n'.encode(),
                  photo, f'\r\n--{boundary}--\r\n'.encode()])
    return b''.join(parts), 'multipart/form-data; boundary=' + boundary


def database_snapshot(path):
    # Read-only connection: the acceptance never repairs or seeds SQLite directly.
    connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute('BEGIN')
        return {table: [dict(row) for row in connection.execute(f'SELECT * FROM {table} ORDER BY 1')]
                for table in ('runs', 'run_snapshots', 'records', 'inspection_records',
                              'evidence', 'photos', 'request_receipts', 'reviews', 'review_runs',
                              'inspection_rounds', 'scenario_instances', 'run_evidence',
                              'dependency_checks', 'task_results', 'plan_results', 'blockers',
                              'facility_observations', 'run_references', 'legacy_runs')}
    finally:
        connection.close()


def compare_database_snapshots(expected, actual):
    for table in expected:
        if table not in ('evidence', 'facility_observations'):
            canonical = lambda rows: sorted(json.dumps(row, sort_keys=True) for row in rows)
            require(canonical(actual[table]) == canonical(expected[table]), 'Persisted table changed: ' + table)
            continue
        identity = 'evidence_id' if table == 'evidence' else 'observation_id'
        before = {row[identity]: row for row in expected[table]}
        after = {row[identity]: row for row in actual[table]}
        require(all(after.get(key) == row for key, row in before.items()), 'Existing ' + table + ' changed or disappeared')
        if table == 'facility_observations':
            require(all(after[key]['source_type'] == 'SIMULATED' for key in after.keys() - before.keys()),
                    'Unexpected non-simulator observation')
            continue
        # The real simulator continues appending remote observations. Only those
        # new unbound rows are allowed; saved inspection/review proof stays exact.
        for key in after.keys() - before.keys():
            row = after[key]
            require(row['evidence_type'] == 'facility_status' and row['source_type'] == 'SIMULATED'
                    and row['observation_id'] and all(row[name] is None for name in
                    ('review_id', 'inspection_round_id', 'inspection_id')),
                    'Unexpected extra business evidence: ' + key)

def upload_snapshot(directory):
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(directory.iterdir()) if path.is_file()}


class Supervisor:
    def __init__(self, command, env, output, label, ports, report):
        self.command, self.env, self.ports = command, env, ports
        self.log_path = output / (label + '-launch.log')
        self.log = None
        self.process = None
        self.launch_dir = None
        self.entry = {'label': label, 'command': command, 'log': str(self.log_path),
                      'graceful': False, 'forced_cleanup': False}
        report['launches'].append(self.entry)

    def start(self):
        options = {'start_new_session': True}
        if os.name == 'nt':
            # A hidden private console lets CTRL_C reach only this owned supervisor.
            # CREATE_NO_WINDOW would detach it and prevent Python SIGINT handling.
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 0
            options = {'creationflags': subprocess.CREATE_NEW_CONSOLE, 'startupinfo': startup}
        self.log = self.log_path.open('wb')
        self.process = subprocess.Popen(self.command, cwd=ROOT, env=self.env,
            stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT, **options)
        self.entry['launcher_pid'] = self.process.pid
        self.readiness()

    def manifest(self):
        # Discover only the directory printed by this Popen's own stdout.
        if not self.launch_dir:
            for line in self.log_path.read_text(encoding='utf-8', errors='replace').splitlines():
                if line.startswith('Started broker (PID ') and '; log: ' in line:
                    directory = Path(line.split('; log: ', 1)[1]).parent.resolve()
                    require(directory.is_relative_to(RUNTIME / 'stage01'), 'Unexpected supervisor log directory')
                    self.launch_dir = directory
        if self.launch_dir:
            try:
                value = json.loads((self.launch_dir / 'processes.json').read_text(encoding='utf-8'))
            except (OSError, ValueError):
                return None
            require([value['web_port'], value['mqtt_port']] == self.ports, 'Supervisor port mismatch')
            self.entry.update(processes=value, supervisor_logs=str(self.launch_dir))
            return value
        return None

    def readiness(self):
        expected = {row['facility_id'] for row in json.loads((ROOT / 'config/facilities.json').read_text(encoding='utf-8-sig'))}
        require(len(expected) == 8, 'Acceptance expects eight configured facilities')

        def ready():
            require(self.process.poll() is None, f'Supervisor exited early; see {self.log_path}')
            manifest = self.manifest()
            if not manifest or set(manifest['children']) != {'broker', 'api', 'simulator'}:
                return False
            try:
                current = api(self.ports[0], '/api/current')
            except (OSError, URLError):
                return False
            facilities = current.get('facilities', [])
            if current.get('broker', {}).get('state') != 'connected' or {row['facility_id'] for row in facilities} != expected:
                return False
            if not all(row.get('freshness') == 'fresh' and row.get('observation', {}).get('source_type') == 'SIMULATED'
                       and row.get('storage', {}).get('status') == 'ok'
                       and row['storage'].get('observation_id') for row in facilities):
                return False
            database = Path(self.command[self.command.index('--db') + 1])
            connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
            try:
                for row in facilities:
                    saved = connection.execute('SELECT facility_id,payload_json FROM facility_observations WHERE observation_id=?',
                                               (row['storage']['observation_id'],)).fetchone()
                    require(saved is not None and saved[0] == row['facility_id']
                            and json.loads(saved[1]) == row['observation'], 'Fresh observation missing or different in SQLite')
            finally:
                connection.close()
            return current
        self.entry['observations'] = until(ready, 'supervisor, real broker and eight fresh simulator observations')

    def stop(self):
        if self.process is None:
            return
        try:
            self.manifest()
            require(self.process.poll() is None, 'Supervisor exited before requested shutdown')
            if os.name == 'nt':
                # Attach a short-lived hidden helper to the *private* console. Group 0
                # refers only to that console, never to the caller or another service.
                interrupt = ('import ctypes,sys,time; k=ctypes.WinDLL("kernel32",use_last_error=True); '
                             'k.FreeConsole(); '
                             'k.AttachConsole(int(sys.argv[1])) or sys.exit(ctypes.get_last_error() or 1); '
                             'k.SetConsoleCtrlHandler(None,True) or sys.exit(ctypes.get_last_error() or 1); '
                             'k.GenerateConsoleCtrlEvent(0,0) or sys.exit(ctypes.get_last_error() or 1); '
                             'time.sleep(.3); k.FreeConsole()')
                command = [self.command[0], '-B', '-c', interrupt, str(self.process.pid)]
                self.entry['interrupt_command'] = command
                result = subprocess.run(command, cwd=ROOT, env=self.env, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, creationflags=WINDOW_FLAGS, timeout=10)
                require(result.returncode == 0, 'Private console interrupt failed: ' + result.stdout.decode(errors='replace'))
            else:
                self.process.send_signal(signal.SIGINT)
            require(self.process.wait(timeout=25) == 0, 'Supervisor shutdown exit code is not zero')
            require(self.launch_dir is not None, 'Missing supervisor manifest')
            stopped = json.loads((self.launch_dir / 'stopped.json').read_text(encoding='utf-8'))
            require(set(stopped) == {'broker', 'api', 'simulator'} and all(code is not None for code in stopped.values()),
                    'Supervisor did not reap all three owned children')
            until(lambda: all(not port_open(p) for p in self.ports), 'both owned ports closed', timeout=10)
            self.entry.update(graceful=True, stopped=stopped, ports_closed=True)
        finally:
            if self.process.poll() is None:
                self.entry['forced_cleanup'] = True
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(self.process.pid), '/T', '/F'],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=WINDOW_FLAGS, timeout=15, check=True)
                else:
                    os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=10)
            if self.log:
                self.log.close()


def main():
    output = RUNTIME / 'stage08-coldstart' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S-%fZ-') + uuid4().hex[:8])
    output.mkdir(parents=True, exist_ok=False)
    database, uploads, overrides = output / 'isolated.db', output / 'uploads', output / 'remote-input.json'
    uploads.mkdir()
    overrides.write_text('{}\n', encoding='utf-8')
    python = Path(os.environ.get('INSPECTGO_PYTHON', sys.executable)).resolve()
    broker_default = RUNTIME / 'broker-venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    broker_python = Path(os.environ.get('INSPECTGO_BROKER_PYTHON', broker_default)).resolve()
    env = os.environ.copy()
    for key in list(env):
        if key.startswith('INSPECTGO_'):
            env.pop(key)
    env.update(INSPECTGO_PYTHON=str(python), INSPECTGO_BROKER_PYTHON=str(broker_python),
               INSPECTGO_LLM_ENABLED='false', INSPECTGO_VLM_ENABLED='false',
               TMP=str(output), TEMP=str(output), TMPDIR=str(output), PYTHONDONTWRITEBYTECODE='1',
               PYTHONIOENCODING='utf-8', PYTHONUNBUFFERED='1', PYTHONPATH=str(ROOT))
    report = {'status': 'failed', 'passed': False, 'test_only': True, 'output': str(output),
              'command': [sys.executable, '-B', str(Path(__file__).resolve())], 'launches': [], 'checks': [],
              'limits': ['Isolated synthetic S2 data and visibly labeled generated PNG; not onsite proof.',
                         'Real local broker/API/simulator; no live database or service is used.',
                         'WeChat developer tools/device/domain/AppID validation remains pending.',
                         'External AI/provider success and production deployment are not tested.',
                         'New unbound simulator telemetry may append; all prior evidence and business rows must remain identical.']}
    supervisors = []
    try:
        require(python.is_file() and broker_python.is_file(), 'Set installed INSPECTGO_PYTHON and INSPECTGO_BROKER_PYTHON interpreters')
        require(not database.exists() and not list(uploads.iterdir()), 'Acceptance must start with fresh storage')
        ports = random_ports()
        report['ports'] = dict(web=ports[0], mqtt=ports[1])
        command = [str(python), '-B', str(ROOT / 'scripts/start_realtime.py'), '--port', str(ports[0]),
                   '--mqtt-port', str(ports[1]), '--db', str(database), '--uploads', str(uploads), '--overrides', str(overrides)]
        fixture = output / 'labeled-test-fixture.png'
        generate = [str(python), '-B', '-c',
                    'from PIL import Image,ImageDraw; import sys; im=Image.new("RGB",(420,100),(235,240,245)); '
                    'ImageDraw.Draw(im).text((10,40),"AUTOMATED TEST FIXTURE - NOT ONSITE",fill=(0,0,0)); im.save(sys.argv[1])', str(fixture)]
        report['fixture_command'] = generate
        subprocess.run(generate, cwd=ROOT, env=env, creationflags=WINDOW_FLAGS, check=True, timeout=15)
        photo_bytes = fixture.read_bytes()
        report['image_sha256'] = hashlib.sha256(photo_bytes).hexdigest()
        first = Supervisor(command, env, output, 'first', ports, report)
        supervisors.append(first)
        first.start()
        require(api(ports[0], '/api/runs') == [], 'Fresh database unexpectedly contains runs')
        report['checks'].append('actual supervisor starts real broker/API/simulator with eight fresh observations')
        prepared = api(ports[0], '/api/scenarios/S2/prepare', {'instance_id': 'coldstart-test-only', 'request_id': 'coldstart-prepare'})
        run_payload = {'request_id': 'coldstart-old-run', 'scenario_id': 'S2',
                       'inspection_round_id': prepared['inspection_round_id'], 'as_of': prepared['as_of']}
        old = api(ports[0], '/api/runs', run_payload)
        old_path = '/api/runs/' + old['run_id']
        old_bytes = request(ports[0], old_path)
        require(old['status'] == 'completed' and old['run_type'] == 'reality', 'Initial S2 run did not complete')
        review = api(ports[0], '/api/reviews', {'point_id': 'C07', 'task_id': 'T4', 'trigger_run_id': old['run_id'],
                     'reason': 'Automated cold-start acceptance: test-only, not onsite', 'request_id': 'coldstart-review'})['review']
        fields = dict(point_id='C07', inspection_round_id=prepared['inspection_round_id'], inspector_id='TEST-ONLY',
                      inspected_at=datetime.now(timezone.utc).isoformat(), result='ok', conclusion='normal',
                      notes='AUTOMATED TEST FIXTURE - NOT ONSITE', onsite_confirmed='true',
                      version=str(review['version']), request_id='coldstart-photo-proof')
        body, content_type = multipart(fields, photo_bytes)
        endpoint = '/api/reviews/' + review['review_id'] + '/evidence'
        saved = json.loads(request(ports[0], endpoint, body, content_type))
        require(saved['photo_count'] == 1 and saved['review']['status'] == 'completed', 'Photo/review did not persist')
        require(saved['rerun']['status'] == 'completed', 'Review did not produce a completed reality run')
        new_path = '/api/runs/' + saved['rerun']['run_id']
        new_bytes = request(ports[0], new_path)
        new = json.loads(new_bytes)
        require(new['run_id'] != old['run_id'] and new['run_type'] == 'reality', 'Expected distinct reality runs')
        proof_ids = {saved['evidence_id'], saved['confirmation_evidence_id']}
        require(proof_ids <= {e['evidence_id'] for e in new['evidence']}, 'New run lacks saved proof IDs')
        image = saved['photos'][0]
        require(request(ports[0], image['url']) == photo_bytes, 'Saved photo bytes differ')
        require(request(ports[0], old_path) == old_bytes, 'Review mutated the old run')
        require(json.loads(request(ports[0], endpoint, body, content_type)) == saved, 'Initial exact retry changed receipt')
        review_path = '/api/reviews/' + review['review_id']
        review_bytes = request(ports[0], review_path)
        frozen_db, frozen_uploads = database_snapshot(database), upload_snapshot(uploads)
        (output / 'before-restart-database.json').write_text(json.dumps(frozen_db, ensure_ascii=False, indent=2), encoding='utf-8')
        require(len(frozen_uploads) == 1 and set(frozen_uploads.values()) == {report['image_sha256']}, 'Expected one matching persisted image')
        require(any(row['request_id'] == fields['request_id'] for row in frozen_db['request_receipts']), 'Missing durable proof receipt')
        for label, raw in [('old-run', old_bytes), ('new-run', new_bytes), ('review', review_bytes)]:
            (output / (label + '.json')).write_bytes(raw)
        report.update(old_run_id=old['run_id'], new_run_id=new['run_id'], review_id=review['review_id'],
                      image_id=image['image_id'], inspection_id=saved['inspection_id'], evidence_ids=sorted(proof_ids),
                      receipt_request_id=fields['request_id'], persisted_uploads=frozen_uploads,
                      run_sha256={'old': hashlib.sha256(old_bytes).hexdigest(), 'new': hashlib.sha256(new_bytes).hexdigest()})
        report['checks'].append('fresh S2 run, review, labeled PNG, evidence and exact retry persist without mutating old run')
        first.stop()
        report['checks'].append('first owned supervisor exits through cleanup and both ports close')
        compare_database_snapshots(frozen_db, database_snapshot(database))
        second = Supervisor(command, env, output, 'second', ports, report)
        supervisors.append(second)
        second.start()
        require(request(ports[0], old_path) == old_bytes and request(ports[0], new_path) == new_bytes, 'Cold restart changed run response bytes')
        require(request(ports[0], review_path) == review_bytes, 'Cold restart changed review/evidence IDs')
        require(request(ports[0], image['url']) == photo_bytes, 'Cold restart changed image bytes or ID')
        after_db = database_snapshot(database)
        (output / 'after-restart-database.json').write_text(json.dumps(after_db, ensure_ascii=False, indent=2), encoding='utf-8')
        compare_database_snapshots(frozen_db, after_db)
        require(json.loads(request(ports[0], endpoint, body, content_type)) == saved, 'Cold restart exact retry differs')
        require(api(ports[0], '/api/runs', run_payload) == old, 'Cold restart run receipt differs')
        compare_database_snapshots(after_db, database_snapshot(database))
        require(upload_snapshot(uploads) == frozen_uploads, 'Retry duplicated or changed uploaded image')
        report['checks'].append('cold restart preserves byte-identical old/new runs, review, image, evidence and idempotent receipts')
        second.stop()
        require(all(s.entry['graceful'] and not s.entry['forced_cleanup'] for s in supervisors), 'Forced cleanup cannot pass acceptance')
        compare_database_snapshots(after_db, database_snapshot(database))
        report['checks'].append('second supervisor exits cleanly, both owned ports close, persisted facts remain intact')
        report.update(status='passed', passed=True, owned_ports_closed=True)
    except BaseException:
        report['error'] = traceback.format_exc()
        print(report['error'], file=sys.stderr)
    finally:
        errors = []
        for supervisor in reversed(supervisors):
            if supervisor.process is not None and supervisor.process.poll() is None:
                try:
                    supervisor.stop()
                except BaseException:
                    errors.append(traceback.format_exc())
        if errors:
            report.update(status='failed', passed=False, cleanup_errors=errors)
        if 'ports' in report:
            report['owned_ports_closed'] = all(not port_open(p) for p in report['ports'].values())
            if not report['owned_ports_closed']:
                report.update(status='failed', passed=False)
        (output / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'status': report['status'], 'test_only': True, 'result': str(output / 'result.json')}, ensure_ascii=False), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())