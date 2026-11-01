"""Read-only inference from a fitted, JSON-serialized teaching decision tree.

Adapted from GreenMate's provenance/split/hash reporting pattern. No agricultural
features, business thresholds, pickle loading, or implicit training are reused.
"""
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATASET_PATH = ROOT / 'config' / 'ml' / 'inspection_history.json'
MODEL_PATH = ROOT / 'config' / 'ml' / 'inspection_tree.json'
FEATURES = ['coverage_rate', 'inspection_count', 'anomaly_count', 'pending_review_count']
CLASSES = ['ROUTINE', 'PRIORITY']
LIMITATIONS = [
    '训练数据为自建 SIMULATED 巡检历史教学样本，标签为 DERIVED_LABEL，不是真实巡检历史或人工验收结论。',
    '留出集指标仅描述该模拟分布；未验证真实校园泛化能力，不预测设施故障、专业风险或未来失效。',
    '输出仅供人工参考的复访工作优先级，不修改设施状态、覆盖事实、复核结论或 T1–T5 判定。',
    'score 是叶节点中 PRIORITY 训练样本比例，未经校准，不是故障概率或置信度保证。',
]


class MissingFeature(ValueError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def file_sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def extract_features(stats):
    if not isinstance(stats, dict):
        raise MissingFeature('statistics')
    missing = [key for key in FEATURES if stats.get(key) is None]
    if missing:
        raise MissingFeature(', '.join(missing))
    result = {key: stats[key] for key in FEATURES}
    for key, value in result.items():
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError('invalid feature: ' + key)
        if key == 'coverage_rate':
            if value > 1:
                raise ValueError('coverage_rate must be a ratio')
        elif type(value) is not int:
            raise ValueError('count must be an integer: ' + key)
    return result


def infer_tree(tree, features):
    node = tree
    path = []
    while 'feature' in node:
        feature, threshold = node['feature'], node['threshold']
        if feature not in FEATURES or type(threshold) not in (int, float) or not math.isfinite(threshold):
            raise ValueError('invalid tree split')
        left = features[feature] <= threshold
        path.append({'feature': feature, 'value': features[feature], 'threshold': threshold,
                     'operator': '<=' if left else '>'})
        if len(path) > 16:
            raise ValueError('tree depth exceeded')
        node = node['left'] if left else node['right']
    counts = node['counts']
    if (node['label'] not in CLASSES or set(counts) != set(CLASSES)
            or any(type(x) is not int or x < 0 for x in counts.values()) or sum(counts.values()) <= 0):
        raise ValueError('invalid tree leaf')
    return {'label': node['label'], 'score': counts['PRIORITY'] / sum(counts.values()),
            'score_label': 'uncalibrated_priority_leaf_fraction', 'decision_path': path,
            'leaf_training_samples': sum(counts.values()),
            'suggestion': '建议人工优先复访' if node['label'] == 'PRIORITY' else '建议按既定巡检流程安排复访'}


def predict(run, *, model_path=MODEL_PATH, dataset_path=DATASET_PATH):
    result = {'status': 'unavailable', 'provider': 'local-cart-teaching-model', 'value': None,
              'error': None, 'retrieved_at': datetime.now(timezone.utc).isoformat()}
    if isinstance(run, dict) and run.get('as_of'):
        result['observed_at'] = run['as_of']
    try:
        features = extract_features(run.get('statistics') if isinstance(run, dict) else None)
        artifact = json.loads(Path(model_path).read_text(encoding='utf-8'))
        checksum = artifact.pop('artifact_sha256')
        if checksum != digest(artifact):
            raise ValueError('model checksum mismatch')
        if (artifact['schema_version'] != 1 or artifact['feature_order'] != FEATURES
                or artifact['class_order'] != CLASSES or artifact['dataset']['source_type'] != 'SIMULATED'
                or artifact['dataset']['label_source'] != 'DERIVED_LABEL'
                or artifact['dataset']['sha256'] != file_sha256(dataset_path)):
            raise ValueError('model/dataset contract mismatch')
        prediction = infer_tree(artifact['tree'], features)
        outside = [key for key in FEATURES if not
                   artifact['feature_ranges'][key]['min'] <= features[key] <= artifact['feature_ranges'][key]['max']]
        limitations = list(LIMITATIONS)
        if outside:
            limitations.append('以下特征超出训练范围，模型建议外推受限：' + '、'.join(outside))
        result.update(status='ok', value={
            'source_type': 'MODEL_OUTPUT', 'model_id': artifact['model_id'],
            'model_version': artifact['model_version'], 'trained_at': artifact['trained_at'],
            'model_sha256': checksum, 'algorithm': artifact['algorithm'],
            'dataset': artifact['dataset'], 'feature_order': FEATURES, 'features': features,
            'input_basis': {'run_id': run.get('run_id'), 'as_of': run.get('as_of'),
                            'source': 'run.statistics (frozen basic_statistics)'},
            'prediction': prediction, 'metrics': artifact['metrics'], 'split': artifact['split'],
            'out_of_training_range': outside, 'limitations': limitations,
        })
    except MissingFeature as error:
        result['error'] = '模型输入缺少可追溯统计，不以 0 填补：' + str(error)
    except FileNotFoundError:
        result['error'] = '模型或训练数据缺失；请显式运行训练脚本，不生成替代预测。'
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        result.update(status='error', value=None, error='模型、数据摘要或输入特征校验失败，不采纳预测。')
    return result
