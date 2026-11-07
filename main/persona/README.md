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

## 4. 常见错误

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
