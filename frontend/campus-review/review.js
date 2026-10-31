import * as THREE from '../vendor/three/three.module.js';
import {loadCampusAsset} from '../twin/campus-asset.js';
import {CAMPUS_BUILDINGS} from '../twin/campus-layout.js';
import {createDaylightEnvironment} from '../twin/architectural-lighting.js';
import {loadSampleHDREnvironment} from '../facade-sample/lighting.js';
const stage=document.querySelector('#stage'),status=document.querySelector('#status'),building=document.querySelector('#building'),view=document.querySelector('#view'),labels=document.querySelector('#labels'),annotations=document.querySelector('#annotations');
let model,renderer,environment,disposed=false,observer,parts=[],camera,scene,frame=0;
const names={front:'南立面',back:'北立面',left:'西立面',right:'东立面',roof:'屋顶平面'};
function render(){frame=0;if(disposed||!model||document.hidden)return;const w=stage.clientWidth,h=stage.clientHeight;renderer.setSize(w,h);const b=CAMPUS_BUILDINGS.find(b=>b.id===building.value),kind=view.value,[x,,z]=b.position,[bw,bd]=b.size,bh=b.floors*b.floorHeight+.9;
 const spanX=kind==='left'||kind==='right'?bd+5:bw+5,spanY=kind==='roof'?bd+8:bh+2,extent=Math.max(spanY,spanX*h/w)*1.12;
 camera.left=-extent*w/h/2;camera.right=-camera.left;camera.top=extent/2;camera.bottom=-camera.top;camera.up.set(0,1,0);
 const dirs={front:[0,0,1],back:[0,0,-1],left:[-1,0,0],right:[1,0,0],roof:[0,1,0]},dir=new THREE.Vector3(...dirs[kind]),target=new THREE.Vector3(x,kind==='roof'?0:bh/2,z);
 if(kind==='roof')camera.up.set(0,0,-1);camera.position.copy(target).addScaledVector(dir,70);camera.lookAt(target);camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
 for(const part of parts)part.visible=part.userData.buildingId===b.id;
 renderer.render(scene,camera);stage.dataset.projection='orthographic';stage.dataset.building=b.id;stage.dataset.view=kind;stage.dataset.ready='true';
 const items=parts.filter(p=>p.visible&&(kind==='roof'?['roof','equipment'].includes(p.userData.role):p.userData.id?.includes('_'+kind+'_')||kind==='front'&&['door','awning','sign'].includes(p.userData.role)));
 const unique=new Map();for(const part of items){const u=part.userData;const old=unique.get(u.id);const box=new THREE.Box3().setFromObject(part);if(old)old.box.union(box);else unique.set(u.id,{...u,box});}
 annotations.replaceChildren();const list=document.querySelector('#components');list.replaceChildren();let i=0;
 for(const item of unique.values()){
  const li=document.createElement('li');li.textContent=item.name+' · '+item.id+'（设计暂估）';list.append(li);
  if(!labels.checked||!['window','door','equipment','sign','awning'].includes(item.role))continue;
  const v=item.box.getCenter(new THREE.Vector3()).project(camera),tag=document.createElement('span');tag.className='tag';tag.textContent=item.role==='window'?item.id.split('_').slice(-2).join(' / '):({door:'入口',equipment:'屋面设备',sign:'标识',awning:'雨棚'})[item.role];tag.style.left=(v.x*.5+.5)*100+'%';tag.style.top=(-v.y*.5+.5)*100+'%';annotations.append(tag);i++;
 }
 document.querySelector('#caption').textContent=`${b.displayName} · ${names[kind]} · 正投影 · 暂估主体 ${bw} m × ${bd} m · ${b.floors} 层；${unique.size} 类构件。非实测，不作施工或巡检依据。`;
}
function invalidate(){if(!frame&&!disposed&&!document.hidden)frame=requestAnimationFrame(render);}
try{
 renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;stage.prepend(renderer.domElement);
 scene=new THREE.Scene();scene.background=new THREE.Color(0xe3e9e6);camera=new THREE.OrthographicCamera(-20,20,10,-10,.1,200);environment=createDaylightEnvironment(renderer);scene.environment=environment.texture;scene.environmentIntensity=.65;scene.add(new THREE.HemisphereLight(0xe9f3ff,0xbec6bd,.7));const sun=new THREE.DirectionalLight(0xfff6e9,3);sun.position.set(-35,45,30);scene.add(sun);
 model=await loadCampusAsset();model.group.updateMatrixWorld(true);
 // Extract only one building's named components, keeping the same geometry/material source.
 model.group.traverse(mesh=>{if(!mesh.isMesh)return;const ranges=mesh.userData.components||[],groups=new Map();for(const c of ranges){if(!c.buildingId)continue;if(!groups.has(c.id))groups.set(c.id,[]);groups.get(c.id).push(c);}for(const[id,ranges]of groups){const geometry=new THREE.BufferGeometry();for(const[key,a]of Object.entries(mesh.geometry.attributes)){const count=ranges.reduce((n,c)=>n+c.count,0),array=new Float32Array(count*a.itemSize);let k=0;for(const c of ranges)for(let i=c.start;i<c.start+c.count;i++)for(let j=0;j<a.itemSize;j++)array[k++]=a.getComponent(i,j);geometry.setAttribute(key,new THREE.BufferAttribute(array,a.itemSize));}geometry.applyMatrix4(mesh.matrixWorld);const part=new THREE.Mesh(geometry,mesh.material);part.userData={...ranges[0]};parts.push(part);scene.add(part);}});
 observer=new ResizeObserver(invalidate);observer.observe(stage);for(const input of [building,view,labels])input.addEventListener('change',invalidate);invalidate();status.textContent='本地模型已加载 · 可查看三栋建筑的四立面与屋顶';document.querySelector('#save').disabled=false;
 loadSampleHDREnvironment(renderer,()=>!disposed).then(next=>{if(!next)return;environment.dispose();environment=next;scene.environment=next.texture;scene.environmentRotation.y=next.rotation;invalidate();}).catch(()=>{});
 document.querySelector('#save').addEventListener('click',()=>{render();const c=document.createElement('canvas'),w=renderer.domElement.width,h=renderer.domElement.height;c.width=w;c.height=h+80;const ctx=c.getContext('2d');ctx.fillStyle='#edf1ee';ctx.fillRect(0,0,w,h+80);ctx.drawImage(renderer.domElement,0,0);const sr=stage.getBoundingClientRect(),scale=w/sr.width;for(const tag of annotations.children){const tr=tag.getBoundingClientRect();ctx.fillStyle='#fff';ctx.fillRect((tr.x-sr.x)*scale,(tr.y-sr.y)*scale,tr.width*scale,tr.height*scale);ctx.fillStyle='#173039';ctx.font=`${11*scale}px monospace`;ctx.fillText(tag.textContent,(tr.x-sr.x+3)*scale,(tr.y-sr.y+12)*scale);}ctx.fillStyle='#173039';ctx.font='16px sans-serif';ctx.fillText(`${building.selectedOptions[0].textContent} / ${names[view.value]} / 正投影 / 原创设计，尺寸暂估，非测绘`,18,h+30);const a=document.createElement('a');a.download=`${building.value}-${view.value}-concept.png`;a.href=c.toDataURL('image/png');a.click();});
}catch(error){status.textContent='三维核对图暂不可用：'+error.message+'。可返回工作台继续巡检。';}
addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;}else invalidate();});addEventListener('pagehide',()=>{disposed=true;cancelAnimationFrame(frame);observer?.disconnect();parts.forEach(p=>p.geometry.dispose());model?.dispose();environment?.dispose();renderer?.dispose();});
