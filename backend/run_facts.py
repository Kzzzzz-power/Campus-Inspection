"""Select facts for a new run without copying the entire telemetry archive.

Raw history and completed runs stay append-only. Live status contributes its
latest observation (including timestamp conflicts), plus historical WARNING /
FAULT witnesses and untraceable witnesses. Round/manual facts remain complete.
"""
from . import evidence as ev

FACT_FILTER = """evidence_type NOT IN
    ('configuration','coverage_check','anomaly_list','sqlite_write',
     'history_query','aggregation','review_channel','basic_statistics')
    AND source_type NOT IN ('MODEL_OUTPUT','LLM_OUTPUT','RAG','TOOL_OUTPUT','WEB_API')"""


def select_evidence(conn, rid, cutoff):
    # Discard old run-derived copies in SQL, before loading/decoding their JSON.
    original = FACT_FILTER + " AND COALESCE(json_extract(provenance_json,'$.run_id'),'')=''"
    rows = conn.execute(f"""SELECT * FROM evidence WHERE {original}
        AND inspection_round_id=? AND observed_at<=?""", (rid, cutoff))
    selected = {p['evidence_id']: ev.decode(p) for p in rows}

    # Explicit historical observations are not a current-status stream.
    rows = conn.execute(f"""SELECT * FROM evidence WHERE {original}
        AND inspection_round_id IS NULL AND evidence_type='historical_observation'
        AND observed_at<=?""", (cutoff,))
    selected.update((p['evidence_id'], ev.decode(p)) for p in rows)

    # ev.stamp normalizes acquisition times to UTC with six fractional digits;
    # compare those exact timestamps, without SQLite julianday rounding.
    # Rank only narrow keys, then fetch full rows for the retained IDs.
    # Separating anomaly and traceability classes preserves T2's anomaly set
    # and T3's "all evidence traceable" result. No status='ok' prefilter: a new
    # unavailable/error observation must never silently fall back to NORMAL.
    rows = conn.execute(f"""
        WITH ranked AS (
            SELECT evidence_id,
                DENSE_RANK() OVER (
                    PARTITION BY facility_id, checkpoint_id, evidence_type,
                        CASE WHEN status='ok' AND
                            json_extract(value_json,'$.condition') IN ('WARNING','FAULT')
                            THEN json_extract(value_json,'$.condition') ELSE 'current' END,
                        CASE WHEN source_type IN ('SYSTEM','SIMULATED','ON_SITE','DEVICE')
                            AND source_id<>'' AND retrieved_at>=observed_at
                            THEN 1 ELSE 0 END
                    ORDER BY observed_at DESC
                ) AS position
            FROM evidence
            WHERE {original} AND inspection_round_id IS NULL
                AND evidence_type IN ('facility_status','remote_status') AND observed_at<=?
        )
        SELECT e.* FROM evidence e JOIN ranked r USING(evidence_id) WHERE r.position=1
        """, (cutoff,))
    selected.update((p['evidence_id'], ev.decode(p)) for p in rows)

    # An explicit manual confirmation may reference an earlier run's copied
    # observation. Retain its basis, without importing unrelated run outputs.
    pending = list(selected.values())
    visited = set(selected)
    while pending:
        proof = pending.pop()
        refs = []
        for value in (proof.get('value_json'), proof.get('provenance_json')):
            if isinstance(value, dict) and isinstance(value.get('basis_evidence_ids'), list):
                refs.extend(value['basis_evidence_ids'])
        for eid in refs:
            if not isinstance(eid, str) or eid in visited:
                continue
            visited.add(eid)
            row = conn.execute(f"""SELECT * FROM evidence WHERE evidence_id=?
                AND {FACT_FILTER} AND (inspection_round_id=? OR inspection_round_id IS NULL)
                AND observed_at<=?""", (eid, rid, cutoff)).fetchone()
            if row is not None:
                basis = ev.decode(row)
                selected[eid] = basis
                pending.append(basis)
    return sorted(selected.values(), key=lambda p: (p['observed_at'], p['evidence_id']))
