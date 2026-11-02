import test from 'node:test';
import assert from 'node:assert/strict';
import {initTaskWorkbench} from '../frontend/task-workbench.js';

// Adapter based on the independent review's reproducible controller fixture.
function harness(){
  const ids=new Map();
  class E {
    constructor(tag,attrs={},children=[]){this.tag=tag;this.children=[];this.events={};this.dataset={};this.value='';Object.assign(this,attrs);this.append(...children);if(attrs.id)ids.set(attrs.id,this);}
    append(...children){for(const c of children){this.children.push(c);if(c instanceof E)c.parent=this;}if(this.tag==='select'&&!this.value)this.value=this.children[0]?.value||'';}
    replaceChildren(...children){this.children=[];this.append(...children);}
    addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
    async fire(name){for(const fn of this.events[name]||[])await fn({preventDefault(){}});}
    setAttribute(k,v){this[k]=v;}
    before(){}
    querySelector(){return null;}
  }
  const el=(tag,attrs={},...c)=>new E(tag,attrs,c),button=(text,fn,cls)=>{const b=el('button',{class:cls},text);b.addEventListener('click',fn);return b;};
  const rounds=['S5','S3'].map(id=>({round_id:id+'.demo',scenario_instance_id:'demo',date:'2026-11-01',window_end:'2026-11-01T09:45:00+08:00'}));
  globalThis.document={body:new E('body'),getElementById:id=>ids.get(id),querySelector:()=>new E('section')};
  globalThis.window={addEventListener(){}};
  globalThis.fetch=async()=>({ok:true,json:async()=>({total:rounds.length,items:rounds})});
  const controller=initTaskWorkbench({el,button,api:async()=>{},postJSON:async()=>{},showDialog(){},toast(){},onSelection(){},overlayChanged(){}});
  const change=async(id,value)=>{ids.get(id).value=value;await ids.get(id).fire('change');};
  return {controller,change,get:id=>ids.get(id)};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('S5 query draft survives a prepare-scenario mismatch, which blocks generation until reconciled',async()=>{
  const h=harness();await tick();
  await h.change('judgment-round','S5.demo');await h.change('judgment-current-status','true');
  await h.change('judgment-scenario','S3');
  assert.equal(h.get('judgment-current-status').parent.hidden,false);
  assert.equal(h.get('judgment-current-status').value,'true');
  assert.throws(()=>h.controller.request(),/待建立的 S3.*当前轮次仍为 S5/);
  await h.change('judgment-scenario','S5');
  assert.equal(h.controller.request().scenario_id,'S5');
  assert.equal(h.controller.request().input_overrides.current_status_available,true);
});
test('S5 prepare selection does not reveal an irrelevant query for S3; actual round changes reset it',async()=>{
  const h=harness();await tick();
  await h.change('judgment-round','S5.demo');await h.change('judgment-current-status','false');
  await h.change('judgment-round','S3.demo');await h.change('judgment-scenario','S5');
  assert.equal(h.get('judgment-current-status').parent.hidden,true);
  assert.equal(h.get('judgment-current-status').value,'');
  assert.throws(()=>h.controller.request(),/待建立的 S5.*当前轮次仍为 S3/);
  await h.change('judgment-scenario','S3');
  assert.equal(h.controller.request().scenario_id,'S3');
  assert(!Object.hasOwn(h.controller.request().input_overrides,'current_status_available'));
  await h.change('judgment-round','S5.demo');assert.equal(h.get('judgment-current-status').value,'');
  assert.equal(h.get('judgment-current-status').parent.hidden,false);
});
test('adopting a frozen run restores its boolean query override or original input',async()=>{
  const h=harness();await tick();
  for(const override of [true,false,undefined]){
    const run={run_id:'saved',run_type:'reality',status:'completed',scenario_id:'S5',inspection_round_id:'S5.demo',as_of:'2026-11-01T01:45:00Z',
      input_snapshot:{round:{scenario_instance_id:'demo'},input_overrides:override===undefined?{}:{current_status_available:override}},task_results:[],evidence:[],plan_results:[]};
    h.controller.accept(run);
    assert.equal(h.get('judgment-current-status').value,override===undefined?'':String(override));
    assert.equal(h.get('judgment-current-status').parent.hidden,false);
    const payload=h.controller.request();
    if(override===undefined)assert(!Object.hasOwn(payload.input_overrides,'current_status_available'));
    else assert.equal(payload.input_overrides.current_status_available,override);
  }
});
