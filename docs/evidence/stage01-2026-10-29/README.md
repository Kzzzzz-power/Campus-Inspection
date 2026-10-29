# 阶段 01 验收证据

- `backend-tests.txt` / `.xml`：70 项后端测试，0 失败。
- `frontend-tests.txt`：17 项 Node 测试通过。
- `result.json`：真实 Broker → 独立 MQTT 探针 → HTTP → WebSocket → 浏览器的 11 项检查通过。包括深层坏 JSON 后正常消息继续到达、断线/过期/重连、后端重启、表单保留及响应式。
- `stage01-390.png`、`stage01-768.png`、`stage01-1440.png`：实际 Chrome 页面截图，已人工查看移动端和桌面，不是生成效果图。
- `launcher-result.json` / `launcher-reconnect-result.json`：启动器、retained、输入校验、关闭清理与重连实测。
- `database-before.json` / `database-after.json`：真实数据库哈希相同。

本目录只证明阶段 01 状态链，不证明正式轮次、完整 S1、T1–T5 或后续阶段。测试使用模拟设备数据和隔离数据库，不是真实设施检查。1 条既有 Starlette/httpx 弃用提示保留。
