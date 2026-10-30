# 日间玻璃工作台 · 完整实现提示词（当前页面 + 后续动效）

> 把下面这一个代码块完整交给执行 AI 即可。它先复刻当前「日间玻璃巡检工作台」，再在同一套视觉上追加「旋转木马选房 + 穿梭 + 视差 + Spark」。
>
> 本轮只写提示词，不修改任何产品代码。

---

```text
你是一名资深前端设计工程师，在 D:\校园设施巡检与复核 这个仓库工作。
项目是原生 HTML/CSS/JS（ES Modules，无前端构建、无 npm 依赖）+ FastAPI 的单页巡检工作台。

请先读：
AGENTS.md、README.md、frontend/index.html、frontend/styles.css、frontend/glass.css、
frontend/motion.css、frontend/motion.js、frontend/filter-pickers.js、frontend/app.js。
再看参考截图：
docs/evidence/glass-ui-2026-10-29/live-1440.png、live-picker-1440.png、live-390.png、live-picker-390.png。

【总目标】
分两阶段完成：
Phase 1：复刻当前「日间玻璃 · 校园巡检工作台」的全部页面、色彩、状态与动效。
Phase 2：在同一套视觉上追加：
  1) 首页 3D 旋转木马选房；
  2) 选中房间后木马快速定位到该房间，并联动下方列表；
  3) 点击「进入巡查」有穿梭（warp）转场；
  4) 页面滚动有克制视差；
  5) 点击有 Spark 反馈。
如果仓库里已经是 glass 版本（存在 frontend/glass.css 与上述截图），Phase 1 只做核对，不要重写；直接做 Phase 2。

【硬约束】
- 不引入 React、GSAP、ogl、three、React Bits 或任何 npm 依赖；不复制第三方源码。
- 不改后端接口、数据库、业务状态机；不伪造房间、照片、记录或统计数字。
- 房间数据只来自现有 state.data.points（C01–C08）；没有照片就用渐变/线框占位，不画假照片。
- 只动画 transform / opacity / clip-path；不动画 width/height/top/left/margin。
- 不给大面积元素加 backdrop-filter；只有顶栏、侧栏、选择浮层、toast 这类小面积元素可用。
- 新增动效必须接入现有 data-motion / data-feedback / prefers-reduced-motion 策略；移动端降低或关闭 3D/视差。
- 现有 4 项前端单元检查、51 项浏览器检查必须继续通过；新增交互补测试。
- 新控件必须有键盘路径、可见焦点、aria 名称；不能把焦点丢在不可见层。
- 用户输入用 textContent，不拼 HTML；不引入远程字体、图片或图标库。

====================================================================
Phase 1 · 当前页面复刻
====================================================================

【页面结构】
1. 顶部 sticky header（高约 96px）：
   - 左：折角巡检标记 SVG（36×36，stroke 1.5）+ 标题「校园设施巡检与复核」。
     标题 9 个汉字，每个字由前后两面组成（front 0°、back -90°，translateZ .55em），
     悬停/首次进入逐字 3D 翻转 800ms cubic-bezier(.16,1,.3,1)，每字延迟 24ms，1.1s 后复位。
   - 右：界面动效开关（checkbox）、连接状态「本地服务已连接 · 每 30 秒刷新」、最后更新时间、
     刷新按钮、生成运行判断主按钮。按钮 44px 高。
2. 三栏 app-shell：
   - max-width 1800px；grid-template-columns 180px minmax(0,1fr) 280px；
   - gap 28px；padding 34px 28px 28px；align-items:start；
   - 左栏/右栏 sticky top 124px。
   - 左栏：楼栋与楼层导航（全部空间 8、教学楼 3、二层 Z1 3、实训楼 5、一层 Z2 3、二层 Z3 2）、
     现场留存提示、教学演练声明。
   - 中栏：巡检概览 → 3 格统计 → 点位覆盖示意 → 巡检点位标题/计数 → 筛选工具条 →
     按楼层分组的点位卡片。
   - 右栏：待处理（C01、C02、C04、C05、C07、C08 待补现场记录）→ 最近运行记录（最多 5 条）。
3. 详情抽屉（右侧 520px、全高）：标题/副标题/关闭；当前情况三行状态；
   填写现场记录/发起复核按钮；现场照片网格；现场证据与记录时间；复核处理记录。
4. 照片预览 dialog、运行判断 dialog、toast。
5. 首屏 skeleton：3 组，每组 2–3 张 skeleton 卡。

【视觉令牌】
- 页面底：#e6eff3（glass.css 覆盖；基础 --paper #f3f6f5）。
- 主文字 #0f202b；次级 #334a5a；辅助/时间 #405462；
- 发丝线 rgba(15,32,43,.10)；强调线 rgba(15,32,43,.18)；
- 主色 teal #0f766e；次色 sky #0284c7；告警 amber #b45309；危险 rose #be123c；正常 green #15803d；
- 玻璃边 rgba(63,139,159,.26)；高光 rgba(255,255,255,.96)；
- 字体：PingFang SC / Microsoft YaHei / Noto Sans CJK SC / system-ui；
  等宽：Cascadia Mono / Consolas；
- 圆角：卡片 14–15px；按钮 8–10px；概览 16px；浮层 16px；
- 字号：正文 14px；卡片设备名 16px；概览大数字 34–44px；标题 32px；
- 断点：1250 / 1100 / 767 / 580 / 320。

【环境层】
- fixed 全屏、z-index:0、pointer-events:none；
- 3 个 70–78vmax 径向色场：
  1) #95cae5/.84，左上，72s；
  2) #a1ddda/.78，右上，88s；
  3) #c3d2eb/.76，底部，96s；
- 动画只改 transform：translate3d + scale，ease-in-out infinite alternate；
- 上面叠 64px 网格 rgba(15,32,43,.06) 1px，向下淡出，opacity .32；
- 内容区域（header、app-shell）z-index 1 以上；环境层不拦截点击。

【顶栏玻璃】
- position:sticky; top:0; z-index:10；
- 背景 rgba(247,253,255,.68)；blur(18px) saturate(1.25)；
- 底部 1px 白高光 + 青→蓝渐变发丝线；
- 连接状态、时间、按钮的层级不变。

【左右栏玻璃】
- 背景 linear-gradient(145deg, rgba(255,255,255,.76), rgba(239,250,252,.53))；
- 1px 白边 + outline rgba(91,147,165,.13)；
- blur(12px)；圆角 14px；阴影 0 15px 34px rgba(41,82,101,.08)；
- 左栏 padding 20px 14px；右栏 padding 14px 18px；
- ≤1100 左栏 display:none，右栏移到下方；≤767 关闭 blur。

【概览】
- summary-strip：3 列 1.15fr 1fr 1fr；
- 背景 linear-gradient(120deg, rgba(255,255,255,.91), rgba(243,252,253,.69))；
- 1px 白边 + outline glass edge；内高光 + 0 12px 30px rgba(44,91,111,.09)；
- 3 个 summary-cell，数字 34–44px，等宽数字；待补检是按钮，hover 浅 teal 底；
- 底部有一条 glass-trace：22% 宽、1px、teal→白→透明，8s 循环从左到右；
- 覆盖条 8 个等宽节点：正常 #dceee7/teal，缺失 #fff2df/amber，普通白 .56；
  中间一条渐变连接线；节点 6px 圆角。

【筛选工具条】
- 搜索框 46px；楼栋/楼层、类型、状态三个 picker 触发器 46px；
- 重置 ghost；网格/列表分段开关：外层玻璃，thumb 240ms 滑动；
- picker 触发器：白 .93→.68 渐变、1px rgba(95,148,169,.36)、10px 圆角；
  chevron 180ms 旋转；[aria-expanded=true] teal 边 + 3px 光环。
- 选择浮层：326px 宽、16px 圆角、白 .94→.89 渐变、blur(22px)、20/56 深阴影；
  打开 180ms 自上而下 + 轻微缩放；内含标题、副标题（楼栋/楼层/点位数量）、搜索框、
  整栋/单层行、数量、勾选、底部说明、关闭按钮；
  支持方向键、Home/End、Enter、Esc、Tab、焦点返回、外部点击关闭、短视口滚动。

【点位卡片】
- 3 列 → ≤1250 2 列 → ≤1100 2 列 → ≤580 1 列；gap 18px；
- 背景 linear-gradient(135deg, rgba(255,255,255,.91), rgba(245,252,254,.72) 55%, rgba(229,242,247,.64))；
- 1px 白边 + outline rgba(84,137,158,.19)；15px 圆角；内高光 + 0 8px 22px rgba(35,79,99,.065)；
- 右上/左下折角细线 SVG（.glass-corners，inset 8px，teal .55）；
- hover 上移 2px、teal 边、阴影 0 14px 30px rgba(35,79,99,.12)；
  指针位置 240px 径向聚光 rgba(2,132,199,.13)；
- 内容：C01 等宽编号 + 必检/普通标签；设备名 16px 600；位置 12px；
  三行状态（现场覆盖/设施状态/复核处理）；记录时间/照片数；
  底部「查看详情 / 现场记录」两个按钮。
- 徽标：good #dceee2/#116b34；warn #fff0d9/#9a4a06；danger #fbe4e8/rose；
  muted #e7edec；info #dcecf4/#036a9b。
- 列表视图：单列，卡片 grid 三列（身份/状态/操作），与网格视图同一批节点。

【弹层与反馈】
- 详情/照片/运行均用原生 dialog.showModal()；焦点陷阱；Esc 关闭；关闭后焦点回到触发元素。
- 详情抽屉 520px；照片/运行居中弹窗；backdrop rgba(15,32,43,.32)。
- toast 右下，白 .82 + blur(10px)，6.5s；保存/刷新/失败文案保持现有语义。
- 点击：所有可点控件 ui-pressed scale(.97) 120ms；
  指针位置 26px 圆环、2px teal、520ms linear（opacity 1→0，scale .3→2.1）；
  键盘 Enter 在中心触发；reduced-motion 不显示环。
- 筛选：显式筛选用 FLIP 280ms；搜索输入不动画；结果计数 180ms 淡入。
- 视图切换：thumb 240ms；卡片 View Transition 320ms（逐卡 view-transition-name，
  重写 keyframes 做宽高/位移插值；root 不做交叉淡入）。
- 弹层：dialog 180ms 淡入 + body 220ms 位移淡入；picker 180ms；
  加载按钮 aria-busy 旋转环 800ms。
- 标题/拖尾：标题翻转见上；拖尾 Canvas2D，teal→sky，24 点/115px，空闲 250ms 停止，
  只在 hover:hover + pointer:fine；弹层/选择浮层/按下/选中/滚动/隐藏页面时停止。

【状态、无障碍、响应式】
- 加载 skeleton；空状态；错误重试；禁用；保存中；脏表单 confirm；403/409；照片失败。
- skip link；focus-visible 2px teal；aria-live；dialog 焦点陷阱；触屏 44px 最小点击区。
- data-motion / data-feedback：关闭时暂停背景、标题、拖尾、点击环、按压、VT。
- prefers-reduced-motion：环境层 animation:none；点击环 display:none；VT 取消；过渡归零。
- 响应式：≤1250 三栏两列；≤1100 单栏、左栏隐藏、右栏下移；≤767 两列；
  ≤580 单列、概览紧凑、抽屉全屏、picker 宽度适配；320px 无横向溢出。

====================================================================
Phase 2 · 追加 React Bits 动效
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

【2.1 首页 3D 旋转木马选房】
位置：header 与 .app-shell 之间新增
<section id="room-stage" class="room-stage" aria-labelledby="room-stage-title">…</section>
不要塞进三栏网格。

结构：
- 标题行：h2「选择巡查空间」+ 说明「拖动、滚轮或按 ← → 选择；点击进入巡查」+
  右侧计数 03 / 08（等宽）。
- #room-carousel：
  role="region" aria-roledescription="carousel" aria-label="巡查房间" tabindex="0"
  > .room-viewport > .room-ring > 8 个 button.room-card[data-point="C01"…]
- 左右箭头按钮 44px（aria-label 上一个/下一个房间）。
- 选中摘要：房间名、楼栋/楼层、必检/普通、现场覆盖/设施状态、最近记录时间。
- 主按钮「进入巡查」。

卡片（只用真实数据）：
- 顶部：C01 · 必检点；
- 中部：设备名，16–18px；
- 位置：教学楼 · 二层 / Z1；
- 状态：现场覆盖（有效/缺少）、设施状态（正常/告警/未知）、复核（待处理/未发起）；
- 有 photos[0].url 用真实照片；无照片用浅青渐变 + 折角线 + 大号 C01，不画假房间。

3D：
- .room-viewport { perspective:1800px; height:380px; }
- .room-ring { transform-style:preserve-3d; transition: transform 520ms cubic-bezier(.16,1,.3,1); }
- .room-card { position:absolute; width:236px; height:302px; transform-style:preserve-3d; }
- 8 张卡，45°/张；半径 ≈ max((236+26)/(2*sin(π/8)), 236*0.6) ≈ 342px；
- 每张：rotateY(index*45deg) translateZ(342px)；环形整体 rotateY(-active*45deg)；
- 中心 scale 1 / opacity 1；两侧 .82 / .55；再外 .68 / .28；背面隐藏；
- 桌面可选 1px 倒影（-webkit-box-reflect 或镜像伪元素），移动端关闭；
- 环形背后一层柔光 radial teal/sky，不遮文字。

交互：
- pointerdown/move/up 拖拽旋转，5px 阈值、pointer capture、惯性、释放吸附到最近 45°；
- 只接管横向 deltaX；纵向滚动仍归页面；
- 键盘 ←/→、Home/End、Enter/Space；焦点环可见；
- 点击任意卡：先 focusRoom(index) 居中，再更新摘要；已居中的卡再点击 → 进入巡查；
- 默认不自动旋转；首次进入只做一次 1.2s rise；鼠标移动 ±3° 视角；
- 触摸横向滑动，纵向交给页面；≤767 改为横向 scroll-snap（卡宽 180–200px），
  选中卡 scrollIntoView({inline:'center'})；隐藏倒影和鼠标视差。

选中联动：
- focusRoom(index) 520ms 转正 → aria-live「已选择 C07 网络交换节点」→ 更新摘要；
- 调 setFilters({query:point.point_id, scope:'all', required:'all', status:'all'})，
  下方列表收敛到该房间；保留「全部空间」恢复入口；
- 用户在搜索框输入 C07，或楼层 picker 选中 Z3 时，自动 focusRoom 到对应房间；
- 用 state.roomSync 防止循环触发；滚动到点位区用 smooth（reduced 时 auto）。

React Bits Circular Carousel 参考参数（按房间卡改）：
preset cylinder；cardWidth 236；aspectRatio .78；gap 26；tilt -6；perspective 1800；
curve 1；spread 1；billboard false；backfaces false；
autoplay off；draggable true；momentum .6；snap true；focusOnClick true；
parallax .3；stretch .5；depthFade .55；cornerRadius 14；captions false。

【2.2 穿梭 warp】
触发：选中房间的「进入巡查」、点击已居中的卡、键盘 Enter；不要每个按钮都触发。

720ms 时间线：
- 0–80ms：插入 #warp-layer（fixed inset:0，pointer-events:none，z-index:80，aria-hidden），
  10–12 条 teal/sky 光线从中心向外 + 中心白青闪光；
- 80–520ms：clone 选中卡（cloneNode(true)，去 id/按钮），
  从 getBoundingClientRect() 用 WAAPI 缩放到全屏
  （transform + border-radius 14→0 + opacity 1），cubic-bezier(.16,1,.3,1)；
  隧道从 scale(.6) 到 1.6、opacity 0→.85→0；
- 520–620ms：warp 层淡出；clone 保持全屏 120ms；
- 620ms：调用 openDetail(point_id, 'inspect')；焦点进入抽屉；移除 warp 层。

视觉：
- 隧道用 repeating-conic-gradient 或 12 个绝对定位 1px 光线 span
  （高 40vmax，linear-gradient(transparent, rgba(15,118,110,.55), transparent)），
  从中心向外 translate + scaleY；
- 中心 radial：rgba(255,255,255,.75) → rgba(2,132,199,.18) 30% → transparent 62%；
- 颜色只用 teal/sky/白；不要紫、不要黑屏、不要全屏 blur。

降级：
- prefers-reduced-motion 或 data-motion=off：直接 openDetail，最多 180ms 淡入；
- state.warping 防重复点击；clone 设 aria-hidden；warp 层移除后焦点在抽屉关闭按钮/首个表单控件；
- 关闭抽屉反向 360ms 缩回可选，但不能闪白。

Lightfall 参考（只作视觉，不引 WebGL）：
lightMode true；colors ['#0f766e','#0284c7','#ffffff']；speed .4；
streakCount 2；streakWidth .8；zoom 3.1；glow 1；density .6；bloom .35；
opacity .9；holdToWarp false；intro true；fade .2。

【2.3 视差滚动】
只三档：
- .ambient 滚动 -0.04（最多 ±40px）；
- 选房 stage 滚动 -0.10（最多 ±48px）；
- 概览/卡片不逐帧位移，用 IntersectionObserver 一次性 16px→0 + opacity .94→1，
  stagger 40ms，最多 8 张。

实现：
- passive scroll + rAF 节流，只读 scrollY，写 --parallax-ambient / --parallax-stage；
- CSS translate3d(0, var(--parallax-ambient), 0)；
- 不要 background-attachment:fixed；不要在 scroll 里读 layout；
- 页面隐藏、reduced-motion、data-motion=off、≤767 时停止并清零；
- 不给每张卡加 scroll 监听；will-change 只在拖拽/转场期间加，结束移除。

【2.4 点击 Spark】
- 只在「进入巡查」和选房卡点击时触发；
- 8–12 条 1px 光线，28–44px，320ms ease-out，teal/sky/白；
  Canvas2D 一次性或 CSS span，结束移除；
- 其他控件保留现有 26px 点击环；不要叠加两个全屏效果；
- reduced-motion 完全不创建。

【2.5 视觉美化】
- 选房 stage 用玻璃框：1px 白边 + glass edge 外描边 + 18/60 阴影 +
  底部青→蓝渐变光；背景 radial 柔光，不遮文字；
- 卡片 14px 圆角、白高光、底部 1px 分隔；中心卡比两侧多一层 0 8 30 阴影；
- 标题 h2 22–24px，说明 12px muted，计数等宽；
- 沿用 teal/sky/白玻璃；不要引入新主色；
- 页面阅读顺序仍是「概览 → 点位」；选房 stage 是入口，不替代概览。

【2.6 集成点】
- 新文件：frontend/room-stage.js、frontend/room-stage.css；
  index.html 引 CSS，app.js import initRoomStage。
- initRoomStage({
    getPoints: () => state.data?.points || [],
    onEnter: point => openDetail(point.point_id, 'inspect'),
    onSelect: point => setFilters({query:point.point_id,scope:'all',required:'all',status:'all'})
  });
- 不修改 filter-pickers.js 的原生 select 逻辑；不在 carousel 里维护第二套筛选状态；
- 不改 dialog.showModal() 的同步时序；warp 在 openDetail 前完成；
- 不新增后端接口、不改数据。

====================================================================
验收
====================================================================
- 1440：8 张卡成 3D 环；拖拽/滚轮/左右键可转；点击先居中再进入；
  720ms 穿梭后打开详情抽屉；无闪白、无错位。
- 768/390：无横向溢出；≤767 横向 scroll-snap；触摸可滑；不阻断纵向滚动。
- 选中 C07 后列表只剩 C07；搜索 C07 时 carousel 自动转正；无循环触发。
- reduced-motion：3D 停止、warp 降级、视差为 0、Spark 不出现。
- 键盘：Tab 到 carousel/箭头/卡片/进入巡查；←/→/Home/End/Enter 可用；
  焦点不被 warp 吞掉。
- 性能：无 WebGL；warp 的 rAF 720ms 后 cancel；移动端无 backdrop-filter；
  连续拖拽 60fps（真机确认）。
- 回归：4/4 单元 + 51 项浏览器检查通过；新增 carousel/联动/warp/reduced-motion 测试。
- 不伪造任何房间、照片、记录或统计。

【交付】
- 1440/390 改造前后截图；
- 选房、穿梭、视差关键帧或短视频；
- 新增测试与运行结果；
- git diff --stat；
- 说明采用了哪些 React Bits 参考、拒绝了哪些（如 Hyperspeed/Pixel Transition）。
不要只说“已完成”，用截图、命令输出和性能记录证明。
```

---

## 使用说明

- **只复刻当前页面**：只执行 Phase 1，Phase 2 跳过；Phase 1 的验收就是 `docs/evidence/glass-ui-2026-10-29` 的截图与 51 项检查。
- **只加新动效**：确认仓库已是 glass 版后，执行 Phase 2；不要重写 Phase 1。
- **React Bits 关系**：两段录屏分别是 Circular Carousel 与 landing page 全屏展示；本项目是原生 JS，提示词要求“借机制、原生重写”，不安装 React Bits。
- **不修改当前代码**：本轮只产出这份提示词；真正执行时再按 Phase 1/2 改代码。
