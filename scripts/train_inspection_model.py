"""Explicit stdlib CART training; defaults write artifacts only under .runtime.

Example: python -B scripts/train_inspection_model.py
Rebuild synthetic data: add --generate-dataset .runtime/ml/inspection_history.json
and --dataset .runtime/ml/inspection_history.json. No runtime request fits a model.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import random
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from backend.analysis_ml import (CLASSES, DATASET_PATH, FEATURES, LIMITATIONS,
                                 digest, extract_features, file_sha256, infer_tree)

TRAINING_CONFIG = {'max_depth': 4, 'min_samples_leaf': 6, 'criterion': 'gini'}


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_suffix(path.suffix + '.tmp')
    staging.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    staging.replace(path)


def generate_dataset():
    """All dates are fictional teaching coordinates, never real observation times."""
    seed = 601
    rng = random.Random(seed)
    start = datetime(2026, 1, 1, 8, tzinfo=timezone(timedelta(hours=8)))
    rows = []
    for index in range(240):
        covered = rng.randint(0, 6)
        features = {'coverage_rate': covered / 6, 'inspection_count': covered + rng.randint(0, 2),
                    'anomaly_count': rng.randint(0, 3), 'pending_review_count': rng.randint(0, 3)}
        score = (2 * (1 - features['coverage_rate']) + .8 * features['pending_review_count']
                 + .45 * features['anomaly_count'] + rng.uniform(-.7, .7))
        rows.append({'sample_id': f'SIM-{index + 1:04d}', 'source_type': 'SIMULATED',
                     'simulated_at': (start + timedelta(hours=4 * index)).isoformat(),
                     'features': features, 'label': 'PRIORITY' if score >= 2.9 else 'ROUTINE'})
    return {'schema_version': 1, 'dataset_id': 'b02-teaching-inspection-history-v1',
            'source_type': 'SIMULATED', 'label_source': 'DERIVED_LABEL',
            'feature_order': FEATURES, 'class_order': CLASSES,
            'provenance': {'creator': 'project synthetic teaching generator', 'seed': seed,
                'generator': 'scripts/train_inspection_model.py:generate_dataset',
                'time_semantics': 'simulated_at 为虚构顺序坐标，不是真实巡检记录时间；未读取真实库、人员或照片。',
                'feature_generation': '6 required points; covered=randint(0,6); inspections=covered+randint(0,2); anomalies,pending=randint(0,3)',
                'label_rule': 'PRIORITY iff 2*(1-coverage_rate)+0.8*pending_review_count+0.45*anomaly_count+U(-0.7,0.7)>=2.9; otherwise ROUTINE',
                'label_meaning': '虚构的人工复访工作优先级教学标签，非故障、非风险或未来事件标签；随机项模拟未建模的安排差异。',
                'reuse': 'GreenMate ml_pipeline.py 的固定切分、基线、摘要和限制说明方式；未使用农业数据或模型。'},
            'samples': rows}


def fit_tree(rows, *, max_depth=4, min_samples_leaf=6):
    """CART: enumerate observed midpoint splits, minimize weighted Gini on train."""
    def gini(group):
        return 1 - sum((sum(r['label'] == label for r in group) / len(group)) ** 2 for label in CLASSES)

    def grow(group, depth):
        counts = {label: sum(row['label'] == label for row in group) for label in CLASSES}
        node = {'label': max(CLASSES, key=lambda key: counts[key]), 'counts': counts}
        if depth >= max_depth or min(counts.values()) == 0 or len(group) < 2 * min_samples_leaf:
            return node
        best_loss = gini(group)
        best = None
        for feature in FEATURES:
            values = sorted({row['features'][feature] for row in group})
            for lower, upper in zip(values, values[1:]):
                threshold = (lower + upper) / 2
                left = [row for row in group if row['features'][feature] <= threshold]
                right = [row for row in group if row['features'][feature] > threshold]
                if min(len(left), len(right)) < min_samples_leaf:
                    continue
                loss = (len(left) * gini(left) + len(right) * gini(right)) / len(group)
                if loss < best_loss - 1e-12:
                    best_loss, best = loss, (feature, threshold, left, right)
        if best:
            feature, threshold, left, right = best
            node.update(feature=feature, threshold=threshold, left=grow(left, depth + 1), right=grow(right, depth + 1))
        return node

    if not rows or any(row['label'] not in CLASSES for row in rows):
        raise ValueError('training rows need supported labels')
    for row in rows:
        extract_features(row['features'])
    return grow(rows, 0)


def metrics(actual, predicted):
    matrix = [[sum(a == row and p == col for a, p in zip(actual, predicted)) for col in CLASSES] for row in CLASSES]
    tn, fp = matrix[0]
    fn, tp = matrix[1]
    return {'accuracy': (tn + tp) / len(actual), 'precision': tp / (tp + fp) if tp + fp else 0,
            'recall': tp / (tp + fn) if tp + fn else 0,
            'f1': 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0,
            'confusion_matrix': matrix, 'class_order': CLASSES, 'positive_class': 'PRIORITY'}


def train(dataset_path, output_path):
    dataset = json.loads(Path(dataset_path).read_text(encoding='utf-8'))
    if (dataset['schema_version'] != 1 or dataset['source_type'] != 'SIMULATED'
            or dataset['label_source'] != 'DERIVED_LABEL'
            or dataset['feature_order'] != FEATURES or dataset['class_order'] != CLASSES):
        raise ValueError('only the SIMULATED teaching data contract is supported')
    rows = dataset['samples']
    if len(rows) < 40 or any(row['source_type'] != 'SIMULATED' for row in rows):
        raise ValueError('at least 40 SIMULATED samples are required')
    dates = [datetime.fromisoformat(row['simulated_at']) for row in rows]
    if (any(d.tzinfo is None for d in dates) or any(a >= b for a, b in zip(dates, dates[1:]))
            or len({row['sample_id'] for row in rows}) != len(rows)):
        raise ValueError('samples must have unique IDs and strictly increasing timezone-aware times')
    for row in rows:
        extract_features(row['features'])
        if row['label'] not in CLASSES:
            raise ValueError('unsupported derived label')
    cut = len(rows) * 3 // 4
    training, test = rows[:cut], rows[cut:]
    if any(set(row['label'] for row in group) != set(CLASSES) for group in (training, test)):
        raise ValueError('each fixed split requires both classes; no automatic resplitting')
    tree = fit_tree(training, max_depth=TRAINING_CONFIG['max_depth'], min_samples_leaf=TRAINING_CONFIG['min_samples_leaf'])
    baseline = max(CLASSES, key=lambda label: sum(row['label'] == label for row in training))
    predicted = [infer_tree(tree, row['features'])['label'] for row in test]
    actual = [row['label'] for row in test]
    dataset_meta = {'dataset_id': dataset['dataset_id'], 'source_type': dataset['source_type'],
                    'label_source': dataset['label_source'], 'sha256': file_sha256(dataset_path),
                    'sample_count': len(rows), 'provenance': dataset['provenance']}
    split = {'method': 'chronological_first_75_percent_train_last_25_percent_test', 'test_used_for_tuning': False}
    for name, group in [('train', training), ('test', test)]:
        split[name] = {'count': len(group), 'start': group[0]['simulated_at'], 'end': group[-1]['simulated_at'],
                       'sample_ids': [row['sample_id'] for row in group],
                       'class_counts': {label: sum(row['label'] == label for row in group) for label in CLASSES}}
    artifact = {'schema_version': 1, 'model_id': 'b02-revisit-priority-cart',
                'model_version': 'cart-v1-' + digest({'dataset': dataset_meta['sha256'], 'config': TRAINING_CONFIG, 'tree': tree})[:16],
                'trained_at': datetime.now(timezone.utc).isoformat(),
                'algorithm': 'CART binary classification (stdlib implementation)',
                'training_config': TRAINING_CONFIG, 'feature_order': FEATURES, 'class_order': CLASSES,
                'dataset': dataset_meta, 'split': split, 'tree': tree,
                'feature_ranges': {key: {'min': min(row['features'][key] for row in training),
                                         'max': max(row['features'][key] for row in training)} for key in FEATURES},
                'metrics': {'scope': 'SIMULATED_HELD_OUT_ONLY', 'model': metrics(actual, predicted),
                            'majority_baseline': metrics(actual, [baseline] * len(test))},
                'heldout_errors': [{'sample_id': row['sample_id'], 'actual': row['label'], 'predicted': pred}
                                   for row, pred in zip(test, predicted) if pred != row['label']],
                'limitations': LIMITATIONS}
    artifact['artifact_sha256'] = digest(artifact)
    if Path(output_path).resolve() == Path(dataset_path).resolve():
        raise ValueError('model output must not replace the training dataset')
    write_json(output_path, artifact)
    return artifact


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, default=DATASET_PATH)
    parser.add_argument('--output', type=Path, default=ROOT / '.runtime' / 'ml' / 'inspection_tree.json')
    parser.add_argument('--generate-dataset', type=Path)
    args = parser.parse_args()
    try:
        if args.generate_dataset:
            write_json(args.generate_dataset, generate_dataset())
        report = train(args.dataset, args.output)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, 'Training failed: ' + str(error) + '\n')
    print(json.dumps({'output': str(args.output), 'model_version': report['model_version'],
                      'source_type': 'SIMULATED', 'metrics': report['metrics']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
