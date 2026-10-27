export function matchesPoint(point, filters) {
  const query = filters.query.trim().toLocaleLowerCase();
  if (query && !`${point.point_id} ${point.device}`.toLocaleLowerCase().includes(query)) return false;
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