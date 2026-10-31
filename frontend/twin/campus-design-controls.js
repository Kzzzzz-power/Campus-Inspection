import {CAMPUS_BUILDINGS} from './campus-layout.js';
const labels={zh:{summary:'场景设置 · 设计示意',building:'观察建筑',view:'相机',overall:'校园总览',front:'南立面',back:'北立面',left:'西立面',right:'东立面',roof:'屋顶',entry:'入口近景',window:'门窗近景',time:'示意光照',morning:'上午侧光',afternoon:'下午侧光',evening:'傍晚暖光',roofToggle:'揭顶查看',windowToggle:'打开示意窗',fanToggle:'风扇演示',download:'下载校园 GLB',note:'原创设计，尺寸暂估。光照、开窗和风扇仅供空间演示，不控制真实设施。'},en:{summary:'Scene settings · Concept',building:'Building',view:'Camera',overall:'Campus',front:'South elevation',back:'North elevation',left:'West elevation',right:'East elevation',roof:'Roof',entry:'Entrance',window:'Window detail',time:'Illustrative lighting',morning:'Morning',afternoon:'Afternoon',evening:'Evening',roofToggle:'Reveal roof',windowToggle:'Open concept window',fanToggle:'Fan demonstration',download:'Export campus GLB',note:'Original design, estimated dimensions. Lighting, windows and fans are visual demonstrations, never device controls.'}};
function el(tag,attrs={},text=''){const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);e.textContent=text;return e;}
export function initDesignControls({host,getScene,fly,invalidate,modeChanged}){
 const events=new AbortController(),panel=el('details',{class:'twin-design-tools'}),summary=el('summary'),body=el('div',{class:'twin-design-body'});
 panel.append(summary,body);host.querySelector('.twin-toolbar').after(panel);
 let language='zh',roofOpen=false,windowOpen=false,fanOn=false,last=0,highlight=null,renderer=null,ray=null,drag=null,disposed=false;
 const refs={};
 const on=(node,event,fn)=>node.addEventListener(event,fn,{signal:events.signal});
 function select(id,key,options){const label=el('label'),text=el('span'),input=el('select',{id});input.append(...options.map(([value,title])=>el('option',{value},title)));label.append(text,input);body.append(label);refs[key]=text;return input;}
 const buildings=select('twin-design-building','building',CAMPUS_BUILDINGS.map(b=>[b.id,b.displayName]));
 const views=select('twin-design-view','view',['overall','front','back','left','right','roof','entry','window'].map(v=>[v,v]));
 const time=select('twin-design-time','time',['morning','afternoon','evening'].map(v=>[v,v]));time.value='afternoon';
 const lang=select('twin-design-language','language',[['zh','中文'],['en','English']]);refs.language.textContent='空间控件 / Language';
 function toggle(id,key){const b=el('button',{id,type:'button','aria-pressed':'false'});refs[key]=b;body.append(b);return b;}
 const roof=toggle('twin-design-roof','roofToggle'),windowButton=toggle('twin-design-window','windowToggle'),fan=toggle('twin-design-fan','fanToggle');
 const download=el('button',{id:'twin-design-export',type:'button'});refs.download=download;body.append(download);const reviewLink=el('a',{href:'/static/campus-review/index.html',target:'_blank',rel:'noopener'},'四立面与屋顶正投影');body.append(reviewLink);
 const note=el('p',{class:'twin-design-note'});body.append(note);
 const info=el('aside',{class:'twin-component-info',hidden:'','aria-live':'polite'}),infoText=el('p'),close=el('button',{type:'button','aria-label':'关闭构件信息'},'×');info.append(infoText,close);host.querySelector('.twin-viewport').append(info);on(close,'click',clearPick);
 function translate(){const t=labels[language];summary.textContent=t.summary;for(const[key,e]of Object.entries(refs))if(t[key])e.textContent=t[key];for(const option of views.options)option.textContent=t[option.value];for(const option of time.options)option.textContent=t[option.value];note.textContent=t.note;}
 translate();on(lang,'change',()=>{language=lang.value;translate();});
 function light(){const {scene,sunLight,fillLight,skyLight,pointScene,renderer}=getScene();if(!scene||!sunLight)return;
  const positions={morning:[-30,32,-25],afternoon:[-35,45,30],evening:[-38,17,26]};
  sunLight.position.fromArray(pointScene?.interior?[-12,5,5]:positions[time.value]);
  scene.background.setHex(({morning:0xd8e8ef,afternoon:0xe2ecef,evening:0xe8d8c9})[time.value]);if(scene.fog)scene.fog.color.copy(scene.background);
  sunLight.color.setHex(time.value==='evening'?0xffd3a0:0xfff4df);sunLight.intensity=pointScene?.interior?2.6:time.value==='evening'?2.8:3.1;
  fillLight.intensity=pointScene?.interior ? .38 : .28;skyLight.intensity=pointScene?.interior ? .52 : .55;
  scene.environmentIntensity=pointScene?.interior ? .48 : .65;
  if(scene.userData.hdrRotation!==undefined){const reference=Math.atan2(5,-4.5),actual=Math.atan2(sunLight.position.z,sunLight.position.x);scene.environmentRotation.y=scene.userData.hdrRotation+reference-actual;}
  renderer.shadowMap.needsUpdate=true;invalidate();
 }
 on(time,'change',light);
 function preset(){const s=getScene(),{THREE,campus,selected,pointScene,camera,controls}=s;if(!campus||selected||!camera)return;
  const b=CAMPUS_BUILDINGS.find(b=>b.id===buildings.value),[x,,z]=b.position,[w,d]=b.size,h=b.floors*b.floorHeight;
  const centre=[x,h*.48,z],dir={front:[0,0,1],back:[0,0,-1],left:[-1,0,0],right:[1,0,0]},kind=views.value;
  if(kind==='overall'){s.resetCampus?.();return;}
  controls.enablePan=true;controls.minDistance=1.8;controls.maxDistance=110;
  let position,target=centre;
  if(dir[kind]){const v=dir[kind],length=kind==='left'||kind==='right'?d:w,dist=Math.max(h*1.25,length/Math.max(.7,camera.aspect)) / Math.tan(camera.fov*Math.PI/360)*.65;position=[x+v[0]*(dist+w/2),h*.5,z+v[2]*(dist+d/2)];}
  else if(kind==='roof'){position=[x,h+Math.max(w,d)*1.2,z+.01];target=[x,h,z];}
  else if(kind==='entry'){position=[x+3,2.1,z+d/2+6.3];target=[x,1.8,z+d/2];}
  else{target=[x-w*.27,b.floorHeight*1.6,z+d/2];position=[target[0]+2.1,target[1]+.2,target[2]+3.5];}
  fly(position,target,850);invalidate();
 }
 on(views,'change',preset);on(buildings,'change',preset);
 function clearPick(){info.hidden=true;delete host.dataset.component;if(highlight){const {scene}=getScene();scene?.remove(highlight);highlight.geometry.dispose();highlight.material.dispose();highlight=null;}invalidate();}
 function pick(event,focus=false,hover=false){const s=getScene();if(s.selected||!s.campus||!s.renderer)return;const {THREE,campus,camera,scene}=s;
  ray??=new THREE.Raycaster();const r=s.renderer.domElement.getBoundingClientRect();ray.setFromCamera(new THREE.Vector2((event.clientX-r.left)/r.width*2-1,-(event.clientY-r.top)/r.height*2+1),camera);
  const hit=ray.intersectObject(campus.group,true).find(h=>h.object.userData.components?.some(c=>c.buildingId&&h.faceIndex*3>=c.start&&h.faceIndex*3<c.start+c.count));if(!hit){clearPick();return;}
  const component=hit.object.userData.components.find(c=>hit.faceIndex*3>=c.start&&hit.faceIndex*3<c.start+c.count);if(!component?.buildingId)return;
  if(hover&&host.dataset.component===component.id)return;
  clearPick();const box=new THREE.Box3(),v=new THREE.Vector3(),p=hit.object.geometry.attributes.position;
  for(const c of hit.object.userData.components.filter(c=>c.id===component.id))for(let i=c.start;i<c.start+c.count;i++)box.expandByPoint(v.fromBufferAttribute(p,i).applyMatrix4(hit.object.matrixWorld));
  highlight=new THREE.Box3Helper(box,0xbfa168);scene.add(highlight);
  infoText.textContent=`${component.name} · ${component.id}\n${hit.object.userData.materialKind} / 原创构造示意；非测绘，不作为现场证据。`;info.hidden=hover;host.dataset.component=component.id;
  if(focus){buildings.value=component.buildingId;views.value=component.role==='roof'?'roof':component.role==='door'||component.role==='awning'?'entry':'window';preset();}
  invalidate();
 }
 on(roof,'click',()=>{const s=getScene();if(!s.scene)return;roofOpen=!roofOpen;roof.setAttribute('aria-pressed',String(roofOpen));
  if(s.pointScene){s.pointScene.roof.visible=!roofOpen;modeChanged(roofOpen);if(roofOpen)fly([9,9,11],[0,.8,0],650);else fly(s.pointScene.cameraPosition.toArray(),s.pointScene.target.toArray(),550,()=>modeChanged(false));}
  else s.campus?.setRoofOpen(roofOpen);
  s.renderer.shadowMap.needsUpdate=true;invalidate();
 });
 on(windowButton,'click',()=>{const s=getScene();if(!s.pointScene)return;windowOpen=!windowOpen;s.pointScene.setWindowOpen?.(windowOpen?1:0);windowButton.setAttribute('aria-pressed',String(windowOpen));s.renderer.shadowMap.needsUpdate=true;invalidate();});
 on(fan,'click',()=>{if(!getScene().pointScene?.hasFan)return;fanOn=!fanOn;last=0;fan.setAttribute('aria-pressed',String(fanOn));invalidate();});
 on(download,'click',async()=>{const s=getScene();if(!s.campus)return;download.disabled=true;try{const {exportCampus}=await import('./export-campus.js');const bytes=await exportCampus(s.campus.group),url=URL.createObjectURL(new Blob([bytes],{type:'model/gltf-binary'}));const a=el('a',{href:url,download:'campus-design-estimated.glb'});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);note.textContent='GLB 已生成：原创建筑设计示意，保留构件编号。';}catch(e){note.textContent='模型导出失败，请重试：'+e.message;}finally{download.disabled=false;}});
 function attach(){const s=getScene();if(!s.renderer||renderer===s.renderer)return;renderer=s.renderer;const canvas=renderer.domElement;
  on(canvas,'pointerdown',e=>{drag={x:e.clientX,y:e.clientY};});on(canvas,'pointerup',e=>{if(drag&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5)pick(e);drag=null;});on(canvas,'dblclick',e=>pick(e,true));let hoverAt=0;on(canvas,'pointermove',e=>{if(drag||e.pointerType==='touch'||performance.now()-hoverAt<100)return;hoverAt=performance.now();pick(e,false,true);});on(canvas,'pointerleave',()=>{if(info.hidden)clearPick();});
 }
 return {
  get roofOpen(){return roofOpen;},
  sceneChanged(){roofOpen=false;windowOpen=false;fanOn=false;last=0;clearPick();for(const b of [roof,windowButton,fan])b.setAttribute('aria-pressed','false');const s=getScene();s.campus?.setRoofOpen(false);windowButton.disabled=!s.pointScene?.setWindowOpen;fan.disabled=!s.pointScene?.hasFan;buildings.disabled=views.disabled=!!s.selected;attach();light();},
  applyLight:light,
  constrain(){const {camera,selected,controls}=getScene();if(!camera||selected)return;camera.position.y=Math.max(.65,camera.position.y);for(const b of CAMPUS_BUILDINGS){const[x,,z]=b.position,[w,d]=b.size,h=b.floors*b.floorHeight+.7;if(camera.position.y>h+.5)continue;const dx=camera.position.x-x,dz=camera.position.z-z;if(Math.abs(dx)<w/2+.65&&Math.abs(dz)<d/2+.65){if((w/2+.65-Math.abs(dx))<(d/2+.65-Math.abs(dz)))camera.position.x=x+Math.sign(dx||1)*(w/2+.7);else camera.position.z=z+Math.sign(dz||1)*(d/2+.7);}}},
  tick(now,animate){if(!fanOn||!getScene().pointScene?.hasFan||!animate){last=0;return false;}const dt=last?Math.min(.05,(now-last)/1000):.016;last=now;getScene().pointScene.fan.rotation.z+=dt*3;return true;},
  dispose(){disposed=true;events.abort();clearPick();panel.remove();info.remove();}
 };
}