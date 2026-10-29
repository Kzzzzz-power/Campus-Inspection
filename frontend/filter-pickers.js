// Progressive enhancement: native selects remain the value and change-event source.
export function createFilterPickers({getPoints}) {
  const events = new AbortController();
  const pickers = new Map();
  let active = null, disposed = false;
  const configs = [
    ['mobile-scope', '选择巡检空间', true],
    ['required-filter', '点位类型', false],
    ['status-filter', '业务状态', false],
  ];
  const on = (target, type, listener, options={}) => target?.addEventListener(type, listener, {...options, signal:events.signal});
  const node = (tag, className, text) => { const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item; };
  const icon = (path,className='icon') => {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    for(const [key,value] of Object.entries({viewBox:'0 0 24 24',class:className,fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
    const line=document.createElementNS(svg.namespaceURI,'path');line.setAttribute('d',path);svg.append(line);return svg;
  };
  const building = () => icon('M4 21V3h10v18m0-12h6v12M8 7h2M8 11h2M8 15h2M8 19h2M17 13h1M17 17h1');
  const notify = open => document.dispatchEvent(new CustomEvent('inspectgo:picker',{detail:{open}}));
  function close(returnFocus=false) {
    if(!active)return;
    const {popup,trigger}=active;active=null;popup.remove();trigger.setAttribute('aria-expanded','false');notify(false);
    if(returnFocus&&trigger.isConnected)trigger.focus({preventScroll:true});
  }
  function sync() {
    for(const {select,trigger,label,value} of pickers.values()) {
      value.textContent=select.selectedOptions[0]?.textContent||label;
      trigger.disabled=select.disabled;
      trigger.setAttribute('aria-label',`${label}：${value.textContent}`);
    }
  }
  function position() {
    if(!active)return;
    const {popup,trigger,spatial}=active,view=window.visualViewport;
    const width=view?.width||innerWidth,height=view?.height||innerHeight,left=view?.offsetLeft||0,top=view?.offsetTop||0;
    popup.style.width=`${Math.min(spatial?(width<580?width-32:326):240,width-32)}px`;
    popup.style.maxHeight=`${Math.max(120,height-32)}px`;
    const rect=trigger.getBoundingClientRect();
    popup.style.left=`${Math.max(left+16,Math.min(rect.left,left+width-popup.offsetWidth-16))}px`;
    popup.style.top=`${Math.max(top+16,Math.min(rect.bottom+9,top+height-popup.offsetHeight-16))}px`;
  }
  function open(picker,keyboard=false) {
    if(picker.trigger.disabled)return;
    if(active?.trigger===picker.trigger){close(true);return;}
    close();
    const {select,trigger,label,spatial}=picker;
    const popup=node('div','picker-popup');popup.id=select.id+'-popup';popup.setAttribute('role','dialog');popup.setAttribute('aria-labelledby',select.id+'-heading');
    const heading=node('h3','',label);heading.id=select.id+'-heading';popup.append(heading);
    const points=getPoints()||[];
    let search=null;
    if(spatial){
      popup.append(node('p','picker-subtitle',`${new Set(points.map(p=>p.building)).size} 栋 · ${new Set(points.map(p=>p.zone_id)).size} 个楼层 · ${points.length} 个点位`));
      search=node('input','picker-search');search.type='search';search.placeholder='搜索楼栋或楼层';search.setAttribute('aria-label','搜索楼栋或楼层');search.autocomplete='off';popup.append(search);
    }
    const list=node('div','picker-options');list.setAttribute('role','listbox');list.setAttribute('aria-label',label);popup.append(list);
    const empty=node('p','picker-empty','没有匹配的楼栋或楼层，请尝试其他关键词。');empty.hidden=true;popup.append(empty);
    const announcement=node('span','sr-only');announcement.setAttribute('role','status');popup.append(announcement);
    if(spatial)popup.append(node('p','picker-footer','选择空间仅筛选清单，全范围覆盖统计保持不变。'));
    const dismiss=node('button','picker-dismiss');dismiss.type='button';dismiss.setAttribute('aria-label','关闭'+label);dismiss.append(icon('m6 6 12 12M18 6 6 18'));dismiss.addEventListener('click',()=>close(true));popup.append(dismiss);
    const choose=value=>{
      // Commit through the existing application handler; do not maintain a second filter state.
      select.value=value;close(true);select.dispatchEvent(new Event('change',{bubbles:true}));sync();
    };
    function option(parent,value,text,meta='',section=false) {
      const original=[...select.options].find(o=>o.value===value);if(!original)return;
      const row=node('button',section?'picker-section':'picker-row');row.type='button';row.tabIndex=-1;row.dataset.value=value;row.disabled=original.disabled;
      row.setAttribute('role','option');row.setAttribute('aria-selected',String(value===select.value));
      if(section)row.setAttribute('aria-label',`选择整栋${text}，${meta}`);
      if(spatial&&!section)row.append(building());
      row.append(node('span','row-title',text));if(meta)row.append(node('small','',meta));
      if(value===select.value)row.append(icon('m5 12 4 4L19 6','row-check'));
      row.addEventListener('click',()=>choose(value));parent.append(row);
    }
    function renderOptions() {
      list.replaceChildren();const query=(search?.value||'').trim().toLocaleLowerCase();
      if(spatial){
        if(!query||'全部空间'.includes(query))option(list,'all','全部空间',`${points.length} 个点位`);
        for(const name of [...new Set(points.map(p=>p.building))]){
          const subset=points.filter(p=>p.building===name);
          const zones=[...new Set(subset.map(p=>p.zone_id))].map(zone=>subset.filter(p=>p.zone_id===zone));
          const visible=zones.filter(group=>`${name} ${group[0].floor} ${group[0].zone_id}`.toLocaleLowerCase().includes(query));
          if(!visible.length)continue;
          const group=node('div','picker-group');group.setAttribute('role','group');group.setAttribute('aria-label',name);list.append(group);
          option(group,'building:'+name,name,`整栋 · ${subset.length} 个点位`,true);
          for(const items of visible)option(group,'zone:'+items[0].zone_id,items[0].floor,`${items[0].zone_id} · ${items.length} 个点位`);
        }
      }else for(const o of select.options)option(list,o.value,o.textContent);
      const options=[...list.querySelectorAll('[role=option]:not(:disabled)')];
      const first=options.find(r=>r.getAttribute('aria-selected')==='true')||options[0];if(first)first.tabIndex=0;
      empty.hidden=options.length>0;list.hidden=!options.length;
      announcement.textContent=options.length?`找到 ${options.length} 个可选范围`:'没有匹配项';
      position();
    }
    search?.addEventListener('input',renderOptions);
    list.addEventListener('focusin',event=>{if(event.target.matches('[role=option]'))for(const row of list.querySelectorAll('[role=option]'))row.tabIndex=row===event.target?0:-1;});
    popup.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
      const rows=[...list.querySelectorAll('[role=option]:not(:disabled)')];
      if(['ArrowDown','ArrowUp'].includes(event.key)){
        event.preventDefault();const i=rows.indexOf(document.activeElement);
        rows[i<0?(event.key==='ArrowDown'?0:rows.length-1):(i+(event.key==='ArrowDown'?1:-1)+rows.length)%rows.length]?.focus();
      }else if(['Home','End'].includes(event.key)&&event.target!==search){event.preventDefault();(event.key==='Home'?rows[0]:rows.at(-1))?.focus();}
      else if(event.key==='Enter'&&event.target===search){event.preventDefault();rows[0]?.focus();}
      else if(event.key==='Tab'){
        const targets=[...popup.querySelectorAll('input,button:not(:disabled)')].filter(e=>e.tabIndex>=0&&e.getClientRects().length);
        const i=targets.indexOf(document.activeElement);
        if((event.shiftKey&&i<=0)||(!event.shiftKey&&i===targets.length-1)){
          event.preventDefault();const backwards=event.shiftKey;close(true);
          if(!backwards){const all=[...document.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(e=>e.tabIndex>=0&&e.getClientRects().length);all[all.indexOf(trigger)+1]?.focus();}
        }
      }
    });
    active={...picker,popup};document.body.append(popup);trigger.setAttribute('aria-expanded','true');renderOptions();position();notify(true);
    if(keyboard)list.querySelector('[tabindex="0"]')?.focus();else (search||list.querySelector('[tabindex="0"]')||dismiss).focus({preventScroll:true});
  }
  for(const [id,label,spatial] of configs) {
    const select=document.getElementById(id);if(!select)continue;
    const wrapper=node('div','filter-picker'),trigger=node('button','filter-picker-trigger'),value=node('span','picker-value');
    trigger.type='button';trigger.id=id+'-trigger';trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',id+'-popup');
    if(spatial)trigger.append(building());trigger.append(value,icon('m6 9 6 6 6-6','icon chevron'));
    select.before(wrapper);wrapper.append(select,trigger);
    // Hide only after construction succeeds; the original control is restored on disposal.
    const wasHidden=select.hidden;select.hidden=true;
    const picker={select,trigger,value,label,spatial,wrapper,wasHidden};pickers.set(id,picker);
    on(trigger,'click',()=>open(picker));on(trigger,'keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();open(picker,true);}});
    on(select,'change',()=>{if(active?.select===select)close();sync();});
  }
  on(document,'pointerdown',event=>{if(active&&!active.popup.contains(event.target)&&!active.trigger.contains(event.target))close();},{capture:true});
  on(document,'focusin',event=>{if(active&&!active.popup.contains(event.target)&&!active.trigger.contains(event.target))close();});
  on(window,'resize',position,{passive:true});on(window.visualViewport,'resize',position,{passive:true});on(window.visualViewport,'scroll',position,{passive:true});
  on(window,'scroll',event=>{if(active&&!active.popup.contains(event.target))close();},{passive:true,capture:true});
  on(document,'visibilitychange',()=>{if(document.hidden)close();});
  on(window,'pagehide',event=>{if(event.persisted)close();else destroy();});
  function destroy(){if(disposed)return;disposed=true;close();events.abort();for(const {select,wrapper,wasHidden} of pickers.values()){select.hidden=wasHidden;wrapper.before(select);wrapper.remove();}pickers.clear();}
  sync();return {sync,close,destroy};
}