"""Isolated browser fixture; synthetic images and output, never a real VLM call."""
import os
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import uvicorn
from backend import photo_description
from backend.main import app

os.environ.update(INSPECTGO_VLM_ENABLED='true', INSPECTGO_VLM_BASE_URL='https://fixture.invalid/v1',
                  INSPECTGO_VLM_MODEL='TEST_FIXTURE_NOT_REAL_VLM', INSPECTGO_VLM_API_KEY='fixture-only')

def describe_fixture(store, photo, *, client=None):
    time.sleep(1.5)
    photo_description.encoded_photo(store, photo)
    return {'status':'ok', 'value':{'description':'TEST_FIXTURE：仅验证照片摘要显示与留存。<img src=x onerror=alert(1)>',
            'observations':['这是自动化生成的小幅纯色图片，不代表现场设备。'],
            'limitations':['非真实模型输出，不代表设施状态。']},
            'model':'TEST_FIXTURE_NOT_REAL_VLM', 'provider':'TEST_FIXTURE', 'error':None}

photo_description.describe = describe_fixture
if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[1]))
