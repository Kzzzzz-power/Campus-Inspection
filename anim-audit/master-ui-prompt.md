# 日间玻璃工作台 · 深化版完整提示词

> 只包含提示词。验收全部用 DOM 断言、计算样式、测试输出和性能记录完成。

---

```text
你是一名资深前端设计工程师，在 D:\校园设施巡检与复核 工作。
项目是原生 HTML/CSS/JS（ES Modules，无构建、无 npm 依赖）+ FastAPI 的单页巡检工作台。
你的任务不是“做一个新页面”，而是：先把当前「日间玻璃巡检工作台」完整复刻并核对，再在同一套设计系统上追加旋转木马选房、穿梭转场、视差滚动和点击 Spark。

【工作方式】
1. 先读代码：AGENTS.md、README.md、frontend/index.html、frontend/styles.css、frontend/glass.css、
   frontend/motion.css、frontend/motion.js、frontend/filter-pickers.js、frontend/app.js。
2. 先输出一份实现计划：要新增/修改的文件、组件边界、状态流、测试点；确认没有业务回归后再写代码。
3. 分阶段执行，每阶段结束跑测试；测试失败就停下修，不要继续堆功能。
4. 如果仓库已经是 glass 版本（存在 frontend/glass.css），Phase 1 只做核对，不重写；直接做 Phase 2。
5. 不要用视觉稿替代实现；所有验收用可执行的 DOM/样式/测试断言。

【硬约束】
- 不引入 React、GSAP、ogl、three、React Bits 或任何 npm 依赖；不复制第三方源码。
- 不改后端接口、数据库、业务状态机、API 字段；不伪造房间、照片、记录或统计。
- 房间数据只来自现有 state.data.points（C01–C08）；没有照片就用渐变/线框占位。
- 只动画 transform / opacity / clip-path；不动画 width/height/top/left/margin。
- 不给大面积元素加 backdrop-filter；只有顶栏、左右栏、选择浮层、toast 这类小面积元素可用。
- 新增动效必须接入 data-motion / data-feedback / prefers-reduced-motion；移动端降低或关闭 3D/视差。
- 现有 4 项前端单元检查、51 项浏览器检查必须继续通过；新增交互必须补测试。
- 新控件必须有键盘路径、可见焦点、aria 名称；焦点不能被不可见层吞掉。
- 用户输入用 textContent；不拼 HTML；不引入远程字体、图片、图标库。
- 不改变 dialog.showModal() 的同步时序；warp 必须在 openDetail 之前完成。

【数据契约（只读）】
state.data = {
  points: Point[],
  covered: number,
  missing: Point[],
  required_total: number,
  window_minutes: number,
  window_start: string,
  window_end: string,
  as_of: string
}

Point = {
  point_id: 'C01'…'C08',
  device: string,              // 照明控制 / 空调 / 网络点…
  building: string,            // 教学楼 / 实训楼
  floor: string,               // 二层 / 一层
  zone_id: 'Z1'…'Z3',
  required: boolean,
  covered: boolean,
  latest_status: 'ok'|'alarm'|'unknown'|'no-record',
  review: null | { status:'pending'|'completed', conclusion:'normal'|'fault'|'unknown', version:number, ... },
  at: string|null,
  photo_count: number,
  photos?: [{ url:string, inspected_at:string, created_at:string }]
}

现有接口（不要改）：
GET /api/dashboard；GET /api/points/{id}；POST /api/inspections；POST /api/reviews；
POST /api/reviews/{id}/evidence；POST /api/runs；GET /api/runs；GET /api/runs/{id}。

====================================================================
Phase 1 · 当前「日间玻璃工作台」复刻
====================================================================

【1.1 设计令牌】
色彩：
- 页面底 #e6eff3；基础纸白 #f3f6f5；
- 主文字 #0f202b；次级 #334a5a；辅助/时间 #405462；
- 发丝线 rgba(15,32,43,.10)；强调线 rgba(15,32,43,.18)；
- 主色 teal #0f766e；次色 sky #0284c7；告警 #b45309；危险 #be123c；正常 #15803d；
- 玻璃边 rgba(63,139,159,.26)；高光 rgba(255,255,255,.96)；
- 遮罩 rgba(15,32,43,.32)。

字体：
- 正文/标题：PingFang SC, Microsoft YaHei, Noto Sans CJK SC, system-ui, sans-serif；
- 等宽：Cascadia Mono, Consolas, monospace；
- 正文 14px/1.55；卡片设备名 16px/1.5 600；标题 32px/1.3 700；
- 大数字 34–44px，font-variant-numeric: tabular-nums。

形状：
- 卡片 14–15px；按钮 8–10px；概览 16px；浮层 16px；节点 6px；
- 阴影：卡片 0 8px 22px rgba(35,79,99,.065)；
  侧栏 0 15px 34px rgba(41,82,101,.08)；
  浮层 0 20px 56px rgba(30,76,98,.22)。

断点：1250 / 1100 / 767 / 580 / 320。

【1.2 页面结构】
<header class="app-header"> 高约 96px，sticky top 0，z-index 10。
  左：折角 SVG + 9 字标题「校园设施巡检与复核」；
  右：界面动效开关、连接状态「本地服务已连接 · 每 30 秒刷新」、更新时间、刷新、生成运行判断。
</header>

<div class="ambient" aria-hidden="true"> 3 个 span + 网格 </div>

<div class="app-shell"> 三栏：
  <aside class="scope-rail"> 楼栋/楼层导航 + 现场留存 + 教学演练声明 </aside>
  <main id="app-main">
    巡检概览：标题/说明/45 分钟窗口/覆盖规则/教学演练标签；
    3 格统计：已覆盖必检点、待补检（按钮）、必检点总数；
    点位覆盖示意：8 个 C01–C08 节点；
    巡检点位：结果计数 + 筛选工具条（搜索/楼栋楼层 picker/类型/状态/重置/网格列表）；
    按楼层分组的点位卡片。
  </main>
  <aside class="activity-rail"> 待处理 + 最近运行记录 </aside>
</div>

<dialog id="detail-dialog" class="drawer"> 520px 右侧抽屉 </dialog>
<dialog id="photo-dialog"> 照片预览 </dialog>
<dialog id="run-dialog"> 运行判断 </dialog>
<div id="toast" class="toast"></div>

【1.3 环境层】
- .ambient：fixed inset:0，z-index:0，pointer-events:none，overflow:hidden；
- 3 个 span，70–78vmax，border-radius:50%：
  1) radial #95cae5/.84，左上，72s；
  2) radial #a1ddda/.78，右上，88s；
  3) radial #c3d2eb/.76，底部，96s；
- 动画只改 transform：translate3d + scale，ease-in-out infinite alternate；
- .ambient::after：64px 网格 rgba(15,32,43,.06) 1px，mask 向下淡出，opacity .32；
- header 与 .app-shell z-index 1 以上；环境层不拦截点击。

【1.4 玻璃层】
- 顶栏：rgba(247,253,255,.68) + blur(18px) saturate(1.25)；
  底部 1px 白高光 + 青→蓝渐变发丝线。
- 左右栏：linear-gradient(145deg, rgba(255,255,255,.76), rgba(239,250,252,.53))；
  1px 白边 + outline rgba(91,147,165,.13)；blur(12px)；14px 圆角；
  左 padding 20 14；右 padding 14 18；sticky top 124。
- 概览：linear-gradient(120deg, rgba(255,255,255,.91), rgba(243,252,253,.69))；
  1px 白边 + outline glass edge；16px 圆角；内高光 + 12/30 阴影；
  底部 22% 宽 teal→白→透明光线，8s 循环。
- 卡片：linear-gradient(135deg, rgba(255,255,255,.91), rgba(245,252,254,.72) 55%, rgba(229,242,247,.64))；
  1px 白边 + outline rgba(84,137,158,.19)；15px 圆角；内高光 + 8/22 阴影；
  右上/左下折角细线 SVG（inset 8，teal .55）；hover 上移 2px、teal 边、14/30 阴影；
  指针位置 240px 径向聚光 rgba(2,132,199,.13)。
- 选择浮层：326px、16px 圆角、白 .94→.89、blur(22px)、20/56 阴影；
  打开 180ms 自上而下 + 轻微缩放。
- 输入：白 .64；聚焦 teal 边 + 3px rgba(15,118,110,.16) 光环。
- 主按钮：linear-gradient(125deg,#197c86,#146871)，白字，内高光 + 5/14 阴影。

【1.5 组件契约】
Header：
- 标题逐字翻转：每个字 front 0° / back -90°，translateZ .55em；
  800ms cubic-bezier(.16,1,.3,1)，每字延迟 24ms，1.1s 后复位；
  reduced-motion 不动。
- 动效开关控制 data-motion / data-feedback；标题、背景、拖尾、点击环、按压、VT 都受控。

概览：
- 3 列 1.15fr 1fr 1fr；数字 34–44px；待补检是 button，hover 浅 teal 底；
- 覆盖节点正常 #dceee7/teal，缺失 #fff2df/amber，普通白 .56；节点下方渐变连接线。

筛选：
- 搜索 46px；楼栋/楼层 picker 46px；类型/状态 46px；重置 ghost；
- 网格/列表 switch：外层玻璃，thumb 240ms 滑动，data-view="grid|list"；
- picker 弹层：标题、副标题、搜索、整栋/单层行、数量、勾选、底部说明、关闭；
  键盘 ←/→/Home/End/Enter/Esc/Tab，焦点返回，外部点击关闭，短视口滚动。

点位卡片：
- 内容顺序：C01 + 必检/普通标签；设备名；位置；三行状态；记录时间/照片数；两个操作按钮；
- 徽标：good #dceee2/#116b34；warn #fff0d9/#9a4a06；danger #fbe4e8/rose；
  muted #e7edec；info #dcecf4/#036a9b；
- 列表视图：单列，卡片 grid 三列（身份/状态/操作），复用同一批 DOM，不重建。

弹层：
- 原生 showModal；焦点陷阱；Esc 关闭；关闭后焦点回触发元素；
- 抽屉 520px；照片/运行居中；backdrop rgba(15,32,43,.32)；
- toast 右下，白 .82 + blur 10，6.5s；错误/成功语义保持。

【1.6 动效表】
| 触发 | 属性 | 时长/曲线 | 降级 |
| 标题首次/悬停 | transform rotateX | 800ms cubic-bezier(.16,1,.3,1)，每字 24ms | reduced 不动 |
| 环境色场 | transform | 72/88/96s alternate | reduced none |
| 概览光线 | transform | 8s 循环 | reduced none |
| 拖尾 | canvas 绘制 | 24 点/115px/250ms 空闲停止 | 触屏/弹层/选择浮层/按下/选中/滚动停止 |
| 点击环 | opacity+scale | 520ms linear，scale .3→2.1 | reduced 不显示 |
| 按压 | transform scale(.97) | 120ms cubic-bezier(.23,1,.32,1) | data-feedback=off 不缩放 |
| 筛选 FLIP | transform | 280ms | 搜索输入不动画 |
| 视图切换 | thumb 240ms；VT 320ms | cubic-bezier(.23,1,.32,1) | reduced 直接切换 |
| 弹层 | opacity + translate | 180ms + body 220ms | reduced 直接显示 |
| picker | opacity + translateY(-5px) + scale(.985) | 180ms | reduced 直接显示 |
| 加载 | rotate 360° | 800ms linear | reduced 静态 |

【1.7 状态矩阵】
- 加载：skeleton 3 组；aria-hidden；不阻塞操作。
- 空：无匹配点位，提供“清除筛选”。
- 错误：保留上次数据 + 错误文案 + 重试；不伪造成功。
- 禁用：refresh 禁用 + aria-busy；保存中禁用表单。
- 脏表单：关闭/切换前 confirm；失败保留草稿和 request_id。
- 403/409：文案区分“无权限/版本冲突”，409 提示重新打开。
- 照片失败：显示“图片暂时无法读取”，不隐藏错误。
- 无照片：空状态文案，不伪造图片。

【1.8 响应式/无障碍】
- >1250 三栏三列；1101–1250 三栏两列；≤1100 单栏，左栏隐藏，右栏下移；
  ≤767 两列；≤580 单列、抽屉全屏、picker 适配；320 无横向溢出。
- skip link；focus-visible 2px teal；aria-live；dialog 焦点陷阱；44px 触控区；
- hover 效果只在 (hover:hover) and (pointer:fine)；触屏关闭聚光/位移。
- reduced-motion：环境动画 none、点击环 none、VT none、过渡归零；
- data-motion / data-feedback 关闭时全部装饰动效停止，但业务操作仍可用。

====================================================================
Phase 2 · 追加动效
====================================================================

参考路径（只作视觉/机制参考，不安装、不复制源码）：
- 3D 环形选房：https://reactbits.dev/components/circular-carousel
- 环形画廊/点击全屏：https://reactbits.dev/components/circular-gallery
- 纵深轮播：https://reactbits.dev/components/depth-carousel
- 光隧道/穿梭：https://reactbits.dev/backgrounds/lightfall
- 高速光轨：https://reactbits.dev/backgrounds/hyperspeed
- 点击火花：https://reactbits.dev/animations/click-spark
- 像素转场：https://reactbits.dev/animations/pixel-transition
- 滚动叠卡：https://reactbits.dev/components/scroll-stack
- 滚动显影：https://reactbits.dev/text-animations/scroll-reveal
- Pro 视差轮播：https://pro.reactbits.dev/docs/components/parallax-carousel（只看理念）
- Pro 纵深画廊：https://pro.reactbits.dev/docs/components/dolly-gallery（只看理念）

【2.1 3D 旋转木马选房】
DOM：
<section id="room-stage" class="room-stage" aria-labelledby="room-stage-title">
  <div class="room-stage__head">
    <div><h2 id="room-stage-title">选择巡查空间</h2>
      <p>拖动、滚轮或按 ← → 选择；点击进入巡查</p></div>
    <span class="room-stage__count" aria-hidden="true">01 / 08</span>
  </div>
  <div id="room-carousel" class="room-carousel" role="region"
       aria-roledescription="carousel" aria-label="巡查房间" tabindex="0">
    <div class="room-viewport">
      <div class="room-ring">
        <button class="room-card" data-point="C01" type="button">…</button>
        … 8 个
      </div>
    </div>
  </div>
  <div class="room-stage__foot">
    <div class="room-summary" aria-live="polite">…</div>
    <button id="room-enter" class="btn btn-primary" type="button">进入巡查</button>
    <button class="room-arrow" data-dir="-1" aria-label="上一个房间">←</button>
    <button class="room-arrow" data-dir="1" aria-label="下一个房间">→</button>
  </div>
</section>

数据：state.data.points 映射为 8 张卡；卡片内容只用 Point 字段：
C01 · 必检点 / device / building·floor / zone_id / 三行状态 / at / photo_count。
如果当前数据里确实带 photos[0].url，才用真实图；否则浅青渐变 + 折角线 + 大号 C01。
不要为 8 张卡额外发 8 个详情请求；如果必须显示照片，只对当前选中房间按需请求详情。
不画假房间、不伪造照片。

3D 参数：
.room-viewport { perspective:1800px; height:380px; }
.room-ring { position:relative; width:0; height:0; margin:auto; transform-style:preserve-3d;
  transition: transform 520ms cubic-bezier(.16,1,.3,1); }
.room-card { position:absolute; width:236px; height:302px;
  margin:-151px 0 0 -118px; transform-style:preserve-3d; }
8 张，45°/张；radius = max((236+26)/(2*Math.sin(Math.PI/8)), 236*0.6) ≈ 342；
每张 transform: rotateY(index*45deg) translateZ(342px)；
.room-ring 的 transform: rotateY(-active*45deg)；
中心卡 .is-active：scale 1 / opacity 1 / z-index 2；
两侧：scale .82 / opacity .55；再外：scale .68 / opacity .28；背面 visibility:hidden。
桌面可选 1px 倒影（-webkit-box-reflect 或镜像伪元素），移动端关闭。
环形背后 radial 柔光 teal/sky，不遮文字。

交互：
- pointerdown/move/up：5px 阈值，pointer capture，横向拖拽旋转，速度采样最近 110ms；
  释放后按速度吸附到最近 45°，spring 520ms；纵向滚动不拦截。
- wheel：只接管 |deltaX|>|deltaY| 的横向滚轮；阻止页面横滚；纵向仍归页面。
- 键盘：←/→ 上一/下一，Home/End 首/尾，Enter/Space 进入。
- 点击任意卡：先 focusRoom(index) 居中；已居中的卡再点击 → warp。
- 默认不自动旋转；首次进入只做一次 1.2s rise；鼠标 ±3° 视角。
- 触摸：横向滑动，纵向交给页面；≤767 改为横向 scroll-snap，卡宽 180–200；
  选中卡 scrollIntoView({inline:'center'})；隐藏倒影和鼠标视差。

focusRoom(index)：
- target = -index*45；target += 360*Math.round((angle-target)/360)（最短路径）；
- 设 active，ring transform 到 target，520ms；
- 更新 aria-live「已选择 C07 网络交换节点」、摘要、计数 03 / 08；
- 调 setFilters({query:point.point_id, scope:'all', required:'all', status:'all'})；
- 滚动到点位区（reduced 时 auto）；state.roomSync 防循环。
- 用户在搜索框输入 C07，或楼层 picker 选中 Z3 时，自动 focusRoom 到对应房间；
  只同步一次，不要反向覆盖用户输入。

边界：
- 0 个点位：显示空状态，隐藏 carousel/箭头/进入巡查；
- 1 个点位：不旋转，只显示一张卡，按钮可用；
- 2–7 个点位：按实际数量计算 step=360/count；
- 照片加载失败：显示渐变占位，不阻塞。
- 组件不可见时暂停 rAF/过渡；恢复时重新计算尺寸。
- resize：重算 radius/卡片缩放；窗口 < 768 切换移动布局。

React Bits Circular Carousel 参考参数（按房间卡改）：
preset cylinder；cardWidth 236；aspectRatio .78；gap 26；tilt -6；perspective 1800；
curve 1；spread 1；billboard false；backfaces false；
autoplay off；draggable true；momentum .6；snap true；focusOnClick true；
parallax .3；stretch .5；depthFade .55；cornerRadius 14；captions false。

【2.2 穿梭 warp】
触发：选中房间的「进入巡查」/ 点击已居中的卡 / 键盘 Enter。不要每个按钮都触发。

DOM（临时）：
<div id="warp-layer" aria-hidden="true">
  <div class="warp-tunnel"></div>
  <div class="warp-flash"></div>
  <div class="warp-clone"></div>
</div>

720ms 时间线：
0–80ms：插入 #warp-layer（fixed inset:0，pointer-events:none，z-index:80）；
  .warp-tunnel 用 repeating-conic-gradient 或 12 个 1px 光线 span，
  颜色 teal/sky/白，从中心向外 translate + scaleY；
  .warp-flash 中心 radial 白青。
80–520ms：clone 选中卡（cloneNode(true)，去 id/按钮/aria），
  position:fixed，left/top/width/height 用原 rect；
  WAAPI 到全屏（transform + border-radius 14→0 + opacity 1），
  cubic-bezier(.16,1,.3,1)；隧道 scale(.6)→1.6、opacity 0→.85→0。
520–620ms：warp 层淡出；clone 保持全屏 120ms。
620ms：openDetail(point_id, 'inspect')；焦点进入抽屉；移除 warp 层。

约束：
- 颜色只用 teal/sky/白；不要紫、不要黑屏、不要全屏 blur。
- state.warping 防重复；页面隐藏/切换时取消；
- clone aria-hidden；warp 层移除后焦点在抽屉关闭按钮/首个表单控件；
- reduced-motion 或 data-motion=off：直接 openDetail，最多 180ms 淡入，不创建 clone/隧道；
- 关闭抽屉反向 360ms 缩回可选，但不能闪白；
- 不改变 dialog.open 的同步时序；warp 在 openDetail 前完成。

Lightfall 参考（只作视觉，不引 WebGL）：
lightMode true；colors ['#0f766e','#0284c7','#ffffff']；speed .4；
streakCount 2；streakWidth .8；zoom 3.1；glow 1；density .6；bloom .35；
opacity .9；holdToWarp false；intro true；fade .2。

【2.3 视差】
只三档：
- .ambient：scrollY * -0.04，限制 ±40px；
- .room-stage：scrollY * -0.10，限制 ±48px；
- 概览/卡片：不逐帧位移；IntersectionObserver 一次性 16px→0、opacity .94→1，stagger 40ms，最多 8 张。
实现：
- passive scroll + rAF 节流；只读 scrollY；写 --parallax-ambient / --parallax-stage；
- CSS translate3d；不要 background-attachment:fixed；不要在 scroll 里读 layout；
- 页面隐藏、reduced-motion、data-motion=off、≤767 时停止并清零；
- 不给每张卡加 scroll 监听；will-change 只在拖拽/转场期间加，结束移除；
- 滚动停止 120ms 后取消 rAF，避免空转。

【2.4 点击 Spark】
- 只在「进入巡查」和选房卡点击时触发；
- 8–12 条 1px 光线，28–44px，320ms ease-out，teal/sky/白；
- Canvas2D 一次性（DPR 上限 2）或 CSS span，结束移除；
- 其他控件保留 26px 点击环；不要叠加两个全屏效果；
- reduced-motion 完全不创建；连续点击合并为一次。

【2.5 视觉美化】
- room-stage 用玻璃框：1px 白边 + glass edge 外描边 + 18/60 阴影 + 底部青→蓝渐变光；
- 背景 radial 柔光，不遮文字；
- 中心卡比两侧多一层 0 8 30 阴影；底部 1px 分隔；
- h2 22–24px；说明 12px muted；计数等宽；
- 沿用 teal/sky/白玻璃；不引入新主色；
- 阅读顺序仍是「概览 → 点位」；room-stage 是入口，不是替代概览。

【2.6 文件与集成】
- 新增 frontend/room-stage.js、frontend/room-stage.css；
  index.html 引 CSS；app.js import initRoomStage。
- initRoomStage({
    getPoints: () => state.data?.points || [],
    onEnter: point => openDetail(point.point_id, 'inspect'),
    onSelect: point => setFilters({query:point.point_id, scope:'all', required:'all', status:'all'})
  });
- 不修改 filter-pickers.js 的原生 select 逻辑；不在 carousel 里维护第二套筛选状态；
- 不重构 app.js 的业务函数；只增加初始化与同步钩子；
- 不新增后端接口、不改数据、不改 README 的业务边界。

====================================================================
Phase 3 · 验收
====================================================================

【3.1 单元/浏览器用例】
必须新增并通过：
1) carousel 渲染 8 张卡；初始 active=C01；每张卡 aria-label 含房间名和序号。
2) ArrowRight 后 active=C02；Home/End 到首/尾；Enter 触发 warp 并打开详情。
3) 点击 C07 卡：先 focus 到中心，再点击一次进入；列表只剩 C07；结果计数为 1。
4) 搜索框输入 C07：carousel 自动 focusRoom(6)，列表 1 条；不会反向覆盖输入。
5) 楼层 picker 选择 Z3：carousel 自动 focus 到 Z3 第一间；列表 2 条。
6) warp：点击进入后 0–80ms 内存在 #warp-layer；≤900ms 后 detail-dialog.open 为 true；
   #warp-layer 已移除；焦点在抽屉内。
7) Esc 关闭抽屉：焦点回到触发卡/进入按钮。
8) reduced-motion：无 #warp-layer；detail 立即打开；room-ring 无 transform 过渡；
   --parallax-ambient / --parallax-stage 为 0px；click-spark 不存在。
9) 390：documentElement.scrollWidth === innerWidth；carousel 为 scroll-snap；触摸横向滑动不阻断纵向。
10) 0/1/2 个点位：分别显示空状态/单卡/两卡；不出现 NaN 角度或空白。
11) 无照片：卡片显示渐变占位；无 img onerror 冒泡。
12) 性能：拖拽 2s 内 Long Task 0；warp 720ms 后无残留 rAF；无 Layout 行（Performance 录制）。

【3.2 计算样式断言】
- body 背景 rgb(230,239,243)；
- header background-color 含 rgba(247,253,255,.68)，backdrop-filter 含 blur(18px)；
- .point-card border-radius 15px；outline-color 含 84,137,158；
- .summary-strip border-radius 16px；
- .room-card width 236px / height 302px（桌面）；≤767 为 180–200px；
- .room-ring transform 为 matrix3d（桌面）；≤767 为 none/2D；
- 点击环 26px、border 2px；spark 320ms 后移除；
- reduced-motion 下 .ambient span animation-name 为 none。

【3.3 回归】
- node tests\frontend.test.mjs：4/4；
- 既有 browser.cjs / browser-advanced.cjs / glass-browser.cjs / polish.json：51 项全部通过；
- 控制台 0 异常；无未捕获 Promise；
- git diff 只包含允许文件（+ room-stage.js/css、index.html、app.js、styles/glass 的追加规则、测试）；
- 不修改后端、数据库、README 业务边界。

【3.4 性能预算】
- 拖拽/转场只允许 transform/opacity；无 layout；
- 视差最多 2 个层；滚动停止 120ms 后取消 rAF；
- warp 720ms 后取消全部 rAF；clone 移除；
- 移动端关闭 backdrop-filter、倒影、鼠标视差；
- 不引入 WebGL；Canvas Spark 一次性，DPR≤2。

【3.5 完成定义】
- Phase 1 计算样式与行为符合上述契约；
- Phase 2 的 5 个交互全部可用，且 reduced-motion 有降级；
- 新增测试全绿，既有测试全绿；
- 输出：文件清单、关键实现说明、测试命令与输出、性能记录；
- 任何未实现项必须明确列出，不要用“基本完成”糊过去。

【禁止】
- 不要用视觉稿替代实现与验收；
- 不要用 React Bits 源码、React、GSAP、three/ogl；
- 不要伪造数据、照片、房间、统计；
- 不要用 transition: all、不要动画 width/height；
- 不要给卡片/抽屉加大面积 blur；
- 不要让 3D/视差在 reduced-motion 或移动端继续运行；
- 不要破坏现有 dialog 焦点、表单草稿、错误重试、版本冲突语义。
```

---

## 说明

- 这份提示词不依赖视觉稿：Phase 1 用令牌、组件契约、动效表和计算样式验收；Phase 2 用 DOM/几何/时间线/测试验收。
- 如果执行模型拿不到仓库，按「数据契约」用 mock 数据实现；拿到仓库则复用现有 `state.data.points`、`setFilters`、`openDetail`，不要另建一套状态。
- React Bits 只作为视觉与机制参考，路径已写入；项目仍是原生 JS，不安装、不复制源码。
