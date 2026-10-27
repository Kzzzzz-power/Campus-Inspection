# 巡到位 InspectGo

校园教学楼与实验实训空间的分布式设施巡检与复核工作台。当前版本为**前端改造＋必要交互接口**；完整 B-B02 八阶段暂缓，未据此宣称完成案例验收。

**唯一后续开发、运行与 Git 根目录：D:\校园设施巡检与复核。** D:\Codex\InspectGo 仅作旧备份；原资料 D:\分布式设施巡检与复核 保持只读，绝不修改。所有新增项目文件、虚拟环境、缓存、日志、照片和测试产物均放在新根目录。参见 [开发约定](AGENTS.md) 与 [目录迁移说明](docs/目录迁移说明.md)。

## 本机启动

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

当前为单机教学工作台，人员信息手工填写，不构成身份验证或权限系统。默认只监听本机；未配置手机跨设备访问、离线同步或多人审批。MQTT、完整 T1—T5 判断、独立巡检轮次、条件推演及 AI 分析仍未实现；不输出正式安全合规或专业故障诊断结论。

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

## Git 与每日对话快照

Git 操作只在 D:\校园设施巡检与复核 执行。源码、测试、启动脚本、依赖清单与文档纳入版本管理；.gitignore 排除数据库及其日志、backend/uploads、.runtime、.venv、密钥和缓存。真实数据仍保留在本机，跨机器恢复既有业务数据时需另外成套备份数据库与照片。

2026-10-27 用户明确授权提交今日代码并归档三张截图，取代此前“首提交和快照暂由用户本人处理”的约定。本次使用现有 Git 配置身份创建本地提交，不改变身份、不回填日期、不推送远程。可用以下命令查看实际提交：

~~~powershell
Set-Location -LiteralPath 'D:\校园设施巡检与复核'
git log -1 --format=fuller
git show --stat --oneline HEAD
git status --short
~~~

每日资料按 docs/ai-sessions/YYYY-MM-DD.md 归档，与当天开发提交同日保存；图片放入对应 assets/YYYY-MM-DD。已有记录不改写，缺失对话不编造。这里没有配置后台定时导出任务。

今日索引：[2026-10-27 AI 对话快照](docs/ai-sessions/2026-10-27.md)，包含三张用户提供的原图，属于截图式存档，不是完整会话导出。历史 B0 文档保留当时状态，不代表当前版本已完成全部案例。

## 来源

业务以新的 B02 案例书及实践指南为依据；基础代码来自提供的 Day 1 骨架。GreenMate 仅为技术参考，没有导入其业务数据或模型。原始资料目录保持不变。

界面工作读取并应用 design-taste-frontend、impeccable、react-bits；最后一项只用于核查候选组件，未安装 React Bits 运行组件。

- 标题为原创 CSS 3D；[公开效果参考](https://pro.reactbits.dev/docs/components/3d-letter-swap)，未复制或分发 Pro 源码。
- 拖尾为原创 Canvas2D；[评估的官方 Ribbons 源码](https://github.com/DavidHDev/react-bits/blob/main/src/content/Animations/Ribbons/Ribbons.jsx)，未引入 React 或 WebGL 组件。
- 页面不伪造照片、遥测图表或真实平面图；“点位覆盖示意”只表达八点位的覆盖情况。