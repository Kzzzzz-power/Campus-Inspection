"""Stage06: serial evidence enrichment outside write transactions; immutable final run."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import logging
from pathlib import Path
from uuid import uuid4
from fastapi import HTTPException
from . import evidence as ev, service, runs
from .analysis_weather import fetch_weather as weather

STEPS=(('statistics','基础统计','SYSTEM'),('weather','外部天气','WEB_API'),('rag','巡检资料检索','RAG'),
       ('ml','重点关注模型','MODEL_OUTPUT'),('tools','只读工具调用','TOOL_OUTPUT'),('llm','AI 解释与建议','LLM_OUTPUT'))


def rag(question,**kwargs):
    from .analysis_rag import retrieve
    return retrieve(question,**kwargs)


def ml(run):
    from .analysis_ml import predict
    return predict(run)


def llm(run,steps,question):
    from .analysis_llm import explain
    return explain(run,steps,question)


def initialize(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS analysis_jobs (
      run_id TEXT PRIMARY KEY REFERENCES runs(run_id),request_id TEXT NOT NULL UNIQUE,
      options_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','completed','interrupted')),
      lease_until TEXT,worker_id TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)''')


def status(store,run_id):
    with store.transaction() as conn:row=conn.execute('SELECT * FROM analysis_jobs WHERE run_id=?',(run_id,)).fetchone()
    if not row:raise HTTPException(404,'增强分析运行不存在。')
    state=row['status']
    if state=='running' and row['lease_until'] and row['lease_until']<ev.now():state='interrupted'
    return {'run_id':run_id,'status':state,'error':row['error'],'updated_at':row['updated_at']}


def prepare(store,payload):
    if not isinstance(payload,dict) or set(payload)-{'request_id','source_run_id','question','failure_mode'}:
        raise HTTPException(422,'分析仅接受请求标识、来源运行、问题和教学失败模式。')
    key=service.request_key(payload.get('request_id'));source=service.request_key(payload.get('source_run_id'))
    question=service.text(payload.get('question'),'分析问题',1000)
    mode=payload.get('failure_mode','none')
    if mode not in ('none','weather','rag','ml','llm'):raise HTTPException(422,'失败模式无效。')
    options={'basis_run_id':source,'question':question,'failure_mode':mode}
    with store.transaction() as conn:
        old=runs.detail(conn,source)
        if old.get('legacy') or old.get('status')!='completed' or old.get('run_type')!='reality':
            raise HTTPException(422,'请先选择已完成的现实运行。')
        if mode!='none' and not old['input_snapshot']['round']['scenario_instance_id']:
            raise HTTPException(422,'失败注入仅允许在显式教学轮次内演练。')
        ids=set(old['source_watermark']['inspection_ids'])
        records=[dict(r) for r in conn.execute('SELECT * FROM inspection_records WHERE inspection_round_id=?',(old['inspection_round_id'],)) if r['inspection_id'] in ids]
    proof_ids=set(old['source_watermark']['evidence_ids'])
    frozen={'records':records,'proofs':[p for p in old['evidence'] if p['evidence_id'] in proof_ids],
            'reviews':old['input_snapshot']['review_snapshot']}
    inputs={k:old['input_snapshot'][k] for k in ('inspection_round_id','as_of','scenario_id','run_type','input_overrides')}
    result=runs.create(store,{**inputs,'request_id':key},frozen=frozen,analysis_context=options)
    return status(store,result['run_id'])


def tools(run,store,attempt):
    gaps={'point_ids':run['coverage']['missing'],'as_of':run['as_of'],'scope':'选定运行的当轮必检覆盖缺口，不是设施故障'}
    history=[{'evidence_id':e['evidence_id'],'point_id':e['checkpoint_id'],'observed_at':e['observed_at'],
              'source_type':e['source_type'],'value':e['value_json']} for e in run['evidence']
             if e.get('checkpoint_id') and e['status']=='ok' and isinstance(e['value_json'],dict)
             and (e['value_json'].get('condition') in ('WARNING','FAULT') or e['value_json'].get('result') in ('WARNING','FAULT')
                  or e['value_json'].get('conclusion')=='confirmed_abnormal')]
    candidates=run.get('plan_results',[])
    definitions={p['plan_id']:p for p in run['input_snapshot'].get('plan_definitions',[])}
    executable=[p for p in candidates if p['state']=='executable']
    # Durations are case estimates, not measured route optimization or a dispatch order.
    durations={p['plan_id']:p.get('estimated_minutes',p.get('duration_minutes')) for p in definitions.values()}
    ranked=sorted([p for p in executable if isinstance(durations.get(p['plan_id']),(int,float))],key=lambda p:durations[p['plan_id']])
    plan_value={'items':candidates,'fastest_executable_plan_ids':[p['plan_id'] for p in ranked if durations[p['plan_id']]==durations[ranked[0]['plan_id']]] if ranked else [],
                'scope':'仅比较当前证据下可执行候选方案的案例预计耗时；不是全局路线最优，不自动派单或完成任务。'}
    items=[]
    for name,value in [('coverage_gaps',gaps),('historical_anomalies',{'items':history,'scope':'选定运行可追溯的异常历史，不代表当前故障'}),('plan_feasibility',plan_value)]:
        items.append({'call_id':'call-'+uuid4().hex,'run_id':run['run_id'],'attempt_id':attempt,'name':name,
                      'arguments':{'run_id':run['run_id']},'result':value,'status':'ok','created_at':ev.now()})
    path=store.path.parent/'logs'/'tool_calls.jsonl';path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('a',encoding='utf-8') as out:
        for item in items:out.write(json.dumps(item,ensure_ascii=False)+'\n')
        out.flush()
    return {'status':'ok','provider':'B02-read-only-tools','value':{'items':items},'error':None}


def execute(store,run_id):
    worker=uuid4().hex
    with store.transaction(write=True) as conn:
        row=conn.execute('SELECT * FROM analysis_jobs WHERE run_id=?',(run_id,)).fetchone()
        if not row or row['status']=='completed':return
        if row['status']=='running' and row['lease_until'] and row['lease_until']>ev.now():return
        active=conn.execute("SELECT COUNT(*) FROM analysis_jobs WHERE run_id!=? AND (status='queued' OR (status='running' AND lease_until>?))",(run_id,ev.now())).fetchone()[0]
        if active>=2:
            conn.execute("UPDATE analysis_jobs SET status='interrupted',error=?,lease_until=NULL,updated_at=? WHERE run_id=?",('其他分析占用执行名额，请稍后恢复同一次分析。',ev.now(),run_id))
            return
        until=(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()
        conn.execute("UPDATE analysis_jobs SET status='running',lease_until=?,worker_id=?,error=NULL,updated_at=? WHERE run_id=?",(until,worker,ev.now(),run_id))
        run=runs.detail(conn,run_id);options=json.loads(row['options_json'])
    try:
        steps=[];mode=options['failure_mode']
        stats=deepcopy(run['statistics']);stats['limitations']=[s for s in stats['limitations'] if s!='当前仅提供基础统计，AI 增强尚未接入。']
        for name,label,source_type in STEPS:
            started=ev.now()
            try:
                if mode==name:
                    value={'status':'unavailable','provider':'teaching-failure-injection','value':None,'error':'本次独立教学运行显式注入失败；未修改真实服务配置。'}
                elif name=='statistics':value={'status':'ok','provider':'B02-shared-statistics','value':stats,'error':None,'observed_at':run['as_of']}
                elif name=='weather':value=weather()
                elif name=='rag':value=rag(options['question'])
                elif name=='ml':value=ml(run)
                elif name=='tools':value=tools(run,store,worker)|{'observed_at':run['as_of']}
                else:value=llm(run,steps,options['question'])
            except Exception:
                logging.getLogger(__name__).error('Analysis step %s failed for %s',name,run_id)
                value={'status':'error','provider':name,'value':None,'error':'本项增强执行失败，未生成替代值；其他任务判断保留。'}
            steps.append({**value,'name':name,'label':label,'source_type':source_type,'evidence_id':'E-'+uuid4().hex,
                          'observed_at':value.get('observed_at'),'retrieved_at':value.get('retrieved_at') or ev.now(),
                          'started_at':started,'completed_at':ev.now()})
        limitations=[s['label']+'：'+s['error'] for s in steps if s['status']!='ok']
        limitations += [x for x in stats.get('limitations',[]) if 'C03' in x]
        analysis={'basis_run_id':options['basis_run_id'],'question':options['question'],'status':'degraded' if limitations else 'complete',
                  'steps':steps,'answer':steps[-1]['value'],'limitations':limitations,
                  'scope':'依据原运行冻结事实重新计算；外部上下文取得时间单列。AI 解释不是任务判定或正式诊断。'}
        with store.transaction(write=True) as conn:
            owner=conn.execute('SELECT worker_id,status FROM analysis_jobs WHERE run_id=?',(run_id,)).fetchone()
            if owner['worker_id']!=worker or owner['status']!='running':return
            for step in steps:
                proof=ev.add(conn,'analysis_'+step['name'],step['source_type'],step['provider'],step['observed_at'] or step['started_at'],step['value'],
                    evidence_id=step['evidence_id'],status=step['status'],error=step['error'],retrieved_at=step['retrieved_at'],
                    inspection_round_id=run['inspection_round_id'],provenance={'run_id':run_id,'basis_run_id':options['basis_run_id'],
                    'failure_injected':mode==step['name'],'started_at':step['started_at'],'completed_at':step['completed_at'],
                    'observed_at_role':'source_observation_or_snapshot_cutoff' if step['observed_at'] else 'processing_attempt_not_field_observation'})
                conn.execute('INSERT INTO run_evidence VALUES (?,?)',(run_id,proof['evidence_id']));run['evidence'].append(proof)
            t5=next(t for t in run['task_results'] if t['task_id']=='T5')
            t5['limitations']=[s for s in t5.get('limitations',[]) if s!='当前仅提供基础统计，AI 增强尚未接入。']+limitations
            conn.execute('UPDATE task_results SET result_json=? WHERE run_id=? AND task_id=?',(service.json_text(t5),run_id,'T5'))
            run.update(analysis=analysis,statistics=stats,status='completed',run_status='completed',completed_at=ev.now())
            run['summary']+='；T5 增强'+('受限' if limitations else '完成')
            conn.execute('UPDATE runs SET status=?,completed_at=?,summary=?,result_json=? WHERE run_id=?',('completed',run['completed_at'],run['summary'],service.json_text(run),run_id))
            conn.execute("UPDATE analysis_jobs SET status='completed',lease_until=NULL,updated_at=? WHERE run_id=?",(ev.now(),run_id))
    except Exception:
        logging.getLogger(__name__).error('Analysis persistence interrupted for %s',run_id)
        with store.transaction(write=True) as conn:
            conn.execute("UPDATE analysis_jobs SET status='interrupted',error=?,lease_until=NULL,updated_at=? WHERE run_id=? AND worker_id=? AND status='running'",('分析保存未完成；可恢复同一次运行，不会重写已完成运行。',ev.now(),run_id,worker))
