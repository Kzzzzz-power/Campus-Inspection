# 校园设施巡检与复核 · 页面复刻 + React Bits 动效提示词

> 依据：2026-10-29 当前工作区源码与 `docs/evidence/glass-ui-2026-10-29/` 的 1440/390 实机截图；两段 React Bits 录屏（`2026-10-29 200940.mp4`、`201115.mp4`）。
> 本轮只写提示词，**不修改任何产品代码**。
>
> 用法：
> - **A** = 把当前页面完整复刻给另一个 AI 的提示词；
> - **B** = 在当前页面上追加「旋转木马选房 + 穿梭 + 视差」的提示词；
> - **C** = 验收提示词。
>
> B 依赖 A 的页面与视觉基线；如果执行模型已经拿到本仓库，直接把 A 换成“先读仓库现有文件”即可。

---

# A. 当前页面复刻提示词

```text
你在 D:\校园设施巡检与复核 工作。这是一个原生 HTML/CSS/JS（ES Modules，无前端构建、无 npm 依赖）+ FastAPI 的单页巡检工作台。
请先读 AGENTS.md、README.md、frontend/index.html、frontend/styles.css、frontend/glass.css、frontend/motion.css、frontend/motion.js、frontend/filter-pickers.js、frontend/app.js。

【目标】
复刻当前「日间玻璃 · 校园巡检工作台」的全部页面结构、视觉、动态效果与交互状态。
不要改业务语义、接口、数据库与文案；不要引入 React、GSAP、React Bits 或任何 npm 依赖。

【技术栈与文件】
- index.html：页面骨架、header、三栏、三个 dialog、toast、ambient 装饰层。
- styles.css：基础布局、组件、响应式、动效与无障碍策略（534 行）。
- glass.css：玻璃主题覆盖（浅蓝青、折角细线、概览底部光线、选择浮层、手机紧凑间距）。
- motion.css：品牌标题 3D 逐字翻转、Canvas 拖尾。
- motion.js：动效偏好、标题翻转、拖尾、背景暂停策略。
- app.js：数据拉取、筛选、卡片渲染、详情、现场记录、复核、运行判断、视图切换、点击反馈、滤镜浮层集成。
- filter-pickers.js：把原生 select 增强为可搜索的楼栋/楼层浮层。

【页面结构】
1. 顶部 sticky header（高约 96px）：
   - 左侧：折角巡检标记 SVG + 9 个汉字的标题「校园设施巡检与复核」，每个字由前后两面组成，逐字 3D 翻转。
   - 右侧：界面动效开关、连接状态（本地服务已连接 · 每 30 秒刷新）、最后更新时间、刷新按钮、生成运行判断主按钮。
2. 三栏 app-shell（最大 1800px，180px / 1fr / 280px，gap 28px，padding 34px 28px）：
   - 左栏：楼栋与楼层导航（全部空间/教学楼/各楼层，带数量）、现场留存提示、教学演练声明；sticky top 124px。
   - 中栏：巡检概览（标题、说明、45 分钟窗口、覆盖规则、教学演练标签）→ 三格统计（已覆盖必检点 0、待补检 6、必检点总数 6）→ 点位覆盖示意（8 个 C01–C08 节点）→ 巡检点位标题/计数 → 筛选工具条（搜索、楼栋楼层 picker、点位类型、状态、重置、网格/列表切换）→ 按楼层分组的点位卡片。
   - 右栏：待处理列表（C01、C02、C04、C05、C07、C08 等待补记录）→ 最近运行记录（最多 5 条）；sticky top 124px。
3. 详情抽屉：右侧 520px、全高、标题/副标题、关闭按钮、当前情况三行状态、填写现场记录/发起复核按钮、现场照片网格、现场证据与记录时间、复核处理记录。
4. 照片预览 dialog、运行判断 dialog、toast。
5. 首屏 skeleton：3 个分组、每组 2–3 张 skeleton 卡片。

【视觉令牌】
- 页面底：glass.css 覆盖为 #e6eff3；纸白基调来自 styles.css 的 --paper #f3f6f5。
- 主文字 #0f202b；次级 #334a5a；辅助/时间 #405462；发丝线 rgba(15,32,43,.10)；强调线 rgba(15,32,43,.18)。
- 主色 teal #0f766e；次色 sky #0284c7；告警 amber #b45309；危险 rose #be123c；正常 green #15803d。
- 玻璃边 rgba(63,139,159,.26)；高光 rgba(255,255,255,.96)。
- 字体：PingFang SC / Microsoft YaHei / Noto Sans CJK SC / system-ui；等宽 Cascadia Mono / Consolas。
- 圆角：卡片 14–15px；按钮 8–10px；浮层 16px；概览 16px。

【玻璃层次】
- 环境层：fixed 全屏、3 个 70–78vmax 的径向色场（蓝 #95cae5/.84、青绿 #a1ddda/.78、淡紫 #c3d2eb/.76），分别 72s/88s/96s 缓慢漂移（translate3d + scale，alternate）；上面叠 64px 网格 rgba(15,32,43,.06)，向下淡出；整体不拦截点击。
- 顶栏：rgba(247,253,255,.68)，blur 18px saturate 1.25，底部 1px 白色高光 + 青→蓝渐变发丝线。
- 左右栏：白→浅青渐变 .76/.53，1px 白边 + 外描边，blur 12px，15–34px 双层阴影；移动端关闭 blur。
- 概览条：白 .91→.69 渐变，1px 白边 + glass edge 外描边，内高光 + 12/30 阴影；底部有一条 8s 循环的 glass-trace 光线。
- 点位卡片：135° 白 .91→.72→.64 渐变，1px 白边 + 外描边，15px 圆角，内高光 + 8/22 阴影；右上/左下折角细线 SVG（.glass-corners），hover 上移 2px、边框 teal、阴影加深，指针位置 240px 径向聚光。
- 选择浮层：326px 宽、16px 圆角、白 .94→.89 渐变、blur 22px、20/56 深阴影，打开 180ms 自上而下 + 轻微缩放。
- 输入/按钮：白 .64–.93 玻璃；主按钮 #197c86→#146871 渐变、白字、内高光 + 5/14 阴影。

【组件与状态】
- 统计：大数字 34–44px，等宽数字；待补检是按钮，hover 有浅 teal 底。
- 覆盖节点：8 个等宽胶囊，正常 #dceee7/teal，缺失 #fff2df/amber，普通点白 .56；下方有一条渐变连接线。
- 卡片：左上 C01 等宽编号 + 必检/普通标签；设备名 16px 600；位置 12px；三行状态（现场覆盖/设施状态/复核处理）用浅色底徽标；底部记录时间/照片数 + 查看详情/现场记录。
- 徽标：good #dceee2/#116b34，warn #fff0d9/#9a4a06，danger #fbe4e8/rose，muted #e7edec，info #dcecf4。
- 工具条：搜索框 46px、picker 触发器 46px、重置 ghost、网格/列表分段开关（thumb 240ms 滑动）。
- 浮层：搜索楼栋/楼层、整栋/单层行、数量、勾选、方向键/Home/End/Enter/Esc/Tab、焦点返回、外部点击关闭、短视口滚动。
- 详情：原生 dialog.showModal()，焦点陷阱，Escape 关闭，关闭后焦点回到触发元素；未保存内容关闭前 confirm。
- 运行判断/照片：同为原生 dialog；照片支持上一张/下一张、键盘左右、加载失败文案。
- 空状态/错误/加载：skeleton、错误重试、toast 6.5s。

【动态效果清单】
- 标题：悬停/首次进入 3D 逐字翻转 800ms cubic-bezier(.16,1,.3,1)，每字延迟 24ms；1.1s 后复位；reduced-motion 关闭。
- 鼠标拖尾：Canvas2D，teal→sky 渐变，24 点/115px，空闲 250ms 停止；只在 hover:hover + pointer:fine；弹层/选择浮层/按下/选中/滚动/隐藏页面时停止。
- 背景：3 个色场 72/88/96s；glass-trace 8s；data-motion=off 时暂停。
- 点击：所有可点控件 ui-pressed scale(.97) 120ms；指针位置 26px 圆环 520ms（opacity 1→0，scale .3→2.1）；键盘 Enter 在中心触发；reduced-motion 不显示环。
- 筛选反馈：显式筛选用 FLIP 280ms；搜索输入不动画；结果计数 180ms 淡入。
- 视图切换：thumb 240ms；卡片 View Transition 320ms（逐卡 view-transition-name，重写 keyframes 做宽高/位移插值；root 不做交叉淡入）。
- 弹层：dialog 180ms 淡入 + body 220ms 位移淡入。
- 选择浮层：picker-open 180ms。
- 加载按钮：aria-busy 旋转环 800ms。
- 所有动效受 data-motion / data-feedback / prefers-reduced-motion 控制。

【交互与无障碍】
- 跳转链接、focus-visible 2px teal 外框、aria-live 状态、dialog 焦点陷阱、Escape、焦点返回。
- 搜索/筛选/视图切换/详情/记录/复核/运行历史全部走真实接口；用户输入用 textContent，不拼 HTML。
- 触屏 44px 最小点击区；hover 效果只在精确指针启用。
- 响应式：>1250 三栏三列卡片；1101–1250 三栏两列；≤1100 单栏、左栏隐藏、右栏移到下方；≤767 两列；≤580 单列、概览紧凑、抽屉全屏；320px 无横向溢出。
- 状态：加载、空、错误、禁用、保存中、脏表单、403/409、照片失败。

【验收】
- 1440/390 截图与 docs/evidence/glass-ui-2026-10-29 的 live-1440/live-390 一致（允许数据变化）。
- 全部 51 项浏览器检查与 4 项前端单元检查通过；控制台 0 异常。
- 不新增依赖、不改后端、不改文案、不伪造数据/照片。
```

---

# B. 追加 React Bits 动效的提示词

> 参考录屏解读：
> - `2026-10-29 200940.mp4` = React Bits **Circular Carousel**（3D 环形、卡片可弯、拖拽/惯性/吸附、点击聚焦）的实机演示。
> - `2026-10-29 201115.mp4` = React Bits 的 landing page 展示（点击卡片进入全屏场景、带关闭、拖拽揭示）。
> - 本项目是原生 JS：**只借视觉与交互机制，不安装 React Bits、不复制源码**。

```text
你在 D:\校园设施巡检与复核 工作。先按 A 的提示词确认当前页面基线，再执行本提示词。
目标：在不破坏现有业务、文案、接口与 51 项浏览器回归的前提下，把当前玻璃工作台升级为「可穿行的巡检空间」：
1) 首页新增 3D 旋转木马选房；
2) 选中房间后旋转木马快速定位到该房间，并联动筛选；
3) 点击「进入巡查」有穿梭（warp）转场；
4) 页面滚动有克制的视差；
5) 点击有 Spark 反馈；
6) 参考 React Bits 的 Circular Carousel / Lightfall / ClickSpark / Circular Gallery，但全部用原生 CSS/JS 重写。

【硬约束】
- 不引入 React、GSAP、ogl、three、React Bits 或任何 npm 依赖；不复制第三方源码。
- 不改后端接口、数据库、业务状态机；不伪造房间、照片、记录或统计数字。
- 房间数据只来自现有 state.data.points（C01–C08）；没有照片时用渐变/线框占位，不伪造照片。
- 只动画 transform / opacity / clip-path；不动画 width/height/top/left/margin；不给大面积元素加 backdrop-filter。
- 新增动效必须接入现有 data-motion / data-feedback / prefers-reduced-motion 策略；移动端降低或关闭 3D/视差。
- 现有测试（frontend.test.mjs、browser.cjs、browser-advanced.cjs、glass-browser.cjs、polish.json）必须继续通过；新增交互要补测试。
- 所有新控件有键盘路径、可见焦点、aria 名称；不能把焦点丢在不可见层。

【参考路径（只作视觉/机制参考，不安装）】
- 3D 环形选房：https://reactbits.dev/components/circular-carousel
- 环形画廊/点击全屏：https://reactbits.dev/components/circular-gallery
- 纵深轮播：https://reactbits.dev/components/depth-carousel
- 光隧道/穿梭：https://reactbits.dev/backgrounds/lightfall
- 高速光轨：https://reactbits.dev/backgrounds/hyperspeed
- 点击火花：https://reactbits.dev/animations/click-spark
- 全屏像素转场：https://reactbits.dev/animations/pixel-transition
- 滚动叠卡/视差参考：https://reactbits.dev/components/scroll-stack
- 滚动显影参考：https://reactbits.dev/text-animations/scroll-reveal
- Pro 视差轮播（只看理念，不要求 Pro）：https://pro.reactbits.dev/docs/components/parallax-carousel
- Pro 纵深画廊（只看理念）：https://pro.reactbits.dev/docs/components/dolly-gallery

【参考参数（来自 React Bits Circular Carousel 的公开 props，按房间卡片改）】
preset: 'cylinder'（8 张卡，45° 一张）
cardWidth: 236, aspectRatio: 0.78（约 236×302）
gap: 26, tilt: -6, perspective: 1800
curve: 1, spread: 1, billboard: false, backfaces: false
autoplay: 'off'（默认不自动旋转；首次进场可 'rise' 1.4s）
draggable: true, momentum: 0.6, snap: true, focusOnClick: true
parallax: 0.3（鼠标 ±3° 视角，不要更大）
stretch: 0.5, depthFade: 0.55, cornerRadius: 14
captions: false（房间信息用卡片本身，不用底部 caption）
半径公式（8 张）：radius = max((cardWidth + gap) / (2 * sin(π/8)), cardWidth * 0.6) ≈ 342px；
每张卡：rotateY(index * 45deg) translateZ(radius)；环形整体 rotateY(-active * 45deg)。
中心卡：scale 1、opacity 1、z-index 2；两侧：scale .82、opacity .55；再外侧：scale .68、opacity .28；背面隐藏。
参考 Lightfall 的穿梭参数：lightMode: true、colors ['#0f766e','#0284c7','#ffffff']、speed .4、streakCount 2、streakWidth .8、zoom 3.1、glow 1、density .6、bloom .35、opacity .9、holdToWarp false、intro true、fade .2；**不要真的引 WebGL**，用 CSS/Canvas2D 光线隧道近似。

【B1. 新增“选择巡查空间”旋转木马】
1. 位置：在 header 与 .app-shell 之间新增
   <section id="room-stage" class="room-stage" aria-labelledby="room-stage-title">…</section>
   不要塞进现有三栏网格，避免挤压概览。
2. 结构：
   - 标题行：h2「选择巡查空间」+ 说明「拖动、滚轮或按 ← → 选择；点击进入巡查」+ 右侧计数 03 / 08（等宽字体）。
   - #room-carousel（role="region" aria-roledescription="carousel" aria-label="巡查房间" tabindex="0"）
     > .room-viewport > .room-ring > 8 个 button.room-card[data-point="C01"…]
   - 左右箭头按钮（44px，aria-label 上一个/下一个房间），移动端显示。
   - 选中房间摘要（右侧或下方）：房间名、楼栋/楼层、必检/普通、现场覆盖/设施状态、最近记录时间；不新增假字段。
   - 主按钮「进入巡查」→ 触发 B2 穿梭。
3. 卡片内容（只用真实数据）：
   - 顶部：C01 · 必检点
   - 中部：设备名（如“照明控制”），16–18px
   - 位置：教学楼 · 二层 / Z1
   - 状态：现场覆盖（有效/缺少）、设施状态（正常/告警/未知）、复核（待处理/未发起）
   - 有照片时：photos[0].url 作为卡片顶部 4:3 图；无照片时：浅青渐变 + 折角线 + 大号 C01，不画假房间。
4. 3D 实现：
   - .room-viewport { perspective: 1800px; height: 380px; }
   - .room-ring { transform-style: preserve-3d; transition: transform 520ms cubic-bezier(.16,1,.3,1); }
   - .room-card { position:absolute; width:236px; height:302px; transform-style:preserve-3d; }
   - 每张卡由 JS 写 transform；中心卡额外 .is-active。
   - 卡片底部可选 1px 倒影（-webkit-box-reflect 或镜像伪元素）；只在桌面启用，移动端关闭。
   - 环形背后加一层柔光（radial teal/sky），不遮卡片文字。
5. 交互：
   - pointerdown/move/up：拖拽旋转，pointer capture，阈值 5px；释放按速度吸附到最近 45°。
   - wheel：只接管横向 deltaX（或 shift+滚轮），阻止页面纵向滚动；纵向滚动仍归页面。
   - 键盘：←/→ 上一/下一，Home/End 首/尾，Enter/Space 进入巡查；焦点环可见。
   - 点击任意卡片：先调用 focusRoom(index) 让该卡转到中心，再更新摘要；如果点击的是已经居中的卡，则触发 B2。
   - 触摸：横向滑动旋转，纵向滑动交给页面；不阻断页面滚动。
   - 不自动旋转；首次进入只做一次 1.2s 的 rise/assemble 入场；鼠标移动带来 ±3° 视角。
6. 选中联动：
   - focusRoom(index, {source}) 旋转 520ms 到中心，更新 aria-live「已选择 C07 网络交换节点」，更新摘要。
   - 选中后调用现有 setFilters({query: point.point_id, scope:'all', required:'all', status:'all'})，让下方点位列表收敛到该房间；同时保留“全部空间”恢复入口。
   - 如果用户在现有搜索框输入 C07，或从楼层 picker 选中 Z3，旋转木马自动 focusRoom 到对应房间；加 state.roomSync 防止循环触发。
   - 滚动到点位区用 scrollIntoView({behavior: reduced ? 'auto' : 'smooth', block:'start'})；不要用 document.write 或重建整页。
7. 移动端（≤767）：
   - 关闭 3D 环形，改为横向 scroll-snap：.room-ring 变成 flex，overflow-x:auto，scroll-snap-type:x mandatory；卡片宽 180–200px；箭头仍可用；选中卡自动 scrollIntoView({inline:'center'})。
   - ≤580 时摘要堆叠到卡片下方，隐藏倒影与鼠标视差。

【B2. 点击“进入巡查”的穿梭（warp）转场】
1. 触发：选中房间的「进入巡查」按钮；点击已居中的房间卡；键盘 Enter。不要在每个按钮上触发。
2. 总时长 720ms（reduced-motion 180ms 淡入）：
   - 0–80ms：在指针/卡片中心插入 #warp-layer（fixed inset:0，pointer-events:none，z-index:80，aria-hidden），播放 10–12 条从中心向外辐射的 teal/sky 光线；中心一个 radial 白青闪光。
   - 80–520ms：克隆选中卡（cloneNode(true)，去掉 id/按钮/aria），从 getBoundingClientRect() 位置用 WAAPI 缩放到全屏（transform + border-radius 14→0 + opacity 1），缓动 cubic-bezier(.16,1,.3,1)；同时 #warp-layer 的 .warp-tunnel 从 scale(.6) 到 1.6、opacity 0→.85→0。
   - 520–620ms：#warp-layer 淡出；clone 保持全屏 120ms，作为“进入房间”的最后一帧。
   - 620ms：调用现有 openDetail(point_id, 'inspect')（现场记录模式），焦点进入抽屉；warp 层在 detail open 后移除。
3. 视觉：
   - 隧道用 repeating-conic-gradient 或 12 个绝对定位的细光线 span（1px 宽、40vmax 高、linear-gradient(transparent, rgba(15,118,110,.55), transparent)），从中心向外 translate + scaleY；不要用全屏 blur。
   - 背景光：radial-gradient(circle at center, rgba(255,255,255,.75), rgba(2,132,199,.18) 30%, transparent 62%)。
   - 颜色只用 teal/sky/白；不要紫、不要黑屏。
4. 降级/无障碍：
   - prefers-reduced-motion 或 data-motion=off：直接 openDetail，最多 180ms opacity 淡入；不创建 clone/隧道。
   - 转场期间禁止重复点击（state.warping）；Esc 不打断（720ms 很短），detail 打开后正常 Esc。
   - clone 设 aria-hidden="true"；warp 层移除后焦点在 detail 的关闭按钮/首个表单控件。
5. 反向（可选）：关闭 detail 时 360ms 缩回原卡位置；不做也接受，但不要闪白。
6. 参考：
   - 光隧道：Lightfall（lightMode:true）的“streaks in curved tunnel”视觉；
   - 全屏展开：Circular Gallery 的“cards that open to the full image”；
   - 不要真的加载 WebGL 组件；如果实现 Canvas2D 光线，注意 rAF 只跑 720ms，结束 cancel。

【B3. 视差滚动（parallax）】
1. 只做三档，幅度克制：
   - 环境层 .ambient：滚动 -0.04（向下滚时轻微上移），最多 ±40px；
   - 选房 stage：滚动 -0.10，最多 ±48px；进入视口时 translateY 20px→0、opacity .9→1；
   - 概览/卡片：不逐帧位移；用 IntersectionObserver 一次性 16px→0 + opacity 0.94→1，stagger 40ms，最多 8 张。
2. 实现：
   - 一个 passive scroll 监听 + requestAnimationFrame 节流，只读 scrollY，写 CSS 变量（--parallax-ambient / --parallax-stage），不要在 scroll 里读 layout。
   - CSS 用 translate3d(0, var(--parallax-ambient), 0)；不改变高度/位置。
   - 页面隐藏、reduced-motion、data-motion=off、≤767 时停止并清零变量。
   - 不要用 background-attachment: fixed（移动端卡顿）。
3. 入场：
   - 选房 stage 首次进入：1 次 700ms rise（translateY 24px + opacity 0→1），之后不再重放。
   - 卡片入场只在首次渲染/筛选后新增卡片时使用；搜索逐字不触发。
4. 性能：
   - 不给 .room-card 加 will-change；只在拖拽/转场期间临时加，结束移除。
   - 视差层最多 2 个；不要给每个卡片加 scroll 监听。

【B4. 点击 Spark（可选但推荐）】
1. 只在「进入巡查」和选房卡片点击时触发，不要每个按钮都放。
2. 8–12 条 1px 光线，从点击点向外 28–44px，320ms，ease-out，颜色 teal/sky/白；Canvas2D 一次性绘制或 CSS span，结束移除。
3. 与现有 click-ring 二选一：选房/进入巡查用 spark，其他控件保留 26px ring；不要叠加两个全屏效果。
4. reduced-motion 完全不创建。

【B5. 视觉美化（不改变布局骨架）】
- 选房 stage 用玻璃框：1px 白边 + glass edge 外描边 + 18/60 阴影 + 底部一条青→蓝渐变光；背景加 radial 柔光，不遮文字。
- 卡片：14px 圆角、白色高光、底部 1px 分隔、状态徽标沿用现有五档浅色；中心卡比两侧多一层 0 8 30 阴影。
- 标题行：h2 22–24px，说明 12px muted，计数用等宽；不要全大写英文 eyebrow。
- 与现有 glass 主题一致：teal #0f766e、sky #0284c7、白玻璃、#0f202b 文字；不要引入新的主色。
- 页面仍保持「先看概览、再看点位」的阅读顺序；选房 stage 是入口，不是替代概览。

【集成点（避免破坏现有代码）】
- 新文件建议：frontend/room-stage.js、frontend/room-stage.css；在 index.html 引入 CSS，在 app.js import initRoomStage。
- initRoomStage({ getPoints: () => state.data?.points || [], onEnter: (point) => openDetail(point.point_id,'inspect'), onSelect: (point) => setFilters({query:point.point_id,scope:'all',required:'all',status:'all'}) })。
- 不修改 filter-pickers.js 的原生 select 逻辑；如需在 picker 中增加房间行，复用现有 choose(value) 机制，不维护第二套筛选状态。
- 不修改 setFilters 的核心语义；只在它之后同步 carousel 的 active。
- 不改 dialog.showModal() 的同步时序；warp 在 openDetail 前完成。
- 不新增后端接口、不改数据库、不改 README 的业务边界。

【验收】
- 1440：选房 stage 可见，8 张卡形成 3D 环；左右/拖拽/滚轮可转；点击卡片先居中再进入；「进入巡查」720ms 穿梭后打开详情抽屉；无闪白/无错位。
- 768/390：无横向溢出；≤767 切换为横向 scroll-snap；触摸可滑；不阻断页面纵向滚动；warp 仍可用但可缩短。
- 选中联动：选 C07 后下方列表只剩 C07，计数正确；搜索 C07 时 carousel 自动转到 C07；不会循环触发。
- 视差：滚动时 ambient/stage 只有 transform；无 Layout；reduced-motion 下全部静止。
- 无障碍：Tab 能到 carousel、箭头、卡片、进入巡查；左右键/Home/End/Enter 可用；aria-live 报当前房间；焦点不被 warp 层吞掉。
- 性能：无 WebGL 依赖；转场 720ms 内 rAF 结束即 cancel；移动端无 backdrop-filter；连续拖拽 60fps（真机确认）。
- 回归：现有 51 项浏览器检查 + 4 项单元检查通过；新增测试覆盖 carousel 键盘/拖拽、选房联动、warp 打开详情、reduced-motion 降级。
- 不伪造任何房间、照片、记录或统计。

【交付】
- 改造前后 1440/390 截图；
- 选房、穿梭、视差的关键帧或短视频；
- 新增测试与运行结果；
- git diff --stat；
- 说明哪些 React Bits 参考被采用、哪些被拒绝及原因。
```

---

# C. 验收提示词

```text
请只做验证，不改代码。逐项给出命令、输出和截图路径：
1) node tests\frontend.test.mjs（4/4）；
2) 现有浏览器回归（browser.cjs / browser-advanced.cjs / glass-browser.cjs / polish.json）结果；
3) 1440/768/390 截图：选房 stage、选中 C07、warp 中段、详情抽屉打开；
4) 键盘：Tab 到 carousel，←/→ 切换，Home/End，Enter 进入；焦点是否回到触发卡；
5) reduced-motion：carousel 是否停止自动/3D 位移，warp 是否降级为淡入，视差是否为 0；
6) Performance：拖拽 carousel 与 warp 各录一次，检查是否有 Layout 行、rAF 是否在 720ms 后停止；
7) 控制台 0 异常；git diff --stat 只包含允许文件。
不要用“应该”“看起来”下结论。
```

---

# D. 参考路径与参数速查

| 效果 | React Bits 路径 | 在本项目里的用法 |
| --- | --- | --- |
| 3D 环形选房 | https://reactbits.dev/components/circular-carousel | 视觉/交互参考；原生重写，8 张房卡，cylinder，45°/张 |
| 环形画廊 / 点击全屏 | https://reactbits.dev/components/circular-gallery | 点击卡片进入全屏场景的参考 |
| 纵深轮播 | https://reactbits.dev/components/depth-carousel | 卡片纵深/后退的参考（可选） |
| 光隧道 / 穿梭 | https://reactbits.dev/backgrounds/lightfall | 720ms warp 的光线视觉；lightMode:true；原生 CSS/Canvas 近似 |
| 高速光轨 | https://reactbits.dev/backgrounds/hyperspeed | 更强烈的穿梭备选；本项目不建议 |
| 点击火花 | https://reactbits.dev/animations/click-spark | 进入巡查/选房卡的 320ms 火花 |
| 像素转场 | https://reactbits.dev/animations/pixel-transition | 全屏场景切换备选；本项目不建议 |
| 滚动叠卡 | https://reactbits.dev/components/scroll-stack | 视差/叠卡的机制参考 |
| 滚动显影 | https://reactbits.dev/text-animations/scroll-reveal | 卡片一次性入场参考 |
| Pro 视差轮播 | https://pro.reactbits.dev/docs/components/parallax-carousel | 只看理念，不要求 Pro |
| Pro 纵深画廊 | https://pro.reactbits.dev/docs/components/dolly-gallery | 只看理念，不要求 Pro |

如果将来真的改用 React（当前项目不是），安装命令示例：

```bash
npx shadcn@latest add @react-bits/CircularCarousel-JS-CSS
npx shadcn@latest add @react-bits/Lightfall-JS-CSS
npx shadcn@latest add @react-bits/ClickSpark-JS-CSS
```

但本次明确：**不安装、不复制源码、不引入 React**。

---

# E. 当前动效数值速查（给执行模型对齐）

| 项目 | 数值 |
| --- | --- |
| 标题翻转 | 800ms + 每字 24ms，cubic-bezier(.16,1,.3,1)，1.1s 复位 |
| 拖尾 | 24 点 / 115px / 250ms 空闲；teal→sky |
| 背景 | 72s / 88s / 96s，translate3d + scale，alternate |
| 概览光线 | 8s 循环 |
| 点击环 | 26px，2px，520ms linear，0/40/100 关键帧 |
| 按压 | scale(.97)，120ms |
| 筛选 FLIP | 280ms |
| 视图切换 | thumb 240ms；VT 320ms |
| 弹层 | 180ms + body 220ms |
| 选择浮层 | 180ms |
| 加载旋转 | 800ms linear |
| 断点 | 1250 / 1100 / 767 / 580 / 320 |
| 主题 | #e6eff3 底、#0f766e teal、#0284c7 sky、#0f202b 文字、白玻璃 |

---

> 说明：React Bits 的组件页面与参数只作为视觉/机制参考；本项目是原生 JS，提示词要求“重写机制、不安装依赖、不复制源码”。所有示例路径以 React Bits 站点当前路由为准。
