"""Small reviewed corpus: keyword retrieval and deterministic, checked citations.

No model or network access. Quotes refer to authored Chinese summaries, never to
the source's original wording. A match cannot establish a campus equipment fault.
"""
from datetime import date
import hashlib
import json
from pathlib import Path
import re


CORPUS_PATH = Path(__file__).resolve().parents[1] / 'config' / 'knowledge' / 'sources.json'
APPROVED_URLS = {
    'cisco-c9300-installation': 'https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/hardware/install/b_c9300_hig/Preparing-for-installation.html',
    'schneider-ups-wp210': 'https://ckm-content.se.com/ckmContent/sfc/servlet.shepherd/document/download/0698V00000YtXpGQAV',
}
ASSET_PATTERNS = {
    'cisco-c9300-installation': r'交换机|思科|(?<![a-z0-9])(?:cisco|catalyst|c9300)(?![a-z0-9])',
    'schneider-ups-wp210': r'不间断电源|(?<![a-z0-9])ups(?![a-z0-9])',
}
NO_SOURCE = '当前资料不足，无法根据已收录资料回答这个问题；请补充适用型号的可靠资料。'
# shortcut: bounded topic screening for four reviewed summaries, not open-domain
# entailment; expand reviewed topics and mismatch tests when adding more documents.
UNSUPPORTED = re.compile(
    r'ospf|vlan|snmp|认证|命令|固件|协议|配置|故障码|错误码|诊断|损坏|电路板|报警|告警|'
    r'华为|huawei|华三|h3c|锐捷|ruijie|戴尔|dell|'
    r'保证|安全|合格|阈值|清洁剂|溶剂|酒精|拆卸|拆开|更换|维修|修理|接线|'
    r'多久|多少|几度|几伏|几安|原因|正常吗|有故障|鼓包|漏液|(?<![a-z0-9])f\d+(?![a-z0-9])',
    re.I,
)


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate key')
        value[key] = item
    return value


def _load_corpus():
    corpus = json.loads(CORPUS_PATH.read_text(encoding='utf-8'), object_pairs_hook=_unique_object)
    sources = {}
    for source in corpus['sources']:
        source_id = source['source_id']
        if source_id in sources or source['url'] != APPROVED_URLS.get(source_id):
            raise ValueError('unreviewed source')
        if any(not isinstance(source.get(key), str) or not source[key].strip()
               for key in ('title', 'provider', 'section', 'reviewed_at', 'scope')):
            raise ValueError('missing source metadata')
        date.fromisoformat(source['reviewed_at'])
        sources[source_id] = source
    if set(sources) != set(APPROVED_URLS) or len(corpus['chunks']) < 4:
        raise ValueError('incomplete corpus')
    seen = set()
    for chunk in corpus['chunks']:
        chunk_id = chunk['chunk_id']
        if not isinstance(chunk_id, str) or not chunk_id or chunk_id in seen:
            raise ValueError('invalid chunk id')
        seen.add(chunk_id)
        if chunk['source_id'] not in sources:
            raise ValueError('orphan chunk')
        if not isinstance(chunk['text'], str) or not 4 <= len(chunk['text']) <= 160:
            raise ValueError('invalid summary length')
        if re.search(r'(?:[a-z][a-z0-9+.-]*://|www\.|javascript:|data:)', chunk['text'], re.I):
            raise ValueError('URL in summary')
        if not isinstance(chunk['section'], str) or not chunk['section'].strip():
            raise ValueError('missing locator')
        if (not isinstance(chunk['keywords'], list) or not chunk['keywords']
                or any(not isinstance(word, str) or len(word) < 2 for word in chunk['keywords'])):
            raise ValueError('invalid keywords')
    return sources, corpus['chunks']


def retrieve(query: str, *, force_no_source=False) -> dict:
    """Return selected sources/chunks, top_k IDs, summary context and exact citations.

    Both unsupported questions and an unreadable/invalid corpus are unavailable;
    neither path returns evidence or a speculative answer. The receipt binds the
    exact query and selected evidence, so callers can re-retrieve before use.
    """
    value = {
        'query': query, 'retrieval_id': None, 'sources': [], 'chunks': [], 'top_k': [],
        'context': '', 'answer': NO_SOURCE, 'citations': [], 'no_source': True,
    }
    result = {'status': 'unavailable', 'value': value, 'error': NO_SOURCE,
              'provider': 'local-reviewed-corpus'}
    if not isinstance(query, str) or not query.strip() or len(query) > 2000 or force_no_source:
        return result
    if UNSUPPORTED.search(query):
        return result
    normalized = query.lower()
    # Numeric/model-specific requests need their own reviewed manual; 9300 is
    # the only switch family reviewed here. Do not transfer its requirements.
    if any(number != '9300' for number in re.findall(r'\d+', normalized)):
        return result
    requested_sources = {source_id for source_id, pattern in ASSET_PATTERNS.items()
                         if re.search(pattern, normalized)}
    if not requested_sources:
        return result
    source_queries = {source_id: normalized for source_id in requested_sources}
    if len(requested_sources) > 1:
        mentions = sorted((match.start(), source_id) for source_id, pattern in ASSET_PATTERNS.items()
                          for match in re.finditer(pattern, normalized))
        source_queries = dict.fromkeys(requested_sources, '')
        for index, (start, source_id) in enumerate(mentions):
            end = mentions[index + 1][0] if index + 1 < len(mentions) else len(normalized)
            source_queries[source_id] += normalized[0 if index == 0 else start:end] + ' '
    try:
        sources, chunks = _load_corpus()
        ranked = []
        for chunk in chunks:
            if chunk['source_id'] not in requested_sources:
                continue
            matched = [word for word in chunk['keywords'] if word in source_queries[chunk['source_id']]]
            if matched:
                ranked.append((sum(len(word) for word in matched), chunk))
        selected = [chunk for _, chunk in sorted(ranked, key=lambda item: (-item[0], item[1]['chunk_id']))[:3]]
        if not selected or {chunk['source_id'] for chunk in selected} != requested_sources:
            return result
        public_chunks = [{key: chunk[key] for key in ('chunk_id', 'source_id', 'text', 'section')}
                         for chunk in selected]
        selected_sources = [sources[source_id] for source_id in dict.fromkeys(chunk['source_id'] for chunk in selected)]
        citations = []
        for chunk in public_chunks:
            source = sources[chunk['source_id']]
            quote = chunk['text']
            # Keep GreenMate's membership/exact-substring checks at the evidence boundary.
            if not 4 <= len(quote) <= 160 or quote not in chunk['text']:
                raise ValueError('invalid citation')
            citations.append({**{key: source[key] for key in ('source_id', 'url', 'title', 'provider', 'reviewed_at', 'scope')},
                              'chunk_id': chunk['chunk_id'], 'section': chunk['section'], 'quote': quote})
        receipt = json.dumps({'query': query, 'sources': selected_sources, 'chunks': public_chunks},
                             ensure_ascii=False, sort_keys=True)
        value.update(
            retrieval_id=hashlib.sha256(receipt.encode('utf-8')).hexdigest(),
            sources=selected_sources, chunks=public_chunks,
            top_k=[chunk['chunk_id'] for chunk in public_chunks],
            context='以下为已核对的自撰中文摘要，不是来源逐字原文；仅用于资料说明，不证明现场故障。\n' +
                    '\n'.join(f"[{chunk['chunk_id']}] {chunk['text']}" for chunk in public_chunks),
            answer='资料摘录式回答（自撰中文摘要，非来源逐字原文）：\n' +
                   '\n'.join(f"[{chunk['chunk_id']}] {chunk['text']}" for chunk in public_chunks),
            citations=citations, no_source=False,
        )
        result.update(status='ok', error=None)
    except (OSError, ValueError, TypeError, KeyError):
        result['error'] = '本地资料或引用元数据无法核验，当前不提供资料回答。'
    return result
