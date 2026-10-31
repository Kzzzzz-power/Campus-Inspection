"""Stage03 migrations preserve legacy history and freeze completed judgments."""

RULE_VERSION = 'b02-stage05-v1'
TASKS = {
    'T1':'关键设施巡检覆盖', 'T2':'异常项复核与确认',
    'T3':'巡检记录可靠留存与汇聚', 'T4':'现场复核与证据补充',
    'T5':'巡检结果分析与阶段复盘',
}


def initialize(conn):
    columns = {r['name'] for r in conn.execute('PRAGMA table_info(runs)')}
    if 'rule_version' not in columns:
        conn.execute('ALTER TABLE runs RENAME TO legacy_runs')
    # Rebuild the constrained fact table without changing its ID or references.
    sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='inspection_records'").fetchone()[0]
    if "CHECK(source_type='ON_SITE')" in sql:
        indexes = [r[0] for r in conn.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='inspection_records' AND sql IS NOT NULL")]
        triggers = [r[0] for r in conn.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='inspection_records'")]
        conn.execute(sql.replace('CREATE TABLE inspection_records','CREATE TABLE inspection_records_new',1)
                     .replace("CHECK(source_type='ON_SITE')","CHECK(source_type IN ('ON_SITE','SIMULATED'))"))
        conn.execute('INSERT INTO inspection_records_new SELECT * FROM inspection_records')
        conn.execute('DROP TABLE inspection_records')
        conn.execute('ALTER TABLE inspection_records_new RENAME TO inspection_records')
        for statement in indexes + triggers:
            conn.execute(statement)
    statements = [
        '''CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=3),
          scenario_id TEXT, inspection_round_id TEXT NOT NULL REFERENCES inspection_rounds(inspection_round_id),
          run_type TEXT NOT NULL CHECK(run_type IN ('reality','what_if')),
          parent_run_id TEXT REFERENCES runs(run_id), rule_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
          as_of TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT,
          input_snapshot TEXT NOT NULL, source_watermark TEXT NOT NULL,
          request_id TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL, summary TEXT, result_json TEXT)''',
        '''CREATE TABLE IF NOT EXISTS task_definitions (
          rule_version TEXT NOT NULL, task_id TEXT NOT NULL, name TEXT NOT NULL,
          PRIMARY KEY(rule_version,task_id))''',
        '''CREATE TABLE IF NOT EXISTS dependency_definitions (
          rule_version TEXT NOT NULL, task_id TEXT NOT NULL, dependency_id TEXT NOT NULL,
          name TEXT NOT NULL, required INTEGER NOT NULL CHECK(required IN (0,1)),
          PRIMARY KEY(rule_version,task_id,dependency_id),
          FOREIGN KEY(rule_version,task_id) REFERENCES task_definitions(rule_version,task_id))''',
        '''CREATE TABLE IF NOT EXISTS run_evidence (
          run_id TEXT NOT NULL REFERENCES runs(run_id), evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
          PRIMARY KEY(run_id,evidence_id))''',
        '''CREATE TABLE IF NOT EXISTS dependency_checks (
          run_id TEXT NOT NULL REFERENCES runs(run_id), task_id TEXT NOT NULL, dependency_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('satisfied','unsatisfied','unknown')),
          reason TEXT NOT NULL, evidence_refs TEXT NOT NULL, missing_kind TEXT,
          PRIMARY KEY(run_id,task_id,dependency_id))''',
        '''CREATE TABLE IF NOT EXISTS task_results (
          run_id TEXT NOT NULL REFERENCES runs(run_id), task_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('established','blocked','pending_verification','unknown')),
          result_json TEXT NOT NULL, PRIMARY KEY(run_id,task_id))''',
        '''CREATE TABLE IF NOT EXISTS scenario_instances (
          instance_id TEXT PRIMARY KEY, inspection_round_id TEXT NOT NULL UNIQUE REFERENCES inspection_rounds(inspection_round_id),
          fixture_hash TEXT NOT NULL, response_json TEXT NOT NULL)''',
        '''CREATE TABLE IF NOT EXISTS run_references (
          run_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('legacy','formal')))''',
    ]
    for sql in statements:
        conn.execute(sql)
    conn.execute("INSERT OR IGNORE INTO run_references SELECT run_id,'legacy' FROM legacy_runs")
    conn.execute("INSERT OR IGNORE INTO run_references SELECT run_id,'formal' FROM runs")
    # Legacy review links survive; future reviews can reference either run generation.
    review_sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='reviews'").fetchone()[0]
    if 'REFERENCES run_references' not in review_sql:
        indexes = [r[0] for r in conn.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='reviews' AND sql IS NOT NULL")]
        conn.execute(review_sql.replace('CREATE TABLE reviews','CREATE TABLE reviews_new',1)
                     .replace('CREATE TABLE "reviews"','CREATE TABLE reviews_new',1)
                     .replace('REFERENCES "legacy_runs"','REFERENCES run_references')
                     .replace('REFERENCES legacy_runs','REFERENCES run_references')
                     .replace('REFERENCES runs','REFERENCES run_references'))
        conn.execute('INSERT INTO reviews_new SELECT * FROM reviews')
        conn.execute('DROP TABLE reviews')
        conn.execute('ALTER TABLE reviews_new RENAME TO reviews')
        for sql in indexes:
            conn.execute(sql)
    for task_id,name in TASKS.items():
        conn.execute('INSERT OR IGNORE INTO task_definitions VALUES (?,?,?)',(RULE_VERSION,task_id,name))
    # INSERT triggers also catch REPLACE, whose implicit DELETE can skip delete triggers.
    conn.execute("""CREATE TRIGGER IF NOT EXISTS frozen_run_insert BEFORE INSERT ON runs
        WHEN EXISTS(SELECT 1 FROM runs WHERE run_id=NEW.run_id)
        BEGIN SELECT RAISE(ABORT,'run IDs cannot be replaced'); END""")
    conn.execute("""CREATE TRIGGER IF NOT EXISTS frozen_run_request_insert BEFORE INSERT ON runs
        WHEN EXISTS(SELECT 1 FROM runs WHERE request_id=NEW.request_id)
        BEGIN SELECT RAISE(ABORT,'run request IDs cannot be replaced'); END""")
    conn.execute("""CREATE TRIGGER IF NOT EXISTS frozen_run_identity BEFORE UPDATE OF run_id,request_id ON runs
        WHEN NEW.run_id!=OLD.run_id OR NEW.request_id!=OLD.request_id
        BEGIN SELECT RAISE(ABORT,'run identity is immutable'); END""")
    for op in ('UPDATE','DELETE'):
        conn.execute(f"""CREATE TRIGGER IF NOT EXISTS frozen_run_{op} BEFORE {op} ON runs
          WHEN OLD.status IN ('completed','failed')
          BEGIN SELECT RAISE(ABORT,'terminal run is immutable'); END""")
    conn.execute('''CREATE TABLE IF NOT EXISTS plan_definitions (
      plan_version TEXT NOT NULL,plan_id TEXT NOT NULL,definition_json TEXT NOT NULL,
      PRIMARY KEY(plan_version,plan_id))''')
    conn.execute('''CREATE TABLE IF NOT EXISTS plan_results (
      run_id TEXT NOT NULL REFERENCES runs(run_id),plan_id TEXT NOT NULL,plan_version TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('executable','not_executable','unknown')),
      result_json TEXT NOT NULL,PRIMARY KEY(run_id,plan_id),
      FOREIGN KEY(plan_version,plan_id) REFERENCES plan_definitions(plan_version,plan_id))''')
    conn.execute('''CREATE TABLE IF NOT EXISTS blockers (
      run_id TEXT NOT NULL REFERENCES runs(run_id),task_id TEXT NOT NULL,dependency_id TEXT NOT NULL,
      reason TEXT NOT NULL,evidence_refs TEXT NOT NULL,point_ids TEXT NOT NULL,
      PRIMARY KEY(run_id,task_id,dependency_id))''')
    for table in ('run_evidence','dependency_checks','task_results','plan_results','blockers'):
        for op in ('INSERT','UPDATE','DELETE'):
            reference = 'NEW' if op=='INSERT' else 'OLD'
            condition = f"(SELECT status FROM runs WHERE run_id={reference}.run_id) != 'running'"
            if op=='UPDATE':
                condition += " OR (SELECT status FROM runs WHERE run_id=NEW.run_id) != 'running'"
            conn.execute(f"""CREATE TRIGGER IF NOT EXISTS frozen_{table}_{op} BEFORE {op} ON {table}
              WHEN {condition} BEGIN SELECT RAISE(ABORT,'terminal run children are immutable'); END""")
    for table,id_col in (('evidence','evidence_id'),('inspection_records','inspection_id'),('facility_observations','observation_id'),('inspection_rounds','inspection_round_id')):
        conn.execute(f"""CREATE TRIGGER IF NOT EXISTS no_replace_{table} BEFORE INSERT ON {table}
          WHEN EXISTS(SELECT 1 FROM {table} WHERE {id_col}=NEW.{id_col})
          BEGIN SELECT RAISE(ABORT,'append-only facts cannot be replaced'); END""")
    for table in ('legacy_runs','run_snapshots'):
        for op in ('UPDATE','DELETE'):
            conn.execute(f"""CREATE TRIGGER IF NOT EXISTS archive_{table}_{op} BEFORE {op} ON {table}
              BEGIN SELECT RAISE(ABORT,'legacy archive is immutable'); END""")

    for table in ('legacy_runs','run_snapshots'):
        conn.execute(f"""CREATE TRIGGER IF NOT EXISTS archive_{table}_insert BEFORE INSERT ON {table}
          WHEN EXISTS(SELECT 1 FROM {table} WHERE run_id=NEW.run_id)
          BEGIN SELECT RAISE(ABORT,'legacy archive cannot be replaced'); END""")
    for table,condition in (
        ('inspection_records','request_id=NEW.request_id OR legacy_record_id=NEW.legacy_record_id'),
        ('facility_observations','(facility_id=NEW.facility_id AND observed_at=NEW.observed_at) OR (source_type=NEW.source_type AND event_id=NEW.event_id)'),
        ('inspection_rounds','round_id=NEW.round_id')):
        conn.execute(f"""CREATE TRIGGER IF NOT EXISTS no_unique_replace_{table} BEFORE INSERT ON {table}
          WHEN EXISTS(SELECT 1 FROM {table} WHERE {condition})
          BEGIN SELECT RAISE(ABORT,'unique fact cannot be replaced'); END""")
