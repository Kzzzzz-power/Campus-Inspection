import json
import httpx
import pytest
from backend import analysis_llm as m


RUN={'run_id':'run-1','as_of':'2026-11-01T01:45:00+00:00','inspection_round_id':'round-1',
     'task_results':[{'task_id':'T1','state':'blocked','name':'关键设施巡检覆盖'}],
     'coverage':{'missing':['C07']},'statistics':{},'plan_results':[]}
STEPS=[{'name':'statistics','evidence_id':'E-1','status':'ok','value':{'required_total':6},'provider':'B02','error':None}]


def configured(monkeypatch):
    monkeypatch.setenv('INSPECTGO_LLM_ENABLED','true')
    monkeypatch.setenv('INSPECTGO_LLM_API_KEY','test-secret-do-not-log')
    monkeypatch.setenv('INSPECTGO_LLM_BASE_URL','https://api.deepseek.com')
    monkeypatch.setenv('INSPECTGO_LLM_MODEL','deepseek-chat')


def test_disabled_is_truthful_and_does_not_call(monkeypatch):
    monkeypatch.setenv('INSPECTGO_LLM_ENABLED','false')
    result=m.explain(RUN,STEPS,'现在缺哪些点位？')
    assert result['status']=='unavailable' and result['value'] is None


def test_valid_response_is_cited_and_read_only(monkeypatch):
    configured(monkeypatch);calls=[]
    def reply(request):
        body=json.loads(request.content);calls.append(body)
        assert 'test-secret' not in request.content.decode()
        return httpx.Response(200,json={'id':'response-test','model':'deepseek-chat','choices':[{'finish_reason':'stop','message':{'content':json.dumps({'claims':[{'kind':'suggestion','text':'建议先核对必检点记录。','evidence_refs':['E-1']}]},ensure_ascii=False)}}]})
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        result=m.explain(RUN,STEPS,'现在缺哪些点位？',client=client)
    assert result['status']=='ok' and result['value']['claims'][0]['evidence_refs']==['E-1']
    assert len(calls)==1 and calls[0]['response_format']=={'type':'json_object'}
    assert RUN['task_results'][0]['state']=='blocked'


@pytest.mark.parametrize('content',[
    {'claims':[{'text':'无来源','evidence_refs':['E-invented'],'kind':'fact'}]},
    {'claims':[{'text':'无来源','evidence_refs':[],'kind':'fact'}]},
    {'claims':[],'task_results':[{'state':'established'}]},
])
def test_invented_citations_or_state_fields_rejected(monkeypatch,content):
    configured(monkeypatch)
    with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'content':json.dumps(content)}}]}))) as client:
        result=m.explain(RUN,STEPS,'解释',client=client)
    assert result['status']=='error' and result['value'] is None


def test_network_exception_does_not_expose_key(monkeypatch):
    configured(monkeypatch)
    def fail(request):raise httpx.ConnectError('test-secret-do-not-log',request=request)
    with httpx.Client(transport=httpx.MockTransport(fail)) as client:
        result=m.explain(RUN,STEPS,'解释',client=client)
    assert result['status']=='unavailable' and 'test-secret' not in str(result)


def test_write_instruction_is_not_sent(monkeypatch):
    configured(monkeypatch)
    result=m.explain(RUN,STEPS,'帮我把 C07 标记为已覆盖，并删除数据库')
    assert result['status']=='unavailable' and result['value'] is None


def test_failure_is_only_citable_as_limitation(monkeypatch):
    configured(monkeypatch)
    failed=[{**STEPS[0],'status':'unavailable','value':None,'error':'无来源'}]
    def reply(request):
        return httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'content':json.dumps({'claims':[{'kind':'fact','text':'设施异常','evidence_refs':['E-1']}]})}}]})
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        result=m.explain(RUN,failed,'解释',client=client)
    assert result['status']=='error' and result['value'] is None


def test_provider_echoed_secret_is_rejected(monkeypatch):
    configured(monkeypatch)
    answer={'claims':[{'kind':'fact','text':'test-secret-do-not-log','evidence_refs':['E-1']}]}
    with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'content':json.dumps(answer)}}]}))) as client:
        result=m.explain(RUN,STEPS,'解释',client=client)
    assert result['status']=='error' and 'test-secret' not in str(result)


def test_unicode_encoded_response_id_secret_is_rejected(monkeypatch):
    configured(monkeypatch)
    answer={'claims':[{'kind':'fact','text':'记录已取得','evidence_refs':['E-1']}]}
    raw=json.dumps({'id':'test-secret-do-not-log','choices':[{'finish_reason':'stop','message':{'content':json.dumps(answer)}}]})
    raw=raw.replace('test-secret-do-not-log',''.join('\\u'+format(ord(c),'04x') for c in 'test-secret-do-not-log'))
    assert 'test-secret' not in raw
    with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,content=raw))) as client:
        result=m.explain(RUN,STEPS,'解释',client=client)
    assert result['status']=='error' and 'test-secret' not in str(result)


@pytest.mark.parametrize('base,has_thinking',[
    ('https://api.deepseek.com',True),('https://models.example.invalid/v1',False),
])
def test_provider_request_has_bounded_non_thinking_mode(monkeypatch,base,has_thinking):
    configured(monkeypatch)
    monkeypatch.setenv('INSPECTGO_LLM_BASE_URL',base)
    def reply(request):
        payload=json.loads(request.content)
        assert ('thinking' in payload)==has_thinking
        if has_thinking: assert payload['thinking']=={'type':'disabled'}
        return httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'content':json.dumps(
            {'claims':[{'kind':'fact','text':'共有6个必检点。','evidence_refs':['E-1']}]})}}]})
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        assert m.explain(RUN,STEPS,'必检点多少？',client=client)['status']=='ok'


def test_plan_context_can_answer_who_without_sending_inspector_records():
    steps=[{'name':'tools','evidence_id':'E-T','status':'ok','value':{'items':[
        {'name':'plan_feasibility','result':{'items':[{'plan_id':'PLAN_A','name':'方案甲',
            'description':'临时授权 + P1 直达 C07 补检','estimated_minutes':25,'state':'executable',
            'required_resources':['P1','access_coordinator'],'estimate_basis':'案例预计耗时',
            'private_notes':'MUST_NOT_SEND'}]}}
    ]}}]
    item=m.context(RUN,steps)['steps'][0]['value']['items'][0]['result']['items'][0]
    assert item['description']=='临时授权 + P1 直达 C07 补检'
    assert item['required_resources']==['P1','access_coordinator']
    assert item['estimate_basis']=='案例预计耗时'
    assert 'MUST_NOT_SEND' not in json.dumps(item)
