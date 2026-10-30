# Release 自动部署（校园项目专用）

本目录接通私有仓库 Kzzzzz-power/Campus-Inspection-draft 的正式 Release 与现有云端容器。阶段 02 及后续业务开发不在本次范围。

## 已有服务器前提

- Ubuntu 24.04 x86_64；Runner campus-inspection-ecs 在线，标签 campus-inspection。
- Runner 用户 campus-runner；Git 用户 campus-deploy；两者均不加入 Docker 组。
- /opt/campus-inspection/source 的 origin 为 git@github.com:Kzzzzz-power/Campus-Inspection-draft.git，原有只读 Deploy key 保留。
- 当前容器 campus-inspection 正在运行，挂载 /opt/campus-inspection/data 到 /data；宿主机仅开放回环 8001。
- GreenMate 使用回环 8000，本部署入口不操作它。
- 基础镜像 public.ecr.aws/docker/library/python:3.11.17-slim-bookworm 已缓存在本机。Docker Hub 不通时仍可构建。
- 原 build-cache/app 和 build-cache/broker 中的 wheels 可复用；新增锁定依赖从清华 PyPI 镜像补齐。

## 一次性安装

将本目录打包上传后，核对 SHA256。在 root 终端对审核过的本目录执行：

```bash
bash install.sh
```

安装器只复制固定入口与构建配方、添加一条 sudoers 命令权限，不启动或替换容器。
成功输出 CAMPUS_RELEASE_ENTRYPOINT_READY。

入口：/usr/local/sbin/campus-release-deploy（root 所有，隔离模式 Python）。
构建配方：/usr/local/lib/campus-inspection/。
授权：/etc/sudoers.d/campus-release。
参数仅接受 vMAJOR.MINOR.PATCH 和完整 40 位小写提交 SHA；不能传路径、任意命令或 prerelease 标签。
即使只有这一命令，发布者仍能够把应用代码部署到演示服务器，仓库写入/发布权限只给可信协作者。

## 正式发布前

1. 将 .github/workflows/release-deploy.yml、本目录、backend/main.py 中的维护写入保护以及测试提交并推送。
2. 标签必须包含上述提交，且提交必须属于 origin/main 的历史。旧草稿若已绑定旧标签，使用新版本标签，不能移动已发布标签。
3. 确认 Runner Idle；服务器安装器成功；工作区待发布改动已明确提交。
4. 发布正式 Release（不是 draft，不是 prerelease），例如 v0.2.1。
5. 到 Actions 查看 Deploy campus Release。修改发布说明、只推送 main 都不部署。
6. Actions 成功后，在服务器读取 active-release.json，核对完整 SHA；通过 SSH 隧道打开页面验证。
7. 首次云端实测完成前不宣称自动部署已经验收。

工作流不 checkout 或执行 Runner 工作区中的部署脚本，不依赖第三方 Action，不上传服务器 root 密码或私钥。
Release 事件的 tag/SHA 通过环境变量传给固定入口，入口再从固定远程仓库核对，不使用最新 main 代替 Release。
Github concurrency 不取消正在进行的部署；本机文件锁另防并发。短时间发布多个版本时 GitHub 可能替换尚未运行的等待任务，发布者应等本次部署结束再发布下一版。

## 更新顺序与数据保护

1. 校验参数、原容器、挂载、未完成部署标记及剩余空间。
2. 拉取指定 tag 和 main，校验标签解析到事件 SHA，检查其属于 main。
3. 导出代码到独立 release-builds 目录；拒绝符号链接、特殊文件和路径穿越，不打包本地数据库或上传照片。
4. 在非 root 限额容器中准备 wheels，两个依赖环境保持独立；离线构建。
5. 在无网络、无正式数据挂载的限额容器中运行后端测试，以普通 Runner 用户运行前端单元测试。
6. 创建写入维护标记，停止旧容器，成套备份数据库和照片，再重命名保留旧容器。
7. 启动新容器：限制资源、去除 capabilities，挂载同一独立数据目录；维护期间 GET 可读，POST/PUT/PATCH/DELETE 返回 503。
8. 检查容器健康、8001 健康接口与维护写入拒绝行为；记录 active-release.json 后开放写入。
9. 若在开放写入前失败，保留失败数据，恢复备份并启动旧容器。若回退失败，保留维护和 pending 标记，禁止继续自动部署。

新版本更新存在短暂不可用和只读窗口，不承诺零停机。
开放写入后不自动恢复旧数据，避免覆盖新记录。后续运行异常要人工处理。
维护开关仅在部署容器设置 INSPECTGO_MAINTENANCE_FILE=/control/readonly；本地不设此变量时原行为不变。
首次从旧手动部署版本升级时，旧版本没有维护开关；在停止旧容器之后才制作备份。

## 验证与排错

```bash
cat /opt/campus-inspection/active-release.json
docker inspect --format '{{.State.Health.Status}}' campus-inspection
curl -fsS http://127.0.0.1:8001/health
docker logs --tail 60 campus-inspection
```

Actions 中日志应包含后端/前端测试成功，最后输出 DEPLOYED 与 tag、完整 SHA。
ROLLBACK_OK 表示本次新版本部署失败，但旧容器与旧数据恢复成功；Actions 仍标记失败，不能冒充部署成功。
ROLLBACK_REQUIRES_OPERATOR 表示需要人工恢复，先检查：
- /opt/campus-inspection/deployment-pending.json
- /opt/campus-inspection/control/readonly
- pending 中指定的备份目录（data 为升级前，failed-data 为失败现场）
- 旧/新容器状态及日志

不要直接删除 pending、维护标记或备份来强行重跑；先确认容器版本、数据库结构和照片一致，再进行人工恢复。
进程被 SIGKILL、服务器断电或磁盘损坏不属于可保证自动回退的范围；保留的 journal 用于恢复。
如果新镜像对数据结构有迁移，首次发布必须先使用备份数据演练，不能只依赖镜像回滚。
脚本保留构建目录、旧容器、镜像和备份，不自动删除历史；定期检查磁盘。剩余空间不足时在停服务前拒绝部署。

## 信任与安装边界

Runner 不持有 root 密码、不读取 Git Deploy key、不直接访问 Docker socket。
固定入口通过 campus-deploy 调用 Git，通过 campus-runner 执行 Node 测试；Docker 下载与应用运行使用 UID 10001。
安装器将项目父目录改为 root 所有，但不递归改变 source/data 所有者。
运行入口和构建配方不会自动从待发布代码覆盖自身；改动这些文件后需重新审核并执行一次安装器。
工作流仅允许本私有仓库正式 Release；仓库改成公开会停止此部署 job。

本地验收：Python/pytest 单元与故障注入、现有 API 回归、Node 单元、Bash 语法检查。
本机没有 Docker，Linux 构建、真实回退和公网 GitHub 执行仍需服务器实测。
