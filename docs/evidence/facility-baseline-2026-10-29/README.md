# 设施基线验证记录

- `backend-tests.txt` / `backend-tests.xml`：本轮实际运行 53 项后端测试，0 失败、0 跳过；包含 20 项新增基线测试和 33 项既有 API 测试。
- `frontend-tests.txt`：4 项前端模型测试通过。本轮不修改前端源码，不据此声称重新完成浏览器视觉验收。
- `database-before.json` / `database-after.json`：真实数据库前后 SHA-256 相同。所有测试写入均位于新项目 `.runtime` 隔离目录。

测试时间、输出与路径均保留真实值；Starlette/httpx 的 1 条弃用提示如实保留。基线属于教学输入及配置层，不是完整 S1 任务引擎验收。详见 ../../baselines/01-设施配置与已确认告警.md。
