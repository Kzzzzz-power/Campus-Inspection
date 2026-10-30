"""Frozen plan definitions and append-only planning input evidence."""
from math import isfinite
from fastapi import HTTPException
from .configuration import CONFIG,read_json
from . import evidence as ev,service

PLAN_VERSION='b02-plans-v1'
DEFINITIONS=read_json(CONFIG/'plans.json')
RESOURCES=('P1','P2','access_coordinator','mobile_terminal')


def validate(overrides):
    output={}
    if 'remaining_minutes' in overrides:
        value=overrides['remaining_minutes']
        if type(value) not in (int,float) or not isfinite(value) or not 0<=value<=1440:
            raise HTTPException(422,'remaining_minutes 必须为 0–1440 的有限数字，表示当前输入快照的剩余时间。')
        output['remaining_minutes']=value
    if 'resources' in overrides:
        values=overrides['resources']
        if not isinstance(values,dict) or set(values)-set(RESOURCES) or any(v not in ('AVAILABLE','UNAVAILABLE',None) for v in values.values()):
            raise HTTPException(422,'资源仅接受 P1/P2/access_coordinator/mobile_terminal；值为 AVAILABLE/UNAVAILABLE/null。')
        output['resources']=values
    if 'p2_z3_access' in overrides:
        if overrides['p2_z3_access'] not in ('ALLOWED','DENIED',None):raise HTTPException(422,'P2 Z3 权限应为 ALLOWED/DENIED/null。')
        output['p2_z3_access']=overrides['p2_z3_access']
    return output


def inputs(conn,context,rid,at,until,source,provenance):
    rows=[]
    def add(kind,subject,value):
        rows.append(ev.add(conn,kind,'SIMULATED',source,at,value,status='ok' if value is not None else 'unavailable',
            error=None if value is not None else '该条件未取得有效观察',inspection_round_id=rid,retrieved_at=at,valid_until=until,
            provenance={**provenance,'subject':subject}))
    if 'remaining_minutes' in context:add('time_budget',{}, {'remaining_minutes':context['remaining_minutes']})
    for resource,value in context.get('resources',{}).items():
        subject={'resource_id':resource}
        add('resource_availability',subject,{**subject,'availability':value} if value is not None else None)
    if 'p2_z3_access' in context:
        subject={'person_id':'P2','zone_id':'Z3'};value=context['p2_z3_access']
        add('access_permission',subject,{**subject,'access':value} if value is not None else None)
    return rows


def apply_overrides(conn,proofs,overrides,rid,at,until,run_id):
    added=inputs(conn,overrides,rid,at,until,run_id,{'run_id':run_id,'input_override':True})
    identities={(p['evidence_type'],service.json_text(p['provenance_json']['subject'])) for p in added}
    kept=[p for p in proofs if (p['evidence_type'],service.json_text(p['provenance_json'].get('subject',{}))) not in identities]
    return kept+added
