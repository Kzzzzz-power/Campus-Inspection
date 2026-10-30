# 巡到位 InspectGo

校园教学楼与实验实训空间的分布式设施巡检与复核工作台。当前验收分支已实现**阶段 01 实时状态链、阶段 02 记录与证据留存、阶段 03 任务判断与 S1**。阶段 03 等待用户验收；阶段 04–08 尚未实施，尚未完成完整 B-B02 案例验收。

**唯一后续开发、运行与 Git 根目录：D:\校园设施巡检与复核。** D:\Codex\InspectGo 仅作旧备份；原资料 D:\分布式设施巡检与复核 保持只读，绝不修改。所有新增项目文件、虚拟环境、缓存、日志、照片和测试产物均放在新根目录。参见 [开发约定](AGENTS.md) 与 [目录迁移说明](docs/目录迁移说明.md)。

## 阶段 03 验收入口（2026-10-30）

本轮代码位于 `feat/stage03-task-runs` 隔离分支。工作台新增轮次与截止时间、显式建立 S1 教学实例、T1–T5 依赖检查、判断证据和现场补证。建立实例后点击“生成运行判断”，S1 应显示 6/6 必检覆盖及五项任务成立；展开任务可以追到证据与来源。

运行输入可排除普通点 C03（T1 仍成立）、排除必检点 C07（T1 状态未知）、同时提供 Z3 拒绝进入（T1 受阻）。每次生成新 `run_id`，原始记录和旧运行保持不变。教学实例标记 `SIMULATED`，不自动导入正式库。精确现场结果支持 NORMAL / WARNING / FAULT；发现异常仍可作为有效现场覆盖。

新接口：`POST /api/scenarios/S1/prepare`、`POST /api/evidence/manual`、`GET /api/tasks?run_id=...`；`POST /api/runs` 要求 `request_id`、`inspection_round_id`、带时区的 `as_of`。旧运行通过 `GET /api/runs/{run_id}` 继续查看。配置哈希与轮次不符时拒绝重新判断；跨轮次复核证据被拒绝。T5 目前为基础统计，耗时缺失保留 null；AI、候选方案与完整复核生命周期属于后续阶段。

本轮使用 D 盘独立数据库验收。后端运行 `python -B -m pytest tests -q -p no:cacheprovider`，前端运行 `node --test tests/*.test.mjs`。浏览器验收脚本为 `tests/stage03-browser.cjs`；历史迁移脚本为 `tests/stage03-integration.cjs`，需通过 `INSPECTGO_STAGE02_ROOT` 指定已验收 Stage02（41ed359）的源码目录，默认使用相邻的 `stage02-worktree`。可用 `INSPECTGO_PYTHON` 指向既有 Python 环境，脚本全部采用隔离数据库和日志。

## 阶段 01 实时链路（2026-10-29）

已接通模拟器 → 本机 MQTT Broker → FastAPI → WebSocket → 页面。卡片显示设施编号、远程状态、观测时间、来源与延迟；断线/过期保留最后值并标未知，不增加现场覆盖，也不改复核或旧运行。

本机 PowerShell 7 启动完整链路：

~~~powershell
Set-Location -LiteralPath 'D:\校园设施巡检与复核'
.\Setup-Realtime.ps1
.\Start-Realtime.ps1
~~~

打开 http://127.0.0.1:8000/；Ctrl+C 清理本次 Broker、API 和模拟器。已有端口被占用时明确报错，可指定 `-Port 8010 -MqttPort 1884`。Broker 单独安装到 `.runtime/broker-venv`，不降级后端环境，不安装系统服务。所有日志、缓存和测试数据均留在本项目 D 盘目录。

[阶段 01 说明、演练步骤与限制](docs/stages/01-设施状态链.md) · [验收证据](docs/evidence/stage01-2026-10-29/README.md)。阶段 02 已验收通过。

## 设施配置基线（2026-10-29）

已建立统一 `config/facilities.json` 和 `config/zones.json`，固定 3 区域、8 点位、6 必检点。既有接口和页面直接读取配置，保留旧点位 ID 并增加 `facility_id`。新增只读接口 `/api/facilities`、`/api/scenarios/S1`。

S1 文件明确标注为教学输入，保留 C03／ap-2f 的历史告警、当前远程观察、现场记录和完成复核的关联证据；不自动灌入真实数据库，不预填 T1–T5 状态。阶段 03 已以明确轮次和固定 09:00–09:45（Asia/Shanghai）窗口替代新运行的滚动统计；未选择轮次时不显示虚构覆盖数。旧运行保留原始摘要及快照。完整说明、固定清单及复现命令见 [设施配置与已确认告警基线](docs/baselines/01-设施配置与已确认告警.md)。

## 当前前端界面（2026-10-30）

页面主题为“校园设施巡检与复核”。已接入确认过的日间玻璃效果、完整中文翻转标题及可搜索的楼栋／楼层选择浮层；搜索、现场记录、照片、复核和运行历史沿用原有接口。使用原生 CSS / JavaScript，无需安装前端构建依赖。

新增全点位选择舞台：原生 CSS 3D 卡片、进入巡查转场、点击火花和视差，移动端采用横向滚动。选点联动清单，进入巡查仍打开原有现场记录表单；舞台与清单共用实时设施状态解释，现场覆盖独立展示。该效果不等于案例要求的 Three.js 多端实现。早期截图与案例取证仍见 [3D 选房案例草稿](02_AI对话快照/01_3D选房与穿梭动效/说明.md)，不把历史截图作为当前代码回归证明。

本次检查记录、实际截图与边界见 [玻璃界面验收](docs/evidence/glass-ui-2026-10-29/README.md)。本机请用 PowerShell 7 运行以下启动命令；旧 Windows PowerShell 5 无法正确解析既有启动脚本中的 UTF-8 中文。

## 仅启动已有 API（不启动 Broker／模拟器）

本机新目录的环境已重建并验证，可以直接运行。换电脑或缺少 .venv 时，先按下方步骤创建 Python 3.11 环境。

~~~powershell
Set-Location -LiteralPath 'D:\校园设施巡检与复核'
Remove-Item -LiteralPath Env:INSPECTGO_DB,Env:INSPECTGO_UPLOADS,Env:INSPECTGO_SEED_DEMO -ErrorAction SilentlyContinue
.\Start.ps1
~~~

打开 http://127.0.0.1:8000/ 。终端按 Ctrl+C 停止；端口冲突时用 .\Start.ps1 -Port 8010。不要双击 HTML，页面通过同源 HTTP 访问后端。清除上述进程环境变量是为了使用新根默认数据库与照片目录，避免继承旧实例或测试实例的路径。

Start.ps1 按自身位置定位项目，将临时文件与包缓存放入 .runtime；默认数据库为 backend/inspectgo.db，照片为 backend/uploads。既有数据库采用增量迁移，不清空历史、不刷新旧模拟记录时间。迁移后的环境、启动及回归结果在迁移说明中单独记录，旧截图不替代新路径验证。

## Python 3.11 环境重建

旧 .venv 含旧绝对路径，不作为可移植环境直接使用。新根尚无 .venv 时，可用已安装的 Python 3.11 创建环境，不需要重新安装系统 Python：

~~~powershell
Set-Location -LiteralPath 'D:\校园设施巡检与复核'
New-Item -ItemType Directory -Path '.runtime\tmp','.runtime\pip-cache' -Force | Out-Null
$projectRoot = (Get-Location).Path
$env:TEMP = Join-Path $projectRoot '.runtime\tmp'
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = Join-Path $projectRoot '.runtime\pip-cache'
$env:PYTHONDONTWRITEBYTECODE = '1'
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -B -m pip install -r .\requirements-lock.txt
.\.venv\Scripts\python.exe -B -m pip check
~~~

若本机没有 py 启动器，可将其中创建环境的一行替换为本机已有 Python 3.11 解释器的明确路径。本次机器原环境使用的是：

~~~powershell
& 'C:\Users\tan13\miniconda3\envs\yolov8\python.exe' -B -m venv .venv
~~~

此 C 盘路径是既有解释器的位置，不是新增项目产物目录；其他机器应替换为其实际 Python 3.11 路径。创建完成后统一使用新根 .venv 内的 python.exe，不依赖激活脚本或系统默认 Python。

requirements-lock.txt 锁定运行与测试依赖。requirements.txt 仅列运行依赖；requirements-dev.txt 在此基础上追加测试工具。首次下载需要网络；未承诺未经干净机器实测的安装时长。

## 已有功能与边界

- 搜索点位编号、设施名称；按楼栋、楼层、必检属性和业务状态筛选，切换网格／列表。
- 八点位来自同一后端统计快照。必检为 C01、C02、C04、C05、C07、C08；普通点为 C03、C06。
- 现场覆盖、设施最近记录、复核处理分别呈现。远程状态不单独算覆盖；有效现场记录不等于设施正常。
- 查看真实详情、登记现场记录、保存实际照片、发起及处理复核。无法确认时保留待复核；确认异常不表示异常解除。
- 保存覆盖判断与快照，查看最近 20 次运行。旧运行仅显示原摘要，不补造历史快照。
- 原创中文标题一次 3D 翻转、桌面短拖尾、可保存的动效开关、减少动态效果支持及键盘可操作的对话框。

统计采用**当前时刻向前滚动 45 分钟**，页面显示后端窗口及最后刷新时间；尚未实施正式巡检轮次。旧记录过期后覆盖数会下降，不为保持截图数字重灌数据。旧种子文本可能写有“照片已上传”，但没有对应图片；只有真正保存的文件才进入照片区。

现场提交需填写人员、发生时间、检查结果、说明，并确认已到现场。支持 JPG/JPEG、PNG、WebP，每张最多 10MB、每次最多 5 张，实际解码校验并限制 2500 万像素。保存失败保留表单，重试采用请求标识避免重复写入；复核使用版本检查。

当前为单机教学工作台，人员信息手工填写，不构成身份验证或权限系统。默认只监听本机；未配置手机跨设备访问、离线同步或多人审批。MQTT/WebSocket 本机教学状态链已实现；完整 T1—T5 判断、独立巡检轮次、条件推演及 AI 分析仍未实现；不输出正式安全合规或专业故障诊断结论。

## 验证

以下命令仅从新根执行。测试使用 .runtime 内的独立数据库和照片目录，不能替换为真实数据库：

~~~powershell
Set-Location -LiteralPath 'D:\校园设施巡检与复核'
New-Item -ItemType Directory -Path '.runtime\tmp' -Force | Out-Null
$env:TEMP = Join-Path (Get-Location).Path '.runtime\tmp'
$env:TMP = $env:TEMP
$env:PYTHONDONTWRITEBYTECODE = '1'
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider --basetemp .runtime\pytest-temp tests\test_api.py
node --test tests\frontend.test.mjs
~~~

Node 使用本机已有版本。若未加入 PATH，本机可将最后一行替换为：

~~~powershell
& 'D:\claude\node.exe' --test tests\frontend.test.mjs
~~~

浏览器脚本使用 Node 内置模块、全局 fetch 与 WebSocket，不需要安装前端 npm 依赖。执行 tests/browser.cjs 与 tests/browser-advanced.cjs 前，需准备 Chrome DevTools 9338 端口和 http://127.0.0.1:8001/ 隔离验收实例；脚本本身不启动它们。该实例的 INSPECTGO_DB、INSPECTGO_UPLOADS 和独立 Chrome 用户目录都必须位于新根 .runtime。不得连接真实 8000 数据库做写入验收。

浏览器测试会使用 docs/evidence/B0/desktop.png 作为测试上传样本。截图与 JSON 输出在 .runtime/ui-check，属于测试产物，不是实际设施照片。历史 B0 及 UI 截图已经随目录迁入；其旧路径、时间、哈希与结论保持历史含义。**迁移后的环境、运行和回归检查已完成**，详见迁移说明。

选房交互回归：运行 `node tests/room-stage-browser.cjs`，脚本自动分配本机端口、启动独立 Broker/API/隐藏 Chrome，并在退出时清理自身进程。需已有 `.venv`、`.runtime/broker-venv` 和本机 Chrome；可通过 `INSPECTGO_CHROME` 指定已有 Chrome 路径。仅在 `.runtime/room-stage-fix/` 内生成测试数据库、浏览器配置和结果，验证实时告警/过期、覆盖标识、键盘、真实鼠标及触屏输入，不写正式数据库。

## Git 与每日对话快照

Git 操作只在 D:\校园设施巡检与复核 执行。源码、测试、启动脚本、依赖清单与文档纳入版本管理；.gitignore 排除数据库及其日志、backend/uploads、.runtime、.venv、密钥和缓存。真实数据仍保留在本机，跨机器恢复既有业务数据时需另外成套备份数据库与照片。

历史记录：2026-10-27 用户授权首次本地提交及三张截图归档。之后用户授权推送，当前 `origin` 为 [Campus-Inspection-draft](https://github.com/Kzzzzz-power/Campus-Inspection-draft)，分支为 `main`；2026-10-30 首次交接时，仓库为私有，当时本地与远端均为 `07753b5`，该编号仅代表历史检查点；当前版本以以下命令为准。后续提交或推送按当次授权执行，使用现有 Git 身份，不回填日期。可用以下命令核对实际状态：

~~~powershell
Set-Location -LiteralPath 'D:\校园设施巡检与复核'
git log -1 --format=fuller
git show --stat --oneline HEAD
git status --short
~~~

每日资料按 docs/ai-sessions/YYYY-MM-DD.md 归档，与当天开发提交同日保存；图片放入对应 assets/YYYY-MM-DD。已有记录不改写，缺失对话不编造。这里没有配置后台定时导出任务。

每日归档入口：[AI 对话快照索引](docs/ai-sessions/README.md)。最新已归档资料为 [2026-10-30 对话快照](docs/ai-sessions/2026-10-30.md)，属于截图式存档，不是完整会话导出。缺失的原始提问、第一版方案和纠偏证据继续标为缺失，不补造；当前竞赛案例包仍为草稿。历史 B0 文档保留当时状态，不代表当前版本已完成全部案例。

## 来源

业务以新的 B02 案例书及实践指南为依据；基础代码来自提供的 Day 1 骨架。GreenMate 仅为技术参考，没有导入其业务数据或模型。原始资料目录保持不变。

界面工作读取并应用 design-taste-frontend、impeccable、react-bits；最后一项只用于核查候选组件，未安装 React Bits 运行组件。

- 标题为原创 CSS 3D；[公开效果参考](https://pro.reactbits.dev/docs/components/3d-letter-swap)，未复制或分发 Pro 源码。
- 拖尾为原创 Canvas2D；[评估的官方 Ribbons 源码](https://github.com/DavidHDev/react-bits/blob/main/src/content/Animations/Ribbons/Ribbons.jsx)，未引入 React 或 WebGL 组件。
- 页面不伪造照片、遥测图表或真实平面图；“点位覆盖示意”只表达八点位的覆盖情况。