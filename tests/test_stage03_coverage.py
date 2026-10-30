"""Formal T1 coverage from configuration and explicit round facts."""
from copy import deepcopy
import pytest
from backend.configuration import FACILITIES
from backend.coverage import calculate_coverage

ROUND = {'inspection_round_id':'R','window_start':'2026-10-29T09:00:00+08:00','window_end':'2026-10-29T09:45:00+08:00'}
AS_OF = '2026-10-29T09:45:00+08:00'
def records():
    return [{'inspection_id':f['checkpoint_id'],'inspection_round_id':'R','checkpoint_id':f['checkpoint_id'],
             'facility_id':f['facility_id'],'zone_id':f['zone_id'],'inspector_id':'P1',
             'inspected_at':'2026-10-29T09:05:00+08:00','method':'ON_SITE','source_type':'ON_SITE',
             'result':'NORMAL','supersedes_id':None} for f in FACILITIES]
def calc(rows=None, as_of=AS_OF):
    return calculate_coverage(FACILITIES, records() if rows is None else rows, ROUND, as_of)

def test_critical_configuration_and_trace():
    result=calc()
    assert result['required']==6 and result['covered']==6 and result['missing']==[] and result['coverage_rate']==1
    assert [p['checkpoint_id'] for p in result['points'] if p['required']]==['C01','C02','C04','C05','C07','C08']
    assert result['points'][0]['inspection_refs']==['C01']
    assert calc([r for r in records() if r['checkpoint_id']!='C03'])['covered']==6
    assert calc([r for r in records() if r['checkpoint_id']!='C07'])['missing']==['C07']

@pytest.mark.parametrize('field,value,reason',[
    ('inspection_round_id','OTHER','wrong_round'),
    ('inspected_at','2026-10-29T08:59:59+08:00','outside_window'),
    ('inspected_at','2026-10-29T09:45:01+08:00','outside_window'),
    ('method','REMOTE','not_on_site'),('source_type','DEVICE','untraceable_source'),
    ('inspector_id','','missing_inspector'),('facility_id','OTHER','mapping_mismatch'),
    ('zone_id','OTHER','mapping_mismatch'),('result',None,'unconfirmed_result'),
    ('inspection_id','','missing_inspection_id'),('inspected_at','invalid','invalid_inspected_at'),
    ('inspected_at','2026-10-29T09:05:00','invalid_inspected_at')])
def test_invalid_records_have_reasons(field,value,reason):
    rows=records(); rows[0][field]=value; result=calc(rows)
    assert result['covered']==5 and result['missing']==['C01']
    assert reason in result['points'][0]['invalid_records'][0]['reasons']

@pytest.mark.parametrize('inspected',['2026-10-29T09:00:00+08:00','2026-10-29T01:45:00Z'])
@pytest.mark.parametrize('result',['WARNING','FAULT'])
@pytest.mark.parametrize('source',['ON_SITE','SIMULATED'])
def test_inclusive_boundaries_results_and_simulation(inspected,result,source):
    rows=records(); rows[0].update(inspected_at=inspected,result=result,source_type=source)
    assert calc(rows)['covered']==6

def test_future_record_does_not_count():
    result=calc(as_of='2026-10-29T09:04:59+08:00')
    assert result['covered']==0
    assert 'after_as_of' in result['points'][0]['invalid_records'][0]['reasons']

def test_future_correction_does_not_hide_current_record():
    rows=records(); correction={**rows[0],'inspection_id':'fix','supersedes_id':'C01','result':None,'inspected_at':'2026-10-29T09:10:00+08:00'}
    assert calc(rows+[correction],'2026-10-29T09:08:00+08:00')['covered']==6

def test_effective_invalid_correction_does_not_resurrect_old_record():
    rows=records(); correction={**rows[0],'inspection_id':'fix','supersedes_id':'C01','result':None,'inspected_at':'2026-10-29T09:10:00+08:00'}
    result=calc(rows+[correction]); assert result['missing']==['C01']
    assert 'superseded' in result['points'][0]['invalid_records'][0]['reasons']

def test_valid_correction_uses_new_reference():
    rows=records(); correction={**rows[0],'inspection_id':'fix','supersedes_id':'C01','result':'FAULT','inspected_at':'2026-10-29T09:10:00+08:00'}
    result=calc(rows+[correction]); assert result['covered']==6
    assert result['points'][0]['inspection_refs']==['fix']

@pytest.mark.parametrize('change',[{'checkpoint_id':'C02'},{'inspection_round_id':'OTHER'}])
def test_cross_point_or_round_correction_does_not_suppress_valid_record(change):
    rows=records(); invalid={**rows[0],**change,'inspection_id':'bad','supersedes_id':'C01','result':None}
    assert calc(rows+[invalid])['covered']==6

def test_ambiguous_correction_chain_does_not_claim_coverage():
    rows=records(); first={**rows[0],'inspection_id':'a','supersedes_id':'C01'}; competing={**first,'inspection_id':'b'}
    result=calc(rows+[first,competing]); assert result['missing']==['C01']
    assert any('ambiguous_correction' in row['reasons'] for row in result['points'][0]['invalid_records'])

def test_repeated_records_do_not_increase_covered_count():
    rows=records(); result=calc(rows+[{**rows[0],'inspection_id':'second'}]); assert result['covered']==6
    assert result['points'][0]['inspection_refs']==['C01','second']

def test_config_controls_required_points():
    facilities=deepcopy(FACILITIES); facilities[2]['critical']=True
    result=calculate_coverage(facilities,[r for r in records() if r['checkpoint_id']!='C03'],ROUND,AS_OF)
    assert result['required']==7 and result['covered']==6 and result['missing']==['C03']
    assert result['coverage_rate']==pytest.approx(6/7)

def test_inputs_are_not_mutated():
    rows=records(); before=deepcopy(rows); facilities_before=deepcopy(FACILITIES); round_before=deepcopy(ROUND)
    calc(rows); assert rows==before and FACILITIES==facilities_before and ROUND==round_before

@pytest.mark.parametrize('round_value',[None,{}, {**ROUND,'window_end':'bad'},{**ROUND,'window_start':'2026-10-29T09:46:00+08:00'}])
def test_requires_explicit_valid_round(round_value):
    with pytest.raises(ValueError): calculate_coverage(FACILITIES,records(),round_value,AS_OF)

def test_requires_valid_configuration_and_as_of():
    with pytest.raises(ValueError): calculate_coverage([],records(),ROUND,AS_OF)
    with pytest.raises(ValueError): calculate_coverage(FACILITIES,records(),ROUND,'bad')

def test_query_failure_is_not_zero_success():
    def failure():
        raise RuntimeError('database unavailable')
        yield
    with pytest.raises(RuntimeError,match='database unavailable'): calculate_coverage(FACILITIES,failure(),ROUND,AS_OF)

@pytest.mark.parametrize('change',[
    {'method':'REMOTE'},{'source_type':'DEVICE'},{'facility_id':'OTHER'},
    {'zone_id':'OTHER'},{'inspector_id':''},
    {'inspected_at':'2026-10-29T08:59:59+08:00'},
    {'inspected_at':'2026-10-29T09:45:01+08:00'}])
def test_invalid_origin_correction_cannot_suppress_valid_record(change):
    rows=records()
    correction={**rows[0],'inspection_id':'invalid-fix','supersedes_id':'C01','result':None,**change}
    result=calc(rows+[correction],as_of='2026-10-29T10:00:00+08:00')
    assert result['covered']==6
    assert result['points'][0]['inspection_refs']==['C01']


def test_invalid_remote_branch_does_not_make_real_correction_ambiguous():
    rows=records()
    valid={**rows[0],'inspection_id':'valid-fix','supersedes_id':'C01','result':'FAULT'}
    remote={**valid,'inspection_id':'remote-fix','method':'REMOTE'}
    result=calc(rows+[valid,remote])
    assert result['covered']==6
    assert result['points'][0]['inspection_refs']==['valid-fix']
