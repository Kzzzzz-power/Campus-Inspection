"""Start and supervise the local stage 01 broker, API and simulator."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.runtime'
WINDOW_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


def project_path(value):
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT):
        raise argparse.ArgumentTypeError('path must stay inside the project root')
    return path


def check_port(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if os.name == 'nt':
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            sock.bind(('127.0.0.1', port))
        except OSError as error:
            raise RuntimeError(f'127.0.0.1:{port} is occupied or unavailable; stop its owner or select another port') from error


def check_children(children):
    for name, process in children:
        code = process.poll()
        if code is not None:
            raise RuntimeError(f'{name} exited with code {code}')


def wait_ready(check, children, label, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        check_children(children)
        if check():
            return
        time.sleep(0.25)
    raise RuntimeError(f'timed out waiting for {label}; inspect this run\'s logs')


def broker_ready(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.5):
            return True
    except OSError:
        return False


def api_ready(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/current', timeout=1) as response:
            return json.load(response).get('broker', {}).get('state') == 'connected'
    except (OSError, ValueError, urllib.error.URLError):
        return False


def stop_child(name, process):
    if process.poll() is not None:
        return
    print(f'Stopping {name} (PID {process.pid})', flush=True)
    if os.name == 'nt':
        # Windows virtualenv launchers own a second Python process: stop their entire owned tree.
        result = subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                creationflags=WINDOW_FLAGS, timeout=10)
        if result.returncode and process.poll() is None:
            raise RuntimeError(f'cannot stop {name}: {result.stdout.decode(errors="replace")}')
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000, help='Web port (default: 8000)')
    parser.add_argument('--mqtt-port', type=int, default=1883, help='Loopback broker port (default: 1883)')
    parser.add_argument('--db', type=project_path, help='Optional isolated database inside the project')
    parser.add_argument('--uploads', type=project_path, help='Optional isolated upload directory inside the project')
    parser.add_argument('--overrides', type=project_path,
                        help='Simulator input file inside the project; default .runtime/stage01/input-overrides.json')
    args = parser.parse_args()
    if any(not 1024 <= p <= 65535 for p in (args.port, args.mqtt_port)):
        parser.error('ports must be between 1024 and 65535')
    if args.port == args.mqtt_port:
        parser.error('Web and MQTT ports must differ')
    if bool(args.db) != bool(args.uploads):
        parser.error('--db and --uploads must be provided together')
    python = Path(os.environ.get('INSPECTGO_PYTHON', ROOT / '.venv/Scripts/python.exe')).resolve()
    broker_python = Path(os.environ.get('INSPECTGO_BROKER_PYTHON', RUNTIME / 'broker-venv/Scripts/python.exe')).resolve()
    env = os.environ.copy()
    for directory in ('tmp', 'pip-cache'):
        (RUNTIME / directory).mkdir(parents=True, exist_ok=True)
    env.update(TEMP=str(RUNTIME / 'tmp'), TMP=str(RUNTIME / 'tmp'),
               PIP_CACHE_DIR=str(RUNTIME / 'pip-cache'), PYTHONDONTWRITEBYTECODE='1',
               PYTHONUNBUFFERED='1', INSPECTGO_MQTT_ENABLED='true',
               INSPECTGO_MQTT_HOST='127.0.0.1', INSPECTGO_MQTT_PORT=str(args.mqtt_port),
               INSPECTGO_SEED_DEMO='false')
    # Standalone startup always uses the existing real store unless explicit paired overrides are supplied.
    env.pop('INSPECTGO_DB', None)
    env.pop('INSPECTGO_UPLOADS', None)
    if args.db:
        args.db.parent.mkdir(parents=True, exist_ok=True)
        args.uploads.mkdir(parents=True, exist_ok=True)
        env.update(INSPECTGO_DB=str(args.db), INSPECTGO_UPLOADS=str(args.uploads))
    children, logs = [], []
    run_dir = None

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        for executable, imports in ((python, 'import uvicorn, fastapi, paho.mqtt.client'),
                                    (broker_python, 'import amqtt.broker')):
            if not executable.is_file():
                raise RuntimeError(f'missing {executable}; run Setup-Realtime.ps1 (see README for initial .venv setup)')
            check = subprocess.run([str(executable), '-B', '-c', imports], cwd=ROOT, env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   creationflags=WINDOW_FLAGS, timeout=15)
            if check.returncode:
                raise RuntimeError('missing runtime dependencies; run Setup-Realtime.ps1\n' +
                                   check.stdout.decode(errors='replace'))
        check_port(args.mqtt_port)
        check_port(args.port)
        run_dir = RUNTIME / 'stage01' / (datetime.now().strftime('launch-%Y%m%d-%H%M%S-') + str(os.getpid()))
        run_dir.mkdir(parents=True, exist_ok=True)

        def start(name, command):
            log = (run_dir / f'{name}.log').open('wb')
            logs.append(log)
            process = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT, creationflags=WINDOW_FLAGS)
            children.append((name, process))
            (run_dir / 'processes.json').write_text(json.dumps({
                'supervisor_pid': os.getpid(), 'web_port': args.port, 'mqtt_port': args.mqtt_port,
                'children': {child_name: child.pid for child_name, child in children}
            }, indent=2), encoding='utf-8')
            print(f'Started {name} (PID {process.pid}); log: {run_dir / (name + ".log")}', flush=True)

        start('broker', [str(broker_python), '-B', '-m', 'simulators.broker', '--port', str(args.mqtt_port)])
        wait_ready(lambda: broker_ready(args.mqtt_port), children, 'MQTT broker')
        start('api', [str(python), '-B', '-m', 'uvicorn', 'backend.main:app',
                      '--host', '127.0.0.1', '--port', str(args.port)])
        wait_ready(lambda: api_ready(args.port), children, 'API and its MQTT connection')
        simulator = [str(python), '-B', '-m', 'simulators.facility_status', '--port', str(args.mqtt_port)]
        if args.overrides:
            simulator.extend(['--overrides', str(args.overrides)])
        start('simulator', simulator)
        print(f'Ready: http://127.0.0.1:{args.port}/ ; Ctrl+C stops this run. Logs: {run_dir}', flush=True)
        while True:
            check_children(children)
            time.sleep(0.5)
    except KeyboardInterrupt:
        print('Stopping this run.', flush=True)
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Startup/run failed: {error}', file=sys.stderr, flush=True)
        return 1
    finally:
        # Ignore a second Ctrl+C while releasing the processes created by this launcher.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        for name, process in reversed(children):
            try:
                stop_child(name, process)
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                print(f'Cleanup failed: {error}', file=sys.stderr, flush=True)
        for log in logs:
            log.close()
        if run_dir:
            (run_dir / 'stopped.json').write_text(json.dumps({
                name: process.poll() for name, process in children
            }, indent=2), encoding='utf-8')
        if any(process.poll() is None for _, process in children):
            raise RuntimeError('one or more owned processes could not be stopped; see cleanup errors above')


if __name__ == '__main__':
    raise SystemExit(main())
