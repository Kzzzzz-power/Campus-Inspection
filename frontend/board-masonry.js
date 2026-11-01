// Layout only. Business ordering remains the DOM order; never use dense packing.
export function initBoardMasonry(grids, motionAllowed) {
  let frame=0, disposed=false;
  const observed=new Set(), positions=new Map(), animations=new Map();
  const resize=new ResizeObserver(()=>schedule());
  function observe(){
    const current=new Set(grids.flatMap(g=>[...g.children].map(p=>p.querySelector('.pin-content')).filter(Boolean)));
    for(const node of observed)if(!current.has(node)){resize.unobserve(node);observed.delete(node);}
    for(const node of current)if(!observed.has(node)){observed.add(node);resize.observe(node);}
    schedule();
  }
  function schedule(){if(!frame&&!disposed)frame=requestAnimationFrame(layout);}
  function layout(){
    frame=0;
    animations.forEach(animation=>animation.cancel());animations.clear();
    const visible=grids.filter(g=>g.getClientRects().length), measures=[];
    for(const grid of visible){
      const style=getComputedStyle(grid), row=parseFloat(style.gridAutoRows)||8, gap=parseFloat(style.rowGap)||0;
      for(const pin of grid.children){
        const content=pin.querySelector('.pin-content');
        if(content&&!pin.hidden)measures.push([pin,Math.max(1,Math.ceil((content.getBoundingClientRect().height+parseFloat(getComputedStyle(pin).borderTopWidth)+parseFloat(getComputedStyle(pin).borderBottomWidth)+gap)/(row+gap)))]);
      }
    }
    for(const [pin,span] of measures)if(pin.style.gridRowEnd!=='span '+span)pin.style.gridRowEnd='span '+span;
    const next=new Map(measures.map(([pin])=>[pin,{left:pin.offsetLeft,top:pin.offsetTop,rect:pin.getBoundingClientRect()}]));
    for(const [pin,rect] of next){
      const previous=positions.get(pin);
      if(previous&&motionAllowed()&&pin.animate){
        const dx=previous.left-rect.left,dy=previous.top-rect.top;
        if((Math.abs(dx)>.5||Math.abs(dy)>.5)&&rect.rect.bottom>0&&rect.rect.top<innerHeight){
          const animation=pin.animate([{transform:`translate(${dx}px,${dy}px)`},{transform:'translate(0,0)'}],{duration:220,easing:'cubic-bezier(.2,.8,.2,1)'});
          animations.set(pin,animation);animation.finished.then(()=>animations.delete(pin),()=>{});
        }
      }
      positions.set(pin,{left:rect.left,top:rect.top});
    }
    for(const pin of positions.keys())if(!pin.isConnected)positions.delete(pin);
  }
  const mutation=new MutationObserver(observe);grids.forEach(g=>mutation.observe(g,{childList:true}));observe();
  const cancel=()=>{animations.forEach(a=>a.cancel());animations.clear();};
  const onFeedback=e=>{if(!e.detail.enabled)cancel();};
  const onVisibility=()=>{if(document.hidden)cancel();else schedule();};
  document.addEventListener('inspectgo:feedback',onFeedback);document.addEventListener('visibilitychange',onVisibility);
  return {refresh({reset=false}={}){if(reset)positions.clear();observe();},dispose(){disposed=true;cancelAnimationFrame(frame);cancel();resize.disconnect();mutation.disconnect();document.removeEventListener('inspectgo:feedback',onFeedback);document.removeEventListener('visibilitychange',onVisibility);}};
}
