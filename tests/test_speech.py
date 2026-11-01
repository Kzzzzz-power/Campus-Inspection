"""Speech drafts never create inspection evidence. All providers/data here are test-only."""
import io
import json
import sys
import types
import wave

import pytest
from fastapi.testclient import TestClient
from backend.main import create_app


def wav(seconds=.4, rate=16000, channels=1):
    stream=io.BytesIO()
    with wave.open(stream, 'wb') as f:
        f.setnchannels(channels); f.setsampwidth(2); f.setframerate(rate)
        f.writeframes(b'\0\0' * int(seconds*rate)*channels)
    return stream.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('INSPECTGO_ASR_MODEL_PATH', str(tmp_path/'absent-model'))
    app=create_app(tmp_path/'test.db',tmp_path/'uploads',False,False)
    with TestClient(app) as c:
        yield c


def test_unconfigured_voice_is_explicit_and_does_not_break_workbench(client):
    r=client.get('/api/speech/status')
    assert r.status_code==200
    assert r.json()['available'] is False
    assert '未安装' in r.json()['message']
    assert client.get('/health').status_code==200
    assert client.post('/api/speech/transcribe',content=wav(),headers={'Content-Type':'audio/wav'}).status_code==503


@pytest.mark.parametrize('data,mime,expected',[
    (b'not audio','audio/wav',422), (wav(),'audio/webm',415),
    (wav(rate=8000),'audio/wav',422), (wav(channels=2),'audio/wav',422),
    (wav(seconds=61),'audio/wav',422), (wav()[:-100],'audio/wav',422),
    (b'x'*2000001,'audio/wav',413), (wav(seconds=0),'audio/wav',422),
], ids=['invalid','mime','rate','stereo','duration','truncated','oversize','empty'])
def test_audio_validated_before_recognizer(client,data,mime,expected):
    assert client.post('/api/speech/transcribe',content=data,headers={'Content-Type':mime}).status_code==expected


def test_stream_size_and_cross_origin(client):
    response=client.post('/api/speech/transcribe',content=iter([b'x'*1000000]*3),headers={'Content-Type':'audio/wav'})
    assert response.status_code==413
    assert client.post('/api/speech/transcribe',content=wav(),headers={'Content-Type':'audio/wav','Origin':'https://other.invalid'}).status_code==403


def test_real_provider_adapter_merges_segments_without_business_writes(client,tmp_path,monkeypatch):
    from backend import speech
    model=tmp_path/'model'
    for name in speech.MODEL_FILES:
        p=model/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'test-only')
    calls=[]
    class Recognizer:
        def __init__(self,model,rate): calls.append(rate)
        def AcceptWaveform(self,data): return True
        def Result(self): return json.dumps({'text':'照明 正常'})
        def FinalResult(self): return json.dumps({'text':'需要 人工 核对'})
    monkeypatch.setitem(sys.modules,'vosk',types.SimpleNamespace(Model=lambda p: (calls.append('load'),object())[1], KaldiRecognizer=Recognizer,SetLogLevel=lambda _:None))
    client.app.state.speech=speech.LocalSpeech(model)
    with client.app.state.store.transaction() as db:
        before={t:db.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ['inspection_records','evidence','runs','review_requests']}
    data=client.post('/api/speech/transcribe',content=wav(),headers={'Content-Type':'audio/wav'}).json()
    assert data['status']=='ok' and '照明正常' in data['text'] and '需要人工核对' in data['text']
    assert data['provider']=='vosk-local' and data['draft_only'] is True
    client.post('/api/speech/transcribe',content=wav(),headers={'Content-Type':'audio/wav'})
    assert calls.count('load')==1
    with client.app.state.store.transaction() as db:
        assert before=={t:db.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in before}
    assert not list((tmp_path/'uploads').rglob('*.wav'))
    client.app.state.speech.lock.acquire()
    try:
        assert client.post('/api/speech/transcribe',content=wav(),headers={'Content-Type':'audio/wav'}).status_code==429
    finally: client.app.state.speech.lock.release()
    monkeypatch.setattr(Recognizer,'Result',lambda self:'{"text":""}')
    monkeypatch.setattr(Recognizer,'FinalResult',lambda self:'{"text":""}')
    data=client.post('/api/speech/transcribe',content=wav(),headers={'Content-Type':'audio/wav'}).json()
    assert data['status']=='no_speech' and data['text']==''
    monkeypatch.setattr(Recognizer,'AcceptWaveform',lambda *_: (_ for _ in ()).throw(RuntimeError('private model path')))
    response=client.post('/api/speech/transcribe',content=wav(),headers={'Content-Type':'audio/wav'})
    assert response.status_code==503 and 'private model path' not in response.text
    assert not client.app.state.speech.lock.locked()
