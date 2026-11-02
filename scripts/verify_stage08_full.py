"""Run the Stage08 local acceptance suites; never equate this with WeChat/user acceptance.

Requires the existing project Python, Broker Python, Node (with fetch/WebSocket), and Chrome.
All fixtures are isolated under .runtime; no writes to the 8016 demonstration database.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
WINDOW_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


def executable(value):
    found = shutil.which(str(value)) or str(value)
    candidate = Path(found).resolve()
    if not candidate.is_file():
        raise ValueError(f'Executable not found: {value}')
    return str(candidate)


def terminate_owned(process):
    if process.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=WINDOW_FLAGS, timeout=20, check=False)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if os.name != 'nt':
            os.killpg(process.pid, signal.SIGKILL)
        process.kill()
        process.wait(timeout=10)


def run_job(name, command, output, env, artifact_pattern=None):
    before = set(ROOT.glob(artifact_pattern)) if artifact_pattern else set()
    record = {'name': name, 'command': command, 'status': 'failed',
              'started_at': datetime.now(timezone.utc).isoformat(), 'reports': []}
    log_path = output / (name + '.log')
    record['log'] = str(log_path.relative_to(ROOT))
    print('START ' + name, flush=True)
    with log_path.open('w', encoding='utf-8') as log:
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=subprocess.STDOUT,
                                   creationflags=WINDOW_FLAGS, start_new_session=os.name != 'nt')
        try:
            record['exit_code'] = process.wait(timeout=600)
        except subprocess.TimeoutExpired:
            record['error'] = 'Acceptance timed out (600 seconds); owned process tree stopped'
            terminate_owned(process)
        except BaseException:
            terminate_owned(process)
            raise
    if artifact_pattern:
        # Only accept reports created by this invocation, never historical passes.
        produced = sorted(set(ROOT.glob(artifact_pattern)) - before)
        for path in produced:
            artifact = json.loads(path.read_text(encoding='utf-8-sig'))
            record['reports'].append({'path': str(path.relative_to(ROOT)),
                                      'status': artifact.get('status'),
                                      'checks': artifact.get('checks', [])})
        valid_reports = bool(produced) and all(r['status'] == 'passed' for r in record['reports'])
    else:
        valid_reports = True
    if record.get('exit_code') == 0 and valid_reports:
        record['status'] = 'passed'
    elif 'error' not in record:
        record['error'] = 'Nonzero exit or missing/failed fresh report; inspect log'
    record['finished_at'] = datetime.now(timezone.utc).isoformat()
    print(record['status'].upper() + ' ' + name + ' | ' + record['log'], flush=True)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', default=os.environ.get('INSPECTGO_NODE', 'node'))
    parser.add_argument('--chrome', default=os.environ.get('INSPECTGO_CHROME',
                        r'C:\Program Files\Google\Chrome\Application\chrome.exe' if os.name == 'nt' else 'google-chrome'))
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S-%fZ')
    output = ROOT / '.runtime' / 'stage08-complete' / stamp
    output.mkdir(parents=True)
    report = {'status': 'failed', 'scope': 'local_engineering_acceptance', 'test_only': True,
              'started_at': datetime.now(timezone.utc).isoformat(), 'jobs': [],
              'complete_acceptance': False,
              'pending': ['Real WeChat AppID, platform compilation and real-device Camera/upload validation',
                          'Approved WeChat ASR/TTS configuration and actual speech validation',
                          'Reachable authenticated HTTPS backend for real phone access',
                          'Final user/teacher Golden Demo, Failure Demo and Modify-Run-Verify acceptance'],
              'limits': ['External AI failure regression uses controlled test providers, not paid live AI calls',
                         'Node wx HTTP adapter is not WeChat DevTools or real-device execution',
                         'Headless Chrome uses software WebGL; this is not a device-performance benchmark',
                         'No Git commit, merge, push, release or cloud deployment is performed']}
    try:
        node, chrome = executable(args.node), executable(args.chrome)
        broker = executable(os.environ.get('INSPECTGO_BROKER_PYTHON',
                             ROOT / '.runtime' / 'broker-venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')))
        env = dict(os.environ, INSPECTGO_PYTHON=sys.executable, INSPECTGO_BROKER_PYTHON=broker,
                   INSPECTGO_CHROME=chrome, PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8',
                   INSPECTGO_LLM_ENABLED='false', INSPECTGO_VLM_ENABLED='false',
                   INSPECTGO_SEED_DEMO='false', TEMP=str(output), TMP=str(output), TMPDIR=str(output))
        for key in ('INSPECTGO_DB', 'INSPECTGO_UPLOADS', 'INSPECTGO_MAINTENANCE_FILE',
                    'INSPECTGO_STAGE08_OUT', 'INSPECTGO_LLM_ENV_FILE'):
            env.pop(key, None)
        git = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], cwd=ROOT,
                             capture_output=True, text=True, creationflags=WINDOW_FLAGS, timeout=10)
        report['source_head'] = git.stdout.strip() if git.returncode == 0 else 'unavailable'
        changes = subprocess.run(['git', '-C', str(ROOT), 'status', '--porcelain', '-uall'], cwd=ROOT,
                                 capture_output=True, text=True, encoding='utf-8', errors='replace',
                                 creationflags=WINDOW_FLAGS, timeout=10)
        report['source_changes'] = changes.stdout.splitlines() if changes.returncode == 0 else ['unavailable']
        report['worktree'] = str(ROOT)
        report['executables'] = {'python': sys.executable, 'broker': broker, 'node': node, 'chrome': chrome}
        js_tests = sorted(str(p) for p in (ROOT / 'tests').iterdir() if p.name.endswith(('.test.mjs', '.test.cjs')))
        jobs = [
            ('scenarios_failures', [sys.executable, '-B', str(ROOT / 'scripts/verify_stage08.py')], '.runtime/stage08-tests/*/result.json'),
            ('frontend_native_units', [node, '--test', *js_tests], None),
            ('campus_business', [node, str(ROOT / 'tests/campus-workbench-browser.cjs')], '.runtime/campus-workbench/flow-*/result.json'),
            ('whatif_and_recovery', [node, str(ROOT / 'tests/stage07-browser.cjs')], '.runtime/stage07-browser/flow-*/result.json'),
            ('frozen_views', [node, str(ROOT / 'tests/stage08-browser.cjs')], '.runtime/stage08-browser/flow-*/result.json'),
            ('mqtt_websocket_alerts', [node, str(ROOT / 'tests/campus-alerts-browser.cjs')], '.runtime/campus-alerts/alerts-*/result.json'),
            ('miniapp_http', [node, str(ROOT / 'tests/stage08-miniapp-http.cjs')], '.runtime/stage08-miniapp-http/*/result.json'),
            ('service_coldstart', [sys.executable, '-B', str(ROOT / 'tests/stage08-coldstart.py')], '.runtime/stage08-coldstart/*/result.json'),
        ]
        for name, command, pattern in jobs:
            job = run_job(name, command, output, env, pattern)
            report['jobs'].append(job)
            (output / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            if job['status'] != 'passed':
                return 1
        report['status'] = 'passed'
        return 0
    except Exception as error:
        report['error'] = str(error)
        print('ERROR ' + str(error), file=sys.stderr)
        return 1
    finally:
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        (output / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('REPORT ' + str(output / 'result.json'), flush=True)
        print('WeChat platform and final human acceptance remain separate; see pending.', flush=True)


if __name__ == '__main__':
    raise SystemExit(main())
