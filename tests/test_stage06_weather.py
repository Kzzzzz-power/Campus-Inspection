from datetime import datetime, timezone
import importlib.util
import httpx
import pytest


def provider():
    assert importlib.util.find_spec('backend.analysis_weather'), '阶段06尚无独立天气证据适配器'
    from backend.analysis_weather import fetch_weather
    return fetch_weather


def test_weather_has_source_time_units_and_does_not_claim_campus_measurement():
    now=datetime.now(timezone.utc)
    payload={'latitude':31.23,'longitude':121.47,'current_units':{'time':'unixtime','temperature_2m':'°C','relative_humidity_2m':'%'},'current':{'time':int(now.timestamp()),'temperature_2m':21,'relative_humidity_2m':65}}
    client=httpx.Client(transport=httpx.MockTransport(lambda request:httpx.Response(200,json=payload)))
    result=provider()(client=client)
    assert result['status']=='ok'
    assert result['provider']=='Open-Meteo' and result['retrieved_at']
    assert result['value']['location']['role']=='demo_context'
    assert '非校园实测' in result['value']['scope']
    assert result['observed_at']!=result['retrieved_at']


@pytest.mark.parametrize('mutation',[{'temperature_2m':None},{'temperature_2m':float('inf')},{'relative_humidity_2m':101},{'time':0}])
def test_invalid_or_stale_weather_is_not_a_facility_fault(mutation):
    body={'latitude':31.23,'longitude':121.47,'current_units':{'time':'unixtime','temperature_2m':'°C','relative_humidity_2m':'%'},'current':{'time':int(datetime.now(timezone.utc).timestamp()),'temperature_2m':20,'relative_humidity_2m':50,**mutation}}
    import json
    client=httpx.Client(transport=httpx.MockTransport(lambda request:httpx.Response(200,content=json.dumps(body))))
    value=provider()(client=client)
    assert value['status']=='error' and value['value'] is None and value['error']
    assert 'FAULT' not in str(value)


def test_weather_network_failure_is_explicit():
    def offline(request):raise httpx.ConnectError('private network detail',request=request)
    value=provider()(client=httpx.Client(transport=httpx.MockTransport(offline)))
    assert value['status']=='unavailable' and value['value'] is None
    assert 'private network detail' not in str(value)
