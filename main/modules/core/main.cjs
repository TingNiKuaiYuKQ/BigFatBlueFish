// 舞台主进程（CommonJS）。
//
// 为什么是 CJS：Electron 的 ESM 主进程在本机这套工具链下不稳（electron 包导出拿不全）。
// 主进程用 CJS 是永远能跑的那条路；需要 ESM 的模块（server / prepare-model）用动态 import。
//
// 职责边界（尽量薄）：
//   - 开一个透明无边框窗口，渲染全交给 renderer
//   - 起本地服务（静态 + 反向 API），插件发来的动作转成 IPC
//   - 轮询 status.json，状态变化转成 IPC
//   - 窗口拖动 / 鼠标穿透 / 右键菜单 / 热键
//
// 不碰「模型参数」和「表情映射」—— 那些在 renderer 与 config.json，换模型不用动这文件。

const { app, BrowserWindow, ipcMain, Menu, shell, globalShortcut, nativeImage, screen, Tray, dialog } = require('electron')
const { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync, statSync, renameSync } = require('node:fs')
const { join, dirname, resolve, sep } = require('node:path')
const { homedir } = require('node:os')

/**
 * 解析 DPI 缩放比例。
 *
 * 为什么不自动读：Windows 只把 DPI 放在注册表里，而本机安全策略把 reg.exe
 * 拉黑了（「PROGRAM BLOCKED BY SECURITY POLICY」），Electron 又因为我们带了
 * --force-device-scale-factor=1 而统一报 scaleFactor=1，两边都拿不到真值。
 * 所以这个值改由 config.window.dpiScale 承载：
 *   Windows 设置 → 系统 → 显示 → 缩放：100%→1、125%→1.25、150%→1.5、175%→1.75。
 * 填 0 或留空按 100% 处理。
 */
function resolveDpiScale(configured) {
  const v = Number(configured)
  if (v > 0.5 && v <= 4) return v
  return 1
}

const paths = require('./paths.cjs')

const MAIN_ROOT = paths.MAIN_ROOT
const CONFIG_PATH = paths.CONFIG_FILE

const logLines = []
// 日志除了走 stdout（launch.mjs 抓），还落一份文件 —— 排查「表情卡住 / 自然事件
// 不发」这类问题时，用户随时可以把 run.log 发过来，不用每次跑一遍复现。
// 4MB 轮转一份 .1，两个文件封顶，不会把磁盘写满。
let LOG_FILE = ''
let logBytes = 0
let logBrokenAt = 0
function appendLogFile(line) {
  // 写失败后 60s 内不再试（避免每条日志都撞一次异常），之后自动重试 ——
  // 启动早期 app 还没 ready 时 getPath 可能拿不到，那种失败不该永久关掉落盘。
  if (logBrokenAt && Date.now() - logBrokenAt < 60000) return
  try {
    if (!LOG_FILE) {
      LOG_FILE = paths.RUN_LOG
      try { logBytes = statSync(LOG_FILE).size } catch { logBytes = 0 }
    }
    if (logBytes > 4 * 1024 * 1024) {
      try { renameSync(LOG_FILE, LOG_FILE + '.1') } catch { /* 占用中就算了，直接续写 */ }
      logBytes = 0
    }
    appendFileSync(LOG_FILE, line + '\n', 'utf8')
    logBytes += Buffer.byteLength(line) + 1
    logBrokenAt = 0
  } catch {
    logBrokenAt = Date.now()
  }
}

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(String).join(' ')}`
  logLines.push(line)
  if (logLines.length > 500) logLines.shift()
  console.log(line)
  appendLogFile(line)
}

// 探针：--selftest-write
// 握手文件（~/.dsh/live2d/endpoint.json）在本机报 EPERM，连「新建一个 .tmp」
// 都不行，而同样路径用普通 node 进程写完全正常。所以逐层试一遍，把 code/errno
// 打出来 —— 猜是没用的，要先确定是「路径」的问题还是「进程」的问题。
if (process.argv.includes('--selftest-write')) {
  const tries = [
    join(paths.RUNTIME_APP, 'w-probe.json'),
    join(homedir(), '.dsh', 'live2d', 'w-probe.json'),
    join(homedir(), '.dsh', 'w-probe.json'),
    join(homedir(), 'w-probe.json'),
  ]
  for (const p of tries) {
    try {
      writeFileSync(p, '{"probe":1}', 'utf8')
      log('[w] OK   ', p)
    } catch (e) {
      log('[w] FAIL ', p, 'code=' + e.code, 'errno=' + e.errno, 'syscall=' + e.syscall)
    }
  }
  log('[w] homedir =', homedir(), 'userData =', app.getPath('userData'))
  app.quit()
}

let win = null
let server = null
let config = null
let lastStatus = ''

// ---------- 运行时设置 / 会话清单 / 驾驶员事件通道 ----------
// 设置：设置页随时改（主题/主动说话/频率/绑定会话），存 runtime/app/settings.json。
// 会话清单：插件轮询上报，内存即可（插件会持续重推，舞台重启不丢数据）。
// 驱动事件：写 runtime/app/pet-events.json（环形缓冲），插件轮询转发到绑定会话。
//   为什么不放 ~/.dsh/live2d：本机 electron 进程对那个目录写入报 EPERM（见
//   --selftest-write 探针），main/runtime 一直可写。路径通过
//   endpoint.json 的 events 字段告诉插件，插件不需要知道舞台装在哪。
let runtimeSettings = null
let persona = null          // 人设行为卡（behavior/persona.mjs 载入）
let presetStore = null      // 演出预设（出厂 + 用户增删改）
let driverSessions = []
let behavior = null
let EVENTS_FILE = ''
// 插件上报的「绑定链路健康度」（sessions/agents 有没有拿到、最后一次错在哪）。
// 只用于 GET /api/health 和排查，不参与任何渲染逻辑 —— 但它是「列表为空」和
// 「接口调用失败」唯一的分辨依据，别再让它只活在插件进程的 stdout 里。
let bridgeHealth = null

function stageStateSnapshot() {
  return {
    expressions: Array.isArray(activeExprNames) ? activeExprNames : [],
    pose: lastStagePose,
    tracking: !!(behavior && behavior.tracking),
  }
}

// 主动说话频率 → 概率。低 25%（默认）/ 中 66% / 高 100%。
// 只门控「自动事件」（交互上报、盯盯观察）；用户在输入胶囊里手动说的话直通。
const FREQ_P = { low: 0.25, mid: 0.66, high: 1 }

let outboxSeq = 0
function pushDriverEvent(payload) {
  if (!EVENTS_FILE) return
  try {
    outboxSeq += 1
    let box = { v: 1, events: [] }
    try { box = JSON.parse(readFileSync(EVENTS_FILE, 'utf8')) } catch { /* 第一条 / 坏了就重建 */ }
    const events = Array.isArray(box.events) ? box.events : []
    events.push({ id: outboxSeq, at: Date.now(), ...payload })
    const tmp = EVENTS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify({ v: 1, events: events.slice(-24) }), 'utf8')
    require('node:fs').renameSync(tmp, EVENTS_FILE)
  } catch (e) {
    log('[driver-events] 写入失败：' + (e && e.message))
  }
}

/**
 * 插件 ACK：从 outbox 移除已送进绑定会话的事件。返回实际移除数。
 */
function ackDriverEvents(ids) {
  const kill = new Set(ids)
  try {
    const box = JSON.parse(readFileSync(EVENTS_FILE, 'utf8'))
    const events = (Array.isArray(box.events) ? box.events : []).filter((e) => !kill.has(Number(e.id)))
    const removed = (Array.isArray(box.events) ? box.events.length : 0) - events.length
    const tmp = EVENTS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify({ v: 1, events }), 'utf8')
    require('node:fs').renameSync(tmp, EVENTS_FILE)
    return removed
  } catch { return 0 }
}

// 事件在 outbox 里的容忍时长：插件 3s 一轮询，正常几秒内就 ACK。
// 超过这个时长还没被取走 = 插件离线 —— 丢弃并冒「断连」气泡。
const DRIVER_EVENT_TIMEOUT_MS = 90 * 1000
// 断连气泡的冷却：事件是逐条超时的，不冷却的话插件离线期间会刷屏
const DISCONNECT_BUBBLE_GAP_MS = 90 * 1000
let lastDisconnectBubbleAt = 0

function reapDriverEvents() {
  if (!EVENTS_FILE) return
  let expired = 0
  try {
    const box = JSON.parse(readFileSync(EVENTS_FILE, 'utf8'))
    const all = Array.isArray(box.events) ? box.events : []
    const now = Date.now()
    const keep = all.filter((e) => now - Number(e.at || 0) < DRIVER_EVENT_TIMEOUT_MS)
    expired = all.length - keep.length
    if (expired > 0) {
      const tmp = EVENTS_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify({ v: 1, events: keep }), 'utf8')
      require('node:fs').renameSync(tmp, EVENTS_FILE)
    }
  } catch { /* 读不到就没有可回收的 */ }
  if (expired > 0 && Date.now() - lastDisconnectBubbleAt >= DISCONNECT_BUBBLE_GAP_MS) {
    lastDisconnectBubbleAt = Date.now()
    log('[driver-events]', expired, '条事件超时丢弃（插件离线）')
    if (win && !win.isDestroyed()) {
      win.webContents.send('pet:action', { kind: 'say', text: '诶？诶？！好像断连了诶……', ms: 3200, at: Date.now() })
    }
  }
}

/** 频率门控 + 绑定检查：没绑定会话或主动说话关着，自动事件就地丢弃。
 *  插件在不在线不管 —— 事件照常入队，插件离线由超时回收器兜底（断连气泡）。
 *
 *  每条丢弃都留一行日志（5s 节流）：自然事件「发了但没反应」时，得能区分
 *  「根本没发」「发出去被门控丢了」「进了 outbox 但插件没取走」三种情况。 */
let lastGateLogAt = 0
function gateLog(reason, payload) {
  const now = Date.now()
  if (now - lastGateLogAt < 5000) return
  lastGateLogAt = now
  log('[driver-gate] 丢弃', String(payload?.kind || '?'), '：' + reason)
}

function gateAndPush(payload) {
  // 省电模式（0.5.7 口径）：主动说话**设置不生效、固定 0%** —— 不向驾驶员发任何
  // 待机消息，也不留 outbox 残渣。user-input 例外（用户自己打的字属于用户意图）。
  if (lowInterrupt && payload?.kind !== 'user-input') {
    return gateLog('省电模式（主动说话固定 0%）', payload)
  }
  const s = runtimeSettings || {}
  if (!s.bind) return gateLog('没有绑定会话', payload)
  if (payload.kind !== 'user-input') {
    if (!s.proactive) return gateLog('主动说话是关的', payload)
    const p = FREQ_P[s.freq] ?? FREQ_P.low
    if (Math.random() >= p) return gateLog(`频率门控（${s.freq}=${p}）未通过`, payload)
  }
  log('[driver-events] 入队', String(payload.kind || '?'),
    Array.from(String(payload.text || '')).slice(0, 24).join(''))
  pushDriverEvent(payload)
}

/**
 * 驾驶员通道的三个开关，启动时从 config.driver 解析一次。
 *
 * 桌宠本身是独立程序：不配这一节（或 driver.enabled = false），它就是一个
 * 会呼吸、眨眼、跟视线、能拖动、能换表情的完整桌宠，不碰任何外部文件。
 * 只有启用后，外部程序（DSH 插件、将来的 WorkBuddy 插件……）才能遥控它。
 *
 * 两条通道方向相反，所以路径分开配：
 *   正向 驾驶员 → 桌宠：它写 stateFile，我们轮询读
 *   反向 桌宠 → 驾驶员：我们写 endpointFile，它读了才知道端口和 token
 */
let DRIVER = { enabled: true, stateFile: '', endpointFile: '' }

/**
 * 窗口几何的持久化文件。
 *
 * 放在 runtime/app/ 而不是 config.json：config 是人手改的设计参数，
 * 这里是程序自己维护的运行时状态（上次停在哪、多大）。混在一起会互相覆盖。
 * 0.6.0 起不再跟着 Chromium 的 user-data-dir 走，实例隔离改由启动参数决定。
 */
const geoPath = () => paths.WINDOW_FILE

/** 读上次保存的几何。文件坏了 / 不存在都当没有，不影响启动。 */
function readGeometry() {
  try {
    const s = JSON.parse(readFileSync(geoPath(), 'utf8'))
    return s && typeof s === 'object' ? s : null
  } catch { return null }
}

/**
 * 把窗口矩形夹到某块屏幕的工作区内。
 *
 * 为什么要夹，而不是「检测不到就回退默认」：
 *   · 保存的坐标是按「上次那套显示器」算的。拔掉外接屏、改分辨率之后，
 *     老坐标可能整个在屏幕外 —— 窗口"消失"但进程还在跑，用户只会觉得打不开。
 *   · 窗口比工作区高的时候（本机 1365 > 1600-任务栏），如果 y 还是原值，
 *     Windows 会在 show 之后自己把窗口推回可见区域 —— 那次推送由系统决定，
 *     实测 1000,300 被推成 1628,295，位置就漂了。
 *
 * 自己夹一次，位置就是确定的：尽量保留用户原来的位置，只把超出的部分拉回来。
 */
function clampGeometry(x, y, w, h) {
  try {
    const disp = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
    const b = disp.workArea
    // 窗口比屏幕还大时 max 会小于 b.x，所以先跟 b.x 取大，避免把窗口推到负方向
    const maxX = Math.max(b.x, b.x + b.width - w)
    const maxY = Math.max(b.y, b.y + b.height - h)
    const nx = Math.min(Math.max(x, b.x), maxX)
    const ny = Math.min(Math.max(y, b.y), maxY)
    return { x: Math.round(nx), y: Math.round(ny), clamped: nx !== x || ny !== y }
  } catch {
    return { x: Math.round(x), y: Math.round(y), clamped: false }
  }
}

// 穿透判定所需的两样东西，都由渲染层送上来：
//   alphaMask —— 角色轮廓的 1/4 降采样掩码
//   dragging  —— 拖动期间强制不穿透（否则拖到透明区就丢了）
let alphaMask = null
let dragging = false
// 编辑模式（右键长按进入）：改位置/改尺寸期间也要强制不穿透，
// 因为虚线框热区有一半落在角色剪影之外，一旦穿透鼠标事件就直接丢了。
let editMode = false
// 模型在窗口里的实际矩形（窗口坐标）。窗口比模型宽，菜单要贴模型而不是窗口边。
let modelRect = null
// 渲染层同步的舞台状态：激活表情集合（穿透/菜单勾选 + 驾驶员事件快照共用）与姿势
let activeExprNames = []
let lastStagePose = null
// 穿透状态的唯一真源。不要读 win.isIgnoringMouseEvents() —— 这个 Electron 版本
// 上它不存在（读到 undefined），热键会因为「读到 false 就设成 true」变成单向的。
let ignoring = false
// 手动切换穿透后，暂停自动判定到这个时间点。否则 50ms 的巡检会立刻改回去。
let autoIgnoreAt = 0
// 托盘对象必须留全局引用：一旦被 GC，托盘图标会凭空消失（Electron 的老坑）。
let tray = null
// 省电模式运行态（原「低打扰」）。不写进 settings.json —— 不跨重启保留。
let lowInterrupt = false

// 省电模式固定 24 帧（0.5.7 口径：比正常低，但比 12 帧还看得出呼吸）。
const LOW_FPS = 24

/**
 * 当前该跑多少帧：省电固定 24；否则看设置页（30 / 60 / 0=无限制）。
 * 0 交给 vsync —— 也就是「屏幕支持的最大帧率」。
 */
function targetFps() {
  if (lowInterrupt) return LOW_FPS
  const v = Number(runtimeSettings && runtimeSettings.fpsCap)
  if (v === 30 || v === 60) return v
  // 「无限制」= 显示器刷新率。不能真给 0（= 不限）：那样会按能跑多快跑多快，
  // 屏幕只有 60Hz 时多出来的帧全是白烧的 GPU。
  try {
    const hz = Number(screen.getPrimaryDisplay().displayFrequency) || 0
    if (hz >= 24) return Math.round(hz)
  } catch { /* 拿不到就退回配置值 */ }
  return Number(loadConfig().raw?.perf?.fpsCap) || 0
}

// 窗口基准尺寸（物理像素）。config 里写的是「逻辑尺寸」，
// 会乘上真实 DPI 比例 —— 因为启动时强制了 1x 缩放，物理像素 = CSS 像素。
let BASE_W = 520
let BASE_H = 780
let UI_SCALE = 1
let resizeCount = 0
// 退出前把几何刷盘。定义在 main() 里，这里先占位，免得 before-quit 拿不到。
let flushGeometry = () => {}

function loadConfig() {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const configured = resolve(MAIN_ROOT, raw.model?.dir || 'model/runtime')
  // 模型目录两级查找：
  //   1) config 写的路径（默认 model/runtime，相对 MAIN_ROOT）
  //   2) main/model/runtime —— 配置写坏时的固定兜底
  const local = paths.MODEL_DIR
  const modelDir = existsSync(configured) ? configured : (existsSync(local) ? local : configured)
  return { raw, modelDir, modelFile: raw.model?.file || '' }
}

/* ---------------------------------------------------------- 无控制台启动（0.5.1 / 0.6.0）
 *
 * 双击快捷方式 → electron.exe --launcher → 本分支。
 *
 * 优先触发计划任务 BigFatBlueFishLauncher（由 scripts/shortcut.mjs install 创建）：
 * 任务计划器用自己的服务进程启动 node launch.mjs，node 不在 electron 的进程树里。
 * 这一步是必须的 —— 实测 electron 直接 spawn node 时，node 子进程仍会被本机
 * 安全策略挡在 ~/.dsh/live2d 外（EPERM），endpoint 镜像写不出去，插件就找不到桌宠。
 *
 * 任务不存在（没跑过 install）时退回直接 spawn node：桌宠能起来，但在受限环境下
 * 握手镜像可能失败，日志里会明确写出来。
 *
 * 三条实测结论不变（见 v0.5计划书 §2.1）：
 *   · 启动器必须 process.exit(0)：ready 之前 app.exit() 会让进程挂住；
 *   · 不能用 ELECTRON_RUN_AS_NODE 让 electron 冒充 node 去写 ~/.dsh/live2d；
 *   · 快捷方式参数不能超过 259 字符，所以只放 "<main>" --no-sandbox --launcher。
 */

function launchLogPath() {
  return paths.LAUNCH_LOG
}

/** 启动器/launch.mjs 的输出：追加写，1 MB 轮转一份 .1 */
function appendLaunchLog(line) {
  try {
    const dir = paths.RUNTIME_LOGS
    mkdirSync(dir, { recursive: true })
    const file = launchLogPath()
    let size = 0
    try { size = statSync(file).size } catch { size = 0 }
    if (size > 1024 * 1024) {
      try { renameSync(file, file + '.1') } catch { /* 占用中就直接续写 */ }
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* 写日志失败绝不影响启动 */ }
}

/** 找 node.exe：PATH（where.exe）→ Program Files 兜底 → 空 */
function findNodeExe() {
  try {
    const out = require('node:child_process')
      .execFileSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (first && existsSync(first)) return first
  } catch { /* PATH 里没有就试固定路径 */ }
  for (const p of [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ]) {
    if (existsSync(p)) return p
  }
  return ''
}

if (process.argv.includes('--launcher')) {
  // 0.6.0 起快捷方式直接指向 wscript.exe + main/launcher.vbs，不再走这个分支。
  // 保留它是为了手工调试：electron --launcher 仍能拉起舞台（受限环境下握手可能写不出去）。
  const nodeExe = findNodeExe()
  if (!nodeExe) {
    appendLaunchLog('找不到 node.exe：PATH 与 Program Files 都没有')
    try {
      require('electron').dialog.showErrorBox(
        '桌宠启动失败',
        '没有找到 Node.js（node.exe）。\n\n'
        + '桌宠需要一个 Node.js 运行时来拉起 Live2D 舞台。\n'
        + '请安装 Node.js（https://nodejs.org/，LTS 版本即可），装完重新双击快捷方式。\n\n'
        + '已经装过的话，确认 node.exe 在 PATH 里，或在 C:\\Program Files\\nodejs\\ 下。',
      )
    } catch { /* 弹窗失败也没别的办法 */ }
    process.exit(1)
  }
  try {
    const { spawn } = require('node:child_process')
    const child = spawn(nodeExe, [join(MAIN_ROOT, 'launch.mjs')], {
      cwd: MAIN_ROOT,
      env: process.env,      // 这里交给 launch.mjs 重建干净环境块（它负责去重代理变量）
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    })
    child.unref()
    appendLaunchLog(`启动器 → ${nodeExe} launch.mjs（pid ${child.pid}）`)
  } catch (e) {
    appendLaunchLog('拉起 launch.mjs 失败：' + (e && (e.stack || e.message)))
    try {
      require('electron').dialog.showErrorBox('桌宠启动失败', String((e && e.message) || e))
    } catch { /* 忽略 */ }
    process.exit(1)
  }
  // ready 之前必须用 process.exit —— app.exit() 在这里会让进程挂住
  process.exit(0)
}

/* ------------------------------------------------------ 快捷方式 / 开机自启（0.5.1 / 0.6.0） */

const LAUNCHER_VBS = join(MAIN_ROOT, 'launcher.vbs')

/**
 * 快捷方式的目标改成 wscript.exe + 生成的 launcher.vbs。
 *
 * 不能再用 electron.exe 做启动器：实测 electron 的子进程会被本机策略挡在
 * ~/.dsh 外（EPERM），launch.mjs 写不了 endpoint 镜像。wscript 由 Explorer 直接
 * 启动时不在 electron 进程树里，node 能正常写；wscript 本身是 GUI 子系统，无黑框。
 */
function shortcutTarget() {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
}

/** 快捷方式参数：**必须 ≤259 字符**（实测 256 以内原样保存，261 起被截断）。 */
function shortcutArgs() {
  return `"${LAUNCHER_VBS}"`
}

/** 生成 main/launcher.vbs（UTF-16LE + BOM），把当前 node.exe 路径写死。 */
function ensureLauncherVbs() {
  const nodeExe = findNodeExe()
  if (!nodeExe) return { ok: false, error: '找不到 node.exe（PATH 与 Program Files 都没有）' }
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"'
  const lines = [
    'Option Explicit',
    'Dim sh, fso, node, script, cmd',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `node = ${q(nodeExe)}`,
    `script = ${q(join(MAIN_ROOT, 'launch.mjs'))}`,
    'If Not fso.FileExists(node) Then',
    '  MsgBox "找不到 Node.js：" & node & vbCrLf & "请安装 Node.js 22+ 后重试。", vbCritical, "桌宠启动失败"',
    '  WScript.Quit 1',
    'End If',
    'If Not fso.FileExists(script) Then',
    '  MsgBox "找不到启动脚本：" & script, vbCritical, "桌宠启动失败"',
    '  WScript.Quit 1',
    'End If',
    `sh.CurrentDirectory = ${q(MAIN_ROOT)}`,
    'cmd = """" & node & """ """ & script & """"',
    'sh.Run cmd, 0, False',
    '',
  ]
  try {
    mkdirSync(MAIN_ROOT, { recursive: true })
    writeFileSync(LAUNCHER_VBS, '\uFEFF' + lines.join('\r\n'), { encoding: 'utf16le' })
    return { ok: true, path: LAUNCHER_VBS, node: nodeExe }
  } catch (e) {
    return { ok: false, error: '写 launcher.vbs 失败：' + ((e && e.message) || e) }
  }
}

function desktopLinkPath() {
  try { return join(app.getPath('desktop'), '桌宠.lnk') } catch { return '' }
}
function startMenuLinkPath() {
  const base = process.env.APPDATA || ''
  return base ? join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', '桌宠.lnk') : ''
}
function startupLinkPath() {
  const base = process.env.APPDATA || ''
  return base ? join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '桌宠.lnk') : ''
}

/** 调 scripts/shortcut.mjs（node 进程，异步）。返回它最后一行的 JSON，失败返回 null。
 *
 *  **必须异步**：这里是主进程，同步 spawn 会阻塞整个事件循环 —— 实测一次失败的
 *  PowerShell 调用能把舞台卡住 30 秒（HTTP 请求全部超时，看着像「桌宠死了」）。
 */
function runShortcutHelper(args) {
  const nodeExe = findNodeExe()
  if (!nodeExe) { log('[shortcut] 找不到 node.exe，无法用助手写快捷方式'); return Promise.resolve(null) }
  return new Promise((resolve) => {
    try {
      require('node:child_process').execFile(
        nodeExe,
        [join(paths.SCRIPTS_DIR, 'shortcut.mjs'), ...args],
        { cwd: MAIN_ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 },
        (err, stdout, stderr) => {
          const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
          if (err && !line) {
            log('[shortcut] 助手失败', 'code=' + (err.code || '?'), String(stderr || err.message).slice(0, 200))
            resolve(null)
            return
          }
          try { resolve(JSON.parse(line)) } catch (e) {
            log('[shortcut] 助手输出不是 JSON：' + String(line).slice(0, 160))
            resolve(null)
          }
        },
      )
    } catch (e) {
      log('[shortcut] 助手异常：' + (e && e.message))
      resolve(null)
    }
  })
}

/** 写一个指向启动器的 .lnk。返回 {ok, path, error} */
async function writePetShortcut(linkPath, description) {
  if (!linkPath) return { ok: false, path: '', error: '拿不到目标目录' }
  const vbs = ensureLauncherVbs()
  if (!vbs.ok) return { ok: false, path: linkPath, error: vbs.error }
  const target = shortcutTarget()
  if (!existsSync(target)) return { ok: false, path: linkPath, error: '找不到 wscript.exe' }

  // ① 首选：Electron 原生 API（不依赖 WSH/COM，同步且快）
  try {
    mkdirSync(dirname(linkPath), { recursive: true })
    const electronIcon = join(paths.NODE_MODULES, 'electron', 'dist', 'electron.exe')
    const ok = shell.writeShortcutLink(linkPath, 'create', {
      target,
      args: shortcutArgs(),
      cwd: MAIN_ROOT,
      icon: existsSync(electronIcon) ? electronIcon : target,
      iconIndex: 0,
      description: description || '桌宠',
      appUserModelId: 'BigFatBlueFish.Pet',
    })
    if (ok) {
      log('[shortcut] 已写入（electron）', linkPath, '| 参数', shortcutArgs().length, '字符')
      return { ok: true, path: linkPath }
    }
    log('[shortcut] writeShortcutLink 返回 false，改用 node 助手', linkPath)
  } catch (e) {
    log('[shortcut] electron 写入异常（改用 node 助手）：' + (e && e.message))
  }

  // ② 退路：node + PowerShell WScript.Shell。
  //    本机实测 electron 往 C:\Users\... 写会 EPERM，node 正常（见 scripts/shortcut.mjs 头注释）
  const h = await runShortcutHelper(['write', linkPath, description || '桌宠'])
  if (h && h.ok && existsSync(linkPath)) {
    log('[shortcut] 已写入（node 助手）', linkPath)
    return { ok: true, path: linkPath }
  }
  const err = (h && h.error) || 'electron 与 node 助手都写不进去'
  log('[shortcut] 写入失败', linkPath, '|', err)
  return { ok: false, path: linkPath, error: err }
}

/** 一次性安装：根 launcher + 桌面 + 开始菜单 */
async function installShortcuts() {
  const results = [
    await writePetShortcut(join(MAIN_ROOT, '..', 'launcher.lnk'), '启动桌宠'),
    await writePetShortcut(desktopLinkPath(), '启动桌宠'),
    await writePetShortcut(startMenuLinkPath(), '启动桌宠'),
  ]
  const okCount = results.filter((r) => r.ok).length
  log('[shortcut] 安装完成', okCount, '/', results.length)
  return { results, okCount }
}

/** 开机自启 = Startup 里有没有那个 .lnk（不维护第二份配置） */
function isAutostartOn() {
  const p = startupLinkPath()
  return !!(p && existsSync(p))
}

async function setAutostart(on) {
  const p = startupLinkPath()
  if (!p) return { ok: false, error: '拿不到 Startup 目录' }
  if (on) {
    const r = await writePetShortcut(p, '桌宠（开机自启）')
    log('[autostart] 开启 →', r.ok ? 'ok' : r.error)
    return r
  }
  try {
    if (existsSync(p)) { require('node:fs').unlinkSync(p); log('[autostart] 已删除 Startup 快捷方式') }
    return { ok: true, path: p }
  } catch (e) {
    log('[autostart] 删除失败', e && e.message)
    return { ok: false, error: String((e && e.message) || e) }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 未捕获异常必须留痕：0.5.1 之后没有控制台，进程静默消失会变成最难查的那类 bug。
  // （实测过一次：调用某个窗口级 API 后进程直接没了，run.log 一行都不留。）
  process.on('uncaughtException', (e) => {
    log('[fatal] uncaughtException', e && (e.stack || e))
    appendLaunchLog('[fatal] uncaughtException ' + String((e && (e.stack || e.message)) || e).slice(0, 2000))
  })
  process.on('unhandledRejection', (e) => {
    log('[fatal] unhandledRejection', e && (e.stack || e))
    appendLaunchLog('[fatal] unhandledRejection ' + String((e && (e.stack || e.message)) || e).slice(0, 2000))
  })
  app.on('second-instance', () => {
    // 被托盘隐藏时先 show 再 focus，否则「第二次双击」看着像没反应
    if (win && !win.isDestroyed()) { win.show(); win.focus() }
  })
  if (process.argv.includes('--install-shortcut')) {
    // 一次性入口：写桌面 + 开始菜单快捷方式后立即退出，不启动桌宠
    app.whenReady().then(async () => {
      const r = await installShortcuts()
      appendLaunchLog(`--install-shortcut 完成 ${r.okCount}/${r.results.length}：`
        + r.results.map((x) => `${x.path}=${x.ok ? 'ok' : x.error}`).join('; '))
      app.exit(r.okCount > 0 ? 0 : 1)
    }).catch((e) => { appendLaunchLog('安装快捷方式失败：' + (e && e.message)); app.exit(1) })
  } else {
    main().catch((e) => {
      log('启动失败', e && (e.stack || e))
      try {
        mkdirSync(paths.RUNTIME_LOGS, { recursive: true })
        writeFileSync(paths.CRASH_LOG, String((e && (e.stack || e)) || e))
      } catch { /* 写不了就算了 */ }
      app.quit()
    })
  }
}

/**
 * 拖动时把窗口移到 (x, y)。
 *
 * 两条都是「拖动闪烁」的直接来源，别改回去：
 *
 * 1. **一次屏幕刷新最多移一次**。渲染层的 rAF 跑在 120fps，屏幕多数是 60Hz ——
 *    一个合成周期里连发两次 SetWindowPos，DWM 会把上一帧的合成结果留在旧位置，
 *    看起来就是「形象在屏幕别处闪一下」。这里按显示器刷新率对齐合并请求。
 * 2. **这条路径绝对不碰尺寸**。老版本每次移动都 getSize 一遍、不等于基准就
 *    setSize —— 那是 175% DPI 下「越拖越大」的补丁。现在尺寸只由 applyResize 管，
 *    留着这段反而会在某些时刻触发真实 resize，画面必然跳一帧。
 *    （那段补丁的历史结论保留在这里：当年 520×780 被拖成 784×1070，就是没有它。）
 */
let moveInterval = 0
function getMoveInterval() {
  if (!moveInterval) {
    let hz = 0
    try { hz = screen.getPrimaryDisplay().displayFrequency || 0 } catch { /* 拿不到就按 60 */ }
    if (!hz || !Number.isFinite(hz)) hz = 60
    // 打九折：正好卡在刷新间隔上时，定时器抖动会让某些帧等到下一帧，反而更顿
    moveInterval = Math.max(6, Math.round((1000 / hz) * 0.9))
  }
  return moveInterval
}

let movePending = null
let moveTimer = 0
let moveAt = 0

function flushMove() {
  moveTimer = 0
  if (!win || win.isDestroyed()) { movePending = null; return }
  if (!movePending) return
  const { x, y } = movePending
  movePending = null
  const b = win.getBounds()
  if (b.x === x && b.y === y) return   // 位置没变就别 SetWindowPos，白闪一下没意义
  moveAt = Date.now()
  if (dbgMove) log('[moveTo] 应用 →', x + ',' + y)
  win.setPosition(x, y)
}

function moveTo(x, y) {
  if (!win || win.isDestroyed()) return
  const nx = Math.round(x)
  const ny = Math.round(y)
  if (movePending && movePending.x === nx && movePending.y === ny) return
  movePending = { x: nx, y: ny }
  if (moveTimer) return
  const wait = Math.max(0, getMoveInterval() - (Date.now() - moveAt))
  if (wait === 0) { flushMove(); return }
  moveTimer = setTimeout(flushMove, wait)
}

// moveTo 只应该由渲染层的拖动触发。为排查「没人拖它自己跑」，开个开关记录来源。
const dbgMove = process.argv.includes('--debug-move')

/**
 * 等比缩放。渲染层只给目标宽度，高度按「启动时的宽高比」算，锚点固定窗口中心。
 *
 * 实测（`--selftest-resize`）：`resizable: false` 的窗口 **setBounds 照样生效**，
 * 不需要临时 setResizable(true) —— 那个方向排查过，是错的，别再绕回去。
 * 真正的坑是下面这条：
 *   尺寸变了必须 `pet:resized` 通知渲染层重排 PIXI，否则画面只是被 CSS 拉伸。
 *   但不能用 window.resize 监听：canvas 变大 → body 撑开 → 窗口再变，正反馈能一路涨。
 */
let lastResizeAt = 0
// 启动时的窗口宽高比。缩放一律按它算高度 —— 用「当前比例」会在反复缩放里被
// 取整误差一点点带偏（1200 → 2339 → 1200 → 2338 …），基准锁死就没有这个问题。
let baseRatio = 0
function applyResize(targetWidth) {
  if (!win || win.isDestroyed()) return null
  const b = win.getBounds()
  const W = Math.max(160, Math.round(Number(targetWidth) || b.width))
  const ratio = baseRatio || BASE_H / Math.max(1, BASE_W)
  const H = Math.max(160, Math.round(W * ratio))
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const next = {
    x: Math.round(cx - W / 2),
    y: Math.round(cy - H / 2),
    width: W,
    height: H,
  }
  win.setBounds(next)
  const got = win.getBounds()
  if (got.width !== W || got.height !== H) {
    log('[resize] 尺寸没吃住：请求', W + 'x' + H, '实际', got.width + 'x' + got.height)
  }
  // 缩放会改变 BASE（见下面 pet:edit），这里同步一次，保证「缩放完再拖动」不会被按回旧尺寸
  BASE_W = got.width
  BASE_H = got.height
  lastResizeAt = Date.now()
  if (!win.isDestroyed()) win.webContents.send('pet:resized', { w: got.width, h: got.height })
  return got
}

/**
 * 掩码查询：取 3×3 邻域的最大值。
 * 掩码是 1/4 降采样，轮廓边缘有锯齿；单点判定会让穿透状态在边缘反复抖动，
 * 邻居兜一下最省事。
 */
function maskSolid(m, mx, my) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = mx + dx
      const y = my + dy
      if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue
      if (m.data[y * m.w + x] > 8) return true
    }
  }
  return false
}

/** 模型缺失时的引导窗（1.0.0）。
 *  仓库不带模型（版权归原作者），新机器 clone 下来必然缺文件；
 *  这时**绝不 throw** —— 抛异常只会变成「双击没反应」的悬案。给出说明入口，然后干净退出。 */
async function showMissingModelDialog(missingPath) {
  log('[model] 找不到模型：' + missingPath)
  const readme = join(MAIN_ROOT, 'model', 'README.md')
  let response = 1 // 默认当「退出」处理：连窗口都弹不出来时也不能卡住
  try {
    const r = await dialog.showMessageBox({
      type: 'warning',
      title: '没有找到模型',
      message: '桌宠需要 Live2D 模型才能站起来',
      detail: [
        '本仓库不附带 Live2D 模型（版权归原作者，不转授权）。',
        '',
        '怎么拿到：看 main/model/README.md，按里面四步做。',
        '',
        '期望的位置：',
        missingPath,
      ].join('\n'),
      buttons: ['打开说明', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    response = r.response
  } catch (e) {
    log('[model] 引导窗打不开：' + (e && e.message))
  }
  if (response === 0) {
    try { await shell.openPath(readme) } catch { /* 打不开就算了，路径已经写在日志里 */ }
  }
  app.exit(0)
}

async function main() {
  await app.whenReady()

  // 运行目录首启自建（runtime 整体不进版本库）
  for (const d of [paths.RUNTIME_APP, paths.RUNTIME_AUDIT, paths.RUNTIME_LOGS, paths.CHROMIUM_DIR]) {
    try { mkdirSync(d, { recursive: true }) } catch { /* 建不了就让具体写入报错 */ }
  }

  // 关掉后台节流：窗口失焦时 Chromium 会把 rAF 压到 1fps，桌宠必须一直看得见
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')

  config = loadConfig()
  const { perf = {}, window: winCfg = {}, driver: driverCfg = {} } = config.raw

  // ---------- 驾驶员通道（可选，默认启用）----------
  const expandHome = (p) => {
    const s = String(p || '').trim()
    if (!s) return ''
    return /^~[\\/]/.test(s) ? join(homedir(), s.slice(2)) : resolve(MAIN_ROOT, s)
  }
  DRIVER = {
    enabled: driverCfg.enabled !== false,
    stateFile: expandHome(driverCfg.stateFile) || paths.STATUS,
    endpointFile: expandHome(driverCfg.endpointFile) || paths.ENDPOINT,
  }
  // 命令行可以临时压掉驾驶员通道，不用改配置：
  //   start.cmd --no-driver
  // 用来验证「桌宠本身是否真的独立」，也方便开一个不受会话影响的纯净实例。
  if (process.argv.includes('--no-driver')) DRIVER.enabled = false
  if (!DRIVER.enabled) log('[driver] 已关闭：纯独立模式（不读状态、不写 endpoint）')
  else log('[driver] 状态文件', DRIVER.stateFile)

  // ---------- 模型准备（贴图压缩，首次约 1 秒）----------
  // 先自己确认原始模型在不在：ensureOptimizedModel 内部第一步就读 model3.json，
  // 文件缺失时它抛的是 ENOENT —— 用户只会看到「窗口没出来就没了」。
  // 模型不随仓库分发（版权归原作者，见 main/model/README.md），新机器上必然缺，
  // 所以这里给一个能点开说明的引导窗，然后干净退出。
  if (!existsSync(join(config.modelDir, config.modelFile))) {
    await showMissingModelDialog(join(config.modelDir, config.modelFile))
    return
  }
  const { ensureOptimizedModel, loadExpressions } = await import('../../scripts/prepare-model.mjs')
  const modelPath = ensureOptimizedModel({
    modelDir: config.modelDir,
    modelFile: config.modelFile,
    maxEdge: Number(perf.textureMax) || 0,
    nativeImage,
    log: (...a) => log('[model]', ...a),
  })
  if (!existsSync(modelPath)) {
    await showMissingModelDialog(modelPath)
    return
  }
  const modelName = modelPath.slice(config.modelDir.length + 1).replace(/\\/g, '/')
  const expressions = loadExpressions(config.modelDir)
  log('[model] 表情', Object.keys(expressions).length, '个：', Object.keys(expressions).join(','))
  if (!Object.keys(expressions).length) log('[model] 警告：没扫到 Exp3，表情切换会退回默认')

  // ---------- 原生动画表（model3.json 的 Motions.arm 组）----------
  //
  // 手臂/持物类动作作者只做了 motion3 动画（VTS TriggerAnimation），**参数直驱推不动**：
  // 实测同样的参数值（Movement3/Param40/41/… 全顶格），原生 motion 通道手臂举起来，
  // 直驱纹丝不动 —— 引擎的 motion 管理每帧 loadParameters 恢复快照，直驱写在渲染
  // 管线里被冲掉（2026-11-03 对照实验，截图在 _research/arm-test.log）。
  // 所以这类动作走引擎原生通道：name = model3.json Motions.arm 里的文件名。
  // 顺序以 model3.json 数组为准（不能用 readdir，字典序会错位播错动画）。
  const animations = {}
  try {
    const model3 = JSON.parse(readFileSync(join(config.modelDir, modelName), 'utf8'))
    const arm = model3?.FileReferences?.Motions?.arm || []
    arm.forEach((m, i) => {
      const name = String(m?.File || '').replace(/\.motion3\.json$/, '').split('/').pop()
      if (!name) return
      let ms = 2000
      const params = []
      const ends = {}
      try {
        const d = JSON.parse(readFileSync(join(config.modelDir, String(m.File)), 'utf8'))
        ms = Math.max(300, Math.round((Number(d?.Meta?.Duration) || 2) * 1000))
        // 动画会碰的参数清单：原生通道播完不回落，渲染层要照这份清单
        // 在播完后把参数还原到播放前（否则「脱捕」末帧的张嘴/手部开关会一直挂着）
        //
        // ends = 每条曲线的**真实末值**。段格式是 [t0,v0] 起手，之后每段
        // [type, …]：0/2/3 是 3 个数（type,t,v），1（贝塞尔）是 7 个
        //（type,c1t,c1v,c2t,c2v,t,v）。末值必须自己解析 —— 引擎播到末尾
        // 会做 fadeOut 混回旧值，按「播放后读参数」拿到的常是中段混合值
        //（狗尾草卡在半透明、手停在半路就是这么来的）。
        for (const c of (d?.Curves || [])) {
          if (c?.Target !== 'Parameter' || !c?.Id) continue
          params.push(String(c.Id))
          const seg = c.Segments || []
          let i = 2          // 跳过起手 [t0, v0]
          let last = Number(seg[1]) || 0
          while (i < seg.length) {
            const type = seg[i]
            if (type === 1) { last = Number(seg[i + 6]) || 0; i += 7 }        // 贝塞尔
            else if (type === 0 || type === 2 || type === 3) { last = Number(seg[i + 2]) || 0; i += 3 }
            else break
          }
          ends[String(c.Id)] = last
        }
      } catch { /* 读不到就按 2s 估 */ }
      animations[name] = { index: i, ms, params, ends }
    })
  } catch (e) {
    log('[model] 动画表读取失败（手臂类动作不可用）：' + (e && e.message))
  }
  log('[model] 原生动画', Object.keys(animations).length, '个：', Object.keys(animations).join(','))

  // 合并动作名单：config.motions 的关键帧动作 + Animation 的原生动画，模型统一用 name 调
  const motionCatalog = {
    ...Object.fromEntries(Object.keys(config.raw?.motions || {}).filter((n) => !n.startsWith('_')).map((n) => [n, { ms: Number(config.raw.motions[n].ms) || 0 }])),
    ...animations,
  }

  // ---------- 本地服务 ----------
  const { startStageServer } = await import('./server.mjs')

  // --shot-on-motion=毫秒：第一个动作事件到达后延时连拍（调试动作/动画用）。
  // 挂在事件上而不是定时器上：动作什么时候来取决于外部脚本，定时器永远对不齐。
  const shotArg = process.argv.find((a) => a.startsWith('--shot-on-motion=')) || ''
  let shotArmed = !!shotArg
  const shotOnMotion = (evt) => {
    if (!shotArmed || !evt || evt.kind !== 'motion') return
    shotArmed = false
    const delay = Number(shotArg.split('=')[1]) || 400
    for (let i = 0; i < 3; i += 1) {
      setTimeout(async () => {
        try {
          if (!win || win.isDestroyed()) return
          const img = await win.webContents.capturePage()
          const out = join(paths.RUNTIME_LOGS, `motion-shot-${i}.png`)
          writeFileSync(out, img.toPNG())
          log('[shot] 已保存', out, img.getSize().width + 'x' + img.getSize().height)
        } catch (e) {
          log('[shot] 失败：' + ((e && e.message) || e))
        }
      }, delay + i * 700)
    }
  }

  // ---------- 运行时设置 / 驱动事件文件 ----------
  const { loadSettings, saveSettings } = await import('../settings/settings.mjs')
  const { loadPersona, makePresetStore } = await import('../behavior/persona.mjs')
  // 菜单规则（层级折叠 / 三态文案 / 行数上限）放在 menu.mjs，离线可测
  const menuLib = await import('../menu/menu.mjs')
  const lowLib = await import('../low-power/lowinterrupt.mjs')
  const SETTINGS_PATH = paths.SETTINGS_FILE
  runtimeSettings = loadSettings(SETTINGS_PATH)
  EVENTS_FILE = paths.EVENTS_FILE

  // 人设行为卡 + 演出预设（出厂 presets.json + 用户在设置页/工具里增删的那份）
  persona = loadPersona({ id: config.raw?.persona, log })
  presetStore = makePresetStore({ persona, userDataDir: paths.RUNTIME_APP, log })
  log('[persona]', persona.id, persona.card?.name || '(无名)', '｜预设', presetStore.list().length, '套')

  // 快捷指令（0.5.3）
  const cmds = await import('../commands/commands.mjs')
  let commandData = cmds.loadCommands().data
  log('[commands]', cmds.countItems(commandData), '条 /', commandData.groups.length, '组')
  // 投影成插件读的协议文件（~/.dsh/live2d/shortcuts.json）：
  // commands.json 是唯一真源，插件只认这一份 —— 不再各存一份互相失配。
  const publishShortcuts = () => {
    if (!DRIVER.enabled) return
    const r = cmds.publishShortcuts(commandData)
    if (r.ok) log('[commands] 白名单已同步 →', r.count, '条')
    else log('[commands] 白名单同步失败：' + r.error)
  }
  publishShortcuts()
  /**
   * 驾驶员改指令库的确认框。
   *
   * 用系统对话框而不是胶囊 UI：确认界面必须显示**完整命令行**，系统对话框能换行
   * 展示长路径、且不会因为透明窗口/置顶被误点。按钮默认「拒绝」。
   */
  async function confirmCommand(title, detail) {
    try {
      const r = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['允许', '拒绝'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: '桌宠 · 指令确认',
        message: title,
        detail,
      })
      return r.response === 0 ? 'allowed' : 'denied'
    } catch (e) {
      log('[commands] 确认框失败 ' + (e && e.message))
      return 'denied'
    }
  }

  // 「快捷操作」只有 20 个槽（用户口径）：超出的不进菜单，设置页里会提示。
  const MENU_CMD_SLOTS = 20

  // 菜单树：配置里 `children` 套几层就几层（实践上三级封顶），老配置的
  // 扁平 level:2 写法也在这里被折进「做点什么……」下面。
  const menuTree = menuLib.normalizeMenu(config.raw?.interact?.menu)
  log('[menu] 树结构', menuTree.map((n) => n.label + (n.children ? `(${n.children.length})` : '')).join(' / '),
    '深度', menuLib.menuDepth(menuTree))

  // 「表情和姿势」「快捷操作」的内容运行时才知道（表情来自模型扫描、指令来自 commands.json），
  // 每次右键现填 —— 加个表情/改条指令不用重启，也不会和配置各说各话。
  function menuTreeNow() {
    // 不加分组标题：分组标题也要占一行，会把「只显示 4 条」挤成 3 条半。
    const faces = Object.keys(expressions).map((n) => ({ label: n, action: 'expr:' + n }))
    const poses = Object.keys(config.raw?.poses || {})
      .filter((k) => !k.startsWith('_'))
      .map((k) => ({ label: POSE_LABEL[k] || k, action: 'pose:' + k }))
    const commands = cmds.listItems(commandData).map((x) => ({ id: x.id, label: x.label }))
    return menuLib.fillDynamic(menuTree, {
      faces: [...faces, ...poses],
      commands,
      maxCommands: MENU_CMD_SLOTS,
    })
  }

  // outbox 序号从「启动时间戳」起步，并在启动时清空旧文件。
  //
  // 为什么不能从 0 开始：插件那边持久化了轮询游标（data/poll-state.json 的 lastId），
  // 舞台重启后 seq 从 0 重来，新事件 id 就小于插件游标 —— 插件 filter(id > lastId)
  // 会把它们当成「已经转发过的旧事件」全部丢掉，而且永远是静默的（实测踩到：
  // 绑好会话、摸头有事件、投递数恒 0）。用毫秒时间戳当起点，跨重启天然单调。
  // 同时在启动时清空：上一个实例留下的事件已经没人认领了，留着只会干扰排查。
  outboxSeq = Date.now()
  try { writeFileSync(EVENTS_FILE, JSON.stringify({ v: 1, events: [] }), 'utf8') } catch { /* 写不了就按老内容走 */ }

  // 参数转储（调试 /api/params）：渲染层采集，这里做一次性的请求-应答桥。
  // 必须在 startStageServer 之前定义 —— options 里就引用了。
  let paramsDumpWaiter = null
  ipcMain.on('pet:params-dump', (_e, list) => {
    if (paramsDumpWaiter) {
      const r = paramsDumpWaiter
      paramsDumpWaiter = null
      r(Array.isArray(list) ? list : [])
    }
  })
  const requestParamsDump = () => new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve([])
    paramsDumpWaiter = resolve
    win.webContents.send('pet:dump-params')
    setTimeout(() => {
      if (paramsDumpWaiter === resolve) { paramsDumpWaiter = null; resolve([]) }
    }, 1500)
  })

  // 动画遥测（1.0.0）：开关单向下发、快照请求-应答，和参数转储同一套桥。
  // 为什么要它：判「动画流不流畅」只能看逐帧 dt 与参数变化量，/api/params 是某一刻的快照，
  // 掉帧和补间断档在快照里完全看不出来。
  let framesDumpWaiter = null
  ipcMain.on('pet:frames-dump', (_e, payload) => {
    if (!framesDumpWaiter) return
    const r = framesDumpWaiter
    framesDumpWaiter = null
    r(payload && typeof payload === 'object' ? payload : null)
  })
  const requestFramesDump = () => new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(null)
    framesDumpWaiter = resolve
    win.webContents.send('pet:dump-frames')
    setTimeout(() => {
      if (framesDumpWaiter === resolve) { framesDumpWaiter = null; resolve(null) }
    }, 1500)
  })
  const setTelemetry = (o) => {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('pet:telemetry-set', o || {})
    } catch { /* 窗口没起来就忽略 */ }
  }

  server = await startStageServer({
    modulesRoot: paths.MODULES_DIR,
    modelDir: config.modelDir,
    vendorDir: paths.VENDOR_DIR,
    // 人设行为卡：决定「她是谁」和「闲着时做什么」。换 pack 只改 config.persona。
    persona: {
      id: persona.id,
      name: persona.card?.name || '桌宠',
      nickname: persona.card?.nickname || '',
      tagline: persona.card?.tagline || '',
      prompt: persona.card?.prompt || '',
      available: persona.available,
      behavior: persona.behavior || null,
    },
    presetStore,
    // 首选固定端口（0 = 随机）：从它开始依次试 10 个，全占则退回随机。
    // 实际端口照旧写 endpoint.json —— 握手文件永远是唯一真相。
    preferredPort: Number(config.raw?.serverPort) || 0,
    modulesDir: paths.NODE_MODULES,
    // 开机自启（0.5.1）：真相是 Startup 目录里那个 .lnk 存不存在，不存第二份配置
    getAutostart: () => isAutostartOn(),
    setAutostart: (on) => setAutostart(!!on),
    installShortcuts: () => installShortcuts(),
    getTrayState: () => ({ lowInterrupt: !!lowInterrupt, visible: !!(win && !win.isDestroyed() && win.isVisible()) }),
    // 打开设置页（自动化验收 / 菜单动作共用一条路径）
    openSettings: (tab) => { try { openSettings(String(tab || '')) } catch (e) { log('[settings] 打开失败 ' + e.message) } },
    // 菜单开合（验收脚本用：真实右键手势没法自动化）
    openMenu: () => { try { openBubbleMenu() } catch (e) { log('[menu] 打开失败 ' + e.message) } },
    closeMenu: () => { try { closeBubbleMenu() } catch { /* 没开就算了 */ } },
    pickMenu: (id) => { try { runMenuAction(String(id || '')) } catch (e) { log('[menu] 执行失败 ' + e.message) } },
    // 教程（0.5.5）：唯一来源是 main/docs/tutorial.md
    getTutorial: () => {
      try { return { ok: true, text: readFileSync(paths.TUTORIAL_FILE, 'utf8') } } catch (e) {
        return { ok: false, error: '读不到 tutorial.md：' + (e && e.message) }
      }
    },
    // 省电模式（原「低打扰」）：手动开关 + 状态查询（设置页/验收脚本用）
    lowState: () => ({ on: !!lowInterrupt, source: lowMachine.source, auto: !!runtimeSettings?.autoLowInterrupt }),
    setLow: (on) => { setLowInterrupt(!!on, 'api'); return { on: !!lowInterrupt } },
    // 快捷指令（0.5.3）：数据 + 执行 + 确认，全在这一组里
    commands: {
      data: () => commandData,
      items: () => cmds.listItems(commandData),
      find: (id) => cmds.findItem(commandData, id),
      running: () => cmds.runningIds(),
      audit: (n) => cmds.readAudit(Number(n) || 50),
      run: (item, args, source) => cmds.runCommand(item, args, { source: source || 'menu' }),
      validate: (raw, isNew) => cmds.validateItem(raw, commandData, { isNew: isNew !== false }),
      confirm: (title, detail) => confirmCommand(title, detail),
      /** 保存整份指令库（调用方保证已经 validate 过） */
      save: (next) => {
        commandData = next
        const r = cmds.saveCommands(next)
        log('[commands] 已保存', r.items, '条 /', r.groups, '组')
        publishShortcuts()
        return r
      },
      reload: () => { commandData = cmds.loadCommands().data; publishShortcuts(); return commandData },
    },
    // 验收：在菜单页面里跑一段 JS（只给 /api/menu/eval 用，需要 token）
    menuEval: (js) => {
      if (!menuWin || menuWin.isDestroyed()) return Promise.resolve(null)
      return menuWin.webContents.executeJavaScript(String(js), true)
    },
    // driver 关闭时传空串：server 会跳过握手文件，一个字节都不往外写
    endpointPath: DRIVER.enabled ? DRIVER.endpointFile : '',
    endpointMirror: paths.ENDPOINT_MIRROR,
    getState: () => ({
      running: !!win,
      status: lastStatus,
      // 当前舞台状态（驾驶员决策用）：表情集合 / 姿势 / 是否盯盯
      stage: stageStateSnapshot(),
    }),
    onEvent: (evt) => {
      if (win && !win.isDestroyed()) win.webContents.send('pet:action', evt)
      try { shotOnMotion(evt) } catch { /* 调试截图失败不影响主流程 */ }
    },
    // 序列里用动作名时要等它演完，时长只有 config / 动画文件知道
    motionMs: (name) => Number(motionCatalog[name]?.ms) || 0,
    // 名字校验：合法名单只有这里知道（表情来自模型 Exp3 扫描，姿势/动作来自 config + 动画表）
    expressionNames: Object.keys(expressions),
    poseNames: Object.keys(config.raw?.poses || {}).filter((n) => !n.startsWith('_')),
    motionNames: Object.keys(motionCatalog),
    // 命中这张表的 motion 名字走引擎原生动画通道（手臂/持物类）
    animationNames: Object.keys(animations),
    // 按需截图：驱动脚本逐个播放条目后调用。透明窗口临时铺白底再 capturePage。
    capture: async (outFile, target = 'stage') => {
      // target='settings' 时截设置页：它是独立 BrowserWindow，只截桌宠窗口的话
      // 改版式只能靠肉眼。两个窗口都走「capturePage → 铺白底」同一条路径。
      // target='menu' 是 0.5.2 加的：三级鱼鳞层叠只能靠截图验收（透明窗口抓屏抓不到）。
      const pick = () => {
        if (target === 'settings') return settingsWin || null
        if (target === 'menu') return menuWin || null
        if (target === 'tutorial') return tutorialWin || null
        return win || null
      }
      const w = pick()
      if (!w || w.isDestroyed()) throw new Error(target === 'settings' ? '设置页没开' : (target === 'menu' ? '菜单没开' : (target === 'tutorial' ? '教程没开' : '窗口已销毁')))
      mkdirSync(dirname(outFile), { recursive: true })
      const img = await w.webContents.capturePage()
      // capturePage 在透明窗口上拿到的是 RGBA（透明背景），普通看图器会渲染成黑/棋盘格。
      // 这里合成到白底，保证一览图清楚。
      const png = require('../../scripts/lib/png-flatten.cjs').flattenToWhite(img.toPNG())
      writeFileSync(outFile, png)
      return img.getSize()
    },
    // 运行时设置（设置页读写）+ 会话清单（插件上报）+ 驱动事件文件路径
    getSettings: () => runtimeSettings,
    patchSettings: (patch) => {
      runtimeSettings = saveSettings(SETTINGS_PATH, patch)
      // 自动省电开关变了就立刻起/停观察器（不用重启）
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'autoLowInterrupt')) syncAutoMode()
      // 帧率改了立刻生效（省电模式期间不打断它的 24 帧）
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'fpsCap') && !lowInterrupt) {
        sendAction({ kind: 'perf', fpsCap: targetFps(), at: Date.now() })
      }
      log('[settings] 已保存：', JSON.stringify(patch).slice(0, 200))
      return runtimeSettings
    },
    getSessions: () => driverSessions,
    setSessions: (list) => {
      driverSessions = (Array.isArray(list) ? list : [])
        .filter((x) => x && (x.id || x.name))
        .map((x) => ({
          id: String(x.id || x.name),
          title: String(x.title || x.name || x.id || '').slice(0, 80),   // 省略交给设置页的 CSS，别在这里切
          // live = 会话此刻在内存里，事件能立刻投递；未打开的会话要等用户点开它。
          // 设置页用这个标志画「未打开」，不参与绑定判断（绑定本来就允许全部）。
          live: x.live !== false,
          at: Number(x.at) || Date.now(),
        }))
      log('[sessions] 插件上报', driverSessions.length, '个会话',
        `（存活 ${driverSessions.filter((s) => s.live).length}）`)
    },
    eventsFile: EVENTS_FILE,
    ackEvents: ackDriverEvents,
    getParams: requestParamsDump,
    getFrames: requestFramesDump, setTelemetry,
    // /api/health：外部探活 + 插件健康（详见 server.mjs 里那段注释）
    version: app.getVersion(),
    getBridgeHealth: () => bridgeHealth,
    setBridgeHealth: (h) => {
      // at = 舞台**收到**上报的时刻。插件那边的 healthSnapshot 刻意不带时间戳
      // （它不想每 3 秒重写一次 status.json），可菜单的在线判定只认 at ——
      // 于是只要绑定了就永远显示「驾驶员离线」（0.5.7 修的就是这条）。
      bridgeHealth = h && typeof h === 'object'
        ? { ...h, at: Date.now(), seenAt: Date.now() }
        : null
    },
    getDriverEnabled: () => DRIVER.enabled,
  })
  log('[server]', server.url)
  if (!DRIVER.enabled) log('[server] endpoint 跳过（独立模式）')
  else if (server.endpoint.ok) log('[server] endpoint', server.endpoint.path)
  else if (server.endpoint.skipped) log('[server] endpoint 跳过（没有驾驶员目录）')
  else log('[server] endpoint 写入失败：' + server.endpoint.error)

  const STATE_PATH = DRIVER.stateFile

  // ---------- ICP：必须在窗口之前注册 ----------
  // 窗口一 loadURL，renderer 立刻调 boot()；晚一行就是
  // "No handler registered for 'boot'"，表现是窗口白屏 + 控制台 FATAL。
  ipcMain.handle('boot', () => ({
    config: {
      ...config.raw,
      model: { ...config.raw.model, dir: config.modelDir },
      // 帧率以设置页为准（30/60/0=无限制）；省电模式另算，由 perf 事件覆盖
      perf: { ...config.raw.perf, fpsCap: targetFps() },
    },
    modelUrl: `/model/${encodeURI(modelName)}`,
    expressions,
    uiScale: UI_SCALE,
    __debugGaze: process.argv.includes('--selftest-gaze'),
    __debugExpr: process.argv.includes('--selftest-expression'),
    // 探针可以指定表情：--expr=流冷汗
    __exprName: (process.argv.find((a) => a.startsWith('--expr=')) || '').slice(7) || null,
    __debugCompose: process.argv.includes('--selftest-compose'),
    __debugParams: process.argv.includes('--debug-params'),
    __debugDrawables: process.argv.includes('--debug-drawables'),
    __debugHan: process.argv.includes('--debug-han'),
    __debugInteract: process.argv.includes('--debug-interact'),
    __debugClear: process.argv.includes('--selftest-clear'),
    __motionProbe: process.argv.includes('--motion-probe'),
    // 原生动画索引表：{ 名字: { index, ms } }，renderer 收到 animation 事件时查它
    animations,
    // 演出预设：{ 名字: {say, steps, desc} }。渲染层按剧本排时间轴，不查盘。
    presets: Object.fromEntries((presetStore?.list() || []).map((p) => [p.name, {
      say: p.say, desc: p.desc, steps: p.steps,
    }])),
    persona: persona ? { id: persona.id, name: persona.card?.name || null, tagline: persona.card?.tagline || null } : null,
    version: app.getVersion(),
  }))

  ipcMain.handle('win:bounds', () => (win ? win.getBounds() : null))
  ipcMain.on('win:move', (_e, x, y) => moveTo(x, y))
  ipcMain.on('win:ignore-mouse', (_e, ignore) => {
    if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true })
  })
  ipcMain.on('app:quit', () => app.quit())
  ipcMain.on('app:open-config', () => shell.openPath(CONFIG_PATH))
  ipcMain.on('app:open-status', () => shell.openPath(STATE_PATH))
  ipcMain.on('log', (_e, ...a) => log('[renderer]', ...a))

  // 渲染层送来轮廓掩码（只在表情/尺寸变化后送一次，几十 KB）
  // 渲染层同步过来的「当前激活表情集合」，右键菜单用它画勾。
  // 表情可以叠加（加载 key8 + 尾巴开关 Clothes5 互不冲突），所以这里是一组而不是一个。
  ipcMain.on('pet:expr-state', (_e, names) => {
    activeExprNames = Array.isArray(names) ? names : []
  })
  // 姿势变化上报（驾驶员事件要附舞台状态）
  ipcMain.on('pet:stage-state', (_e, s) => {
    if (s && typeof s === 'object') {
      if (s.pose !== undefined) lastStagePose = s.pose
    }
  })
  // 交互/观察事件上报：频率门控后写 pet-events.json，插件转发到绑定会话
  ipcMain.on('pet:driver-event', (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {}
    const text = String(p.text || '').trim()
    if (!text) return
    gateAndPush({
      kind: p.kind === 'observe' ? 'observe' : 'interaction',
      text,
      state: p.state || stageStateSnapshot(),
    })
  })

  // 参数转储的注册与 requestParamsDump 定义在 startStageServer 之前（见上）
  ipcMain.on('pet:model-rect', (_e, r) => {
    if (r && r.w > 0 && r.h > 0) modelRect = r
  })
  ipcMain.on('pet:mask', (_e, m) => {
    if (m && m.w > 0 && m.h > 0 && m.data) alphaMask = m
  })
  ipcMain.on('pet:dragging', (_e, v) => {
    const was = dragging
    dragging = !!v
    // 松手即落盘 —— 几何最自然的保存点就是这里。
    // 拖动过程中每帧 move 都写盘没有意义（100 次移动只关心最后停在哪），
    // 而且高频写盘会和透明窗口的重绘抢 IO。
    if (was && !dragging) flushGeometry()
  })

  // ---------- 编辑模式（右键长按后进入） ----------
  ipcMain.on('pet:edit', (_e, v) => {
    editMode = !!v
    log('[edit] 主进程 editMode =', editMode, 'resizable =', win ? win.isResizable() : '?')
    if (!editMode) flushGeometry()
  })

  // 等比缩放：渲染层只给目标宽度，其余交给 applyResize（细节见该函数注释）
  ipcMain.on('win:resize', (_e, w) => {
    if (!editMode) return
    applyResize(w)
  })

  // 快捷指令走自己的 HTTP API：保证「点菜单」和「模型调用」是同一条代码路径
  ipcMain.handle('shortcut:run', async (_e, id) => {
    try {
      const res = await fetch(`${server.url}/api/shortcut`, {
        method: 'POST',
        headers: { 'x-stage-token': server.token, 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      return await res.json()
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  })

  // 右键菜单 = 桌宠自己的控制面板。
  //
  // 这一块是「独立运行」的关键：不接任何驾驶员，用户也能换表情、换姿势、
  // 调穿透、退出。驾驶员插件只是额外提供「自动跟随会话状态」这层增强，
  // 拿掉它，菜单里每一项照样能用。
  const sendAction = (evt) => {
    if (win && !win.isDestroyed()) win.webContents.send('pet:action', { ...evt, at: Date.now() })
  }
  const POSE_LABEL = { default: '默认姿势', grass: '狗尾草', chest: '抚胸', finger: '竖食指' }
  const poseNames = Object.keys(config.raw.poses || {}).filter((k) => !k.startsWith('_'))


  // ---------- 设置窗口 ----------
  // 为什么再开一个窗口：设置页要「屏幕 70%」那么大，主窗口只有模型那么大，
  // 塞不进去；独立透明窗口也不碰舞台的穿透判定和渲染尺寸。
  let settingsWin = null

  function openSettings(tab = '') {
    if (settingsWin && !settingsWin.isDestroyed()) {
      // 已经开着：先显示再切页签（同一个 window，不重建，保留用户当前滚动位置以外的一切）
      if (settingsWin.isMinimized()) settingsWin.restore()
      settingsWin.show()
      // show() 对「已经可见但被别的置顶窗压住」不起作用，重新提一次最前
      settingsWin.moveTop?.()
      settingsWin.focus()
      log('[settings] 已开着，提到最前', 'visible=' + settingsWin.isVisible(),
        'focus=' + settingsWin.isFocused(), tab ? 'tab=' + tab : '')
      if (tab) {
        try {
          const u = new URL(settingsWin.webContents.getURL())
          u.searchParams.set('tab', tab)
          settingsWin.loadURL(u.toString())
        } catch { /* 拿不到 URL 就算了，页面本身还能用 */ }
      }
      return
    }
    const b = win && !win.isDestroyed() ? win.getBounds() : null
    const disp = screen.getDisplayNearestPoint(
      b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
        : screen.getCursorScreenPoint(),
    )
    const wa = disp.workArea
    const W = Math.round(wa.width * 0.7)
    const H = Math.round(wa.height * 0.7)
    const x = Math.round(wa.x + (wa.width - W) / 2)
    const y = Math.round(wa.y + (wa.height - H) / 2)
    // 展开方向看舞台落在屏幕哪一侧：在左 → 从卡片左下角长出来，在右 → 右下角。
    const stageCx = b ? b.x + b.width / 2 : wa.x + wa.width / 2
    const from = stageCx < wa.x + wa.width / 2 ? 'left' : 'right'

    settingsWin = new BrowserWindow({
      width: W,
      height: H,
      x,
      y,
      transparent: true,
      frame: false,
      resizable: false,
      hasShadow: false,
      roundedCorners: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(paths.SETTINGS_DIR, 'settings-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    settingsWin.setAlwaysOnTop(true, 'screen-above')
    settingsWin.once('ready-to-show', () => {
      if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus() }
    })
    settingsWin.on('closed', () => { settingsWin = null })
    // 页面报错必须留痕：0.5.x 出过一次「设置页整页空白」—— 一行注释把后面的
    // 代码吞了，脚本语法错误、一行都没执行，但 did-finish-load 照常触发，
    // 日志里只有「页面加载完成」，根本看不出问题。控制台/崩溃都接上。
    settingsWin.webContents.on('console-message', (_e, level, msg, line, src) => {
      if (level >= 2) log('[settings:console]', msg, src ? `(${src}:${line})` : '')
    })
    settingsWin.webContents.on('render-process-gone', (_e, d) => {
      log('[settings] 渲染进程退出', JSON.stringify(d))
      // 渲染进程没了，这个窗口就是个死壳：关掉，下次点「打开设置」重建一个
      try { settingsWin?.close() } catch { /* 已经没了 */ }
    })
    settingsWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log('[settings] 加载失败', code, desc, url)
    })
    settingsWin.webContents.on('did-finish-load', () => {
      log('[settings] 页面加载完成')
      // 调试自截图：透明窗口用系统截图抓不到（DWM 合成层拿不到），只能自己截自己。
      // 只在 --settings-shot 时跑：它会切页签、改设置，不适合和外部截图脚本同时用。
      if (process.argv.includes('--settings-shot')) {
        setTimeout(async () => {
          try {
            const shoot = async (file, tag) => {
              const img = await settingsWin.webContents.capturePage()
              writeFileSync(join(paths.RUNTIME_LOGS, file), img.toPNG())
              log('[settings] 自截图', tag, JSON.stringify(img.getSize()))
            }
            await shoot('settings.png', '外观页')
            await settingsWin.webContents.executeJavaScript(`
              document.querySelector('.tab[data-tab="behavior"]').click()
              document.getElementById('proactive').click()
              document.querySelector('input[name="freq"][value="mid"]').click()
              document.getElementById('chatmenu').scrollTop = 96
            `)
            await new Promise((r) => setTimeout(r, 700))
            await shoot('settings2.png', '行为页')
            // 验证三支主题色 + UI 缩放真的联动：直接改 CSS 变量再截一张
            await settingsWin.webContents.executeJavaScript(`
              (() => {
                const r = document.documentElement.style
                r.setProperty('--ui-bg', '#fff7e8')
                r.setProperty('--ui-star', '#ffe9c9')
                r.setProperty('--ui-edge', '#e8a33d')
                r.setProperty('--ui-text', '#8a5a12')
                document.querySelector('.tab[data-tab="look"]').click()
                const s = document.getElementById('ui-scale')
                s.value = '1.3'; s.dispatchEvent(new Event('input'))
              })()
            `)
            await new Promise((r) => setTimeout(r, 600))
            await shoot('settings3.png', '改色+1.3倍')
          } catch (e) { log('[settings] 自截图失败 ' + (e && e.message)) }
        }, 1400)
      }
    })
    // 调试：--settings-tab=behavior 让设置页直接落在指定页签（截图/回归用）
    const wantTab = tab
      || ((process.argv.find((a) => a.startsWith('--settings-tab=')) || '').split('=')[1] || '')
    settingsWin.loadURL(`${server.url}/settings/settings.html?from=${from}&dpi=${UI_SCALE}&token=${server.token}`
      + (wantTab ? `&tab=${encodeURIComponent(wantTab)}` : ''))
    // 兜底：transparent + show:false 的窗口在页面没画出第一帧时不会发 ready-to-show，
    // 表现就是「点了打开设置，什么都没出现」。1.2s 还没显示就强制 show 一次。
    const guard = setTimeout(() => {
      if (!settingsWin || settingsWin.isDestroyed()) return
      if (settingsWin.isVisible()) return
      log('[settings] ready-to-show 没来，强制显示')
      settingsWin.show()
      settingsWin.focus()
    }, 1200)
    settingsWin.once('closed', () => clearTimeout(guard))
    settingsWin.once('show', () => clearTimeout(guard))
    log('[settings] 打开', W + 'x' + H, '@', x + ',' + y, 'from=' + from, 'workArea', wa.width + 'x' + wa.height)
  }

  /* ---------- 教程窗口（0.5.5） ----------
   * 内容只有一份：pet/tutorial.md（窗口去 /api/tutorial 取）。
   * 首次启动自动打开一次；tutorial-state.json 的 seen 置真后不再自动弹。
   * 重看：菜单 其他 → 使用教程；或把它改回 seen:false；或加 --tutorial 启动。
   */
  let tutorialWin = null
  const TUTORIAL_STATE_PATH = paths.TUTORIAL_STATE_FILE

  function readTutorialState() {
    try {
      const j = JSON.parse(readFileSync(TUTORIAL_STATE_PATH, 'utf8'))
      return { seen: j?.seen === true, step: Number(j?.step) || 0, version: Number(j?.version) || 1 }
    } catch {
      return { seen: false, step: 0, version: 1 }
    }
  }
  function patchTutorialState(patch) {
    const next = { ...readTutorialState(), ...patch }
    try {
      mkdirSync(dirname(TUTORIAL_STATE_PATH), { recursive: true })
      writeFileSync(TUTORIAL_STATE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
    } catch (e) { log('[tutorial] 状态写入失败：' + (e && e.message)) }
    return next
  }

  function openTutorial() {
    if (tutorialWin && !tutorialWin.isDestroyed()) { tutorialWin.show(); tutorialWin.focus(); return }
    const disp = screen.getPrimaryDisplay().workArea
    // 尺寸（1.0.0）：正文改成 21px（旧版的 1.5 倍），窗口也得跟着放大，
    // 否则一屏只看得到两行。取法参照设置页（工作区 0.7×0.7），高度再放宽一点
    // —— 教程是竖着读的长文，工作区 1/3 的宽度分配才是舒服的阅读栏宽。
    const W = Math.min(1280, Math.round(disp.width * 0.72))
    const H = Math.min(980, Math.round(disp.height * 0.88))
    tutorialWin = new BrowserWindow({
      width: W,
      height: H,
      x: Math.round(disp.x + (disp.width - W) / 2),
      y: Math.round(disp.y + (disp.height - H) / 2),
      // 不透明 + 有边框：教程要能读、能拉大、能最小化，和设置页那种「贴纸感」不同
      transparent: false,
      frame: true,
      resizable: true,
      skipTaskbar: false,
      backgroundColor: '#f6f8ff',
      title: '桌宠使用教程',
      webPreferences: {
        preload: join(paths.TUTORIAL_DIR, 'tutorial-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    tutorialWin.loadURL(`${server.url}/tutorial/tutorial.html?token=${server.token}`)
    // 关掉就算看过了：以前只有点「已读」才置 seen，于是每次重启都自动弹一次教程。
    // 用户手动关窗＝不想再看，不该在下一次启动时再糊他一脸。
    tutorialWin.on('closed', () => {
      tutorialWin = null
      if (!readTutorialState().seen) { patchTutorialState({ seen: true }); log('[tutorial] 关窗即视为已读') }
    })
    log('[tutorial] 已打开', W + 'x' + H)
  }

  ipcMain.on('tutorial:close', () => { if (tutorialWin && !tutorialWin.isDestroyed()) tutorialWin.close() })
  ipcMain.on('tutorial:seen', () => { patchTutorialState({ seen: true }); log('[tutorial] 已标记为读过了') })

  ipcMain.on('settings:close', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
  })

  // ---------- 对话气泡（独立窗口） ----------
  // 为什么不像原来那样画在舞台上：气泡的换行宽度是相对舞台的（max-width 88%），
  // 舞台一缩到 300px，一句话就被切成五六行。气泡必须有自己的宽度，
  // 所以单独开一个透明小窗，位置贴在人物头顶，宽度由文字自己决定。
  let bubbleWin = null

  function ensureBubble() {
    if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin
    bubbleWin = new BrowserWindow({
      width: 240,
      height: 90,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      roundedCorners: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,          // 不许抢焦点，否则会打断正在编辑的输入框
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(paths.UI_DIR, 'bubble-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    bubbleWin.setAlwaysOnTop(true, 'screen-saver')
    bubbleWin.setIgnoreMouseEvents(true)   // 气泡永远不挡鼠标
    bubbleWin.on('closed', () => { bubbleWin = null })
    bubbleWin.loadURL(`${server.url}/ui/bubble.html`)
    return bubbleWin
  }

  /** 把气泡摆在人物头顶：水平对准模型中心，尾巴尖压在头发上沿下面一点 */
  function placeBubble(w, h) {
    if (!bubbleWin || bubbleWin.isDestroyed() || !win || win.isDestroyed()) return
    const b = win.getBounds()
    const mr = (modelRect && modelRect.w > 0) ? modelRect : { x: 0, y: 0, w: b.width, h: b.height }
    const cx = Math.round(b.x + mr.x + mr.w / 2)
    const bottom = Math.round(b.y + mr.y + 46)
    const disp = screen.getDisplayNearestPoint({ x: cx, y: bottom })
    const wa = disp.workArea
    let x = Math.round(cx - w / 2)
    let y = Math.round(bottom - h)
    x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - w - 4))
    y = Math.max(wa.y + 4, y)
    bubbleWin.setBounds({ x, y, width: w, height: h })

    // 尾巴必须跟着「人物在哪」走，不能永远钉在气泡正中：
    // 气泡被屏幕边夹住时（比如人在屏幕最右），气泡中心已经不在头顶了，
    // 尾巴如果还在中点，就会指向空气。这里算的是「头顶中心在气泡窗口里的 x」，
    // 再夹到两端圆角内侧，保证尾巴不会骑到圆角上。
    const tail = Math.max(26, Math.min(w - 26, Math.round(cx - x)))
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.webContents.send('bubble:tail', tail)
    }

    if (!bubbleWin.isVisible()) bubbleWin.showInactive()
  }

  ipcMain.on('pet:bubble', (_e, payload) => {
    const bw = ensureBubble()
    const p = { text: String(payload?.text || ''), ms: Number(payload?.ms) || 0 }
    const send = () => { if (bw && !bw.isDestroyed()) bw.webContents.send('bubble:show', p) }
    if (bw.webContents.isLoading()) bw.webContents.once('did-finish-load', send)
    else send()
  })

  /* ---------- 通知（0.5.2）：复用气泡窗口，排队 + 1s 去重 ----------
   *
   * 只用于「有异步过程」的动作（执行指令、写文件），点开设置这类即时动作不提示。
   * 气泡窗是 focusable:false + 忽略鼠标，所以这里只能显示文字，不能放按钮 ——
   * 0.5.5 的「下一步/跳过」会另开一个可交互窗口，别想着改造它。
   */
  const notifyQueue = []
  let notifyBusyUntil = 0
  let notifyTimer = 0
  let lastNotify = { text: '', at: 0 }

  function drainNotify() {
    if (notifyTimer) return
    const wait = notifyBusyUntil - Date.now()
    if (wait > 0) {
      notifyTimer = setTimeout(() => { notifyTimer = 0; drainNotify() }, wait)
      return
    }
    const next = notifyQueue.shift()
    if (!next) return
    const bw = ensureBubble()
    const send = () => { if (bw && !bw.isDestroyed()) bw.webContents.send('bubble:show', next) }
    if (bw.webContents.isLoading()) bw.webContents.once('did-finish-load', send)
    else send()
    notifyBusyUntil = Date.now() + next.ms
  }

  /** @returns {boolean} 是否真的排进了队列（去重命中返回 false） */
  function notify(text, opts = {}) {
    const t = String(text || '').trim()
    if (!t) return false
    const now = Date.now()
    if (lastNotify.text === t && now - lastNotify.at < 1000) return false
    lastNotify = { text: t, at: now }
    const err = opts.tone === 'error'
    notifyQueue.push({ text: err ? '⚠ ' + t : t, ms: Number(opts.ms) || (err ? 3200 : 1800) })
    if (notifyQueue.length > 6) notifyQueue.shift()
    drainNotify()
    log('[notify]', err ? 'error' : 'info', t.slice(0, 60))
    return true
  }

  ipcMain.on('bubble:size', (_e, size) => {
    const w = Math.max(80, Math.round(Number(size?.w) || 240))
    const h = Math.max(40, Math.round(Number(size?.h) || 80))
    placeBubble(w, h)
  })

  ipcMain.on('pet:bubble-hide', () => {
    if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.webContents.send('bubble:hide')
  })

  ipcMain.on('bubble:done', () => {
    if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.hide()
  })

  // ---------- 胶囊菜单（右键短按弹出） ----------
  // 为什么用独立窗口而不是同一个窗口里的 DOM：
  //   主窗口尺寸就是「模型刚好铺满」，菜单要伸到模型左右两侧，只能扩窗。
  //   扩窗会改变模型渲染尺寸和穿透掩码，代价大且容易出幺蛾子；
  //   独立窗口不动主窗口一根毫毛。
  let menuWin = null
  let menuForceClose = 0      // 页面动画没回关时的兜底定时器
  let menuBlurTimer = 0
  let menuBlurOn = false      // blur 只挂一次（兜底定时器可能和页面的 armed 赛跑）
  let menuClosing = false     // 已在收场中（失焦 / 再右键 / 点了某项），别重复触发

  function closeBubbleMenu() {
    if (menuForceClose) { clearTimeout(menuForceClose); menuForceClose = 0 }
    if (menuBlurTimer) { clearTimeout(menuBlurTimer); menuBlurTimer = 0 }
    if (menuWin && !menuWin.isDestroyed()) menuWin.close()
    menuWin = null
    menuBlurOn = false
    menuClosing = false
  }

  // 收场动画由页面播（逆向的出场动画），播完页面发 menu:close。
  // 这里只兜底：页面 JS 万一挂了，不能让一个透明窗口悬在桌面上没人关。
  function armMenuClose(ms) {
    if (menuForceClose) clearTimeout(menuForceClose)
    menuForceClose = setTimeout(() => { menuForceClose = 0; closeBubbleMenu() }, ms)
    if (menuForceClose.unref) menuForceClose.unref()
  }

  // 失焦（点到菜单外面）：也先播完消失动画，再由页面关窗
  function armMenuBlur() {
    if (!menuWin || menuWin.isDestroyed()) return
    menuWin.on('blur', () => {
      if (!menuWin || menuWin.isDestroyed()) return
      log('[menu] 失焦 → 播收场')
      menuClosing = true
      menuWin.webContents.send('menu:dismiss')
      armMenuClose(1800)
    })
  }

  ipcMain.on('menu:close', () => closeBubbleMenu())

  // 菜单页 1.2s 问一次：驾驶员可能就在菜单开着的时候上线/下线。
  ipcMain.handle('menu:status', () => {
    try { return menuLib.menuStatus(runtimeSettings || {}, bridgeHealth) } catch { return { kind: 'input', text: '请输入文本 > _ ', disabled: false } }
  })

  // 入场动画放完了 —— 主进程这时候才允许失焦关窗（早于动画，窗口会在
  // 自己还没稳定时被自己的 blur 掐掉）。页面没回话时 1.5s 后强制武装。
  ipcMain.on('menu:armed', () => {
    if (menuBlurTimer) { clearTimeout(menuBlurTimer); menuBlurTimer = 0 }
    armMenuBlur()
  })

  // 选了哪项：先执行动作，收场动画并行播（点「打开设置」不该等 0.8s 才响应）。
  // 关窗交给页面（动画播完发 menu:close），这里不再抢先 close。
  ipcMain.on('menu:pick', (_e, id) => {
    menuClosing = true
    runMenuAction(String(id || ''))
    armMenuClose(1800)
  })

  // 一级 ↔ 二级只改「页面上显隐哪些胶囊」，窗口尺寸从头到尾不变，
  // 所以这里没有任何 IPC：展开/收起是纯渲染层的事。

  // 菜单最下方的输入胶囊提交：「用户说：…」直接走驾驶员通道（不受主动说话
  // 频率门控 —— 手动说话是明确意图）。没绑定会话时冒气泡告知，不丢字。
  ipcMain.on('menu:input', (_e, text) => {
    const t = String(text || '').trim()
    if (!t) return
    if (!runtimeSettings.bind) {
      sendAction({ kind: 'say', text: '还没有绑定驾驶员会话，这句话送不到。', ms: 3000 })
      return
    }
    log('[menu] 用户说：' + t)
    pushDriverEvent({ kind: 'user-input', text: `用户说：${t}`, state: stageStateSnapshot() })
  })

  /** 菜单项动作：能主进程处理的就地处理，其余转给渲染层 */
  function runMenuAction(id) {
    // 查的是「填过内容」的那棵树：表情/指令的 id 只存在于运行时那一份
    const item = menuLib.findMenuItem(menuTreeNow(), id) || menuLib.findMenuItem(menuTree, id)
    if (!item) return log('[menu] 未找到项', id)
    const a = item.action || ''
    log('[menu] 执行', id, '→', a)
    if (a === 'quit') return app.quit()
    if (a === 'low-interrupt') return setLowInterrupt(true, 'menu')
    if (a === 'tutorial') return openTutorial()
    if (a === 'tutorial-reset') { patchTutorialState({ seen: false }); return openTutorial() }
    if (a === 'open-config') return shell.openPath(CONFIG_PATH)
    if (a === 'open-settings') return openSettings()
    // 快捷指令：走 /api/commands/run（commands.json 是唯一真源，cmd 内置命令也能跑）。
    // /api/shortcut 是给插件用的老接口，只认 ~/.dsh/live2d/shortcuts.json 那份投影。
    if (a.startsWith('command:')) {
      const cid = a.slice('command:'.length)
      const label = item.label || cid
      notify('执行中…', { ms: 1400 })
      fetch(`${server.url}/api/commands/run`, {
        method: 'POST',
        headers: { 'x-stage-token': server.token, 'content-type': 'application/json' },
        body: JSON.stringify({ id: cid }),
      }).then((r) => r.json())
        .then((r) => {
          // 成功也要有反馈：以前只在失败时冒泡，于是「现在几点」「列出目录」这类
          // 有输出的指令点完像没反应（输出只进了审计日志）。
          if (!r || r.ok !== true) {
            const why = String((r && r.error) || '未知错误')
            const code = r && Number(r.code) >= 0xc0000000
              ? `（0x${(Number(r.code) >>> 0).toString(16).toUpperCase()}）` : ''
            notify(`执行失败：${why}${code}`, { tone: 'error', ms: 4200 })
            return
          }
          const out = String(r.output || '').trim()
          if (out) {
            log('[commands] 输出', out.slice(0, 400))
            // 取**最后**几行：命令的结果通常在尾巴上（dir 的最后是「N 个文件…」，
            // 头几行只是卷标和路径）。整段太长的只留前 140 字。
            const brief = out.split('\n').map((s2) => s2.trim()).filter(Boolean).slice(-3).join(' / ')
            notify(`${label}：${brief}`.slice(0, 140), { ms: 3800 })
          } else {
            notify(`已执行：${label}`, { ms: 1800 })
          }
        })
        .catch((e) => notify('执行失败：' + (e && e.message), { tone: 'error', ms: 3200 }))
      return
    }
    if (win) win.webContents.send('pet:menu-action', a)
  }

  /** 调试连拍：出场是从下到上逐个弹，收场是反向，单张截图看不出顺序，也拍不到闪烁 */
  function menuShotBurst(w) {
    const n = 24
    for (let i = 1; i <= n; i += 1) {
      setTimeout(async () => {
        if (!w || w.isDestroyed()) return
        try {
          const img = await w.webContents.capturePage()
          writeFileSync(join(paths.RUNTIME_LOGS, `menu-${String(i).padStart(2, '0')}.png`), img.toPNG())
        } catch (e) { log('[menu] 自截图失败 ' + (e && e.message)) }
      }, 100 * i)
    }
    log('[menu] 连拍 ' + n + ' 张（每 100ms）→ runtime/logs/menu-NN.png')
  }

  function openBubbleMenu() {
    if (!win || win.isDestroyed()) return
    if (menuWin && !menuWin.isDestroyed()) {
      // 菜单开着再右键 = 收场。让页面播逆向动画再关窗（直接 close 是「啪」地消失，
      // 和点空白的观感不一致）；已在收场中就不重复触发。
      if (!menuClosing) {
        menuClosing = true
        menuWin.webContents.send('menu:dismiss')
        armMenuClose(1800)
      }
      return
    }

    if (!menuTree.length) return

    // 每次打开都重算一次树（表情/指令可能刚变过），也让这次弹窗的在线状态是新的
    const tree = menuTreeNow()

    // 尺寸定死为整数：胶囊 84 高 / 330 宽，星纹 26px 一格（17 的 1.5 倍取整）。
    // 最下面一行固定是输入胶囊（660×168），窗口宽度按它算；高度固定成 maxRows 行
    // （默认 6，按屏幕高度再夹一次）—— 层内超出就滚动，窗口尺寸自始至终不变。
    const CAP_W = 330, PAD = 36, ROW = 84, GAP = 15, IN_W = CAP_W * 2, IN_H = ROW * 2
    const W = IN_W + PAD
    const b = win.getBounds()
    const disp = screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) })
    const db = disp.bounds
    // 行数上限 = min(屏幕放得下, 5)：4 行列表 + 1 行固定的「返回」。用户口径是
    // 「列表只显示 4 条」，所以不跟着屏幕变大 —— 大屏也只是列表更高，不是条目更多。
    const capRows = Math.min(5, menuLib.maxRows({ screenH: db.height, inH: IN_H, row: ROW, gap: GAP, pad: PAD }))
    const rows = menuLib.windowRows(tree, capRows)
    const menuH = (n) => n * ROW + IN_H + n * GAP + PAD
    const H = menuH(rows)

    // 贴「人物」而不是「窗口」：窗口按 2:3 建，模型是 1:2.05，
    // 左右各有约 120px 透明留白，贴窗口边会看起来离人很远。
    const mr = (modelRect && modelRect.w > 0)
      ? modelRect
      : { x: 0, y: 0, w: b.width, h: b.height }
    const mLeft = b.x + mr.x
    const mRight = b.x + mr.x + mr.w
    const mTop = b.y + mr.y
    const EDGE_GAP = 8   // 菜单离模型边缘的间距

    // 优先贴模型右边；放不下换左边；再放不下就夹回屏幕内
    let side = 'to-right'
    let x = Math.round(mRight + EDGE_GAP)
    if (x + W > db.x + db.width) {
      side = 'to-left'
      x = Math.round(mLeft - W - EDGE_GAP)
      if (x < db.x) {
        x = Math.max(db.x + 8, Math.min(Math.round(mRight - W), db.x + db.width - W - 8))
      }
    }

    // 定位按「全展开」那只窗口算，并且**一次开到位**：展开/收起只显隐胶囊，
    // 绝不改窗口尺寸 —— 透明无边框窗口 setBounds 会让 DWM 重新合成，
    // 那一下就是用户看到的闪烁（100ms 连拍抓不到，只有一帧）。
    // 收起态的内容靠 #list 贴底定位落在同一条底线上。
    let y = Math.round(mTop + mr.h * 0.32 - H / 2)
    y = Math.max(db.y + 8, Math.min(y, db.y + db.height - H - 8))

    // 页面需要的全部输入一次性塞进查询串（菜单是独立窗口，没有别的 IPC 通道传数据）：
    // 树 + 输入胶囊三态 + 行数上限 + 贴边方向。
    const q = encodeURIComponent(JSON.stringify({
      tree,
      status: menuLib.menuStatus(runtimeSettings || {}, bridgeHealth),
      rows,
      capW: CAP_W,
      side,
    }))
    menuWin = new BrowserWindow({
      width: W,
      height: H,
      x,
      y,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      roundedCorners: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(paths.MENU_DIR, 'menu-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    menuWin.setAlwaysOnTop(true, 'screen-saver')
    // 透明无边框窗口必须显式 show + 置顶，否则会「有内容但看不见」
    menuWin.once('ready-to-show', () => { if (menuWin && !menuWin.isDestroyed()) { menuWin.show(); menuWin.moveTop() } })
    menuWin.webContents.on('console-message', (_e, lvl, msg, line, src) => log('[menu:console]', msg, src ? `(${src}:${line})` : ''))
    menuWin.webContents.on('did-fail-load', (_e, code, desc, url) => log('[menu] 加载失败', code, desc, String(url).slice(0, 160)))
    menuWin.webContents.on('did-finish-load', () => {
      log('[menu] 页面加载完成 visible=' + menuWin.isVisible())
      if (!menuWin.isVisible()) { menuWin.show(); menuWin.moveTop() }
      if (process.argv.includes('--debug-menu')) menuShotBurst(menuWin)
    })
    const open2 = process.argv.includes('--debug-menu-sub') ? '&open2=1' : ''
    menuWin.loadURL(`${server.url}/menu/menu.html?d=${q}${open2}`)
    // 页面入场动画放完会发 menu:armed，那时才允许失焦收场（早于动画，窗口会在
    // 还没稳定时被自己的 blur 掐掉）。页面万一没回话，1.5s 后照样武装。
    menuBlurTimer = setTimeout(() => { menuBlurTimer = 0; armMenuBlur() }, 1500)
    log('[menu] 弹出', side, x + ',' + y + ' ' + W + 'x' + H, '行上限', rows, '根项', tree.length,
      '｜表情', tree[0]?.children?.[0]?.children?.length || 0,
      '指令', tree[0]?.children?.[1]?.children?.length || 0,
      '｜驾驶员', (menuLib.menuStatus(runtimeSettings || {}, bridgeHealth).kind))
  }

  // 省电期间左键单击 / 右键短按 = 退出（interact.js 判定后发上来）
  ipcMain.on('pet:low-exit', () => {
    if (lowInterrupt) setLowInterrupt(false, 'click')
  })

  ipcMain.on('ui:menu', () => {
    if (!win) return
    // 省电时右键不弹菜单（省电口径：交互只剩「单击退出菜单/省电」）
    if (lowInterrupt) return
    openBubbleMenu()
    return
    const template = [
      {
        label: '表情',
        submenu: [
          {
            label: '回到当前状态',
            click: () => {
              try {
                win.webContents.send('pet:state', lastStatus ? JSON.parse(lastStatus) : null)
              } catch { /* 状态文件坏了就按 idle */ win.webContents.send('pet:state', null) }
            },
          },
          {
            label: '清除全部表情',
            click: () => sendAction({ kind: 'expression', name: null }),
          },
          { type: 'separator' },
          // 勾选 = 激活。可以多选：参数不冲突的会叠加（加载 + 尾巴开关），
          // 冲突的自动替换（眼部组都占 key3~key6）。
          ...Object.keys(expressions).map((name) => ({
            label: name,
            type: 'checkbox',
            checked: activeExprNames.includes(name),
            click: () => sendAction({ kind: 'expr-toggle', name }),
          })),
        ],
      },
      {
        label: '姿势',
        submenu: poseNames.map((name) => ({
          label: POSE_LABEL[name] || name,
          click: () => sendAction({ kind: 'pose', name }),
        })),
      },
      { type: 'separator' },
      { label: '打开设置文件', click: () => shell.openPath(CONFIG_PATH) },
    ]
    if (DRIVER.enabled) {
      template.push({ label: '打开状态文件', click: () => shell.openPath(STATE_PATH) })
    }
    // 排查入口：自然事件/表情这些「看着没反应」的问题，答案基本都在 run.log 里
    template.push({
      label: '打开运行日志',
      click: () => {
        const p = LOG_FILE || join(app.getPath('userData'), 'run.log')
        if (!existsSync(p)) writeFileSync(p, '', 'utf8')
        shell.openPath(p)
      },
    })
    template.push(
      { type: 'separator' },
      {
        label: '鼠标穿透（Ctrl+Alt+L）',
        type: 'checkbox',
        checked: !!ignoring,
        click: (item) => {
          ignoring = item.checked
          autoIgnoreAt = Date.now() + 3000
          win.setIgnoreMouseEvents(ignoring, { forward: true })
        },
      },
      { type: 'separator' },
      { label: '退出（Ctrl+Alt+Q）', click: () => app.quit() },
    )

    Menu.buildFromTemplate(template).popup({ window: win })
  })

  // ---------- 窗口 ----------
  // config 里的 width/height 是逻辑尺寸，这里乘真实 DPI 换成物理像素。
  // 配合 --force-device-scale-factor=1，得到「物理像素 1:1」——
  // 既不会因为非整数缩放把窗口撑大，画质也是原生分辨率。
  UI_SCALE = resolveDpiScale(winCfg.dpiScale)
  const cfgW = Number(winCfg.width) || 520
  const cfgH = Number(winCfg.height) || 780
  BASE_W = Math.round(cfgW * UI_SCALE)
  BASE_H = Math.round(cfgH * UI_SCALE)

  // ---------- 恢复上次的几何 ----------
  const saved = readGeometry()
  let startX = winCfg.x == null ? undefined : Number(winCfg.x)
  let startY = winCfg.y == null ? undefined : Number(winCfg.y)
  let restored = false

  if (saved) {
    // 尺寸：只有「配置没变过」才沿用。改过 config 就该按新的来，
    // 否则会出现「明明改了 width，启动还是老大小」这种没法解释的行为。
    const sameCfg = Number(saved.configW) === cfgW
      && Number(saved.configH) === cfgH
      && Number(saved.dpiScale) === UI_SCALE
    const w = Number(saved.width)
    const h = Number(saved.height)
    if (sameCfg && w >= 100 && h >= 100) {
      BASE_W = Math.round(w)
      BASE_H = Math.round(h)
    }

    // 位置：config 显式指定了就以 config 为准；否则用上次停的地方（夹回工作区）
    const sx = Number(saved.x)
    const sy = Number(saved.y)
    if (startX == null && startY == null && Number.isFinite(sx) && Number.isFinite(sy)) {
      const c = clampGeometry(sx, sy, BASE_W, BASE_H)
      if (c.clamped) log('[window] 上次位置超出工作区，已夹回', `${Math.round(sx)},${Math.round(sy)} → ${c.x},${c.y}`)
      startX = c.x
      startY = c.y
      restored = true
    }
  }

  if (restored) log('[window] 恢复上次几何', startX + ',' + startY, BASE_W + 'x' + BASE_H)
  baseRatio = BASE_H / Math.max(1, BASE_W)
  log('[window] DPI 比例', UI_SCALE, '窗口物理尺寸', BASE_W + 'x' + BASE_H)
  win = new BrowserWindow({
    width: BASE_W,
    height: BASE_H,
    x: startX,
    y: startY,
    transparent: true,
    frame: false,
    // 不可缩放：尺寸由 config.window 决定，改大小请改配置。
    resizable: false,
    movable: true,
    hasShadow: false,
    // Windows 11 默认给窗口加圆角，透明无边框窗口会被反复调整边框，
    // 在非整数缩放下表现为「每次移动都撑大」。关掉。
    roundedCorners: false,
    skipTaskbar: winCfg.skipTaskbar !== false,
    alwaysOnTop: winCfg.alwaysOnTop !== false,
    backgroundColor: '#00000000',
    opacity: Number(winCfg.opacity) || 1,
    webPreferences: {
      preload: join(paths.UI_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  if (winCfg.alwaysOnTop !== false) win.setAlwaysOnTop(true, 'screen-saver')
  if (winCfg.clickThrough === true) win.setIgnoreMouseEvents(true, { forward: true })

  // ---------- 托盘（0.5.1） ----------
  // 无控制台启动之后，托盘就是「跟桌宠有关的唯一常驻入口」：
  // 窗口被隐藏了、菜单点不到时，只能从这里找回来。
  const trayIconPath = join(paths.UI_DIR, 'assets', 'tray.png')
  function rebuildTrayMenu() {
    if (!tray) return
    const visible = !!(win && !win.isDestroyed() && win.isVisible())
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: visible ? '隐藏桌宠' : '显示桌宠',
        click: () => {
          if (!win || win.isDestroyed()) return
          if (win.isVisible()) { win.hide(); log('[tray] 隐藏桌宠') } else { win.show(); win.focus(); log('[tray] 显示桌宠') }
          rebuildTrayMenu()
        },
      },
      {
        label: '省电模式',
        type: 'checkbox',
        checked: lowInterrupt,
        click: (item) => setLowInterrupt(!!item.checked, 'tray'),
      },
      { type: 'separator' },
      { label: '打开设置', click: () => { try { openSettings() } catch (e) { log('[tray] 打开设置失败 ' + e.message) } } },
      { label: '使用教程', click: () => { try { openTutorial() } catch (e) { log('[tray] 打开教程失败 ' + e.message) } } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]))
  }

  /**
   * 省电模式（原「低打扰」，0.5.7 改名）：状态机在 low-power/lowinterrupt.mjs，这里只负责把状态变成效果。
   *
   * 效果四件事：透明度 50%（setOpacity 实测线性）、帧率降到 12、行为状态机停摆、
   * 气泡与驾驶员事件抑制。退出时全部按进入前保存的值恢复。
   */
  const lowMachine = lowLib.createLowInterrupt({
    log,
    snapshot: () => ({
      opacity: Number(winCfg.opacity) || 1,
      fpsCap: targetFps(),
    }),
    apply: (on, saved, src) => {
      lowInterrupt = on
      try {
        if (win && !win.isDestroyed()) win.setOpacity(on ? 0.5 : (Number(saved.opacity) || 1))
      } catch (e) { log('[low] 设置透明度失败：' + (e && e.message)) }
      // 帧率：渲染层 ticker.maxFPS（0 = 不限）
      try {
        win?.webContents?.send('pet:action', {
          kind: 'perf', fpsCap: on ? LOW_FPS : targetFps(), at: Date.now(),
        })
        win?.webContents?.send('pet:action', { kind: 'low-interrupt', on, at: Date.now() })
      } catch { /* 渲染层没起来 */ }
      // 行为状态机：省电期间连 idle 小动作都停下（只保留引擎自带的呼吸/眨眼）
      try {
        if (on) behavior?.stop()
        else behavior?.start()
      } catch (e) { log('[low] 行为状态机切换失败：' + (e && e.message)) }
      rebuildTrayMenu()
      log('[low] 效果已' + (on ? '应用' : '撤销') + '（来源 ' + src + '）')
    },
  })

  /** 托盘 / 菜单 / 左键点击 都汇到这里（enter/exit 都是幂等的） */
  function setLowInterrupt(on, source = 'menu') {
    if (on) lowMachine.enter(source)
    else lowMachine.exit(source)
    rebuildTrayMenu()
  }

  /* ---------- 自动省电：全屏观察器（0.5.4） ----------
   * 常驻一个隐藏的 PowerShell，每 2s 一行 JSON。判定逻辑全在 observer.ps1 里，
   * 这里只负责「要不要拉起它、收到 full=true 就 tick 一下」。
   * config.behavior.autoLowInterrupt 关掉时立刻杀掉子进程（不常驻无用进程）。
   */
  let observerProc = null
  function stopObserver() {
    if (!observerProc) return
    try { observerProc.kill() } catch { /* 已经退了 */ }
    observerProc = null
    log('[low] 全屏观察器已停止')
  }
  function startObserver() {
    if (observerProc) return
    try {
      const { spawn } = require('node:child_process')
      const readline = require('node:readline')
      observerProc = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(paths.LOW_POWER_DIR, 'observer.ps1')],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const rl = readline.createInterface({ input: observerProc.stdout, crlfDelay: Infinity })
      rl.on('line', (line) => {
        const t = String(line || '').trim()
        if (!t.startsWith('{')) return
        let s = null
        try { s = JSON.parse(t) } catch { return }
        // 自己的窗口不算全屏（托盘菜单/设置页盖满屏时会误判）
        const full = s.full === true && Number(s.pid) !== process.pid
        lowMachine.tick(full, !!runtimeSettings?.autoLowInterrupt)
      })
      observerProc.on('exit', () => { observerProc = null })
      log('[low] 全屏观察器已启动')
    } catch (e) {
      log('[low] 观察器启动失败：' + (e && e.message))
    }
  }
  function syncAutoMode() {
    const on = !!runtimeSettings?.autoLowInterrupt
    if (on) startObserver()
    else { stopObserver(); lowMachine.tick(false, false) }
  }

  try {
    const icon = nativeImage.createFromPath(trayIconPath)
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    tray.setToolTip('桌宠')
    tray.on('click', () => setLowInterrupt(!lowInterrupt, 'tray'))
    rebuildTrayMenu()
    log('[tray] 已创建', trayIconPath)
    syncAutoMode()    // 设置里开着「全屏自动省电」就顺手把观察器拉起来
  } catch (e) {
    log('[tray] 创建失败：' + (e && e.message))
  }

  // ---------- 几何持久化 ----------
  // 写盘时机：move / resize 都高频触发，防抖到「停下来 700ms」写一次。
  // 监听 win 事件而不是只靠渲染层的 win:move IPC —— 这样系统级移动
  // （Alt+Space 菜单、任务栏的"移动"、多显示器快捷键）也能被记录。
  const persistGeometry = () => {
    if (!win || win.isDestroyed()) return
    try {
      const b = win.getBounds()
      const payload = {
        x: b.x, y: b.y, width: b.width, height: b.height,
        // 记下当时的配置值与缩放：配置被人改过时就不沿用这份尺寸
        configW: cfgW, configH: cfgH, dpiScale: UI_SCALE,
        savedAt: new Date().toISOString(),
      }
      mkdirSync(dirname(geoPath()), { recursive: true })
      writeFileSync(geoPath(), JSON.stringify(payload, null, 2), 'utf8')
    } catch (e) {
      log('[window] 几何保存失败：' + (e && e.message))
    }
  }
  let geoTimer = 0
  const scheduleGeo = () => {
    clearTimeout(geoTimer)
    geoTimer = setTimeout(persistGeometry, 700)
  }
  flushGeometry = () => { clearTimeout(geoTimer); persistGeometry() }
  let moveLogs = 0
  win.on('move', () => {
    // 只在 --debug-move 下记明细：用来分辨「系统瞬时纠正」和「有代码在持续移动」。
    // 平时不打，否则拖一下刷几十行。
    if (dbgMove && moveLogs < 20) {
      moveLogs += 1
      const b = win.getBounds()
      log('[window] move →', b.x + ',' + b.y, '#' + moveLogs,
        'cursor=' + JSON.stringify(screen.getCursorScreenPoint()))
    }
    // 拖动中不写盘：等松手（pet:dragging=false）时一次性落盘。
    // 只有「没有 pointerup 的移动」才走这里兜底 —— 系统级移动（Alt+Space 菜单、
    // 任务栏的"移动"、多显示器快捷键）不会触发渲染层的拖动流程。
    if (!dragging) scheduleGeo()
  })

  // 把渲染层控制台转发到主日志：渲染层抛的异常以前是静默的，
  // 「参数写了没反应」这类问题必须看得到 console.error 才查得动。
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) log('[renderer:err]', message, source ? `(${source}:${line})` : '')
    else if (process.argv.includes('--verbose')) log('[renderer]', message)
  })

  await win.loadURL(`${server.url}/ui/index.html`)
  win.show()

  // 隐藏（托盘 → 隐藏桌宠）时把渲染循环整个停掉：看不见的画面不该烧 GPU。
  // 之前只靠 Chromium 的遮挡节流，透明置顶窗口基本不会被判成遮挡。
  win.on('hide', () => sendAction({ kind: 'perf', paused: true, at: Date.now() }))
  win.on('show', () => sendAction({ kind: 'perf', paused: false, at: Date.now() }))
  // 首次启动也要落盘一次：用户可能一直不拖窗口，那样就永远没有 move 事件，
  // 位置文件会一直是空的 —— 「上次停在哪」也就无从谈起。
  scheduleGeo()
  log('[window] shown', win.getSize().join('x'), 'base', BASE_W + 'x' + BASE_H)

  // ---------- 行为状态机（自发动作的时间线） ----------
  // 初始待机 = 追踪关；只有盯盯段内才开追踪。发的事件带 prio=1，
  // 驾驶员/用户（0 档）在演时渲染层会直接丢弃 —— 「规划可被覆盖」就是靠它。
  const { createBehavior } = await import('../behavior/behavior.mjs')
  behavior = createBehavior({
    config: config.raw.behavior || {},
    // 人设行为卡里的默认行为规划（idleActions 有就用它，没有再退回 config.behavior.smallMotions）
    persona: persona?.behavior || null,
    log: (...a) => log('[behavior]', ...a),
    send: (evt) => { if (win && !win.isDestroyed()) win.webContents.send('pet:action', { ...evt, at: Date.now() }) },
    sendDriver: (payload) => gateAndPush({ ...payload, state: stageStateSnapshot() }),
    getCursorIdleMs: () => Date.now() - lastCursorMoveAt,
    getSettings: () => runtimeSettings || {},
  })
  behavior.start()

  // 首次启动自动打开教程（4s 后，等窗口稳定）。
  // --tutorial 强制重播；--no-tutorial 静默（自动化验收/截图时用）。
  try {
    const tut = readTutorialState()
    const force = process.argv.includes('--tutorial')
    const mute = process.argv.includes('--no-tutorial')
    if (!mute && (force || !tut.seen)) {
      setTimeout(() => { try { openTutorial() } catch (e) { log('[tutorial] 自动打开失败 ' + e.message) } }, 4200)
      log('[tutorial] 首次启动，4s 后自动打开教程')
    }
  } catch (e) { log('[tutorial] 初始化失败 ' + e.message) }


  // outbox 回收器：插件 3s 轮询，正常几秒内 ACK；90s 还没被取走的事件
  // 视为插件离线，丢弃并冒「断连」气泡（带冷却，不刷屏）
  const reaper = setInterval(reapDriverEvents, 5000)
  if (reaper.unref) reaper.unref()

  // 调试：--debug-menu 启动后自动弹一次菜单，方便截图核对动画/视觉
  if (process.argv.includes('--debug-menu')) {
    setTimeout(() => { try { openBubbleMenu() } catch (e) { log('[menu] 调试弹出失败 ' + e.message) } }, 2200)
  }

  // 调试：--debug-settings 启动后自动打开设置页；--settings-open 只打开不跑自截图
  // 流程（外部脚本要自己控制截图时机/内容时用这个）。
  if (process.argv.includes('--debug-settings') || process.argv.includes('--settings-open')) {
    setTimeout(() => { try { openSettings() } catch (e) { log('[settings] 调试打开失败 ' + e.message) } }, 2200)
  }

  // 调试：--selftest-resize 验证「等比缩放」链路真的能改窗口尺寸。
  // 这里直接调 applyResize，绕过指针事件 —— 目的就是把「手势判定」和「窗口能不能改」
  // 两件事分开查：如果这里尺寸不变，就是窗口层的问题，跟 interact.js 无关。
  if (process.argv.includes('--selftest-resize')) {
    setTimeout(async () => {
      const b0 = win.getBounds()
      log('[rs] 起始', b0.width + 'x' + b0.height, 'resizable=' + win.isResizable(), 'ratio=' + baseRatio.toFixed(4))
      editMode = true
      for (const w of [600, 900, 1200, 700]) {
        applyResize(w)
        await new Promise((r) => setTimeout(r, 320))
        const b = win.getBounds()
        log('[rs] 请求宽', w, '→ 实际', b.width + 'x' + b.height, '@', b.x + ',' + b.y)
      }
      editMode = false
      log('[rs] 结束（未动 resizable）')
      setTimeout(() => app.quit(), 800)
    }, 2200)
  }
  // 多屏 / 高 DPI 下位置可能被系统改写，记一笔实际 bounds 和屏幕布局，
  // 否则「恢复了但没生效」会完全查不出原因。
  try {
    const b = win.getBounds()
    log('[window] 实际位置', b.x + ',' + b.y, b.width + 'x' + b.height,
      '屏幕', screen.getAllDisplays().map((d) => `${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height}`).join(' | '))
  } catch { /* 拿不到就算了 */ }
  // 诊断用：窗口尺寸一旦变化就记一笔，方便定位「越拖越大」
  win.on('resize', () => {
    resizeCount += 1
    log('[window] resize →', win.getSize().join('x'), '#' + resizeCount)
    scheduleGeo()
  })

  // ---------- 状态轮询：零 token 的正向通道 ----------
  // 独立模式下整段不启动：桌宠不读任何外部文件，纯靠自身状态机待机。
  let endpointRetryLogged = false
  if (DRIVER.enabled) {
    setInterval(() => {
      try {
        if (!existsSync(STATE_PATH)) {
          if (lastStatus !== '') { lastStatus = ''; win?.webContents.send('pet:state', null) }
          return
        }
        // 状态文件出现了 = 驾驶员已上线。如果启动时目录还不存在（先开桌宠、
        // 后装插件的顺序），这里补写一次握手，免得用户还得重启桌宠。
        if (!server.endpoint.ok) {
          if (server.writeEndpoint()) {
            log('[driver] 检测到驾驶员上线，握手已补写', DRIVER.endpointFile)
          } else if (!endpointRetryLogged) {
            // 只记一次，别每 200ms 刷屏。失败原因必须留痕，否则无法排查
            endpointRetryLogged = true
            log('[driver] 握手补写失败：' + (server.endpoint.error || '目录不存在'))
          }
        }
        const txt = readFileSync(STATE_PATH, 'utf8')
        if (txt === lastStatus) return
        lastStatus = txt
        win?.webContents.send('pet:state', JSON.parse(txt))
      } catch { /* 半截文件 / 正在替换，下一轮再说 */ }
    }, 200)
  }

  // ---------- 全局光标：眼神跟全屏 + 顺带做穿透判定 ----------
  // 归一化：以窗口中心为原点，「半个屏幕」当半径，夹到 -1..1。
  //
  // 穿透为什么放在主进程算：渲染层自己判断会遇到死锁 —— 一旦把窗口设成穿透，
  // 渲染层收不到事件就再也判断不回来了（拖动一次后彻底失联就是这么来的）。
  // 主进程有 screen.getCursorScreenPoint()，不依赖窗口事件，天然没有这个问题。
  let lastCursor = null
  let lastCursorMoveAt = Date.now()   // 行为状态机判「鼠标静止多久」用
  setInterval(() => {
    if (!win || win.isDestroyed()) return
    try {
      const p = screen.getCursorScreenPoint()
      if (!lastCursor || p.x !== lastCursor.x || p.y !== lastCursor.y) {
        lastCursor = { x: p.x, y: p.y }
        lastCursorMoveAt = Date.now()
      }
      const b = win.getBounds()
      const disp = screen.getDisplayNearestPoint(p)
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      const rx = Math.max(1, disp.bounds.width / 2)
      const ry = Math.max(1, disp.bounds.height / 2)
      const gx = Math.max(-1, Math.min(1, (p.x - cx) / rx))
      const gy = Math.max(-1, Math.min(1, (p.y - cy) / ry))
      win.webContents.send('pet:gaze', { x: gx, y: gy })

      // 穿透判定
      let over = true
      if (alphaMask) {
        const relX = (p.x - b.x) / b.width
        const relY = (p.y - b.y) / b.height
        if (relX < 0 || relX > 1 || relY < 0 || relY > 1) over = false
        else {
          over = maskSolid(
            alphaMask,
            Math.min(alphaMask.w - 1, Math.floor(relX * alphaMask.w)),
            Math.min(alphaMask.h - 1, Math.floor(relY * alphaMask.h)),
          )
        }
      }
      const want = (dragging || editMode) ? false : !over
      if (Date.now() >= autoIgnoreAt && want !== ignoring) {
        ignoring = want
        win.setIgnoreMouseEvents(want, { forward: true })
      }
    } catch { /* 显示器热插拔之类的瞬态，忽略 */ }
  }, 50)

  // ---------- 热键 ----------
  globalShortcut.register('Control+Alt+L', () => {
    if (!win) return
    ignoring = !ignoring
    autoIgnoreAt = Date.now() + 3000
    win.setIgnoreMouseEvents(ignoring, { forward: true })
    log('[hotkey] 穿透', ignoring)
  })
  globalShortcut.register('Control+Alt+Q', () => app.quit())

  // ---------- 自测：窗口自己截图 ----------
  // 用 capturePage 而不是抓屏：透明窗口 + 置顶 + 用户可能在拖动，
  // 抓屏经常截到被遮挡的桌面，而 capturePage 拿到的就是窗口内容本身。
  // 结果落在 runtime/logs/shot.png（背景透明）。
  if (process.argv.includes('--selftest-shot')) {
    const arg = (k) => (process.argv.find((a) => a.startsWith(k)) || '').split('=')[1]
    const delay = Number(arg('--shot-delay=')) || 4000
    const count = Number(arg('--shot-count=')) || 1
    const gap = Number(arg('--shot-gap=')) || 400
    for (let i = 0; i < count; i += 1) {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage()
          const out = join(paths.RUNTIME_LOGS, count > 1 ? `shot-${i}.png` : 'shot.png')
          writeFileSync(out, img.toPNG())
          const sz = img.getSize()
          log('[shot] 已保存', out, sz.width + 'x' + sz.height)
        } catch (e) {
          log('[shot] 失败：' + ((e && e.message) || e))
        }
      }, delay + i * gap)
    }
  }

  // ---------- 自测：模拟连续拖动 ----------
  // 验证两件事：
  //   1. 尺寸不会膨胀（透明窗口 + 非整数缩放的老坑）
  //   2. 几何只在「松手」时落盘，拖动过程中不写
  if (process.argv.includes('--selftest-drag')) {
    setTimeout(() => {
      const b = win.getBounds()
      log('[selftest] 起始尺寸', b.width + 'x' + b.height)

      // 模拟按住：这段时间里 window.json 必须保持不变
      const before = readGeometry()
      dragging = true
      for (let i = 1; i <= 80; i += 1) moveTo(b.x + (i % 20), b.y + (i % 20))
      const during = readGeometry()
      log('[selftest] 拖动中未落盘 →',
        JSON.stringify(before) === JSON.stringify(during) ? '是（对）' : '变了（错）')

      // 模拟松手：立即落盘，且内容应等于当前窗口位置
      dragging = false
      flushGeometry()
      const after = readGeometry()
      const now = win.getBounds()
      log('[selftest] 松手后落盘 →', after.x + ',' + after.y,
        '与当前窗口一致', after.x === now.x && after.y === now.y ? '是（对）' : '不一致（错）')

      const e = win.getBounds()
      log('[selftest] 结束尺寸', e.width + 'x' + e.height, '基准', BASE_W + 'x' + BASE_H)
      log('[selftest] resize 累计次数', resizeCount)
    }, 3500)
  }
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', async () => {
  // 先把几何落盘：防抖可能还压着一次没写，用户拖完立刻关就会丢位置
  try { flushGeometry() } catch { /* 退都退了 */ }
  try { await server?.close() } catch { /* 退都退了 */ }
})
