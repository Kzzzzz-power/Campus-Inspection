"""Open-Meteo context. Adapts GreenMate's source/time/unit validation, not its domain."""
from datetime import datetime, timezone
import math
import os
import httpx

ENDPOINT = 'https://api.open-meteo.com/v1/forecast'
LOCATION = {'name':'上海（演示城市）','latitude':31.23,'longitude':121.47,'role':'demo_context'}


def fetch_weather(*, client=None):
    owned = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(12,connect=5),follow_redirects=False,
                                   trust_env=os.getenv('INSPECTGO_HTTP_TRUST_ENV','false').lower()=='true')
    result = {'provider':'Open-Meteo','source_url':ENDPOINT,'status':'unavailable','value':None,
              'error':None,'observed_at':None,'retrieved_at':None}
    try:
        with client.stream('GET',ENDPOINT,params={
            'latitude':LOCATION['latitude'],'longitude':LOCATION['longitude'],
            'current':'temperature_2m,relative_humidity_2m','timeformat':'unixtime','timezone':'UTC'
        }) as response:
            result['retrieved_at']=datetime.now(timezone.utc).isoformat()
            if response.status_code!=200:
                result['error']=f'天气 API 返回 HTTP {response.status_code}，不据此判断设施状态。'
                return result
            content=bytearray()
            for block in response.iter_bytes():
                content.extend(block)
                if len(content)>65536:raise ValueError('response size')
        import json
        data=json.loads(content);units=data['current_units'];current=data['current']
        if units.get('time')!='unixtime' or units.get('temperature_2m')!='°C' or units.get('relative_humidity_2m')!='%':
            raise ValueError('units')
        for field,low,high in [('temperature_2m',-90,65),('relative_humidity_2m',0,100)]:
            v=current[field]
            if type(v) not in (int,float) or not math.isfinite(v) or not low<=v<=high:raise ValueError('measurement')
        for field in ('latitude','longitude'):
            if type(data[field]) not in (int,float) or not math.isfinite(data[field]) or abs(data[field]-LOCATION[field])>1:raise ValueError('grid')
        observed=datetime.fromtimestamp(current['time'],timezone.utc)
        age=(datetime.now(timezone.utc)-observed).total_seconds()
        if not -900<=age<=7200:raise ValueError('stale weather')
        result.update(status='ok',observed_at=observed.isoformat(),value={
            'location':LOCATION,'temperature_c':current['temperature_2m'],'relative_humidity_percent':current['relative_humidity_2m'],
            'scope':'当前室外格点天气，非校园实测、非巡检时刻历史天气；不能用于确认设备故障。',
            'units':{'temperature_c':'°C','relative_humidity_percent':'%'},'grid':{k:data[k] for k in ('latitude','longitude')}})
    except httpx.HTTPError:
        result['error']='天气 API 连接失败或超时，相关环境解释受限。'
    except (ValueError,TypeError,KeyError,OverflowError,OSError):
        result.update(status='error',error='天气响应格式、单位、地点或时效无法核验，不采纳。')
    finally:
        result['retrieved_at']=result['retrieved_at'] or datetime.now(timezone.utc).isoformat()
        if owned:client.close()
    return result
