import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../frontend/evidence-browser.js',import.meta.url),'utf8');
const {initEvidenceBrowser,allRounds}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.value='';this.disabled=false;this.textContent='';}
 setAttribute(k,v){this[k]=v;}
 append(...items){this.children.push(...items);}
 prepend(...items){this.children.unshift(...items);}
 replaceChildren(...items){this.children=items;}
 after(){}
 addEventListener(){}
 focus(){}
}
test('round pagination includes records after the first 200',async()=>{
 const urls=[];
 globalThis.fetch=async url=>{urls.push(url);return {ok:true,json:async()=>({total:201,items:url.includes('offset=200')?[{round_id:'last'}]:Array.from({length:200},(_,i)=>({round_id:String(i)}))})};};
 const data=await allRounds();assert.equal(data.items.length,201);assert.equal(data.items[200].round_id,'last');assert.equal(urls.length,2);
});
test('successful save survives failed refresh and freezes editable draft while pending',async()=>{
 const elements=[],rail=new Element('aside');
 globalThis.document={createElement(tag){const e=new Element(tag);elements.push(e);return e;},querySelector(){return rail;},body:new Element('body')};
 let release;
 const pending=new Promise(resolve=>release=resolve);
 globalThis.fetch=async(url,options)=>{
  if(url==='/api/facilities')return {ok:true,json:async()=>[]};
  if(options?.method==='POST'){await pending;return {ok:true,json:async()=>({round_id:'saved'})};}
  return {ok:false,status:503,json:async()=>({detail:'locked'})};
 };
 initEvidenceBrowser();
 const find=id=>elements.find(e=>e.id===id),form=find('round-create-form'),rid=find('round-create-id'),day=find('round-create-date'),save=find('round-create-submit');
 rid.value='saved';day.value='2026-10-01';
 const result=form.onsubmit({preventDefault(){}});
 assert.equal(rid.disabled,true);assert.equal(day.disabled,true);assert.equal(save.disabled,true);
 release();await result;
 assert.equal(rid.disabled,false);assert.equal(day.disabled,false);assert.equal(save.disabled,false);
 const message=elements.find(e=>e.textContent.includes('轮次 saved 已保存。'));
 assert.ok(message);assert.match(message.textContent,/列表刷新失败/);assert.doesNotMatch(message.textContent,/创建失败/);
 assert.ok(find('round-refresh'));
});
