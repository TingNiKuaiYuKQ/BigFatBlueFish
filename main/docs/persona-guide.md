# 蓝汐 · 蓝色大肥鱼

Live2D 桌宠人设卡。一套「人设 + 默认行为规划」，换这个目录就能换桌宠的性格，不动代码。

> 0.6.0 起人设包放在 `main/persona/<id>/`，按 `main/config/config.json` 的 `persona` 字段选择。
> **以下全部以示例人设 `blue-whale-maid` 为例** —— 它是默认人设，也是写人设卡的样板；
> 想快速上手（复制目录、改哪几个字段、常见错误）先看 [`main/persona/README.md`](../persona/README.md)，本文是深入版。

## 文件

| 文件 | 作用 | 谁读 |
| --- | --- | --- |
| `persona.json` | 人设卡。名称、绰号态度、四项道具、口癖、给 LLM 的 `prompt` | 设置页显示 `tagline`；驾驶会话原样注入 `prompt` |
| `behavior.json` | 默认行为规划。规划参数 + 46 条待机小动作 + 15 个事件反应 | `main/modules/behavior/behavior.mjs` 与事件层 |

两个 JSON 都是 UTF-8 无 BOM，可以被 `JSON.parse` 直接吃。

## 怎么被消费

### `behavior.json` → `plan`

`plan` 的字段是 `config.json` 里 `behavior` 一节的「人设版」，覆盖关系：

| behavior.json | config.behavior | 含义 |
| --- | --- | --- |
| `plan.periodMs` | （常量 `HOUR_MS`） | 重新规划的周期，一小时 |
| `plan.gaze.enabled` | `behavior.enabled` 的语义位 | 本小时是否排盯盯段 |
| `plan.gaze.totalMinMs` / `totalMaxMs` | `gazeMinMs` / `gazeMaxMs` | 每小时盯盯总时长区间 |
| `plan.gaze.segMinMs` / `segMaxMs` | `gazeSegMinMs` / `gazeSegMaxMs` | 单段时长区间 |
| `plan.gaze.focusIdleMs` | `focusIdleMs` | 段内鼠标静止多久去探前台窗口 |
| `plan.small.minPerHour` / `maxPerHour` | `smallMin` / `smallMax` | 每小时小动作次数区间 |
| `plan.small.minGapMs` | 常量 `SMALL_GAP_MS` | 两个小动作之间的最小间隔 |

### `behavior.json` → `idleActions`

取代 `config.behavior.smallMotions` 那张只有三个名字的固定表。每条：

- `hours`：小时数组（0-23）。**空数组 = 全天可用**。小时不匹配就不参与抽取，所以深夜和清晨是两套完全不同的动作。
- `weight`：1-5，同一时刻命中的所有条目按权重加权随机。
- `mood`：命中的 `moods` 键（可为 `null`）。`moods[*].extraExpression` 是这一时段叠加的底色表情。
- `action`：`kind` 只取四种 —— `motion`（配 `name`）、`pose`（配 `name`）、`animation`（配 `name`）、`cue`（配 `cue` 串）。
  **名字只能来自 `config.json` 的 `motions` / `poses` 与原生 Animation 清单，不能自创**。
- `say`：可选，0-3 条，随机挑一句，走气泡通道，不占动作通道。
- `bubbleMs`：气泡停留时长。

### `behavior.json` → `reactions`

键是事件名，`steps` 是按序播放的 cue 串（走 `lib/sequence.mjs` 那套语法层），`say` 随机挑一条。
到渲染层后由 `claim` 按优先级仲裁 —— 0 档的驾驶员/交互事件会自然压掉这里的 1 档事件，这正是「可被覆盖」的形态。

已实现：`onTaskStart` `onTaskError` `onTaskLong` `onTaskSuccess` `onUserPraise` `onUserTease` `onUserIgnore` `onNickname` `onMorning` `onLateNight` `onScreenStare` `onSkirtChange` `onTailTouch` `onHungry` `onGreet`。

## 时段设计

| 时段 | 小时 | 基调 | 代表动作 |
| --- | --- | --- | --- |
| 清晨 | 5-8 | 刚醒、饿、顶盆等饭 | `dawn-wake` `bowl-breakfast` |
| 上午 | 9-11 | 认真工作 | `monocle-focus` `idea-glasses` |
| 午间 | 12-14 | 吃饭、护盆、饭后困 | `rice-time` `nap-noon` `look-noon` |
| 下午 | 15-17 | 干活 + 偷闲挑逗 | `grass-tease` `monocle-stare` |
| 傍晚 | 18-20 | 晚饭、被夸会慌 | `dinner-bowl` `shy-evening` |
| 深夜 | 21-23 | 犯困硬撑 | `yawn-late` `doze-late` |
| 凌晨 | 0-4 | 打瞌睡、半夜灵感、偷吃饭 | `doze-late` `midnight-idea` |
| 全天 | — | 低权重的呼吸级小动作 | `all-day-shift` `all-day-blink` |

## 道具触发

| 道具 | 触发 | 收回 |
| --- | --- | --- |
| 钢盆（cue `钢盆`） | 被压任务、被骂、自己任务出岔子；也当饭碗（清晨/午间/傍晚/半夜偷吃） | `-钢盆`（任务成功时摘） |
| 狗尾巴草（cue `狗尾草`） | 想逗用户、情绪上头、闲得慌；配 `动作:狗尾草晃动` | 回到 `default` 姿势 |
| 单片眼镜（cue `单片眼镜`） | 认真做任务、认真盯用户在干什么 | `-单片眼镜`（一段结束） |
| 黑框眼镜（cue `黑框眼镜`） | 想到办法/灵感，同时 `竖手指` 抬左手比划 | 讲完放下手、摘镜 |

## 动作编排与流畅度

单人动作好写，**交接**才是难点。完整规则、判定数字与自测配方在
[`main/persona/README.md` §4「怎么把动作写顺」](../persona/README.md)，这里只记本卡相关的四条：

1. **一条 cue 串只引一个 `动作:`**，两段动作分两步演。
2. **`steps[].after` 给 600~1400ms**：它是"之后等多久"，不是"演多久"。贴太近会看到上一步的残差被硬收。
3. **首末关键帧写 0**：动作是增量，末帧停在非零值就等于把角色按偏了。
4. **别给开关类参数补过渡**：`Movement1/2/3`、`Param55/56/58` 由原生动画写，瞬切是素材决定的；
   `尾巴开关`、`裙子切换` 这类纯配件切换本来也不需要过渡。

判定口径（用 `main/modules/ui/renderer.js` 的 `/api/debug/frames` 自测）：
单帧 `mx` < 1.0、`jumpRatio` < 2.5、`freezeMax` < 3。

## 扩一条自己的动作

1. 在 `idleActions` 里加一条，`id` 起个能读的名，`hours` 写想出现的时段，`weight` 给 2-3。
2. `action` 优先用 `cue`，一句话能把表情 + 头部 + 幅度写完，最短路径。
3. 台词 ≤ 20 字，宁可土一点也不要客服腔。
4. 跑一遍 `node -e "JSON.parse(require('fs').readFileSync('behavior.json','utf8'))"` —— 逗号掉了整个文件就哑了。

## 注意

- `cue` 里的词必须出自语法层词汇表；写错的词会被跳过而不是整条失败，表现为「动作只做了一半」。
- `pose` 手臂类（`grass` / `finger`）依赖原生切换动画才有手臂位，单独切姿势手指会出现但手臂不转。所以本卡里涉及手臂的动作一律走 `cue`（`狗尾草` / `竖手指`），不用裸 `pose`。
- `reactions[*].steps` 最多 24 步、总时长 120s 以内。
- `全时段` 的两条权重是 1：它们是兜底，不该在深夜和午饭时间抢戏。
