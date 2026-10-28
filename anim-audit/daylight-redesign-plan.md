# 日间主题 · 动态背景 · 点击与视图切换改造方案

> 日期：2026-10-28 ｜ 方式：只读审查 + 独立预览验证 ｜ 未修改任何产品源码。
>
> 这次方向**替换**上一版「夜间巡检控制台」：不再是深色/纯黑，而是日间、带环境光、可切换视图的工作台。

---

## 0. 结论

当前前端自 2026-10-27 后没有再改过（`frontend/` 文件哈希未变），所以上一轮审计里的问题仍然成立：抽屉瞬开、toast 被抽屉盖住、按钮没有按压反馈。这次新增三点要求，对应三个缺口：

1. **背景是纯色**：`body { background: var(--ground) }`，`--ground: #0d1014`，没有任何环境层，观感单调且偏夜。
2. **点击没有"回应"**：全仓没有 `:active`，按钮只过渡颜色；点击后界面几乎没有物理确认。
3. **视图切换是硬切**：`app.js:185` 只切一个 class，网格↔列表瞬间重排，没有滑块、没有形变。

建议按三层做，全部只动 CSS + 少量装饰 JS，不引依赖：

- **环境层**：日间纸感底 + 3 个缓慢漂移的色场 + 48px 网格；`transform` 动画，60–96s，可被 reduced-motion 关闭。
- **交互层**：按钮 120ms 按压 + 点击处 520ms 扩散环；视图切换加 240ms 滑块。
- **形变层**：网格↔列表用 View Transition 做 320ms 卡片形变；筛选保持 DOM 同步后用 280ms FLIP。

不做：数字滚动、卡片逐张入场、搜索逐字动画、全屏粒子/3D 背景、GSAP 运行时。

---

## 1. 复检范围与证据

| 项目 | 结果 |
| --- | --- |
| 代码状态 | `git status --short` 只有 `?? anim-audit/`；`frontend/` 六个文件 mtime 仍是 2026-10-27，哈希未变 |
| 审计依据 | `frontend/styles.css` 396 行、`app.js` 203 行、`motion.css` 90 行、`motion.js` 245 行；`.runtime/ui-check` 的 2026-10-27 验收截图 |
| 新增验证 | 独立预览页 `anim-audit/preview-daylight.html`（不连后端），Chrome 156 实测 1440×1200，控制台 0 错误 |
| 未覆盖 | 真实数据库写入、真机性能、跨浏览器像素级比对；预览页是桌面演示，390 移动布局需在真实页面实现后再验 |

---

## 2. 现状与问题（只列与新要求相关的）

| # | 严重度 | 位置 | 现象 | 对新方向的影响 |
| --- | --- | --- | --- | --- |
| D1 | HIGH | `styles.css:24-25`、`:root` | `body` 只有一层 `var(--ground)`，`:root` 是 `color-scheme: dark` | 背景单调、偏夜；不做环境层就不可能"动态" |
| D2 | HIGH | `styles.css:58` | `.btn` 只过渡颜色，全仓无 `:active` | 点击没有物理确认；触屏尤其空 |
| D3 | MEDIUM | `app.js:185`、`styles.css:131-133` | 视图切换只 `classList.toggle('list-view')` | 网格/列表瞬间跳变，没有"切换"的感觉 |
| D4 | MEDIUM | `styles.css:42` | 顶栏没有背景/边框层次 | 浅色背景上顶栏与内容糊在一起 |
| D5 | MEDIUM | `styles.css:91`、`139-140` | 概览条是实色面板；卡片 hover 只改边框色 | 缺少"浮在环境上"的层次，白色卡片容易像表格 |
| D6 | MEDIUM | `motion.js:119-121` | 拖尾颜色硬编码 `rgba(139,213,246,…)` | 浅色背景上几乎不可见；改浅色主题必须重配或停用 |
| D7 | MEDIUM | `styles.css:390-392`；`app.js:44` | toast 只有终态、无过渡，且被 `showModal()` 的 top layer 盖住 | 浅色主题下仍存在；保存反馈不可见 |
| D8 | LOW | `styles.css:193-194`；`app.js:106` | 抽屉瞬开 | 与"视图切换动效"同属空间连续性问题，可一起做 |
| D9 | 约束 | `styles.css:363-366` | reduced-motion 只把 `transition-duration` 归零，不覆盖 `animation` | 新增的环境层/扩散环/光晕都必须显式处理 |

> D6 的数值来自 `motion.js` 的 `createLinearGradient`：`rgba(139,213,246,0)` → `rgba(139,213,246,.17)` → `rgba(189,234,255,.23)`。浅色下建议改成 `rgba(15,118,110,…)` / `rgba(2,132,199,…)`，或直接停用。

---

## 3. 方向：「Daylight Campus / 日间信号台」

不是把深色换成白底，而是把界面变成"浮在日光和空气里的一层玻璃"：纸感底、缓慢移动的冷色光、极细网格、半透明白面板、深青墨字。

### 3.1 为什么不是夜间/纯黑

- 巡检是白天发生的现场工作，深色控制台在日光下反而难读；
- 纯黑 + 霓虹是营销页语汇，放在要读状态、填表单的工作台上会疲劳；
- 用户明确要"动态、不单调"，深色渐变很容易滑向"夜间"，所以选日间纸感 + 冷色环境光。

### 3.2 色板（可直接替换 `:root`）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--paper` | `#f3f6f5` | 页面底，冷调纸白 |
| `--ink` | `#0f202b` | 主文字，深青墨 |
| `--ink-2` | `#334a5a` | 次级标题 |
| `--muted` | `#5c7080` | 正文辅助 |
| `--faint` | `#738696` | 时间、编号、说明（仍 ≥4.5:1） |
| `--line` | `rgba(15,32,43,.10)` | 1px 发丝边 |
| `--line-strong` | `rgba(15,32,43,.18)` | hover/强调边 |
| `--teal` | `#0f766e` | 主色：覆盖、主按钮、ID |
| `--sky` | `#0284c7` | 次色：进度、聚光 |
| `--amber` | `#b45309` | 告警（唯一暖色） |
| `--rose` | `#be123c` | 严重/异常 |
| `--green` | `#15803d` | 正常/已覆盖 |

### 3.3 玻璃层级（只做 20–35%，不做"毛玻璃水族箱"）

| 层 | 背景 | 模糊 | 边框 |
| --- | --- | --- | --- |
| 顶栏 | `rgba(255,255,255,.62)` | `blur(18px) saturate(1.25)` | 底部 1px `--line` + 青→蓝渐变发丝线 |
| 概览条 | `rgba(255,255,255,.64)` | `blur(14px) saturate(1.15)` | 1px `--line`，16px 圆角 |
| 点位卡片 | `rgba(255,255,255,.70)` | 不加模糊 | 1px `--line`，14px 圆角，双层阴影 |
| 左/右栏 | `.55 / .64` 白 | `blur(12/10px)` | 1px `--line`，14px 圆角 |
| 输入/下拉 | `rgba(255,255,255,.64)` | 无 | 聚焦 3px teal 光环 |
| 弹层 | 近不透明白 `rgba(255,255,255,.96)` | 不建议大面积 blur | 深阴影 + 1px 边 |

原则：**透明感来自层次，不来自把正文放在半透明底上**。卡片正文区域不模糊，保证读表速度。

### 3.4 环境层（动态、但不"动个不停"）

三个大色场，彼此错开：

- 冷蓝 `rgba(180,216,255,.95)`，72s，左上；
- 薄荷 `rgba(196,240,226,.90)`，88s，右上；
- 淡紫 `rgba(226,220,255,.82)`，96s，底部。

再加一层 48px 网格（`rgba(15,32,43,.06)`），用 `mask-image` 从上往下淡出。所有动画只改 `transform`，元素固定定位，`pointer-events:none`，不参与布局。

```css
@keyframes drift-a {
  0% { transform: translate3d(-3%, -2%, 0) scale(1); }
  50% { transform: translate3d(5%, 4%, 0) scale(1.08); }
  100% { transform: translate3d(-1%, 7%, 0) scale(1.02); }
}
```

性能说明：色场用 `radial-gradient` 自带柔边，**不要**再叠 `filter: blur(60px)`；`transform` 动画由合成器处理，不触发布局/绘制。`prefers-reduced-motion: reduce` 下 `animation: none`。

### 3.5 页面框架（Pinterest 的启发，不是照搬）

Pinterest 2026 的界面语言里最值得借的是"**柔和的渐变作为光线**"而不是装饰：DoubleShot 的趋势文章直接拿 Pinterest 菜单的"梦幻渐变过渡"举例。落到工作台：

- 顶栏 sticky、半透明，让环境光从下面透出来；
- 左栏从"裸文字"变成一块浮动玻璃面板，与右栏成对；
- 卡片用 14px 圆角 + 1px 发丝边 + 双层阴影，浮在环境层上；
- 保留 3 栏结构，不改成 masonry：巡检要扫读编号/状态，瀑布流会破坏对齐；
- 不做"每个区块都是同样圆角卡片"的 SaaS 套件感：概览条、卡片、侧栏的圆角/阴影/密度不同。

### 3.6 动效令牌

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--dur-press: 120ms;
--dur-ui: 180ms;
--dur-panel: 260ms;
```

---

## 4. 三块交互改造

### 4.1 点击效果（press + ring）

- 所有按钮/可点行：`:active { transform: scale(0.97) }`，120ms `--ease-out`；键盘 Enter 同样生效。
- 点击处扩散环：`26px` 圆环，2px teal 边，`520ms linear`，`0% opacity 1 / 40% opacity .9 / 100% opacity 0`，从 `scale(.3)` 到 `scale(2.1)`；`pointer-events:none`，动画结束自动移除。
- 主操作（生成运行判断）加 `box-shadow` 外发光，不弹庆祝动画。
- reduced-motion：不创建环，保留按压缩放或改为仅颜色变化。
- 不做全屏 canvas 粒子（React Bits 的 ClickSpark 是 canvas 粒子，工作台上每次点击都放会吵）；环 + 按压已经足够。

### 4.2 视图切换（segmented + View Transition）

- 视图开关做成滑块：`thumb` 绝对定位，`transform: translateX(calc(100% + 2px))`，240ms；`data-view="list"` 驱动，不依赖 `:has()`。
- 卡片形变：`document.startViewTransition(() => { toggle class })`，每张卡 `view-transition-name: card-C01…`；`::view-transition-group(*) { animation-duration: 320ms }`；关闭 root 的整页交叉淡入（`::view-transition-old(root), ::view-transition-new(root) { animation: none }`），只让卡片形变。
- 测试影响：`startViewTransition` 回调是异步的，`tests/browser.cjs:30` 在点击后立即断言 `list-view` 会失败。两种处理：
  1. 把断言改成 `await wait("...contains('list-view')")`（推荐，测试语义也更对）；
  2. 不支持 VT 或 reduced-motion 时同步切换，测试只在支持的浏览器上跑。
- 降级：`typeof document.startViewTransition !== 'function'` 或 reduced-motion 时直接切 class，不做形变。

### 4.3 筛选重排（FLIP，保持同步）

- 点击"待补检"：DOM **同步**隐藏/显示卡片，再在下一帧对存活卡片做 280ms `translate` FLIP；新出现的卡片 180ms 淡入。
- 隐藏后同步隐藏空的分区标题（否则会出现"教学楼·二层 2 个点位"但一张卡都没有）。
- 搜索输入、30s 自动刷新、首次加载不走动画。
- 卡片数量 > 12 或 reduced-motion 时跳过 FLIP。

---

## 5. React Bits / Pinterest / GSAP 取舍

### 5.1 React Bits

本机**没有安装** react-bits skill。我从 skills.sh 读了 `kmshihab7878/claude-code-setup/react-bits` 的目录（第三方，未安装），它自己的规则就写着："企业仪表盘不建议直接用 React Bits，动画要克制；一个角色只选一个组件，不要堆叠 canvas 背景。"

所以只借三个概念，且全部用原生 CSS/JS 重写：

| React Bits 组件 | 在本项目里的用法 |
| --- | --- |
| `Aurora` | 环境层的三个色场（不引 WebGL/ogl，改用 CSS 渐变 + transform） |
| `SpotlightCard` | 卡片 hover 的 240px 指针光斑（`--mx/--my` + radial-gradient） |
| `ClickSpark` | 降级成 520ms 扩散环，不做 canvas 粒子 |

明确不用：`MagicBento`、`Particles`、`Ballpit`、`Galaxy`、`Dock`、`Masonry`——与巡检工作台的气质和性能预算不符。

### 5.2 Pinterest

- 借"渐变作为光线、悬浮面板、留白"；不借 masonry、图片主导、超大标题。
- 参考：[2026 Design Trends（DoubleShot）](https://doubleshotcreative.com/blog/2026-design-trends-whats-shaping-the-future/) 里关于 Pinterest 菜单渐变过渡的描述。
- Pinterest 站点本身是 JS 重渲染，直接抓取意义不大；这里用的是它的视觉语言，不是页面结构。

### 5.3 GSAP

不需要。环境层是 CSS `transform` 动画；点击环是 CSS keyframes；视图形变是 View Transitions；筛选是 WAAPI。引入 GSAP 只会多 70KB 和一条主线程动画路径。

---

## 6. 分阶段实施

| 阶段 | 内容 | 文件 | 风险 |
| --- | --- | --- | --- |
| P0 | 色板、纸感底、环境层（3 色场 + 网格）、`color-scheme: light`、`theme-color` | `styles.css`、`index.html` 一行 | 低 |
| P1 | 顶栏/概览/侧栏/卡片/输入/徽标的玻璃层；卡片聚光；ribbon 重配色 | `styles.css`、`motion.js` | 低 |
| P2 | 按钮按压、点击环、视图滑块 | `styles.css`、`motion.js` 或 `app.js` | 低 |
| P3 | View Transition 形变 + 测试断言调整 | `app.js`、`styles.css`、`tests/browser.cjs` | 中（异步时序） |
| P4 | 筛选 FLIP、空分区隐藏、抽屉/toast 修复（可选） | `app.js`、`styles.css` | 中 |
| P5 | 1440/768/390 截图、对比度、reduced-motion、性能 | — | — |

---

## 7. 提示词

### 7.0 总控提示词（先贴）

```text
你在 D:\校园设施巡检与复核 工作。项目是原生 HTML/CSS/JS（无构建、无 npm 依赖）+ FastAPI。
先读 AGENTS.md、README.md、frontend/index.html、frontend/styles.css、frontend/motion.js、frontend/app.js。

【目标】
把当前深色、纯色背景的工作台，改成"日间信号台"：
冷调纸白底 + 三个缓慢漂移的冷色环境光 + 48px 网格 + 半透明白玻璃面板 + 深青墨字。
同时补上：按钮点击反馈、点击处扩散环、网格↔列表的滑块与卡片形变。
只改视觉与交互表现，不改业务、不改文案、不改数据逻辑。

【硬约束】
1. 只允许改 frontend/styles.css、frontend/motion.js、frontend/app.js；
   如需同步浏览器主题色，只允许改 index.html 的 <meta name="theme-color"> 一行。
   如果为了 View Transition 必须动 tests/browser.cjs 的等待断言，只改那一处等待，不放宽其他断言。
2. 不引入任何依赖、图片、远程字体、图标库；不改 DOM 结构、不改文案、不改接口。
3. 不做夜间/纯黑主题；不做紫色霓虹赛博朋克；暖色只留给告警（琥珀）。
4. 只动画 transform / opacity；连续动画只允许环境层，且必须在 prefers-reduced-motion 下停止。
5. 不给卡片/概览条/抽屉加 backdrop-filter；只有顶栏、侧栏、toast 这类小面积元素可以用 blur。
6. 正文对比度 ≥ 4.5:1，大字号 ≥ 3:1；--faint 仍要可读。
7. 不改变 dialog.open 的同步时序（tests/browser.cjs:41 在 Escape 后立即断言照片弹窗已关闭）。

【色板】
--paper: #f3f6f5;
--ink: #0f202b;
--ink-2: #334a5a;
--muted: #5c7080;
--faint: #738696;
--line: rgba(15, 32, 43, 0.10);
--line-strong: rgba(15, 32, 43, 0.18);
--teal: #0f766e;
--sky: #0284c7;
--amber: #b45309;
--rose: #be123c;
--green: #15803d;

【P0 背景】
body { background: var(--paper); color: var(--ink); }
新增一个装饰层（aria-hidden="true"），里面 3 个 span 做色场，外层 fixed inset:0、overflow:hidden、pointer-events:none、z-index:0；
页面 .app-header 与 .app-shell 保持 z-index:1 以上。
色场：
1) 72vmax，左上，radial-gradient(rgba(180,216,255,.95), transparent 68%)，72s；
2) 64vmax，右上，radial-gradient(rgba(196,240,226,.90), transparent 66%)，88s；
3) 78vmax，底部，radial-gradient(rgba(226,220,255,.82), transparent 66%)，96s。
动画只改 transform：translate3d + scale，关键帧 0/50/100%，ease-in-out infinite alternate。
网格用 ::after，48px，rgba(15,32,43,.06) 1px 线，mask-image 从上往下淡出，opacity .6。
prefers-reduced-motion: reduce 下所有色场 animation:none，网格保留静态。
:root 改为 color-scheme: light；meta theme-color 改为 #f3f6f5。

【P1 玻璃层】
- 顶栏：rgba(255,255,255,.62) + blur(18px) saturate(1.25) + 底部 1px 发丝线 + 一条青→蓝渐变线。
- 概览条：rgba(255,255,255,.64) + blur(14px) + 16px 圆角 + 双层阴影。
- 卡片：rgba(255,255,255,.70) + 1px 发丝边 + 14px 圆角 + 阴影；hover 抬升 2px、边框 teal 28%、阴影加深。
- 左/右栏：玻璃面板，14px 圆角，左右栏 top 与 sticky 对齐。
- 输入/下拉：rgba(255,255,255,.64)，聚焦 3px teal 光环。
- 徽标改成浅色底 + 深色字（good/warn/danger/info/muted 五档）。
- ribbon 在浅色下不可见：把 motion.js 里的 rgba(139,213,246,…)/rgba(189,234,255,…) 改成 rgba(15,118,110,…)/rgba(2,132,199,…)，透明度降到 .10–.16；或直接停用。

【P2 点击】
- .btn / .queue-item / .view-switch button / .map-point：
  transition: transform 120ms cubic-bezier(.23,1,.32,1)；:active { transform: scale(.97) }。
- 点击环：pointerdown 时在指针位置插入 26px 圆环，2px solid rgba(15,118,110,.75)，box-shadow 0 0 0 5px rgba(15,118,110,.10)，520ms linear，keyframes 0% opacity 1 scale .3 / 40% opacity .9 scale 1.15 / 100% opacity 0 scale 2.1；animationend 移除；pointer-events:none；reduced-motion 不创建。
- 主按钮 hover/active 增加克制的 teal 外发光，不加庆祝动画。
- 键盘 Enter 触发的 :active 同样有效；不要给键盘高频操作加额外动画。

【P2 视图切换】
- .view-switch 内加 .thumb，绝对定位，data-view="list" 时 translateX(calc(100% + 2px))，240ms cubic-bezier(.23,1,.32,1)。
- 内容切换：
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches)
    document.startViewTransition(() => applyView(mode));
  else applyView(mode);
- 每张卡片设置 view-transition-name: card-C01…；::view-transition-group(*) 320ms；关闭 root 的 old/new 交叉淡入。
- tests/browser.cjs:30 的立即断言改成 wait("...contains('list-view')")；不要放宽其他断言。
- 形变期间卡片只做位置/尺寸插值，不改内部文字。

【P3 筛选（可选）】
- 点击"待补检"：同步更新 hidden，再下一帧对存活卡片做 280ms FLIP；新卡 180ms 淡入；空分区同步隐藏。
- 搜索输入、30s 刷新、首次加载不做动画。
- 卡片数 > 12 或 reduced-motion 跳过。

【验收】
- 1440：背景能看到色场与网格；顶栏/概览/卡片/侧栏有层次；正文和 --faint 清晰。
- 390：无横向滚动；环境层不溢出；网格与色场不遮挡内容。
- 点击：按钮按下有 0.97 缩放；点击"待补检"与"生成运行判断"出现 520ms 扩散环。
- 视图：滑块 240ms；网格↔列表卡片 320ms 形变；reduced-motion 下直接切换。
- 对比度：正文、--muted、--faint 在深浅背景上 ≥4.5:1（大字 ≥3:1）。
- 回归：node tests\frontend.test.mjs 3/3；git diff 只包含允许的文件；没有控制台错误。
- 性能：环境层只有 Composite；卡片/概览没有 backdrop-filter；View Transition 期间无 Layout 行。

【交付】
- 1440/390 改造前后截图各一组；
- 实际色板与偏离说明；
- 对比度检查结果；
- git diff --stat；
- 未运行的测试说明原因。
不要只说"已完成"。
```

### 7.1 只做背景与主题（P0+P1）

把 7.0 里的 P0、P1 两段单独执行，先只改 `:root`、`body`、环境层、顶栏、概览、卡片、侧栏、输入；不要碰 JS。截图确认"背景不抢内容、正文清晰"后再继续。

### 7.2 只做点击与视图（P2）

在 7.1 完成后执行 7.0 的 P2 两段。先做按压与扩散环（纯 CSS + 一个小函数），再做滑块与 View Transition；每步都在 1440/390 截图，测试断言同步调整。

### 7.3 验收提示词

```text
请只做验证，不改代码。逐项给出证据（命令、输出、截图路径）：
1) node tests\frontend.test.mjs 的结果；
2) git status --short 与 git diff --stat；
3) prefers-reduced-motion: reduce 下：环境层是否静止、点击环是否出现、视图切换是否直接生效；
4) 1440/390 截图：背景、玻璃层、对比度、横向滚动；
5) Chrome Performance 录制一次视图切换：是否有 Layout 行；
6) 点击"待补检"后：卡片数量立即为 2，空分区隐藏，存活卡片 280ms 归位；
7) 点击"生成运行判断"：是否有 520ms 扩散环，焦点是否保持。
不要用"应该""看起来"下结论。
```

---

## 8. 验收与风险

### 8.1 验收清单

| 项目 | 标准 |
| --- | --- |
| 背景 | 能看出三个色场缓慢移动 + 网格；不是一层纯色 |
| 层次 | 顶栏/概览/卡片/侧栏从环境层上"浮"起来；卡片正文清晰 |
| 点击 | 所有按钮 120ms 缩放；两个主操作有 520ms 扩散环 |
| 视图 | 滑块 240ms；卡片 320ms 形变；无闪白、无错位 |
| 筛选 | DOM 同步、数量立即更新；FLIP 280ms；空分区隐藏 |
| 无障碍 | reduced-motion 下无环境动画/扩散环/形变；焦点环可见 |
| 对比度 | 正文、--muted、--faint ≥4.5:1 |
| 测试 | 单测 3/3；VT 断言改为 wait；无控制台错误 |
| 性能 | 环境层只有 Composite；没有大面积 backdrop-filter |

### 8.2 风险

1. **View Transition 的异步时序**：`startViewTransition` 回调在下一帧执行，立即断言会失败；必须把 `tests/browser.cjs:30` 改成 `wait`，否则测试红。
2. **浅色主题的眩光**：如果现场主要在强光下使用，纯白卡片会反光；`#f3f6f5` 已经是偏灰的纸白，仍建议在真机上确认。
3. **backdrop-filter 成本**：只给顶栏/侧栏/toast；卡片和概览条不用，避免滚动时每帧重采样。
4. **环境层动画**：三个大层同时 transform，低端机可能 GPU 内存吃紧；如果掉帧，先把色场从 3 个减到 2 个、尺寸降到 60vmax。
5. **ribbon 重配色**：`motion.js` 的颜色是硬编码，改浅色后必须同步改，否则拖尾几乎不可见。
6. **`--faint` 对比度**：`#738696` 在 `#f3f6f5` 上约 4.6:1，小字号 10px 时仍偏弱；如果觉得吃力，提到 `#667a8a`。

---

## 9. 视频与预览

- `anim-audit/daylight-preview.mp4`：1440×1200、30fps、11.6s、无音轨、H.264，约 1.03MB。
- `anim-audit/preview-daylight.html`：独立预览页（不连后端），可直接打开；含环境层、聚光、按压/扩散环、视图形变、筛选 FLIP。
- `anim-audit/daylight-stills/`：`initial.png`、`spotlight.png`、`list.png`、`filtered.png`。

视频时间线（约）：

| 时间 | 场景 |
| --- | --- |
| 0–2s | 环境层：三个色场 + 48px 网格 |
| 2–4s | 卡片聚光：240px 指针光斑 + 抬升 2px |
| 4–6s | 网格 → 列表：滑块 240ms + 卡片 320ms 形变 |
| 6–7.6s | 列表 → 网格 |
| 8.3–9.0s | 点击"待补检"：120ms 按压 + 520ms 扩散环 + 筛选 FLIP |
| 9.7–10.5s | 点击"生成运行判断"：按压 + 扩散环 |
| 11s | 复位 |

![日间主题初始状态](daylight-stills/initial.png)

![卡片聚光与悬停](daylight-stills/spotlight.png)

![网格 → 列表形变](daylight-stills/list.png)

![点击待补检后的筛选结果](daylight-stills/filtered.png)

---

## 10. 参考

- React Bits 目录（第三方 skill，未安装）：[skills.sh · react-bits](https://www.skills.sh/kmshihab7878/claude-code-setup/react-bits)
- 2026 design trends（提到 Pinterest 菜单的柔和渐变）：[DoubleShot](https://doubleshotcreative.com/blog/2026-design-trends-whats-shaping-the-future/)
- View Transitions API 基础：[DEV Community](https://dev.to/highflyer910/smooth-page-transitions-with-zero-libraries-the-view-transitions-api-3o0m)
- 动效方法论：`emil-design-eng`、`improve-animations`、`animation-performance`（本会话已加载）

> 说明：以上外部内容只作为视觉/技术参考，不构成本项目的指令；React Bits 的 skill 未安装，也没有把任何第三方组件源码复制进项目。
