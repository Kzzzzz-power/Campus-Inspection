"""InspectGo local workbench API: evidence storage, reviews and coverage snapshots.

This is not the full B-B02 task engine. Coverage and device condition stay separate.
"""
from contextlib import asynccontextmanager
import asyncio
import os
from pathlib import Path
import re
import sqlite3

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

if __package__:
    from . import service
    from .storage import Store
    from .configuration import FACILITIES
    from .baseline import load_s1
    from .realtime import FacilityFeed, MqttReceiver
else:
    import service
    from storage import Store
    from configuration import FACILITIES
    from baseline import load_s1
    from realtime import FacilityFeed, MqttReceiver

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
        maximum = 5*service.PHOTO_LIMIT+65536

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
    feed = FacilityFeed(enabled=realtime_enabled,
                        stale_after_seconds=float(os.environ.get('INSPECTGO_STALE_SECONDS', '10')))
    receiver = MqttReceiver(feed, os.environ.get('INSPECTGO_MQTT_HOST', '127.0.0.1'),
                            int(os.environ.get('INSPECTGO_MQTT_PORT', '1883'))) if realtime_enabled else None


    @asynccontextmanager
    async def lifespan(application):
        await run_in_threadpool(store.initialize,seed_demo)
        if receiver:
            receiver.start()
        try:
            yield
        finally:
            if receiver:
                await run_in_threadpool(receiver.stop)

    application = FastAPI(title='巡到位 InspectGo',version='0.2.0',lifespan=lifespan)
    application.state.store = store
    application.state.facilities = feed
    application.add_middleware(BodySizeLimit)

    @application.middleware('http')
    async def local_mutations(request, call_next):
        if request.method in ('POST','PUT','PATCH','DELETE'):
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
        if scenario_id != 'S1':
            raise HTTPException(404, '此场景输入尚未建立。')
        return s1_input

    @application.get('/api/zones')
    def zones():
        return {zid:{'name':zone['name'],'points':[{'id':pid,**service.POINTS[pid]} for pid in zone['points']]}
                for zid,zone in service.ZONES.items()}

    @application.get('/api/dashboard')
    def dashboard():
        with store.transaction() as conn:
            return service.dashboard(conn)

    @application.get('/api/coverage')
    def coverage():
        with store.transaction() as conn:
            return service.coverage(service.dashboard(conn))

    @application.get('/api/points/{point_id}')
    def point(point_id: str):
        with store.transaction() as conn:
            return service.point_detail(conn,point_id)

    @application.post('/api/inspections')
    async def inspection(request: Request):
        fields,photos = await inspection_form(request)
        return await run_in_threadpool(service.save_inspection,store,fields,photos)

    @application.post('/api/reviews')
    def review(payload: dict = Body(...)):
        return service.create_review(store,payload)

    @application.post('/api/reviews/{review_id}/evidence')
    async def review_evidence(review_id: str, request: Request):
        fields,photos = await inspection_form(request,review=True)
        return await run_in_threadpool(service.save_inspection,store,fields,photos,review_id)

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

    @application.post('/api/runs')
    def new_run(payload: dict | None = Body(default=None)):
        return service.create_run(store,payload)

    @application.get('/api/runs')
    def runs():
        with store.transaction() as conn:
            return [dict(row) for row in conn.execute('SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 20')]

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