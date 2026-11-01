# 提交索引

**仓库：** https://github.com/Kzzzzz-power/Campus-Inspection-draft

**整理日期：** 2026-11-01（Asia/Shanghai）

**当前分支：** `feat/campus-twin`；本轮代码及日志保存在最新 3D 工作区 `D:\校园设施巡检与复核\.runtime\twin-worktree`。项目根目录的 main 不等于本工作区，尚未合并、推送或部署。

**首次提交：** 2026-10-27 · `f7995bd`

**统计截点：** `491e0cf75d2982b9c493607057b705fd335fd18c`（保存本索引的 docs 提交之前）。本轮新增 4 条功能提交，合计 124 个项目文件；日志另外提交，不混入其他文档修改。

**提交总数：** 当前分支 34 条，main 21 条；所有本地分支及现有远程引用可达提交去重后 38 条。覆盖 2026-10-27 至 2026-11-01 共 6 个不同日期，首末相隔 5 天。

**标签与远程：** 本地当前没有标签。`v0.2.1` → `5f010d3d9bb92d36734982dfb94097ddb2bee019` 是先前核实并记入索引的历史截点；本次没有查询远程，不将其视为 GitHub 目前状态。

> 两份导出与统计以同一截点生成，不包含随后保存日志的 docs 提交自身，避免为追赶自身哈希反复 amend。所有提交使用现有身份、实际时间，不删除或改写历史。

## 阅读方式与分支范围

| 分支 | 截点 | 本分支历史提交数 | 相对 main 新增提交数 |
| --- | --- | --- | --- |
| `main` | `78c16f7` | 21 | 0 |
| `feat/stage02-evidence` | `41ed359` | 23 | 6 |
| `feat/stage03-task-runs` | `7d42e90` | 25 | 8 |
| `feat/stage04-feasibility` | `71203a2` | 27 | 10 |
| `feat/stage05-review-chain` | `d539318` | 28 | 11 |
| `feat/campus-twin` | `491e0cf` | 34 | 17 |

- 本地工作区位于项目根目录 `.runtime/` 下，属于同一 Git 仓库；父目录被忽略不表示工作区里的源码未保存。检查方式为 `git show <提交>:<文件>`。
- 用户在本会话已确认业务阶段 02—07 验收通过；阶段 08 的工程与回归代码已接入。微信小程序尚无正式 AppID 和语音服务配置，真机验收未完成；自动测试不代替这些验收。
- 3D 校园与室内是设计示意，未测绘区域不宣称真实校园还原。本次提交不代表新增视觉验收结论。
- 本轮没有同步 GitHub。仅克隆远程 main 无法获得当前本地分支的新增功能。表中跨分支文档用 `提交:路径` 标记时，可使用 `git show` 查看，不把不存在的文件写成可点击链接。

## 关键功能提交与证据对应

| # | 提交 | 日期 | 做了什么 | 对话案例 | 技术文档／源码与验证入口 |
| --- | --- | --- | --- | --- | --- |
| 1 | `f7995bd` | 10-27 | 初始化巡检工作台并保留首日 AI 对话快照 | [10-27 快照](../docs/ai-sessions/2026-10-27.md) | `README.md`、`AGENTS.md` |
| 2 | `d67506d` | 10-28 | 完成日间 Web 界面打磨；原提交同时包含当日快照，保留历史事实 | [10-28 快照](../docs/ai-sessions/2026-10-28.md) | `frontend/`、`docs/evidence/` |
| 3 | `d26a6c6` | 10-29 | 接入玻璃界面与楼栋／楼层筛选浮层 | Web 纠偏案例（`78c16f7:02_AI对话快照/01_Web前端与动态特效多轮纠偏/说明.md`） | `docs/evidence/glass-ui-2026-10-29/` |
| 4 | `60072ea` | 10-29 | 建立三个区域、八个点位配置及已确认历史告警输入 | [10-29 快照](../docs/ai-sessions/2026-10-29.md) | `config/facilities.json`、`docs/baselines/01-设施配置与已确认告警.md` |
| 5 | `be87fac` | 10-29 | 打通阶段 01 MQTT 与 WebSocket 状态链 | 对应完整对话尚未归档 | `docs/stages/01-设施状态链.md` |
| 6 | `cfb8ff4` | 10-30 | 新增 CSS 3D 选房舞台与穿梭视差，读取真实点位；不是 Three.js 校园场景 | [选房案例](../02_AI对话快照/01_3D选房与穿梭动效/对话记录.md) | `frontend/room-stage.js`、`frontend/room-stage.css` |
| 7 | `1e75706` | 10-30 | 同步选房状态并修复桌面与触屏交互 | [10-30 快照](../docs/ai-sessions/2026-10-30.md) | `README.md`、`tests/room-stage-browser.cjs` |
| 8 | `df3f531` | 10-30 | 阶段 02：保存现场事实、轮次与可追溯证据 | 阶段完整对话尚未归档 | `backend/evidence.py`、`backend/storage.py`、`tests/test_stage02.py` |
| 9 | `4619e0a` | 10-30 | 阶段 02：仅在事务提交成功后返回存储证据 | 阶段完整对话尚未归档 | `backend/evidence.py`、`tests/test_storage_failure_receipts.py` |
| 10 | `8116fad` | 10-30 | 阶段 02：增加记录与证据浏览界面 | 阶段完整对话尚未归档 | `frontend/evidence-browser.js`、`frontend/app.js` |
| 11 | `c98ea77` | 10-30 | 阶段 02：保留轮次保存结果并修复证据浏览状态 | 阶段完整对话尚未归档 | `frontend/evidence-browser.js`、`tests/evidence-browser.test.mjs` |
| 12 | `b293b52` | 10-30 | 阶段 02：将轮次创建与存储自检入口置于证据结果之前 | 阶段完整对话尚未归档 | `frontend/app.js`、`frontend/evidence-browser.js` |
| 13 | `41ed359` | 10-30 | 阶段 02：补充重启留存及页面失败恢复验证脚本 | 阶段完整对话尚未归档 | `tests/stage02-browser.cjs`、`tests/stage02-integration.cjs` |
| 14 | `1f60f42` | 10-30 | 阶段 03：建立固定轮次覆盖计算与更正记录边界 | 阶段完整对话尚未归档 | `backend/coverage.py`、`tests/test_stage03_coverage.py` |
| 15 | `7d42e90` | 10-30 | 阶段 03：实现 T1—T5 依赖判断、S1 运行及完成后的快照保护 | 阶段完整对话尚未归档 | `README.md`、`backend/judgment.py`、`backend/runs.py`、`tests/test_stage03_runs.py` |
| 16 | `dea4977` | 10-30 | 阶段 04：增加 S2／S3 独立场景、阻塞证据和候选方案可行性判断 | 阶段完整对话尚未归档；本会话现已确认验收通过 | `backend/feasibility.py`、`config/plans.json`、`tests/test_stage04.py` |
| 17 | `71203a2` | 10-30 | 阶段 04：展示阻塞依据、方案状态与运行对比 | 阶段完整对话尚未归档；本会话现已确认验收通过 | `frontend/planning-view.js`、`frontend/task-workbench.js`、`tests/stage04-browser.cjs` |
| 18 | `d539318` | 10-31 | 阶段 05：任务关联复核、现场补证、超时取消、版本检查与新运行，保留旧快照 | 10-31 节选（`78c16f7:docs/ai-sessions/2026-10-31.md`）；本会话现已确认阶段 05 通过 | `backend/reviews.py`、`frontend/review-workbench.js`、`tests/test_stage05_reviews.py`、`tests/stage05-integration.cjs` |
| 19 | `c7da410` | 10-31 | 接通 HTTP 启动快照和 WebSocket 断线接续，处理竞态、身份核对与过期 | 10-31 节选（`78c16f7:docs/ai-sessions/2026-10-31.md`） | `frontend/realtime.js`、`tests/realtime.test.mjs` |
| 20 | `b743e5c` | 10-31 | 封闭校园与八个真实点位房间、可编辑和压缩 GLB、立面检查页与模型重建 | 10-31 节选（`78c16f7:docs/ai-sessions/2026-10-31.md`），原创设计示意，待统一视觉验收 | `frontend/twin/`、`frontend/assets/campus/`、`frontend/campus-review/`、`scripts/build-campus-assets.mjs`、对应分支 `README.md` |
| 21 | `babcbff` | 2026-11-01 | 接通 T5 多源串行分析、S4 推演、S5 限制结论、照片辅助摘要和本地语音接口，保留冻结运行 | 本会话可回溯；本次未新增对话快照或案例文档 | `backend/analysis*.py`、`backend/what_if.py`、`backend/degradation.py`、`backend/photo_description.py`、`backend/speech.py`、`config/`、`tests/test_stage06_*.py`、`tests/test_stage07.py`、`tests/test_stage08_acceptance.py` |
| 22 | `9a42769` | 2026-11-01 | 调整建筑构图、校园绿化、PBR 材质和房门入口；保存 Blender、GLB 及材质来源，加入有效远程告警提示 | 本会话可回溯；本次未新增对话快照或案例文档 | `art/campus/campus-environment.blend`、`frontend/twin/`、`frontend/assets/campus/`、`scripts/build-campus-assets.mjs`、`tests/campus-scenes.test.mjs`、`tests/campus-alerts.test.mjs` |
| 23 | `aea6c6a` | 2026-11-01 | 整合总览／覆盖／任务／证据／分析五分区，接通真实运行和补证操作，保留共享筛选与 3D 画布 | 本会话可回溯；本次未新增对话快照或案例文档 | `frontend/board-shell.js`、`frontend/board-masonry.js`、`frontend/board.css`、`frontend/app.js`、`tests/campus-workbench-browser.cjs`、`tests/stage07-browser.cjs` |
| 24 | `491e0cf` | 2026-11-01 | 建立同源查询与巡检复核小程序工程；AppID／语音服务未配置时保留明确限制 | 本会话可回溯；本次未新增对话快照或案例文档 | `miniapp/`、`scripts/configure-miniapp.cjs`、`tests/miniapp.test.cjs`、`tests/stage08-miniapp-http.cjs` |

以上是阅读索引，原始 commit message 不作改写。对于尚未整理的对话证据，明确记录缺口；源码与测试入口可以核查实现，不替代原始聊天截图。

## 辅助工程与归档记录

部署、历史提示词和归档记录保留在真实历史及 graph 日志中，不删除，也不当作核心功能开发数量。本次只更新 Git 日志三件套。

| 提交 | 日期 | 实际内容 |
| --- | --- | --- |
| `a8480d4` | 2026-10-28 | docs: 按要求删除 2026-10-28 AI 对话快照 |
| `eec5a5c` | 2026-10-28 | docs: 恢复 2026-10-28 AI 对话快照 |
| `1abac21` | 2026-10-29 | docs(ai-sessions): 归档 2026-10-29 对话截图 |
| `7b2c8ec` | 2026-10-30 | docs(prompts): 归档前端复刻与 React Bits 动效提示词 |
| `f5bb32b` | 2026-10-30 | docs(git): 建立提交日志索引与导出 |
| `f572134` | 2026-10-30 | docs(ai-snapshot): 归档 2026-10-30 选房动效截图与案例 |
| `07753b5` | 2026-10-30 | docs(git): 补记提交索引与导出日志 |
| `5a103ba` | 2026-10-30 | feat(deploy): 添加正式 Release 部署入口与失败回退 |
| `6130d21` | 2026-10-30 | docs(deploy): 归档 Release 部署交接与提交索引 |
| `5f010d3` | 2026-10-30 | docs(ui): 记录前端同步验证与当日对话 |
| `04a8c11` | 2026-10-30 | docs(git): 整理功能与辅助索引并补齐阶段提交记录 |
| `f71e194` | 2026-10-31 | docs(prompts): 归档校园三维与智能增强需求材料 |
| `a126a15` | 2026-10-31 | docs(ai-sessions): 归档Web纠偏案例与10月31日对话记录 |
| `78c16f7` | 2026-10-31 | docs(git): 更新阶段05与三维校园提交索引 |

## 提交节奏说明

- 2026-11-01 按用户要求集中提交当前已积累的项目改动，按后端能力、3D 场景、工作台和小程序四个功能边界保存。提交时间表示实际保存时间，不声称这些功能都在提交瞬间完成。
- 后端统一入口、存储初始化及运行契约存在依赖，因此与分析、推演和补证辅助模块成组提交，没有为增加数量拆散共同调用路径。
- 保留 10-30、10-31 的集中提交事实及全部早期提交。没有重写、删除、回填时间或空提交。
- 当前首末跨度 5 天、覆盖 6 个日期，尚未达到规范“跨度 ≥15 天、覆盖 ≥10 个日期”的门槛；后续仅按真实工作积累。

## 本轮验证与实际边界

| 验证 | 结果与范围 |
| --- | --- |
| Python 隔离测试 | 388 项通过；覆盖 API、轮次与冻结运行、复核、分析降级、推演、照片辅助摘要、语音输入校验等。本次未调用收费 AI 端点，测试数据在独立目录 |
| Node 本地测试 | 93 项通过；覆盖前端投影、实时状态、3D 场景、告警、小程序、语音草稿等 |
| 此前本轮 Chrome 工作台流程 | 6 组通过；实际鼠标／键盘流程、共享筛选、现场记录、照片、复核和历史 |
| 此前本轮 Chrome 阶段 07 流程 | 6 组通过；S4 推演、S5 限制、C03 补证及旧运行保留 |
| 此前本轮页面只读检查 | 1440／1200／1024／768／440／390 六种宽度、五个工作区布局通过；不是实机性能测试 |
| 提交检查 | 核对分组文件清单；未发现明显私钥／令牌格式；`.env.example` 的凭据为空。修正两处行尾空白，未改运行逻辑 |
| 未验证范围 | Safari、Firefox、真实手机性能，小程序正式 AppID／语音服务与真机联调；本次没有推送、Release 或云端部署 |

Python 有一条现有 Starlette／httpx 弃用提示，测试没有失败。测试输出、截图仅留本机，不提交运行数据库。

本机复核位置（不随仓库发布）：

- `.runtime/git-verify-20261101-233143/pytest.txt`：本次 388 项测试输出。
- `.runtime/git-node-verify/node-tests.txt`：本次 93 项测试输出。
- `.runtime/campus-workbench/flow-1793546371621/result.json`：此前本轮工作台浏览器流程。
- `.runtime/stage07-browser/flow-1793545159355/result.json`：此前本轮阶段 07 流程。
- `.runtime/campus-workbench/pinboard-1793546499462/result.json`：此前本轮只读布局与交互核查。

上述本机记录不作为远程克隆的必备输入；对应 `tests/` 与 `scripts/verify_stage08.py` 已提交，可使用独立存储重新验证。

## 未提交／未推送的内容及原因

| 内容 | 原因与恢复／获取方式 |
| --- | --- |
| README 与其他说明／案例／对话文档的本地修改 | 用户要求排除；本次仅 Git 日志获得额外授权。README 改动原样留在当前工作区 |
| `.env`、供应商凭据、SSH 私钥、注册令牌 | 不进入 Git；按空值 `.env.example` 在服务端另行配置 |
| 真实 SQLite 数据库和上传照片 | 需单独成套备份，不在本次 Git 中公开，不用教学种子替代真实历史 |
| `.venv/`、依赖缓存、浏览器配置、`.runtime/` 测试输出 | 本机产物，按依赖清单、启动脚本与已提交测试重建 |
| 本地语音模型权重 | 由 `Setup-Speech.ps1` / `scripts/setup_speech.py` 校验下载，使用 `requirements-speech.txt`；不把已下载权重提交 Git |
| 原始竞赛资料目录 | `D:\分布式设施巡检与复核` 保持只读，本轮未改动 |
| 新建或更新的 AI 对话快照 | 本次未获快照归档任务，未补写对话或加入无关图片；后续使用真实资料单独整理 |
| 当前功能分支远程同步 | 本次只做本地提交，没有推送／合并／发布；需要另行执行才能更新 GitHub 或云端 |

运行需要的知识库来源 JSON、明确标为模拟样本的 ML 数据与模型、三个 3D 资产、材质及来源记录均已提交。Blender 源文件约 53.69 MiB，可编辑 GLB 约 35.59 MiB，压缩 GLB 约 16.08 MiB；保留源资产用于复现，克隆与推送体积会增加。它们是设计展示资源，不是现场照片或实时设施证据。

## 日志导出与核对

- `git-log-graph.txt`：全部本地分支及现有远程引用，38 条；包括其他分支的归档记录。
- `git-log-oneline.txt`：当前 `feat/campus-twin` 可达历史，34 条。
- 两份文件使用 Git 原始输出、UTF-8，不手工删改部署或归档记录。graph 中分支连线的行末空白保留原样，并用逐字对比验证；手写索引和 oneline 另作空白检查。
- 自身日志提交不在上述快照内；直接执行 `git log -1` 可检查随后保存这些文件的提交。

```bash
git log --graph --oneline --all --date=short
git log --date=short --pretty=format:"%h %ad %s"
git log --all --date=iso-strict --format="%h %aI %cI %s"
git rev-list --count HEAD
git rev-list --all --count
```
