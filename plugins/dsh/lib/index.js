// pet-bridge —— DSH 侧的桌宠桥接插件。
//
// 设计取向（与参考实现的差异，都是刻意的）：
//
// 1. 状态走「投影」，零 token。会话事件在 ctx.on('session/event') 里就地归约成
//    { state, expression, pose }，原子写进 ~/.dsh/live2d/status.json，由桌宠轮询。
//    这条路径不产生任何 LLM 消息，因此对上下文是 0 成本。
//
// 2. 只有「她真的要说话」才走模型。常驻开销压到最低：一个合并工具 + 一句短提示词。
//    对照：参考实现常驻 501 tok 系统提示词 + 3 个工具 ≈ 750 tok；
//    这里≈ 100 tok 提示词 + 1 个工具 ≈ 180 tok。
//
// 3. 快捷指令只在桌宠进程里执行，插件只转发 id。模型永远拿不到 shell——
//    它最多能点白名单里的菜单项。命令与参数写在桌宠的 shortcuts.json，模型无法创造。
//
// 4. 反向通道沿用参考做法：桌宠启动时把 { url, token } 写进 endpoint.json，
//    插件读它发 HTTP。DSH 自己的 Web 端口带鉴权，外部进程直连会 401，所以不能复用。
//
// 约束：零依赖（只用 node 内置 + @deepseek-ai/dsh-tools），只观察不改流程，异常全吞。

import {
  mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, statSync, appendFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'pet-bridge'

// 依赖声明（v0.4 修复 P0-1）。
//
// 这里**必须**把 sessions / agents 写进去：市场动态插件由宿主用沙箱 Proxy 门面包
// ctx，未声明的服务在「读属性那一刻」就 throw（?. 挡不住 —— ?. 只对 null/undefined
// 短路，而 Proxy 在返回值之前已经抛了）。0.3.0 只声明 tools/systemPrompt，于是
// ctx.sessions 一读就炸、被 catch 吞掉，绑定会话列表恒空、事件投递恒失败。
// 同时宿主没挂载某个 provider 时，声明会让插件被 cordis 挂起等待（而不是拿半个
// ctx 跑），所以代码里仍然用 ctx.get() 做可选查找，两条腿一起走（见 svc()）。
export const inject = ['tools', 'systemPrompt', 'sessions', 'agents']

const VERSION = '1.0.0'
const DIR = join(homedir(), '.dsh', 'live2d')
const STATUS = join(DIR, 'status.json')
const STATUS_TMP = join(DIR, 'status.json.tmp')
const ENDPOINT = join(DIR, 'endpoint.json')
const MAP_FILE = join(DIR, 'expression-map.json')

// 自定义预设放在**插件自己的目录**里，不放 ~/.dsh/live2d。
//
// 理由：~/.dsh/live2d 是「两个进程的握手区」，里面的东西谁都可能写，
// 卸载插件时也没人负责清。预设是插件的用户数据，跟插件同生共死才对 ——
// 删掉插件目录（安装时建的是指向仓库 bridge/ 的联接），预设一起没了，
// 不会在用户机器上留一堆没人认领的文件。
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_DIR = join(PLUGIN_DIR, 'data')
const PRESET_FILE = join(PRESET_DIR, 'presets.json')
const PRESET_MAX = 40
const PRESET_NAME_MAX = 24
// 轮询游标：记「转发到哪条事件了」。放插件目录 —— 和预设同生共死
const POLL_STATE = join(PRESET_DIR, 'poll-state.json')

const STAGE_TIMEOUT = 6000
const WRITE_DEBOUNCE = 120
const TERMINAL_KEEP_MS = 60 * 1000
const TASK_MAX = 48

// 白名单来源：和 status.json / endpoint.json 同一个握手目录，两端只看这一处。
// 仓库里的 pet/shortcuts.json 是源文件，安装时复制到这里（可用 PET_SHORTCUTS 覆盖）。
const SHORTCUTS_FILE = process.env.PET_SHORTCUTS || join(DIR, 'shortcuts.json')

/* ------------------------------------------------------------------ 状态 → 表情映射 */

// 用大肥鱼实际存在的 exp3 / Movement 参数名，见 README 的参数表：
//   表情：默认体型 / 前倾 / 兔牙 / 屑屑眼 / 圈圈眼 / 流冷汗 / 流泪 / 爱心眼 / 脸红 / ＞＜
//   姿势：default / grass(狗尾草 Movement1) / chest(抚胸 Movement2) / finger(竖食指 Movement3)
const DEFAULT_MAP = {
  thinking: { expression: '前倾', pose: 'default' },
  working: { expression: '兔牙', pose: 'default' },
  result: { expression: null, pose: 'default' },
  waiting: { expression: '＞＜', pose: 'chest' },
  success: { expression: '爱心眼', pose: 'default' },
  error: { expression: '流冷汗', pose: 'default' },
  idle: { expression: '默认体型', pose: 'default' },
}

/** 读用户的映射覆盖表；坏了就退回内置，绝不让配置错误中断事件流 */
function loadMap() {
  try {
    if (!existsSync(MAP_FILE)) return { ...DEFAULT_MAP }
    const user = JSON.parse(readFileSync(MAP_FILE, 'utf8'))
    const out = { ...DEFAULT_MAP }
    for (const k of Object.keys(DEFAULT_MAP)) {
      if (user[k] && typeof user[k] === 'object') {
        out[k] = {
          expression: user[k].expression ?? DEFAULT_MAP[k].expression,
          pose: user[k].pose ?? DEFAULT_MAP[k].pose,
        }
      }
    }
    return out
  } catch {
    return { ...DEFAULT_MAP }
  }
}

let EXPR_MAP = loadMap()

/* ------------------------------------------------------------------ 舞台通信 */

function log(msg) {
  try { console.log(`[pet-bridge] ${msg}`) } catch { /* 日志不允许影响主流程 */ }
}

// 上一次连接失败的真实原因。模型只能看到这一段文字，所以要写人话。
let lastStageError = ''

/* ------------------------------------------------------------------ 健康与错误留痕 */
//
// 0.3.0 的教训：绑定链路坏掉时异常被 catch 静默吞掉，只进了宿主 stdout，插件自己的
// 日志也不落盘 —— 于是「列表为空」和「调用失败」在外部完全没法区分，排查只能去读
// 宿主源码。v0.4 起所有被吞掉的错误都记在这张表里，两条出口：
//   ① 随 status.json 一起写出去（`bridge` 字段，排查时一个文件看全）；
//   ② 每轮轮询上报舞台 POST /api/bridge-health，由 GET /api/health 带出来。
const health = {
  sessions: { ok: false, count: 0, error: null, at: 0 },
  agents: { ok: false, error: null, at: 0 },
  lastError: null,          // { scope, message, at }
  delivered: 0,
  lastDeliveredAt: 0,
  confirmed: 0,             // 投递后真的跑完一轮的条数
  dropped: 0,               // 投出去了但没确认（回合报错/超时）被放弃的条数
}

/** 快照给外部看：不带时间戳，避免每 3 秒一次轮询把 status.json 反复重写 */
function healthSnapshot() {
  return {
    version: VERSION,
    sessions: { ok: health.sessions.ok, count: health.sessions.count, error: health.sessions.error },
    agents: { ok: health.agents.ok, error: health.agents.error },
    lastError: health.lastError
      ? { scope: health.lastError.scope, message: health.lastError.message, at: health.lastError.at }
      : null,
    delivered: health.delivered,
    confirmed: health.confirmed,
    dropped: health.dropped,
    inflight: inflight.size,
    lastDeliveredAt: health.lastDeliveredAt || null,
  }
}

/** 记一条被吞掉的错误（同 scope+message 10 秒内只记一次，轮询不会刷屏） */
function noteHealth(scope, e) {
  const message = String((e && (e.message || e)) || '未知错误').slice(0, 300)
  const at = Date.now()
  const prev = health.lastError
  if (prev && prev.scope === scope && prev.message === message && at - prev.at < 10000) return
  health.lastError = { scope, message, at }
  log(`[health] ${scope} 失败：${message}`)
  markHealth()
}

// 上次写进 status.json 的健康快照。健康变了就补一次写盘 —— 否则「链路从坏到好」
// 这件事在 status.json 里永远看不见（状态本身没变，不会触发 scheduleWrite）。
let lastHealthJson = ''
function markHealth() {
  try {
    const snap = JSON.stringify(healthSnapshot())
    if (snap === lastHealthJson) return
    lastHealthJson = snap
    scheduleWrite()
  } catch { /* 健康上报失败不影响主流程 */ }
}

/**
 * 取宿主服务。两条腿一起走：
 *   · ctx.get(name) —— 沙箱官方「可选查找」，宿主没挂载时返回 undefined，不抛；
 *   · ctx[name]     —— 已在 inject 声明时正常（老宿主没有 get 时的退路）。
 * 绝不要写 `ctx.xxx?.`：未声明服务的属性读取会直接 throw，?. 挡不住。
 */
function svc(ctx, name) {
  if (!ctx) return null
  // 宿主有 ctx.get 时只用它 —— 这是沙箱认可的「可选查找」，未声明的服务返回
  // undefined 而不抛。此时**不要**再去读 ctx[name]：未声明服务的属性读取会
  // throw，被 catch 记进 health 后，每轮轮询都会留下一条假错误，掩盖真正的故障。
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(name) || null
    } catch (e) {
      noteHealth(`${name}.get`, e)
      return null
    }
  }
  // 老宿主没有 ctx.get：只能靠属性访问（inject 已声明过的服务才拿得到）
  try {
    return ctx[name] || null
  } catch (e) {
    noteHealth(name, e)
    return null
  }
}


/**
 * 读握手文件，并确认桌宠进程还活着。
 *
 * 为什么查 pid：桌宠被强杀或崩溃时 endpoint.json 会留在磁盘上，里面的端口
 * 已经没人监听。不查的话，模型只会收到一句「fetch failed」，既不知道是
 * 「没开」还是「开过但死了」，也没有可执行的动作。查一下 pid 就能把这两种
 * 情况分开，并直接告诉模型该重启桌宠。
 */
async function stageEndpoint() {
  let ep = null
  try {
    ep = JSON.parse(await readFile(ENDPOINT, 'utf8'))
  } catch { /* 读不到 = 没开 */ }

  if (!ep?.url || !ep?.token) {
    lastStageError = `桌宠没开（读不到 ${ENDPOINT}）`
    return null
  }

  if (Number(ep.pid) > 0) {
    let alive = true
    try {
      process.kill(Number(ep.pid), 0)
    } catch (e) {
      // ESRCH = 进程不存在；EPERM = 存在但没权限发信号，按活着处理
      if (e && e.code === 'ESRCH') alive = false
    }
    if (!alive) {
      lastStageError = `桌宠进程已退出（pid ${ep.pid}），握手文件是旧的——重新启动桌宠即可`
      return null
    }
  }

  return ep
}

/** 调桌宠 HTTP API。失败折成 { ok:false, error }，不把异常扔给模型。 */
async function stageFetch(method, apiPath, body, timeoutMs) {
  const ep = await stageEndpoint()
  if (!ep) return { ok: false, error: lastStageError || '桌宠没开' }
  try {
    const res = await fetch(ep.url + apiPath, {
      method,
      headers: { 'x-stage-token': ep.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // say-lines 会阻塞到播完才应答，给调用方留加长超时的口子
      signal: AbortSignal.timeout(timeoutMs || STAGE_TIMEOUT),
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!res.ok) return { ok: false, status: res.status, error: data }
    return { ok: true, data }
  } catch (e) {
    // 端口能用但连不上：多半是桌宠刚好在重启，或者被别的进程占了这个端口
    return { ok: false, error: `连不上桌宠（${ep.url}）：${String(e?.message || e)}` }
  }
}

/* ------------------------------------------------------------------ 自定义预设 */

// 预设 = 一份「以后还会再用」的 steps。存的东西和 sequence 的入参完全一样，
// 播的时候原样转发给舞台，所以不存在「存的和播的不是同一套结构」这种漂移。

const PRESET_FALLBACK = join(DIR, 'presets.json')

// 运行时确定实际落在哪：插件目录优先，写不进去才退握手目录（见 writePresets）
let presetHome = PRESET_FILE

function loadPresets() {
  for (const p of [presetHome, PRESET_FILE, PRESET_FALLBACK]) {
    try {
      if (!existsSync(p)) continue
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (j && j.presets && typeof j.presets === 'object') {
        presetHome = p
        return j.presets
      }
    } catch (e) {
      log('读预设失败（' + p + '）：' + (e && e.message))
    }
  }
  return {}
}

/**
 * 原子替换：先写 .tmp 再 rename，读到一半的文件不存在。
 *
 * 写入位置按「插件目录 → 握手目录」依次试：插件目录是正解（卸载即清），
 * 但宿主如果有沙箱或权限限制，写不进去也不该让「存预设」这个能力直接消失 ——
 * 退到握手目录，并且把真实路径回给调用方，用户能看见东西在哪。
 *
 * @returns {string} 实际写入的路径
 */
function writePresets(presets) {
  const json = JSON.stringify({ v: 1, presets }, null, 2)
  let lastErr = null
  for (const p of [presetHome, PRESET_FILE, PRESET_FALLBACK]) {
    try {
      mkdirSync(dirname(p), { recursive: true })
      const tmp = p + '.tmp'
      writeFileSync(tmp, json, 'utf8')
      renameSync(tmp, p)
      presetHome = p
      return p
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('没有可写的位置')
}

function presetName(v) {
  return Array.from(String(v || '').trim()).join('')
}

/** 给模型看的一行清单：名字(几步) */
function presetHint(presets) {
  const names = Object.keys(presets)
  if (!names.length) return '还没有自定义预设。'
  return '已有预设：' + names.slice(0, 20)
    .map((n) => `${n}(${(presets[n].steps || []).length}步)`).join('、')
}

/**
 * 预设的四个操作。
 *
 * 存在的意义只有一个：把「模型已经编好的一套 steps」变成一个名字，
 * 下次不用重编。所以 save 收的就是 sequence 的 steps 原样，play 也是原样转发，
 * 中间不做任何结构转换 —— 存的和播的必然一致。
 */
async function runPreset(args) {
  const op = String(args?.op || '').trim()
  const presets = loadPresets()

  if (op === 'list') {
    return {
      ok: true,
      presets: Object.entries(presets).map(([n, p]) => ({
        name: n,
        desc: p.desc || '',
        steps: Array.isArray(p.steps) ? p.steps.length : 0,
        plays: Number(p.plays) || 0,
      })),
    }
  }

  if (op !== 'save' && op !== 'play' && op !== 'delete') {
    return { ok: false, error: `op 只支持 save / play / list / delete，收到：${op || '(空)'}` }
  }

  const name = presetName(args?.name)
  if (!name) return { ok: false, error: `preset ${op} 需要 name` }
  if (Array.from(name).length > PRESET_NAME_MAX) {
    return { ok: false, error: `预设名最多 ${PRESET_NAME_MAX} 个字，收到 ${Array.from(name).length} 个` }
  }

  if (op === 'save') {
    const steps = readSteps(args?.steps)
    if (!steps || !steps.length) {
      return { ok: false, error: 'save 需要 steps：把要记住的那套序列原样放进来（和 kind=sequence 的 steps 一样）' }
    }
    if (!presets[name] && Object.keys(presets).length >= PRESET_MAX) {
      return {
        ok: false,
        error: `预设最多 ${PRESET_MAX} 条，先 delete 一条`,
        available: Object.keys(presets),
      }
    }
    presets[name] = {
      desc: args?.desc ? Array.from(String(args.desc).trim()).slice(0, 60).join('') : '',
      steps,
      at: Date.now(),
      plays: Number(presets[name]?.plays) || 0,
    }
    let written = ''
    try { written = writePresets(presets) } catch (e) {
      return { ok: false, error: `预设写盘失败：${e && e.message}` }
    }
    scheduleRebuild()   // 预设清单进了工具描述，变了就要重建
    return { ok: true, saved: name, steps: steps.length, path: written }
  }

  const hit = presets[name]
  if (!hit || !Array.isArray(hit.steps) || !hit.steps.length) {
    return { ok: false, error: `没有这个预设：${name}`, available: Object.keys(presets) }
  }

  if (op === 'delete') {
    delete presets[name]
    try { writePresets(presets) } catch (e) {
      return { ok: false, error: `预设写盘失败：${e && e.message}` }
    }
    scheduleRebuild()
    return { ok: true, deleted: name, available: Object.keys(presets) }
  }

  // play
  hit.plays = (Number(hit.plays) || 0) + 1
  try { writePresets(presets) } catch (e) { log('记播放次数失败：' + (e && e.message)) }
  return stageFetch('POST', '/api/sequence', { steps: hit.steps })
}

/* ------------------------------------------------------------------ 驾驶员通道 */

// 舞台（桌宠进程）会产生两类「想对驾驶员说的话」：
//   interaction —— 用户交互上报（摸头/饭盆/牵手/换裙，带舞台状态）
//   observe     —— 盯盯观察（「用户正在使用XX窗口…」）
//   user-input  —— 用户在输入胶囊里手动打的话
// 这些事件由舞台写进 pet-events.json（路径在 endpoint.json 的 events 字段），
// 插件轮询转发到「绑定会话」。频率门控在舞台侧做完，这里照单转发。

// 绑定信息缓存（轮询 /api/driver-info 维护）
let boundInfo = { bind: null, title: '', proactive: false, freq: 'low' }
let pluginConfig = null   // mount 的第二个参数（宿主给的插件配置），debug 开关从这里读
// 最近一次上报的会话清单快照（去重推送 + 绑定标题显示用）
let reportedSessions = []
let reportedJson = ''
// 舞台的启动时间戳（/api/driver-info 的 since）。变了 = 舞台重启过，清单要重推。
let reportedStageSince = 0

/** 会话标题缓存：session/title 事件在 onSessionEvent 里持续回填（见 reduce 上方） */
const sessionTitles = new Map()

/* ------------------------------ 全量会话清单 + 标题 ------------------------------ */

// v0.4.1：绑定列表要「全部对话」，不是「此刻存活的对话」。
//
// ctx.sessions.list() 只给内存里活着的会话（通常 = 当前打开的这一个），所以旧版
// 列表永远只有一个，标题也只能退回 id（用户看到的「哈希值」）。真正的全集在
// ctx.sessionQuery（dsh-session-query）：listSessions() 把持久化日志里的每条会话
// 都列出来（带 live / persisted 标志），readTitleSnapshots() 折叠出真实标题。
//
// 代价是标题要读整份会话日志（本机 66 条，最大 4.6MB 压缩），所以：
//   · 标题落盘缓存（session-titles.json），重启不重读；
//   · 每轮只补 6 条、读完一条记一条，列表在几轮内逐步长全；
//   · 有 session/title 事件时以事件为准（不花 IO）。
const TITLE_FILE = join(PRESET_DIR, 'session-titles.json')
const TITLE_TTL_MS = 30 * 60 * 1000      // 有标题的缓存 30 分钟
const TITLE_MISS_TTL_MS = 3 * 60 * 1000  // 没标题的（还没生成）3 分钟后重试
const TITLE_BATCH = 6
const TITLE_MAX = 200                    // 缓存条数上限，防无限增长

/**
 * 把宿主给的标题值归一成显示字符串。
 *
 * readTitleSnapshots 的 `title` 不是字符串，而是冻结的标题快照
 * `{ title, messageSeqs, source, eventSeq, updatedAt }`（dsh-session-title 的
 * titleSnapshotFromState）—— 直接 String() 会得到 "[object Object]" 并被当成
 * 有效标题缓存 30 分钟（v0.4.1 的实际事故，设置页整列都是这串）。
 * session/title 事件带的才是裸字符串，所以两种形状都要吃。
 */
function titleText(raw) {
  const s = typeof raw === 'string' ? raw : typeof raw?.title === 'string' ? raw.title : ''
  const t = s.trim()
  return t.startsWith('[object ') ? '' : t   // 洗掉历史坏缓存，空值会走 3 分钟重读
}

/** id → { title, at }（at = 上次读取时间） */
let titleCache = new Map()
let titleLoaded = false
let titlesBusy = false
let titleSaveTimer = 0

function loadTitleCache() {
  if (titleLoaded) return
  titleLoaded = true
  try {
    const j = JSON.parse(readFileSync(TITLE_FILE, 'utf8'))
    const t = j && j.titles
    if (t && typeof t === 'object') {
      for (const [id, v] of Object.entries(t)) {
        if (!id || !v) continue
        titleCache.set(id, { title: titleText(v.title), at: Number(v.at) || 0 })
      }
    }
    log(`标题缓存已载入 ${titleCache.size} 条`)
  } catch { /* 第一次运行没有缓存文件，正常 */ }
}

function saveTitleCache() {
  if (titleSaveTimer) return
  titleSaveTimer = setTimeout(() => {
    titleSaveTimer = 0
    try {
      mkdirSync(PRESET_DIR, { recursive: true })
      // 只留最近 200 条，按读取时间倒序
      const entries = [...titleCache.entries()]
        .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
        .slice(0, TITLE_MAX)
      const titles = {}
      for (const [id, v] of entries) titles[id] = { title: v.title || '', at: v.at || 0 }
      const tmp = TITLE_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify({ v: 1, titles }), 'utf8')
      renameSync(tmp, TITLE_FILE)
    } catch (e) {
      log('标题缓存写盘失败：' + (e && e.message))
    }
  }, 1500)
  if (titleSaveTimer.unref) titleSaveTimer.unref()
}

/** 事件流里的标题最权威：见到就顺手写进缓存，省一次读日志；null = 标题被清除 */
function noteTitle(id, title) {
  if (!id) return
  loadTitleCache()
  const t = titleText(title)
  if (!t) {
    sessionTitles.delete(id)
    titleCache.delete(id)
    saveTitleCache()
    return
  }
  sessionTitles.set(id, t)
  titleCache.set(id, { title: t, at: Date.now() })
  saveTitleCache()
}

/** 标题显示：真标题 > 缓存 > 「未命名对话 · id前6」 */
function displayTitle(id) {
  const live = sessionTitles.get(id)
  const cached = titleCache.get(id)?.title
  const t = titleText(live || cached)
  if (t) return t.slice(0, 80)   // 显示层用 CSS 省略号截断，这里只防超长
  return `未命名对话 · ${String(id).slice(0, 6)}`
}

/**
 * 分批补读标题（不阻塞轮询）。
 * @param q sessionQuery 服务
 * @param ids 需要标题的会话 id（新→旧，已排好）
 * @param liveIds 当前存活的会话 id 集合（存活会话的标题变化更频繁，优先后读）
 */
function refreshTitles(q, ids, liveIds) {
  if (!q?.readTitleSnapshots || titlesBusy) return
  loadTitleCache()
  const now = Date.now()
  const need = []
  for (const id of ids) {
    const c = titleCache.get(id)
    const ttl = c && c.title ? TITLE_TTL_MS : TITLE_MISS_TTL_MS
    if (!c || now - c.at > ttl) need.push(id)
    if (need.length >= TITLE_BATCH) break
  }
  if (!need.length) return
  titlesBusy = true
  const startedAt = Date.now()
  q.readTitleSnapshots(need)
    .then((results) => {
      let filled = 0
      for (let i = 0; i < need.length; i += 1) {
        const id = need[i]
        const r = results?.[i]
        if (r?.status === 'fulfilled') {
          const t = titleText(r.value?.title)
          titleCache.set(id, { title: t, at: Date.now() })
          if (t) { sessionTitles.set(id, t); filled += 1 }
        } else {
          // 读失败（日志正在写/损坏）：2 分钟后再试，别每轮都撞同一个坏文件
          const prev = titleCache.get(id)
          titleCache.set(id, { title: prev?.title || '', at: Date.now() - TITLE_MISS_TTL_MS + 120000 })
          if (r?.reason) noteHealth('sessionQuery.title', r.reason)
        }
      }
      saveTitleCache()
      log(`标题补读 ${need.length} 条（${Date.now() - startedAt}ms）：新填 ${filled}`)
    })
    .catch((e) => noteHealth('sessionQuery.title', e))
    .finally(() => { titlesBusy = false })
}

/**
 * 扫描会话清单。
 *
 * 首选 ctx.sessionQuery（全部历史对话，含未打开的）；拿不到时退回
 * ctx.sessions.list()（只有存活会话）。返回项：
 *   { id, title, live, at }
 *   live = 有存活的 agent/会话，事件能立刻投递；未打开的会话要等它被打开。
 */
async function listSessions(ctx) {
  let out = []
  const q = svc(ctx, 'sessionQuery')
  if (q && typeof q.listSessions === 'function') {
    try {
      const records = await q.listSessions()
      if (Array.isArray(records)) {
        let child = 0
        for (const r of records) {
          const h = r?.header || {}
          const id = String(h.id || r?.id || '')
          if (!id) continue
          // 子会话（subagent / agent-team 派生）不出现在侧栏，也绑不了：
          // 它们没有独立的对话窗口，投递进去没人看。这里剔掉，列表就是
          // 「用户能在 DSH 里点开的那些对话」。全部被剔光时再退回全集（防御）。
          if (h.parentSession || h.origin === 'subagent') { child += 1; continue }
          out.push({
            id,
            title: displayTitle(id),
            live: r?.live === true,
            at: Number(h.createdAt) || 0,
          })
        }
        if (child) log(`会话清单：剔除 ${child} 个子会话（subagent）`)
        health.sessions = {
          ok: true,
          count: out.length,
          source: 'sessionQuery',
          live: out.filter((s) => s.live).length,
          child,
          error: null,
          at: Date.now(),
        }
      }
    } catch (e) {
      noteHealth('sessionQuery.list', e)
      health.sessions = { ok: false, count: 0, error: String(e?.message || e).slice(0, 300), at: Date.now() }
    }
  }

  if (!out.length) {
    const sessionsSvc = svc(ctx, 'sessions')
    if (!sessionsSvc) {
      health.sessions = {
        ok: false,
        count: 0,
        error: health.lastError?.message || '宿主没有 sessions / sessionQuery 服务（inject 未生效或 provider 未挂载）',
        at: Date.now(),
      }
      markHealth()
      return out
    }
    try {
      const list = sessionsSvc.list?.()
      if (Array.isArray(list)) {
        for (const s of list) {
          const id = String(s?.header?.id || s?.id || '')
          if (!id) continue
          out.push({ id, title: displayTitle(id), live: true, at: Number(s?.header?.createdAt) || 0 })
        }
      }
      health.sessions = { ok: true, count: out.length, source: 'sessions', error: null, at: Date.now() }
    } catch (e) {
      noteHealth('sessions.list', e)
      health.sessions = { ok: false, count: 0, error: String(e?.message || e).slice(0, 300), at: Date.now() }
    }
  }

  // 标题补读放后台：读日志比列清单慢得多，不能卡住 3s 一次的轮询。
  refreshTitles(q, out.map((s) => s.id), new Set(out.filter((s) => s.live).map((s) => s.id)))
  markHealth()
  return out
}

/** 当前存活会话 id 集合（清理滞留状态用；拿不到返回 null = 不做判断） */
function liveSessionIds(ctx) {
  const svcSessions = svc(ctx, 'sessions')
  try {
    const list = svcSessions?.list?.()
    if (!Array.isArray(list)) return null
    const set = new Set()
    for (const s of list) {
      const id = String(s?.header?.id || s?.id || '')
      if (id) set.add(id)
    }
    return set
  } catch {
    return null
  }
}

/**
 * 把一条文本送进指定会话 —— 真 API：@deepseek-ai/dsh-agent 的 Agent 句柄。
 *
 * agent 与会话共享同一个 id：ctx.agents.get(会话id) 直接拿到驱动它的 Agent。
 *   · agent 空闲 → followup()：排队一条普通「下一轮」提示词并唤醒驱动器；
 *   · agent 繁忙 → steer()：插话成「下一步」输入，当前回合的下一个步骤就带上
 *     （用户要求的「繁忙时以插话发送」，宿主原生语义，不用自己发明）。
 * 消息形状由宿主的落盘校验反推（别照 v3 文档写）：followup/steer 的参数会原样
 * 进 agent/inbox/spliced 的 inserted，然后被 encodeEvent 逐条 admission ——
 *   · source.kind 必须非空且**不能是 'plugin'**：{kind:'plugin', plugin:'x'} 是
 *     v3 的写法，v4 已退休（dsh-session-format-v3-to-v4/lib/index.js:126,150），
 *     一条不合规会让整批 append 抛错，把同一回合里用户自己那条一起拖下水。
 *   · role 必须有：适配器按 role 分派转 wire 形状，undefined 直接发不出去。
 *   · id 必须有：inbox 投影用它做「同一条消息不重复挂起」的去重键。
 * 归因放 source.kind：用户手打的标 'user'（和真实输入一模一样），桌宠自己报的
 * 事件标 'pet-bridge'（宿主各插件都用自己的名字做 kind，如 webhook/team-message；
 * UI 对不认识的 kind 退回通用图标，不会报错）。
 *
 * 返回 { ok, mode, error }：ok=false 时事件留在 outbox，舞台超时回收 + 断连气泡。
 */
function sendToSession(ctx, sid, text, fromUser = false) {
  const agentsSvc = svc(ctx, 'agents')
  if (!agentsSvc) {
    noteHealth('agents', new Error('宿主没有 agents 服务（inject 未生效或 provider 未挂载）'))
    health.agents = { ok: false, error: 'no-agents-service', at: Date.now() }
    return { ok: false, error: 'no-agents-service' }
  }
  let agent = null
  try { agent = agentsSvc.get?.(sid) || null } catch (e) { noteHealth('agents.get', e) }
  if (!agent) {
    health.agents = { ok: false, error: `会话 ${String(sid).slice(0, 12)}… 没有存活 agent`, at: Date.now() }
    log(`会话 ${sid} 没有存活的 agent（会话可能已归档或没打开）：${text.slice(0, 60)}`)
    return { ok: false, error: 'no-live-agent' }
  }
  const message = {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: fromUser ? 'user' : 'pet-bridge' },
  }
  try {
    const busy = agent.status === 'running'
    if (busy) agent.steer(message)
    else agent.followup(message)
    health.agents = { ok: true, error: null, at: Date.now() }
    return { ok: true, mode: busy ? 'steer' : 'followup' }
  } catch (e) {
    noteHealth('agents.send', e)
    health.agents = { ok: false, error: String(e?.message || e).slice(0, 300), at: Date.now() }
    log(`投递失败（${sid}）：${(e && e.message) || e}`)
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * 已投出去、但还没等到回合结局的事件：id → { sid, text, fromUser, tries, at }。
 * outbox 里的副本在投递成功时就 ACK 掉了（等确认会误触舞台 90s 的断连告警），
 * 所以重投用的是这里的文本。确认来源是绑定会话的 turn/end：completed 算送达；
 * 遇到 §6.1 那种一次性的 UNSUPPORTED_CONTENT 重投一次；其余结局或超时（120s）
 * 就放弃并记进 health —— 至少不再假装成功。
 */
const inflight = new Map()
let boundTurn = null            // { at, kind, message }
const INFLIGHT_RETRY_MAX = 1
const INFLIGHT_TIMEOUT_MS = 120000

/** 结束一条 in-flight：成功记 confirmed，其余记 dropped + lastError（ACK 早在投递成功时做过了） */
function settleInflight(id, why) {
  const it = inflight.get(id)
  inflight.delete(id)
  if (why === 'acked') {
    health.confirmed += 1
    return
  }
  health.dropped += 1
  const text = String((it && it.text) || '').slice(0, 60)
  noteHealth('turn.confirm', new Error(`${why}：${text}`))
  log(`投递未确认（${why}）：${text}`)
}

/**
 * 用绑定会话刚出现的回合结局确认所有 in-flight 事件。
 * 只在「这一轮确实是桌宠的话叫醒的回合」上做重投：重投条件收得很紧
 * （只认那条已知的一次性错误），否则无关回合的失败会造成重复消息。
 */
function confirmInflight(ctx, turn) {
  if (!inflight.size) return
  const known = /cannot represent|UNSUPPORTED_CONTENT/i.test(turn.message || '')
  for (const [id, it] of [...inflight]) {
    if (turn.kind === 'completed') { settleInflight(id, 'acked'); continue }
    if (known && it.tries < INFLIGHT_RETRY_MAX) {
      const r = sendToSession(ctx, it.sid, it.text, it.fromUser)
      it.tries += 1
      if (r.ok) { log(`回合报错（${(turn.message || '').slice(0, 46)}）→ 重投第 ${it.tries} 次：${it.text.slice(0, 40)}`); continue }
      settleInflight(id, 'retry-send-failed')
      continue
    }
    settleInflight(id, turn.kind === 'error' ? 'turn-error' : `turn-${turn.kind || 'unknown'}`)
  }
}

/** 事件 → 送进会话的最终文本：正文 + 舞台状态附注 */
function composeEventText(ev) {
  const st = ev.state && typeof ev.state === 'object' ? ev.state : null
  const exprs = Array.isArray(st?.expressions) ? st.expressions.filter(Boolean).join('+') : ''
  const parts = [String(ev.text || '').trim()]
  if (exprs || st?.pose) {
    parts.push(`（当前舞台：${exprs ? `表情 ${exprs}` : '无表情'}${st?.pose ? ` / 姿势 ${st.pose}` : ''}）`)
  }
  return parts.filter(Boolean).join(' ')
}

/** 读轮询游标（没读过/坏了从 0 开始，从头转发一轮 —— 最多 24 条，可接受） */
function readLastEventId() {
  try {
    const j = JSON.parse(readFileSync(POLL_STATE, 'utf8'))
    return Number(j?.lastId) || 0
  } catch {
    return 0
  }
}

function writeLastEventId(id) {
  try {
    mkdirSync(PRESET_DIR, { recursive: true })
    writeFileSync(POLL_STATE, JSON.stringify({ lastId: id, at: Date.now() }), 'utf8')
  } catch (e) {
    log('记轮询游标失败：' + (e && e.message))
  }
}

/**
 * 轮询一次舞台：上报会话清单 → 拉绑定信息 → 转发新事件。
 * 全程吞异常：这条链路任何一环挂了都不该影响工具调用和状态投影。
 */
async function pollDriver(ctx) {
  // ① 绑定 + 主动说话设置（插件要在工具层拒绝非绑定会话，必须知道绑定了谁）
  //    顺带拿到舞台的启动时间戳：舞台重启后它变了 —— 这时必须重推一次会话清单，
  //    否则「清单没变」会让守卫跳过推送，设置页在舞台重启后永远是空的。
  const info = await stageFetch('GET', '/api/driver-info')
  const stageSince = Number(info?.data?.since) || 0
  const stageRestarted = stageSince > 0 && stageSince !== reportedStageSince
  if (stageRestarted) {
    reportedStageSince = stageSince
    reportedJson = ''       // 强制下一段重推
    // 舞台启动时会清空 outbox，等确认的事件已经没有归属了，直接结清
    if (inflight.size) log(`舞台重启，放弃 ${inflight.size} 条等确认的投递`)
    inflight.clear()
    log('舞台已重启（since=' + stageSince + '），会话清单重推')
  }
  if (info?.ok && info.data && typeof info.data === 'object') {
    const bind = info.data.bind || null
    const title = bind ? (reportedSessions.find((s) => s.id === bind)?.title || bind) : ''
    boundInfo = {
      bind,
      title,
      proactive: !!info.data.proactive,
      freq: String(info.data.freq || 'low'),
    }
  }

  // ② 会话清单有变化才推。空清单不推（避免把舞台已有列表冲掉），
  //    但正因为如此，stageRestarted 那一支必须能绕过守卫。
  //
  //    变化判断要带上 title / live：标题是分批从日志里补读出来的，
  //    id 集合没变但标题刚补到时也必须重推，否则设置页永远停在「未命名对话」。
  const list = await listSessions(ctx)
  const listJson = JSON.stringify(list.map((s) => `${s.id}|${s.title}|${s.live ? 1 : 0}`))
  if ((listJson !== reportedJson || stageRestarted) && list.length) {
    reportedJson = listJson
    reportedSessions = list
    log(`会话清单上报 ${list.length} 条（存活 ${list.filter((s) => s.live).length}）：`
      + list.slice(0, 3).map((s) => s.title).join(' / '))
    await stageFetch('POST', '/api/sessions', { sessions: list })
  }

  // ②' 清理滞留状态：会话已经不在内存里（关掉了/归档了），它的 waiting 状态
  //     却还在 map 里 —— waiting 优先级最高，于是桌宠会一直顶着「＞＜」不放。
  //     只清「非存活 + 已经 2 分钟没更新」的条目，避免误伤刚落地的状态。
  pruneStaleStates(liveSessionIds(ctx))

  // ③ 健康上报：绑定链路一旦坏了，外部（/api/health）要能立刻看出「空」还是「错」
  await stageFetch('POST', '/api/bridge-health', {
    ...healthSnapshot(),
    bind: boundInfo.bind,
    boundTitle: boundInfo.title,
  })

  // ④ 转发新事件
  const ep = await stageEndpoint()
  if (!ep?.events) return
  let box = null
  try {
    box = JSON.parse(await readFile(ep.events, 'utf8'))
  } catch { /* 没有事件文件 = 没有新事件 */ }
  const events = Array.isArray(box?.events) ? box.events : []
  // 先结清上一轮投出去的（确认 / 重投 / 放弃），再投新事件 —— outbox 空了也要做，
  // 否则已投递的事件永远等不到 ACK。
  if (boundTurn) {
    const t = boundTurn
    boundTurn = null
    confirmInflight(ctx, t)
  }
  // 等不到回合结局的（会话被关掉、插件先重启了）到点结清，别一直挂着
  for (const [id, it] of [...inflight]) {
    if (Date.now() - it.at > INFLIGHT_TIMEOUT_MS) settleInflight(id, 'timed-out')
  }
  if (!events.length) return
  let cursor = readLastEventId()
  const fresh = events
    .filter((e) => Number(e?.id) > cursor)
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
  // 投递游标只有在「确实送进会话」时才前进。
  //
  // 0.3.0 的写法是循环第一步就 lastId = max(lastId, ev.id)，于是「没绑定会话」
  // 或「agent 不存活」的那一轮会把游标推过去，事件留在 outbox 里却再也不会被
  // 重试 —— 表现是「有事件、投递数恒 0」，只能等 90s 后舞台回收。
  // 现在：送成功才推进；没有绑定/投递失败就停在这一条，下一轮（3s 后）重试。
  // 唯一例外是「太老了」：舞台 90s 会回收，这里提前放弃并推进，避免卡住队列。
  //
  // 0.4.2：送成功 ≠ 送达。followup()/steer() 只是把消息塞进收件箱，回合里失败
  // （见 DSH-API.md §6.1：工具注册表基线变化撞上 in-history 系统更新）原本照样 ACK，
  // 那句话就永久丢了且无人知晓。现在投递后另记一份 inflight 等 turn/end 确认。
  // 注意 ACK **不等确认**：agent 一轮跑几分钟很常见，而舞台 90s 没收到 ACK 就会
  // 冒「好像断连了」的误报。文本已经在 inflight 里，重投不依赖 outbox 的副本。
  if (!fresh.length) return
  const delivered = []
  let sentNow = false
  for (const ev of fresh) {
    const id = Number(ev.id) || 0
    const text = composeEventText(ev)
    const tooOld = Date.now() - Number(ev.at || 0) > 85000
    if (!text || tooOld) {
      cursor = Math.max(cursor, id)
      if (tooOld) log(`事件已过期（舞台会回收）：${String(text).slice(0, 40)}`)
      continue
    }
    if (!boundInfo.bind) {
      log(`事件暂存（没有绑定会话，等舞台超时回收）：${text.slice(0, 60)}`)
      break
    }
    // user-input = 用户在桌宠输入胶囊里手打的话，按真实用户身份投递
    const r = sendToSession(ctx, boundInfo.bind, text, ev.kind === 'user-input')
    if (!r.ok) break          // 下一轮再试，不推进游标
    inflight.set(id, {
      sid: boundInfo.bind, text, fromUser: ev.kind === 'user-input', tries: 0, at: Date.now(),
    })
    delivered.push(id)
    cursor = Math.max(cursor, id)
    health.delivered += 1
    health.lastDeliveredAt = Date.now()
    sentNow = true
    log(`事件已投递（${r.mode}，等回合确认）：${text.slice(0, 60)}`)
  }
  writeLastEventId(cursor)
  // ACK = 「这条我不需要再看见它了」。投递成功就 ACK（不等回合 —— 见上面 0.4.2 那段），
  // 同时把「游标之前的陈旧事件」一并确认掉 —— 否则它们会一直躺在 outbox 里，
  // 90s 后被舞台的回收器判成「插件离线」并冒一句「好像断连了诶……」（实测踩过）。
  const ack = new Set(delivered)
  for (const ev of events) {
    const id = Number(ev.id) || 0
    if (id > 0 && id <= cursor) ack.add(id)
  }
  if (ack.size) {
    await stageFetch('POST', '/api/events-ack', { ids: [...ack] }).catch(() => {})
  }
  // 投递计数变了就补报一次健康（3s 一轮，累计值晚一轮也能接受；但刚投递完
  // 的那一轮最好立刻反映出来，否则排查时「delivered 一直是 0」会误导人）
  if (sentNow) {
    await stageFetch('POST', '/api/bridge-health', {
      ...healthSnapshot(),
      bind: boundInfo.bind,
      boundTitle: boundInfo.title,
    }).catch(() => {})
  }
}



/* ------------------------------------------------------------------ pet 的 schema 变体 */

const TRACKS_DESC = 'motion（或 sequence 里的 motion 步）现编动作用：{参数id: [[t, v], …]}，'
  + 't 是 0~1 归一化时间，v 是「增量」不是绝对值（起止都要回 0，否则结束时会卡住半路）。'
  + '只能写这些参数，其余会被物理接管或破坏形状：'
  + 'ParamAngleX 头向右、ParamAngleY 头向上、ParamAngleZ 歪头、'
  + 'ParamBodyAngleX 身体向右、ParamBodyAngleZ 身体歪、'
  + 'ParamEyeBallX/Y 眼珠、ParamMouthOpenY 张嘴、ParamMouthForm 嘴形、ParamBreath 呼吸。'
  + '手臂没有可写的参数：RArm/LArm/RForearm 等是 -1~1 的物理摆动修正量，写了几乎看不见；'
  + '竖食指、抚胸这类成套手势走 kind=pose（姿势自带完整手臂位）。'

const STEPS_DESC = 'kind=sequence 必填：每步 {op:"say|expression|pose|motion|wait", text/name/tracks/ms, after}。'
  + 'after 是「这步发出去后等多久」（缺省：motion 等它演完、say 2600、pose 420、expression 260、wait 600）。'
  + '上限 24 步 / 120 秒。'

/** steps 可能是数组，也可能（宿主只收字符串时）是 JSON 文本 */
function readSteps(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim()) {
    try {
      const j = JSON.parse(v)
      return Array.isArray(j) ? j : null
    } catch { return null }
  }
  return null
}

/** say 的多句序列，同 steps：数组或 JSON 文本 */
function readLines(v) {
  return readSteps(v)
}

/* -------------------------------------------------------------- 参数容错（kind 可省略） */

/**
 * 参数可能被宿主/模型包了一层：{args:{…}}、{arguments:"{…}"}、整串 JSON 文本。
 * 见 2026-11-04 检查报告：DSH 侧连报 4 次 missing required property kind。
 * 解包只做「明确是包裹」的情况，不猜业务字段（run_shortcut 自己的 args 是字符串，
 * 这里只服务 pet，不会误伤）。
 */
function unwrapArgs(raw) {
  let a = raw
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { return {} }
  }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return {}
  for (let i = 0; i < 3; i += 1) {
    const inner = a.arguments ?? a.args ?? a.input
    if (a.kind || typeof inner === 'string') break
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) break
    if (!('text' in inner) && !('name' in inner) && !('steps' in inner) && !('kind' in inner)) break
    a = inner
  }
  return a
}

/** 模型可能写的近义 kind（中英文都收，大小写不敏感） */
const KIND_ALIASES = {
  speak: 'say', talk: 'say', mouth: 'say', bubble: 'say', 说话: 'say', 说: 'say', 冒泡: 'say', 台词: 'say',
  expr: 'expression', face: 'expression', expression_change: 'expression', 表情: 'expression',
  posture: 'pose', gesture: 'pose', 姿势: 'pose', 手势: 'pose',
  action: 'motion', move: 'motion', animate: 'motion', 动作: 'motion', 动画: 'motion',
  seq: 'sequence', steps: 'sequence', script: 'sequence', 序列: 'sequence', 连演: 'sequence',
  presets: 'preset', 预设: 'preset',
  clear: 'reset', restore: 'reset', 归位: 'reset', 重置: 'reset', 复位: 'reset',
  halt: 'stop', cancel: 'stop', 停止: 'stop', 中断: 'stop',
}
const KINDS = ['say', 'expression', 'pose', 'motion', 'sequence', 'preset', 'reset', 'stop']

/**
 * 决定这次调用到底要干什么。
 *
 * 为什么要推断而不是硬要 kind：宿主侧（dsh-tools）在 execute 之前就按 schema 校验，
 * 缺 kind 会被直接判死（missing required property），插件连一句人话都来不及说。
 * 模型漏写 kind 是常事（尤其 PTC 里`await tools.pet({text:"…"})`），
 * 与其让整次调用报废，不如按照参数形状还原意图 —— 参数足够唯一确定时。
 */
function inferKind(a) {
  const raw = a?.kind
  if (raw !== undefined && raw !== null && String(raw).trim()) {
    const k0 = String(raw).trim()
    const lower = k0.toLowerCase()
    if (KINDS.includes(lower)) return { kind: lower, from: 'explicit' }
    if (KIND_ALIASES[lower]) return { kind: KIND_ALIASES[lower], from: 'alias' }
    if (KIND_ALIASES[k0]) return { kind: KIND_ALIASES[k0], from: 'alias' }
    return { kind: lower, from: 'unknown' }
  }
  if (readSteps(a?.steps)) return { kind: 'sequence', from: 'steps' }
  if (a?.op) return { kind: 'preset', from: 'op' }
  if (a?.text || readLines(a?.lines)) return { kind: 'say', from: 'text' }
  const name = a?.name ? String(a.name) : ''
  if (name) {
    if (names.poses.includes(name)) return { kind: 'pose', from: 'name→pose' }
    if (names.motions.includes(name)) return { kind: 'motion', from: 'name→motion' }
    if (names.expressions.includes(name)) return { kind: 'expression', from: 'name→expression' }
    return { kind: 'expression', from: 'name(未知，按表情)' }
  }
  if (a?.pose) return { kind: 'pose', from: 'pose' }
  if (a?.expression) return { kind: 'expression', from: 'expression' }
  if (a?.tracks) return { kind: 'motion', from: 'tracks' }
  return { kind: '', from: 'none' }
}

/**
 * 把「kind 不是模型显式给的」这类调用留一份现场：只在这时才写盘，
 * 正常调用零开销。下次再出「工具报错但插件没记录」，直接看
 * ~/.dsh/live2d/pet-calls.log 最后几行就知道参数长什么样。
 */
const CALL_LOG = join(DIR, 'pet-calls.log')
function noteCall(guessed, rawArgs) {
  if (guessed.from === 'explicit') return
  try {
    let keys = '?'
    try { keys = Object.keys(rawArgs && typeof rawArgs === 'object' ? rawArgs : {}).join(',') || '(空)' } catch { /* 忽略 */ }
    const line = `[${new Date().toISOString()}] kind=${guessed.kind || '(推断不出)'} 来源=${guessed.from} 顶层键=${keys} 原始=${JSON.stringify(rawArgs)?.slice(0, 400)}`
    log('[call] ' + line)
    mkdirSync(DIR, { recursive: true })
    try {
      if (statSync(CALL_LOG).size > 64 * 1024) renameSync(CALL_LOG, CALL_LOG + '.1')
    } catch { /* 文件还不存在 */ }
    appendFileSync(CALL_LOG, line + '\n', 'utf8')
  } catch { /* 写不了就算了，绝不影响表演 */ }
}

/**
 * 驾驶位校验：绑定会话之外调用工具要拒绝（行为状态机.txt 的约定）。
 *
 * 工具执行上下文带发起 agent：exec.agent.session.header.id 就是调用方会话
 * （宿主源码考证：dsh-tools 执行流水线把 agent 挂在 exec 上）。抠不到就放行
 * —— 拒绝需要确凿的证据，猜是会误伤。
 */
/**
 * 调试标签（v0.4）：除了绑定会话，带 debug 标签的输入也可以操纵舞台。
 * 三种加法，任意一个成立即视为 debug：
 *   ① 进程环境 PET_DEBUG=1（启动 DSH 前设，最省事）
 *   ② 插件配置 debug:true（profile/插件配置里写）
 *   ③ 调用方会话标题里带 [debug] 或 #debug（临时给某个会话开权限）
 * 注意：debug 只放宽「谁能操纵」，不绕过舞台的 token 校验。
 */
function isDebugCall(callCtx) {
  if (String(process.env.PET_DEBUG || '') === '1') return true
  if (pluginConfig && pluginConfig.debug === true) return true
  const title = String(
    callCtx?.agent?.session?.header?.title
    || callCtx?.agent?.session?.title
    || callCtx?.session?.header?.title
    || callCtx?.session?.title
    || '',
  )
  return /\[debug\]|#debug/i.test(title)
}

/**
 * 驾驶位校验：绑定会话之外调用工具要拒绝（行为状态机.txt 的约定）。
 * v0.4 起放开一条口子：带 debug 标签的输入同样接受（手动联调/脚本用）。
 *
 * 宿主不一定把调用方会话传给 execute —— callCtx 里抠得到就用，
 * 抠不到（undefined）按放行处理：拒绝需要确凿的证据，猜是会误伤。
 */
function driverGate(callCtx) {
  if (!boundInfo.bind) return null
  if (isDebugCall(callCtx)) return null
  const sid = String(
    callCtx?.agent?.session?.header?.id
    || callCtx?.agent?.session?.id
    || callCtx?.session?.header?.id
    || callCtx?.session?.id
    || callCtx?.sessionId
    || '',
  )
  if (!sid) return null
  if (sid === boundInfo.bind) return null
  return `舞台驾驶位已绑定到会话「${boundInfo.title || boundInfo.bind}」，本会话（${sid.slice(0, 12)}…）不能操纵桌宠。`
}

/**
 * 按宿主能力挑一套参数 schema。
 *
 * 为什么必须探测：`@deepseek-ai/dsh-tools` 不同版本对参数 schema 的校验宽严不一样 ——
 * 有的要求 object 显式写 `additionalProperties`，有的根本不认这个键；数组的 items 同理。
 * 插件在整条链路的最末端，不能因为「宿主版本差一点」就让工具注册失败，
 * 更不能把异常抛上去把 DSH 拖挂。所以从最严的一套开始试，被拒就退一级：
 *
 *   strict  tracks 带 additionalProperties + steps 用数组（最贴模型直觉）
 *   loose   tracks 不带该键 + steps 用数组（老版本宿主）
 *   string  tracks 不带 + steps 用 JSON 文本（任何版本都收，最保守）
 *
 * 三级都失败就只写一份诊断、不注册 —— run_shortcut 与状态投影照常工作。
 */
function tryPetVariants(build) {
  const tracksStrict = { type: 'object', additionalProperties: true, description: TRACKS_DESC }
  const tracksLoose = { type: 'object', description: TRACKS_DESC }
  const stepsArray = {
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: STEPS_DESC,
  }
  const stepsString = {
    type: 'string',
    description: STEPS_DESC + ' 当前宿主只接受字符串：请把整个数组写成 JSON 文本，'
      + '例如 \'[{"op":"motion","name":"伸懒腰"}]\'。',
  }
  // say 的多句序列：数组形（[{text, ms}] 或纯字符串都行） / 字符串形（JSON 文本）
  const LINES_DESC = 'say 可选：多句连播数组，每项 {"text":"…","ms":2600}（ms 缺省 2600）。'
    + '整组说完才返回（阻塞），最多 8 句。'
  const linesArray = { type: 'array', items: { type: 'object', additionalProperties: true }, description: LINES_DESC }
  const linesString = { type: 'string', description: LINES_DESC + ' 当前宿主只接受字符串：写成 JSON 文本。' }

  const variants = [
    ['strict', tracksStrict, stepsArray, linesArray],
    ['loose', tracksLoose, stepsArray, linesArray],
    ['string', tracksLoose, stepsString, linesString],
  ]

  const failures = []
  for (const [tag, tracks, steps, lines] of variants) {
    try {
      const tool = defineTool(build(tracks, steps, lines))
      if (!tool) throw new Error('defineTool 返回空')
      log(`pet 工具注册成功（schema 变体 ${tag}）`)
      return tool
    } catch (e) {
      failures.push(`${tag}: ${(e && e.message) || e}`)
    }
  }

  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(join(DIR, 'bridge-error.log'),
      'pet 工具注册失败，三个 schema 变体都被拒：\n' + failures.join('\n'), 'utf8')
  } catch { /* 日志也写不了就算了 */ }
  log('pet 工具注册失败：' + failures.join(' / '))
  return null
}

/* ------------------------------------------------------------------ 能力名单（由舞台注册） */

// 名单的真相在舞台：表情来自模型 Exp3 扫描，姿势/动作来自 config.json。
// 插件不维护第二份清单 —— 启动时从 GET /api/catalog 拉一次，之后每次调用
// 顺手刷新，名单变了就重建工具（description 里拼的就是这份名单）。
// 拉不到（桌宠没开）时用这份兜底，保证工具描述不至于空白。
const FALLBACK_NAMES = {
  expressions: ['默认体型', '前倾', '兔牙', '圈圈眼', '屑屑眼', '流冷汗', '流泪', '爱心眼', '脸红', '＞＜',
    '黑脸', '加载', '黑框眼镜', '单片眼镜', '大钢盆', '尾巴开关', '裙子切换', '胸口衣服', '脱鞋',
    '竖食指开', '竖食指关', '体型1', '体型2'],
  poses: ['default', 'grass', 'chest', 'finger'],
  motions: ['重心换脚', '东张西望', '伸懒腰', '打瞌睡', '抖尾巴'],
}

let names = FALLBACK_NAMES
let namesAt = 0
let rebuildPet = null   // mount 注入：名单或预设变化时重建工具注册

/** 拉取能力名单。返回 true = 名单有变化（调用方应重建工具）。 */
async function refreshCatalog(minIntervalMs = 30000) {
  if (Date.now() - namesAt < minIntervalMs) return false
  namesAt = Date.now()
  const r = await stageFetch('GET', '/api/catalog')
  const d = r?.data
  if (!r.ok || !d || typeof d !== 'object') return false
  const pick = (v, fallback) => (Array.isArray(v) && v.length ? v.map(String) : fallback)
  const next = {
    expressions: pick(d.expressions, FALLBACK_NAMES.expressions),
    poses: pick(d.poses, FALLBACK_NAMES.poses),
    motions: pick(d.motions, FALLBACK_NAMES.motions),
    animations: pick(d.animations, []),
  }
  if (JSON.stringify(next) === JSON.stringify(names)) return false
  names = next
  log(`能力名单更新：表情 ${next.expressions.length} / 姿势 ${next.poses.length} / 动作 ${next.motions.length}`
    + (next.animations.length ? ` / 手臂动画 ${next.animations.length}` : ''))
  return true
}

/** 名单或预设变化后重建工具。失败不影响旧注册（旧描述只是暂时过时）。 */
function scheduleRebuild() {
  if (typeof rebuildPet !== 'function') return
  try { rebuildPet() } catch (e) { log('重建 pet 工具失败：' + (e && e.message)) }
}

/* ------------------------------------------------------------------ 会话状态归约 */

const PRIORITY = { waiting: 60, error: 50, working: 40, thinking: 30, result: 25, success: 20 }
const QUESTION_TOOL = 'ask_user_question'
const GOAL_TOOL = 'update_goal'

/** sid → { state, seq, ts, task, tool, detail } */
const sessions = new Map()
/** sid → { goalRound, closing } */
const flags = new Map()
const terminalTimers = new Map()

let writeTimer = 0
let lastPayload = ''

function sidOf(session) {
  return String(session?.header?.id || session?.id || 'unknown')
}

function trimTask(text) {
  const points = Array.from(String(text || '').trim())
  if (!points.length) return null
  return points.length > TASK_MAX ? points.slice(0, TASK_MAX).join('') + '…' : points.join('')
}

/** 工具名 + 参数 → 一句细节（「写文件 · editor.js」里的后半截） */
function toolDetail(tool, rawArgs) {
  let a = {}
  try { a = JSON.parse(String(rawArgs || '{}')) || {} } catch { return null }
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''
  const clip = (s) => {
    const t = String(s || '').trim()
    return t ? Array.from(t).slice(0, 18).join('') : null
  }
  if (tool === 'write' || tool === 'edit' || tool === 'read') return clip(base(a.file_path || a.path))
  if (tool === 'ops_read_files') return clip(base(a.files?.[0]?.path))
  if (tool === 'grep' || tool === 'glob') return clip(a.pattern)
  if (tool === 'ops_bash' || tool === 'bash' || tool === 'pwsh') {
    return clip(a.description || String(a.command || '').split('\n')[0])
  }
  if (tool === 'web_search') return clip(Array.isArray(a.queries) ? a.queries[0] : a.query)
  if (tool === 'web_fetch') return clip(String(a.url || '').replace(/^https?:\/\//, ''))
  return null
}

function taskFromTodo(event) {
  const todos = Array.isArray(event?.data?.todos) ? event.data.todos : []
  let current = null
  for (const t of todos) if (t && t.status === 'in_progress') current = t
  if (!current) current = todos.find((t) => t && t.status === 'pending')
  return trimTask(current?.content)
}

function goalAction(event) {
  try {
    const o = JSON.parse(String(event?.data?.arguments || ''))
    if (o && (o.action === 'complete' || o.action === 'blocked')) return o.action
  } catch { /* 参数不是 JSON 就当作没有收尾动作 */ }
  return null
}

function turnEndState(kind) {
  if (kind === 'completed') return 'success'
  if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error'
  if (kind === 'blocked') return 'waiting'
  return null
}

/** 事件 → 状态档；不认识的返回 null */
function reduce(event, flag) {
  const type = event?.type
  const data = event?.data || {}
  switch (type) {
    case 'turn/start': return 'thinking'
    case 'tool/call':
      return String(data.name || data.toolName || '') === QUESTION_TOOL ? 'waiting' : 'working'
    case 'tool/result': return 'result'
    case 'approval/asked': return 'waiting'
    // 审批有结果 = 用户已经处理过了，必须立刻离开 waiting。
    // 旧版没有这一条：approval/asked 之后如果下一个事件不是 tool/call / turn/end
    // （比如审批后只是继续回话），状态会永远停在 waiting —— 桌宠就一直是「＞＜」。
    case 'approval/decided': return 'working'
    case 'turn/end': {
      const st = turnEndState(String(data?.reason?.kind || ''))
      if (st !== 'success') return st
      if (!flag?.goalRound) return 'success'
      if (flag.closing === 'blocked') return 'error'
      if (flag.closing === 'complete') return 'success'
      return 'result'
    }
    default: return null
  }
}

/** 多会话仲裁：优先级高的赢，同级取更新的 */
function best() {
  let pick = null
  for (const [sid, e] of sessions) {
    if (!pick || PRIORITY[e.state] > PRIORITY[pick.state]
      || (PRIORITY[e.state] === PRIORITY[pick.state] && e.ts > pick.ts)) {
      pick = e
      pick.sid = sid
    }
  }
  return pick
}

/** 防抖 + 去重 + 原子替换：桌宠永远不会读到写了一半的文件 */
function scheduleWrite() {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = 0
    try {
      const b = best()
      const state = b ? b.state : null
      const mapped = state ? (EXPR_MAP[state] || {}) : (EXPR_MAP.idle || {})
      const payload = {
        ok: true,
        v: 2,
        at: Date.now(),
        state,
        task: b ? b.task : null,
        tool: b ? b.tool : null,
        detail: b ? b.detail : null,
        expression: mapped?.expression ?? null,
        pose: mapped?.pose ?? 'default',
        session: b ? b.sid : null,
        version: VERSION,
        // 绑定链路的健康度（v0.4）：sessions/agents 是不是真的拿到了、最后一次错在哪。
        // 只给排查看，舞台与渲染层都忽略这个字段。
        bridge: healthSnapshot(),
      }
      const json = JSON.stringify(payload)
      if (json === lastPayload) return
      lastPayload = json
      mkdirSync(DIR, { recursive: true })
      writeFileSync(STATUS_TMP, json, 'utf8')
      renameSync(STATUS_TMP, STATUS)
    } catch (e) {
      log('写状态失败：' + (e && e.message))
    }
  }, WRITE_DEBOUNCE)
  if (writeTimer.unref) writeTimer.unref()
}

function setState(sid, state, seq, extra = {}) {
  const prev = sessions.get(sid)
  if (prev && prev.state === state && prev.seq >= seq) {
    const changed = (extra.tool ?? prev.tool) !== prev.tool
      || (extra.task ?? prev.task) !== prev.task
      || (extra.detail ?? prev.detail) !== prev.detail
    if (changed) {
      prev.tool = extra.tool ?? prev.tool
      prev.task = extra.task ?? prev.task
      prev.detail = extra.detail ?? prev.detail
      prev.ts = Date.now()
      scheduleWrite()
    }
    return
  }
  sessions.set(sid, {
    state,
    seq,
    ts: Date.now(),
    task: extra.task !== undefined ? extra.task : (prev ? prev.task : null),
    tool: extra.tool !== undefined ? extra.tool : (prev ? prev.tool : null),
    detail: extra.detail !== undefined ? extra.detail : (prev ? prev.detail : null),
  })
  // 状态迁移留痕：桌宠「表情不动 / 卡在某个表情」时，第一件事就是看这条日志
  // —— 是没收到事件（这里没有记录），还是状态没变（同一个 state 不重复打）。
  if (!prev || prev.state !== state) {
    const mapped = EXPR_MAP[state] || {}
    log(`[state] ${sid.slice(0, 8)} ${prev ? prev.state : '(空)'} → ${state}`
      + `（表情 ${mapped.expression || '无'} / 姿势 ${mapped.pose || '-'}）`)
  }
  scheduleWrite()
}

/**
 * 清理「会话已经不在内存里、状态却还挂着」的条目。
 *
 * 为什么必须有：waiting 在 PRIORITY 里最高（60），一个关掉的会话留下的 waiting
 * 会一直压过所有活着的会话 —— 桌宠就永远顶着 waiting 的表情（本机实测是「＞＜」）。
 * 只清「非存活 + 2 分钟没更新」的，给刚打开/刚切走的会话留出缓冲。
 */
function pruneStaleStates(liveIds) {
  if (!liveIds || !liveIds.size) return
  const now = Date.now()
  let changed = false
  for (const [sid, e] of [...sessions]) {
    if (liveIds.has(sid)) continue
    if (now - e.ts < 120000) continue
    sessions.delete(sid)
    flags.delete(sid)
    clearTerminalTimer(sid)
    changed = true
    log(`[state] 清理滞留状态 ${sid.slice(0, 8)} ${e.state}（会话已不在内存，`
      + `${Math.round((now - e.ts) / 1000)}s 未更新）`)
  }
  if (changed) scheduleWrite()
}

function clearTerminalTimer(sid) {
  const t = terminalTimers.get(sid)
  if (t) { clearTimeout(t); terminalTimers.delete(sid) }
}

function scheduleTerminalCleanup(sid) {
  if (terminalTimers.has(sid)) return
  const t = setTimeout(() => {
    terminalTimers.delete(sid)
    const e = sessions.get(sid)
    if (e && (e.state === 'success' || e.state === 'error')) {
      sessions.delete(sid)
      flags.delete(sid)
      scheduleWrite()
    }
  }, TERMINAL_KEEP_MS)
  if (t.unref) t.unref()
  terminalTimers.set(sid, t)
}

function onSessionEvent(session, event) {
  if (!event || !event.type) return
  const sid = sidOf(session)
  const type = event.type
  const seq = Number(event.seq || 0)

  // 绑定会话的回合结局 = 桌宠那句话的确认信号（followup/steer 成功只代表进了收件箱）
  if (type === 'turn/end' && sid && sid === boundInfo.bind) {
    const r = event?.data?.reason || {}
    boundTurn = {
      at: Date.now(),
      kind: String(r.kind || ''),
      message: String(r.error?.message || r.failure?.message || ''),
    }
  }

  // 会话标题：session/title 事件的 data.title 是最新标题（null = 清除）。
  // 这类事件最权威也最便宜（不用读日志），顺手写进标题缓存。
  if (type === 'session/title') {
    const t = event?.data?.title
    if (t) { noteTitle(sid, String(t)); log(`[session] 标题更新：${String(t).slice(0, 30)}`) } else sessionTitles.delete(sid)
    return
  }
  if (type === 'todo/write') {
    const cur = sessions.get(sid)
    if (cur) setState(sid, cur.state, seq, { task: taskFromTodo(event) })
    return
  }
  if (type === 'user/message') {
    if (event?.data?.source?.kind === 'goal') {
      const f = flags.get(sid) || { goalRound: false, closing: null }
      f.goalRound = true
      flags.set(sid, f)
    }
    return
  }
  if (type === 'turn/start') {
    flags.set(sid, { goalRound: false, closing: null })
    clearTerminalTimer(sid)
  }
  if (type === 'tool/call' && String(event?.data?.name || '') === GOAL_TOOL) {
    const action = goalAction(event)
    if (action) {
      const f = flags.get(sid) || { goalRound: false, closing: null }
      f.closing = action
      flags.set(sid, f)
    }
  }

  const next = reduce(event, flags.get(sid))
  if (!next) {
    if (type === 'turn/end') {
      flags.delete(sid)
      clearTerminalTimer(sid)
      if (sessions.delete(sid)) scheduleWrite()
    }
    return
  }

  const extra = {}
  if (type === 'tool/call') {
    const tool = String(event?.data?.name || event?.data?.toolName || '') || null
    extra.tool = tool
    extra.detail = toolDetail(tool, event?.data?.arguments)
  }
  if (type === 'tool/result') extra.tool = sessions.get(sid)?.tool ?? null
  if (type === 'turn/start') { extra.tool = null; extra.task = null; extra.detail = null }

  setState(sid, next, seq, extra)

  if (next === 'success' || next === 'error') scheduleTerminalCleanup(sid)
  else clearTerminalTimer(sid)
}

/* ------------------------------------------------------------------ 快捷指令白名单 */

/** 启动时读一次白名单；文件不存在就当空表（工具仍注册，但会告诉模型没有可执行的） */
function loadShortcuts() {
  try {
    if (!existsSync(SHORTCUTS_FILE)) return []
    const data = JSON.parse(readFileSync(SHORTCUTS_FILE, 'utf8'))
    const list = Array.isArray(data?.shortcuts) ? data.shortcuts : []
    return list.filter((s) => s && typeof s.id === 'string' && s.id.trim())
  } catch (e) {
    log('读快捷指令失败：' + (e && e.message))
    return []
  }
}

/** 工具描述里那一行可执行清单：id(说明)，只带 id 和 label，别把参数塞进来 */
function shortcutHint(list) {
  if (!list.length) return '当前没有注册任何快捷指令。'
  return '可执行：' + list.slice(0, 12).map((s) => `${s.id}(${s.label || s.id})`).join('、')
}

/* ------------------------------------------------------------------ 插件装配 */

function mount(ctx, config) {
  pluginConfig = config && typeof config === 'object' ? config : null
  log(`v${VERSION} 加载；状态文件 ${STATUS}`)

  // 短提示词：只说「什么时候用」，不说「有哪些能力」——能力由工具 schema 自己表达，
  // 重复一遍就是白花 token。行为时间线只提一句「她自己会安排」，细节在工具描述里。
  const PROMPT = '桌面有一个 Live2D 角色陪着你（会自己待机：眨眼呼吸、东张西望、抖尾巴、盯盯看鼠标，'
    + '这些由她的行为状态机安排，不用你操心）。需要她开口或表演时用三个工具：\n'
    + '· pet —— 说话。文字里可以内联 〔动作〕 标记让她边说边演（如「今天也请多关照〔歪头 眯眼笑〕」），'
    + '也能引用现成的演出：〔预设:害羞〕〔动作:伸懒腰〕；多句连播用 lines。\n'
    + '· pet_act —— 只演不说：单独做一个动作/表情/姿势，名单在工具描述里。\n'
    + '· pet_preset —— 演出预设：一串动作的组合，可播放/保存/删除/写注释。\n'
    + '· pet_command —— 桌面快捷指令：list 看清单、run 执行；add/update/delete 会弹确认框，'
    + '用户拒绝就停手，别反复请求。运行已有指令不用确认。\n'
    + '事件演完想让她归位用 pet(kind=reset)；想让她保持某个状态就别调。'
    + '用户摸头/递饭盆/牵手/换裙或在输入胶囊里说话时，你会收到舞台发来的消息，正常回应即可。'
    + '用户要你开软件、跑脚本时用 run_shortcut，只能选白名单里的 id。'
  try {
    ctx.systemPrompt?.section?.({ name: 'tool:pet', order: 2450, text: PROMPT })
  } catch (e) { log('注册提示词失败：' + (e && e.message)) }

  // 人设提示词：舞台的人设行为卡（persona.json 的 prompt 字段）原样注入。
  // 换人设包只改舞台 config.persona，这里每次重建工具时顺带刷新一次。
  let personaPrompt = ''
  async function refreshPersona() {
    try {
      const r = await stageFetch('GET', '/api/persona')
      if (r?.ok && r.data?.prompt && r.data.prompt !== personaPrompt) {
        personaPrompt = String(r.data.prompt)
        try {
          ctx.systemPrompt?.section?.({
            name: 'persona',
            order: 2400,
            text: `【你的桌宠人设】${r.data.name || ''}（${r.data.nickname || ''}）：${personaPrompt}`,
          })
          log('人设提示词已注入：' + (r.data.name || r.data.id || ''))
        } catch (e) { log('注册人设提示词失败：' + (e && e.message)) }
        return true
      }
    } catch { /* 舞台没开：下次工具调用时会再试 */ }
    return false
  }

  const OUTPUT = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }

  // ---- 工具 1：说话 / 表情 / 姿势 / 动作 / 序列 / 预设，合并成一个（省工具定义） ----
  // 预设清单和能力名单都拼进 description：模型要在「决定用哪个」的那一刻就知道
  // 现有哪些，而不是先 list 一次再想 —— 少一次往返。
  // 两者都会变（预设增删、config 加动作），所以构建函数可重入，变了就重建注册。
  //
  // 瘦身原则（v0.4）：描述里只写「参数怎么填」，不重复系统提示词已经说过的
  // 「什么时候该用它」「待机是她自己的事」。两边各写一遍等于每条消息都多花 token。

  // 返回「工具定义」而不是工具本身：schema 变体要挨个试（见 tryPetVariants）
  const petDef = (tracksParam, stepsParam, linesParam) => ({
    name: 'pet',
    description: '让桌宠说话（会冒气泡），支持边说边演。\n'
      + '核心用法：text 里写 〔动作〕 标记，她念到那里就做到那里 —— '
      + '如「今天也请多关照〔歪头 眯眼笑〕」「吓我一跳！〔吓一跳 冷汗〕」。'
      + '可引用现成演出：〔预设:害羞〕〔动作:伸懒腰〕；〔〕前缀 - 表示撤销（如〔-脸红〕）。\n'
      + '多句连播用 lines（阻塞到说完才返回）；纯说话不要加任何标记。\n'
      + '兼容旧参数：kind=expression/pose/motion/sequence/reset/stop/preset 仍然有效，'
      + '但单个动作用 pet_act、预设管理用 pet_preset 更直接。\n'
      + '没开桌宠时返回 ok:false，忽略即可、不必重试。\n'
      + presetHint(loadPresets()),
    parameters: {
      // 故意**不**把 kind 标成 required、也不放 enum：
      // 宿主在 execute 之前就按 schema 校验，缺 kind / 写成近义词会在插件说上一句话
      // 之前整次调用报废（2026-11-04 的 missing required property kind）。
      // 允许缺省，由 inferKind() 按参数形状还原意图；非法值在 execute 里给可用清单。
      kind: {
        type: 'string',
        description: '动作类型：say / expression / pose / motion / sequence / preset / reset / stop。'
          + '可省略 —— 给了 text 就是 say、给了 steps 就是 sequence、给了 op 就是 preset、'
          + 'name 会对表情/姿势/动作名单自动归类。',
      },
      text: { type: 'string', description: 'say：要说的话，一句话，别超过 40 字' },
      lines: linesParam,
      name: {
        type: 'string',
        description: `expression：${names.expressions.join('/')}；`
          + `pose：${names.poses.join('/')}；`
          + `motion：${names.motions.join('/')}；`
          + 'preset：预设名',
      },
      tracks: tracksParam,
      steps: stepsParam,
      op: {
        type: 'string',
        enum: ['save', 'play', 'list', 'delete'],
        description: 'kind=preset 用：save 存一套（要带 name 和 steps）/ play 按 name 播 / list / delete',
      },
      desc: { type: 'string', description: 'preset save 用：一句话说明这套动作是干什么的，方便以后挑' },
      ms: { type: 'number', description: '持续时间毫秒；say 默认 9000，motion 缺省 2000' },
      expression: { type: 'string', description: 'say 时可同时指定表情' },
      pose: { type: 'string', description: 'say 时可同时指定姿势' },
    },
    output: OUTPUT,
    async execute(rawArgs, callCtx) {
      const gate = driverGate(callCtx)
      if (gate) return { ok: false, error: gate }
      // 参数容错三件套：解包（args/arguments/JSON 文本）→ 推断 kind → 留痕
      const args = unwrapArgs(rawArgs)
      const guessed = inferKind(args)
      const kind = guessed.kind
      noteCall(guessed, rawArgs)
      const tracks = args?.tracks && typeof args.tracks === 'object' ? args.tracks : null

      // 每次调用顺手刷新能力名单（不 await：名单刷新不值得阻塞这次表演）。
      // 名单或预设变了就重建注册 —— 模型下次看到的就是新清单。
      refreshCatalog().then((changed) => { if (changed) scheduleRebuild() }).catch(() => {})

      if (kind === 'say') {
        const lines = readLines(args?.lines)
        if (lines && lines.length) {
          // 多句连播：舞台阻塞到播完才应答 —— 模型拿到返回值时话已经说完了
          return stageFetch('POST', '/api/say', {
            lines: lines.slice(0, 8),
            expression: args?.expression ? String(args.expression) : undefined,
            pose: args?.pose ? String(args.pose) : undefined,
          }, 70000)
        }
        const text = String(args?.text || '').trim()
        if (!text) return { ok: false, error: 'say 需要 text（多句用 lines）' }
        return stageFetch('POST', '/api/say', {
          text,
          ms: Number(args?.ms) || 9000,
          expression: args?.expression ? String(args.expression) : undefined,
          pose: args?.pose ? String(args.pose) : undefined,
        })
      }
      if (kind === 'expression') {
        const n = args?.name || args?.expression
        return stageFetch('POST', '/api/expression', { name: n ? String(n) : null })
      }
      if (kind === 'pose') {
        const n = args?.name || args?.pose
        return stageFetch('POST', '/api/pose', { name: n ? String(n) : 'default' })
      }
      if (kind === 'motion') {
        // 两种：内置动作（name）或现编关键帧（tracks）。舞台侧按优先级排，低优不打断。
        return stageFetch('POST', '/api/motion', {
          name: args?.name ? String(args.name) : null,
          ms: Number(args?.ms) || null,
          tracks,
        })
      }
      if (kind === 'sequence') {
        // 整段交给舞台：只有它知道每一步真实多长（见 stage/lib/sequence.mjs）
        const steps = readSteps(args?.steps)
        if (!steps || !steps.length) {
          return { ok: false, error: 'sequence 需要 steps 数组，每步形如 {op:"motion", name:"伸懒腰"}' }
        }
        return stageFetch('POST', '/api/sequence', { steps })
      }
      if (kind === 'reset') {
        return stageFetch('POST', '/api/reset', {})
      }
      if (kind === 'stop') {
        return stageFetch('POST', '/api/stop', {})
      }
      if (kind === 'preset') {
        return runPreset(args)
      }
      if (!kind) {
        return {
          ok: false,
          error: '没看懂要做什么：请给 kind（' + KINDS.join('/') + '），'
            + '或者直接给 text（=说话）、steps（=连演）、name（=表情或姿势）、op（=预设管理）',
        }
      }
      return { ok: false, error: `不认识的 kind：${kind}（可用：${KINDS.join(' / ')}）` }
    },
    presentCall: (rawArgs) => {
      const args = unwrapArgs(rawArgs)
      // 卡片标题也要跟着推断，否则缺 kind 的调用会显示成「桌宠 · 你好」这种残句
      const kind = inferKind(args).kind
      const detail = kind === 'preset' ? `${args?.op || ''} ${args?.name || ''}`.trim()
        : kind === 'sequence' ? `${readSteps(args?.steps)?.length || 0} 步`
          : String(args?.name || args?.text || '')
      const brief = Array.from(detail).slice(0, 18).join('')
      return {
        card: 'generic',
        title: `桌宠 ${kind}${brief ? ' · ' + brief : ''}`,
        kind: 'other',
        rawInput: args,
      }
    },
    presentResult: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
  })

  // 首次注册 + 注入重建回调。之后名单/预设变化都会走 scheduleRebuild() → buildPet()，
  // 同名重新注册会覆盖旧描述（宿主不支持覆盖时会抛错，被 scheduleRebuild 吞掉，
  // 旧描述只是暂时过时 —— 校验在舞台，错误信息里永远带最新 available，不影响正确性）。
  const buildPet = () => {
    const tool = tryPetVariants(petDef)
    if (tool) ctx.tools.register(tool)

    // ---- 工具 2：演出动作（单个，独立于说话） ----
    // 名单由舞台 catalog 注册（Live2D 模型实际支持的全部动作/表情/姿势），
    // 名单变了这里跟着重建 —— 模型看到的永远是当下真的演得出来的。
    try {
      ctx.tools.register(defineTool({
        name: 'pet_act',
        description: '让桌宠单独做一个演出动作（不说话）。适合：回应互动、强调刚才那句话、'
          + '纯肢体反应。要「边说边做」请在 pet 的文字里写 〔动作〕 标记，不要连发这个工具。\n'
          + `表情：${names.expressions.join('/')}；`
          + `姿势：${names.poses.join('/')}；`
          + `动作：${names.motions.join('/')}`
          + (Array.isArray(names.animations) && names.animations.length
            ? `；手臂动画：${names.animations.join('/')}` : ''),
        parameters: {
          name: {
            type: 'string',
            required: true,
            description: '动作名，从描述里的名单选。认不出的名字会返回 ok:false 和可用名单',
          },
          ms: { type: 'number', description: '可选，持续毫秒（默认按动作自身时长）' },
        },
        output: OUTPUT,
        async execute(rawArgs, callCtx) {
          const gate = driverGate(callCtx)
          if (gate) return { ok: false, error: gate }
          const args = unwrapArgs(rawArgs)
          const n = String(args?.name || '').trim()
          if (!n) return { ok: false, error: '需要 name；可用名单见工具描述' }
          refreshCatalog().then((changed) => { if (changed) scheduleRebuild() }).catch(() => {})
          return stageFetch('POST', '/api/act', { name: n, ms: Number(args?.ms) || null })
        },
        presentCall: (rawArgs) => {
          const args = unwrapArgs(rawArgs)
          const brief = Array.from(String(args?.name || '')).slice(0, 18).join('')
          return { card: 'generic', title: `桌宠 演出${brief ? ' · ' + brief : ''}`, kind: 'other', rawInput: args }
        },
        presentResult: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      }))
    } catch (e) { log('注册 pet_act 失败：' + (e && e.message)) }

    // ---- 工具 3：演出预设（多个动作的组合；舞台是唯一真源，出厂预设 + 用户增删改） ----
    try {
      ctx.tools.register(defineTool({
        name: 'pet_preset',
        description: '管理并播放桌宠的「演出预设」：一段编好的动作组合（3~6 步，含表情/手势/道具）。'
          + 'play 直接演；save 把一套 steps 存成名字（之后能在 pet 的说话文字里用 〔预设:名字〕 引用）；'
          + 'delete 删除；annotate 给已有预设补一句说明（帮助以后挑选）。',
        parameters: {
          op: {
            type: 'string',
            required: true,
            enum: ['play', 'list', 'save', 'delete', 'annotate'],
            description: 'play 播放 / list 列出 / save 保存 / delete 删除 / annotate 补注释',
          },
          name: { type: 'string', description: '预设名（play/save/delete/annotate 都要）' },
          steps: {
            type: 'array',
            description: 'save 用：动作序列，每步形如 {cue:"歪头 眯眼笑", after:800}。'
              + 'cue 是空格分隔的演出词（看/头/眼/眉/嘴/表情/道具/小动作），after 是该步后的停顿毫秒',
          },
          desc: { type: 'string', description: 'save/annotate 用：一句话说明这套动作是干什么的' },
        },
        output: OUTPUT,
        async execute(rawArgs, callCtx) {
          const gate = driverGate(callCtx)
          if (gate) return { ok: false, error: gate }
          const args = unwrapArgs(rawArgs)
          const op = String(args?.op || 'list').trim()
          if (op === 'list') {
            // 舞台侧清单（出厂 + 用户），带 desc —— 模型能按说明挑
            const r = await stageFetch('GET', '/api/preset')
            if (r?.ok && Array.isArray(r.data?.presets)) {
              return { ok: true, presets: r.data.presets.map((p) => ({ name: p.name, desc: p.desc || '', steps: (p.steps || []).length })) }
            }
            return { ok: true, presets: Object.entries(loadPresets()).map(([n, p]) => ({ name: n, desc: p.desc || '', steps: (p.steps || []).length })) }
          }
          refreshCatalog().then((changed) => { if (changed) scheduleRebuild() }).catch(() => {})
          const body = {
            op,
            name: args?.name ? String(args.name) : undefined,
            desc: args?.desc ? String(args.desc) : undefined,
          }
          if (op === 'save') {
            const steps = readSteps(args?.steps)
            if (!steps || !steps.length) return { ok: false, error: 'save 需要 steps 数组（每步 {cue, after}）' }
            body.steps = steps
          }
          const r = await stageFetch('POST', '/api/preset', body)
          if (r?.ok && typeof scheduleRebuild === 'function') scheduleRebuild()  // 预设变了，重建 pet 的提示
          return r
        },
        presentCall: (rawArgs) => {
          const args = unwrapArgs(rawArgs)
          const brief = `${args?.op || ''} ${args?.name || ''}`.trim()
          return { card: 'generic', title: `桌宠 预设${brief ? ' · ' + brief : ''}`, kind: 'other', rawInput: args }
        },
        presentResult: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      }))
    } catch (e) { log('注册 pet_preset 失败：' + (e && e.message)) }

    // ---- 工具 4：快捷指令（0.5.3）----
    // 指令库存舞台（commands.json）。增删改必须经用户确认，执行已有的不用确认。
    try {
      ctx.tools.register(defineTool({
        name: 'pet_command',
        description: '执行/管理桌面快捷指令（菜单「快捷指令」里那一组）。\n'
          + 'op=list 看有哪些（带类型与是否捕获输出）；op=run 直接跑，不用确认；\n'
          + 'op=add/update/delete 会弹桌面确认框（显示完整命令行），用户拒绝或 30 秒不点就不改。\n'
          + '参数只按 argv 传，不拼 shell 字符串；shell 模式的指令不接受 args。',
        parameters: {
          op: {
            type: 'string', required: true,
            enum: ['list', 'run', 'add', 'update', 'delete'],
            description: 'list / run / add / update / delete',
          },
          id: { type: 'string', description: '指令 id（run/update/delete 必填；add 时作为新 id）' },
          args: {
            type: 'array',
            description: 'run 用：运行时参数，字符串数组（逐项作为 argv 传给程序，不拼引号）',
          },
          label: { type: 'string', description: 'add/update：显示名' },
          type: { type: 'string', description: 'add/update：exe / cmd / powershell / bat / shortcut' },
          cmd: { type: 'string', description: 'add/update：可执行文件或脚本的绝对路径' },
          cwd: { type: 'string', description: 'add/update：工作目录（绝对路径，可省）' },
          mode: { type: 'string', description: 'add/update：exec（默认）或 shell' },
          capture: { type: 'boolean', description: 'add/update：是否回传 stdout/stderr（最多 4000 字）' },
          visible: { type: 'boolean', description: 'add/update：是否显示程序窗口' },
          timeoutMs: { type: 'number', description: 'add/update：超时毫秒（默认 30000）' },
          allowArgs: { type: 'boolean', description: 'add/update：是否允许运行时传 args' },
          group: { type: 'string', description: 'add/update：放到哪个分组（默认 driver）' },
        },
        output: OUTPUT,
        async execute(rawArgs, callCtx) {
          const gate = driverGate(callCtx)
          if (gate) return { ok: false, error: gate }
          const a = unwrapArgs(rawArgs)
          const op = String(a?.op || 'list').trim()

          if (op === 'list') {
            const r = await stageFetch('GET', '/api/commands')
            if (!r?.ok) return r
            return {
              ok: true,
              items: (r.data?.items || []).map((it) => ({
                id: it.id, label: it.label, type: it.type, group: it.group,
                capture: !!it.capture, allowArgs: !!it.allowArgs,
              })),
              running: r.data?.running || [],
            }
          }

          if (op === 'run') {
            const id = String(a?.id || '').trim()
            if (!id) return { ok: false, error: 'run 需要 id；先用 op=list 看有哪些' }
            const args = Array.isArray(a?.args) ? a.args.map(String) : []
            if (args.join('').length > 4096) return { ok: false, error: '参数太长（>4096）' }
            if (args.some((s) => s.length > 1024)) return { ok: false, error: '单个参数太长（>1024）' }
            return stageFetch('POST', '/api/commands/run', { id, args, source: 'driver' }, 40000)
          }

          if (op === 'delete') {
            const id = String(a?.id || '').trim()
            if (!id) return { ok: false, error: 'delete 需要 id' }
            return stageFetch('POST', '/api/commands/propose', { op, id }, 35000)
          }

          // add / update：字段拍平传，舞台侧组装成 item
          const id = String(a?.id || '').trim()
          if (!id) return { ok: false, error: `${op} 需要 id` }
          const item = {
            id,
            label: a?.label ? String(a.label) : id,
            type: a?.type ? String(a.type) : 'exe',
            cmd: a?.cmd ? String(a.cmd) : '',
            args: [],
            cwd: a?.cwd ? String(a.cwd) : null,
            mode: a?.mode ? String(a.mode) : 'exec',
            capture: a?.capture === true,
            visible: a?.visible === true,
            timeoutMs: Number(a?.timeoutMs) || 30000,
            allowArgs: a?.allowArgs === true,
          }
          if (!item.cmd && op === 'add') return { ok: false, error: 'add 需要 cmd（可执行文件或脚本路径）' }
          return stageFetch('POST', '/api/commands/propose', {
            op, item, group: a?.group ? String(a.group) : 'driver',
          }, 35000)
        },
        presentCall: (rawArgs) => {
          const a = unwrapArgs(rawArgs)
          const brief = `${a?.op || ''} ${a?.id || ''}`.trim()
          return { card: 'generic', title: `桌宠 指令${brief ? ' · ' + brief : ''}`, kind: 'other', rawInput: a }
        },
        presentResult: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      }))
    } catch (e) { log('注册 pet_command 失败：' + (e && e.message)) }

    refreshPersona()   // 人设提示词变了（换包/改卡）就在重建时补上
    return tool
  }
  buildPet()
  rebuildPet = buildPet
  // 启动后马上拉一次名单：桌宠已在跑的话，模型第一次看到的就是真清单
  refreshCatalog(0).then((changed) => { if (changed) scheduleRebuild() }).catch(() => {})
  refreshPersona()

  // ---- 工具 2：执行白名单快捷指令 ----
  const shortcuts = loadShortcuts()
  log(`快捷指令 ${shortcuts.length} 条：${shortcuts.map((s) => s.id).join(', ') || '无'}`)

  ctx.tools.register(defineTool({
    name: 'run_shortcut',
    description: '执行一条已注册的桌面快捷指令（开软件、跑脚本、切工作区等）。'
      + '只能选白名单里已有的 id，不能自定义命令。'
      + shortcutHint(shortcuts),
    parameters: {
      id: { type: 'string', required: true, description: '快捷指令 id' },
      args: { type: 'string', description: '可选，传给指令的附加参数（仅当该指令允许时生效）' },
    },
    output: OUTPUT,
    async execute(a, callCtx) {
      const gate = driverGate(callCtx)
      if (gate) return { ok: false, error: gate }
      const id = String(a?.id || '').trim()
      if (!id) return { ok: false, error: '需要 id' }
      const hit = shortcuts.find((s) => s.id === id)
      if (!hit) {
        return {
          ok: false,
          error: `没有这条指令：${id}`,
          available: shortcuts.map((s) => s.id),
        }
      }
      // 真正的执行发生在桌宠进程里：命令与参数写在桌宠的 shortcuts.json，
      // 模型只递 id，因此无法构造任意命令。
      return stageFetch('POST', '/api/shortcut', { id, args: a?.args ? String(a.args) : undefined })
    },
    presentCall: (a) => ({
      card: 'generic',
      title: `快捷指令 ${a?.id || ''}`,
      kind: 'command',
      rawInput: a,
    }),
    presentResult: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
  }))

  // ---- 投影：整条链路零 token ----
  ctx.on('session/event', (session, event) => {
    try { onSessionEvent(session, event) } catch (e) {
      log('session/event 异常：' + (e && e.message))
    }
  })

  // ---- 驾驶员通道轮询：会话上报 → 绑定信息 → 事件转发 ----
  // 3s 一次：事件本身低频（交互/盯盯观察），轮询成本可以忽略。
  // pollDriver 内部全吞异常，这里只负责起停。
  let pollTimer = 0
  let pollBusy = false
  const pollTick = async () => {
    if (pollBusy) return
    pollBusy = true
    try { await pollDriver(ctx) } catch (e) {
      log('驾驶员轮询异常：' + (e && e.message))
    } finally {
      pollBusy = false
    }
  }
  pollTimer = setInterval(pollTick, 3000)
  if (pollTimer.unref) pollTimer.unref()
  pollTick()

  // 挂载即写一次（state=null 表示空闲）。
  // 这不是给桌宠看的，是给排查用的：status.json 存在 = 插件确实被加载了。
  // 否则「桌宠没反应」到底是插件没装、还是没会话事件，完全没法区分。
  scheduleWrite()

  ctx.on('session/disposed', (session) => {
    try {
      const sid = sidOf(session)
      clearTerminalTimer(sid)
      flags.delete(sid)
      if (sessions.delete(sid)) scheduleWrite()
    } catch { /* 卸载路径上的异常没有意义 */ }
  })

  ctx.on('dispose', () => {
    try {
      if (pollTimer) clearInterval(pollTimer)
      for (const t of terminalTimers.values()) clearTimeout(t)
      terminalTimers.clear()
      if (writeTimer) clearTimeout(writeTimer)
      sessions.clear()
      flags.clear()
      // 状态文件留着：桌宠读不到新状态会按空闲处理，留着方便排查
      log('卸载')
    } catch { /* 同上 */ }
  })
}

/**
 * 装配过程整个包一层。
 *
 * 为什么必须包：加载期抛异常会让整条插件链挂掉，桌宠是「可有可无」的东西，
 * 绝不能成为 DSH 起不来的原因。装配失败时留一份错误日志但继续抛，
 * 让宿主自己决定怎么报——但至少现场留下来了。
 */
export function applySafe(ctx, config) {
  try {
    // 0.4.2 一度把 config 漏掉（applySafe 只调 mount(ctx)），
    // 结果是插件配置里的 debug / 别的开关永远读不到。cordis 的 apply 第二个参数就是它。
    mount(ctx, config)
  } catch (e) {
    try {
      mkdirSync(DIR, { recursive: true })
      writeFileSync(join(DIR, 'bridge-error.log'), String((e && e.stack) || e), 'utf8')
    } catch { /* 连日志都写不了就算了 */ }
    throw e
  }
}

// Cordis 认的是导出的 `apply`。外层必须是 applySafe，所以在这里改名导出。
export { applySafe as apply }

// 供离线测试（test/projection.test.mjs）直接喂宿主的各种标题形状
export { titleText }
