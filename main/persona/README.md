# 人设包（persona）

`main/persona/<id>/` 一个目录就是一张人设卡。换目录 = 换性格，**不用改任何代码**。

`blue-whale-maid` 既是默认人设，也是最完整的示例 —— 想写自己的，直接抄它。

```
main/persona/
├─ README.md              ← 本文件
└─ blue-whale-maid/       ← 一个包 = 一个目录
   ├─ persona.json        是谁
   ├─ behavior.json       闲着时做什么
   ├─ presets.json        成套演出
   └─ README.md           包内速记
```

选哪个由 `main/config/config.json` 的 `persona` 字段决定（值是目录名）：

```json
{ "persona": "blue-whale-maid" }
```

---

## 1. 三个文件各管什么

| 文件 | 作用 | 谁读 | 必填 |
| --- | --- | --- | --- |
| `persona.json` | 名字 / 绰号 / 称呼 / 性子 / 道具 / 口癖 / 给模型看的 `prompt` | 设置页显示 `tagline`；接 DSH 时把 `prompt` 原样注入会话 | 是 |
| `behavior.json` | 待机行为规划（`plan`）+ 待机小动作（`idleActions`）+ 心情（`moods`）+ 事件反应（`reactions`） | `main/modules/behavior/behavior.mjs` | 是 |
| `presets.json` | 出厂演出预设（一套多步的「表情 + 动作 + 台词」） | 舞台的预设播放器；模型可用 `预设:名字` 引用 | 否（缺了就是没有预设） |

三个都是 UTF-8 无 BOM 的 JSON，必须能被 `JSON.parse` 直接吃。

---

## 2. 字段速查（只列实际存在的）

### `persona.json`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | 数字 | 目前是 `1` |
| `id` | 字符串 | **必须与目录名一致** |
| `name` | 字符串 | 正式名字，气泡与设置页都用它 |
| `nickname` | 字符串 | 用户给她起的外号 |
| `nicknameAttitude` | 字符串 | 被叫外号时的反应（写进 prompt 的语气说明） |
| `callUser` | 字符串数组 | 她怎么称呼用户；第一个是默认 |
| `tagline` | 字符串 | 一句话简介，设置页显示 |
| `traits` / `likes` / `dislikes` | 字符串数组 | 性格、喜欢、讨厌；人设卡自己的备忘，也给写 prompt 时参考 |
| `props` | 对象数组 | 道具：`{id, name, cue, when}`。`cue` 是语法层能识别的词（`钢盆` / `狗尾草` / `单片眼镜` / `黑框眼镜`） |
| `speech` | 对象 | `tone`（语气一句话）/ `fillers`（口癖）/ `forbidden`（明确不要的腔调） |
| `relationships` | 字符串 | 她与用户的关系（写给读者看，也用于 prompt 取材） |
| `prompt` | 字符串 | **真正生效的那段**：接 DSH 时原样作为系统提示注入 |

### `behavior.json`

| 字段 | 说明 |
| --- | --- |
| `version` / `personaId` | `personaId` 要等于 `persona.json` 的 `id` |
| `plan` | 每小时重排一次的规划：`periodMs`、`gaze.*`（盯屏幕的时长区间）、`small.*`（每小时小动作次数） |
| `idleActions` | 数组，每条 `{id, action, weight, hours, mood?, say?, bubbleMs?}`；`action.kind` 用 `cue` / `motion` / `pose` / `expression` |
| `moods` | 心情池：`{hours: [...], extraExpression: "..."}`，按小时命中 |
| `reactions` | 事件反应：`onTaskStart` / `onTaskSuccess` / `onTaskError` / `onUserPraise` / `onNickname` … 每条 `{steps: [cue...], say: [...]}` |

### `presets.json`

| 字段 | 说明 |
| --- | --- |
| `presets` | 数组，每条 `{name, desc, tags, say, steps}` |
| `steps` | 数组，每步 `{cue: "微低头 半睁", after: 900}` —— `after` 是这一步之后等多久（毫秒） |

`cue` 串的语法（词表、`微/大/快/慢` 修饰、`:左` 方向、`×3` 重复、`-脸红` 撤销、`动作:名字` / `预设:名字` 引用）见
`main/docs/persona-guide.md`。

---

## 3. 手把手：写一张自己的人设卡

```powershell
# 1) 复制一份（目录名 = 你要用的 id）
cd main\persona
Copy-Item -Recurse blue-whale-maid my-pet
```

2. 改 `my-pet/persona.json`：
   - `id` 改成 `my-pet`（**必须和目录名一字不差**）；
   - `personaId`（在 `behavior.json` / `presets.json` 里）也跟着改；
   - 改 `name` / `callUser` / `tagline`；
   - **重写 `prompt`** —— 这是唯一会被模型读到的东西，写清「她是谁、怎么说话、什么不做」。
3. 改 `main/config/config.json`：

   ```json
   { "persona": "my-pet" }
   ```

4. 重启桌宠。气泡、待机动作、预设都会换成新卡里的内容。

只改名字和 prompt 也能用：`idleActions` / `presets` 沿用示例的编排不会报错（只要它们引用的 cue 词和动作名在当前模型上存在）。

---

## 4. 怎么把动作写「顺」（流畅动画指南）

> 这一节来自 1.0.0 的动画审计：人设卡里 125 条动作（表情 / 姿势 / 关键帧动作 / 原生动画 / 预设 / 待机小动作 / 事件反应）逐帧测过，
> 下面每条规则都对应一次实测到的跳变。结论先行：**单个动作不难写顺，难的是"交接"** —— 上一段还没收干净，下一段就起手了。

### 4.1 先搞清有几层在写同一个参数

| 层 | 写什么 | 起落怎么过渡 |
| --- | --- | --- |
| 姿势 `pose` | 一组参数（`Movement1/2/3`、`Param56`…）的**绝对值** | 260ms smoothstep |
| 表情 / cue 保持态 | 表情参数、`微低头` `半闭眼` 这类**保持**词 | 表情 120ms、cue 180ms ease-out |
| 动作 `motion` | 关键帧**增量**，加在前两层之上 | 首帧从 0 起步；演完/被顶掉时 170ms 收回 |
| 原生动画（`Animation/`） | 引擎 motion3 曲线（手臂类只能走这条） | 引擎自己播；非切换类播完按基准 500ms 还原 |

**同一个参数不要同时让两层管**：谁最后写谁生效，换手那一帧就是一次跳变。看到"抖一下 / 闪一下"，先查是不是两条路都在写同一个 id。

### 4.2 七条硬规则

1. **动作的首末关键帧必须是 0。** 动作是增量叠加，末帧停在 -6 就等于把角色按偏了，收尾那一下必然是跳。
   词表里的一次性小动作（`点头` `叹气` `吓一跳`…）已经遵守，自己编 `tracks` 时要自己保证。
2. **一条 cue 串里只引一个 `动作:`。** 两个动作同时发会互相顶替，后到的把前一个的残差直接扔掉。
   想连演两段，分成两步（`steps` 里两条）。
3. **两段动作之间留 ≥600ms 的空隙。** 170ms 的收回窗口是给"被顶替"兜底的，不是让你贴着发的；
   贴着发就是"旧的在收、新的在起"，观感是抽一下。
4. **一次性小动作的滑入 ≥120ms。** 60fps 下 80ms 只有 5 帧，单帧要吃 1.7~2.0 个参数单位，看着就"弹"。
   现有词表里 `缩一下` `抖一下` 是 80ms —— 这是刻意做的"脆"，写在自己的卡里时，安静的场景请用 `微/慢` 前缀或拉长关键帧。
5. **不要给"开关类"参数补过渡。** `Movement1/2/3`、`Param55/56/58` 这类 0/1 开关与部件开关由**原生动画**写，
   瞬切是素材曲线决定的，cue 补不了。同理 **`尾巴开关`、`裙子切换` 这类纯配件切换本来就不需要过渡**，别为它加淡入。
6. **预设 / 反应的每一步都要能自己站住。** `steps[].after` 是"这一步之后等多久"，不是"演多久"：
   给到 600~1400ms，让上一步的保持态自然收回去；`after` 太小会看到连续两次跳。
7. **不要用 cue 去救原生动画。** 名字在 `Animation/` 里的动作走引擎通道，播放期间姿势层被冻结；
   这时再发 `pose` 或改 `Movement*` 会互相打架。要配合，就等它播完再发。

### 4.3 什么算"顺"：三个数

审计用的口径，自己也能算（见 4.4）：

| 指标 | 含义 | 过线标准 |
| --- | --- | --- |
| `peakMx` | 单帧参数最大变化量 | **< 1.0**（待机呼吸/眨眼本身就有 ~0.3，超过 1.0 就开始像"闪"） |
| `jumpRatio` | `peakMx` ÷ 该段 95 分位 | **< 2.5**（一帧吃掉整段的大半就是它） |
| `freezeMax` | 演到一半连续完全不动的帧数 | **< 3**（60fps 下 3 帧 = 50ms，肉眼就是"卡住"） |

### 4.4 自己验收：一条配方

```bash
# 0) 打开逐帧遥测（调试 token 见 main/docs/technical.md）
DT=<调试 token>
curl --noproxy '*' -X POST -H "x-stage-token: $DT" -H "content-type: application/json" \
     -d '{"on":true,"clear":true,"cap":600}' http://127.0.0.1:12405/api/debug/frames

# 1) 发你要测的动作（换成自己的 cue 串 / 预设名 / 动作名）
curl --noproxy '*' -X POST -H "x-stage-token: $DT" -H "content-type: application/json" \
     -d '{"cue":"微低头 缩一下 ＞＜"}' http://127.0.0.1:12405/api/debug/cue

# 2) 等它演完再取帧，看有没有某帧 mx 特别大
sleep 4
curl --noproxy '*' -H "x-stage-token: $DT" "http://127.0.0.1:12405/api/debug/frames?n=600"
```

返回里每帧的 `dt`（帧间隔）、`act`（全部参数变化量之和）、`mx`+`arg`（最大单参数变化及其名字）就是依据：
`mx` 突然高出前后帧 5 倍以上，那一帧就是"跳"；`arg` 直接告诉你该去改哪个参数。

### 4.5 常见症状对照

| 你看到的 | 多半是 | 怎么改 |
| --- | --- | --- |
| 演到一半"闪一下" | 上一条动作/上一步 cue 被顶掉，残差一帧清零 | 拉开两条 cue 的间隔；确认一条串里只有一个 `动作:` |
| 动作起手"弹"一下 | 滑入太短（<120ms），或首帧关键帧不是 0 | 把第一个关键帧写成 `0:0`，滑入拉到 120ms 以上 |
| 演完人还歪着 / 一直抖 | 末帧不是 0，或两个通道写同一参数 | 末帧归零；把该参数只留给一层管 |
| 换表情时身体跟着抽 | 表情里写了 `LeanInput` 这类物理输入，和动作的角度撞了 | 表情只管脸，别在表情里放大角度 |
| 切到某个动作后手臂"啪"一下 | 走的是原生动画，素材里就是 0→1 瞬切 | 属素材行为；别在它播放期间再写 `Movement*` |

---

## 5. 常见错误

| 现象 | 原因 |
| --- | --- |
| 启动后还是原来的人设 | `config.persona` 没改，或改完没重启 |
| 报「人设加载失败」 | `id` 与目录名不一致，或 `personaId` 与 `id` 不一致 |
| 一切正常但台词没变 | 只改了 `tagline` / `relationships`，那两处不进 prompt；要改 `prompt` |
| 动作没反应 | `cue` 里的词不在词表里，或 `action` 里的动作/姿势名在当前模型上不存在 |
| JSON 读不出来 | 尾逗号、中文引号、BOM |
| 换机器后语气怪 | `prompt` 里写死了用户名 / 路径 / 工作内容 —— 那属于运行时设置，不属于人设 |

改完想验证结构有没有写错，可以跑：

```powershell
node -e "['persona','behavior','presets'].forEach(f=>JSON.parse(require('fs').readFileSync('main/persona/my-pet/'+f+'.json','utf8')));console.log('json ok')"
```
