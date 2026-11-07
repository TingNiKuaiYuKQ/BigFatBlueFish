# WorkBuddy 插件（占位）

0.6.0 不实现。约定：

- 与 `pet-bridge` 平级，独立安装目录与 `data/`。
- 只通过 `~/.dsh/live2d/` 之外的握手文件（由配置 `driver.stateFile` / `driver.endpointFile` 指定）与桌宠通信，不改桌宠代码。
- 复用 `/api/*` 协议；token 从 endpoint 文件读。

TODO：确认 WorkBuddy 的插件加载机制与 profile 路径后再落地。
