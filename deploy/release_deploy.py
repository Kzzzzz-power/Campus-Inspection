#!/usr/bin/python3 -I
"""Root-owned release entrypoint. No shell evaluation, arbitrary paths or Docker access for runner."""
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone

BASE = Path("/opt/campus-inspection")
SOURCE = BASE / "source"
DATA = BASE / "data"
CONTROL = BASE / "control"
BACKUPS = BASE / "backups"
BUILDS = BASE / "release-builds"
TRUSTED = Path("/usr/local/lib/campus-inspection")
PENDING = BASE / "deployment-pending.json"
ACTIVE = BASE / "active-release.json"
NAME = "campus-inspection"
BASE_IMAGE = "public.ecr.aws/docker/library/python:3.11.17-slim-bookworm"
REPOSITORY = "git@github.com:Kzzzzz-power/Campus-Inspection-draft.git"
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root",
       "LANG": "C.UTF-8", "DOCKER_BUILDKIT": "0"}
TAG = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def validate_release(tag, sha):
    if not TAG.fullmatch(tag) or len(tag) > 60:
        raise ValueError("Only formal vMAJOR.MINOR.PATCH tags are accepted")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Expected a full 40-character commit SHA")


def run(args, *, capture=False, binary=False, timeout=120, check=True):
    result = subprocess.run([str(a) for a in args], env=ENV, check=check,
                            stdout=subprocess.PIPE if capture else None,
                            text=not binary, timeout=timeout)
    return result.stdout if capture else result.returncode


def docker(*args, **options):
    return run(["/usr/bin/docker", *args], **options)


def git(*args, **options):
    return run(["/usr/sbin/runuser", "-u", "campus-deploy", "--",
                "/usr/bin/git", "-C", SOURCE, *args], **options)


def extract_source(content, destination):
    """Export only app/test inputs; refuse links, devices and escaping paths."""
    allowed = {"backend", "frontend", "config", "simulators", "tests", "deploy", ".github",
               "requirements-lock.txt", "requirements-broker-lock.txt"}
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:") as archive:
        for item in archive:
            path = PurePosixPath(item.name)
            if path.is_absolute() or ".." in path.parts or "\\" in item.name:
                raise ValueError("Unsafe archive path")
            if not (item.isfile() or item.isdir()):
                raise ValueError("Links and special files are not deployable")
            if not path.parts or path.parts[0] not in allowed:
                continue
            if path.parts[0] == "backend" and (len(path.parts) != 2 or path.suffix != ".py"):
                continue
            target = destination.joinpath(*path.parts)
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(item) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o644)


def own_data(path):
    for current in [path, *path.rglob("*")]:
        if current.is_symlink():
            raise ValueError("Data symlinks require manual review")
        os.chown(current, 10001, 10001)


def restore_data(data, backup, failed):
    if failed.exists():
        raise ValueError("Refusing to overwrite retained failure evidence")
    data.rename(failed)
    shutil.copytree(backup, data, symlinks=True)
    own_data(data)


def container_info(name=NAME):
    return json.loads(docker("inspect", name, capture=True))[0]


def wait_healthy(name, seconds=90):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        state = container_info(name)["State"]
        if state.get("Health", {}).get("Status") == "healthy":
            return
        if not state.get("Running") or state.get("Health", {}).get("Status") == "unhealthy":
            break
        time.sleep(2)
    docker("logs", "--tail", "60", name, check=False)
    raise RuntimeError("Container failed health check: " + name)


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def switch_release(image, tag, sha):
    """Pause writes before stopping; retain old container and a consistent data snapshot."""
    ident = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + sha[:12]
    backup = BACKUPS / ident
    backup.mkdir(mode=0o700)
    previous = NAME + "-previous-" + ident.lower()
    gate = CONTROL / "readonly"
    stopped = renamed = snapshot = False
    committed = False
    old_active = ACTIVE.read_bytes() if ACTIVE.exists() else None
    atomic_json(PENDING, {"tag": tag, "sha": sha, "backup": str(backup),
                          "previous_container": previous})
    gate.touch(mode=0o644)
    try:
        # Mark before invoking stop: even a partially failed stop must restart the old service.
        stopped = True
        docker("stop", "--time", "20", NAME)
        own_data(DATA)  # validates links after writers have stopped
        shutil.copytree(DATA, backup / "data", symlinks=True)
        snapshot = True
        docker("rename", NAME, previous)
        renamed = True
        docker("run", "-d", "--pull=never", "--name", NAME, "--init",
               "--restart", "unless-stopped", "--stop-timeout", "20",
               "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
               "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
               "--cpus", "2", "--memory", "2g", "--pids-limit", "256",
               "--label", "campus.release.sha=" + sha,
               "--label", "campus.release.tag=" + tag,
               "-p", "127.0.0.1:8001:8000",
               "--mount", "type=bind,src=" + str(DATA) + ",dst=/data",
               "--mount", "type=bind,src=" + str(CONTROL) + ",dst=/control,readonly",
               "-e", "INSPECTGO_MAINTENANCE_FILE=/control/readonly", image)
        wait_healthy(NAME)
        # Verify the actual host port and the write barrier before reopening writes.
        from urllib.request import urlopen, Request
        from urllib.error import HTTPError
        with urlopen("http://127.0.0.1:8001/health", timeout=5) as response:
            health = json.load(response)
        if health.get("status") != "ok" or health.get("mqtt", {}).get("state") != "connected":
            raise RuntimeError("Published port health failed")
        request = Request("http://127.0.0.1:8001/api/runs", data=b"{}", method="POST",
                          headers={"Content-Type": "application/json"})
        try:
            urlopen(request, timeout=5).close()
        except HTTPError as error:
            if error.code != 503:
                raise RuntimeError("Deployment write barrier is not active") from error
        else:
            raise RuntimeError("Deployment write barrier did not reject POST")
        atomic_json(ACTIVE, {"tag": tag, "sha": sha, "image": image,
                             "backup": str(backup), "previous_container": previous})
        gate.unlink()
        committed = True
        PENDING.unlink()
    except BaseException:
        if committed:
            # Never restore old data after accepting new writes.
            raise RuntimeError("New version is live; pending journal needs operator review")
        try:
            if renamed:
                # The fixed container name was vacated by us; it can only be this deployment.
                docker("rm", "-f", NAME, check=False)
            if snapshot and renamed:
                restore_data(DATA, backup / "data", backup / "failed-data")
            if renamed:
                docker("rename", previous, NAME)
            if stopped:
                docker("start", NAME)
                wait_healthy(NAME)
            if old_active is None:
                ACTIVE.unlink(missing_ok=True)
            else:
                ACTIVE.write_bytes(old_active)
            gate.unlink(missing_ok=True)
            PENDING.unlink(missing_ok=True)
            print("ROLLBACK_OK: old container/data restored; failed data retained.", flush=True)
        except BaseException as rollback_error:
            print("ROLLBACK_REQUIRES_OPERATOR: " + str(rollback_error), file=sys.stderr)
            # Keep journal and barrier. Future deployments are blocked.
        raise
    print("DEPLOYED " + tag + " " + sha, flush=True)


def prepare_build(tag, sha):
    if git("remote", "get-url", "origin", capture=True).strip() != REPOSITORY:
        raise RuntimeError("Unexpected source repository")
    git("fetch", "--no-tags", "origin",
        "refs/tags/" + tag + ":refs/tags/" + tag,
        "+refs/heads/main:refs/remotes/origin/main", timeout=300)
    actual = git("rev-parse", "refs/tags/" + tag + "^{commit}", capture=True).strip()
    if actual != sha:
        raise RuntimeError("Release tag and event commit do not match")
    git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main")
    docker("image", "inspect", BASE_IMAGE, capture=True)  # never pulls Docker Hub
    work = Path(tempfile.mkdtemp(prefix=sha[:12] + "-", dir=BUILDS))
    work.chmod(0o755)
    src = work / "source"
    extract_source(git("archive", "--format=tar", sha, capture=True, binary=True, timeout=120), src)
    # Privileged build recipe is installed by root, never executed from runner's work tree.
    shutil.copyfile(TRUSTED / "Dockerfile", work / "Dockerfile")
    shutil.copyfile(TRUSTED / "start.sh", work / "start.sh")
    for environment, requirements in (("app", "requirements-lock.txt"),
                                      ("broker", "requirements-broker-lock.txt")):
        target = work / "wheels" / environment
        cache = BASE / "build-cache" / environment
        if cache.exists():
            shutil.copytree(cache, target, symlinks=True)
        else:
            target.mkdir(parents=True)
        own_data(target)
        docker("run", "--rm", "--pull=never", "--user", "10001:10001",
               "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
               "--cpus", "1", "--memory", "768m", "--pids-limit", "128",
               "--mount", "type=bind,src=" + str(src) + ",dst=/src,readonly",
               "--mount", "type=bind,src=" + str(target) + ",dst=/wheels",
               "-e", "HOME=/tmp", "-e", "PIP_DISABLE_PIP_VERSION_CHECK=1",
               BASE_IMAGE, "python", "-m", "pip", "download",
               "--only-binary=:all:", "--no-cache-dir", "--timeout", "30", "--retries", "2",
               "--index-url", "https://pypi.tuna.tsinghua.edu.cn/simple",
               "-r", "/src/" + requirements, "-d", "/wheels", timeout=900)
    image = NAME + ":" + sha
    docker("build", "--pull=false", "--network=none", "--memory", "2g",
           "--label", "org.opencontainers.image.revision=" + sha,
           "-t", image, "-f", work / "Dockerfile", work, timeout=1200)
    # Backend tests get only temporary storage, never the live /data volume.
    docker("run", "--rm", "--pull=never", "--network", "none",
           "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
           "--cpus", "2", "--memory", "2g", "--pids-limit", "256",
           "--tmpfs", "/app/.runtime:rw,nosuid,nodev,uid=10001,gid=10001,mode=0770",
           "--tmpfs", "/data:rw,nosuid,nodev,uid=10001,gid=10001,mode=0770",
           "-e", "INSPECTGO_MQTT_ENABLED=false",
           "--entrypoint", "/opt/app-venv/bin/python", image,
           "-B", "-m", "pytest", "-q", "-p", "no:cacheprovider",
           "--basetemp", "/app/.runtime/pytest", "tests", timeout=300)
    # Use the runner's bundled Node, but execute as the unprivileged runner user.
    run(["/usr/sbin/runuser", "-u", "campus-runner", "--",
         "/opt/campus-runner/externals/node24/bin/node", "--test",
         src / "tests/frontend.test.mjs", src / "tests/realtime.test.mjs"], timeout=120)
    return image


def main():
    import fcntl
    if os.geteuid() != 0 or len(sys.argv) != 3:
        raise ValueError("Usage (root): campus-release-deploy vX.Y.Z full-commit-sha")
    tag, sha = sys.argv[1:]
    validate_release(tag, sha)
    os.umask(0o022)
    with (BASE / "deployment.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if PENDING.exists() or (CONTROL / "readonly").exists():
            raise RuntimeError("An unfinished deployment needs operator review")
        info = container_info()
        if not info["State"]["Running"]:
            raise RuntimeError("Existing campus container must be running")
        mounts = [m for m in info["Mounts"] if m["Destination"] == "/data"]
        if len(mounts) != 1 or mounts[0]["Source"] != str(DATA):
            raise RuntimeError("Unexpected data mount; refusing deployment")
        if DATA.is_symlink() or not DATA.is_dir():
            raise RuntimeError("Unexpected data directory")
        data_bytes = sum(p.stat().st_size for p in DATA.rglob("*") if p.is_file())
        if shutil.disk_usage(BASE).free < 2 * data_bytes + 3 * 1024**3:
            raise RuntimeError("Insufficient disk for build and retained rollback data")
        def interrupted(signum, frame):
            raise RuntimeError("Deployment interrupted by signal " + str(signum))
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        image = prepare_build(tag, sha)
        switch_release(image, tag, sha)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("DEPLOYMENT_FAILED: " + str(error), file=sys.stderr)
        sys.exit(1)
