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

省电模式期间 `behavior.stop()`，只保留引擎自带的呼吸/眨眼；退出时 `start()`。待机动作事件带 `prio=1`，驾驶员/用户事件优先。

## 测试

```bash
node 其他/tests/sequence.test.mjs
```
