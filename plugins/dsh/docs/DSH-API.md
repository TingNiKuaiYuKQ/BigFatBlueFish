# DSH 宿主插件 API 契约（实测/源码考证）

> 考证来源：DSH Desktop 安装目录下的 `resources/app/node_modules/@deepseek-ai/*` 各包 `README.zh.md`
> 与 `lib/` 打包产物。宿主是 cordis 插件体系（koishi 同源），本插件（pet-bridge）通过
> 插件根目录下的 `pet-bridge` 符号链接直指本目录（根目录 = `PET_PLUGIN_ROOT` 或 `%LOCALAPPDATA%\BigFatBlueFish\Plugin`，见 `plugins/install.mjs`），**改 lib/index.js 即生效**
>（重启 DSH Desktop 或插件重载后生效）。
> 更新：2026-11-03。

## 1. 插件入口

```js
// ESM，main: lib/index.js
export const name = 'pet-bridge'
export const inject = ['tools', 'systemPrompt', 'sessions', 'agents']   // 依赖的服务（必须声明，见 §4）
export function mount(ctx, config) { ... }        // cordis 约定
export const defineTool = (t) => t                // @deepseek-ai/dsh-tools 全部内容（就这一个函数）
```

- `ctx.tools.register(toolDef)` —— 注册工具（实测有效，工具会在 DSH 会话里出现）。
- `ctx.systemPrompt?.section?.({ name, order, text })` —— 注入系统提示词（实测有效）。
- `ctx.on('session/event', (session, event) => ...)` —— 订阅会话事件流（dsh-session 文档确认该事件名）。
- `ctx.on('dispose', ...)` —— 卸载钩子。
- dsh-tools 包里**只有** `defineTool`，没有任何会话/消息 API。

## 2. 会话（@deepseek-ai/dsh-session）

```js
ctx.sessions.list()        // 所有存活会话，按创建顺序
ctx.sessions.get(id)       // 单个会话（Session 实例）
ctx.sessions.create(...)   // 创建（绑定调用方 fiber）
session.append(type, data, opts)   // 追加事件；表层事件必须带 surfaceOp: 'append'
session.deriveMessages()           // 投影成模型看到的 Message[]
```

- 标题不是 header 字段，是独立事件：`session/title` / `session/title-llm-request`
  （见 dsh-session/lib/index.js 事件类型表 113-114 行）。要拿标题需从事件流折叠，
  或退而求其次显示会话 id 前缀。
- 会话持久化在 `~/.dsh/sessions/`（persistence-jsonl）。**注意 v4 的文件不是普通
  单帧 zstd**：`zstdDecompressSync` 只能解出第一行（会话 header），要拿到完整事件流
  得用宿主的 persistence/sessionQuery 服务，别自己解压（会 "Unknown frame descriptor"）。

### 2.1 要「全部对话」必须走 ctx.sessionQuery（v0.4.1 新增）

```js
// @deepseek-ai/dsh-session-query（dsh-base 的 cordis.patch.yml 里已挂载）
q.listSessions()          // 全部逻辑会话，最新在前：[{ header, live, persisted }]
q.readTitleSnapshots(ids) // 每个会话折叠出的最新标题（读整份日志，慢）
                          // → [{ status:'fulfilled', value:{ session, title? } } | { status:'rejected', reason }]
```

- **（2026-11-04 勘误，重要）`value.title` 不是字符串**，是 `dsh-session-title` 的
  `titleSnapshotFromState()` 冻结快照 `{ title, messageSeqs, source, eventSeq, updatedAt }`，
  **显示用的真串在 `value.title.title`**。直接 `String(value.title)` 得到
  `"[object Object]"`，而且它是 truthy，会被当成有效标题缓存 30 分钟、写进
  `data/session-titles.json` 落盘 —— v0.4.1 的设置页整列显示 `[object Object]` 就是这么来的
  （现修在 `lib/index.js` 的 `titleText()`，两种形状都吃，并把历史坏值判空）。
  对照：`session/title` **事件**的 `event.data.title` 才是裸字符串（见 §5）。

- `ctx.sessions.list()` **只给内存里活着的会话**（通常 = 当前打开的那一个），
  拿它做「绑定对话」列表永远只有一条；`ctx.sessionQuery` 才覆盖持久化的历史对话。
- 标题只能从日志折叠（`foldSessionTitle`），所以要读整份日志；一个会话 1~5MB 压缩，
  必须做**磁盘缓存 + 分批补读**（pet-bridge 每轮 6 条，缓存 30 分钟）。
- `header` 里还有 `parentSession` / `origin: 'subagent'` / `delegationDepth`：
  **子会话（subagent / agent-team）不是用户能点开的对话**，绑定列表要剔掉。
- 服务是可选增强：**不要写进 inject**，用 `ctx.get('sessionQuery')` 取，拿不到就退回
  `ctx.sessions.list()` —— 写进 inject 会让插件在没挂载该服务的宿主上被 cordis 挂起。

## 3. Agent（@deepseek-ai/dsh-agent + dsh-agent-loop）★主动说话的核心通道

```js
ctx.agents.get(agentId)    // 裸 Agent（handle 只给创建者；list()/roots() 可枚举）
ctx.agents.list()

// 三种投递方式（参数是一条**完整的**消息，会原样落进 agent/inbox/spliced 的 inserted）：
agent.followup({ role: 'user', id: crypto.randomUUID(),
                 content: [{ type: 'text', text: '...' }], source: { kind: 'user' } })
//   排队「下一轮」提示词并唤醒驱动器；agent 繁忙时排队，轮次边界被领取
agent.steer({ role: 'user', id: crypto.randomUUID(),
              content: [{ type: 'text', text: '...' }], source: { kind: 'pet-bridge' } })
//   「下一步」输入 = 真正的中途插话（繁忙时当前轮的下一个步骤就会带上）
agent.inject({ ... })      // 只进上下文，不唤醒驱动器（不触发回合）
agent.cancel(cause)        // 取消当前活动
await agent.whenIdle()     // 等完全停稳
```

- `Agent.inbox`：结构化收件箱（`nextTurn` / `nextStep` 两份待处理列表），
  有 `append/prepend/replace/remove/clear/splice`。事件词汇：`agent/inbox/inserted { message }`、
  `agent/inbox/claimed { message, turn }`、`agent/inbox/discarded { message }`、
  `agent/inbox/spliced`（持久投影折叠用）。
- `agent/*` 生命周期事件：`agent/created`、`agent/disposed`、`agent/status`、
  `agent/pre-step`（可拒绝/替换进入步骤的消息）、`agent/request-error`、
  `agent/turn-stopping`、`agent/assistant-stream`、`agent/turn-end` 等。
- **消息三个字段少一个都会炸，而且都炸在离插件很远的地方**（v0.4.2 实测，见 §6.3）：
  `role` 决定适配器怎么转 wire 形状（缺了 → `role: undefined` 的请求，报
  「system update without a preceding user…」）、`id` 是 inbox 投影的去重键、
  `source.kind` 必须非空且**不能是 `'plugin'`**（v4 落盘硬拒）。
- **pet-bridge 的投递策略**：agent 空闲 → `followup()`（正常开新一轮）；
  agent 繁忙 → `steer()`（用户要求的"以插话发送"）。判定直接读 `agent.status`。
- source.kind 是**生产者自己的名字**，不是 `'plugin'`：宿主各插件用
  `'webhook'` / `'team-message'` / `'agent-message'` / `'context-usage'` …。UI 对
  不认识的 kind 退回通用图标（`dsh-client-ui-chat/lib/client.js:6560` 的 switch 有
  default），所以自定义 kind 安全。模拟用户输入就用 `'user'`。

## 4. 组合注意事项

- **（2026-11-03 勘误，重要）**市场动态插件由宿主用沙箱 Proxy 门面包 ctx：**未在
  `inject` 里声明的服务，读属性那一刻就 throw**（`ctx.sessions` 会直接抛
  `service "sessions" is not injected`）。**`?.` 挡不住** —— 可选链只对 null/undefined
  短路，而 Proxy 在返回值之前已经抛了。本文件旧版写的「inject 不必声明，直接
  `ctx.agents?` 可选访问即可」是**错的**，照它写会导致绑定会话列表恒空、事件投递恒失败
  （0.3.0 的实际事故，见《检查报告.txt》）。
- 正确写法有两条腿，`pet-bridge` 两条都走（`lib/index.js` 的 `svc()`）：
  1. `inject` 里声明服务 —— 宿主没挂载时 cordis 会把插件挂起等待（而不是给半个 ctx）；
  2. 取值用沙箱官方的可选查找 `ctx.get('sessions')`（不抛，返回 undefined）。
- `ctx.agents` 由 dsh-agent 提供、驱动器由 dsh-agent-loop 注册；DSH Desktop 组合里
  两者都在（桌面端能跑对话就说明已挂载）。
- 插件安装 staging：DSH 会把插件复制到 `%TEMP%\pet-XXXX\node_modules\` 做 npm install
  （依赖 @deepseek-ai/dsh-tools），但**运行加载的是插件根目录下 `pet-bridge` 链接的本体**。
- 宿主自查工具：创造模式有 `cordis_inspect_list` / `cordis_inspect_query`
  （@deepseek-ai/dsh-tool-cordis），可在线查 provider/方法签名。

## 5. 运行时确认（读打包产物核实，2026-11-03）

- `ctx.agents.get(id)` 按 **agent/session 共享 id** 查找 —— 直接传会话 id 就能拿到 Agent。
- `ctx.agents.list()` 返回存活 Agent 对象数组（注册序）；`roots()` 顶层子集。
- `agent.status` → `'idle' | 'running'`（ReactLoopAgent 的 getter，每次变化发 `agent/status`）。
- `agent.followup(input)` = send(input,'next-turn',唤醒)；`steer(input)` = send(input,'next-step',唤醒)；
  `inject(input)` = 同 steer 但**不唤醒**。send 实现是 `inbox.splice(target, …)` + wakeDriver。
- input 形状：`{ role: 'user', id: <uuid>, content: [{ type: 'text', text }], source: { kind: <生产者名> } }`
  —— **`followup/steer` 不做任何归一化**，参数原样落盘，所以少 role/id 就等于写坏一条历史消息
  （v0.4.2 之前这里记的是 `{ content, source }`，照着写就翻车，见 §6.3）。
- `agent.cancel(cause, { keepInbox })`；`await agent.whenIdle()` 等停稳。
- 工具执行上下文：`execute(args, exec)`，**exec.agent.session.header.id = 调用方会话 id**
  （dsh-tools 流水线把 agent 挂在 exec 上，源码多处 `exec.agent?.session`）。
- `session/title` 事件：`event.data.title`（string|null，null=清除）。标题不在 Session.header。
- `session/disposed` 是真实事件名（持久化路由用到）。
- 无 .d.ts 随包发布（exports 指向的 types 文件缺失），一切以 README + 打包产物为准。

## 6. pet-bridge 现状与待办（2026-11-04，v0.4.2 更新）

### 6.1 「cannot represent system update」报错现场（已定位 → 真因见 §6.3）

从绑定会话的持久化日志里挖到了完整事件序列（`session-d5cc97d3…`，seq 1451-1463）：

```
1451 turn/end(completed)          ← 上一轮正常收尾
1453 agent/inbox/spliced          ← 桌宠消息进 nextTurn，source.kind='user'
1454 turn/start(4)  1456 step/start
1457 system/message (role=system, 6231 字)      ← systemPrompt.project 落的整份提示词
1458 user/message   "用户说：你好 （当前舞台：表情 默认体型）"  source.kind='user'
1459 request/header reason="resume"  model=deepseek-flash
1460 developer/message [{tool-addition:pet},{tool-addition:run_shortcut}]   ← 桌宠工具此刻才进注册表
1461 assistant/attempt → finish reason=error:
     "DeepSeek Messages cannot represent system update without a preceding user or tool-result turn"
1463 turn/end reason.kind=error
```

> 下面 1/2 两条是当时的判断，**已被 §6.3 推翻一半**：`source.kind` 确实不是原因，
> 但「触发点是工具进注册表」只说对了导火索 —— 真正让我们这颗雷响起来的是消息缺
> `role`。保留原文是为了记下推理过程。

三条结论：

1. **不是 `source.kind` 的锅。** 这条投递本来就是 `{kind:'user'}`（输入胶囊的「用户说」），
   照样失败 —— 所以「改成模拟用户发送」这条路**不成立**，v4.2.txt 里的猜测要作废。
   （更正：「模拟用户发送」本身是对的，问题在于只改了 `source`，没补 `role`/`id`。）
2. **触发点是桌宠自己的工具进注册表。** 整个会话里唯一的一条 `developer/message` 就是
   `pet` + `run_shortcut` 的 tool-addition，且它落在 `user/message` 之后、请求发出之前。
   agent-loop 在 `buildRequest()` 里比对上一次的 `request/header` 基线，工具集变了就补一条
   developer 消息（`dsh-agent-loop/lib/index.js:1214-1232`），DeepSeek 适配器把 developer
   折成 in-history 系统更新（`dsh-llm-deepseek/lib/index.js:1613-1641`），随后要求它必须
   跟在 user / tool-result 轮后面（`:1607-1610`）。**一次性条件**：DSH 重启后 agent 以
   `resume` 恢复、而基线里还没有桌宠工具时才会撞上；同一会话的第二次投递不会再有这条 delta。
   （更正：这条 delta 每轮都可能重放，适配器只是**要求它前面得是一条真 user 轮**；
   seq 1458 那条 `role=undefined`，所以 `messages.at(-1)?.role !== "user"` 直接判死。）
3. **插件侧的真实缺陷是「假成功」。** `followup()/steer()` 只是把消息塞进 inbox，不抛异常
   就返回 `ok:true`（`lib/index.js:681-686`），回合里失败插件完全不知道 —— 于是事件被 ACK、
   游标前进、这句话永久丢失，用户只在 DSH 界面上看到一个红色报错。

**v0.4.2 已实现（原待办）**：投递改成「有确认」而不是「塞进去就算」——
① 投递成功**照旧立刻 ACK**（不能推迟：agent 一轮跑几分钟很常见，舞台 90 s 收不到 ACK
就会冒「好像断连了」的误报）；② 同时在插件内存里留一份 `inflight`（id → 文本 + tries），
重投不依赖 outbox 副本；③ `onSessionEvent` 捕获绑定会话的 `turn/end`，`completed` 记
`health.confirmed`；④ 命中 `cannot represent` / `UNSUPPORTED_CONTENT` 这条已知一次性错误
时重投一次（`INFLIGHT_RETRY_MAX=1`）；⑤ 其他错误、超时 120 s、舞台重启判为放弃，记
`health.dropped` + `lastError`；⑥ `/api/health` 的 plugin 段新增 `confirmed / dropped / inflight`。
重投条件收得很紧（只认那条错误文案），否则无关回合的失败会造成重复消息。

仍未做：`boundInfo.proactive/freq` 在插件侧已缓存但没参与节流（门控目前全在舞台侧）；
`agent/request-error` 的宿主级重试（比 turn/end 确认更及时，值得下一步试）。

### 6.2 v0.4.2 修复

- **v0.4.2 修复**：`readTitleSnapshots()` 的 `value.title` 是**标题快照对象**，真串在
  `value.title.title` —— 旧代码 `String(value.title)` 得到 `[object Object]` 并被当有效
  标题缓存 30 分钟，设置页整列显示这串。现统一走 `titleText()`（快照对象 / 裸字符串 /
  null 三种形状都吃，历史坏值判空后走 3 分钟重读分支），`data/session-titles.json`
  里的坏条目下次载入即被洗掉。见 §2.1 勘误。

- 已实现：pet 工具 7 kind、run_shortcut 白名单、status.json 投影、presets.json 预设、
  /api/catalog 动态名单。
- driver-channel（真 API）：
    - `listSessions` = **`ctx.sessionQuery.listSessions()`（全部历史对话）+ `readTitleSnapshots()`
      折叠标题**；sessionQuery 不在时退回 `ctx.sessions.list()`（只有存活会话）。
      子会话（`header.parentSession` / `origin:'subagent'`）剔除；标题落盘缓存
      `data/session-titles.json`，每轮补读 6 条。返回 `{id,title,live,at}`。
    - `sendToSession` = `ctx.agents.get(会话id)` → 空闲 `followup()` / 繁忙 `steer()`（插话），
      user-input 事件 source.kind='user'，其余 'pet-bridge'（v0.4.2 更正，见 §6.3）
    - `driverGate` 优先读 `callCtx.agent.session.header.id`
    - ACK：投递成功才回 /api/events-ack；超时 90s 未 ACK → 舞台丢事件 + 断连气泡
    - 状态机：`approval/decided → working`（旧版漏了，waiting 会永远挂着）；
      `pruneStaleStates()` 清理「会话已不在内存 + 2 分钟未更新」的滞留状态
- **v0.4 修复（P0-1）**：
    - `inject` 补 `sessions` / `agents`；取值统一走 `svc(ctx, name)`（`ctx.get` + 属性两条腿）
    - 错误不再静默：`health` 表 → ①随 status.json 的 `bridge` 字段落盘 ②每轮 POST
      `/api/bridge-health`，由舞台 `GET /api/health` 带出（看 `plugin.sessions.ok` / `lastError`）
    - 事件游标只在**确实投递成功**时前进（旧写法在「没绑定/没 agent」时也前进，
      导致事件留在 outbox 却永不被重试）；陈旧事件顺带 ACK 掉，避免 90s 后被误判成断连
    - 舞台重启检测：`/api/driver-info` 的 `since` 变了就重推会话清单（否则重启后设置页永远空）
- 桌宠输入胶囊的「用户说：…」user-input 事件 → steer/followup 到绑定会话 = 用户
  隔空对 agent 说话的通道。

### 6.3 真根因：投递的消息不是合法的 v4 消息（v0.4.2 修）

两次报错（10:21 的 `cannot represent system update`、15:21 的
`format v4 message requires a producer-owned source kind`）是同一个缺陷的两张脸：
`sendToSession` 造的 `{ content, source }` **既没有 `role`，也没有 `id`，`source.kind`
还用了 v4 退休的 `'plugin'`**。`followup/steer` → `inbox.splice` → `session.append
("agent/inbox/spliced", { inserted })` 全程不做归一化（`dsh-agent-loop/lib/index.js:181-207`），
插件给什么就落什么，坏形状要到很远的下游才炸：

- **没 `role`** → `dsh-llm-deepseek/lib/index.js:1660-1672` 按 role 分派，`undefined`
  被当成一条 `role: undefined` 的 wire 消息推进 `messages`；等下一条 assistant 消息来
  flush 那条 `developer/message(tool-addition)` 时，`messages.at(-1)?.role !== "user"`
  成立 → UNSUPPORTED_CONTENT。宿主自己造的每条 `user/message` 都带
  `role:"user"` + `id`（对比 seq 1028/1059），只有我们的没有。
- **`source.kind:'plugin'`** → v4 落盘 admission 硬拒
  （`dsh-session-format-v3-to-v4/lib/index.js:126` + `:145,150` 的
  `assertV4SourceRowAdmission`，它对 `agent/inbox/spliced` 的 `inserted` 逐条查）。
  而且它抛在 `encodeEventBatch` 里，**整批一起失败**，同一回合里用户自己那条也写不进
  历史 —— 这就是「会话还是不能发送」的体感：不是没投出去，是投出去了但落盘被拒。
  `{kind:'plugin', plugin:'x'}` 是 v3 写法，v4 退休成「生产者自己的 kind 名」，
  迁移器把它改写成 `plugin:<id>` 或直接同名（`:87-93`），现役插件全部用裸名字
  （`webhook` / `team-message` / `agent-message`）。
- **没 `id`** → inbox 投影用 `message.id` 做「同一条不重复挂起」的去重键
  （`dsh-agent-loop/lib/index.js:43,192`），两条无 id 消息会被判成同一条。

**证据**：`logs/host/*.log` 从 09-27 到今天，`system update without` 只出现过 **1 次**
= 10:21 那次，正是第一条无 role 的桌宠消息所在回合；`producer-owned` 只出现在 15:21/15:22
两个回合的 `turn/end` 前，报错栈全在 `appendLines → encodeEventBatch`。

**修法**（`lib/index.js` 的 `sendToSession`）：一条完整消息 ——
`{ role:'user', id: randomUUID(), content:[{type:'text',text}], source:{ kind: fromUser ? 'user' : 'pet-bridge' } }`。
重投时重新生成 id（旧 id 可能已经进过 pending 列表，复用会被投影判成重复）。
回归测试覆盖了 v4 形状断言（role/id/source.kind/content，且全程不许出现 `kind:'plugin'`），13 → 17 条。

## 7. v0.4 端到端验证记录

用一个复刻沙箱语义的 harness（Proxy：未声明服务读属性即 throw）+ 真实舞台跑通：

```
inject = ["tools","systemPrompt","sessions","agents"]
舞台 /api/sessions → {"ok":true,"sessions":[{…},{…}]}          ← 修复前恒空
舞台 /api/health.plugin → {"sessions":{"ok":true,"count":2}, "agents":{"ok":true}, "delivered":1}
[agent] followup → sess-aaa-111 | 用户摸了摸你的头，现在已经自动说了「要干活吗？还是摸鱼？」。
outbox 剩余事件 = 0                                            ← ACK 生效
```

harness 位置：作者本机的 `_px/bridge-harness/`（不属于本仓库，仅作对照实验用）。
