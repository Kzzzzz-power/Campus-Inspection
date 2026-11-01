"""InspectGo local workbench API: evidence storage, reviews and coverage snapshots.

This is not the full B-B02 task engine. Coverage and device condition stay separate.
"""
from contextlib import asynccontextmanager
import asyncio
import logging
import os
from pathlib import Path
import re
import sqlite3

from fastapi import BackgroundTasks, Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

if __package__:
    from . import service, evidence, runs as formal_runs, scenario_input
    from .storage import Store
    from .configuration import FACILITIES
    from .baseline import load_s1
    from .realtime import FacilityFeed, MqttReceiver
else:
    import service
    import evidence
    from backend import runs as formal_runs, scenario_input
    from storage import Store
    from configuration import FACILITIES
    from baseline import load_s1
    from realtime import FacilityFeed, MqttReceiver

from backend import reviews as review_service
from backend import analysis
from backend.speech import LocalSpeech, MAX_BYTES as SPEECH_MAX_BYTES

FRONTEND = Path(__file__).resolve().parent.parent / 'frontend'


class BodySizeLimit:
    """Limit actual ASGI request bytes, including chunked multipart uploads."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] not in ('POST','PUT','PATCH','DELETE'):
            await self.app(scope,receive,send)
            return
        total = 0
        maximum = SPEECH_MAX_BYTES if scope['path'] == '/api/speech/transcribe' else 5*service.PHOTO_LIMIT+65536

        async def bounded_receive():
            nonlocal total
            message = await receive()
            if message['type'] == 'http.request':
                total += len(message.get('body',b''))
                if total > maximum:
                    # Starlette's parser closes partial spooled files as this exception unwinds.
                    raise HTTPException(413,'提交内容超过允许大小。')
            return message

        await self.app(scope,bounded_receive,send)

async def inspection_form(request, review=False):
    try:
        async with request.form(max_files=5,max_fields=15,max_part_size=8192) as form:
            fields, files = {}, []
            for name, value in form.multi_items():
                if isinstance(value,UploadFile):
                    if name not in ('photos','photos[]'):
                        raise HTTPException(422,'不支持的文件字段。')
                    files.append(value)
                else:
                    if name in fields:
                        raise HTTPException(422,'表单字段不能重复。')
                    fields[name] = value
            service.inspection_fields(fields,review=review)
            photos = []
            for file in files:
                content = await file.read(service.PHOTO_LIMIT+1)
                photos.append(await run_in_threadpool(service.validate_photo,file.filename,file.content_type,content))
            return fields,photos
    except StarletteHTTPException as error:
        if error.status_code == 400:
            raise HTTPException(422,'表单无效；每次最多 5 张照片。') from None
        raise


def create_app(db_path=None, uploads_dir=None, seed_demo=None, realtime_enabled=None):
    database = Path(db_path or os.environ.get('INSPECTGO_DB',str(Path(__file__).parent/'inspectgo.db')))
    uploads = Path(uploads_dir or os.environ.get('INSPECTGO_UPLOADS',str(Path(__file__).parent/'uploads')))
    if seed_demo is None:
        seed_demo = os.environ.get('INSPECTGO_SEED_DEMO','true').lower() != 'false'
    s1_input = load_s1()
    store = Store(database,uploads)
    if realtime_enabled is None:
        realtime_enabled = os.environ.get('INSPECTGO_MQTT_ENABLED', 'true').lower() == 'true'
    feed = FacilityFeed(enabled=realtime_enabled, store=store,
                        stale_after_seconds=float(os.environ.get('INSPECTGO_STALE_SECONDS', '10')))
    receiver = MqttReceiver(feed, os.environ.get('INSPECTGO_MQTT_HOST', '127.0.0.1'),
                            int(os.environ.get('INSPECTGO_MQTT_PORT', '1883'))) if realtime_enabled else None


    @asynccontextmanager
    async def lifespan(application):
        await run_in_threadpool(store.initialize,seed_demo)
        stop = asyncio.Event()
        async def review_lifecycle():
            while not stop.is_set():
                try:
                    maintenance=os.environ.get('INSPECTGO_MAINTENANCE_FILE')
                    if not maintenance or not Path(maintenance).exists():
                        await run_in_threadpool(review_service.maintain,store)
                except (sqlite3.Error,OSError,HTTPException):
                    logging.getLogger(__name__).exception('Review lifecycle maintenance failed; retry in 30 seconds')
                try:
                    await asyncio.wait_for(stop.wait(), timeout=30)
                except asyncio.TimeoutError:
                    pass
        review_worker=asyncio.create_task(review_lifecycle())
        if receiver:
            receiver.start()
        try:
            yield
        finally:
            stop.set()
            # Drain any in-flight threadpool transaction before releasing the app.
            await review_worker
            if receiver:
                await run_in_threadpool(receiver.stop)

    application = FastAPI(title='巡到位 InspectGo',version='0.2.0',lifespan=lifespan)
    application.state.store = store
    application.state.facilities = feed
    application.state.speech = LocalSpeech()
    application.add_middleware(BodySizeLimit)

    @application.middleware('http')
    async def local_mutations(request, call_next):
        if request.method in ('POST','PUT','PATCH','DELETE'):
            # Deployment-only write barrier; local development leaves this env unset.
            maintenance = os.environ.get("INSPECTGO_MAINTENANCE_FILE")
            if maintenance:
                try:
                    paused = Path(maintenance).exists()
                except OSError:
                    paused = True
                if paused:
                    return JSONResponse(
                        {"detail": "服务器正在更新，暂时无法保存。请保留输入，稍后重试。"},
                        status_code=503, headers={"Retry-After": "30", "Cache-Control": "no-store"})
            origin = request.headers.get('origin')
            expected = f'{request.url.scheme}://{request.url.netloc}'
            if origin and origin.rstrip('/') != expected:
                return JSONResponse({'detail':'此操作只允许从当前站点提交。'},status_code=403)
            length = request.headers.get('content-length')
            if length and length.isdigit() and int(length)>5*service.PHOTO_LIMIT+65536:
                return JSONResponse({'detail':'提交内容超过允许大小。'},status_code=413)
        response = await call_next(request)
        if request.url.path.startswith('/api/') and not request.url.path.startswith('/api/evidence/images/'):
            response.headers['Cache-Control'] = 'no-store'
        # Revalidate code/HTML together; keep model, texture and photo caching unchanged.
        path = request.url.path
        if path == '/' or (path.startswith('/static/') and Path(path).suffix.lower() in {'.html', '.js', '.mjs', '.css'}):
            response.headers['Cache-Control'] = 'no-cache, must-revalidate'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    async def storage_error(request,error):
        return JSONResponse({'detail':'数据或照片暂时无法保存/读取，本次操作未确认成功，请稍后重试。'},status_code=503)
    application.add_exception_handler(sqlite3.Error,storage_error)
    application.add_exception_handler(OSError,storage_error)

    @application.get('/health')
    def health():
        with store.transaction() as conn:
            conn.execute('SELECT 1 FROM records LIMIT 1').fetchone()
        return {'status':'ok','version':'0.2.0','mqtt':feed.snapshot()['broker']}

    @application.get('/api/speech/status')
    def speech_status():
        return application.state.speech.status()

    @application.post('/api/speech/transcribe')
    async def transcribe_speech(request: Request):
        if request.headers.get('content-type', '').split(';')[0].strip().lower() not in ('audio/wav', 'audio/x-wav'):
            raise HTTPException(415, '请发送 WAV 录音。')
        data=bytearray()
        async for chunk in request.stream():
            if len(data)+len(chunk)>SPEECH_MAX_BYTES:
                raise HTTPException(413, '录音超过 2MB，请缩短后重录。')
            data.extend(chunk)
        return await run_in_threadpool(application.state.speech.transcribe, bytes(data))

    @application.get('/api/current')
    def current_facilities():
        return feed.snapshot()

    @application.websocket('/ws/facilities')
    async def facility_stream(websocket: WebSocket):
        origin = websocket.headers.get('origin')
        scheme = 'https' if websocket.url.scheme == 'wss' else 'http'
        if origin and origin.rstrip('/') != f'{scheme}://{websocket.url.netloc}':
            await websocket.close(code=1008)
            return
        await websocket.accept()
        try:
            while True:
                # Per-client send deadline bounds slow consumers; MQTT writes never await sockets.
                await asyncio.wait_for(websocket.send_json(feed.snapshot()), timeout=3)
                try:
                    await asyncio.wait_for(websocket.receive_text(), timeout=1)
                except asyncio.TimeoutError:
                    pass
        except (WebSocketDisconnect, asyncio.TimeoutError):
            pass
        finally:
            try:
                await websocket.close()
            except (RuntimeError, OSError):
                pass

    @application.get('/api/facilities')
    def facilities():
        return FACILITIES

    @application.get('/api/scenarios/{scenario_id}')
    def scenario(scenario_id: str):
        if scenario_id=='S4':
            from backend.configuration import CONFIG,read_json
            return read_json(CONFIG/'scenarios'/'S4.json')
        return scenario_input.load_scenario(scenario_id)

    @application.post('/api/scenarios/S1/prepare')
    def prepare_s1(payload: dict = Body(...)):
        return scenario_input.prepare_s1(store,payload)

    @application.post('/api/scenarios/{scenario_id}/prepare')
    def prepare_scenario(scenario_id: str, payload: dict = Body(...)):
        return scenario_input.prepare_s1(store,payload,scenario_id)

    @application.post('/api/evidence/manual')
    def manual_evidence(payload: dict = Body(...)):
        return scenario_input.manual(store,payload)

    @application.get('/api/task-definitions')
    def task_definitions():
        # Definitions are navigation, not unobserved or fabricated task results.
        return {'rule_version': formal_runs.RULE_VERSION,
                'items': [{'task_id': key, 'name': name} for key, name in formal_runs.TASKS.items()]}

    @application.get('/api/tasks')
    def tasks(run_id: str):
        with store.transaction() as conn:
            result=formal_runs.detail(conn,run_id)
            return result.get('task_results',[])

    @application.get('/api/zones')
    def zones():
        return {zid:{'name':zone['name'],'points':[{'id':pid,**service.POINTS[pid]} for pid in zone['points']]}
                for zid,zone in service.ZONES.items()}

    @application.get('/api/dashboard')
    def dashboard(inspection_round_id: str | None = None, as_of: str | None = None, run_id: str | None = None):
        with store.transaction() as conn:
            return formal_runs.dashboard(conn,inspection_round_id,as_of,run_id)

    @application.get('/api/coverage')
    def coverage(inspection_round_id: str | None = None, as_of: str | None = None, run_id: str | None = None):
        with store.transaction() as conn:
            return formal_runs.dashboard(conn,inspection_round_id,as_of,run_id)

    @application.get('/api/points/{point_id}')
    def point(point_id: str):
        with store.transaction() as conn:
            return service.point_detail(conn,point_id)

    @application.post('/api/inspections')
    async def inspection(request: Request):
        if request.headers.get('content-type','').split(';')[0].strip() == 'application/json':
            try:
                payload = await request.json()
            except ValueError:
                raise HTTPException(422,'无效 JSON。') from None
            fields = evidence.canonical_fields(payload,request.headers.get('Idempotency-Key'))
            return await run_in_threadpool(service.save_inspection,store,fields,[],None,True)
        fields,photos = await inspection_form(request)
        return await run_in_threadpool(service.save_inspection,store,fields,photos)

    @application.post('/api/rounds')
    def new_round(payload: dict = Body(...)):
        return evidence.create_round(store,payload)

    @application.get('/api/rounds')
    def rounds(request: Request):
        return evidence.query(store,'inspection_rounds',request.query_params)

    @application.get('/api/history')
    def history(request: Request):
        return evidence.query(store,'facility_observations',request.query_params)

    @application.get('/api/inspections')
    def inspections(request: Request):
        return evidence.query(store,'inspection_records',request.query_params)

    @application.get('/api/evidence')
    def evidence_list(request: Request):
        return evidence.query(store,'evidence',request.query_params)

    @application.post('/api/evidence/storage-check')
    def storage_check():
        return evidence.storage_check(store)

    @application.post('/api/reviews')
    def review(payload: dict = Body(...)):
        review_service.expire(store)
        return review_service.create(store,payload)

    @application.get('/api/reviews')
    def review_list(status: str | None = None):
        return review_service.listing(store,status)

    @application.post('/api/reviews/expire')
    def expire_reviews():
        return review_service.expire(store)

    @application.get('/api/reviews/{review_id}')
    def review_detail(review_id: str):
        return review_service.detail(store,review_id)

    @application.post('/api/reviews/{review_id}/transition')
    def review_transition(review_id: str,payload: dict = Body(...)):
        return review_service.transition(store,review_id,payload)

    @application.post('/api/reviews/{review_id}/rerun')
    def review_rerun(review_id: str,payload: dict = Body(...)):
        if set(payload)!={'version'} or type(payload['version']) is not int:
            raise HTTPException(422,'需要复核版本。')
        return {'rerun':review_service.rerun(store,review_id,payload['version'])}

    @application.post('/api/reviews/{review_id}/evidence')
    async def review_evidence(review_id: str, request: Request):
        fields,photos = await inspection_form(request,review=True)
        response=await run_in_threadpool(service.save_inspection,store,fields,photos,review_id)
        return await run_in_threadpool(review_service.finish,store,response)

    @application.get('/api/evidence/images/{image_id}')
    def image(image_id: str):
        if not re.fullmatch('[a-f0-9]{32}',image_id):
            raise HTTPException(404,'照片不存在。')
        with store.transaction() as conn:
            row = conn.execute('SELECT * FROM photos WHERE image_id=?',(image_id,)).fetchone()
        if row is None or row['media_type'] not in {'image/jpeg','image/png','image/webp'}:
            raise HTTPException(404,'照片不存在。')
        path = (store.uploads/row['stored_name']).resolve()
        if not path.is_relative_to(store.uploads.resolve()) or not path.is_file():
            raise HTTPException(404,'照片文件不存在。')
        return FileResponse(path,media_type=row['media_type'],
            headers={'Cache-Control':'private, max-age=86400','Content-Security-Policy':"default-src 'none'"})

    @application.get('/api/photo-descriptions/config')
    def photo_description_config():
        from backend.photo_description import public_status
        return public_status()

    @application.get('/api/evidence/images/{image_id}/descriptions')
    def photo_descriptions(image_id: str):
        from backend import photo_description
        return photo_description.listing(store,image_id)

    @application.post('/api/evidence/images/{image_id}/descriptions',status_code=202)
    def start_photo_description(image_id: str,background_tasks: BackgroundTasks,payload: dict = Body(...)):
        from backend import photo_description
        job=photo_description.prepare(store,image_id,payload)
        if job['status'] in ('queued','interrupted'):
            background_tasks.add_task(photo_description.execute,store,job['description_id'])
        return job

    @application.get('/api/photo-descriptions/{description_id}')
    def photo_description_status(description_id: str):
        from backend import photo_description
        return photo_description.status(store,description_id)

    @application.post('/api/photo-descriptions/{description_id}/retry',status_code=202)
    def retry_photo_description(description_id: str,background_tasks: BackgroundTasks):
        from backend import photo_description
        job=photo_description.status(store,description_id)
        if job['status'] in ('queued','interrupted'):
            background_tasks.add_task(photo_description.execute,store,description_id)
        return job

    @application.get('/api/analyses/config')
    def analysis_config():
        from backend.analysis_llm import public_status
        return public_status()

    @application.post('/api/analyses',status_code=202)
    async def start_analysis(background_tasks: BackgroundTasks,payload: dict = Body(...)):
        job=await run_in_threadpool(analysis.prepare,store,payload)
        if job['status'] in ('queued','interrupted'):
            background_tasks.add_task(analysis.execute,store,job['run_id'])
        return job

    @application.get('/api/analyses/{run_id}')
    def analysis_status(run_id: str):
        return analysis.status(store,run_id)

    @application.post('/api/analyses/{run_id}/retry',status_code=202)
    def retry_analysis(run_id: str,background_tasks: BackgroundTasks):
        job=analysis.status(store,run_id)
        if job['status'] in ('queued','interrupted'):
            background_tasks.add_task(analysis.execute,store,run_id)
        return job

    @application.post('/api/runs')
    def new_run(payload: dict | None = Body(default=None)):
        if isinstance(payload,dict) and payload.get('run_type','reality')=='reality' and payload.get('scenario_id')!='S4':
            review_service.expire(store)
        return service.create_run(store,payload)

    @application.get('/api/runs')
    def runs():
        with store.transaction() as conn:
            return formal_runs.listing(conn)

    @application.get('/api/runs/{run_id}')
    def run(run_id: str):
        with store.transaction() as conn:
            return service.run_detail(conn,run_id)

    application.mount('/static',StaticFiles(directory=FRONTEND),name='static')

    @application.get('/')
    def index():
        return FileResponse(FRONTEND/'index.html')

    return application


app = create_app()
