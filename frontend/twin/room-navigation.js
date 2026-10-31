// Pure visibility-graph navigation for schematic rooms; no business state is stored here.
const RADIUS=.22;
const expanded=box=>({minX:box.minX-RADIUS,maxX:box.maxX+RADIUS,minZ:box.minZ-RADIUS,maxZ:box.maxZ+RADIUS});
export function isWalkable(p,room){
 const b=room.walkBounds;
 return Number.isFinite(p.x)&&Number.isFinite(p.z)&&p.x>=b.minX&&p.x<=b.maxX&&p.z>=b.minZ&&p.z<=b.maxZ&&
  !(room.obstacles||[]).some(box=>{const r=expanded(box);return p.x>=r.minX&&p.x<=r.maxX&&p.z>=r.minZ&&p.z<=r.maxZ;});
}
function clearSegment(a,b,room){
 return !(room.obstacles||[]).some(box=>{
  const r=expanded(box);let lo=0,hi=1;
  for(const key of ['X','Z']){const k=key.toLowerCase(),d=b[k]-a[k];
   if(Math.abs(d)<1e-9){if(a[k]<r['min'+key]||a[k]>r['max'+key])return false;}
   else{let u=(r['min'+key]-a[k])/d,v=(r['max'+key]-a[k])/d;if(u>v)[u,v]=[v,u];lo=Math.max(lo,u);hi=Math.min(hi,v);if(lo>hi)return false;}
  }return hi>=0&&lo<=1;
 });
}
export function planWalk(start,end,room){
 const a={x:start.x,z:start.z},b={x:end.x,z:end.z};
 if(!isWalkable(a,room)||!isWalkable(b,room))return null;
 const nodes=[a,b];
 for(const box of room.obstacles||[]){const r=expanded(box);for(const x of [r.minX-.025,r.maxX+.025])for(const z of [r.minZ-.025,r.maxZ+.025]){const p={x,z};if(isWalkable(p,room))nodes.push(p);}}
 const dist=nodes.map(()=>Infinity),previous=nodes.map(()=>-1),visited=new Set();dist[0]=0;
 while(visited.size<nodes.length){let u=-1;for(let i=0;i<nodes.length;i++)if(!visited.has(i)&&(u<0||dist[i]<dist[u]))u=i;
  if(u<0||!Number.isFinite(dist[u]))return null;if(u===1)break;visited.add(u);
  for(let v=0;v<nodes.length;v++)if(v!==u&&!visited.has(v)&&clearSegment(nodes[u],nodes[v],room)){
   const next=dist[u]+Math.hypot(nodes[u].x-nodes[v].x,nodes[u].z-nodes[v].z);
   if(next<dist[v]){dist[v]=next;previous[v]=u;}
  }
 }
 if(!Number.isFinite(dist[1]))return null;const route=[];for(let i=1;i>=0;i=previous[i])route.unshift(nodes[i]);return route;
}