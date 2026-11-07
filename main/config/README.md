# 配置目录

| 文件 | 职责 |
| --- | --- |
| `config.json` | 设计参数：端口、窗口、性能、模型、姿势、状态映射、菜单、行为、动作 |
| `commands.json` | 快捷指令库（最多 20 条），设置页与驾驶员共用 |
| `shortcuts.legacy.json` | 0.5 之前的白名单，只在 `commands.json` 缺失时首启迁移 |

宁可改配置也不要改代码：换模型、换表情映射、调行为节奏都在这里。

字段说明见 [../docs/config-reference.md](../docs/config-reference.md)。
手改后重启桌宠生效；运行期偏好（主题、绑定会话、帧率）在 `runtime/app/settings.json`，不要写到这里。
