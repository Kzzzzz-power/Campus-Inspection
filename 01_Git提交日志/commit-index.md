# 提交索引

**仓库：** https://github.com/Kzzzzz-power/Campus-Inspection-draft

**索引整理日期：** 2026-10-31（Asia/Shanghai）

**当前分支：** main；阶段 02—05 与 3D 保存在各自本地分支，未合并 main，本次未推送。

**首次提交：** 2026-10-27 · `f7995bd`

**标签与远程：** `v0.2.1` → `5f010d3d9bb92d36734982dfb94097ddb2bee019` 是 2026-10-30 通过 `git ls-remote` 核实的历史截点。本次未联网更新远程引用，不将该记录当作远程当前状态。

**统计截点：** 本次保存索引的 docs 提交之前，main = `a126a15`，阶段 05 = `d539318`，3D = `b743e5c`。

**提交总数：** main 20 条；所有本地分支及已有远程引用可达提交去重后共 33 条，覆盖 2026-10-27 至 2026-10-31 共 5 个日期。

**今日提交：** 截点内 5 条，功能代码 3 条、需求与对话归档 2 条；本索引的保存提交不计入自身截点。

> 两份日志与本表记录上述截点，不包含保存本次索引的提交自身。使用真实作者、日期和历史，不 amend、回填日期或补造空提交来追赶自身哈希。

## 阅读方式与分支范围

| 分支 | 截点 | 当前状态 | 相对 main 的新增提交 |
| --- | --- | --- | --- |
| `main` | `a126a15` | 本批仅新增需求材料、AI 归档与日志；无功能合并 | — |
| `feat/stage02-evidence` | `41ed359` | 用户已验收通过 | 6 条 |
| `feat/stage03-task-runs` | `7d42e90` | 用户已验收通过，包含阶段 02 | 累计 8 条 |
| `feat/stage04-feasibility` | `71203a2` | 代码已提交，尚待人工验收；后续用户另行授权阶段 05 与 3D 开发 | 累计 10 条 |
| `feat/stage05-review-chain` | `d539318` | 复核与补证链代码已提交，尚待人工验收 | 累计 11 条 |
| `feat/campus-twin` | `b743e5c` | 接续阶段 05；三维代码与模型已提交，待统一视觉验收 | 累计 13 条 |

各工作区位于项目根目录的 `.runtime/stage02-worktree` 至 `.runtime/stage05-worktree` 及 `.runtime/twin-worktree`，属于同一 Git 仓库。父目录被忽略不表示这些分支源码未保存。可用 `git show <提交>:<文件>` 检查对应树；分支文件不一定存在于当前 main。**本次没有推送；仅从 GitHub 克隆当前 main 不能取得这些本地功能分支的新增代码。**

阶段 05 与 3D 原先基于同一阶段 04 截点：本次先保存阶段 05，然后在备份、逐文件哈希核对后将 3D 分支快进至该提交，再提交三维差异，避免重复记账。全部原有提交、标签和 Release 均保留。阶段验收状态来自本会话用户确认，不冒充完整对话归档。

## 关键功能提交与证据对应

部署、提示词和归档提交移至下一节，原始 Git 历史和文件保持完整。下表是中文阅读索引，不改写原始 commit message。

| # | 提交 | 日期 | 做了什么 | 对话案例 | 技术文档／源码与验证入口 |
| --- | --- | --- | --- | --- | --- |
| 1 | `f7995bd` | 10-27 | 初始化巡检工作台并保留首日 AI 对话快照 | [10-27 快照](../docs/ai-sessions/2026-10-27.md) | `README.md`、`AGENTS.md` |
| 2 | `d67506d` | 10-28 | 完成日间 Web 界面打磨；原提交同时包含当日快照，保留历史事实 | [10-28 快照](../docs/ai-sessions/2026-10-28.md) | `frontend/`、`docs/evidence/` |
| 3 | `d26a6c6` | 10-29 | 接入玻璃界面与楼栋／楼层筛选浮层 | [Web 纠偏案例](../02_AI对话快照/01_Web前端与动态特效多轮纠偏/说明.md) | `docs/evidence/glass-ui-2026-10-29/` |
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
| 16 | `dea4977` | 10-30 | 阶段 04：增加 S2／S3 独立场景、阻塞证据和候选方案可行性判断 | 阶段完整对话尚未归档；用户待验收 | `backend/feasibility.py`、`config/plans.json`、`tests/test_stage04.py` |
| 17 | `71203a2` | 10-30 | 阶段 04：展示阻塞依据、方案状态与运行对比 | 阶段完整对话尚未归档；用户待验收 | `frontend/planning-view.js`、`frontend/task-workbench.js`、`tests/stage04-browser.cjs` |
| 18 | `d539318` | 10-31 | 阶段 05：任务关联复核、现场补证、超时取消、版本检查与新运行，保留旧快照 | [10-31 节选](../docs/ai-sessions/2026-10-31.md)，待人工验收 | `backend/reviews.py`、`frontend/review-workbench.js`、`tests/test_stage05_reviews.py`、`tests/stage05-integration.cjs` |
| 19 | `c7da410` | 10-31 | 接通 HTTP 启动快照和 WebSocket 断线接续，处理竞态、身份核对与过期 | [10-31 节选](../docs/ai-sessions/2026-10-31.md) | `frontend/realtime.js`、`tests/realtime.test.mjs` |
| 20 | `b743e5c` | 10-31 | 封闭校园与八个真实点位房间、可编辑和压缩 GLB、立面检查页与模型重建 | [10-31 节选](../docs/ai-sessions/2026-10-31.md)，原创设计示意，待统一视觉验收 | `frontend/twin/`、`frontend/assets/campus/`、`frontend/campus-review/`、`scripts/build-campus-assets.mjs`、对应分支 `README.md` |

验证入口说明如何检查相应提交；各阶段人工验收与自动测试分开。本次新检查与既有报告范围见下方“日志导出与自检”。

## 辅助工程与归档记录

这些提交属于项目复现、部署或过程证据，不作为核心业务功能迭代计数，但保留在真实历史和日志导出中。

| 提交 | 日期 | 类别与实际内容 | 保留理由／对应文件 |
| --- | --- | --- | --- |
| `a8480d4` | 10-28 | 按用户当时要求删除 10-28 快照 | 保留真实操作轨迹，不掩盖删除行为 |
| `eec5a5c` | 10-28 | 按随后要求恢复 10-28 快照 | 与上一条一起说明恢复过程；`docs/ai-sessions/2026-10-28.md` |
| `1abac21` | 10-29 | 归档当日 AI 对话截图 | 竞赛过程证据；`docs/ai-sessions/2026-10-29.md` |
| `7b2c8ec` | 10-30 | 归档前端复刻与动效提示词 | 保留需求来源；`anim-audit/` |
| `f5bb32b` | 10-30 | 建立提交索引和两份日志导出 | 竞赛要求的提交证据；`01_Git提交日志/` |
| `f572134` | 10-30 | 归档选房截图与 AI 对话案例草稿 | 截图式证据与完整会话有区别；`docs/ai-sessions/2026-10-30.md`、`02_AI对话快照/` |
| `07753b5` | 10-30 | 补记索引与日志快照 | 保留当时的导出截点 |
| `5a103ba` | 10-30 | 实现 Release 部署、维护写入保护与失败回退 | 真实功能代码；`.github/workflows/release-deploy.yml`、`deploy/`、`tests/test_release_deploy.py` |
| `6130d21` | 10-30 | 归档 Release 部署交接与索引 | 部署过程证据，保留当时“待首次验证”的历史语义 |
| `5f010d3` | 10-30 | 记录前端同步检查与当日文字节选 | README 与归档；远程 main、v0.2.1 的已核实截点 |
| `04a8c11` | 10-30 | 整理功能与辅助索引并补齐阶段提交记录 | 保留上一版日志快照及“不改历史”裁决 |
| `f71e194` | 10-31 | 归档六份校园三维与智能增强提示词原文件 | `docs/`；需求参考不等于全部功能已实现 |
| `a126a15` | 10-31 | 归档已有 Web 纠偏截图案例及本日文字节选 | `02_AI对话快照/`、`docs/ai-sessions/2026-10-31.md`；不补造聊天或验收 |

## 提交节奏说明

- 10-31 按用户要求集中保存已完成改动，依功能边界分成复核链、实时接入和三维场景；归档材料另存。本批提交时间代表实际保存时间，不声称各功能恰在该分钟完成。
- 10-30 的 19 条提交以及全部早期英文或混合范围提交均保留，不通过重写历史改善表面规范。早期语义通过本索引解释。
- 截点覆盖 5 个日期，首末相隔 4 天；仍未达到指南“跨度 ≥15 天、覆盖 ≥10 个不同日期”的要求。后续仅随真实工作积累，不凑数或回填。
- 提示词、构建资产和历史 Web 案例的归档不等于功能验收。阶段 06—08 不在本批完成范围。

## 未提交／未推送的内容及原因

| 内容 | 原因与获取方式 |
| --- | --- |
| 本地功能分支 | 源码和模型已入本地 Git，但本次未推送／合并；正式交付前须核对验收范围并另行同步远程 |
| `.workbuddy-ai/` | AI 工具内部记忆，保留未跟踪；不是项目运行源码 |
| `.venv/`、`.runtime/` 中运行产物与缓存 | 按忽略规则保留，包括独立测试数据库、浏览器截图、Chrome 配置、工作副本备份；不作为 Git 发布资产 |
| 真实数据库和上传照片 | 不提交；恢复已有记录需单独成套备份，不用教学种子冒充历史 |
| 完整 AI 会话与尚缺的人工验收 | 今日文件是原文节选和已有截图索引，不补造完整导出；阶段 04／05 和本轮 3D 的人工验收仍待完成 |
| 全屏原件中的其他项目内容 | 编辑案例只提交经授权裁切的证据和标明编辑排版的对照图；全屏原件留在本机 |
| 原始竞赛资料 `D:\分布式设施巡检与复核` | 按用户要求只读，未写入或改动 |
| 私钥、注册令牌、部署安装包与服务器数据 | 不提交；部署代码的历史仍在，当前提交未触发 Release 或云端更新 |

六份 docs 提示词、Web 案例裁切图、原创模型、可编辑 GLB、压缩 GLB、HDR 及其来源许可已归档。模型与灯光素材是展示资源，不是现场巡检证据。

## 日志导出与自检

- `git-log-graph.txt` 使用 `git log --graph --oneline --all --date=short`，截点共 33 条。
- `git-log-oneline.txt` 使用 `git log --date=short --pretty=format:"%h %ad %s"`，只导出当前 main 的 20 条；功能分支见 graph 与上方索引。
- 所有日志使用 Git 实际输出、UTF-8 编码，不删部署或归档行。引用哈希、分支可达关系、源码树与日志计数在提交前核对。
- 本次重新运行阶段 05 后端测试 **228 项通过**；三维分支前端单元 **45 项通过**。后端有 Starlette／httpx 弃用提示，无失败。
- 已有校园 24 项、立面 19 项、复核 6 项浏览器报告为 passed，本次只读取核对，未重跑；不作为全浏览器或实际手机性能承诺。
- 两份校园 GLB 与模型源文件均和 manifest 哈希一致。第三方源码原始缩进及部分文件末尾空行保留；排除第三方原文与末尾空行的自有代码空白检查通过。
- 候选文件扫描未发现明显私钥／令牌格式，未发现超过 90 MiB 的新增文件；数据库、上传目录和工具记忆未暂存。扫描不替代凭据管理。
- 本次未查询远程实时状态，未推送、未发布 Release、未部署；本地保存与线上生效明确区分。

~~~bash
git log --graph --oneline --all --date=short
git log --date=short --pretty=format:"%h %ad %s"
git log --all --date=iso-strict --format="%h %aI %cI %s"
git rev-list --count main
git rev-list --all --count
git show feat/stage05-review-chain:backend/reviews.py
git show feat/campus-twin:frontend/assets/campus/campus-design-manifest.json
~~~
