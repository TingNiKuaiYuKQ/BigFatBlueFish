# DSH 宿主契约（索引）

插件侧的唯一完整说明在：

- [../../plugins/dsh/docs/DSH-API.md](../../plugins/dsh/docs/DSH-API.md)

这份索引只列维护者最常查的几件事：

1. **握手**：桌宠（node 启动器）把 `endpoint.json` 镜像到 `~/.dsh/live2d/`；插件只读，不猜端口。
2. **状态投影**：插件把 `session/event` 归约成 `status.json`，零 token；桌宠每 200ms 轮询。
3. **反向调用**：插件用 `x-stage-token` 调 `/api/say`、`/api/sequence`、`/api/commands/*`。
4. **事件回传**：桌宠写 `main/runtime/app/pet-events.json`，插件轮询后投递到绑定会话，再 `POST /api/events-ack`。
5. **v4 消息形状**：`role:'user'`、`id`、`source.kind` 必须由产出方给定，不能是 `'plugin'`。

插件安装：`node plugins/install.mjs --apply`，目录联接指向 `plugins/dsh/`；运行数据跟插件目录走（开发时 `plugins/dsh/data/`，安装后在 `<插件根目录>/pet-bridge/data/`）。
