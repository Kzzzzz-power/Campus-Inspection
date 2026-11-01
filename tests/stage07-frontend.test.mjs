import test from 'node:test';
import assert from 'node:assert/strict';
import {eligibleParent,readAssumptions,assumptionLines,initWhatifWorkbench} from '../frontend/whatif-workbench.js';
import {planLabel} from '../frontend/planning-view.js';
import {adoptableReality} from '../frontend/task-workbench.js';

test('only completed S3 reality can parent a what-if; children cannot be adopted',()=>{
  const reality={scenario_id:'S3',status:'completed',run_type:'reality'};
  assert(eligibleParent(reality));assert(adoptableReality(reality));
  for(const change of [{scenario_id:'S5'},{status:'running'},{run_type:'what_if'}])assert(!eligibleParent({...reality,...change}));
  assert(!adoptableReality({...reality,run_type:'what_if'}));assert(!adoptableReality({...reality,status:'running'}));
});
test('assumptions retain inheritance and unknown distinctly, with readable labels',()=>{
  const value=readAssumptions('0',{P1:'',P2:'AVAILABLE',access_coordinator:'unknown'},'ALLOWED');
  assert.deepEqual(value,{remaining_minutes:0,resources:{P2:'AVAILABLE',access_coordinator:null},p2_z3_access:'ALLOWED'});
  assert.deepEqual(readAssumptions('',{P2:''},''),{});
  for(const invalid of ['-1','1441','NaN','Infinity'])assert.throws(()=>readAssumptions(invalid,{},''));
  assert.deepEqual(assumptionLines(value),['剩余时间：0 分钟','P2：可用','访问协调人员：未知','P2 的 Z3 权限：允许']);
});
test('all what-if plan states are hypothetical while reality labels remain',()=>{
  for(const [state,label] of [['executable','可执行'],['not_executable','不可执行'],['unknown','无法确认']]){
    assert.equal(planLabel({run_type:'what_if'},state),'推演条件下'+label);
    assert.equal(planLabel({run_type:'reality'},state),label);
  }
});

// Small DOM adapter exercises request/session behavior without a browser dependency.
class Element{
  constructor(tag,attrs={},children=[]){this.tag=tag;Object.assign(this,attrs);this.children=[];this.listeners={};this.value=attrs.value??'';this.append(...children);}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[];this.append(...children);}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
  async fire(name){for(const fn of this.listeners[name]||[])await fn({preventDefault(){}});}
  querySelectorAll(){return this.children.filter(c=>c instanceof Element).flatMap(c=>[...(['input','select','button'].includes(c.tag)?[c]:[]),...c.querySelectorAll()]);}
  setAttribute(key,value){this[key]=value;}
  reportValidity(){return true;}
  focus(){this.focused=true;}
  close(){this.open=false;void this.fire('close');}
  get textContent(){return this.text??this.children.map(c=>c.textContent??c).join('');}
  set textContent(value){this.text=value;}
}
function harness({api,postJSON,parent}={}){
  const byId=new Map(),dock=new Element('div'),body=new Element('body');
  const el=(tag,attrs={},...children)=>{const item=new Element(tag,attrs,children);if(attrs.id)byId.set(attrs.id,item);return item;};
  const button=(label,fn,classes)=>{const item=el('button',{class:classes},label);item.addEventListener('click',fn);return item;};
  globalThis.document={body,querySelector:()=>dock};
  const find=(node,id)=>node.id===id?node:node.children?.map(child=>find(child,id)).find(Boolean);
  const get=id=>byId.get(id)||find(body,id)||find(dock,id);
  let selected=parent??{run_id:'parent-1',scenario_id:'S3',run_type:'reality',status:'completed',as_of:'2026-11-01',evidence:[],task_results:[]};
  const controller=initWhatifWorkbench({el,button,api:api??(async()=>({presets:[{id:'A',label:'资源',assumptions:{resources:{P2:'AVAILABLE'},p2_z3_access:'ALLOWED'}}]})),postJSON,showDialog:d=>{d.open=true;},overlayChanged(){},getRun:()=>selected,openTasks(){}});
  return {get,controller,setSelected:value=>selected=value};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('network failure retains retry identity; editing requires explicit discard with uncertain outcome',async()=>{
  const calls=[],h=harness({postJSON:async(_,payload)=>{calls.push(structuredClone(payload));throw Error('network');}});
  h.controller.open();await tick();
  h.get('whatif-preset').value='A';await h.get('whatif-preset').fire('change');
  const form=h.get('whatif-submit');
  // The submit listener lives on its containing form.
  const dialog=h.get('whatif-dialog'),container=dialog.children[1],formNode=container.children.find(c=>c.tag==='form');
  await formNode.fire('submit');assert.match(h.get('whatif-status').textContent,/原样重试/);assert.equal(form.disabled,false);
  h.setSelected({run_id:'other'});await formNode.fire('submit');
  assert.equal(calls[0].request_id,calls[1].request_id);assert.equal(calls[1].parent_run_id,'parent-1');
  assert.equal(calls[1].assumptions.resources.P2,'AVAILABLE');
  assert(h.get('whatif-minutes').disabled);assert(h.get('whatif-preset').disabled);
  h.get('whatif-minutes').value='60';await h.get('whatif-minutes').fire('input');await formNode.fire('submit');
  assert.equal(calls[1].request_id,calls[2].request_id);assert.equal(calls[2].assumptions.remaining_minutes,undefined);
  let warning='';globalThis.confirm=text=>{warning=text;return false;};await h.get('whatif-restart').fire('click');
  assert.match(warning,/服务端可能已经保存/);await formNode.fire('submit');assert.equal(calls[3].request_id,calls[0].request_id);
  h.setSelected({run_id:'parent-2',scenario_id:'S3',run_type:'reality',status:'completed',evidence:[],task_results:[]});
  globalThis.confirm=()=>true;await h.get('whatif-restart').fire('click');await tick();
  h.get('whatif-minutes').value='60';await h.get('whatif-minutes').fire('input');await formNode.fire('submit');
  assert.notEqual(calls[0].request_id,calls[4].request_id);assert.equal(calls[4].parent_run_id,'parent-2');assert.equal(calls[4].assumptions.remaining_minutes,60);
});
test('late preset response cannot replace a newer invalid-parent session',async()=>{
  let complete;const h=harness({api:()=>new Promise(resolve=>complete=resolve)});
  h.controller.open();assert.equal(h.get('whatif-submit').disabled,true);
  h.get('whatif-dialog').close();h.setSelected(null);h.controller.open();
  complete({presets:[{id:'A',label:'late',assumptions:{remaining_minutes:60}}]});await tick();
  assert.equal(h.get('whatif-preset').children.length,0);assert.equal(h.get('whatif-submit').disabled,true);
  assert.match(h.get('whatif-context').textContent,/已完成的 S3/);
});

const formFor=h=>h.get('whatif-dialog').children[1].children.find(c=>c.tag==='form');
const child={run_id:'child-saved',run_type:'what_if',parent_run_id:'parent-1',assumptions:{remaining_minutes:60},evidence:[],task_results:[],plan_results:[]};
test('pending save survives close/reopen with original parent and disables repeat until late success',async()=>{
  let complete;const calls=[],h=harness({postJSON:async(_,payload)=>{calls.push(structuredClone(payload));return new Promise(resolve=>complete=resolve);}});
  h.controller.open();await tick();h.get('whatif-minutes').value='60';await h.get('whatif-minutes').fire('input');
  const saving=formFor(h).fire('submit');h.get('whatif-dialog').close();h.setSelected({run_id:'other'});h.controller.open();
  assert.match(h.get('whatif-context').textContent,/parent-1/);assert.equal(h.get('whatif-minutes').value,'60');
  assert(h.get('whatif-submit').disabled);assert(h.get('whatif-restart').disabled);assert.match(h.get('whatif-status').textContent,/等待原请求/);
  await formFor(h).fire('submit');assert.equal(calls.length,1);
  complete(child);await saving;
  assert.equal(h.get('whatif-run-id').textContent,'child-saved');assert.match(h.get('whatif-status').textContent,/已保存/);assert(!h.get('whatif-minutes').disabled);
});
test('late success while closed remains confirmed on reopen without another save or parent change',async()=>{
  let complete;let calls=0;const h=harness({postJSON:async()=>{calls++;return new Promise(resolve=>complete=resolve);}});
  h.controller.open();await tick();const saving=formFor(h).fire('submit');h.get('whatif-dialog').close();complete(child);await saving;
  h.setSelected(null);h.controller.open();
  assert.equal(calls,1);assert.equal(h.get('whatif-run-id').textContent,'child-saved');assert.match(h.get('whatif-context').textContent,/parent-1/);assert.match(h.get('whatif-status').textContent,/已保存/);
});
test('late failure while closed preserves draft and retries exact original request after reopen',async()=>{
  let fail;const calls=[],h=harness({postJSON:async(_,payload)=>{calls.push(structuredClone(payload));if(calls.length===1)return new Promise((resolve,reject)=>fail=reject);return child;}});
  h.controller.open();await tick();h.get('whatif-minutes').value='60';await h.get('whatif-minutes').fire('input');
  const saving=formFor(h).fire('submit');h.get('whatif-dialog').close();fail(Error('lost response'));await saving;
  h.setSelected({run_id:'other'});h.controller.open();
  assert.match(h.get('whatif-status').textContent,/结果未确认/);assert.equal(h.get('whatif-minutes').value,'60');assert(h.get('whatif-minutes').disabled);assert(!h.get('whatif-submit').disabled);
  await formFor(h).fire('submit');assert.deepEqual(calls[1],calls[0]);assert.equal(h.get('whatif-run-id').textContent,'child-saved');
});
test('preset read failures remain retryable and invalid assumptions do not create save requests',async()=>{
  let reads=0,saves=0;const h=harness({api:async()=>{if(++reads===1)throw Error('preset offline');return {presets:[{id:'B',label:'时间',assumptions:{remaining_minutes:60}}]};},postJSON:async()=>{saves++;return child;}});
  h.controller.open();await tick();assert(h.get('whatif-submit').disabled);assert.equal(h.get('whatif-retry').hidden,false);
  await h.get('whatif-retry').fire('click');assert(!h.get('whatif-submit').disabled);assert(h.get('whatif-retry').hidden);
  h.get('whatif-minutes').value='-1';await h.get('whatif-minutes').fire('input');await formFor(h).fire('submit');
  assert.equal(saves,0);assert.match(h.get('whatif-status').textContent,/0–1440/);
  h.get('whatif-minutes').value='60';await h.get('whatif-minutes').fire('input');await formFor(h).fire('submit');assert.equal(saves,1);
});
test('editing confirmed assumptions starts a new request while retaining the original parent',async()=>{
  const calls=[],h=harness({postJSON:async(_,payload)=>{calls.push(structuredClone(payload));return child;}});
  h.controller.open();await tick();await formFor(h).fire('submit');
  assert(!h.get('whatif-minutes').disabled);h.get('whatif-minutes').value='70';await h.get('whatif-minutes').fire('input');await formFor(h).fire('submit');
  assert.notEqual(calls[0].request_id,calls[1].request_id);assert.equal(calls[1].parent_run_id,'parent-1');assert.equal(calls[1].assumptions.remaining_minutes,70);
});
