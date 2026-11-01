"""Explicit isolated browser fixture. Never import from a production entry point."""
import sys
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import uvicorn
from backend import analysis
from backend.evidence import now
from backend.main import app


def weather_fixture():
    time.sleep(.4)
    return {'status':'ok','provider':'TEST_FIXTURE_NOT_REAL_WEATHER','value':{
        'location':{'name':'自动化测试地点'},'temperature_c':20,'relative_humidity_percent':50,
        'scope':'仅隔离测试数据，不代表真实天气'},'error':None,'observed_at':now(),'retrieved_at':now()}


def llm_fixture(run,steps,question):
    proof=next(s for s in steps if s['name']=='tools')
    return {'status':'ok','provider':'TEST_FIXTURE_NOT_REAL_LLM','value':{
        'model':'test-fixture','response_id':'test-'+run['run_id'],
        'claims':[{'kind':'fact','text':'自动化测试引用展示；非真实模型回答。','evidence_refs':[proof['evidence_id']]}]},'error':None}


analysis.weather=weather_fixture
analysis.llm=llm_fixture
if __name__=='__main__':uvicorn.run(app,host='127.0.0.1',port=int(sys.argv[1]))
