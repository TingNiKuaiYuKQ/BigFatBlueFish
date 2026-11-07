# settings 模块

目录：`main/modules/settings/`

- `settings.html` / `settings-preload.cjs`：三页签（外观 / 行为 / 指令）
- `settings.mjs`：设置存储（默认值、清洗、原子写入）

## 存储

文件：`main/runtime/app/settings.json`（`paths.SETTINGS_FILE`）。

| 字段 | 说明 |
| --- | --- |
| `theme` | 四个主题色（`uiBg/uiStar/uiEdge/uiText`） |
| `uiScale` | UI 缩放 0.2..3 |
| `proactive` / `freq` | 主动说话开关与频率（low 25% / mid 66% / high 100%） |
| `bind` | 绑定的驾驶员会话 id |
| `fpsCap` | 30 / 60 / 0（0 = 无限制） |
| `autoLowInterrupt` | 全屏自动省电开关 |

写入走临时文件 + rename；读失败退回默认值，绝不影响启动。
