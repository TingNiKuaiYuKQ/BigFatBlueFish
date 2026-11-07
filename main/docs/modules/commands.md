# commands 模块

目录：`main/modules/commands/`

| 文件 | 职责 |
| --- | --- |
| `commands.mjs` | 指令数据、校验、执行器、审计 |
| `shortcuts.mjs` | 旧 `run_shortcut` 白名单兼容（读 `~/.dsh/live2d/shortcuts.json`） |

## 安全模型

1. 运行时参数只以 argv 追加（`shell:false`）；`mode:"shell"` 不接受任何附加参数。
2. 改文件走临时文件 + rename，并留 `.bak`。
3. 驾驶员新增/修改/删除必须弹系统确认框，显示完整命令行；拒绝/超时/关窗都不落盘。
4. 最多 20 条；`id` 限 `[A-Za-z0-9_-]{1,40}`。

## 数据与审计

- 数据：`main/config/commands.json`
- 首启迁移源：`main/config/shortcuts.legacy.json`
- 审计：`main/runtime/audit/commands-audit.jsonl`（1MB 轮转）
- 默认 cwd：`main/`

字段说明见 [../config-reference.md](../config-reference.md)。
