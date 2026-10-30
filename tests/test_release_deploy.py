"""Release safety contracts; all filesystem tests use pytest temporary directories."""
import importlib.util
import io
from pathlib import Path
import tarfile

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def deployment():
    path = ROOT / "deploy/release_deploy.py"
    assert path.is_file(), "Release deployment implementation is missing"
    spec = importlib.util.spec_from_file_location("release_deploy", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("tag,sha", [
    ("v0.2.1", "a" * 40), ("v12.0.10", "0123456789" * 4),
])
def test_valid_release_identity(deployment, tag, sha):
    deployment.validate_release(tag, sha)


@pytest.mark.parametrize("tag,sha", [
    ("../../root", "a" * 40), ("v1.0.0;id", "a" * 40),
    ("v1.0.0-rc.1", "a" * 40), ("main", "a" * 40),
    ("v01.0.0", "a" * 40), ("v1.0.0", "--help"),
    ("v1.0.0", "a" * 39), ("v1.0.0", "g" * 40),
    ("v1.0.0\n", "a" * 40),
])
def test_untrusted_release_arguments_rejected(deployment, tag, sha):
    with pytest.raises(ValueError):
        deployment.validate_release(tag, sha)


def archive_file(name, *, kind=tarfile.REGTYPE):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        item = tarfile.TarInfo(name)
        item.type = kind
        if kind == tarfile.REGTYPE:
            item.size = 2
            archive.addfile(item, io.BytesIO(b"ok"))
        else:
            item.linkname = "/etc/passwd"
            archive.addfile(item)
    return stream.getvalue()


@pytest.mark.parametrize("name,kind", [
    ("../outside", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
    ("backend/link", tarfile.SYMTYPE), ("backend/link", tarfile.LNKTYPE),
    ("backend/fifo", tarfile.FIFOTYPE), ("backend/../../outside", tarfile.REGTYPE),
    ("backend\\escape", tarfile.REGTYPE),
])
def test_archive_cannot_escape_or_create_links(deployment, tmp_path, name, kind):
    with pytest.raises(ValueError):
        deployment.extract_source(archive_file(name, kind=kind), tmp_path / "src")
    assert not (tmp_path / "outside").exists()


def test_source_export_includes_code_but_excludes_local_data(deployment, tmp_path):
    deployment.extract_source(archive_file("backend/main.py"), tmp_path)
    assert (tmp_path / "backend/main.py").read_bytes() == b"ok"
    deployment.extract_source(archive_file("backend/inspectgo.db"), tmp_path)
    assert not (tmp_path / "backend/inspectgo.db").exists()


def test_restore_keeps_failed_database_and_photos(deployment, tmp_path, monkeypatch):
    data, backup, failed = (tmp_path / n for n in ("data", "backup", "failed"))
    for folder, value in ((data, "new"), (backup, "old")):
        (folder / "uploads").mkdir(parents=True)
        (folder / "inspectgo.db").write_text(value)
        (folder / "uploads/photo.png").write_text(value)
    monkeypatch.setattr(deployment, "own_data", lambda path: None)
    deployment.restore_data(data, backup, failed)
    assert (data / "inspectgo.db").read_text() == "old"
    assert (data / "uploads/photo.png").read_text() == "old"
    assert (failed / "inspectgo.db").read_text() == "new"
    assert (failed / "uploads/photo.png").read_text() == "new"
    assert (backup / "inspectgo.db").read_text() == "old"


def test_workflow_only_published_formal_release():
    path = ROOT / ".github/workflows/release-deploy.yml"
    assert path.is_file(), "Release workflow is missing"
    workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
    events = workflow.get("on", workflow.get(True))
    assert events == {"release": {"types": ["published"]}}
    job = workflow["jobs"]["deploy"]
    assert "prerelease" in job["if"] and "draft" in job["if"]
    assert "campus-inspection" in job["runs-on"]
    assert workflow["concurrency"]["cancel-in-progress"] is False
    script = job["steps"][0]["run"]
    assert "${{" not in script
    assert 'sudo -n /usr/local/sbin/campus-release-deploy "$RELEASE_TAG" "$RELEASE_SHA"' in script


def test_maintenance_blocks_writes_and_preserves_reads(monkeypatch, tmp_path):
    from test_api import api, form
    from fastapi.testclient import TestClient
    flag = tmp_path / "maintenance"
    flag.touch()
    monkeypatch.setenv("INSPECTGO_MAINTENANCE_FILE", str(flag))
    app = api.create_app(db_path=tmp_path / "db.sqlite", uploads_dir=tmp_path / "uploads",
                         seed_demo=False, realtime_enabled=False)
    with TestClient(app) as client:
        assert client.get("/api/dashboard").status_code == 200
        response = client.post("/api/inspections", data=form())
        assert response.status_code == 503
        assert response.headers["retry-after"] == "30"
        flag.unlink()
        assert client.post("/api/inspections", data=form()).status_code == 200

@pytest.fixture
def transaction(deployment, tmp_path, monkeypatch):
    for name in ("DATA", "CONTROL", "BACKUPS"):
        folder = tmp_path / name.lower()
        folder.mkdir()
        monkeypatch.setattr(deployment, name, folder)
    monkeypatch.setattr(deployment, "PENDING", tmp_path / "pending.json")
    monkeypatch.setattr(deployment, "ACTIVE", tmp_path / "active.json")
    monkeypatch.setattr(deployment, "own_data", lambda p: None)
    (deployment.DATA / "inspectgo.db").write_text("old database")
    (deployment.DATA / "uploads").mkdir()
    (deployment.DATA / "uploads/photo.png").write_text("old photo")
    deployment.ACTIVE.write_text('{"sha":"old"}')
    containers = {deployment.NAME: "old"}
    events = []

    def docker(*args, **kwargs):
        events.append(args)
        action = args[0]
        if action == "rename":
            containers[args[2]] = containers.pop(args[1])
        elif action == "run":
            assert (deployment.CONTROL / "readonly").exists()
            containers[deployment.NAME] = "new"
            (deployment.DATA / "inspectgo.db").write_text("new database")
        elif action == "rm":
            containers.pop(args[-1], None)
        return 0
    monkeypatch.setattr(deployment, "docker", docker)
    return deployment, containers, events


def test_failed_new_health_restores_old_container_and_data(transaction, monkeypatch):
    deployment, containers, events = transaction
    def healthy(name, seconds=90):
        if containers[name] == "new":
            raise RuntimeError("injected failed health")
    monkeypatch.setattr(deployment, "wait_healthy", healthy)
    with pytest.raises(RuntimeError, match="injected failed health"):
        deployment.switch_release("image:new", "v0.2.1", "a" * 40)
    assert containers == {deployment.NAME: "old"}
    assert (deployment.DATA / "inspectgo.db").read_text() == "old database"
    assert (deployment.DATA / "uploads/photo.png").read_text() == "old photo"
    failures = list(deployment.BACKUPS.glob("*/failed-data/inspectgo.db"))
    assert len(failures) == 1 and failures[0].read_text() == "new database"
    assert not deployment.PENDING.exists()
    assert not (deployment.CONTROL / "readonly").exists()
    assert deployment.ACTIVE.read_text() == '{"sha":"old"}'


def test_backup_failure_restarts_old_without_creating_new(transaction, monkeypatch):
    deployment, containers, events = transaction
    def failed_copy(*args, **kwargs):
        raise OSError("injected disk full")
    monkeypatch.setattr(deployment.shutil, "copytree", failed_copy)
    monkeypatch.setattr(deployment, "wait_healthy", lambda name: None)
    with pytest.raises(OSError, match="disk full"):
        deployment.switch_release("image:new", "v0.2.1", "a" * 40)
    assert containers == {deployment.NAME: "old"}
    assert not any(event[0] == "run" for event in events)
    assert ("start", deployment.NAME) in events
    assert (deployment.DATA / "inspectgo.db").read_text() == "old database"
    assert not deployment.PENDING.exists()


def test_failed_rollback_keeps_maintenance_and_pending(transaction, monkeypatch):
    deployment, containers, events = transaction
    def fail_all_health(name, seconds=90):
        raise RuntimeError("injected unhealthy container")
    monkeypatch.setattr(deployment, "wait_healthy", fail_all_health)
    with pytest.raises(RuntimeError):
        deployment.switch_release("image:new", "v0.2.1", "a" * 40)
    assert deployment.PENDING.exists()
    assert (deployment.CONTROL / "readonly").exists()


def test_success_reopens_writes_only_after_health_and_barrier_checks(transaction, monkeypatch):
    import urllib.error
    import urllib.request
    deployment, containers, events = transaction
    monkeypatch.setattr(deployment, "wait_healthy", lambda name: None)
    def urlopen(request, **kwargs):
        assert (deployment.CONTROL / "readonly").exists()
        if isinstance(request, str):
            return io.BytesIO(b'{"status":"ok","mqtt":{"state":"connected"}}')
        raise urllib.error.HTTPError(request.full_url, 503, "maintenance", {}, None)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    deployment.switch_release("image:new", "v0.2.1", "a" * 40)
    assert containers[deployment.NAME] == "new"
    assert "old" in containers.values()
    assert not deployment.PENDING.exists()
    assert not (deployment.CONTROL / "readonly").exists()
    assert (deployment.DATA / "inspectgo.db").read_text() == "new database"
    assert len(list(deployment.BACKUPS.glob("*/data/uploads/photo.png"))) == 1
