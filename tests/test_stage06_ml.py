"""Synthetic training must be real fitting, traceable, and fail closed on missing inputs."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / 'config' / 'ml' / 'inspection_history.json'
MODEL = ROOT / 'config' / 'ml' / 'inspection_tree.json'


def modules():
    assert importlib.util.find_spec('backend.analysis_ml'), 'Missing trained ML provider'
    assert importlib.util.find_spec('scripts.train_inspection_model'), 'Missing explicit training entry point'
    from backend import analysis_ml
    from scripts import train_inspection_model
    return analysis_ml, train_inspection_model


def run_value(**overrides):
    return {'run_id': 'test-frozen-run', 'as_of': '2026-11-01T00:00:00+00:00',
            'statistics': {'coverage_rate': 0.5, 'inspection_count': 4,
                           'anomaly_count': 2, 'pending_review_count': 2, **overrides},
            'task_results': [{'task_id': 'T1', 'state': 'blocked'}]}


def test_fitting_learns_from_labels_instead_of_returning_fixed_thresholds():
    ml, training = modules()
    rows = [{'features': {'coverage_rate': x, 'inspection_count': 3,
                         'anomaly_count': 0, 'pending_review_count': 0},
             'label': label} for x, label in [(0.1, 'PRIORITY'), (0.3, 'PRIORITY'),
                                              (0.7, 'ROUTINE'), (0.9, 'ROUTINE')]]
    first = training.fit_tree(rows, max_depth=2, min_samples_leaf=1)
    reversed_rows = [{**r, 'label': 'ROUTINE' if r['label'] == 'PRIORITY' else 'PRIORITY'} for r in rows]
    second = training.fit_tree(reversed_rows, max_depth=2, min_samples_leaf=1)
    features = rows[0]['features']
    assert ml.infer_tree(first, features)['label'] == 'PRIORITY'
    assert ml.infer_tree(second, features)['label'] == 'ROUTINE'


def test_training_is_reproducible_with_disjoint_temporal_holdout(tmp_path):
    ml, training = modules()
    first = training.train(DATASET, tmp_path / 'first.json')
    second = training.train(DATASET, tmp_path / 'second.json')
    assert first['tree'] == second['tree']
    assert first['model_version'] == second['model_version']
    assert first['metrics'] == second['metrics']
    bundled = json.loads(MODEL.read_text(encoding='utf-8'))
    assert (first['tree'], first['model_version'], first['metrics']) == (
        bundled['tree'], bundled['model_version'], bundled['metrics'])
    assert first['dataset']['source_type'] == 'SIMULATED'
    assert first['dataset']['label_source'] == 'DERIVED_LABEL'
    assert first['dataset']['sha256'] == ml.file_sha256(DATASET)
    split = first['split']
    assert split['train']['end'] < split['test']['start']
    assert set(split['train']['sample_ids']).isdisjoint(split['test']['sample_ids'])
    assert split['test_used_for_tuning'] is False
    assert sum(map(sum, first['metrics']['model']['confusion_matrix'])) == split['test']['count']
    assert first['metrics']['scope'] == 'SIMULATED_HELD_OUT_ONLY'
    assert first['metrics']['model']['accuracy'] > first['metrics']['majority_baseline']['accuracy']


def test_bundled_model_predicts_with_provenance_without_mutating_run():
    ml, _ = modules()
    run = run_value()
    before = deepcopy(run)
    result = ml.predict(run)
    assert result['status'] == 'ok' and result['error'] is None
    assert result['observed_at'] == run['as_of']
    value = result['value']
    assert value['source_type'] == 'MODEL_OUTPUT'
    assert value['features'] == run['statistics']
    assert value['dataset']['source_type'] == 'SIMULATED'
    assert value['prediction']['label'] in ('ROUTINE', 'PRIORITY')
    assert value['prediction']['score_label'] == 'uncalibrated_priority_leaf_fraction'
    assert value['model_id'] and value['model_version'] and value['trained_at']
    assert any('真实' in limitation for limitation in value['limitations'])
    assert run == before


@pytest.mark.parametrize('key', ['coverage_rate', 'inspection_count', 'anomaly_count', 'pending_review_count'])
def test_missing_features_are_unavailable_not_zero_imputed(key):
    ml, _ = modules()
    run = run_value()
    del run['statistics'][key]
    result = ml.predict(run)
    assert result['status'] == 'unavailable' and result['value'] is None
    assert key in result['error']


@pytest.mark.parametrize('bad', [None, True, -1, float('nan'), float('inf'), '1', 1.01])
def test_invalid_or_absent_coverage_never_becomes_a_valid_prediction(bad):
    ml, _ = modules()
    result = ml.predict(run_value(coverage_rate=bad))
    assert result['status'] in ('unavailable', 'error') and result['value'] is None


def test_missing_model_and_missing_dataset_are_explicit(tmp_path):
    ml, _ = modules()
    assert ml.predict(run_value(), model_path=tmp_path / 'absent.json')['status'] == 'unavailable'
    assert ml.predict(run_value(), dataset_path=tmp_path / 'absent.json')['status'] == 'unavailable'


def test_corrupt_model_and_changed_dataset_fail_integrity_check(tmp_path):
    ml, _ = modules()
    broken_model = tmp_path / 'model.json'
    artifact = json.loads(MODEL.read_text(encoding='utf-8'))
    artifact['tree']['label'] = 'ROUTINE' if artifact['tree']['label'] == 'PRIORITY' else 'PRIORITY'
    broken_model.write_text(json.dumps(artifact), encoding='utf-8')
    assert ml.predict(run_value(), model_path=broken_model)['status'] == 'error'
    changed_data = tmp_path / 'data.json'
    changed_data.write_bytes(DATASET.read_bytes() + b' ')
    assert ml.predict(run_value(), dataset_path=changed_data)['status'] == 'error'


def test_inputs_outside_training_range_are_visible():
    ml, _ = modules()
    result = ml.predict(run_value(pending_review_count=50))
    assert result['status'] == 'ok'
    assert 'pending_review_count' in result['value']['out_of_training_range']
    assert any('超出' in x for x in result['value']['limitations'])


def test_training_rejects_real_or_mixed_provenance(tmp_path):
    _, training = modules()
    data = json.loads(DATASET.read_text(encoding='utf-8'))
    data['samples'][0]['source_type'] = 'FIELD'
    path = tmp_path / 'mixed.json'
    path.write_text(json.dumps(data), encoding='utf-8')
    with pytest.raises(ValueError, match='SIMULATED'):
        training.train(path, tmp_path / 'must-not-exist.json')
    assert not (tmp_path / 'must-not-exist.json').exists()


def test_holdout_labels_and_values_cannot_change_fitted_tree_or_training_ranges(tmp_path):
    _, training = modules()
    original = training.train(DATASET, tmp_path / 'original-model.json')
    dataset = json.loads(DATASET.read_text(encoding='utf-8'))
    for row in dataset['samples'][180:]:
        row['features']['pending_review_count'] = 100
        row['label'] = 'PRIORITY' if row['label'] == 'ROUTINE' else 'ROUTINE'
    changed = tmp_path / 'changed-holdout.json'
    changed.write_text(json.dumps(dataset), encoding='utf-8')
    retrained = training.train(changed, tmp_path / 'changed-model.json')
    assert retrained['tree'] == original['tree']
    assert retrained['feature_ranges'] == original['feature_ranges']
    assert retrained['metrics'] != original['metrics']


def test_report_metrics_use_correct_positive_class_and_denominators():
    _, training = modules()
    report = training.metrics(['ROUTINE', 'ROUTINE', 'PRIORITY', 'PRIORITY', 'PRIORITY'],
                              ['ROUTINE', 'PRIORITY', 'PRIORITY', 'ROUTINE', 'PRIORITY'])
    assert report['confusion_matrix'] == [[1, 1], [1, 2]]
    assert report['accuracy'] == .6
    assert report['precision'] == report['recall'] == report['f1'] == pytest.approx(2 / 3)


def test_cli_regenerates_dataset_and_trains_a_loadable_model(tmp_path):
    ml, _ = modules()
    dataset_path, model_path = tmp_path / 'history.json', tmp_path / 'model.json'
    proc = subprocess.run([sys.executable, '-B', str(ROOT / 'scripts' / 'train_inspection_model.py'),
                           '--generate-dataset', str(dataset_path), '--dataset', str(dataset_path),
                           '--output', str(model_path)], cwd=ROOT, capture_output=True, text=True, encoding='utf-8',
                          env={**os.environ,'PYTHONIOENCODING':'utf-8'}, timeout=15)
    assert proc.returncode == 0, proc.stderr
    assert dataset_path.read_bytes() == DATASET.read_bytes()
    assert json.loads(proc.stdout)['source_type'] == 'SIMULATED'
    assert ml.predict(run_value(), model_path=model_path, dataset_path=dataset_path)['status'] == 'ok'
    absent_output = tmp_path / 'absent-model.json'
    failed = subprocess.run([sys.executable, '-B', str(ROOT / 'scripts' / 'train_inspection_model.py'),
                             '--dataset', str(tmp_path / 'absent-data.json'), '--output', str(absent_output)],
                            cwd=ROOT, capture_output=True, text=True, encoding='utf-8',
                            env={**os.environ,'PYTHONIOENCODING':'utf-8'}, timeout=15)
    assert failed.returncode == 1
    assert not absent_output.exists()
