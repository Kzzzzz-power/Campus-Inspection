"""Read-only teaching inputs, not a task engine or a live-data seeder."""
from datetime import datetime, timedelta

if __package__:
    from .configuration import CONFIG, FACILITIES, read_json
else:
    from configuration import CONFIG, FACILITIES, read_json


def _time(value):
    stamp = datetime.fromisoformat(value)
    if stamp.utcoffset() is None:
        raise ValueError('基线时间必须带时区。')
    return stamp


def _index(rows, key):
    result = {row[key]: row for row in rows}
    if len(result) != len(rows) or any(not isinstance(k, str) or not k for k in result):
        raise ValueError(f'基线标识为空或重复: {key}')
    return result


def _validate_s1(data):
    if (data['scenario_id'] != 'S1' or data['schema_version'] != 1
            or data['source_type'] != 'SIMULATED' or data['scope'] != 'facility_baseline_input'
            or {'run_id', 'task_results', 'coverage_rate'} & data.keys()):
        raise ValueError('S1 文件只能保存明确标注的教学输入，不能预填任务判定。')
    at, round_ = _time(data['as_of']), data['inspection_round']
    start, end = _time(round_['window_start']), _time(round_['window_end'])
    if (not round_['inspection_round_id'] or round_['timezone'] != 'Asia/Shanghai'
            or start.utcoffset() != timedelta(hours=8) or end.utcoffset() != timedelta(hours=8)
            or start.strftime('%H:%M:%S') != '09:00:00' or end.strftime('%H:%M:%S') != '09:45:00'
            or end - start != timedelta(minutes=45) or not start <= at <= end):
        raise ValueError('S1 教学轮次必须使用同日 09:00–09:45 窗口。')
    facilities = {f['facility_id']: f for f in FACILITIES}
    points = {f['checkpoint_id']: f for f in FACILITIES}
    current = _index(data['facility_observations'], 'facility_id')
    if set(current) != set(facilities):
        raise ValueError('S1 当前观察必须覆盖配置中的全部设施。')
    observations = _index(data['historical_observations'] + data['facility_observations'], 'observation_id')
    for row in observations.values():
        if (row['facility_id'] not in facilities or row['zone_id'] != facilities[row['facility_id']]['zone_id']
                or row['source_type'] != 'SIMULATED' or _time(row['observed_at']) > at
                or row['payload_json']['condition'] not in ('NORMAL', 'WARNING', 'FAULT')
                or row['payload_json']['availability'] != 'AVAILABLE'):
            raise ValueError('S1 设施观察的引用、来源、时间或业务状态无效。')
    if any(_time(row['observed_at']) < start for row in current.values()):
        raise ValueError('S1 当前观察不能引用窗口外的历史状态。')
    inspections = _index(data['inspection_records'], 'inspection_id')
    checkpoint_records = _index(data['inspection_records'], 'checkpoint_id')
    if set(checkpoint_records) != set(points):
        raise ValueError('此 S1 输入应保留八个点位的教学现场记录。')
    for row in inspections.values():
        point = points[row['checkpoint_id']]
        if (row['facility_id'] != point['facility_id'] or row['zone_id'] != point['zone_id']
                or row['inspection_round_id'] != round_['inspection_round_id']
                or not start <= _time(row['inspected_at']) <= at
                or row['method'] != 'ON_SITE' or row['onsite_confirmed'] is not True
                or row['source_type'] != 'SIMULATED' or not row['inspector_id']
                or row['result'] not in ('NORMAL', 'WARNING', 'FAULT')):
            raise ValueError('现场记录的点位、轮次、时间或来源无效。')
    reviews = _index(data['review_requests'], 'review_id')
    evidence = _index(data['evidence'], 'evidence_id')
    for row in evidence.values():
        if (row['status'] != 'ok' or row['source_type'] != 'SIMULATED' or row['facility_id'] not in facilities
                or not _time(row['observed_at']) <= _time(row['retrieved_at']) <= _time(row['created_at']) <= at
                or row['review_id'] is not None and row['review_id'] not in reviews):
            raise ValueError('S1 确认链必须取得有效证据；取得状态不等于业务状态。')
        value = row['value_json']
        if row['evidence_type'] in ('remote_status', 'historical_observation'):
            observation = observations[value['observation_id']]
            if (observation['facility_id'] != row['facility_id']
                    or observation['payload_json']['condition'] != value['condition']
                    or _time(observation['observed_at']) != _time(row['observed_at'])):
                raise ValueError('观察证据与原始观察不一致。')
        elif row['evidence_type'] == 'inspection_record':
            inspection = inspections[value['inspection_id']]
            if (inspection['facility_id'] != row['facility_id'] or inspection['result'] != value['result']
                    or _time(inspection['inspected_at']) != _time(row['observed_at'])):
                raise ValueError('现场证据与原始记录不一致。')
        elif row['evidence_type'] != 'review_confirmation':
            raise ValueError('未知基线证据类型。')
    if len(reviews) != 1:
        raise ValueError('此基线必须保留 C03 的一次已确认复核。')
    review = next(iter(reviews.values()))
    confirmation = evidence[review['completion_evidence_id']]
    value = confirmation['value_json']
    alarm = observations[value['historical_observation_id']]
    observed = observations[value['current_observation_id']]
    inspection = inspections[value['inspection_id']]
    basis = [evidence[key] for key in value['basis_evidence_ids']]
    by_type = _index(basis, 'evidence_type')
    if set(by_type) != {'historical_observation', 'remote_status', 'inspection_record'}:
        raise ValueError('复核确认必须引用历史、当前远程和现场三份依据。')
    if (by_type['historical_observation']['value_json']['observation_id'] != alarm['observation_id']
            or by_type['remote_status']['value_json']['observation_id'] != observed['observation_id']
            or by_type['inspection_record']['value_json']['inspection_id'] != inspection['inspection_id']
            or any(by_type[k]['review_id'] != review['review_id'] for k in ('remote_status', 'inspection_record'))):
        raise ValueError('复核依据必须回连本次确认所用的原始观察、现场记录和请求。')
    # This frozen fixture is synchronous; future offline uploads need separate timing rules.
    if (any(_time(e['created_at']) > _time(confirmation['observed_at']) for e in basis)
            or _time(confirmation['created_at']) > _time(review['completed_at'])):
        raise ValueError('确认不能使用稍后才取得的依据；复核完成前应已留存确认凭据。')
    if (review['facility_id'] != 'ap-2f' or review['zone_id'] != 'Z1' or review['status'] != 'completed'
            or review['trigger_run_id'] is not None or confirmation['review_id'] != review['review_id']
            or confirmation['evidence_type'] != 'review_confirmation'
            or any(row['facility_id'] != 'ap-2f' for row in [confirmation, alarm, observed, inspection] + basis)
            or value['historical_alarm_confirmed'] is not True or alarm not in data['historical_observations']
            or alarm['payload_json']['condition'] != 'WARNING' or observed != current['ap-2f']
            or value['conclusion'] not in ('ruled_out', 'confirmed_abnormal')
            or (value['conclusion'] == 'ruled_out') != (observed['payload_json']['condition'] == 'NORMAL')
            or {e['evidence_type'] for e in basis} != {'historical_observation', 'remote_status', 'inspection_record'}
            or not _time(alarm['observed_at']) < _time(observed['observed_at']) <= _time(confirmation['observed_at'])
            or not _time(inspection['inspected_at']) <= _time(confirmation['observed_at'])
            or not _time(review['created_at']) <= _time(confirmation['observed_at']) <= _time(review['completed_at']) <= at):
        raise ValueError('C03 历史告警、当前状态、现场记录与复核确认链不一致。')


def load_s1(path=CONFIG / 'scenarios' / 'S1.json'):
    data = read_json(path)
    try:
        _validate_s1(data)
    except (KeyError, TypeError, IndexError, AttributeError, ValueError) as error:
        raise ValueError(f'S1 教学基线无效: {error}') from error
    return data
