"""Formal coverage from configuration, round and traceable on-site facts."""
from collections import defaultdict
from datetime import datetime, timedelta, timezone

SHANGHAI = timezone(timedelta(hours=8))


def _time(value):
    if not isinstance(value, str):
        raise ValueError('A timezone-aware ISO datetime is required')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.utcoffset() is None:
            raise ValueError('Datetime requires a timezone')
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        raise ValueError('A timezone-aware ISO datetime is required') from None


def _identifier(value):
    return isinstance(value, str) and bool(value.strip())


def calculate_coverage(facilities, records, inspection_round, as_of,
                       exclude_inspection_points=()):
    """Compute coverage without mutating facts or assigning task states.

    Effective corrections replace old facts, including when the replacement
    result is unconfirmed. Ambiguous correction chains cannot prove coverage.
    Input iteration/query errors propagate rather than becoming zero coverage.
    """
    catalog = [dict(facility) for facility in facilities]
    if not catalog:
        raise ValueError('Facilities configuration must not be empty')
    checkpoints, facility_ids = set(), set()
    for facility in catalog:
        if (any(not _identifier(facility.get(k)) for k in ('checkpoint_id','facility_id','zone_id'))
                or type(facility.get('critical')) is not bool
                or facility['checkpoint_id'] in checkpoints or facility['facility_id'] in facility_ids):
            raise ValueError('Facilities configuration is invalid or duplicated')
        checkpoints.add(facility['checkpoint_id'])
        facility_ids.add(facility['facility_id'])
    if not isinstance(inspection_round, dict):
        raise ValueError('An explicit inspection round is required')
    round_id = inspection_round.get('inspection_round_id')
    if not _identifier(round_id):
        raise ValueError('An explicit inspection round identifier is required')
    start, end = _time(inspection_round.get('window_start')), _time(inspection_round.get('window_end'))
    local_start, local_end = start.astimezone(SHANGHAI), end.astimezone(SHANGHAI)
    if (local_start.date() != local_end.date()
            or (local_start.hour,local_start.minute,local_start.second,local_start.microsecond) != (9,0,0,0)
            or (local_end.hour,local_end.minute,local_end.second,local_end.microsecond) != (9,45,0,0)):
        raise ValueError('The round window must be 09:00–09:45 Asia/Shanghai')
    cutoff = _time(as_of)
    if isinstance(exclude_inspection_points, (str,bytes)):
        raise ValueError('Excluded points must be a collection of checkpoint IDs')
    excluded = set(exclude_inspection_points)
    if not excluded <= checkpoints:
        raise ValueError('Excluded points contain an unknown checkpoint')

    rows = [dict(record) for record in records]
    by_id, parsed_times = defaultdict(list), {}
    for index,row in enumerate(rows):
        record_id = row.get('inspection_id')
        if _identifier(record_id):
            by_id[record_id].append(index)
        try:
            parsed_times[index] = _time(row.get('inspected_at'))
        except ValueError:
            parsed_times[index] = None
    duplicate_conflicts, duplicate_copies = set(), set()
    for indexes in by_id.values():
        first = indexes[0]
        if any(rows[index] != rows[first] for index in indexes[1:]):
            duplicate_conflicts.update(indexes)
        else:
            duplicate_copies.update(indexes[1:])
    catalog_by_point = {f['checkpoint_id']: f for f in catalog}

    def correction_origin_valid(index, row):
        facility = catalog_by_point.get(row.get('checkpoint_id'))
        inspected = parsed_times[index]
        # An unconfirmed result can retract coverage, but unrelated or remote
        # observations cannot supersede a traceable on-site inspection.
        return (facility is not None
                and row.get('facility_id') == facility['facility_id']
                and row.get('zone_id') == facility['zone_id']
                and row.get('method') == 'ON_SITE'
                and row.get('source_type') in ('ON_SITE', 'SIMULATED')
                and _identifier(row.get('inspector_id'))
                and inspected is not None and start <= inspected <= end)

    active = {index for index,row in enumerate(rows)
              if index not in duplicate_conflicts and index not in duplicate_copies
              and row.get('inspection_round_id') == round_id and parsed_times[index] is not None
              and parsed_times[index] <= cutoff and _identifier(row.get('inspection_id'))
              and correction_origin_valid(index, row)}
    parents, children, invalid_links = {}, defaultdict(list), set()
    for index in active:
        row = rows[index]
        prior_id = row.get('supersedes_id')
        if prior_id is None:
            continue
        candidates = by_id.get(prior_id, [])
        prior = candidates[0] if candidates else None
        if (prior is None or prior not in active
                or rows[prior].get('checkpoint_id') != row.get('checkpoint_id')
                or rows[prior].get('inspection_round_id') != row.get('inspection_round_id')):
            invalid_links.add(index)
            continue
        parents[index] = prior
        children[prior].append(index)
    ambiguous = set()
    for parent,replacements in children.items():
        if len(replacements) > 1:
            pending = [parent]
            while pending:
                node = pending.pop()
                if node not in ambiguous:
                    ambiguous.add(node)
                    pending.extend(children.get(node, ()))
    for index in active:
        chain, positions, node = [], {}, index
        while node in parents:
            if node in positions:
                ambiguous.update(chain[positions[node]:])
                break
            positions[node] = len(chain)
            chain.append(node)
            node = parents[node]
    pending = list(ambiguous | invalid_links)
    while pending:
        node = pending.pop()
        for child in children.get(node, ()):
            if child not in ambiguous:
                ambiguous.add(child)
                pending.append(child)
    superseded, points = set(children), []
    for facility in catalog:
        checkpoint, refs, invalid = facility['checkpoint_id'], [], []
        for index,row in enumerate(rows):
            if row.get('checkpoint_id') != checkpoint or index in duplicate_copies:
                continue
            reasons = []
            if not _identifier(row.get('inspection_id')):
                reasons.append('missing_inspection_id')
            if index in duplicate_conflicts:
                reasons.append('duplicate_inspection_id')
            if row.get('inspection_round_id') != round_id:
                reasons.append('wrong_round')
            if row.get('facility_id') != facility['facility_id'] or row.get('zone_id') != facility['zone_id']:
                reasons.append('mapping_mismatch')
            if row.get('method') != 'ON_SITE':
                reasons.append('not_on_site')
            if row.get('source_type') not in ('ON_SITE','SIMULATED'):
                reasons.append('untraceable_source')
            if not _identifier(row.get('inspector_id')):
                reasons.append('missing_inspector')
            if row.get('result') not in ('NORMAL','WARNING','FAULT'):
                reasons.append('unconfirmed_result')
            inspected = parsed_times[index]
            if inspected is None:
                reasons.append('invalid_inspected_at')
            else:
                if not start <= inspected <= end:
                    reasons.append('outside_window')
                if inspected > cutoff:
                    reasons.append('after_as_of')
            if checkpoint in excluded:
                reasons.append('excluded_by_input')
            if index in invalid_links:
                reasons.append('invalid_supersedes')
            if index in superseded:
                reasons.append('superseded')
            if index in ambiguous:
                reasons.append('ambiguous_correction')
            if reasons:
                invalid.append({'inspection_id':row.get('inspection_id'),'reasons':reasons})
            else:
                refs.append(row['inspection_id'])
        points.append({**facility,'required':facility['critical'],'covered':bool(refs),
                       'inspection_refs':sorted(set(refs)),'invalid_records':invalid})
    required_points = [p for p in points if p['required']]
    required, covered = len(required_points), sum(p['covered'] for p in required_points)
    return {'inspection_round_id':round_id,'as_of':cutoff.isoformat(),
            'window_start':start.isoformat(),'window_end':end.isoformat(),'timezone':'Asia/Shanghai',
            'required':required,'covered':covered,
            'missing':[p['checkpoint_id'] for p in required_points if not p['covered']],
            'coverage_rate':covered/required if required else None,'points':points}

