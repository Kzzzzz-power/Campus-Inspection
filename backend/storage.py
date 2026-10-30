"""SQLite transactions and additive migrations; legacy data is never rewritten."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3


class Store:
    def __init__(self, path, uploads):
        self.path = Path(path)
        self.uploads = Path(uploads)

    @contextmanager
    def transaction(self, write=False, timeout=5):
        conn = sqlite3.connect(self.path, timeout=timeout)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('PRAGMA foreign_keys=ON')
            conn.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def initialize(self, seed_demo=True):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.transaction(write=True) as conn:
            fresh_database = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('records','runs')").fetchone() is None
            conn.execute('''CREATE TABLE IF NOT EXISTS records (
                id INTEGER PRIMARY KEY AUTOINCREMENT, point_id TEXT NOT NULL,
                status TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT, created_at TEXT NOT NULL)''')
            conn.execute('''CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, summary TEXT)''')
            columns = {row['name'] for row in conn.execute('PRAGMA table_info(records)')}
            for name, declaration in {
                'inspector_id':'TEXT', 'inspected_at':'TEXT',
                'is_legacy':'INTEGER NOT NULL DEFAULT 1', 'review_id':'TEXT',
            }.items():
                if name not in columns:
                    conn.execute(f'ALTER TABLE records ADD COLUMN {name} {declaration}')
            statements = [
                '''CREATE TABLE IF NOT EXISTS photos (
                    image_id TEXT PRIMARY KEY, record_id INTEGER NOT NULL REFERENCES records(id),
                    point_id TEXT NOT NULL, stored_name TEXT NOT NULL, media_type TEXT NOT NULL,
                    created_at TEXT NOT NULL, sha256 TEXT NOT NULL)''',
                '''CREATE TABLE IF NOT EXISTS reviews (
                    review_id TEXT PRIMARY KEY, point_id TEXT NOT NULL, reason TEXT NOT NULL,
                    status TEXT NOT NULL, version INTEGER NOT NULL, conclusion TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    trigger_run_id TEXT REFERENCES runs(run_id))''',
                '''CREATE UNIQUE INDEX IF NOT EXISTS one_pending_review
                    ON reviews(point_id) WHERE status='pending' ''',
                '''CREATE TABLE IF NOT EXISTS run_snapshots (
                    run_id TEXT PRIMARY KEY REFERENCES runs(run_id), snapshot_json TEXT NOT NULL)''',
                '''CREATE TABLE IF NOT EXISTS request_receipts (
                    request_id TEXT PRIMARY KEY, action TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, response_json TEXT NOT NULL)''',
                'CREATE INDEX IF NOT EXISTS records_point ON records(point_id, id)',
                'CREATE INDEX IF NOT EXISTS photos_record ON photos(record_id)',
            ]
            for statement in statements:
                conn.execute(statement)
            if __package__:
                from .evidence import initialize
            else:
                from evidence import initialize
            initialize(conn)
            if seed_demo and fresh_database:
                now = datetime.now(timezone.utc)
                demo = [
                    ('C01','ok','onsite','历史模拟现场记录（未附照片）',20),
                    ('C02','ok','onsite','历史模拟读数正常',18),
                    ('C03','unknown','remote','告警确认接口超时',30),
                    ('C04','ok','onsite','历史模拟现场记录（未附照片）',15),
                    ('C05','ok','onsite','历史模拟门禁开合正常',12),
                    ('C06','alarm','remote','排风电流超限告警（未现场确认）',25),
                ]
                conn.executemany('''INSERT INTO records
                    (point_id,status,source,evidence,created_at) VALUES (?,?,?,?,?)''',
                    [(p,s,src,e,(now-timedelta(minutes=m)).isoformat()) for p,s,src,e,m in demo])
