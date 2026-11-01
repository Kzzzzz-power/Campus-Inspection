"""Local Chinese transcription: volatile audio/text drafts, no business writes."""
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import threading
import wave
from fastapi import HTTPException

MAX_BYTES = 2_000_000
MAX_SECONDS = 60
MODEL_FILES = ('am/final.mdl', 'conf/model.conf', 'graph/HCLr.fst', 'graph/Gr.fst')
DEFAULT_MODEL = Path(__file__).resolve().parents[1] / '.runtime/models/vosk-model-small-cn-0.22'


def decode_wav(data):
    if len(data) > MAX_BYTES:
        raise HTTPException(413, '录音超过 2MB，请缩短后重录。')
    try:
        with wave.open(io.BytesIO(data), 'rb') as f:
            if (f.getnchannels(), f.getsampwidth(), f.getframerate(), f.getcomptype()) != (1, 2, 16000, 'NONE'):
                raise ValueError('format')
            frames=f.getnframes()
            if not 1600 <= frames <= MAX_SECONDS*16000:
                raise ValueError('duration')
            pcm=f.readframes(frames)
            if len(pcm)!=frames*2:
                raise ValueError('truncated')
            return pcm, frames/16000
    except (wave.Error, EOFError, ValueError):
        raise HTTPException(422, '录音无效；需要 0.1—60 秒、16kHz 单声道 PCM WAV，请重新录音。') from None


class LocalSpeech:
    def __init__(self, model_path=None):
        self.path=Path(model_path or os.environ.get('INSPECTGO_ASR_MODEL_PATH') or DEFAULT_MODEL)
        self.lock=threading.Lock()
        self.model=None

    def status(self):
        present=all((self.path/name).is_file() for name in MODEL_FILES)
        installed=importlib.util.find_spec('vosk') is not None
        available=present and installed
        return {'available':available, 'provider':'vosk-local', 'language':'zh-CN',
                'max_seconds':MAX_SECONDS, 'audio_persisted':False, 'draft_only':True,
                'message':'本地中文识别已配置，首次转写需加载模型。' if available else
                          '本地中文识别模型或依赖未安装，请运行 Setup-Speech.ps1；仍可手写现场说明。'}

    def transcribe(self, data):
        pcm, duration=decode_wav(data)
        if not all((self.path/name).is_file() for name in MODEL_FILES):
            raise HTTPException(503, '本地中文模型未安装，请运行 Setup-Speech.ps1。草稿未改变。')
        if not self.lock.acquire(blocking=False):
            raise HTTPException(429, '识别正在处理中，请稍后重试这段录音。', headers={'Retry-After':'3'})
        try:
            from vosk import Model, KaldiRecognizer, SetLogLevel
            SetLogLevel(-1)
            if self.model is None:
                # Explicit local path: never auto-download models on user requests.
                native_path=str(self.path.resolve())
                if os.name=='nt':
                    # libvosk uses narrow Windows paths; an ASCII relative path also works
                    # when the process working directory contains Chinese characters.
                    try:
                        relative=os.path.relpath(self.path.resolve(), Path.cwd())
                        if relative.isascii(): native_path=relative
                    except ValueError:
                        pass
                self.model=Model(native_path)
            rec=KaldiRecognizer(self.model,16000)
            parts=[]
            for offset in range(0,len(pcm),8000):
                if rec.AcceptWaveform(pcm[offset:offset+8000]):
                    parts.append(json.loads(rec.Result()).get('text',''))
            parts.append(json.loads(rec.FinalResult()).get('text',''))
            text=' '.join(p.strip() for p in parts if p.strip())
            text=re.sub(r'(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])','',text)
            return {'status':'ok' if text else 'no_speech','text':text,'provider':'vosk-local',
                    'duration_seconds':round(duration,2),'draft_only':True,
                    'message':'转写仅供人工核对。' if text else '未识别到清晰语音，请靠近麦克风重新录音。'}
        except Exception:
            # Do not expose audio, transcripts, model paths or native exceptions in logs/errors.
            raise HTTPException(503, '本地语音识别暂不可用，可重试这段录音或手写。') from None
        finally:
            self.lock.release()
