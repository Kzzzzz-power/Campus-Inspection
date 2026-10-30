"""Pure candidate feasibility. No task state or facility record is mutated."""
from datetime import datetime
from math import isfinite


def stamp(value):
    try:
        parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
        return parsed if parsed.utcoffset() is not None else None
    except (ValueError,TypeError,AttributeError,OverflowError):
        return None


def number(value):
    return type(value) in (int,float) and isfinite(value) and value>=0


def business(row):
    return row.get('value_json') if isinstance(row.get('value_json'),dict) else {}


def evaluate_plans(definitions,evidence,round_id,as_of):
    cutoff=stamp(as_of)
    if cutoff is None:raise ValueError('Explicit timezone-aware cutoff required')
    def resolve(kind,identity,field,valid,predicate):
        rows=[]
        for row in evidence:
            value=business(row);subject=row.get('provenance_json',{}).get('subject',value)
            observed,retrieved=stamp(row.get('observed_at')),stamp(row.get('retrieved_at'))
            if (row.get('inspection_round_id')==round_id and row['evidence_type']==kind
                and all(subject.get(k)==v for k,v in identity.items())
                and observed is not None and retrieved is not None and observed<=retrieved<=cutoff):
                rows.append(row)
        if not rows:return 'unknown','缺少当前轮次的有效证据',[]
        latest=max(stamp(row['observed_at']) for row in rows)
        rows=[row for row in rows if stamp(row['observed_at'])==latest]
        refs=sorted({row['evidence_id'] for row in rows})
        if any(row['status']!='ok' for row in rows):return 'unknown','最新证据未能取得，不能推断业务条件',refs
        if any(stamp(row.get('valid_until')) is None or stamp(row['valid_until'])<cutoff for row in rows):
            return 'unknown','最新证据已过期或缺少有效期',refs
        values=[business(row).get(field) for row in rows]
        if any(not valid(v) for v in values):return 'unknown','业务值缺失或无效',refs
        if any(v!=values[0] for v in values):return 'unknown','同一时间存在冲突证据',refs
        display={'remaining_minutes':'剩余时间','availability':'可用性','access':'访问权限'}[field]
        business_label={'AVAILABLE':'可用','UNAVAILABLE':'不可用','ALLOWED':'已具备','DENIED':'明确拒绝'}.get(values[0],str(values[0]))
        return ('satisfied' if predicate(values[0]) else 'unsatisfied'),display+'：'+business_label+(' 分钟' if field=='remaining_minutes' else ''),refs
    if not isinstance(definitions,list) or not definitions:raise ValueError('Plan definitions required')
    seen=set()
    for plan in definitions:
        if not isinstance(plan,dict) or not isinstance(plan.get('plan_id'),str) or not plan['plan_id'] or plan['plan_id'] in seen:
            raise ValueError('Plan identifiers must be unique')
        seen.add(plan['plan_id'])
        if not number(plan.get('estimated_minutes')):raise ValueError('Invalid plan duration')
        resources=plan.get('required_resources');permissions=plan.get('required_permissions')
        if not isinstance(resources,list) or any(not isinstance(r,str) or not r for r in resources) or len(resources)!=len(set(resources)):
            raise ValueError('Invalid plan resource requirements')
        if not isinstance(permissions,list) or any(not isinstance(r,dict) or set(r)!={'person_id','zone_id'} or not all(isinstance(v,str) and v for v in r.values()) for r in permissions):
            raise ValueError('Invalid plan permission requirements')
    results=[]
    for plan in definitions:
        checks=[];pid=plan['plan_id'];minutes=plan['estimated_minutes']
        def add(key,label,result):
            status,reason,refs=result
            checks.append(dict(dependency_id=pid+'.'+key,status=status,reason=label+'：'+reason,evidence_refs=refs))
        add('time_budget',f'至少需要 {minutes} 分钟',resolve('time_budget',{},'remaining_minutes',number,lambda v:v>=minutes))
        for resource in plan['required_resources']:
            add('resource.'+resource,{'P1':'巡检员 P1','P2':'巡检员 P2','access_coordinator':'临时访问协调人员','mobile_terminal':'移动终端'}.get(resource,resource),resolve('resource_availability',{'resource_id':resource},'availability',lambda v:v in ('AVAILABLE','UNAVAILABLE'),lambda v:v=='AVAILABLE'))
        for permission in plan['required_permissions']:
            key=permission['person_id']+'.'+permission['zone_id']
            add('permission.'+key,'访问权限 '+key,resolve('access_permission',permission,'access',lambda v:v in ('ALLOWED','DENIED'),lambda v:v=='ALLOWED'))
        state='not_executable' if any(c['status']=='unsatisfied' for c in checks) else 'unknown' if any(c['status']=='unknown' for c in checks) else 'executable'
        results.append({**plan,'state':state,'checks':checks,'reason':'；'.join(c['reason'] for c in checks if c['status']!='satisfied') or '必要执行条件均满足；补检尚未发生。'})
    return results


def derive_blockers(tasks):
    return [dict(task_id=t['task_id'],dependency_id=c['dependency_id'],reason=c['reason'],
        evidence_refs=c['evidence_refs'],point_ids=c.get('point_ids',[])) for t in tasks for c in t['checks'] if c['status']=='unsatisfied']
