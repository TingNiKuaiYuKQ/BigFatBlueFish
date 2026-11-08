# behavior 模块

目录：`main/modules/behavior/`

| 文件 | 职责 |
| --- | --- |
| `behavior.mjs` | 行为状态机：按小时规划「盯盯」段与待机小动作 |
| `cues.mjs` | 文本 cue 语法：解析〔表情/动作/预设〕、台词切分 |
| `sequence.mjs` | 多步序列编排（每步时长、派发、可被新序列顶掉） |
| `persona.mjs` | 人设包加载 + 演出预设（出厂 + 用户态） |

## 人设

- 目录：`main/persona/<id>/`（`paths.PERSONA_DIR`）
- `persona.json` / `behavior.json` / `presets.json`
- 用户态：`main/runtime/app/presets-user.json`
- 选择：`config.json` 的 `persona`

## 行为抑制

省电模式**不再**调用 `behavior.stop()`：待机小动作与盯盯照常跑，省电只降帧率（24）并把角色/气泡调成 50% 透明。真正被挡住的是「主动说话」——事件带 `prio=1`，驾驶员/用户事件优先；省电期间 `gateAndPush` 直接把非 `user-input` 的事件丢掉（固定 0%）。
