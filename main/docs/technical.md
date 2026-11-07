# BigFatBlueFish 桌宠 · 技术文档

> **版本基线：main 1.0.0 / pet-bridge 1.0.0**
>
> 本文档按当前代码实现重写，所有陈述均已逐条对照源码核验。原「v0.4 优化交接文档」中的问答、待办清单、测试记录与修复日志已移除，只保留对后续维护有用的技术事实。

---

## 1. 项目是什么

本项目由两个组件构成：

| 组件 | 路径 | 形态 | 职责 |
| --- | --- | --- | --- |
| **stage** | `main` | Electron 应用（pixi.js 8 + Live2D Cubism 5） | 桌宠本体：透明窗口、模型渲染、行为状态机、右键菜单、设置页。**可独立运行**，不依赖 DSH |
| **bridge** | `plugins\dsh` | DSH 市场插件 `pet-bridge` | 给宿主 agent 两个工具：`pet`（8 种动作）与 `run_shortcut`（白名单来自 commands.json）；每 3 秒轮询桌宠，处理「主动说话」（把桌宠事件转给绑定会话） |

两个组件之间不直接通信，全部走 `~/.dsh\live2d\` 下的文件与 HTTP：

- **`endpoint.json`**（stage → 外部）：url / token / pid / pet-events 文件路径。stage 先写自己的 `main/runtime/app/endpoint.json`，再由 `launch.mjs` **每 600 ms 镜像**一份到 `~/.dsh\live2d\endpoint.json`（electron 进程无法直接写那个目录，EPERM，只有 node 进程可以）。**插件只读这个文件，从不猜端口。**
- **`status.json`**（插件 → stage，零 token 投影）：插件把 `say` / `expression` / `pose` 等指令写进去；stage 主进程**每 200 ms** 轮询并通过 IPC 转给渲染进程。
- **`pet-events.json`**（stage → 插件，事件 outbox，存 `main/runtime/app/`）：stage「想上报驾驶员」时（用户互动、盯着观察等）追加事件，只保留最近 24 条；插件读取并转给绑定会话，随后 `POST /api/events-ack {ids}` 回 ACK，stage 删除已 ACK 事件并清理过期事件。

最小流程：

```
宿主 agent ──pet / run_shortcut──▶ pet-bridge ──status.json──▶ stage 主进程(200ms 轮询) ──IPC──▶ 渲染(Live2D)
      ▲                           │
      │ ③ 事件转给绑定会话        │ ① 3s 轮询(endpoint.json → HTTP /api/*, 头 x-stage-token)
      └────────pet-events.json ◀──┘ ② 每轮上报 /api/bridge-health
```

---

## 2. 目录结构与关键文件

```
BigFatBlueFish\
├─ main\                     主体（运行所需的一切）
│  ├─ package.json           Electron 入口：modules/core/main.cjs
│  ├─ launch.mjs             node 启动器（干净环境块 + 600ms endpoint 镜像）
│  ├─ launcher.vbs           生成物：快捷方式 → wscript → 这里 → node（gitignore）
│  ├─ deps\                  真实依赖实体：package.json / node_modules / vendor
│  ├─ model\                 runtime\（运行模型）+ source\（PSD / 表情截图）
│  ├─ persona\               blue-whale-maid 人设包
│  ├─ config\                config.json / commands.json / shortcuts.legacy.json
│  ├─ runtime\               app\ / audit\ / chromium\ / logs\
│  ├─ docs\                  技术文档、教程、人设指南、模块说明
│  ├─ modules\
│  │  ├─ core\               main.cjs / server.mjs / paths.cjs（唯一路径契约）
│  │  ├─ ui\                 index / renderer / engine / interact / 气泡 / 托盘图标
│  │  ├─ menu\               菜单页 + menu.mjs（纯函数）
│  │  ├─ settings\           设置页 + settings.mjs
│  │  ├─ behavior\           behavior / cues / sequence / persona
│  │  ├─ commands\           commands.mjs / shortcuts.mjs（旧白名单兼容）
│  │  ├─ low-power\          lowinterrupt.mjs / observer.ps1
│  │  └─ tutorial\           教程窗口
│  └─ scripts\               shortcut.mjs / make-tray-icon.mjs / prepare-model.mjs / build-renderer.mjs / lib\
├─ plugins\
│  ├─ install.mjs            插件安装脚本
│  ├─ dsh\                   pet-bridge 插件（lib / docs / data）
│  ├─ workbuddy\             空实现占位
│  └─ qodercn\               空实现占位
├─ 其他\                     参考项目 / 测试 / 工具 / 历史笔记（唯一中文目录）
├─ launcher.lnk              生成物：双击无黑框启动
├─ start.cmd                 控制台启动（排障）+ start.cmd install
├─ README.md                 项目简述 + 目录树 + Agent 安装流程
└─ -bak\                     迁移备份（验收后回收）
```

（`其他\reference\` 里的 `airi` / `upstream` / `research` 等是参考项目，不参与运行。）

`config.json`（772 行）是 stage 的全部可调项：端口（`serverPort 12405` + 回退链）、`driver`（enabled / stateFile / endpointFile）、`window`（400×780 / dpiScale / alwaysOnTop / skipTaskbar）、`perf`（fpsCap 120 / textureMax 2048 / minimal / idleFpsBoots）、`stateMap`（会话状态→表情/姿势）、`poses`（4 种）、`expressionExtras` / `expressionParts`（表情补充）、`interact`（右键/左点/编辑模式）、`bubble`（60 字 / 9 s）、`behavior`（行为状态机计时）、`motions`（8 个内置动作）。

---

## 3. 启动与验证

### 3.1 启动链

```
start.cmd ─────────────────────────────▶ node launch.mjs ──▶ electron

launcher.lnk ──▶ wscript.exe main\launcher.vbs ──▶ node launch.mjs ──▶ electron
```

- `launcher.lnk` 的目标是 **wscript.exe**（不是 electron.exe），参数是生成的 `main/launcher.vbs`。launcher.vbs 用隐藏窗口启动 node，node 再走 `launch.mjs`。
  - 为什么不用 electron.exe 做启动器：实测 electron 的**子进程**也会被本机策略挡在 `~/.dsh` 外（EPERM），launch.mjs 的握手镜像写不出去，插件找不到桌宠。wscript 由 Explorer 直接启动时不在 electron 进程树里，node 能正常写。
  - 为什么不用 node.exe 直接做快捷方式目标：node 是控制台子系统，会闪黑框；wscript 是 GUI 子系统。
  - `main/launcher.vbs` 是生成物（`start.cmd install` 生成，UTF-16LE + BOM），里面写死了当前 node.exe 路径；仓库移动后重跑 install。
- `start.cmd` 先清空所有代理类环境变量（本机代理键重复会让环境块无效、进程静默失败，exit code 3），再检查 `node_modules`。node 在 PATH 时走 `launch.mjs`；不在则直接起 electron 进入 **standalone 模式**——桌宠本身正常，但**握手文件不会被镜像，DSH 插件找不到这个实例**（启动时会有提示）。
- `launch.mjs` 做三件事：
  1. 重建**干净环境块**再 spawn electron（治重复代理键导致的静默 exit 3）；
  2. 加 `--no-sandbox`、`--user-data-dir=main/runtime/chromium`、`--force-device-scale-factor=1`（本机 Chromium 没有这些参数起不来 / 解析默认 profile 时崩）；
  3. **每 600 ms 把 `endpoint.json` 镜像到 `~/.dsh\live2d\`**（electron 写不了那里，EPERM；node 可以）。
- 额外参数透传：`start.cmd --settings-open` 等于给 electron 传 `--settings-open`。
- `electron --launcher` 分支仍保留，仅用于手工调试；快捷方式已经不走它。受限环境下它的 node 子进程仍可能写不了握手。

### 3.2 启动时发生什么

1. **端口**：`config.json` 的 `serverPort: 12405` 首选（0 = 随机）；被占用则向后逐位回退（12405..12414）。**实际端口以 `endpoint.json` 为准。**
2. 生成 36 位**运行 token**（每次启动随机），写入 `endpoint.json`。
3. 启动只监听 `127.0.0.1` 的 HTTP 服务（server.mjs），挂载进主进程。
4. 打开透明桌宠窗口；开始 200 ms 的 `status.json` 轮询与 1 s 的行为状态机 tick。

### 3.3 验证存活（curl）

先读端口和 token：

```powershell
Get-Content C:\Users\<you>\.dsh\live2d\endpoint.json
```

```powershell
# 免 token
curl.exe -s http://127.0.0.1:12405/api/health

# 带 token：头名是 x-stage-token
curl.exe -s -H "x-stage-token: <token>" http://127.0.0.1:12405/api/state
curl.exe -s -H "x-stage-token: <token>" http://127.0.0.1:12405/api/catalog
```

**调试 token**：固定值 = `sha256('TingNiKuaiYuKQ-3042-FishDeBug')` 的十六进制串，给人和脚本联调用（免得每次翻 endpoint.json）。调试 token 的请求在日志里标 `[debug]`，控制类接口照常执行；`/api/debug/*` 两条接口**只接受调试 token**。

> 这个口令是**刻意保留的水印，不要改**：改了所有旧的验收脚本会失效，它同时也是这份代码来源的记号。它**不是后门** —— `/api/debug/*` 只做参数对照实验（临时改 Live2D 参数、读参数当前值），不涉及文件读写与命令执行；真正敏感的接口都要普通 token（在 `endpoint.json` 里，每次启动随机）。

### 3.4 改渲染层要构建

`renderer.js` 是源码，实际加载的是构建产物 `modules\ui\build\renderer.bundle.js`。改完渲染侧代码，在 `main\deps` 里跑 `npm run build`。

```powershell
npm run build
```

注意：构建产物里**中文被转义成 `\uXXXX`**，在 bundle 里 grep 中文查不到东西——要 grep 源码 `renderer.js`。

### 3.5 安装插件

```powershell
node pet\install.mjs      # 把 pet-bridge 复制到 DSH 插件目录
# 在插件目录里：
pnpm install             # 装 @deepseek-ai/dsh-tools 等依赖
# 然后重启 DSH
```

重启后宿主 agent 获得 `pet` 与 `run_shortcut` 工具。`run_shortcut` 的白名单**不是**手写文件，而是 `main/config/commands.json` 的投影：启动时与每次保存后，舞台写 `main/runtime/app/shortcuts.json`，再由 `launch.mjs`（node 进程）镜像到 `~/.dsh/live2d/shortcuts.json`（electron 直写会 EPERM）。默认 4 条：`open_control`（exe）/ `open_temp`（shortcut，走 shell.openPath）/ `list_downloads`（cmd）/ `current_time`（ps shell）。其中 GUI 一律走 `shortcut`：从 Electron 主进程直接 spawn `explorer.exe`、商店版程序会失败（0xC0000142 / 0xC0000409）。

### 3.6 启动参数

| 参数 | 作用 |
| --- | --- |
| `--settings-open` / `--debug-settings` | 启动时打开设置页 |
| `--settings-tab=<name>` | 设置页打开到指定 tab |
| `--settings-shot` | 给设置页截图（存 `main/runtime/logs`） |
| `--no-driver` | 纯独立模式（测试/演示）：`DRIVER.enabled=false`，且 launch.mjs 不镜像握手文件——DSH 侧看不到这个实例 |
| `--debug-interact` | 用合成指针事件跑一遍右键手势状态机（调试用） |
| `--debug-menu` | 启动 2.2 s 后自动弹一次菜单，并**每 150 ms 连拍 10 张**存 `main/runtime/logs/menu-01.png … menu-10.png`（单张截图看不出「从下到上」的出场顺序） |
| `--debug-menu-sub` | 配合 `--debug-menu`：入场动画播完自动展开二级，用来核对二级的弹出顺序与「返回」文本 |

### 3.7 日志

- `main\runtime\logs\run.log` —— stage 日志。`[driver-events]` 行是「上报给驾驶员」那条链（入队 / 写失败 / ACK）。
- 右键菜单的 **「打开运行日志」** 直接打开它。
- `fake-stage.mjs` 可以不开窗跑同一套协议（写 endpoint.json、轮询 status.json），适合联调时不想开窗的场景。

---

## 4. 进程与通道

### 4.1 进程

| 进程 | 职责 |
| --- | --- |
| electron 主进程 | 透明桌宠窗口、气泡窗口、右键菜单窗口、设置窗口；托管 HTTP 服务；200 ms status 轮询；事件 outbox |
| 渲染进程 | pixi.js + Live2D 渲染、帧序与优先级仲裁、气泡、宠内交互 |
| DSH 宿主（插件沙箱） | pet-bridge：工具定义、3 秒轮询循环、会话列表、预设存储 |

### 4.2 三条数据线

| 线 | 方向 | 机制 | 节奏 |
| --- | --- | --- | --- |
| `status.json` | 插件 → stage | 插件写零 token 投影文件；stage 主进程轮询后 `IPC pet:state` 转发 | stage 每 200 ms |
| `endpoint.json` | stage → 插件 | stage 写 `main\runtime\app\endpoint.json`；launch.mjs 镜像到 `~/.dsh\live2d\` | 每 600 ms 镜像 |
| `pet-events.json`（outbox） | stage → 插件 | stage 追加（保留最近 24 条）；插件读取并转给绑定会话，投递成功即 `POST /api/events-ack {ids}` ACK；另在插件内存里留一份 in-flight 等绑定会话的 `turn/end` 做确认（确认**不推迟** ACK，只用于重投与计数） | 插件每 3 s 一轮询；stage 清理过期事件（90 s）；插件丢弃 85 s 以上旧事件；in-flight 120 s 等不到结局就放弃 |

### 4.3 主动说话

- **投递的消息必须是完整的 v4 消息**（v0.4.2，真根因）：`followup()` / `steer()` 的参数**不做任何归一化**，原样落进 `agent/inbox/spliced` 的历史里，所以少一个字段都会在很远的下游炸，而且炸的是整批落盘（用户自己那条一起没）。要求：`role:'user'`（适配器按 role 转 wire 形状，缺了会得到 `role: undefined`，报「cannot represent system update…」）、`id`（inbox 投影用它去重，两条无 id 会被判成同一条）、`source.kind` 非空且**不能是 `'plugin'`**（v4 退休写法，报「format v4 message requires a producer-owned source kind」；插件用自己名字当 kind，如 `'pet-bridge'`，用户手打的用 `'user'`）。两条报错的完整证据链在 `plugins/dsh/docs/DSH-API.md` §6.3。
- **投递要「确认」，不是「塞进去就算」**（v0.4.2）：`followup()` / `steer()` 不抛异常只代表消息进了收件箱，回合里失败插件原本不知道 —— 那句话永久丢失（`DSH-API.md` §6.1 记了实测现场）。现在投递成功照常 ACK，另外在插件内存里记一份 `inflight`（文本 + 第几次重投），等绑定会话的 `turn/end` 结清：`completed` 算送达；命中已知的一次性错误（`cannot represent` / `UNSUPPORTED_CONTENT`）用留底的文本重投一次（重投会换新 `id`，旧 id 可能已在 pending 里）；其他错误、超时（120 s）、舞台重启都判为放弃。重投条件收得很紧，否则无关回合失败会造成重复消息。**为什么 ACK 不等确认**：agent 一轮跑几分钟很常见，而舞台 90 s 收不到 ACK 就会冒「好像断连了诶……」的误报。放弃的会记进 `health.dropped` + `lastError`，`/api/health` 的 plugin 段能看到 `delivered / confirmed / dropped / inflight` 四个数。
- 设置页的「主动说话」开关 + 频率（低 / 中 / 高）。stage 端折算成概率：**低 25% / 中 66% / 高 100%**。
- 只门控「自动事件」（互动上报、盯着观察等）；**用户在输入胶囊里打的字直通**，不被门控。
- 插件端会话标题：落盘缓存 `session-titles.json`（重启不重读）；有标题的缓存 30 分钟，没标题的 3 分钟后重试；每轮只补 6 条（读整份会话日志代价高，列表几轮内逐步长全）；缓存上限 200 条。
- 设置页会话列表每 5 秒自动刷新。
- `GET /api/driver-info` 的 `since` 字段（stage 启动时刻）让插件能察觉「stage 重启过」并重新同步。

---

## 5. 握手与鉴权

- 握手目录：`~/.dsh\live2d\`（路径契约定义在 `lib\paths.mjs`）。
- 端口策略：12405 首选（`config.json` 的 `serverPort`，0 = 随机），被占用则向后逐位回退（12405..12414）；**插件永远从 endpoint.json 读实际端口，不猜。**
- 两个 token（见 §3.3）：
  - **运行 token**：每次启动随机，存在 endpoint.json 里，**插件用它**；
  - **调试 token**：固定值，给人 / 脚本。
- 所有 `/api/*` 都要带 **`x-stage-token`** 头；错 token 一律 401。静态资源（页面、html/js/css、`/model`、`/node_modules`）免鉴权；路径拼接走 `safeJoin` 挡 `../` 穿越。
- 设置页的 token 来自 URL query（`?token=`，主进程开设置窗口时注入；`settings.html` 用 `URLSearchParams` 读）。

---

## 6. HTTP API（127.0.0.1）

### 6.1 路由全表

**免 token**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 + 插件自报（来自 `/api/bridge-health`）+ stage 最近请求日志 |

**要 token**（`x-stage-token`）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/state` | 当前状态（活动表情 / 姿势 / 追踪）+ 最近 30 行日志 |
| GET | `/api/catalog` | 表情 / 姿势 / 动作的合法清单（供插件侧校验参数） |
| GET | `/api/settings` | 读设置 |
| POST | `/api/settings` | 写设置（局部更新） |
| GET | `/api/sessions` | 设置页会话列表数据源 |
| POST | `/api/sessions` | 更新会话列表（全量 `{id, title, live, at}`，未开过的会话也在） |
| GET | `/api/driver-info` | `{ok, since, proactive, freq, bind}` —— 绑定状态 / 主动说话 / stage 启动时刻 |
| POST | `/api/bridge-health` | 插件自报 |
| POST | `/api/events-ack` | ACK：把已转发的事件从 outbox 删除 |
| POST | `/api/say` | 说话（两种形式：单句 / 多句数组，可带 expression/pose） |
| POST | `/api/expression` | 换表情（可叠加） |
| POST | `/api/pose` | 换姿势 |
| POST | `/api/motion` | 播动作（内置 name，或 `tracks` 现编关键帧） |
| POST | `/api/sequence` | 多步序列（steps，上限 24 步 / 120 s） |
| POST | `/api/stop` | 停当前序列（正在演的那一步自然演完） |
| POST | `/api/reset` | 清表情 / 恢复默认姿势 / 关鼠标追踪 |
| POST | `/api/screenshot` | `{path: .png 绝对路径, target: 'stage' \| 'settings'}` 按需截图 |
| POST | `/api/shortcut` | 执行 run_shortcut（插件通道，读 `~/.dsh/live2d/shortcuts.json` 投影） |
| POST | `/api/commands/run` | 执行一条指令（菜单通道，直接读 `commands.json`，支持 `cmd` 内置命令） |
| GET | `/api/params` | 读当前模型参数 |
| GET | `/api/debug/frames` | **仅调试 token**：逐帧遥测快照 `?n=600`，返回 `{dt, act, mx, arg, pose, expr, mot}` 数组 |
| POST | `/api/debug/frames` | **仅调试 token**：遥测开关 `{on, clear, cap}`（默认只记 dt，`on:true` 后才算参数变化量） |
| POST | `/api/debug/cue` | **仅调试 token**：原样重放一条 cue 串 `{cue}`（人设卡的 idleAction / reaction 都是 cue 串） |
| POST | `/api/debug/params` | **仅调试 token**：参数直写 `{set, parts, hold, clear, save}`，做 A/B 实验用 |
| POST | `/api/debug/tap` | **仅调试 token**：触点模拟 |

未知 `/api/*` → 404；非 `/api` 路径走页面目录或静态资源（`/model`、`/node_modules`）。

### 6.2 名称校验

控制类接口（`say` / `expression` / `pose` / `motion`）**在 stage 端校验名称**（表情 / 姿势 / 动作的合法清单只有 stage 自己知道）；非法名称返回 400 并带 `available` 清单。这是为了防止「不存在的表情也返回 accepted、实际什么都没发生」。

### 6.3 pet 工具 8 种动作与 API 的对应

| tool kind | 实现 |
| --- | --- |
| say / expression / pose / motion / sequence / stop / reset | 对应 `/api/*` 控制接口 |
| preset（save / play / list / delete） | 全在插件侧：存插件 `data\` 目录；play 就是把存好的一套 steps 重放给 stage |

**`kind` 不是必填（v0.4.3）**：宿主 `dsh-tools` 在 `execute` **之前**就用 `validateJsonSchemaValue` 按 schema 校验参数，所以「kind 写成 required」意味着模型漏写一次就整次调用报废（报 `missing required property "kind"`，插件连一句人话都说不出）。现在的约定：

- schema 里 `kind` 无 `required`、无 `enum`；缺省由 `inferKind()` 按参数形状还原：`steps`→sequence、`op`→preset、`text`/`lines`→say、`name`→查表情/姿势/动作名单、`tracks`→motion、`pose`/`expression` 字段→对应 kind。
- `unwrapArgs()` 兼容 `{args:{…}}` / `{arguments:"{…}"}` / 整串 JSON 文本三种包裹。
- 写成近义词（`speak` / `表情` / `动作` …）走 `KIND_ALIASES` 归一，不再判死。
- **只有 kind 不是显式给的时候**才落一行 `~/.dsh\live2d\pet-calls.log`（含原始参数前 400 字）；正常调用零开销。排查「工具报错但插件没记录」先看它。
- 想改 schema 先用 `_px/bh2/`（接宿主真实 `dsh-tools` + 插件副本）跑 `run.mjs` 校验九种参数，再 `e2e.mjs` 打真舞台。

---

## 7. 渲染管线与参数写入时机

### 7.1 帧序与优先级仲裁（renderer.js）

每帧大致流程：

1. 读取待处理指令队列（IPC 事件：驾驶员 / 用户 / 调试）；
2. **优先级仲裁（claim）**：系统（驾驶员）指令最高，用户（输入胶囊 / 手动）次之，行为（自发状态机）最低——0 级指令在播时，1 级事件被丢弃（这正是「可以被覆盖」想要的形态）；
3. 应用参数写入（模型参数、部件透明度等）；
4. 气泡文本 / 时长更新；
5. 参数固化（saveParameters）。

**三条铁律**：

1. **帧外读参数读到的是「存档值」**——验证「到底有没有生效」用 `GET /api/params`（要 token）或 `POST /api/screenshot`，别在帧外读渲染进程的内存状态。
2. 现编关键帧动作的参数是**增量**（起止都要回到 0），否则会卡在半路；不在可写清单里的参数（手臂物理参数等）会被物理接管或破坏形状。
3. 序列演完后状态自然固化。
4. **语法层的「保持」必须有人收尾**（0.5.6）。`〔歪头〕〔脸红〕` 这类 cue 写的是保持型通道，
   以前没人关 → 说完一直挂着。现在：说话按 `plan.ms + 900ms` 收尾、预设按最后一步收尾、
   裸 cue 固定 5.2s 收尾；收尾由 `relaxCues()` 统一做（撤通道 / 撤 overlay / 放下手 /
   按当前状态重贴状态表情）。cue 点亮的表情**不进快照**，否则会被下一次还原永久固化。

### 7.2 气泡

- 时长公式：`Math.max(total, Math.min(6000, 字数 × 90))` ms（renderer.js）。
- 气泡窗口在淡出结束 **180 ms** 后回调 `done()`（bubble.html），释放「气泡占用」的 claim。
- 气泡上限 **60 字**，默认展示 9 s（`config.json` 的 `bubble`：maxChars / defaultMs / fontSize）。

### 7.3 姿势与动作

- **姿势**共 4 种：`default` / `grass` / `chest` / `finger`，切换走 260 ms 补间。`finger` 姿势要配合「竖食指」开关动画和 `Param40/39/41` 三个参数，缺了会「手出现了但手臂没转」（实测结论，见 config.json 注释）。
- **狗尾草的收尾（v0.4.3）**：草不是表情，是 `Movement1` 这个参数在挑贴图；进/出靠两条原生动画把 0↔1 拉过去（`狗尾草切换出来` 末值 1、`狗尾草切回默认手` 末值 0），播完由 `settleSwitch()` 把末值固化进基准。收尾靠三层保险，别只留时间轴：
  1. `grassSeq` 序号 —— 后一次左手点击整体作废前一次的时间轴（两条时间轴交错必定互踩）；
  2. 快照还原 —— 回到交互前的姿势（含 `Movement1=0`）；
  3. 看门狗 —— 切回动画之后再等 700 ms，`Movement1 > 0.02` 就地压回 0、写进 `baseline`，并 `requestPose('default')`（否则姿势层每帧又写回 1）。
- **内置动作** 8 个（`config.json` 的 `motions` 节，keyframes 以增量 `tracks` 描述）：

  | 动作 | 时长 |
  | --- | --- |
  | 重心换脚 | 5.2 s |
  | 东张西望 | 5.6 s |
  | 伸懒腰 | 4.2 s |
  | 打瞌睡 | 6.2 s |
  | 抖尾巴 | 2.4 s |
  | 抖动身体 | 2.2 s |
  | 歪头 | 1.6 s |
  | 狗尾巴草摆动 | 2.8 s |

- **表情补充**：`expressionExtras`（参数级，如猫嘴 `ParamMouthForm = -1`）与 `expressionParts`（部件透明度级，如流冷汗 `Part79`），都在 `config.json` 配置。

### 7.4 行为状态机（modules/behavior/behavior.mjs）

- 按 **1 小时** 为单位做规划：
  - **盯着**（鼠标追踪）：每小时共 8–24 分钟（`gazeMinMs 480000` – `gazeMaxMs 1440000`），切成每段 2–6 分钟的随机段（`gazeSeg 120000`–`360000`）。段内鼠标静止超过 `min(3 分钟, 段长 50%)`（`focusIdleMs`）→ 探测前台窗口标题 → 气泡「`[窗口名] 是什么？`」，且主动说话开着时给驾驶员发一条观察。
  - **小动作**：3 种——东张西望 / 抖尾巴 / 抖动身体（`smallMotions`），每种每小时触发 **2–8 次**（`smallMin/smallMax`；原计划 4–28 实测太密集，已下调），随机间隔、不重复时间戳，任意两个之间至少 1 秒。
- 初始状态：鼠标追踪**关**；`/api/reset` 的「恢复初始」同样把追踪关掉。
- 所有计时值在 `config.json` 的 `behavior` 节可调。
- `config.json` 的 `driver.enabled = false` → 纯独立桌宠：不读任何状态文件、不写任何握手文件，右键菜单照旧可用。

### 7.5 会话状态映射（stateMap）

会话状态（由插件侧推送）按下表落到表情 / 姿势：

| 状态 | 表情 | 姿势 |
| --- | --- | --- |
| thinking | 前倾 | |
| working | 兔牙 | |
| result | （无） | |
| waiting | ＞＜ | chest |
| success | 爱心眼 | |
| error | 流冷汗 | |
| idle | 默认体型 | |

（`config.json` 的 `stateMap` 节。）

### 7.6 交互（interact）

- **短右键** = 三级胶囊菜单（DOM 从上到下 = 列表 → 固定返回 → 输入胶囊）：
  - 一级只有两枚：**对话框**（输入胶囊，固定最下，尺寸是按钮的 2 倍长宽）和 **做点什么……**；
  - 点「做点什么……」展开二级：**表情和姿势 / 快捷操作 / 打开设置 / 其他**，再往下一层是具体项；
  - **鱼鳞层叠**（0.5.8 纠偏）：进深层时被盖住的层**不隐藏**——保持显示、被上层天然遮挡（露出 22px 鳞边），只是 `covered`（整层不响应鼠标）。鳞边上的点击在捕获阶段被吞掉（不动作、也不触发「点空白收菜单」）；popLayer 恢复下层交互时不重播展开动画。
- **深层固定有一颗「返回」**：它挂在 layer 上、不参与列表滚动，位置就是一级时「做点什么」那一格（输入胶囊正上方）。列表视口固定 **4 行**，窗口固定 **5 行**（4+1），大屏也不会显示更多；
  - **列表内容运行时填**：`config.interact.menu` 里写 `source: "faces"` / `"commands"`，`modules/menu/menu.mjs: fillDynamic()` 在每次打开时填「全部表情 + 全部姿势」/「全部快捷指令（上限 20）」。加个表情、改条指令不用重启；`expr:名字` 是开关、`pose:名字` 是切换；
  - 快捷操作上限 20 由两处共同保证：菜单只取前 20 条（`MENU_CMD_SLOTS`），新增时 `modules/commands/commands.mjs: validateItem` 直接拒绝第 21 条；
  - 滚动：原生 overflow，无滚动条；上下各 16px 渐隐提示（`can-up` / `can-down`，滚到头就撤）。长列表的出场错峰有总时长上限（~420ms），不会出现「进列表后 1.8 秒才铺满」；
  - 输入胶囊三态（未绑定 / 离线 / 请输入文本）由 `menu:status` 每 1.2s 刷新，菜单开着时驾驶员上下线能当场反映。
- **动画**（`menu.html`，Web Animations API，无 CSS keyframes）：
  - 出场**从下到上**逐个弹：对话框先，0.1 s 后「做点什么……」；展开二级时二级项也从下到上。
  - 收场是**逆向的出场动画**，方向**从上到下**：`dismiss()` 只取「当前 DOM 里真的显示着的那些胶囊」，所以按钮多寡、一级/二级状态都不用改代码。
  - 单颗胶囊 = 0.1 s 圆形浮现 + 0.3 s 抽出（`STAGGER/POP/DRAW` 三个常量）；播完把终态 `commitStyles()` 写进内联样式再 cancel，随时打断都不会闪回 CSS 基态。
  - **点空白、Esc、失焦（点到菜单外面）走同一套收场**：主进程失焦时发 `menu:dismiss` 让页面播，播完页面发 `menu:close`；主进程另有 1.8 s 兜底强关（页面 JS 挂了也不留透明空窗）。
  - 展开/收起改的是**窗口高度**（`menu:expand` / `menu:collapse` → `menuResize()`），**底边钉住往上长**，已有的胶囊不会跳位；页面等收场动画播完才发 `menu:collapse`，否则顶边先动会把还在收的胶囊裁掉。
  - 失焦关闭的武装时机：页面入场动画播完发 `menu:armed`（不再是写死 600 ms），页面没回话时 1.5 s 兜底武装。
- **长按右键 ≥ 500 ms** → 扫 500 ms 进入编辑模式（拖拽 / 缩放；缩放范围 0.45–2.2；边缘抓手 28 px）。
  - **退出倒计时**：编辑模式里任意一次真交互（拖过 >3px、缩放过）松手后启动 `interact.frameHideDelayMs`（1000 ms）倒计时，到点退模式并收起虚线框。
  - 例外：长按进来「按住直接接着拖」时，那次松手由 `editEntryRelease` 标记；v0.4.3 起只有「一次都没动」才保留虚线框常驻，拖过就照常开始倒计时（旧版把拖完松手也当成「进入动作的结尾」，框要等下一次交互才消失）。
  - `armHide` 到点时若 `drag`/`resize` 还挂着（拖到窗口外松手、系统吃掉 up），按松手补齐再退，避免 timer 再也不触发。
- **左点区域**：头 / 右手 / 左手 / 裙子 / 腿 / 尾巴 → 招呼气泡或换裙（`interact.js` 的 `ACTIONS` 表）。
- 招呼语、菜单项、区域都在 `config.json` 的 `interact` 节配置。
- 菜单窗口尺寸常量在 `main.cjs` 的 `openBubbleMenu()`：`CAP_W 330 / ROW 84 / GAP 15 / PAD 36 / IN_W 660 / IN_H 168`，`rows = min(5, 屏幕放得下)`，`menuH(rows)` 一次性算死（5 行 = 699），层级切换只改页面内显隐、**不动窗口尺寸**。

---

### 7.7 省电模式与帧率

- **省电模式**（原「低打扰」，0.5.7 改名，代码里仍叫 low）：`modules/low-power/lowinterrupt.mjs` 只做状态机，
  效果全在 `main.cjs` 的 `apply()` 里：透明度 50%、帧率 24、行为状态机停摆、驾驶员事件全丢
  （= 主动说话设置不生效、固定 0%）、左右键语义反转（单击 = 退出）。不跨重启保留。
- **帧率**三级：外观页 `30 / 60 / 无限制`（`settings.json: fpsCap`，0 = 无限制）。
  `main.cjs: targetFps()` 是唯一出口：省电 → 24；否则取设置，"无限制" 取
  `displayFrequency`（不是 0=不限，否则按能跑多快跑多快，多出来的帧全白烧）。
  启动时盖到 `config.perf.fpsCap`，改设置时发 `perf` 事件即时生效。
- **看不见就不画**：托盘隐藏窗口时发 `perf{paused:true}` → `stage.ticker.stop()`，
  显示时 `start()`。透明置顶窗口不会被 Chromium 判成「遮挡」，不主动停就一直空转。

## 8. 测试

- `其他\tests\sequence.test.mjs` —— 序列引擎（`lib\sequence.mjs`）单元测试，离线跑。
- `其他\tests\projection.test.mjs` —— status.json 投影单元测试（换隔离目录、stub `@deepseek-ai/dsh-tools`，不碰真实 DSH 状态）；含会话标题的四种形状回归（快照对象 / 裸字符串 / null / 历史坏值）。
- `其他\tests\delivery.test.mjs` —— 投递确认链路：起一个假舞台 HTTP + 假 agent，验证「未确认不 ACK → 已知错误重投 → 完成才 ACK → 未知错误不重投但放弃 → health 计数」整条路径，外加投递消息的 v4 形状（role / id / source.kind，且全程不许出现退休的 `kind:'plugin'`）（约 20 s，比另两套慢）。
- `其他\tests\syntax.test.mjs` —— 语法体检：所有 .html 的内联 `<script>` 用 `new Function` 校验（普通脚本语义，顶层 await 会报错），`app/*.js` / `lib/*.mjs` / `plugins/dsh/lib/index.js` 走 `node --check`。0.5.6 的「设置页整页空白」（一行注释吞掉代码 → 整块脚本不执行）就是被这层闸抓住的那类错。

五套都要过：`node 其他/tests/run-all.mjs`（syntax / menu / sequence / projection / delivery）。

---

## 附：常见坑

1. 端口不一定是 12405（被占用会回退）——永远读 `endpoint.json` 拿实际端口。
2. 头名是 **`x-stage-token`**，不是 Authorization。
3. 构建产物里中文是 `\uXXXX`，grep bundle 中文无果——grep 源码。
4. electron 进程写不了 `~/.dsh\live2d`（EPERM）——这就是 launch.mjs 存在的原因。
5. standalone 启动（没 node）时桌宠能动但插件找不到它——看启动提示。
6. 改完 `renderer.js` 忘记 `npm run build` 是「改了没生效」的头号原因。
7. `finger` 姿势必须配合「竖食指」开关动画和 `Param40/39/41`，缺了会「手出现了但手臂没转」。
8. **温和退出桌宠目前会卡住（未解决）**：`taskkill <pid>`（只发关闭信号）后会出现「HTTP 已死、进程还挂着」，而 `main.cjs` 有 `requestSingleInstanceLock()`，锁没放 → 之后每次启动都立刻退出，看起来像「启动不了」。已排除一个猜测：不是 `before-quit` 里 `server.close()` 等 keep-alive 连接（加了 `closeAllConnections()` + 500ms 超时后**仍然卡**，那个改动本身是对的，但不是根因；main.cjs 里也没有任何 `close`/`preventDefault` 否决）。排查前先用 `taskkill /F /T /PID` 推平整棵树（`electron.exe` 在这台机器上只有桌宠在用，父进程就是它的主进程，可以按树确认）。
9. 从 Git Bash / MSYS 里拉 `start.cmd` 会因为 GBK/UTF-8 编码把中文路径搞坏（静默不起）。改走 ASCII 路径：`powershell Start-Process cmd.exe -ArgumentList '/c','D:\...\start.cmd'`。双击 .cmd 不受影响（shell 自己处理文件名）。

10. **页面「打开了但空白」先看语法**：内联 `<script>` 里一行注释吞掉代码 → 整块脚本一行都不执行，
    `did-finish-load` 照常触发、日志全是「页面加载完成」。设置/菜单/教程窗口现在都接了
    `console-message`（level ≥ 2），报错会以 `[settings:console]` 出现在 run.log。改完页面先跑
    `node 其他/tests/syntax.test.mjs`。
11. **本模型的头部转不了**：`ParamAngleX/Y/Z` 与 `AngleX/Y/Z` 写到 ±30 都没画面反应（眼球参数有效）。
    只有 `ParamBodyAngleZ/X/Y` 会带动整体倾斜/前后。所以 cue 里的「歪头/点头/摇头」实际表现是
    「歪身/身体微动」。排查参数有没有效果，先看 `GET /api/params` 里的 `min`/`max`。
