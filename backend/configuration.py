"""One validated B02 catalog; legacy API names are projections of this config."""
import json
from pathlib import Path
import re

CONFIG = Path(__file__).resolve().parents[1] / 'config'


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except (OSError, ValueError) as error:
        raise ValueError(f'无法读取配置 {path}: {error}') from error


def load_catalog(directory=CONFIG):
    directory = Path(directory)
    zones = read_json(directory / 'zones.json')
    facilities = read_json(directory / 'facilities.json')
    if not isinstance(zones, list) or not isinstance(facilities, list):
        raise ValueError('区域和设施配置必须为数组。')
    zone_map = {}
    for zone in zones:
        if not isinstance(zone, dict) or any(not isinstance(zone.get(k), str) or not zone[k].strip()
                                              for k in ('zone_id', 'name', 'building', 'floor')):
            raise ValueError('区域配置缺少有效的标识、名称、楼栋或楼层。')
        zid = zone['zone_id']
        if zid in zone_map:
            raise ValueError(f'区域标识重复: {zid}')
        zone_map[zid] = {k: zone[k] for k in ('name', 'building', 'floor')}
        zone_map[zid]['points'] = []
    if set(zone_map) != {'Z1', 'Z2', 'Z3'}:
        raise ValueError('B02 基线必须配置 Z1、Z2、Z3 三个区域。')
    points, facility_ids = {}, set()
    for facility in facilities:
        if not isinstance(facility, dict) or any(not isinstance(facility.get(k), str) or not facility[k].strip()
                                                for k in ('checkpoint_id', 'facility_id', 'zone_id', 'name')):
            raise ValueError('设施配置缺少有效的点位、设施、区域或名称。')
        pid, fid, zid = (facility[k] for k in ('checkpoint_id', 'facility_id', 'zone_id'))
        if pid in points or fid in facility_ids:
            raise ValueError(f'点位或设施标识重复: {pid} / {fid}')
        if zid not in zone_map or not re.fullmatch(r'[a-z][a-z0-9-]*', fid):
            raise ValueError(f'区域引用或设施标识无效: {pid}')
        if type(facility.get('critical')) is not bool:
            raise ValueError(f'critical 必须是布尔值: {pid}')
        points[pid] = {'device': facility['name'], 'required': facility['critical'], 'facility_id': fid}
        facility_ids.add(fid)
        zone_map[zid]['points'].append(pid)
    if set(points) != {f'C{i:02}' for i in range(1, 9)}:
        raise ValueError('B02 基线必须完整配置 C01–C08。')
    if [len(zone_map[z]['points']) for z in ('Z1', 'Z2', 'Z3')] != [3, 3, 2]:
        raise ValueError('三个区域的点位数必须为 3、3、2。')
    if sum(p['required'] for p in points.values()) != 6:
        raise ValueError('B02 基线必须包含六个必检点。')
    return {'facilities': facilities, 'zones': zone_map, 'points': points}


CATALOG = load_catalog()
FACILITIES, ZONES, POINTS = (CATALOG[k] for k in ('facilities', 'zones', 'points'))
