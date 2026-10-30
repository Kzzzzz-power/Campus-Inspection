export function matchesPoint(point, filters) {
  const query = filters.query.trim().toLocaleLowerCase();
  const searchable = [point.point_id, point.facility_id, point.device, point.building, point.floor, point.zone_id, point.zone_name].filter(Boolean).join(" ");
  if (query && !searchable.toLocaleLowerCase().includes(query)) return false;
  if (filters.scope.startsWith('building:') && point.building !== filters.scope.slice(9)) return false;
  if (filters.scope.startsWith('zone:') && point.zone_id !== filters.scope.slice(5)) return false;
  if (filters.required === 'required' && !point.required) return false;
  if (filters.required === 'optional' && point.required) return false;
  switch (filters.status) {
    case 'missing': return point.required && !point.covered;
    case 'covered': return point.required && point.covered;
    case 'alarm': return point.latest_status === 'alarm';
    case 'unknown': return ['unknown', 'no-record'].includes(point.latest_status);
    case 'pending': return point.review?.status === 'pending';
    case 'completed': return point.review?.status === 'completed';
    default: return true;
  }
}

export function facilityState(p) {
  if(p.realtime && p.realtime.reason!=='disabled'){
    if(!p.realtime.current)return ['状态未知','warn'];
    const observation=p.realtime.facility.observation;
    const availability={AVAILABLE:'可用',UNAVAILABLE:'不可用',UNKNOWN:'可用性未知'};
    const condition={NORMAL:'正常',WARNING:'警告',FAULT:'故障'};
    return [`${availability[observation.availability]} · ${condition[observation.condition]}`,p.latest_status==='alarm'?'danger':p.latest_status==='ok'?'good':'warn'];
  }
  return ({ok:['最近记录正常','good'],alarm:['告警待关注','danger'],unknown:['状态待确认','warn'],'no-record':['暂无状态记录','muted']})[p.latest_status]||['状态待确认','muted']; }

export function coverageState(p) { return !p.required?['不计入必检统计','muted']:p.covered?['现场记录有效','good']:['缺少有效现场记录','warn']; }
