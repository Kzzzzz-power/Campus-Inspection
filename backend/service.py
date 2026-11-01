"""Inspection evidence, review transitions and immutable coverage snapshots."""
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import warnings
from uuid import uuid4

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

WINDOW_MINUTES = 45
if __package__:
    from .configuration import ZONES, POINTS
else:
    from configuration import ZONES, POINTS

PHOTO_LIMIT = 10 * 1024 * 1024
PHOTO_TYPES = {'JPEG':('image/jpeg','.jpg'), 'PNG':('image/png','.png'), 'WEBP':('image/webp','.webp')}


def utcnow():
    return datetime.now(timezone.utc)


def timestamp(value):
    """Old naive timestamps were written in the host's local time."""
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def text(value, name, maximum, required=True):
    if not isinstance(value, str):
        raise HTTPException(422, f'{name}格式无效。')
    value = value.strip()
    if len(value) > maximum or (required and not value):
        raise HTTPException(422, f'{name}为空或过长。')
    return value


def request_key(value):
    if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}',value):
        raise HTTPException(422, 'request_id 必须是 1–128 位字母、数字或 . _ : -。')
    return value


def require_point(point_id, code=422):
    if not isinstance(point_id,str) or point_id not in POINTS:
        raise HTTPException(code, '巡检点不存在。')
    return point_id


def inspection_fields(fields, review=False, canonical=False):
    allowed = {'point_id','inspector_id','inspected_at','result','notes','onsite_confirmed','request_id'}
    allowed.add('inspection_round_id')
    if canonical:
        allowed.update({'canonical_result','started_at','duration_seconds','supersedes_id','assumed_timezone'})
    if review:
        allowed |= {'conclusion','version'}
    if set(fields) - allowed:
        raise HTTPException(422, '包含不支持的表单字段。')
    point_id = require_point(fields.get('point_id'))
    inspector = text(fields.get('inspector_id'), '巡检人员', 80)
    raw_time = fields.get('inspected_at')
    try:
        observed = datetime.fromisoformat(raw_time.replace('Z','+00:00'))
        if observed.utcoffset() is None:
            raise ValueError()
        observed = observed.astimezone(timezone.utc)
        if observed > utcnow():
            raise ValueError()
    except (AttributeError, TypeError, ValueError, OverflowError):
        raise HTTPException(422, '巡检时间必须是带时区且不晚于当前时间的 ISO 时间。') from None
    result = fields.get('result')
    canonical_result = result if result in ('NORMAL','WARNING','FAULT') else None
    if canonical_result:
        result = {'NORMAL':'ok','WARNING':'alarm','FAULT':'alarm'}[canonical_result]
    if result not in ('ok','alarm','unknown') or fields.get('onsite_confirmed') != 'true':
        raise HTTPException(422, '请选择有效现场结果并明确确认已到现场。')
    value = {'point_id':point_id, 'inspector_id':inspector, 'inspected_at':observed.isoformat(),
             'result':result, 'notes':text(fields.get('notes',''),'现场说明',2000),
             'request_id':request_key(fields.get('request_id'))}
    if canonical_result:
        value['canonical_result'] = canonical_result
    if fields.get('inspection_round_id') is not None:
        value['inspection_round_id'] = request_key(fields['inspection_round_id'])
    if canonical:
        value.update({k:fields[k] for k in ('canonical_result','started_at','duration_seconds','supersedes_id','assumed_timezone')})
    if review:
        conclusion = fields.get('conclusion')
        if {'normal':'ok','fault':'alarm','unknown':'unknown'}.get(conclusion) != result:
            raise HTTPException(422, '复核结论与现场结果不一致。')
        version = fields.get('version')
        if not isinstance(version,str) or not re.fullmatch(r'[1-9][0-9]{0,8}',version):
            raise HTTPException(422, '复核版本无效。')
        value.update(conclusion=conclusion,version=int(version))
    return value


def validate_photo(filename, media_type, content):
    if len(content) > PHOTO_LIMIT:
        raise HTTPException(413, '每张照片不能超过 10 MB。')
    suffix = Path(filename or '').suffix.lower()
    if suffix not in ('.jpg','.jpeg','.png','.webp') or not content:
        raise HTTPException(422, '照片仅支持 JPG、PNG 或 WEBP。')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as picture:
                format = picture.format
                if format not in PHOTO_TYPES or picture.width * picture.height > 25_000_000:
                    raise ValueError()
                picture.verify()
            with Image.open(io.BytesIO(content)) as picture:
                picture.load()
        expected_type, extension = PHOTO_TYPES[format]
        if (suffix not in (('.jpg','.jpeg') if format=='JPEG' else (extension,))
                or media_type != expected_type):
            raise ValueError()
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(422, '照片内容、扩展名或媒体类型无效，或像素数超过 2500 万。') from None
    return {'content':content,'media_type':expected_type,'extension':extension,
            'sha256':hashlib.sha256(content).hexdigest()}


def json_text(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(json_text(value).encode('utf-8')).hexdigest()


def receipt(conn, key, action, digest):
    if key is None:
        return None
    row = conn.execute('SELECT * FROM request_receipts WHERE request_id=?',(key,)).fetchone()
    if row:
        if row['action'] != action or row['fingerprint'] != digest:
            raise HTTPException(409, '同一 request_id 已用于不同内容，请刷新后重新提交。')
        return json.loads(row['response_json'])
    return None


def save_receipt(conn, key, action, digest, response):
    if key is not None:
        conn.execute('INSERT INTO request_receipts VALUES (?,?,?,?)',(key,action,digest,json_text(response)))


def photo_metadata(row, inspected_at):
    return {'image_id':row['image_id'], 'url':'/api/evidence/images/'+row['image_id'],
            'record_id':row['record_id'],'point_id':row['point_id'],
            'inspected_at':inspected_at,'created_at':row['created_at']}


def point_projection(conn):
    """Current record/review presentation; coverage comes only from formal rounds."""
    at=utcnow()
    records=[dict(r) for r in conn.execute('SELECT * FROM records ORDER BY id DESC')]
    photos={r['point_id']:r['n'] for r in conn.execute('SELECT point_id,COUNT(*) n FROM photos GROUP BY point_id')}
    reviews={}
    for row in conn.execute("SELECT * FROM reviews ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, rowid DESC"):
        reviews.setdefault(row['point_id'],dict(row))
    result=[]
    for zone_id,zone in ZONES.items():
        for point_id in zone['points']:
            history=[(timestamp(r['inspected_at'] or r['created_at']),r) for r in records if r['point_id']==point_id]
            history=sorted(((t,r) for t,r in history if t and t<=at),key=lambda pair:(pair[0],pair[1]['id']),reverse=True)
            latest=history[0][1] if history else None
            onsite=[(t,r) for t,r in history if r['source']=='onsite']
            result.append({'point_id':point_id,**POINTS[point_id],'zone_id':zone_id,'zone_name':zone['name'],
                'building':zone['building'],'floor':zone['floor'],'covered':None,
                'latest_status':latest['status'] if latest else 'no-record',
                'evidence':latest['evidence'] if latest else None,'at':history[0][0].isoformat() if history else None,
                'record_id':latest['id'] if latest else None,'record_source':latest['source'] if latest else None,
                'review':reviews.get(point_id),'photo_count':photos.get(point_id,0),
                'last_inspection_at':onsite[0][0].isoformat() if onsite else None})
    return result


def dashboard(conn, **selection):
    if __package__:
        from .runs import dashboard as formal_dashboard
    else:
        from backend.runs import dashboard as formal_dashboard
    return formal_dashboard(conn,**selection)


def coverage(snapshot):
    return {**snapshot,'points':[p for p in snapshot['points'] if p['required']]}


def point_detail(conn, point_id):
    require_point(point_id,404)
    snapshot = dashboard(conn)
    rows = [dict(r) for r in conn.execute('SELECT * FROM records WHERE point_id=? ORDER BY id DESC',(point_id,))]
    photos = []
    for row in rows:
        row['is_legacy'] = bool(row['is_legacy'])
        row['photos'] = [photo_metadata(p,row['inspected_at'] or row['created_at'])
                         for p in conn.execute('SELECT * FROM photos WHERE record_id=? ORDER BY created_at,image_id',(row['id'],))]
        photos.extend(row['photos'])
    reviews = [dict(r) for r in conn.execute('''SELECT reviews.*, runs.inspection_round_id FROM reviews
        LEFT JOIN runs ON runs.run_id=reviews.trigger_run_id WHERE reviews.point_id=?
        ORDER BY reviews.created_at DESC, reviews.rowid DESC''',(point_id,))]
    return {'point':next(p for p in snapshot['points'] if p['point_id']==point_id),
            'records':rows,'photos':photos,'reviews':reviews}


def review_round(conn, review):
    """Resolve one review scope from its triggering run and immutable evidence."""
    scopes={r[0] for r in conn.execute('SELECT DISTINCT inspection_round_id FROM evidence WHERE review_id=? AND inspection_round_id IS NOT NULL',(review['review_id'],))}
    if review['trigger_run_id']:
        row=conn.execute('SELECT inspection_round_id FROM runs WHERE run_id=?',(review['trigger_run_id'],)).fetchone()
        if row:
            scopes.add(row[0])
    if len(scopes)>1:
        raise HTTPException(409,'该复核已有冲突的轮次关联，请核对原始证据。')
    return next(iter(scopes),None)


def create_review(store, payload):
    if set(payload)-{'point_id','reason','request_id','trigger_run_id'}:
        raise HTTPException(422,'包含不支持的复核字段。')
    value = {'point_id':require_point(payload.get('point_id')),
             'reason':text(payload.get('reason'),'复核原因',1000),
             'trigger_run_id':payload.get('trigger_run_id')}
    if value['trigger_run_id'] is not None:
        value['trigger_run_id'] = text(value['trigger_run_id'],'触发运行',128)
    key = request_key(payload.get('request_id'))
    digest = fingerprint(value)
    with store.transaction(write=True) as conn:
        prior = receipt(conn,key,'review',digest)
        if prior is not None:
            return prior
        if value['trigger_run_id'] and not conn.execute('SELECT 1 FROM run_references WHERE run_id=?',(value['trigger_run_id'],)).fetchone():
            raise HTTPException(404,'触发运行不存在。')
        from backend.reviews import pending_exists
        if pending_exists(conn,value['point_id']):
            raise HTTPException(409,'此点位已有待处理复核，请打开原请求继续补证。')
        now = utcnow().isoformat()
        review = {'review_id':'review-'+uuid4().hex,**value,'status':'pending','version':1,'conclusion':None,'created_at':now,'updated_at':now}
        conn.execute('''INSERT INTO reviews (review_id,point_id,reason,status,version,conclusion,created_at,updated_at,trigger_run_id)
            VALUES (:review_id,:point_id,:reason,:status,:version,:conclusion,:created_at,:updated_at,:trigger_run_id)''',review)
        response = {'review':review}
        save_receipt(conn,key,'review',digest,response)
    return response


def save_inspection(store, fields, photos, review_id=None, canonical=False):
    value = inspection_fields(fields,review=review_id is not None,canonical=canonical)
    if len(photos)>5:
        raise HTTPException(422,'每次最多提交 5 张照片。')
    key = value['request_id']
    action = 'inspection' if review_id is None else 'review-evidence:'+review_id
    digest = fingerprint({**value,'photos':[p['sha256'] for p in photos]})
    written = []
    try:
        with store.transaction(write=True) as conn:
            prior = receipt(conn,key,action,digest)
            if prior is not None:
                return prior
            review = None
            if review_id is not None:
                from backend import reviews as review_service
                row = conn.execute('SELECT * FROM reviews WHERE review_id=?',(review_id,)).fetchone()
                if row is None:
                    raise HTTPException(404,'复核请求不存在。')
                review = dict(row)
                bound_round=review_round(conn,review)
                supplied_round=value.get('inspection_round_id')
                if bound_round and supplied_round not in (None,bound_round):
                    raise HTTPException(422,'补证轮次与复核请求所属轮次不一致。')
                if bound_round:
                    value['inspection_round_id']=bound_round
                if review.get('task_id') and value['inspected_at'] < review['created_at']:
                    raise HTTPException(422,'补证现场时间不能早于复核请求。')
                if review.get('expires_at') and review['expires_at'] <= utcnow().isoformat():
                    raise HTTPException(409,'复核已到期，请先处理超时并重新发起。')
                if review['point_id'] != value['point_id']:
                    raise HTTPException(422,'现场记录的点位与复核请求不一致。')
                if review['version'] != value['version'] or review['status'] != 'pending':
                    raise HTTPException(409,'复核已被更新或完成，请刷新后核对最新版本。')
            now = utcnow().isoformat()
            cursor = conn.execute('''INSERT INTO records
                (point_id,status,source,evidence,created_at,inspector_id,inspected_at,is_legacy,review_id)
                VALUES (?,?,'onsite',?,?,?,?,0,?)''',
                (value['point_id'],value['result'],value['notes'],now,value['inspector_id'],value['inspected_at'],review_id))
            record_id = cursor.lastrowid
            saved_photos = []
            if photos:
                store.uploads.mkdir(parents=True,exist_ok=True)
            for photo in photos:
                image_id = uuid4().hex
                name = image_id+photo['extension']
                path = store.uploads/name
                stream = path.open('xb')
                written.append(path)
                with stream:
                    stream.write(photo['content'])
                    stream.flush()
                conn.execute('INSERT INTO photos VALUES (?,?,?,?,?,?,?)',
                    (image_id,record_id,value['point_id'],name,photo['media_type'],now,photo['sha256']))
                saved_photos.append({'image_id':image_id,'url':'/api/evidence/images/'+image_id,
                    'record_id':record_id,'point_id':value['point_id'],'inspected_at':value['inspected_at'],'created_at':now})
            response = {'record_id':record_id,'point_id':value['point_id'],'created_at':now,
                        'inspected_at':value['inspected_at'],'photo_count':len(saved_photos),'photos':saved_photos}
            if review is not None:
                review.update(status='pending' if value['conclusion']=='unknown' else 'completed',
                              conclusion=value['conclusion'],version=review['version']+1,updated_at=now)
                conn.execute('UPDATE reviews SET status=?,conclusion=?,version=?,updated_at=? WHERE review_id=?',
                    (review['status'],review['conclusion'],review['version'],now,review_id))
                response['review'] = review
            if __package__:
                from . import evidence
            else:
                import evidence
            response.update(evidence.save_inspection(conn,value,record_id,review_id,saved_photos))
            if review is not None and review.get('task_id'):
                from backend import reviews as review_service
                completed=now if review['status']=='completed' else None
                conn.execute('UPDATE reviews SET completed_at=? WHERE review_id=?',(completed,review_id))
                review['completed_at']=completed
                validity=(timestamp(value['inspected_at'])+timedelta(minutes=review_service.CONFIRMATION_MINUTES)).isoformat()
                proof=evidence.add(conn,'review_confirmation','ON_SITE',response['inspection_id'],value['inspected_at'],
                    {'conclusion':{'normal':'ruled_out','fault':'confirmed_abnormal','unknown':'unable_to_confirm'}[value['conclusion']],
                     'basis_evidence_ids':[response['evidence_id']],'validity_policy':'onsite-confirmation-60m-v1'},
                    review_id=review_id,inspection_round_id=value['inspection_round_id'],checkpoint_id=value['point_id'],
                    facility_id=review['facility_id'],zone_id=review['zone_id'],valid_until=validity,
                    provenance={'port':'/api/reviews/{review_id}/evidence','request_id':key,'inspector_id':value['inspector_id'],
                                'validity_policy':'onsite-confirmation-60m-v1','validity_minutes':review_service.CONFIRMATION_MINUTES})
                response['confirmation_evidence_id']=proof['evidence_id']
                review_service.schedule(conn,review)
            save_receipt(conn,key,action,digest,response)
        return response
    except BaseException:
        # Files only become readable through committed photo rows; failed writes remove their files.
        for path in written:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def create_run(store, payload):
    if __package__:
        from .runs import create
    else:
        from backend.runs import create
    return create(store,payload)


def run_detail(conn, run_id):
    if __package__:
        from .runs import detail
    else:
        from backend.runs import detail
    return detail(conn,run_id)
