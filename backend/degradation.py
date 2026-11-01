"""Scoped teaching acquisition failure and real review lifecycle linkage."""
from datetime import datetime,timedelta
from uuid import uuid4
from fastapi import HTTPException
from . import evidence as ev,service


def status_evidence(conn,rid,at,available,**provenance):
    return ev.add(conn,'current_status','SIMULATED','ap-2f',at,
        {'condition':'NORMAL'} if available else None,
        status='ok' if available else 'unavailable',error=None if available else 'status endpoint unavailable',
        inspection_round_id=rid,checkpoint_id='C03',facility_id='ap-2f',zone_id='Z1',retrieved_at=at,
        valid_until=(datetime.fromisoformat(at)+timedelta(minutes=60)).isoformat(),
        provenance={'fixture':'config/scenarios/S5.json','query_simulation':True,**provenance})


def ensure_review(conn,rid,run_id,at):
    # Any prior request, including closed requests, prevents automatic reopening.
    if conn.execute("SELECT 1 FROM reviews WHERE inspection_round_id=? AND (task_id='T2' OR status='pending') AND point_id='C03'",(rid,)).fetchone():return
    f=ev.CATALOG['C03']
    ev.insert(conn,'reviews',dict(review_id='review-'+uuid4().hex,point_id='C03',reason='C03｜ap-2f 当前状态取证失败，需要新的现场确认。',
        status='pending',version=1,conclusion=None,created_at=at,updated_at=at,trigger_run_id=run_id,
        task_id='T2',inspection_round_id=rid,facility_id=f['facility_id'],zone_id=f['zone_id'],
        expires_at=(datetime.fromisoformat(at)+timedelta(hours=24)).isoformat(),completed_at=None,close_reason=None))
