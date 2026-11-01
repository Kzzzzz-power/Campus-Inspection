"""Evidence-chain tests: unsupported topics must not inherit an asset-name match."""
import importlib.util
import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest


ROOT = Path(__file__).resolve().parents[1]
CORPUS_PATH = ROOT / 'config' / 'knowledge' / 'sources.json'


def provider():
    assert importlib.util.find_spec('backend.analysis_rag'), '阶段06尚无可追溯的本地资料检索器'
    from backend.analysis_rag import retrieve
    return retrieve


@pytest.mark.parametrize(('query', 'source_id', 'expected'), [
    ('Catalyst 9300 安装位置对指示灯观察和布线有什么要求？', 'cisco-c9300-installation', '指示灯'),
    ('交换机巡检时，通风口和周边积尘需要关注什么？', 'cisco-c9300-installation', '通风'),
    ('UPS 已有自动监测，还需要人工检查吗？', 'schneider-ups-wp210', '自动监测'),
    ('UPS 维护记录应该记录哪些内容？', 'schneider-ups-wp210', '检查日期'),
    ('UPS 周围的灰尘和通风开口有什么要求？', 'schneider-ups-wp210', '通风开口'),
])
def test_relevant_questions_return_scoped_evidence(query, source_id, expected):
    result = provider()(query)
    assert result['status'] == 'ok' and result['error'] is None
    assert result['provider'] == 'local-reviewed-corpus'
    value = result['value']
    assert value['query'] == query and not value['no_source']
    assert expected in value['answer'] and '资料摘录式回答' in value['answer']
    assert {source['source_id'] for source in value['sources']} == {source_id}
    assert value['retrieval_id']


def test_every_answer_and_citation_comes_from_the_selected_reviewed_chunks():
    value = provider()('交换机通风与 UPS 维护记录有什么要求？')['value']
    corpus = json.loads(CORPUS_PATH.read_text(encoding='utf-8'))
    original = {chunk['chunk_id']: chunk for chunk in corpus['chunks']}
    sources = {source['source_id']: source for source in value['sources']}
    chunks = {chunk['chunk_id']: chunk for chunk in value['chunks']}
    assert len(sources) == 2 and 1 <= len(chunks) <= 3
    assert set(chunks) == {'c9300-airflow', 'ups-inspection-records'}
    assert value['top_k'] == [chunk['chunk_id'] for chunk in value['chunks']]
    assert len(value['citations']) == len(chunks)
    for citation in value['citations']:
        chunk = chunks[citation['chunk_id']]
        source = sources[chunk['source_id']]
        assert chunk['text'] == original[chunk['chunk_id']]['text']
        assert citation['source_id'] == chunk['source_id']
        assert 4 <= len(citation['quote']) <= 160
        assert citation['quote'] in chunk['text']
        assert citation['quote'] in value['answer']
        assert chunk['text'] in value['context'] and chunk['chunk_id'] in value['context']
        assert citation['url'] == source['url']
        assert citation['title'] == source['title']
        assert urlsplit(source['url']).hostname in {'www.cisco.com', 'ckm-content.se.com'}
        assert all(source[key] for key in ('provider', 'section', 'reviewed_at', 'scope'))
        assert '不证明现场故障' in source['scope']
    for chunk_id in original.keys() - chunks.keys():
        assert chunk_id not in value['context']
    assert '摘要' in value['context'] and '原文' in value['context']


@pytest.mark.parametrize('query', [
    '消防喷淋末端试水的合格压力是多少？',
    'Cisco Catalyst 9300 的 OSPF 邻居认证命令是什么？',
    'Cisco 交换机维护时如何配置 OSPF 认证？',
    'UPS 的 F02 故障具体是哪块电路板损坏？',
    'UPS 通风和 F02 故障诊断分别怎么做？',
    '这台 UPS 明天能保证机房供电 30 分钟吗？',
    'Dell 服务器的通风口要求是什么？',
    'Cisco 2960 交换机的通风要求是什么？',
    '华为交换机的通风要求是什么？',
    'UPS 电池报警应该怎么检查？',
    '交换机清洁时应该使用哪一种清洁剂？',
    '',
    '   ',
])
def test_unsupported_question_returns_no_answer_or_citations(query):
    result = provider()(query)
    assert result['status'] == 'unavailable' and result['error']
    value = result['value']
    assert value['no_source'] is True
    assert not value['sources'] and not value['chunks'] and not value['top_k']
    assert not value['citations'] and not value['context']
    assert '资料不足' in value['answer']


def test_forced_unavailable_cannot_leak_a_successful_answer():
    value = provider()('UPS 维护记录应该记录什么？', force_no_source=True)
    assert value['status'] == 'unavailable' and value['value']['no_source']
    assert value['value']['citations'] == [] and value['value']['chunks'] == []


def test_retrieval_receipt_binds_the_query_and_evidence():
    retrieve = provider()
    first = retrieve('UPS 维护记录应该记录什么？')['value']['retrieval_id']
    assert first == retrieve('UPS 维护记录应该记录什么？')['value']['retrieval_id']
    assert first != retrieve('UPS 通风有什么要求？')['value']['retrieval_id']


def test_changed_evidence_invalidates_the_previous_receipt(monkeypatch):
    retrieve = provider()
    query = 'UPS 维护记录应该记录什么？'
    first = retrieve(query)['value']['retrieval_id']
    corpus = json.loads(CORPUS_PATH.read_text(encoding='utf-8'))
    for chunk in corpus['chunks']:
        if chunk['chunk_id'] == 'ups-inspection-records':
            chunk['text'] = '单相 UPS 即使提供自动监测和通知，仍需安排检查。维护记录应包含检查日期。'
    monkeypatch.setattr(Path, 'read_text', lambda self, **kwargs: json.dumps(corpus, ensure_ascii=False))
    second = retrieve(query)
    assert second['status'] == 'ok'
    assert second['value']['retrieval_id'] != first


@pytest.mark.parametrize('corruption', ['external_url', 'orphan_chunk', 'duplicate_chunk', 'invalid_json'])
def test_invalid_corpus_is_unavailable_instead_of_inventing_provenance(monkeypatch, corruption):
    retrieve = provider()
    corpus = json.loads(CORPUS_PATH.read_text(encoding='utf-8'))
    if corruption == 'external_url':
        corpus['sources'][0]['url'] = 'https://example.org/pretend-cisco'
    elif corruption == 'orphan_chunk':
        corpus['chunks'][0]['source_id'] = 'unreviewed-source'
    elif corruption == 'duplicate_chunk':
        corpus['chunks'].append(dict(corpus['chunks'][0]))
    raw = '{' if corruption == 'invalid_json' else json.dumps(corpus, ensure_ascii=False)
    monkeypatch.setattr(Path, 'read_text', lambda self, **kwargs: raw)
    result = retrieve('交换机通风需要关注什么？')
    assert result['status'] == 'unavailable' and result['error']
    assert result['value']['no_source'] and not result['value']['citations']
    assert 'example.org' not in str(result)
