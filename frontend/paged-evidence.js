// Keep frozen arrays intact; construct only the currently visible page of nodes.
export function pagedItems(items,renderItem,{el,button,label='判断证据',pageSize=30,itemClass='',emptyText='没有关联证据。'}){
  const size=Math.max(1,Math.min(100,Math.trunc(pageSize)||30));
  const pages=Math.max(1,Math.ceil(items.length/size));
  const root=el('section',{class:'evidence-pagination','aria-label':label,'data-evidence-total':items.length});
  const list=el('div',{class:('evidence-page-items '+itemClass).trim()});
  if(!items.length){list.append(el('p',{class:'field-hint'},emptyText));root.append(list);return root;}
  let page=0;
  const status=el('p',{class:'field-hint',role:'status','aria-live':'polite','aria-atomic':'true','data-page-status':''});
  const controls=el('div',{class:'evidence-page-controls',role:'group','aria-label':label+'分页'});
  const previous=button('上一页',()=>go(page-1),'btn btn-ghost btn-small');previous.dataset.pageAction='previous';
  const next=button('下一页',()=>go(page+1),'btn btn-ghost btn-small');next.dataset.pageAction='next';
  const number=el('input',{type:'number',min:1,max:pages,step:1,value:1,required:true,'aria-label':label+'页码','data-page-number':''});
  function jump(){if(number.reportValidity())go(Number(number.value)-1);}
  const jumpButton=button('跳转',jump,'btn btn-ghost btn-small');jumpButton.dataset.pageAction='jump';
  number.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();jump();}});
  controls.append(previous,next,el('label',{},'页码',number),jumpButton);
  function go(value){
    if(!Number.isInteger(value))return;
    page=Math.max(0,Math.min(pages-1,value));
    const start=page*size,end=Math.min(start+size,items.length);
    list.replaceChildren();
    for(let i=start;i<end;i++)list.append(renderItem(items[i],i));
    number.value=String(page+1);previous.disabled=page===0;next.disabled=page===pages-1;
    status.textContent=`${label}：${start+1}–${end} / 共 ${items.length} 条 · 第 ${page+1} / ${pages} 页`;
    // Do not strand keyboard focus on a newly disabled first/last-page control.
    if((previous.disabled&&document.activeElement===previous)||(next.disabled&&document.activeElement===next))number.focus({preventScroll:true});
  }
  if(items.length>size)root.append(status,controls);
  root.append(list);go(0);return root;
}

export function evidenceLinks(run,refs,{el,button,proof}){
  return pagedItems(refs||[],id=>button(id,()=>proof(run,id),'btn btn-ghost btn-small'),
    {el,button,label:'引用证据',itemClass:'evidence-links'});
}
