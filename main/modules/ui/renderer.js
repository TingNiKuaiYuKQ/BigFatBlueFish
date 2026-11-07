// 渲染层：把「状态」翻译成「模型参数」。
//
// 核心取舍 —— 参数直驱，不用引擎的 motion / expression 通道：
//
//   这个模型的 model3.json 里没有 Motions，也没有 Expressions 段（作者只声明了
//   EyeBlink / LipSync 两个组）。要用引擎通道就得手改 model3.json，等于把程序
//   和这个模型绑死。而它的 .exp3.json 本身就是纯参数表（key4=1.0 这种），
//   姿势也只是 Movement1/2/3 三个 Add 开关 —— 既然如此，直接写参数最省事：
//
//     · 不依赖 model3 的结构 → 换模型只要换目录 + 映射表
//     · 表情是瞬切，没有动作过渡 → 极简模式天然成立
//     · 每帧成本只有几个 setParameter，比动作系统轻得多
//
// 代价：表情的「互斥」语义要自己实现（exp3 用 Add 混合，需要先把所有可能
// 涉及的参数复位到默认，再叠加目标表情），而且必须**每帧**重放一遍 ——
// Cubism 每帧会把参数存档/恢复，写一次只活一帧。见 applyModelParams。

import { createStage, loadCore } from './engine.js'
import { setupInteract } from './interact.js'
import { createCueEngine, planSpeech, stripCue, hasCue, hasCueWord } from '../behavior/cues.mjs'

const $ = (id) => document.getElementById(id)
const stageEl = $('stage')
const bubbleEl = $('bubble')
const bubbleTextEl = $('bubble-text')
const hintEl = $('hint')

const api = window.pet
const log = (...a) => { try { api.log(...a) } catch { /* 主进程没起来 */ } }

function fail(msg) {
  hintEl.textContent = String(msg)
  hintEl.classList.remove('hidden')
  log('[boot] FATAL', msg)
}

let stage = null
let cfg = null
let expressions = {}
let currentState = null
let interact = null      // 交互层句柄（interact.js），探针和状态切换要用
let skirtOn = false      // 裙摆两态：false = 短裙（默认），true = 长裙

/* ---------------------------------------------------------------- 动作仲裁 */

/**
 * 动作优先级（数字越小越高，2026-11-03 调整版）：
 *   0  驾驶员（LLM）输出的动作反馈脚本 + 用户主动交互
 *   1  随机事件触发的动作 / 表情变化（含会话状态投影）
 *   2  鼠标追踪（持续层）
 *
 * 规则：
 *   · **驾驶员和用户合并成 0 档**。它们的定义就是「不互相冲突、谁先触发谁先播」，
 *     合并后天然不会互抢：后到的排在已播内容后面。
 *   · 1 档随机事件不能打断 0 档 —— 低档请求直接丢弃；同档之间后触发的
 *     覆盖先触发的（claim 对同档放行，旧租约自然被顶掉）。
 *   · 2 是持续层（眼珠/头部阻尼），不进队列、不占通道，任何动作都能盖住它。
 *     注意：追踪不再是常开的 —— 它由行为状态机（盯盯状态）显式开关，
 *     初始状态 = 关（见 behavior.mjs 与 trackEnabled）。
 *
 * 两种通道，两套实现：
 *   bubble   有明确时长 → 真队列：前一句念完再念下一句；
 *   face/pose 是「状态」不是「片段」 → 租约：同档或更高档可以接手。
 */
const PRIO = { LLM: 0, USER: 0, RANDOM: 1, TRACK: 2 }
const laneOf = (p) => (p <= 0 ? 0 : p)

const gates = new Map()          // channel → { lane, until }
const bubbleQueue = []
let bubbleLane = 99
let bubbleUntil = 0

/**
 * 申请某个通道的使用权。
 * @returns {boolean} 允许（true）/ 被更高优先级占着（false）
 */
function claim(channel, prio, holdMs) {
  const now = Date.now()
  const lane = laneOf(prio)
  const g = gates.get(channel)
  if (!g || now >= g.until || lane <= g.lane) {
    gates.set(channel, { lane, prio, until: now + Math.max(0, holdMs) })
    return true
  }
  log('[act] ' + channel + ' 正被 P' + (g.prio ?? g.lane) + ' 占用，丢弃 P' + prio + ' 的请求')
  return false
}

/* ------------------------------------------------------------------ 表情 / 姿势 */

// 这个模型的每个 exp3 就是一张「开关表」，实测参数分布：
//   key1~key13    表情 / 配件（黑脸=key1、流泪=key2、爱心眼=key4、加载=key8…）
//   Clothes1~5    换装（裙子 / 体型 / 胸口衣服 / 鞋 / 尾巴）
//   Movement1/3   姿势（狗尾草 / 竖食指）
//   LeanInput     前倾 —— 注意它是**物理输入**，必须写在物理计算之前
//
// 除眼部组（key3~key6：圈圈眼 / 屑屑眼 / ＞＜ / 爱心眼）之外，各表情碰的参数
// 互不重叠 —— 也就是说「加载(key8) + 尾巴开关(Clothes5)」本来就能共存。
//
// 所以不能「切表情时把所有表情参数清零」：那会把用户手动开的尾巴、裙子、体型
// 一起清掉，表现就是「切个表情，之前设的全没了」。正确做法是——
//
//   · 维护一个「已激活表情」集合，每帧把所有激活项的参数重放一遍
//   · 激活新表情时，只移除与它**共用参数**的那些（眼部组天然互斥）
//   · 不共用参数的一律保留 → 可以任意组合
//
// 为什么用 set(default + value) 而不是 add：每帧都重放，add 会无限累加。
// 也不用先手动清零：引擎每帧会把参数恢复成 default（`--selftest-expression`
// 实测帧初恒为 0），不写就自动归位。

const exprStack = new Map()   // name → { params, parts }。Map 保序：后激活的覆盖先激活的
let exprInfo = new Map()      // 参数 id → { default, min, max }，boot 时建好
let activePose = []           // 当前姿势的 [[id, value], ...]
let wantPose = null
let boundPose = null
let stateExpr = null          // 由「会话状态」驱动的那个表情
let wantStateExpr = null      // 当前状态「应该」长的脸（可能因为通道被占还没贴上）
let stateFacePending = false  // 有排队中的状态表情 → 收盘定时器每 600ms 补一次
let stateFaceTimer = 0
let tapExpr = null            // 由「点一下」驱动的那个表情

/* ------------------------------------------------------------ 动作语法层（cue） */

// 〔歪头 眯眼笑〕这类内联动作由 app/cues.js 解析；这里只负责把它的三类结果
// 接到舞台已有的通道上：表情走 activateExpression、手走成对原生动画、
// 一次性关键帧走 playMotion 的增量轨道。保持型通道每帧由 applyModelParams 写入。
let cueEngine = null
let cueTimers = []            // 一次说话里排的 cue 定时器，reset 时全撤
let presets = {}              // 舞台下发的演出预设（名字 → {say, steps}）
let stateEntry = null         // 当前状态在 stateMap 里的那条（漂移用）
let stateKeySeen = ''         // 上一次的状态名
let stateSince = 0            // 这个状态是什么时候开始的
let statePick = -1            // 上一次从表情池里抽中的下标（避免连抽同一张）

function makeCueEngine() {
  return createCueEngine({
    expression(name, on) {
      if (on) activateExpression(name, { why: 'cue' })
      else deactivateExpression(name)
      scheduleMask()
    },
    hand(kind) {
      // 手只有「原生动画」推得动。chest 的末值是坏姿势（见 config.poses.chest 注释），
      // 所以走 950ms 提前交接；finger/grass 直接播出来那条。
      if (kind === 'chest') {
        requestPose('chest', PRIO.USER)
        playAnimation('默认手切举手', { handoff: { at: 950, pose: 'chest' }, prio: PRIO.USER })
      } else if (kind === 'finger') {
        requestPose('finger', PRIO.USER)
        playAnimation('竖手指切出来动画')
      } else if (kind === 'grass') {
        requestPose('grass', PRIO.USER)
        playAnimation('狗尾草切换出来')
      }
    },
    pose(name) { requestPose(name, PRIO.USER) },
    motion(tracks, ms) { playMotion('', PRIO.USER, { ms, tracks }) },
    action(name) { playActionByName(name, PRIO.USER) },
    preset(name) { playPreset(name, PRIO.USER) },
    log(msg) { log(msg) },
  })
}

/**
 * 按名字演一个动作 —— 名字来自舞台注册的能力表（表情/姿势/动作/原生动画）。
 * 顺序按「越具体越优先」：原生动画（名字带「切」）> 关键帧动作 > 姿势 > 表情。
 */
function playActionByName(name, prio = PRIO.LLM) {
  const n = String(name || '').trim()
  if (!n) return false
  if (animationTable[n]) { playAnimation(n); return true }
  if (motionDefs()[n]) return playMotion(n, prio)
  if ((cfg.poses || {})[n]) return requestPose(n, prio)
  if (expressions[n]) {
    if (!claim('face', prio, 1500)) return false
    if (tapExpr) deactivateExpression(tapExpr)
    tapExpr = n
    activateExpression(n, { why: 'action' })
    scheduleMask()
    return true
  }
  // cue 词也允许当动作名用（act("歪头") 等价于说一句〔歪头〕）
  if (hasCueWord(n)) {
    cueEngine?.apply(n, {})
    // 单独一句 cue（没有配套说话）：给个固定的收尾时间，别让姿势一直挂着
    armCueRelax(5200, 'act-cue')
    if (cfg.perf?.minimal) renderOnce()
    return true
  }
  log('[act] 没有这个动作：' + n)
  return false
}

/**
 * 播一套演出预设：按 steps 顺序排时间轴。
 * 每一步要么是 cue 串（走语法层），要么是 action 名（走 playActionByName）。
 */
let presetSeq = 0
function playPreset(name, prio = PRIO.LLM, inline = null) {
  // 事件里带着剧本时优先用它（预设刚改过、渲染层的缓存可能还是旧的）
  const p = inline && Array.isArray(inline.steps)
    ? { say: inline.say || null, steps: inline.steps }
    : presets?.[name]
  if (!p) { log('[preset] 没有这套预设：' + name); return false }
  const my = ++presetSeq
  if (p.say) sayWithCues(p.say, Math.max(2200, planSpeech(p.say).ms + 600), prio)
  let at = 0
  for (const step of p.steps) {
    const delay = at
    cueTimers.push(setTimeout(() => {
      if (my !== presetSeq) return
      if (step.action) playActionByName(step.action, prio)
      else if (step.cue) cueEngine?.apply(step.cue, {})
      if (cfg.perf?.minimal) renderOnce()
    }, delay))
    at += Math.max(120, Number(step.after) || 800)
  }
  // 一步一套预设演完就收尾（同一次演出里后面还有步就等最后一步）
  armCueRelax(at + CUE_TAIL_MS, 'preset-end')
  log('[preset] 播放', name, p.steps.length, '步 /', at + 'ms')
  return true
}

/** 把参数 id 解析成 { default, ... }（stage 就绪后才能调） */
function buildParamInfo() {
  const ids = new Set()
  for (const list of Object.values(expressions)) {
    for (const p of list) ids.add(p.id)
  }
  for (const set of Object.values(cfg.poses || {})) {
    if (set && typeof set === 'object') for (const id of Object.keys(set)) ids.add(id)
  }
  // 补充参数也要在这里登记，否则 applyModelParams 会当成未知参数跳过
  for (const [name, set] of Object.entries(cfg.expressionExtras || {})) {
    if (name.startsWith('_') || !set || typeof set !== 'object') continue
    for (const id of Object.keys(set)) ids.add(id)
  }
  const out = new Map()
  for (const id of ids) {
    const info = stage.param.info(id)
    if (info) out.set(id, info)
  }
  return out
}

/**
 * 取一个表情的完整参数表：exp3 本体 + config.expressionExtras 里的补充参数。
 *
 * 为什么需要补充：有些 exp3 只写了「表情本体」，配套特效是独立参数。
 * 比如「流冷汗」的 exp3 只有 key13=1（面部表情），而汗珠由 Sweat1/Sweat2 控制 ——
 * 不补这两个，表情选了也不会出现汗。
 */
function expressionParams(name) {
  const base = expressions[name] || []
  const extra = (cfg.expressionExtras || {})[name]
  if (!extra || typeof extra !== 'object') return base
  const extraList = Object.entries(extra)
    .filter(([k]) => !k.startsWith('_'))
    .map(([id, v]) => ({ id, value: Number(v), blend: 'Add' }))
  return extraList.length ? [...base, ...extraList] : base
}

/**
 * 激活一个表情。
 * 与它共用参数的表情会被替换掉（眼部组就是这样互斥的），其余保留。
 *
 * @param {string} name 表情名
 * @param {{ttl?:number, fx?:boolean, why?:string}} opts
 *   ttl —— 这个表情是「演出」还是「常驻」。演出（摸头时随机抽的那一个、点出来的、
 *          say 顺带的那一个）必须在 ttl 内被视为瞬时：期间如果又发生一次交互，
 *          新拍的快照**不能**把它记进去，否则这次演出会被下一次还原永久固化
 *          （本机实测：连点两下头，「＞＜」就一直卸不掉了）。
 *   fx  —— 归某个模式自己管的脸（编辑模式的「＞＜」），快照一律不记。
 *   why —— 日志里标明来源，排查「脸怎么变成这样」时一眼看出是谁写的。
 */
function activateExpression(name, opts = {}) {
  if (!name) return
  if (!expressions[name]) { log('[expr] 没有这个表情：', name); return }

  const params = expressionParams(name)
  const parts = (cfg.expressionParts || {})[name] || null
  const ids = new Set(params.map((p) => p.id))

  for (const [n, item] of [...exprStack]) {
    if (n !== name && item.params.some((p) => ids.has(p.id))) exprStack.delete(n)
  }
  const ttlMs = Math.max(0, Number(opts.ttl) || 0)
  exprStack.set(name, {
    params,
    parts,
    ttlUntil: ttlMs ? Date.now() + ttlMs : 0,
    // fx = 归某个模式自己管的临时脸（编辑模式的「＞＜」），交互快照一律不记：
    // 它由那个模式自己撤，被快照记进去就会在模式退出后又被还原回来。
    fx: opts.fx === true,
    why: opts.why || '',
  })
  log('[face] +', name,
    ttlMs ? `(瞬时 ${Math.round(ttlMs)}ms)` : '(常驻)',
    opts.why ? '· 来源 ' + opts.why : '')
  // 诊断：部件型效果最容易「设了没反应」，把存在性和默认值打出来
  if (parts) {
    for (const id of Object.keys(parts)) {
      if (id.startsWith('_')) continue
      log('[expr] 部件', id,
        stage.part.has(id) ? '存在' : '**不存在**',
        '当前 opacity', stage.part.get(id),
        '目标', parts[id])
    }
  }
  reportExprState()
}

function deactivateExpression(name) {
  if (!exprStack.delete(name)) return
  log('[face] -', name)
  reportExprState()
}

function clearExpressions() {
  // 表情栈整个清空 → 语法层「谁亮着」的记账也要对齐，否则同一个表情说第二遍
  // 会被 overlays.has 挡住、再也亮不起来。放在提前返回之前：栈空但记账脏也要修。
  try { cueEngine?.resync?.([]) } catch { /* 老引擎没有这个方法 */ }
  if (!exprStack.size) return
  log('[face] 清空', [...exprStack.keys()].join('+'))
  exprStack.clear()
  reportExprState()
}

/** 把当前激活的表情名同步给主进程，右键菜单要用它画勾选状态 */
function reportExprState() {
  try { api.exprState([...exprStack.keys()]) } catch { /* 主进程没起来 */ }
}

/* 姿势补间。
 *
 * 姿势只是 Movement1/2/3 三个 Add 开关，直接写目标值手臂会「瞬移」——
 * 观感上是掉帧，不是换姿势。表情有淡入（0.24~0.3s）而姿势没有，对比更明显。
 *
 * 这里做 smoothstep 补间（t²(3-2t)），时长 260ms。上游参考项目用的是 320ms，
 * 稍微收短一点，和气泡出现的节奏更贴。
 */
const POSE_MS = 260
const poseCur = new Map()
let poseAnim = null

function bindPose(name) {
  boundPose = name ?? 'default'
  try { api.stageState?.({ pose: boundPose }) } catch { /* 主进程没起来 */ }
  const table = cfg.poses || {}
  const set = table[boundPose] || table.default || {}

  const to = new Map()
  for (const [id, v] of Object.entries(set)) to.set(id, Number(v))

  const from = new Map()
  for (const id of to.keys()) {
    const cur = poseCur.has(id) ? poseCur.get(id) : Number(stage.param.get(id) ?? 0)
    from.set(id, Number.isFinite(cur) ? cur : 0)
  }
  // 上一姿势有、新姿势没有的参数 → 也要补间回 0，否则会残留在原位
  for (const [id, v] of poseCur) {
    if (!to.has(id)) { to.set(id, 0); from.set(id, Number(v) || 0) }
  }

  poseAnim = { from, to, at: performance.now() }
  activePose = [...to.entries()].map(([id, v]) => [id, v])

  // 极简模式不跑连续渲染，这里补一条短泵，把动画走完再停
  if (cfg.perf?.minimal) {
    const pump = () => {
      renderOnce()
      if (poseAnim && performance.now() - poseAnim.at < POSE_MS + 60) requestAnimationFrame(pump)
    }
    requestAnimationFrame(pump)
  }
}

/**
 * 请求换姿势。走仲裁：低档请求在 0/1 档动作期间会被丢掉。
 * 注意调用点是「请求」而不是「赋值」——直接写 wantPose 会绕过优先级。
 */
function requestPose(name, prio = PRIO.RANDOM) {
  if (!claim('pose', prio, POSE_MS + 260)) return false
  wantPose = name || 'default'
  if (cfg.perf?.minimal) renderOnce()
  return true
}

/* ------------------------------------------------ 通用参数缓动层（tween mixer）
 *
 * 这个架构是「每帧重放」：引擎每帧把参数恢复成存档值，所有效果必须每帧重写。
 * 于是一切「瞬跳」都来自写入目标值的突变 —— cue 通道建立/清除、表情开关，都是
 * 某一帧目标值突然出现或消失。
 *
 * 这里提供统一的缓动写入器，各切换点不再各写一遍手搓插值：
 *   tweenParam(id, to, ms)   登记目标（每帧调也安全：目标没变就继续滑，不重置；
 *                            目标中途变化时从当前插值位置续接，不回头跳）
 *   runParamTweens(now)      每帧推进并写入（ease-out，到位后直写落定值）
 *
 * 两个时长：cue 通道 180ms（收尾时间轴 relaxCues 不改，只是视觉上多滑一小段，
 * 远小于 300ms 上限）；表情 120ms（表情要快，太慢会腻）。
 * 目标消失时由调用方登记一次「滑回参数默认值」，到位后 done 直写接管。
 */
const TWEEN_CUE_MS = 180
const TWEEN_EXPR_MS = 120
const paramTweens = new Map()   // id → { from, to, t0, ms, done }
let tweenPrev = new Set()       // 上一帧由 cue/表情层亮着的参数（用于检测「目标消失」）

function paramDefault(id) {
  const info = exprInfo.get(id) || (stage ? stage.param.info(id) : null)
  return info && Number.isFinite(info.default) ? info.default : 0
}

function tweenValue(tw, now) {
  const t = Math.min(1, (now - tw.t0) / tw.ms)
  const k = 1 - (1 - t) * (1 - t)          // ease-out：起步快、收尾缓
  return tw.from + (tw.to - tw.from) * k
}

function tweenParam(id, to, ms = TWEEN_CUE_MS) {
  if (!Number.isFinite(to)) return
  const now = performance.now()
  const tw = paramTweens.get(id)
  if (!tw) {
    // 冷启动：从模型当前值出发（帧初 ≈ 存档值，即「没有这个效果时」的值）
    const cur = stage ? stage.param.get(id) : null
    paramTweens.set(id, { from: cur == null ? to : Number(cur), to, t0: now, ms, done: false })
    return
  }
  if (tw.to === to) return                 // 目标没变：接着滑，别把进度清零
  tw.from = tw.done ? tw.to : tweenValue(tw, now)
  tw.to = to
  tw.t0 = now
  tw.ms = ms
  tw.done = false
}

function runParamTweens(now) {
  for (const [id, tw] of paramTweens) {
    if (tw.done) { stage.param.set(id, tw.to); continue }
    stage.param.set(id, tweenValue(tw, now))
    if (now - tw.t0 >= tw.ms) tw.done = true
  }
}

// 极简模式没有逐帧渲染：有缓动在跑时补一条短泵，滑完就停（同姿势补间的做法）
let tweenPumpOn = false
function pumpTweens() {
  if (tweenPumpOn || !cfg?.perf?.minimal) return
  tweenPumpOn = true
  const pump = () => {
    renderOnce()
    let active = false
    for (const tw of paramTweens.values()) { if (!tw.done) { active = true; break } }
    if (active) requestAnimationFrame(pump)
    else tweenPumpOn = false
  }
  requestAnimationFrame(pump)
}

/* ---------------- 关键帧动作（motions） ----------------
 *
 * 上游开源项目的做法值得抄：**LLM 不生成逐帧数据，只给关键帧和时长**。
 * 一个动作就是 { ms, tracks: { 参数id: [[t, 增量], ...] } }，t 归一化到 0~1，
 * 本地按 smoothstep 采样，每帧把增量「加」到当前值上 —— 于是它天然能和
 * 视线追踪、表情、姿势叠在一起，谁也不覆盖谁。
 *
 * 为什么用「增量」而不是绝对值：绝对值会把同一参数上的其它层（表情、视线）抹掉。
 * 上游的 ROUTINES 也是增量（起点归零、终点归零），道理一样。
 */
const motionDefs = () => (cfg.motions || {})
let motion = null        // { name, ms, tracks, t0 }

/**
 * 追踪冻结：播 LLM/用户的动作时，暂停视线追踪对头/身体/眼珠的写入。
 *
 * 为什么要冻结：追踪每帧把头写成 ±30°、身体 ±14° 的大角度，而动作增量通常
 * 只有 ±3~6°。两者数学上是叠加（先写追踪值、再加增量），但视觉上动作被
 * 追踪的变化整个淹没 —— 实测就是「动作明明在播，画面上看不见」。
 * 追踪是持续层（PRIO 3），动作是表演层（PRIO 0/1）：表演时停下来看动作，
 * 演完（+400ms 缓冲）阻尼自然把视线收回到鼠标上，不会跳。
 */
let gazeHoldUntil = 0    // performance.now() 时标

/**
 * 鼠标追踪总开关（PRIO 2 持续层）。
 *
 * 初始状态 = 关（行为状态机的约定：初始待机只眨眼呼吸，不追鼠标）。
 * 只有「盯盯状态」（behavior.mjs）和驾驶员显式要求时才打开。
 * 事件 kind=tracking 切换，/api/reset 恢复初始状态时置回 false。
 */
let trackEnabled = false

/**
 * 原生动画通道（引擎 motion manager）。
 *
 * 手臂/持物类动作只能走这里 —— 参数直驱对它们无效（引擎每帧 loadParameters
 * 恢复快照，直驱值被冲掉；实测对照见 README）。播放中姿势层让位
 * （applyModelParams 跳过姿势参数），否则姿势每帧重写会把动画打回去。
 */
let animationHold = false
let animationTable = {}  // { 名字: { index, ms, params } }，boot 时下发
let animFinish = null    // 当前原生动画的结束回调（由引擎 motionFinish 事件驱动）
let animSeq = 0          // 动画序号：防止上一次动画迟到的 finish 事件收掉这一次
let animRestore = null   // { t0, ms, from, to }：动画播完的残帧还原补间

/* ---------------- 初始态基准快照 ----------------
 *
 * 还原的目标不是「这条动画开始前的状态」，而是**一份固定的初始态快照**：
 * 启动后第一帧（姿势/表情/待机层都落位后）把全部参数拍一张，之后永不重拍。
 * 原因：照「播放前」还原会把之前的残留原样接回来 —— 上一次还原不完整、
 * 或切换动画留下的状态都会被当成「正常」固定下来，错误会随时间累积；
 * 照初始态还原则永远收敛到已知的好状态。
 *
 * 例外：切换类动画（切出来/切回，名字带「切」）的结束态是**故意保持**的
 * （掏出狗尾草、竖起食指），它们播完后把自己的结束值**固化进基准** ——
 * 基准从「初始自然态」演进成「当前自然态」，之后的一次性动画还原就回到它。
 */
let baseInitial = null   // 启动初始态（不可变，reset 用它复位基准）
let baseline = null      // 当前自然态基准（切换动画会更新它）

/** 每帧都被活层（待机/追踪/物理）重写的参数：还原时跳过，写了也会被盖 */
const TRANSIENT_PARAMS = new Set([
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
  'ParamEyeBallX', 'ParamEyeBallY', 'ParamBreath',
])

/** 当前不该被基准还原碰的参数集合：活层每帧重写的（瞬态 + 姿势 + 表情） */
function liveParamIds() {
  const skip = new Set(TRANSIENT_PARAMS)
  for (const [id] of activePose) skip.add(id)
  for (const item of exprStack.values()) {
    for (const p of item.params) skip.add(p.id)
  }
  return skip
}

/** 关键帧求值：keys=[[t,v],...]，t 为 0~1，段内用 smoothstep */
function sampleTrack(keys, p) {
  if (!Array.isArray(keys) || !keys.length) return 0
  if (p <= keys[0][0]) return Number(keys[0][1]) || 0
  for (let i = 1; i < keys.length; i += 1) {
    const [t1, v1] = keys[i]
    if (p <= t1) {
      const [t0, v0] = keys[i - 1]
      const span = t1 - t0 || 1
      const k = Math.min(1, Math.max(0, (p - t0) / span))
      const e = k * k * (3 - 2 * k)
      return v0 + (v1 - v0) * e
    }
  }
  return Number(keys[keys.length - 1][1]) || 0
}

/**
 * 播一个动作。
 * @param {string} name      motions 里的名字（或用 tracks 直接传一份自定义关键帧）
 * @param {number} prio      优先级：0（驾驶员/用户）/ 1（随机事件）
 * @param {object} [inline]  { ms, tracks } —— LLM 自己编的动作序列走这里
 */
function playMotion(name, prio = PRIO.RANDOM, inline = null) {
  const def = inline && inline.tracks ? inline : motionDefs()[name]
  if (!def || !def.tracks) { log('[motion] 没有这个动作：', name); return false }
  const ms = Math.max(160, Number(def.ms) || 3000)
  if (!claim('motion', prio, ms + 120)) return false
  motion = {
    name: name || 'inline',
    ms,
    tracks: def.tracks,
    t0: performance.now(),
    fadeIn: Math.max(0, Number(def.fadeIn) || 0),
    fadeOut: Math.max(0, Number(def.fadeOut) || 0),
  }
  // 表演层（0 档）的动作才值得冻结追踪；随机待机动作（1 档）本来就被设计成
  // 「能和追踪叠加」，不冻。
  if (prio <= PRIO.USER) gazeHoldUntil = performance.now() + ms + 400
  log('[motion] 播放', motion.name, ms + 'ms', Object.keys(def.tracks).length + '条轨',
    prio <= PRIO.USER ? '（追踪已冻结）' : '')
  if (cfg.perf?.minimal) {
    const pump = () => { renderOnce(); if (motion) requestAnimationFrame(pump) }
    requestAnimationFrame(pump)
  }
  return true
}

/** 原生动画：走引擎 motion manager，播完（或失败）自动恢复姿势层 */
function playAnimation(name, o = {}) {
  const info = animationTable[name]
  if (!info) { log('[anim] 没有这个原生动画：', name); return false }
  animationHold = true
  animRestore = null
  // 切换类动画（掏出/收回持物、竖手指等，名字带「切」）的结束态是故意保持的；
  // 其余（脱捕这类一次性表演）播完要还原。照初始态基准还原，不照播放前 ——
  // 后者会把历史残留接回来，见 baseline 声明处的注释。
  const isSwitch = name.includes('切')
  const touched = info.params || []
  let done = false
  const mySeq = ++animSeq
  let probe = 0
  let handoffTimer = 0
  const finish = () => {
    if (done) return
    done = true
    if (probe) { clearInterval(probe); probe = 0 }
    if (handoffTimer) { clearTimeout(handoffTimer); handoffTimer = 0 }
    if (animFinish?.seq === mySeq) animFinish = null
    animationHold = false
    if (isSwitch) {
      settleSwitch(touched, info.ends)
    } else {
      startAnimRestore(touched)
    }
  }
  animFinish = { seq: mySeq, fn: finish }

  // 提前交接（v0.4）：某些动画的**真实末值是个坏姿势**（举手的末把手折到脑后，
  // 手掌被躯干挡住）。这时不能等它播完再固化末值，而是在「手臂到位的瞬间」
  // 停掉动画、把控制权交给姿势层 —— 姿势层会每帧重写参数，不依赖引擎的 fadeOut。
  // handoff.at 是毫秒，从这次播放起算；done 先置位，后面的停变探测就不会再
  // 走 settleSwitch（否则坏末值还是会被固化）。
  if (o.handoff && o.handoff.pose) {
    const atMs = Math.max(0, Number(o.handoff.at) || 0)
    handoffTimer = setTimeout(() => {
      if (done || animSeq !== mySeq) return
      done = true
      if (probe) { clearInterval(probe); probe = 0 }
      if (animFinish?.seq === mySeq) animFinish = null
      // 值桥接：把动画此刻的参数值记成姿势补间的起点。帧外 param.get 读到的是
      // 上一帧动画应用后的值，而下一帧帧初引擎会把它重置回存档 —— 不桥接的话
      // bindPose 的 from 拿到的是陈旧姿势值，交接那一帧手臂会先瞬回旧位再抬起来。
      // 只桥接新姿势表里包含的参数：其余动画参数原行为是冻结在交接值，不收编。
      const poseSet = (cfg.poses || {})[o.handoff.pose] || cfg.poses?.default || {}
      for (const id of Object.keys(poseSet)) {
        const v = stage.param.get(id)
        if (v != null) poseCur.set(id, Number(v))
      }
      animationHold = false
      try { stage.stopMotions() } catch { /* 没有这个 API 就靠姿势层覆盖 */ }
      requestPose(o.handoff.pose, o.prio ?? PRIO.USER)
      log('[anim] 提前交接给姿势层', o.handoff.pose, '（' + atMs + 'ms，跳过固化末值）')
    }, atMs)
  }
  log('[anim] 原生通道播放', name, info.ms + 'ms',
    (info.params || []).length ? `(${info.params.length} 参数待还原)` : '')
  let r = null
  try {
    // loop 必须显式关掉：这批动画是 VTS 导出的，Meta.Loop 全是 true ——
    // 不关的话「脱捕」会永远循环，onFinish 永远不来，参数停在循环中段
    //（圈圈眼/张嘴/手消失就是它的中段画面），残帧还原也永远等不到时机。
    r = stage.motion('arm', info.index, { loop: false, onFinish: finish })
  } catch (e) {
    log('[anim] 播放异常：' + (e && e.message))
  }
  if (r && typeof r.catch === 'function') r.catch(finish)

  // 结束探测：引擎把 onFinish 丢了，motionFinish 事件也只在它自己的包装层
  // 才发（我们走 model.motion 直达 motionManager，收不到）。唯一可靠的信号
  // 是「动画碰的参数不再变化」—— 每隔 120ms 采一次全部相关参数，连续 3 次
  // 完全不动就认为播完了（必须看全部参数：单看某一个会在它的保持段误判）。
  const probeIds = touched.slice(0, 24)
  let sigPrev = null
  let still = 0
  const startedAt = performance.now()
  probe = setInterval(() => {
    if (done || animSeq !== mySeq) { clearInterval(probe); probe = 0; return }
    if (performance.now() - startedAt < 320) return    // 起步段在淡入，别急
    let sig = ''
    for (const id of probeIds) {
      const v = stage.param.get(id)
      sig += (v == null ? 'x' : v.toFixed(3)) + ','
    }
    if (sig === sigPrev) still += 1
    else { still = 0; sigPrev = sig }
    if (still >= 2) finish()
  }, 120)

  // 兜底：真的探不到（动画一直在微动 / 引擎换版本）也不能把姿势层永久冻住
  setTimeout(() => { if (animSeq === mySeq) finish() }, info.ms * 3 + 3000)
  return true
}

/**
 * 切换类动画（掏出/收回持物、竖手指）播完：把**动画文件的真实末值**200ms
 * 补间到位，再固化进基准与引擎存档。结束态就是新的「自然状态」—— 之后
 * 一次性动画的还原则以它为目标。
 *
 * 为什么用 ends 而不是读当前值：引擎播到末尾会 fadeOut，把曲线末值混回
 * 播放前的旧值（常常混到一半就撤条目），于是「播完读参数」拿到的是中段
 * 混合值。狗尾草卡在半透明、手停在半路、切换后草一直挂着，都是这个混合值
 * 被当成结束态固化的结果。ends 是解析曲线得到的确定值，不受混色影响。
 */
function settleSwitch(touched, ends) {
  if (!touched?.length || !ends) return
  const from = new Map()
  const to = new Map()
  for (const id of touched) {
    if (!Object.prototype.hasOwnProperty.call(ends, id)) continue
    const v = Number(ends[id])
    if (!Number.isFinite(v)) continue
    to.set(id, v)
    const cur = stage.param.get(id)
    if (cur != null && Math.abs(cur - v) > 0.001) from.set(id, cur)
  }
  if (!to.size) return
  const applyBaseline = () => {
    for (const [id, v] of to) {
      stage.param.set(id, v)
      baseline?.set(id, v)
    }
    try { stage.core?.saveParameters?.() } catch { /* 拿不到就退回持续写入 */ }
    log('[anim] 切换态固化', to.size, '个参数（写入曲线末值）')
  }
  if (!from.size) { applyBaseline(); return }
  // 先停掉引擎动作队列：它播完后还会继续写参数（我们实测会停在曲线中段），
  // 不停的话这 200ms 补间会被它逐帧压回去，残帧就留住了
  try { stage.stopMotions?.() } catch { /* 没有这个 API 就退回纯写入 */ }
  const t0 = performance.now()
  animRestore = { t0, ms: 200, holdUntil: t0 + 300, from, to, onDone: applyBaseline }
}

/* ------------------------------------------------------------------ 演出信封 perform */

/**
 * 一次把「说什么 + 演什么」按同一条时间轴排好。
 *
 * 语义（v0.4 定）：total = fadeIn + action + fadeOut；气泡显示时长 = total
 * （文案太短时按字数补下限，避免一闪而过）。
 *   action.kind = 'motion'    关键帧动作（可带 tracks 现编）
 *   action.kind = 'animation' 原生动画（手臂类，唯一能驱动手臂链的通道）
 *   action.kind = 'pose'      姿势（260ms 到位后停止写入）
 *
 * 为什么要有它：以前每个交互自己 setTimeout（左手 1.4s/2.8s/1.4s、右手 4.2s…），
 * 气泡和动作各走各的时间轴，收尾时机是一堆手算的魔数。现在统一算一次 total，
 * 调用方只需 scheduleRestore(snap, total)。
 *
 * 可被顶替的语义照旧：动作走 claim 租约、气泡走 lane，更高档来了立即打断
 * （fadeOut 直接被截断，不等它演完）——这是刻意保留的，别改成排队。
 *
 * @returns {number} 这段演出的总时长（毫秒）
 */
function perform(o = {}) {
  const prio = o.prio ?? PRIO.USER
  const act = o.action || null
  const fadeIn = Math.max(0, Number(o.fadeIn ?? 160) || 0)
  const fadeOut = Math.max(0, Number(o.fadeOut ?? 220) || 0)
  let actionMs = Number(o.ms) || 0
  if (!actionMs && act) {
    if (act.kind === 'animation') actionMs = Number(animationTable[act.name]?.ms) || 0
    else if (act.kind === 'motion') actionMs = Number((act.tracks ? act : motionDefs()[act.name])?.ms) || 0
    else if (act.kind === 'pose') actionMs = 260
  }
  const hold = Math.max(0, Number(o.hold) || 0)
  const total = Math.max(600, actionMs + fadeIn + fadeOut, hold)

  if (o.expression) tapFace(o.expression, { ttl: total + 900, why: 'perform' })
  if (o.pose) requestPose(o.pose, prio)
  if (o.text) {
    const chars = Array.from(String(o.text)).length
    say(o.text, Math.max(total, Math.min(6000, chars * 90)), prio)
  }
  if (Array.isArray(o.lines)) {
    for (const ln of o.lines) {
      if (ln?.text) say(ln.text, Number(ln.ms) || Math.max(total, 1600), prio)
    }
  }
  if (act) {
    if (act.kind === 'animation') {
      if (!playAnimation(act.name)) log('[perform] 动画不可用：', act.name)
    } else if (act.kind === 'motion') {
      if (act.tracks) {
        playMotion(act.name || '', prio, { ms: actionMs, tracks: act.tracks, fadeIn, fadeOut })
      } else if (playMotion(act.name, prio) && motion) {
        motion.fadeIn = fadeIn
        motion.fadeOut = fadeOut
      }
    } else if (act.kind === 'pose') {
      requestPose(act.name, prio)
    }
  }
  log('[perform]', act ? `${act.kind}:${act.name || 'inline'}` : '仅说话',
    '总时长', Math.round(total) + 'ms', `淡入淡出 ${fadeIn}/${fadeOut}`)
  if (cfg.perf?.minimal) renderOnce()
  return total
}

/**
 * 一次性动画（脱捕这类表演）播完的还原：照**固定的自然态基准**补间回去。
 * 500ms smoothstep + 短保持，最后把还原值固化成新存档 —— 固化这步不能省：
 * 引擎每帧末尾 loadParameters 会把「动作存档」（= 动作末帧值）拉回缓冲，
 * 不重写存档的话，只要停止写入就会被打回动作末帧（嘴合不上、手消失）。
 */
function startAnimRestore(touched) {
  if (!baseline || !touched?.length) return
  try { stage.stopMotions() } catch { /* 引擎没有这个 API 就算了 */ }
  const skip = liveParamIds()
  const from = new Map()
  const to = new Map()
  for (const id of touched) {
    if (skip.has(id)) continue
    const target = baseline.get(id)
    if (target == null) continue           // 基准里没有的（不该发生）不乱写
    const cur = stage.param.get(id)
    if (cur == null || Math.abs(cur - target) < 0.001) continue
    from.set(id, cur)
    to.set(id, target)
  }
  if (!from.size) return
  const t0 = performance.now()
  animRestore = { t0, ms: 500, holdUntil: t0 + 900, from, to }
  log('[anim] 残帧还原', from.size, '个参数 → 固定基准（500ms 补间 + 保持到 0.9s 固化）')
}

/** 还原收尾：写最终值并把缓冲固化为新存档（详见 startAnimRestore 注释） */
function finalizeAnimRestore() {
  if (!animRestore) return
  const done = animRestore.onDone
  for (const [id, v] of animRestore.to) stage.param.set(id, v)
  try { stage.core?.saveParameters?.() } catch { /* 拿不到就退回纯持续写入 */ }
  animRestore = null
  if (done) { try { done() } catch { /* 收尾失败不影响还原 */ } }
}

/** 每帧：把动作的增量加到当前参数上（必须在视线/表情之后） */
function applyMotion(now) {
  if (!motion) return
  // 一次性诊断：动作开演 300ms 时，把每条 track 的参数范围和当前值打出来。
  // 手臂参数（RArm 等）是物理输出 —— 写入是否真到达渲染、还是被 clamp/跳过，看这行就知道。
  if (!motion.probed && now - motion.t0 > 300) {
    motion.probed = true
    for (const id of Object.keys(motion.tracks)) {
      const info = stage.param.info(id)
      log('[motion-probe]', id, info
        ? `min=${info.min} max=${info.max} default=${info.default} cur=${stage.param.get(id)}`
        : 'info=null（参数不存在，写入被跳过）')
    }
  }
  const p = (now - motion.t0) / motion.ms
  if (p >= 1) { motion = null; return }
  // 演出信封的淡入淡出：整体乘一个 smoothstep 包络（毫秒单位）。
  // 关键帧本身首末多为 0，已经比较平滑；这层是给「有头有尾的整段动作」用的，
  // 让动作起落和气泡的 150ms 淡入淡出对齐。
  const elapsed = now - motion.t0
  let env = 1
  if (motion.fadeIn > 0 && elapsed < motion.fadeIn) {
    const k = Math.max(0, elapsed / motion.fadeIn)
    env *= k * k * (3 - 2 * k)
  }
  if (motion.fadeOut > 0) {
    const left = motion.ms - elapsed
    if (left < motion.fadeOut) {
      const k = Math.max(0, Math.min(1, left / motion.fadeOut))
      env *= k * k * (3 - 2 * k)
    }
  }
  for (const id in motion.tracks) {
    const d = sampleTrack(motion.tracks[id], p)
    if (!d) continue
    const info = stage.param.info(id)
    if (!info) continue
    const cur = stage.param.get(id)
    if (cur == null) continue
    stage.param.set(id, Math.max(info.min, Math.min(info.max, cur + d * env)))
  }
}

/** 当前帧应当写入的姿势值（补间中就是插值后的） */function poseValues(now) {
  if (!poseAnim) return activePose
  const t = Math.min(1, (now - poseAnim.at) / POSE_MS)
  const s = t * t * (3 - 2 * t)
  const out = []
  for (const [id, target] of poseAnim.to) {
    const a = poseAnim.from.get(id) ?? 0
    const val = a + (target - a) * s
    poseCur.set(id, val)
    out.push([id, val])
  }
  if (t >= 1) { poseAnim = null; activePose = out }
  return out
}

/**
 * 每帧调用：重放「姿势 + 已激活表情」的全部参数。
 *
 * 顺序是先姿势后表情 —— 表情优先级更高，因为「竖食指开」自己就带 Movement3=1，
 * 而姿势 default 是 Movement3=0，反过来的话姿势会把表情盖掉。
 *
 * animationHold（原生动画播放中）时跳过姿势：原生动画会 overwrite Movement1/3
 * 这类姿势参数，姿势层每帧重写会把动画的手臂位打回去 —— 表现是「手臂抬到一半
 * 被按下去」。表情参数与动画曲线不重叠，照常写。
 */
function applyModelParams() {
  const pose = animationHold ? [] : poseValues(performance.now())
  for (let i = 0; i < pose.length; i += 1) stage.param.set(pose[i][0], pose[i][1])

  // cue 通道 + 表情：先各自算出本帧「目标表」，合并后统一交给缓动层写入。
  // 合并顺序保持原语义：表情排在 cue 之后 → 共用参数时表情覆盖（＞＜ 盖住眯眼笑）。
  // 改前两边都是直接 stage.param.set 目标值 —— 通道建立/清除、表情开/关都是瞬跳；
  // 改后起落都走 tweenParam 滑过去（cue 180ms / 表情 120ms）。
  const targets = new Map()
  if (cueEngine) {
    for (const [id, v] of Object.entries(cueEngine.params())) targets.set(id, v)
  }
  const exprIds = new Set()
  for (const item of exprStack.values()) {
    for (const p of item.params) {
      const info = exprInfo.get(p.id)
      if (!info) continue
      if (p.blend === 'Multiply') targets.set(p.id, (info.default ?? 0) * p.value)
      else if (p.blend === 'Add') targets.set(p.id, (info.default ?? 0) + p.value)
      else targets.set(p.id, p.value)
      exprIds.add(p.id)
    }
  }
  // 上一帧还亮着、这一帧目标消失的参数（通道 relax / 表情摘掉）：滑回默认值。
  // 滑到位后 done 直写接管，不再依赖「引擎回存档」的瞬跳归零。
  for (const id of tweenPrev) {
    if (!targets.has(id)) tweenParam(id, paramDefault(id), TWEEN_CUE_MS)
  }
  tweenPrev = new Set(targets.keys())
  for (const [id, v] of targets) {
    tweenParam(id, v, exprIds.has(id) ? TWEEN_EXPR_MS : TWEEN_CUE_MS)
  }
  runParamTweens(performance.now())
  pumpTweens()

  // 部件透明度也要每帧写：和参数一样，引擎每帧会复位
  for (const item of exprStack.values()) {
    if (item.parts) {
      for (const [id, v] of Object.entries(item.parts)) {
        if (id.startsWith('_')) continue
        stage.part.set(id, Number(v))
      }
    }
  }

  // 调试直写放最后：优先级最高，任何层都会被它盖住（对照实验要的就是这个语义）
  applyDebugHold()
}

/* ------------------------------------------------------------------ 调试参数直写 */
//
// 来源：POST /api/debug/params（仅调试 token）。手臂/贴图这类问题光读代码推不出来，
// 必须能把某个参数单独按在某个值上看画面：{ set:{"Param61":0.2}, hold:3000 }。
// 到期后（或 clear）把当时的终值 saveParameters 固化 —— 和「保持类状态」同一套规矩。

let debugHold = null   // { set:[[id,v]…], parts:[[id,v]…], until, save, timer }

function applyDebugHold() {
  if (!debugHold) return
  if (performance.now() > debugHold.until) { endDebugHold(); return }
  for (const [id, v] of debugHold.set) stage.param.set(id, v)
  for (const [id, v] of debugHold.parts) stage.part.set(id, v)
}

function endDebugHold() {
  if (!debugHold) return
  const h = debugHold
  debugHold = null
  if (h.timer) clearTimeout(h.timer)
  if (h.save) {
    for (const [id, v] of h.set) stage.param.set(id, v)
    for (const [id, v] of h.parts) stage.part.set(id, v)
    try { stage.core?.saveParameters?.() } catch { /* 拿不到就退回持续写入 */ }
  }
  log('[debug] 参数直写结束', h.set.length + '参数/' + h.parts.length + '部件', h.save ? '已固化' : '未固化')
}

function debugApplyParams(evt) {
  if (evt.clear) { endDebugHold(); return 0 }
  const set = []
  for (const [id, v] of Object.entries(evt.set || {})) {
    if (!stage.param.has(id)) { log('[debug] 模型里没有这个参数：', id); continue }
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    set.push([id, n])
  }
  const parts = []
  for (const [id, v] of Object.entries(evt.parts || {})) {
    if (!stage.part.has(id)) { log('[debug] 模型里没有这个部件：', id); continue }
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    parts.push([id, n])
  }
  if (debugHold?.timer) clearTimeout(debugHold.timer)
  const hold = Math.max(0, Number(evt.hold) || 0)
  debugHold = {
    set,
    parts,
    until: performance.now() + hold,
    save: evt.save !== false,
    timer: hold > 0 ? setTimeout(() => { try { endDebugHold() } catch { /* 收尾失败不影响画面 */ } }, hold + 20) : 0,
  }
  applyDebugHold()
  log('[debug] 参数直写', set.length, '参数 /', parts.length, '部件，保持', hold + 'ms',
    set.map(([k, v]) => `${k}=${v.toFixed ? v.toFixed(3) : v}`).join(' '))
  if (cfg.perf?.minimal) renderOnce()
  return set.length + parts.length
}

/* ------------------------------------------------------------------ 闲置动作 + 眼神 */

// 视线平滑：指数阻尼，帧率无关。
//   每帧朝「采样目标」靠拢一段，而不是直接跳过去 —— 直接跳会一顿一顿的。
//   k = 1 - exp(-damping * dt)，damping 单位 1/s，越大越跟手。
//   眼珠快、头慢、身体更慢，三级错开才有「先看、再转头」的活物感。
//   （这套参数与判据参考了 FULASKA 桌宠的 gaze.js，实测手感是对的）
const GAZE = {
  dampingEye: 22,
  dampingHead: 11,   // 头比眼慢一点，但仍要跟得上，否则只有眼珠在动
  dampingBody: 5,
  curve: 0.7,      // 响应曲线：pow<1 → 小幅移动也给出足够角度，否则头几乎不动
  deadZone: 0.02,
}

let idleT0 = performance.now()
let lastTick = performance.now()
let uiScale = 1
let probeMode = false
let exprProbe = { on: false, id: null, before: null, after: null, watch: [] }
const sample = { eyeX: 0, angleX: 0, angleY: 0, bodyX: 0, breath: 0 }

const gazeTarget = { x: 0, y: 0 }  // -1..1，右/上为正
const gazeState = { eyeX: 0, eyeY: 0, headX: 0, headY: 0, bodyX: 0, bodyY: 0 }

const gazeCurve = (v) => (v === 0 ? 0 : Math.sign(v) * Math.pow(Math.abs(v), GAZE.curve))

function dampGaze(dtMs) {
  const dt = Math.max(1, dtMs) / 1000
  const k = (d) => 1 - Math.exp(-d * dt)

  let tx = gazeTarget.x
  let ty = gazeTarget.y
  if (Math.abs(tx) < GAZE.deadZone) tx = 0
  if (Math.abs(ty) < GAZE.deadZone) ty = 0
  tx = gazeCurve(tx)
  ty = gazeCurve(ty)

  const ke = k(GAZE.dampingEye)
  const kh = k(GAZE.dampingHead)
  const kb = k(GAZE.dampingBody)
  gazeState.eyeX += (tx - gazeState.eyeX) * ke
  gazeState.eyeY += (ty - gazeState.eyeY) * ke
  gazeState.headX += (tx - gazeState.headX) * kh
  gazeState.headY += (ty - gazeState.headY) * kh
  gazeState.bodyX += (tx - gazeState.bodyX) * kb
  gazeState.bodyY += (ty - gazeState.bodyY) * kb
}

/** 每帧：推进阻尼 + 写「非物理」参数（呼吸、眼珠） */
function idleTick() {
  const now = performance.now()
  const dtMs = Math.min(100, now - lastTick)
  lastTick = now
  const t = (now - idleT0) / 1000
  const idle = cfg.idle || {}

  dampGaze(dtMs)

  if (idle.breath) {
    const period = Number(idle.breathPeriod) || 4.2
    const amp = Number(idle.breathAmp) ?? 0.55
    stage.param.set('ParamBreath', 0.5 + Math.sin((t / period) * Math.PI * 2) * amp * 0.5)
  }

  if (idle.gaze !== false && trackEnabled && performance.now() >= gazeHoldUntil) {
    const g = Number(idle.gazeStrength) ?? 0.6
    // 眼珠不是物理输出，直接写
    stage.param.set('ParamEyeBallX', gazeState.eyeX * g)
    stage.param.set('ParamEyeBallY', gazeState.eyeY * g)
  }
}

/**
 * 角度参数必须在 physics.evaluate **之前**写。
 *
 * ParamAngleX/Y/Z 与 ParamBodyAngleX/Y 在 physics3.json 里既当输入又当输出：
 * 写晚了会被物理算完的结果覆盖，写早了才驱动整条物理链（头发、耳朵、裙子）。
 * 表现差别很明显 —— 写晚了就是「眼珠动、头不动」。
 */
function idleAngles() {
  const idle = cfg.idle || {}
  const t = (performance.now() - idleT0) / 1000
  const gazeOn = trackEnabled && idle.gaze !== false && performance.now() >= gazeHoldUntil
  const hx = gazeOn ? gazeState.headX : 0
  const hy = gazeOn ? gazeState.headY : 0

  const sway = idle.sway
    ? Math.sin((t / (Number(idle.swayPeriod) || 7.5)) * Math.PI * 2) * (Number(idle.swayAmp) ?? 1.8)
    : 0

  // headGain / bodyGain 可调：觉得头转得不够就加大，觉得太夸张就减小
  const hg = Number(idle.headGain) || 1
  const bg = Number(idle.bodyGain) || 1

  stage.param.set('ParamAngleX', hx * 30 * hg)          // ±30°，横向转头
  stage.param.set('ParamAngleY', hy * 24 * hg)          // ±24°，点头/抬头
  stage.param.set('ParamAngleZ', sway - hx * 4 * hg)    // 横向看时轻微歪头 + 待机摇摆
  // 冻结期间身体归零而不是保留旧值：追踪的身体分量也是每帧写入的，
  // 保留就是继续追踪；动作的 body 增量需要一块干净的底。
  stage.param.set('ParamBodyAngleX', gazeOn ? gazeState.bodyX * 14 * bg : 0)
  stage.param.set('ParamBodyAngleY', gazeOn ? gazeState.bodyY * 10 * bg : 0)
}

/* ------------------------------------------------------------------ 气泡 */

let bubbleTimer = 0
let lastBubble = ''      // 最近一句气泡文本：driverEvent 附带给驾驶员看
/** 立即显示（队列内部用，不判优先级） */
function showBubbleNow(text, ms, lane) {
  const max = Number(cfg.bubble?.maxChars) || 60
  const points = Array.from(String(text || '').trim())
  if (!points.length) return
  const shown = points.length > max ? points.slice(0, max).join('') + '…' : points.join('')
  lastBubble = shown

  // 气泡画在独立窗口里（见 app/bubble.html）。舞台只负责「说什么、说多久」，
  // 排版宽度由气泡窗口自己决定 —— 舞台缩到多小都不影响换行。
  try { api.bubbleShow({ text: shown, ms }) } catch { /* 主进程没起来 */ }

  bubbleLane = lane
  bubbleUntil = Date.now() + ms
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => {
    // 淡出 200ms 之后再放下一句，避免两句话在同一个位置叠着换字
    setTimeout(() => { try { api.bubbleHide() } catch { /* 同上 */ }; drainBubble() }, 200)
  }, ms)
}

function drainBubble() {
  bubbleTimer = 0
  const next = bubbleQueue.shift()
  if (!next) { bubbleUntil = 0; bubbleLane = 99; return }
  showBubbleNow(next.text, next.ms, next.lane)
}

/**
 * 说一句话。
 * @param {number} prio 优先级，默认 USER（用户交互）。LLM 走 PRIO.LLM，
 *   两者同档 → 排队播放，谁先触发谁先说；随机事件（PRIO.RANDOM）遇到忙就丢。
 */
function say(text, ms, prio = PRIO.USER) {
  const lane = laneOf(prio)
  const dur = Number(ms) || Number(cfg.bubble?.defaultMs) || 9000
  const busy = Date.now() < bubbleUntil

  if (!busy || lane < bubbleLane) {
    // 空闲，或者来了更高档的（0/1 已经合并，实际只有档位更低时才排队）
    showBubbleNow(text, dur, lane)
    return
  }
  if (lane > bubbleLane) return          // 低档：不打断，也不排队（排了也是过期语境）

  bubbleQueue.push({ text, ms: dur, lane })
  if (bubbleQueue.length > 6) bubbleQueue.shift()
}

/**
 * 带动作的说话：文字里的〔…〕按「念到那儿」的时刻落到身体上。
 *
 * 气泡整段显示（气泡窗口没有逐字能力），所以对齐靠拍子：9 字/秒 + 标点停顿，
 * 一个 cue 排在它前面那些字念完的那一刻；cue 自身要等「起手」的时间也计入
 * 时间轴，于是「说完这句才抬手」这种顺序不会乱。
 *
 * @returns {number} 这段话的朗读时长（毫秒）
 */
function sayWithCues(text, ms, prio = PRIO.USER) {
  const raw = String(text || '')
  if (!hasCue(raw)) {
    say(raw, ms, prio)
    return Number(ms) || 0
  }
  const plan = planSpeech(raw)
  const total = Math.max(Number(ms) || 0, plan.ms + 400)
  // 新的一句会顶掉上一句的身体语言：旧 cue 全撤（不只是撤定时器 ——
  // 上一句〔歪头〕留下的保持通道也要真的清掉），免得两条时间轴互相踩。
  clearCueTimers()
  try { cueEngine?.relax() } catch { /* 语法层没起来 */ }
  say(plan.plain, total, prio)
  scheduleCueChain(plan.cues)
  // 说完之后收尾：留一段尾巴让最后一个动作演完，再回到状态该有的样子
  armCueRelax(plan.ms + CUE_TAIL_MS, 'say-end')
  log('[say] ' + plan.plain.slice(0, 24) + '｜' + plan.cues.length + ' 个动作 · ' + total + 'ms')
  return total
}

/**
 * 按顺序落 cue，并把「动作要等起手」的时间顺延给下一个动作。
 * 用绝对时刻排队（每次重算 dueAt），这样前一个 cue 等得久，后面的一起往后挪，
 * 但相对节奏不变 —— 和参考实现的 Line.Advance 是同一个语义。
 */
function scheduleCueChain(cues) {
  if (!cues.length) return
  const step = (idx, dueAt) => {
    const item = cues[idx]
    cueTimers.push(setTimeout(() => {
      let wait = 0
      try { wait = cueEngine?.apply(item.cue, { spoken: item.spoken, tone: item.tone }) || 0 } catch (e) {
        log('[cue] 执行失败：' + (e && e.message))
      }
      if (cfg.perf?.minimal) renderOnce()
      const next = cues[idx + 1]
      if (!next) return
      const gap = Math.max(0, next.at - item.at)
      const extra = Math.max(0, (Number(wait) || 0) * 1000 - gap)
      step(idx + 1, Date.now() + gap + extra)
    }, Math.max(0, dueAt - Date.now())))
  }
  step(0, Date.now() + cues[0].at)
  if (cueTimers.length > 160) cueTimers = cueTimers.slice(-120)
}

/** 清掉还没落地的 cue（reset / 新的演出打断旧的） */
function clearCueTimers() {
  for (const t of cueTimers) clearTimeout(t)
  cueTimers = []
}

/* ---- 收尾：这段话演完，把身体语言交还回去 ----
 *
 * 语法层的保持通道（歪头/眯眼笑/抚胸）和 overlay（脸红/钢盆）是「说了才亮」，
 * 但以前没有任何东西负责关掉它们 —— 一句「你看我这样〔歪头 眯眼笑 脸红〕」说完，
 * 那张眯着眼红着脸歪着头的脸会一直挂着，直到下一次 reset。用户看到的
 * 「动作表情不会恢复了」就是这么来的。
 *
 * 规则：一次说话/一套预设结束时排一个收尾定时器；新的演出会把它往后推。
 * 收尾只撤 cue 自己点亮的东西，不动体型、衣服、状态表情（那由 applyStateFace 补）。
 */
const CUE_TAIL_MS = 900
let cueRelaxTimer = 0

function relaxCues(why) {
  clearTimeout(cueRelaxTimer)
  cueRelaxTimer = 0
  clearCueTimers()
  try { cueEngine?.relax() } catch (e) { log('[cue] 收尾失败：' + (e && e.message)) }
  // cue 的 overlay 可能正好是当前状态表情：撤掉之后要按状态重贴一次，
  // 否则脸会停在「什么都没有」上（状态没变，就不会有第二次 applyState）。
  if (stateExpr && !exprStack.has(stateExpr)) stateExpr = null
  applyStateFace('cue-relax')
  scheduleMask()
  log('[cue] 收尾（' + why + '）')
  if (cfg.perf?.minimal) renderOnce()
}

/** 排一次收尾；ms 是「这段演出要演多久」 */
function armCueRelax(ms, why) {
  clearTimeout(cueRelaxTimer)
  cueRelaxTimer = setTimeout(() => relaxCues(why), Math.max(800, Number(ms) || 0))
}

/* ------------------------------------------------------------------ 状态 */

function applyState(st) {
  currentState = st
  const map = cfg.stateMap || {}
  const key = st?.state ?? 'idle'
  const r = map[key] || map.idle || {}
  stateEntry = r
  const fresh = key !== stateKeySeen
  if (fresh) {
    stateKeySeen = key
    stateSince = Date.now()
    statePick = -1
  }

  // 状态表情：单张（expression）或表情池（expressions）。
  // 池子的意义 —— 用户报过「同一个状态挂着一张脸十分钟不动」：working 一直兔牙、
  // thinking 一直前倾，像贴纸。现在同状态里按 driftMs 换脸，还能偶发小动作。
  if (r.expression !== undefined || Array.isArray(r.expressions)) {
    if (fresh || !wantStateExpr) wantStateExpr = pickStateExpr(r)
  }
  applyStateFace('state:' + key)

  // 姿势：stateMap 里的 `default` 意思是「这个状态不干预姿势」，不是「把姿势按回默认」。
  //
  // 以前无条件覆盖，结果 LLM 通过 /api/pose 摆好的姿势，在下一个状态变化到来时
  // （通常几百毫秒内：thinking → working → result）就被打回 default —— 表现就是
  // 「姿势闪一下就复位」。2026-11-03 用本地模型实测到：pose=finger 返回 ok，
  // 但桌宠日志里姿势立刻变回 default。
  //
  // 现在只有状态明确写了非 default 的姿势才接管（例如 waiting → chest）。
  if (r.pose !== undefined && r.pose !== 'default') requestPose(r.pose, PRIO.RANDOM)

  log('[state]', key, '→ 表情', exprNames().join('+') || '无', '姿势', String(wantPose),
    st?.detail ? `· ${st.detail}` : '')

  if (cfg.perf?.minimal) renderOnce()
}

/** 从表情池里抽一张，避免连续抽到同一张 */
function pickStateExpr(r) {
  const pool = Array.isArray(r.expressions) ? r.expressions.filter((x) => x !== undefined) : null
  if (!pool || !pool.length) return r.expression === undefined ? wantStateExpr : r.expression
  if (pool.length === 1) return pool[0]
  let i = Math.floor(Math.random() * pool.length)
  if (i === statePick) i = (i + 1) % pool.length
  statePick = i
  return pool[i]
}

/**
 * 状态漂移：同一个会话状态持续太久时换点花样。
 * 「不要长时间保持一个动作」—— 换脸 + 偶发小动作 + 偶发换配件，三件都做。
 * 只在当前状态条目写了 driftMs 时才生效（idle 不写 → 不会被这里打扰，
 * 待机归行为状态机管）。
 */
function driftState() {
  const r = stateEntry
  if (!r) return
  const drift = Number(r.driftMs) || 0
  if (!drift || Date.now() - stateSince < drift) return
  if (Date.now() < bubbleUntil) return      // 正在说话：别抢脸
  stateSince = Date.now()

  if (Array.isArray(r.expressions) && r.expressions.length) {
    wantStateExpr = pickStateExpr(r)
    applyStateFace('drift')
  }
  // 偶发小动作：走 1 档，被更高档占用就自然丢弃
  if (Array.isArray(r.motions) && r.motions.length && Math.random() < (Number(r.motionChance) ?? 0.4)) {
    const name = r.motions[Math.floor(Math.random() * r.motions.length)]
    if (playMotion(name, PRIO.RANDOM)) log('[state] 漂移小动作', name)
  }
  // 偶发换配件（单片眼镜/黑框眼镜这类）：带 ttl，自己会退场
  if (Array.isArray(r.props) && r.props.length && Math.random() < (Number(r.propChance) ?? 0.18)) {
    const name = r.props[Math.floor(Math.random() * r.props.length)]
    if (!exprStack.has(name) && claim('face', PRIO.RANDOM, 4000)) {
      activateExpression(name, { ttl: Math.max(4000, drift), why: 'drift' })
      scheduleMask()
      log('[state] 漂移配件', name)
    }
  }
}

function exprNames() {
  return [...exprStack.keys()]
}

/**
 * 把「当前状态应该长的脸」贴上。
 *
 * 拆成单独函数是必要的：0 档（用户交互 / 驾驶员）正在用这张脸的时候，1 档的
 * 状态表情抢不到通道。旧代码在这里直接 return，之后只要状态不再变化就再没有
 * 第二次机会 —— 脸会永久停在旧表情上（本机实测：交互演完把「＞＜」留在脸上）。
 * 现在抢不到就记账，由收盘定时器重试，通道一空立刻补上。
 *
 * @returns {boolean} 已贴上（true）/ 已排队（false）
 */
function applyStateFace(reason) {
  if (wantStateExpr === stateExpr) {
    stateFacePending = false
    return true
  }
  if (!claim('face', PRIO.RANDOM, 1500)) {
    if (!stateFacePending) {
      stateFacePending = true
      log('[face] 状态表情排队中 →', wantStateExpr || '(无)',
        '（当前', stateExpr || '(无)', '；通道被更高档占用，', reason || '', '）')
    }
    return false
  }
  const next = wantStateExpr
  if (stateExpr) deactivateExpression(stateExpr)
  stateExpr = next
  if (stateExpr) activateExpression(stateExpr, { why: 'state（' + (reason || '') + '）' })
  stateFacePending = false
  scheduleMask()
  if (cfg.perf?.minimal) renderOnce()
  return true
}

/** 状态表情的补贴：600ms 一次，没排队就什么都不做（极简模式下也照常工作） */
function startStateFaceRetry() {
  if (stateFaceTimer) return
  stateFaceTimer = setInterval(() => {
    if (stateFacePending) applyStateFace('retry')
  }, 600)
  if (stateFaceTimer.unref) stateFaceTimer.unref()
}

/* ------------------------------------------------ 快照 / 恢复 / 全局复位 */

/**
 * 舞台状态快照：交互事件（摸头/牵手/裙子…）演出前拍一张，结束后平滑还原。
 *
 * 只记「会演完消失的东西」：激活的表情集合 + 姿势。鼠标追踪由行为状态机管，
 * 不属于某次交互的状态，不进快照。
 *
 * **有两类表情刻意不记**（v0.4.1 修，实测踩过「＞＜ 卸不掉」）：
 *   · stateExpr —— 状态表情归状态管，还原时按「当前状态」重贴。记进快照的话，
 *     演出期间状态若从 waiting 变成 thinking，还原会把旧状态的脸重新贴回去，
 *     而状态不会再变一次，于是永久卡住。
 *   · 仍在 ttl 内的瞬时表情 —— 上一次交互还没演完就来了下一次（连点两下头），
 *     第二次快照会把第一次的演出表情记进去，之后每次还原都在重建它。
 */
function snapshotStage() {
  const now = Date.now()
  const exprs = []
  // 语法层点亮的（〔脸红〕〔钢盆〕）归那次说话管，不进快照 ——
  // 记进去的话，下一次交互还原会把这个「本该跟着话说完就消失的表情」永久贴回脸上。
  const cueOn = new Set((() => { try { return cueEngine?.overlays?.() || [] } catch { return [] } })())
  for (const [name, item] of exprStack) {
    if (name === stateExpr) continue
    if (cueOn.has(name)) continue
    if (item.fx) continue
    if (item.ttlUntil && item.ttlUntil > now) continue
    exprs.push(name)
  }
  return {
    exprs,
    pose: boundPose || 'default',
    tap: tapExpr && exprs.includes(tapExpr) ? tapExpr : null,
  }
}

/**
 * 平滑恢复到快照。表情按原顺序重放（引擎自带 0.24~0.3s 淡入），
 * 姿势走 260ms 补间 —— 和进出编辑模式的还原是同一条路径，观感一致。
 *
 * 恢复属于「0 档收尾动作」：正在演的 1 档随机事件会被顶掉，这是预期 ——
 * 事件已经结束，随机动作没理由还占着姿势。
 */
function restoreStage(snap) {
  if (!snap) return
  clearExpressions()
  stateExpr = null
  tapExpr = null
  for (const n of snap.exprs) activateExpression(n, { why: 'restore' })
  if (snap.tap && exprStack.has(snap.tap)) tapExpr = snap.tap
  requestPose(snap.pose || 'default', PRIO.LLM)
  scheduleMask()
  // 快照不含状态表情：还原后按「当前状态」重贴一次。
  // 这段演出里状态变过的话，这一步就是唯一能把脸纠正回来的地方。
  applyStateFace('restore')
  log('[restore] 已恢复', snap.exprs.join('+') || '(无表情)', '姿势', snap.pose || 'default',
    '状态表情 →', wantStateExpr || '(无)')
  if (cfg.perf?.minimal) renderOnce()
}

/** 「事件结束后等一会儿再还原」的统一入口；返回定时器句柄方便取消 */
/**
 * 延时快照还原。`before` 可选：还原前先做收尾（比如播「手放下来」的切回
 * 动画），返回还需要等多久（毫秒）—— 演完再还原，快照才不会把动画中段
 * 的姿势拍进去。
 */
function scheduleRestore(snap, ms, before = null) {
  return setTimeout(() => {
    let extra = 0
    try { extra = Math.max(0, Number(before?.()) || 0) } catch { /* 回调失败不挡还原 */ }
    setTimeout(() => restoreStage(snap), extra)
  }, Math.max(400, Number(ms) || 4000))
}

/**
 * 全局「恢复初始状态」：驾驶员的工具（kind=reset）和所有事件的收尾兜底。
 *
 * 初始待机 = 无表情 + default 姿势 + 鼠标追踪关闭 + 气泡清空。
 * 钢盆这类「驾驶员要求保持」的常驻状态也由这里统一撤除 —— 除非驾驶员
 * 在 reset 之后重新摆回想要的状态。
 */
function resetToInitial() {
  clearExpressions()
  clearCueTimers()
  clearTimeout(cueRelaxTimer)
  cueRelaxTimer = 0
  try { cueEngine?.relax() } catch { /* 语法层没起来 */ }
  stateExpr = null
  wantStateExpr = null
  stateFacePending = false
  tapExpr = null
  wantPose = 'default'
  trackEnabled = false
  bowlState = 'off'
  animRestore = null
  paramTweens.clear()     // 缓动层一并清空：复位后不该再有旧目标在被写入
  tweenPrev = new Set()
  editExprSnap = null     // 编辑模式中途被 reset：退出时不要再把旧表情还原回来
  endDebugHold()          // 调试直写的参数一并撤销，否则 reset 之后画面还是被按住
  try { stage?.stopMotions?.() } catch { /* 引擎没有这个 API 就算了 */ }
  // 基准复位：切换动画固化进基准的状态（举着狗尾草之类）一并撤销，
  // 并立即把参数写回初始值 + 固化存档 —— 不然 loadParameters 会把旧存档拉回来。
  if (baseInitial && stage) {
    baseline = new Map(baseInitial)
    for (const [id, v] of baseInitial) stage.param.set(id, v)
    try { stage.core?.saveParameters?.() } catch { /* 拿不到就算了 */ }
  }
  if (bowlRestoreTimer) { clearTimeout(bowlRestoreTimer); bowlRestoreTimer = 0 }
  // 气泡队列一并清空：恢复初始状态意味着「什么都别再说」
  bubbleQueue.length = 0
  bubbleUntil = 0
  bubbleLane = 99
  clearTimeout(bubbleTimer)
  bubbleTimer = 0
  try { api.bubbleHide() } catch { /* 主进程没起来 */ }
  scheduleMask()
  log('[reset] 已恢复初始待机（追踪关）')
  if (cfg.perf?.minimal) renderOnce()
}

function renderOnce() {
  if (!stage) return
  stage.advance(1000 / Math.max(1, Number(cfg.perf?.fpsCap) || 30))
  stage.renderOnce()
  scheduleMask()
}

/* ------------------------------------------------------------------ 轮廓掩码 */

// 窗口是整块矩形，但角色只占一部分。要让「透明处不挡鼠标」，需要知道
// 光标下是不是实心像素。
//
// 掩码在这里算（只有渲染层能 readPixels），但**判定在主进程做** ——
// 主进程有 screen.getCursorScreenPoint()，不依赖窗口事件；
// 而渲染层一旦被设成穿透就收不到事件，自己判断会死锁（拖动一次后失联就是这么来的）。
//
// 掩码用 1/4 降采样，几十 KB，只在表情/姿势/尺寸变化后重算一次，不进每帧路径。
let mask = null
let maskTimer = 0

function scheduleMask() {
  clearTimeout(maskTimer)
  maskTimer = setTimeout(() => {
    try {
      mask = stage ? stage.alphaMask(4) : null
    } catch { mask = null }
    if (mask) api.sendMask({ w: mask.w, h: mask.h, data: mask.data })
  }, 260)
}

/* ------------------------------------------------------------------ 渲染循环 */

function setupRenderLoop() {
  const perf = cfg.perf || {}
  const fps = Number(perf.fpsCap) || 0

  stage.onBeforeUpdate(() => {
    if (wantPose !== boundPose) { bindPose(wantPose); scheduleMask() }

    // 表情探针采样「帧初」：此刻引擎刚恢复过参数，还没被我们写。
    // 它若是默认值，就证明参数确实每帧被重置 —— 也就证明了必须每帧重写。
    if (exprProbe.on && exprProbe.id) exprProbe.before = stage.param.get(exprProbe.id)

    applyModelParams()

    if (exprProbe.on && exprProbe.id) exprProbe.after = stage.param.get(exprProbe.id)
    // 组合探针：同时盯多个参数，确认它们能共存
    for (let i = 0; i < exprProbe.watch.length; i += 1) {
      const w = exprProbe.watch[i]
      w.got = stage.param.get(w.id)
    }

    idleTick()
    idleAngles()
    applyMotion(performance.now())

    // 原生动画播完的残帧还原：500ms 补间回播放前，保持到 0.9s 后固化存档。
    if (animRestore) {
      const nowA = performance.now()
      const t = (nowA - animRestore.t0) / animRestore.ms
      if (t < 1) {
        const s = t * t * (3 - 2 * t)
        for (const [id, v] of animRestore.to) {
          const a = animRestore.from.get(id) ?? v
          stage.param.set(id, a + (v - a) * s)
        }
      } else if (nowA >= animRestore.holdUntil) {
        finalizeAnimRestore()
      } else {
        for (const [id, v] of animRestore.to) stage.param.set(id, v)
      }
    }

    // 帧内采样：参数在每帧 coreModel.update 之后会被重置回存档值，
    // 所以「帧外读参数」永远是默认值。要验证写没写进去，只能在帧内最后一刻读。
    // 初始态基准快照：等姿势补间走完（poseAnim=null）再拍，补间中点不能当初始态。
    // 活层（瞬态/姿势/表情）管理的参数不进基准 —— 它们每帧被重写，
    // 而且像「默认体型」这种开机即激活的表情，其值不该被当成自然态固化。
    if (!baseInitial && !poseAnim && stage.param?.ids?.length) {
      const skip0 = liveParamIds()
      baseInitial = new Map()
      for (const id of stage.param.ids) {
        if (skip0.has(id)) continue
        const v = stage.param.get(id)
        if (v != null) baseInitial.set(id, v)
      }
      baseline = new Map(baseInitial)
      log('[base] 初始态基准快照', baseInitial.size, '个参数')
    }
    if (probeMode) {
      sample.eyeX = stage.param.get('ParamEyeBallX')
      sample.angleX = stage.param.get('ParamAngleX')
      sample.angleY = stage.param.get('ParamAngleY')
      sample.bodyX = stage.param.get('ParamBodyAngleX')
      sample.breath = stage.param.get('ParamBreath')
    }
  })

  // 角度要在物理**前后各写一次**：
  //   · 之前写 —— 驱动整条物理链（头发、耳朵、裙子会跟着甩）
  //   · 之后写 —— 物理会把 ParamAngle* 当输出重算，不补一次就被吃掉
  // 只写前面 = 眼珠动、头不动（就是现在的症状）；只写后面 = 有角度但物理不响应。
  //
  // 表情参数也一样要在这个位置写一遍：像「前倾」用的是 LeanInput（物理输入，
  // physics3.json 里有 19 处引用）。只写在物理之后，物理链根本不响应，
  // 表现就是「表情选了但几乎看不出变化」。
  stage.onBeforePhysics(() => {
    applyModelParams()
    idleAngles()
  })

  if (perf.minimal) {
    stage.stop()
    log('[perf] 极简模式：已停止逐帧渲染，仅按需出帧')
    return
  }

  if (fps > 0) {
    stage.ticker.maxFPS = fps
    log('[perf] 帧率上限', fps, 'fps')
  }
}

/* ------------------------------------------------------------------ 布局 */

function layout() {
  if (!stage) return
  const { width: W, height: H } = stage.size()
  const { width: ow, height: oh } = stage.modelSize()
  const m = cfg.model || {}
  const scale = Number(m.scale) || 1
  const k = Math.min(W / ow, H / oh) * scale
  stage.model.scale.set(k)
  const ax = Number(m.anchorX) ?? 0.5
  const ay = Number(m.anchorY) ?? 1.0
  const offY = Number(m.offsetY) || 0
  stage.model.position.set(W * ax, H * ay - (oh * k) / 2 + offY)
  // 给交互层算区域判定用：模型原始画布尺寸（窗口坐标 → 模型归一化）
  window.__modelSize = { width: ow, height: oh }
  // 上报模型实际占的矩形（窗口坐标），菜单据此贴边
  const dw = ow * k, dh = oh * k
  api.modelRect?.({ x: W * ax - dw / 2, y: H * ay - dh + offY, w: dw, h: dh })
  log('[layout]', Math.round(W) + 'x' + Math.round(H), '模型', Math.round(ow) + 'x' + Math.round(oh), 'k=' + k.toFixed(4))
  scheduleMask()
}

/* ------------------------------------------------------------------ 交互 */

function setupInteraction() {
  /* ============ 新交互层：全部逻辑在 interact.js ============
     左键点区域 → 打招呼 / 换裙子
     右键短按  → 菜单
     右键长按  → 加载条扫过 0.5s → 编辑模式（虚线框 + 拖动 + 等比缩放）
  */
  interact = setupInteract({
    stageEl,
    api,
    cfg,
    log,
    // 区域名（头/裙摆/腿/尾巴/右手/左手…）直接透传，行为在事件池里定
    onGreet: (region) => onRegionTap(region),
    onDouble: (region) => onRegionDouble(region),
    onSkirt: toggleSkirt,
    onAction: (a) => log('[menu] ' + a),
    onMenu: window.__probeInteract ? () => log('[probe] 菜单被请求（探针不真弹）') : null,
    onEnterEdit: enterEditFx,
    onExitEdit: exitEditFx,
    refreshMask: scheduleMask,
  })
  return

  /* ============ 以下是旧实现，保留备查，不再执行 ============ */
  let drag = null
  let raf = 0
  let pending = null

  // 拖动窗口：位置按 rAF 合并 + 取整。
  // 每个 pointermove 都发一次 setPosition 会让透明窗口不停重合成，表现就是闪。
  const flush = () => {
    raf = 0
    if (!pending) return
    api.move(Math.round(pending.x), Math.round(pending.y))
    pending = null
  }
  const scheduleMove = (x, y) => {
    pending = { x, y }
    if (!raf) raf = requestAnimationFrame(flush)
  }

  // 事件本身由主进程按掩码放行：光标在角色身上时窗口才接收点击，
  // 透明处直接穿透。所以这里不用再判一次「实不实心」。
  stageEl.addEventListener('pointerdown', async (e) => {
    if (e.button === 2) return
    const b = await api.bounds()
    if (!b) return
    drag = { sx: e.screenX, sy: e.screenY, wx: b.x, wy: b.y, moved: 0 }
    // 拖动期间强制不穿透，否则拖到透明区窗口就跑了、手势中断
    api.setDragging(true)
    stageEl.setPointerCapture?.(e.pointerId)
  })

  stageEl.addEventListener('pointermove', (e) => {
    if (!drag) return
    const dx = e.screenX - drag.sx
    const dy = e.screenY - drag.sy
    drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy))
    if (drag.moved > 3) scheduleMove(drag.wx + dx, drag.wy + dy)
  })

  stageEl.addEventListener('pointerup', (e) => {
    const wasDrag = drag && drag.moved > 3
    if (drag) stageEl.releasePointerCapture?.(e.pointerId)
    drag = null
    api.setDragging(false)
    if (!wasDrag && e.button === 0) onTap()
  })

  // 拖动中途失焦 / 松手在窗口外，也要把 dragging 复位
  window.addEventListener('blur', () => {
    if (drag) { drag = null; api.setDragging(false) }
  })

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    api.menu()
  })

  // 刻意不监听 window resize。
  //
  // 这个窗口尺寸固定（main 里 resizable:false），本来就不需要响应 resize；
  // 而一旦监听并调 stage.resize，就会形成正反馈：
  //   canvas 变大 → body 被撑开 → 窗口 resize → 再调 stage.resize → canvas 更大 …
  // 实测窗口会从 520×780 一路涨到 546×811 停不下来。尺寸只由 config 决定。
}

/** 点一下：换个表情 + 冒一句，纯本地，不花 token */
const TAP_PHRASES = ['嗯？怎么啦～', '在的在的', '别戳我啦', '要干活了吗？', '我在这儿呢']
let tapCount = 0
function onTap() {
  tapCount += 1
  const pool = ['爱心眼', '脸红', '＞＜', '兔牙', '屑屑眼'].filter((n) => expressions[n])
  if (pool.length && claim('face', PRIO.USER, 1500)) {
    // 只替换「上一次点出来的那个」，用户手动开的尾巴/裙子保持不动
    const next = pool[tapCount % pool.length]
    if (tapExpr) deactivateExpression(tapExpr)
    tapExpr = next
    activateExpression(next, { ttl: 3600, why: 'tap' })
    scheduleMask()
    // 点一下是「反应」不是「设定」：4 秒后自己卸掉，回到当前状态该有的脸。
    // 以前这个表情会一直挂着（下一次点击才换），看起来就像「表情卡住了」。
    const mine = next
    setTimeout(() => {
      if (tapExpr !== mine) return
      deactivateExpression(mine)
      tapExpr = null
      applyStateFace('tap-expire')
      scheduleMask()
      if (cfg.perf?.minimal) renderOnce()
    }, 4200)
  }
  // 招呼语优先用 config.interact.greetings，没配就退回内置表
  const pool2 = (cfg && cfg.interact && Array.isArray(cfg.interact.greetings) && cfg.interact.greetings.length)
    ? cfg.interact.greetings
    : TAP_PHRASES
  say(pool2[tapCount % pool2.length], 2600, PRIO.USER)
  if (cfg.perf?.minimal) renderOnce()
}

/* ------------------------------------------------ 交互事件池（行为状态机.txt） */

/** 两个表情是否共用参数（共用 = 激活一个会顶掉另一个） */
function exprConflicts(a, b) {
  if (!expressions[a] || !expressions[b]) return false
  const ids = new Set(expressionParams(b).map((p) => p.id))
  return expressionParams(a).some((p) => ids.has(p.id))
}

/**
 * 激活一个「点出来的」表情：替换上一次点出来的，不动用户手动开的配件。
 * @param {string} name
 * @param {{ttl?:number, why?:string}} opts ttl = 演出时长（期间不算进快照，见 activateExpression）
 */
function tapFace(name, opts = {}) {
  if (!expressions[name] || !claim('face', PRIO.USER, 1500)) {
    log('[face] 点选表情被丢弃：', name, '（脸正被更高档占用）')
    return false
  }
  if (tapExpr) deactivateExpression(tapExpr)
  tapExpr = name
  activateExpression(name, { ttl: Number(opts.ttl) || 0, why: opts.why || 'tap' })
  scheduleMask()
  return true
}

/** 渲染层 → 驾驶员通道：主进程按主动说话频率门控后写 pet-events.json */
function driverEvent(text) {
  const payload = {
    kind: 'interaction',
    text,
    state: { expressions: exprNames(), pose: String(wantPose || 'default'), bubble: lastBubble },
  }
  try { api.driverEvent(payload) } catch { /* 主进程没起来 */ }
  log('[driver] →', text)
}

/** 区域单击分发。头部延迟 360ms 派发（等双击判别窗口，见 interact.js） */
function onRegionTap(region) {
  if (region === '头') return bowlState !== 'off' ? bowlHeadPat() : headPat()
  if (region === '右手') return rightHandTap()
  if (region === '左手') return leftHandTap()
  return onTap()          // 腿 / 尾巴 / 未命中：默认招呼
}

/** 区域双击分发：只有头部有分支（钢盆），其余当没看见 */
function onRegionDouble(region) {
  if (region === '头') headDouble()
}

/* ---- 摸摸头：台词 + 表情 + 小动作随机抽一组，演完平滑还原 ---- */

const HEAD_TAPS = [
  { text: '怎么啦？', expr: '前倾', motion: '歪头' },
  { text: '有事儿嘛？', expr: '前倾' },
  { text: '开饭啦？', expr: '爱心眼' },
  { text: '唔！', expr: '＞＜' },
  { text: '要干活吗？还是摸鱼？', expr: '屑屑眼' },
  { expr: '加载' },                    // 什么也不说，只是发着呆
]

function headPat() {
  const snap = snapshotStage()
  const pick = HEAD_TAPS[Math.floor(Math.random() * HEAD_TAPS.length)]
  // 一次信封排好：气泡 + 表情 + 小动作，时长统一由 perform 算
  const total = perform({
    text: pick.text || '',
    expression: pick.expr,
    action: pick.motion ? { kind: 'motion', name: pick.motion } : null,
    prio: PRIO.USER,
    hold: pick.text ? 2600 : 1200,
  })
  driverEvent(pick.text
    ? `用户摸了摸你的头，现在已经自动说了「${pick.text}」。`
    : '用户摸了摸你的头，快回复ta吧。')
  scheduleRestore(snap, total + 700)
  return total
}

/* ---- 钢盆：双击头部戴上；恢复前再双击转常驻；常驻中再双击摘下 ---- */

let bowlState = 'off'          // off 没戴 | temp 戴着（计划自动恢复）| keep 常驻
let bowlSnap = null
let bowlRestoreTimer = 0

function headDouble() {
  if (bowlState === 'off') {
    bowlSnap = snapshotStage()
    bowlState = 'temp'
    tapFace('钢盆')
    say('我的饭盆！', 2600, PRIO.USER)
    driverEvent('用户把饭盆扣在了你头上。')
    bowlRestoreTimer = setTimeout(() => {
      bowlRestoreTimer = 0
      bowlState = 'off'
      restoreStage(bowlSnap)
      bowlSnap = null
    }, 2600 + 2000)
  } else if (bowlState === 'temp') {
    // 哐当分支：取消自动恢复，饭盆转为常驻（只有驾驶员 reset 或再双击才摘）
    clearTimeout(bowlRestoreTimer)
    bowlRestoreTimer = 0
    bowlState = 'keep'
    say('（哐当！）', 2200, PRIO.USER)
    driverEvent('用户决定一直把饭盆扣在你头上。')
  } else {
    // 常驻中再双击：摘下来，还原到戴上前的样子
    bowlState = 'off'
    const snap = bowlSnap
    bowlSnap = null
    if (snap) restoreStage(snap)
    else resetToInitial()
    log('[bowl] 饭盆已摘下')
  }
}

/** 钢盆在头上时摸头：另一个分支（黑脸不与钢盆冲突才加） */
function bowlHeadPat() {
  // 先判冲突再激活：真冲突的话 tapFace 会把钢盆顶掉（共用参数自动替换），
  // 表现就是「摸个头把饭盆摸没了」
  const conflict = exprConflicts('黑脸', '钢盆')
  const ok = !conflict && tapFace('黑脸')
  say('我的饭盆摸起来手感很好吗？', 2800, PRIO.USER)
  driverEvent('用户摸了摸你的头，现在已经自动说了「我的饭盆摸起来手感很好吗？」。')
  // 只摘黑脸，钢盆还挂着 —— 这里不能走快照恢复，会把它一起清掉
  if (ok) {
    setTimeout(() => {
      if (tapExpr === '黑脸') { deactivateExpression('黑脸'); tapExpr = null; scheduleMask() }
    }, 4200)
  }
  if (cfg.perf?.minimal) renderOnce()
}

/* ---- 右手（画面左）：抬手伸手 + 脸红，40% 说话 ---- */

const CHEST_BACK_MS = 1400   // 举手切默认手 ~1.1s，留余量
// 抬手起手时长：动画在 ~950ms 时手臂到最高点（Param59≈0.51 / Param60≈0.88）。
// 再往后引擎的 fadeOut 会把末值混回来，而且末值本身是个坏姿势 —— 就在这一刻交接。
const CHEST_RAISE_MS = 950

function rightHandTap() {
  const snap = snapshotStage()
  const speak = Math.random() < 0.4
  // v0.4 修法（P0-2）：
  //   旧实现 perform({action:'animation'}) 播完由 settleSwitch 固化**曲线末值**，
  //   而「默认手切举手」的末值会把手臂折到脑后（Param59=0.476 / Param60=0.86），
  //   手掌被躯干/头发挡住 —— 截图上看就是「手不见了」。
  //   现在：动画只负责漂亮的起手，到 950ms 停掉并交接给 chest 姿势
  //   （config.poses.chest 是实测「手臂抬到胸高且手掌可见」的组合）。
  const total = perform({
    text: speak ? '难道是要带我去吃饭？' : '',
    expression: '脸红',
    hold: 4200,
    prio: PRIO.USER,
  })
  playAnimation('默认手切举手', { handoff: { at: CHEST_RAISE_MS, pose: 'chest' } })
  driverEvent(speak
    ? '用户牵了你的右手，现在已经自动说了「难道是要带我去吃饭？」。'
    : '用户牵了你的右手，快回复ta吧。')
  // 收尾：先回 default 姿势（否则姿势层会一直按着 chest），再播「举手切默认手」放手
  scheduleRestore(snap, total, () => {
    requestPose('default', PRIO.USER)
    if (animationTable['举手切默认手']) {
      playAnimation('举手切默认手')
      return CHEST_BACK_MS
    }
    return 0
  })
}

/* ---- 左手（画面右）：掏狗尾草晃两下，收尾必定收回 ---- */

const GRASS_SWAY_MS = 2800    // 晃两个来回
const GRASS_BACK_MS = 1500    // 切回动画 1133ms + settle 补间余量
const GRASS_GUARD_MS = 700    // 切回之后再等这么久，草必须已经不在了

/**
 * 狗尾草的收尾必须是「确定的」，不能只靠时间轴碰巧排对。
 *
 * 实测（2026-11-04）：草是 Movement1 这个参数在挑贴图，进/出靠两条原生动画的曲线
 * 把 0↔1 拉过去；收尾一旦被打断（连点两下、动画结束探测被别的东西干扰、切回动画
 * 在 pose 层还原之后才落地），草就停在半路或干脆留在手上 —— 用户看到的就是
 * 「不给消失」。所以这里做三层保险：
 *   ① 序号：后一次左手点击整体作废前一次的时间轴（两条时间轴交错必定互相踩）
 *   ② 快照还原：回到交互前的姿势（含 Movement1=0）
 *   ③ 看门狗：再过 GRASS_GUARD_MS，只要 Movement1 还不为 0，就地压回 0 并写进基准
 */
let grassSeq = 0

function leftHandTap() {
  const snap = snapshotStage()
  const my = ++grassSeq
  // 第一段：说话 + 掏出（同一个信封，气泡时长跟着动画走）
  const outMs = perform({
    text: '哈哈没想到我藏了一根狗尾巴草吧~',
    action: { kind: 'animation', name: '狗尾草切换出来' },
    prio: PRIO.USER,
  })
  // 第二段：掏出来后接 grass 姿势 + 晃两个来回
  setTimeout(() => {
    if (my !== grassSeq) return
    requestPose('grass', PRIO.USER)
    playMotion('狗尾草晃动', PRIO.USER)
  }, outMs)
  // 第三段：晃完必定收回（切回默认手 bake 回自然态 + 快照还原表情）
  setTimeout(() => {
    if (my !== grassSeq) return
    playAnimation('狗尾草切回默认手')
    setTimeout(() => { if (my === grassSeq) restoreStage(snap) }, GRASS_BACK_MS)
    setTimeout(() => {
      if (my !== grassSeq) return
      const v = Number(stage.param.get('Movement1'))
      if (Number.isFinite(v) && v > 0.02) {
        // 姿势层还在举着就一起放掉（否则压回 0 也会被每帧重写回去）
        requestPose('default', PRIO.USER)
        stage.param.set('Movement1', 0)
        try { baseline?.set('Movement1', 0) } catch { /* 基准还没建好 */ }
        try { stage.core?.saveParameters?.() } catch { /* 拿不到就靠每帧写入 */ }
        log('[grass] 看门狗收草：残留 Movement1 =', v.toFixed(2))
      }
    }, GRASS_BACK_MS + GRASS_GUARD_MS)
  }, outMs + GRASS_SWAY_MS)
}

/**
 * 进出编辑模式的「小情绪」。
 * 进来：说一句「有框？？」+ 换成 ＞＜；退出：把表情还原成进来之前的样子。
 *
 * 快照只在第一次进入时拍，反复进出不会把 ＞＜ 记进快照（否则退出后卸不掉）。
 * 用 clear + 按原顺序重放，而不是只删 ＞＜ —— 因为 ＞＜ 是眼型表情，
 * 激活时会把原来的眼型挤掉，光删它回不来。
 */
let editExprSnap = null

function enterEditFx() {
  if (editExprSnap) return
  // 状态表情不进快照：退出编辑模式时由 applyStateFace 按「当时的状态」重贴，
  // 这样编辑期间状态变过也不会把旧状态的脸还原回去。
  editExprSnap = [...exprStack.keys()].filter((n) => n !== stateExpr)
  log('[edit] 表情快照 =', editExprSnap.join(' / ') || '(空)')
  say('有框？？', 2600, PRIO.USER)
  activateExpression('＞＜', { fx: true, why: 'edit-mode' })
  scheduleMask()
  if (cfg.perf?.minimal) renderOnce()
}

function exitEditFx() {
  if (!editExprSnap) return
  const snap = editExprSnap
  editExprSnap = null
  clearExpressions()
  stateExpr = null
  for (const n of snap) activateExpression(n, { why: 'edit-exit' })
  // 编辑模式期间状态可能变过：退出时按当前状态重贴，别留在编辑期的脸
  applyStateFace('edit-exit')
  log('[edit] 表情已还原 =', snap.join(' / ') || '(空)')
  scheduleMask()
  if (cfg.perf?.minimal) renderOnce()
}

/** 裙摆两态切换：Clothes1 是 Add，-1 = 长裙。换装持久，反应表情演完还原 */
function toggleSkirt() {
  skirtOn = !skirtOn
  // 裙子本体先落位 —— 反应表情的快照要含它，几秒后还原时裙子不能跟着弹回去
  if (skirtOn) activateExpression('裙子切换')
  else deactivateExpression('裙子切换')
  scheduleMask()

  const snap = snapshotStage()
  if (!skirtOn) {
    // 长裙 → 短裙
    say('短裙轻松，适合居家。', 2800, PRIO.USER)
    tapFace('脸红', { ttl: 5200, why: 'skirt' })
    tapFace('＞＜', { ttl: 5200, why: 'skirt' })   // 与脸红共用参数的话会自动替换，不冲突就共存
    driverEvent('用户把你的裙子换成了短裙。')
  } else {
    // 短裙 → 长裙
    say('长裙优雅，我优雅吧。', 2800, PRIO.USER)
    tapFace('猫猫嘴', { ttl: 5200, why: 'skirt' })  // expressionExtras 合成表情，Exp3 里没有文件
    driverEvent('用户把你的裙子换成了长裙。')
  }
  scheduleRestore(snap, 4400)
  if (cfg.perf?.minimal) renderOnce()
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  const payload = await api.boot()
  window.__probeInteract = !!payload.__debugInteract
  cfg = payload.config
  expressions = payload.expressions || {}
  animationTable = payload.animations || {}
  presets = payload.presets || {}
  cueEngine = makeCueEngine()
  uiScale = Number(payload.uiScale) || 1

  // 合成表情：expressionExtras 里配了参数、但 Exp3 目录没有文件的名字（如「猫猫嘴」）。
  // activateExpression 只认 expressions 表，这里补登记空壳 —— 真正的参数由
  // expressionParams() 在激活时从 extras 拼，模型里没有的参数会自然跳过。
  for (const [name, set] of Object.entries(cfg.expressionExtras || {})) {
    if (name.startsWith('_') || !set || typeof set !== 'object') continue
    if (!expressions[name]) expressions[name] = []
  }

  // 界面元素按 DPI 放大：窗口是按物理像素创建的，1px 的 CSS 字体在
  // 175% 屏上会显得很小，所以字号统一乘回缩放比。
  const bubbleFont = (Number(cfg.bubble?.fontSize) || 15) * uiScale
  document.documentElement.style.setProperty('--bubble-font', bubbleFont + 'px')
  document.documentElement.style.setProperty('--hint-font', (12.5 * uiScale) + 'px')

  const ok = await loadCore('/vendor/live2dcubismcore.min.js')
  if (!ok) throw new Error('Cubism Core 没加载起来：检查 /vendor/live2dcubismcore.min.js')

  const perf = cfg.perf || {}
  // 分辨率：配置为 0/缺省时按屏幕 DPR 走（上限 2）。
  // 之前固定 1.0，在缩放 150% 的屏上等于半分辨率渲染，看着就是糊的。
  const dpr = window.devicePixelRatio || 1
  const res = Number(perf.resolution) > 0 ? Number(perf.resolution) : Math.min(dpr, 2)

  stage = await createStage({
    container: stageEl,
    modelUrl: payload.modelUrl,
    backgroundAlpha: 0,
    antialias: perf.antialias !== false,
    resolution: res,
    autoStart: true,
  })
  log('[boot] 模型已载入', JSON.stringify(stage.modelSize()), '渲染倍率', res)

  // 原生动画的真实结束信号（内核把 onFinish 丢了，只有事件可信）。
  // 只认当前动画序号的回调，避免上一次动画迟到的 finish 收掉这一次。
  stage.onMotionFinish?.(() => {
    const cur = animFinish
    if (cur && cur.seq === animSeq) cur.fn()
  })

  // 参数表必须在 stage 就绪后构建：默认值要问 coreModel 要
  exprInfo = buildParamInfo()
  log('[boot] 参数表', exprInfo.size, '个（表情 + 姿势）')

  layout()
  setupRenderLoop()
  setupInteraction()

  // 参数/部件转储（调试口 /api/params）：排查「动画播完残留」「参数没写进去」
  // 这类问题用 —— 眼睛看不见的中间状态，转储一眼就能定位是哪个参数挂了。
  api.onDumpParams?.(() => {
    if (!stage) return
    const list = []
    for (const id of stage.param.ids) {
      const info = stage.param.info(id)
      // min/max 一起给：判断「这个参数写得有没有效果」必须先知道它的范围。
      // 本机踩过：歪头写 AngleZ=30，视觉纹丝不动 —— 因为它的上限只有 1，
      // 30 被夹成 1，看起来就是「动作没反应」。
      list.push({
        kind: 'param', id, value: stage.param.get(id), default: info?.default,
        min: info?.min, max: info?.max,
      })
    }
    for (const id of stage.part.ids) {
      list.push({ kind: 'part', id, value: stage.part.get(id) })
    }
    api.dumpParams(list)
  })

  // 编辑模式改完尺寸后主进程会通知一次：重设 PIXI 分辨率再重排。
  // 只有这里会调 stage.resize —— 不用 window.resize 监听（会正反馈把窗口撑大）。
  api.onResized?.((sz) => {
    if (!sz || !stage) return
    try {
      stage.resize(sz.w, sz.h)
      layout()
      scheduleMask()
      log('[layout] 窗口尺寸变更后重排', sz.w + 'x' + sz.h)
    } catch (e) {
      log('[layout] 重排失败：' + ((e && e.message) || e))
    }
  })

  // 穿透完全交给主进程（它按掩码 + 全局光标判定），这里不设初始状态，
  // 避免两边打架导致「某一刻之后再也收不到事件」
  api.onGaze((g) => {
    if (probeMode) return // 探针模式忽略真实光标，否则每 50ms 就被覆盖回去
    // 主进程给的是「屏幕坐标下为正」，这里翻成「向上为正」，与模型参数方向一致
    gazeTarget.x = g.x
    gazeTarget.y = -g.y
  })
  api.onState((st) => applyState(st))
  api.onAction((evt) => {
    if (!evt) return
    // 事件可带 prio：行为状态机的随机事件带 1，驾驶员/菜单不带（默认 0 档）
    const prio = Number.isFinite(Number(evt.prio)) ? Number(evt.prio) : PRIO.LLM
    if (evt.kind === 'say') {
      // lines = 多句连播（say 序列）：整组进同一档排队，前一句念完再念下一句
      const lines = Array.isArray(evt.lines) ? evt.lines : null
      if (lines && lines.length) {
        for (const ln of lines.slice(0, 8)) {
          const t = typeof ln === 'string' ? ln : (ln?.text ?? '')
          const d = typeof ln === 'string' ? 2600 : (Number(ln?.ms) || 2600)
          sayWithCues(t, d, prio)
        }
      } else {
        // 文字里的〔…〕交给语法层：说完前半句，动作跟着落点演
        sayWithCues(evt.text, evt.ms, prio)
      }
      if (evt.expression && claim('face', prio, 1500)) {
        if (tapExpr) deactivateExpression(tapExpr)
        tapExpr = evt.expression
        activateExpression(evt.expression)
        scheduleMask()
      }
      if (evt.pose) requestPose(evt.pose, prio)
      if (evt.preset) playPreset(evt.preset, prio)
      if (cfg.perf?.minimal) renderOnce()
    } else if (evt.kind === 'act') {
      // 单个动作：名字可以是表情 / 姿势 / 关键帧动作 / 原生动画 / cue 词
      playActionByName(evt.name, prio)
      if (cfg.perf?.minimal) renderOnce()
    } else if (evt.kind === 'cue') {
      // 一串 cue 词（人设卡 idleAction / 插件 say 里拆出来的裸 cue）
      try { cueEngine?.apply(String(evt.cue || ''), {}) } catch (e) {
        log('[cue] 执行失败：' + (e && e.message))
      }
      // 裸 cue 没有朗读时长，按固定节拍收尾（自然事件是 1 档，不该长期占着脸和姿势）
      armCueRelax(5200, 'idle-cue')
      if (cfg.perf?.minimal) renderOnce()
    } else if (evt.kind === 'preset') {
      playPreset(evt.name, prio, evt)
      if (cfg.perf?.minimal) renderOnce()
    } else if (evt.kind === 'presets') {
      // 预设库变了（设置页增删改 / 工具保存）：整体替换，〔预设:名字〕就能引用了
      presets = evt.presets || {}
      log('[preset] 预设表更新', Object.keys(presets).length, '套')
    } else if (evt.kind === 'expression') {
      // name 为空 = 清除全部表情（回到默认脸）
      if (!claim('face', PRIO.LLM, 1500)) { if (cfg.perf?.minimal) renderOnce(); return }
      if (!evt.name) {
        clearExpressions()
        stateExpr = null
        tapExpr = null
      } else {
        if (tapExpr) deactivateExpression(tapExpr)
        tapExpr = evt.name
        activateExpression(evt.name)
      }
      scheduleMask()
      if (cfg.perf?.minimal) renderOnce()
    } else if (evt.kind === 'expr-toggle') {
      // 右键菜单用：勾上就加进集合，取消就移除。同参数的表情会被自动替换。
      if (exprStack.has(evt.name)) deactivateExpression(evt.name)
      else activateExpression(evt.name)
      if (evt.name === stateExpr) stateExpr = null
      if (evt.name === tapExpr) tapExpr = null
      scheduleMask()
      if (cfg.perf?.minimal) renderOnce()
    } else if (evt.kind === 'motion') {
      // animation = 原生动画通道（手臂/持物类，参数直驱推不动的那批）
      if (evt.animation) playAnimation(evt.animation)
      // name 走内置动作库；没有 name 时用 tracks 当一份临时动作（LLM 现编的序列）
      else {
        const ok = playMotion(evt.name || '', prio, evt.tracks ? { ms: evt.ms, tracks: evt.tracks } : null)
        // 自然事件（1 档）的结果要留痕：被 0 档顶掉时这里写「顶掉」，
        // 配合 behavior 的「触发」日志就能对出「发了但没演」的完整因果。
        if (prio >= PRIO.RANDOM) {
          log('[nat] motion', evt.name || 'inline', ok ? '执行' : '被更高档顶掉（未播）')
        }
      }
    } else if (evt.kind === 'pose') {
      requestPose(evt.name || 'default', prio)
      if (cfg.perf?.minimal) renderOnce()
    } else if (evt.kind === 'low-interrupt') {
      // 低打扰（0.5.4）：手势反转交给 interact，渲染层不碰窗口透明度（那是主进程的 setOpacity）
      try { interact?.setLowMode?.(evt.on === true) } catch (e) { log('[low] 手势切换失败：' + (e && e.message)) }
    } else if (evt.kind === 'perf') {
      // 低打扰/省电（0.5.4）：主进程按需要降帧。0 = 不限，跟 boot 时的 cfg.perf.fpsCap 同一语义。
      // 0.5.7：paused = 窗口被隐藏，直接把 ticker 停掉（透明置顶窗口不会被判成遮挡，
      // 不主动停就会一直空转烧 GPU）。
      if (typeof evt.paused === 'boolean') {
        try {
          if (evt.paused) stage?.ticker?.stop()
          else stage?.ticker?.start()
          log('[perf] 渲染循环', evt.paused ? '暂停' : '恢复')
        } catch (e) { log('[perf] 暂停/恢复失败：' + (e && e.message)) }
        if (evt.paused) return
      }
      const cap = Number(evt.fpsCap) || 0
      try {
        if (stage?.ticker) stage.ticker.maxFPS = cap
      } catch (e) {
        log('[perf] 设置帧率上限失败：' + (e && e.message))
      }
      log('[perf] 帧率上限 →', cap || '不限')
      if (cfg.perf?.minimal) renderOnce()
    } else if (evt.kind === 'tracking') {
      // 行为状态机的盯盯状态开关（鼠标追踪，PRIO 2）
      trackEnabled = !!evt.on
      log('[tracking]', trackEnabled ? '开（盯盯）' : '关')
    } else if (evt.kind === 'reset') {
      // 驾驶员的全局复位：恢复初始待机（含钢盆等常驻状态的撤除）
      resetToInitial()
    } else if (evt.kind === 'shortcut') {
      say(evt.ok ? `好啦 · ${evt.label || evt.id}` : `「${evt.label || evt.id}」没跑起来`, 3000, PRIO.RANDOM)
    } else if (evt.kind === 'debug-tap') {
      // 调试入口（仅调试 token 可用）：用 curl 触发交互，方便手动回归
      //   /api/debug/tap {"region":"头"}  → 和真点一下等价（含双击分支用 double）
      log('[debug] 触发交互', evt.region, evt.double ? '双击' : '单击')
      if (evt.double) onRegionDouble(evt.region)
      else onRegionTap(evt.region)
    } else if (evt.kind === 'debug-params') {
      // 调试入口（仅调试 token 可用）：把任意参数按在某个值上，看画面到底由谁决定
      debugApplyParams(evt)
    }
  })

  // 胶囊菜单：主进程处理不了的项（换装/换表情/换姿势）转到这里
  api.onMenuAction?.((a) => {
    log('[menu] 渲染层执行', a)
    if (a === 'skirt') return toggleSkirt()
    if (a === 'expr-random') return onTap()
    if (a === 'pose-cycle') {
      const names = Object.keys(cfg.poses || {}).filter((n) => !n.startsWith('_'))
      if (!names.length) return
      const i = names.indexOf(wantPose)
      requestPose(names[(i + 1) % names.length], PRIO.USER)
      say('换个姿势～', 1500)
      if (cfg.perf?.minimal) renderOnce()
      return
    }
    // 0.5.7：菜单里逐个点选（expr:体型1 / pose:grass）。同一个再点一次 = 摘掉，
    // 这样「体型1 → 体型2 → 体型1」不会越点越乱。
    if (a.startsWith('expr:')) {
      const n = a.slice(5)
      if (!expressions[n]) return log('[menu] 没有这个表情：' + n)
      if (exprStack.has(n)) {
        deactivateExpression(n)
        if (n === stateExpr) stateExpr = null
        if (n === tapExpr) tapExpr = null
        log('[menu] 摘掉表情', n)
      } else {
        if (tapExpr) deactivateExpression(tapExpr)
        tapExpr = n
        activateExpression(n, { why: 'menu' })
        log('[menu] 戴上表情', n)
      }
      scheduleMask()
      if (cfg.perf?.minimal) renderOnce()
      return
    }
    if (a.startsWith('pose:')) {
      const n = a.slice(5)
      if (!(cfg.poses || {})[n]) return log('[menu] 没有这个姿势：' + n)
      requestPose(n, PRIO.USER)
      log('[menu] 切姿势', n)
      if (cfg.perf?.minimal) renderOnce()
      return
    }
  })

  applyState(null)
  startStateFaceRetry()
  // 状态漂移：同一状态挂太久就换脸/做小动作（间隔由 stateMap 的 driftMs 决定）
  setInterval(driftState, 1500)
  idleT0 = performance.now()
  log('[boot] 就绪')

  // 探针：--motion-probe = 就绪 2.5s 后走引擎**原生 motion 通道**播「竖手指切出来」。
  // 对照实验：同样的动画，参数直驱（/api/motion tracks）不动、原生通道动 →
  // 问题在直驱路径的写法；两个都不动 → 问题在 moc3/加载链。
  if (payload.__motionProbe) {
    setTimeout(() => {
      log('[motion-probe] 原生通道播放 arm/0（竖手指切出来）')
      const r = stage.motion('arm', 0)
      log('[motion-probe] motion() 返回', r)
    }, 2500)
  }

  // 探针：--selftest-expression 时切到第一个表情，并在多个时间点回读它的参数。
  //
  // 判定标准：帧初应回到 default（引擎每帧恢复），帧末应是目标值。
  // 修复前帧末也是 default —— 表现就是「表情闪一帧就没了」。
  // 这里跨 6 秒采样，如果 6 秒后帧末仍是目标值，说明保持住了。
  if (payload.__debugExpr) {
    // --expr=名字 可以指定；支持逗号分隔多个，用来测「组合」
    const wanted = String(payload.__exprName || '').split(',').map((s) => s.trim()).filter(Boolean)
    const name = wanted.find((n) => expressions[n])
      || ['爱心眼', '脸红', '兔牙', '＞＜'].find((n) => (expressions[n] || []).length)
      || Object.keys(expressions).find((n) => (expressions[n] || []).length)
      || null
    const list = name ? expressions[name] : []
    exprProbe.on = true
    exprProbe.id = list[0]?.id || null
    const applied = wanted.filter((n) => expressions[n])
    if (applied.length) {
      for (const n of applied) activateExpression(n)
      stateExpr = applied[0]
    } else if (name) {
      stateExpr = name
      activateExpression(name)
    }
    const info = exprProbe.id ? stage.param.info(exprProbe.id) : null
    log('[expr-probe] 目标表情', String(name), '采样参数', String(exprProbe.id),
      'min=' + (info ? info.min : '?'), 'max=' + (info ? info.max : '?'),
      'def=' + (info ? info.default : '?'),
      'exp3 值=' + (list[0] ? list[0].value : '?'))
    for (const ms of [300, 1000, 3000, 6000]) {
      setTimeout(() => {
        log('[expr-probe] t=' + ms + 'ms',
          '帧初', Number(exprProbe.before ?? 0).toFixed(3),
          '帧末', Number(exprProbe.after ?? 0).toFixed(3),
          '激活集合', exprNames().join('+') || '无')
      }, ms)
    }
  }

  // 诊断：--debug-params 打印所有表情参数的「模型里是否真的存在 + 取值范围」。
  // 用来解释「某个表情选了没反应」——最常见的原因是 exp3 里写的参数名
  // 在模型里根本不存在，或者值被 clamp 到范围之外。
  if (payload.__debugParams) {
    const ids = new Map() // id → 用到它的表情名
    for (const [name, list] of Object.entries(expressions)) {
      for (const p of list) {
        if (!ids.has(p.id)) ids.set(p.id, [])
        ids.get(p.id).push(name)
      }
    }
    log('[params] 表情共触碰', ids.size, '个参数')
    for (const [id, names] of ids) {
      const info = stage.param.info(id)
      log('[params]', id.padEnd(12),
        info ? `min=${info.min} max=${info.max} def=${info.default}` : '**模型里不存在**',
        '←', names.join(','))
    }
  }

  log('[boot] flags', JSON.stringify({
    drawables: !!payload.__debugDrawables,
    params: !!payload.__debugParams,
    keys: Object.keys(payload).filter((k) => k.startsWith('__')),
  }))

  // 探针：--debug-interact 用合成指针事件把右键手势状态机跑一遍。
  // 验证点：短按开菜单 / 长按扫过进编辑 / 拖动后 1 秒自动退出。
  if (payload.__debugInteract) {
    const PROBE_ORIGIN = { x: window.screenX || 0, y: window.screenY || 0 }
    const fire = (type, x, y, button = 0) => {
      const sx = (window.screenX || 0) + x
      const sy = (window.screenY || 0) + y
      stageEl.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true,
        clientX: x, clientY: y, screenX: sx, screenY: sy,
        button, buttons: button === 2 ? 2 : 1,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }))
    }
    const W = () => window.innerWidth
    const H = () => window.innerHeight
    // 绝对时间基准：块内可以嵌套调用，不受前面 setTimeout 累积影响
    const base = performance.now()
    const at = (absMs, fn) => setTimeout(fn, Math.max(0, absMs - (performance.now() - base)))
    const mode = () => (interact ? interact.mode : '?')

    at(1500, () => {
      log('[probe] ① 左键点头部（50%,12%）')
      fire('pointerdown', W() * 0.5, H() * 0.12)
      at(1600, () => fire('pointerup', W() * 0.5, H() * 0.12))
    })
    at(2700, () => {
      log('[probe] ② 左键点裙摆（50%,62%）')
      fire('pointerdown', W() * 0.5, H() * 0.62)
      at(2800, () => fire('pointerup', W() * 0.5, H() * 0.62))
    })
    at(3900, () => {
      log('[probe] ③ 右键短按 150ms → 期望请求菜单')
      fire('pointerdown', W() * 0.5, H() * 0.4, 2)
      at(4050, () => fire('pointerup', W() * 0.5, H() * 0.4, 2))
    })
    at(5200, () => {
      log('[probe] ④ 右键长按 700ms → 期望扫过 → edit')
      fire('pointerdown', W() * 0.5, H() * 0.4, 2)
      at(5900, () => fire('pointerup', W() * 0.5, H() * 0.4, 2))
    })
    at(6400, () => log('[probe] 扫过后 mode =', mode(), '（期望 sweeping/edit）'))
    at(7000, () => log('[probe] 松手后 mode =', mode(), '（期望 edit，无拖动则框常驻）'))
    at(7400, () => {
      log('[probe] ⑤ 编辑模式里拖动 +40/+30')
      fire('pointerdown', W() * 0.5, H() * 0.4)
      at(7480, () => fire('pointermove', W() * 0.5 + 40, H() * 0.4 + 30))
      at(7560, () => fire('pointerup', W() * 0.5 + 40, H() * 0.4 + 30))
    })
    at(8300, () => log('[probe] 拖动后 0.7s mode =', mode(), '（此时应仍是 edit）'))
    at(9200, () => log('[probe] 拖动后 1.8s mode =', mode(), '（期望 idle）'))
    // ⑥ 缩放：直接进编辑模式，从左边框往外拉 100px。
    // 期望：窗口宽 700 → 900（锚点在中心，两侧同时扩，所以位移 ×2）。
    at(9600, () => {
      log('[probe] ⑥ 抓左边框往左（外）拉 100px，期望变大')
      interact?.enterEdit()
      const w0 = window.innerWidth
      at(9700, () => fire('pointerdown', 6, H() * 0.5))
      at(9760, () => fire('pointermove', -94, H() * 0.5))
      at(9830, () => {
        fire('pointerup', -94, H() * 0.5)
        log('[probe] 缩放后 innerWidth', w0, '→', window.innerWidth, `（期望 ${w0 + 200} 上下）`)
      })
    })
    at(10600, () => {
      log('[probe] 缩放后 1.7s mode =', mode(), '（期望 idle），最终宽', window.innerWidth)
    })
    // ⑦ 框线内侧 20px 处（离框线 6 → 26，在 edgeGrabPx=28 内）：也应进缩放
    at(11200, () => {
      log('[probe] ⑦ 框线内侧 20px 处按下（应仍算抓住边框）')
      interact?.enterEdit()
      const w0 = window.innerWidth
      at(11300, () => fire('pointerdown', 26, H() * 0.5))
      at(11360, () => fire('pointermove', 86, H() * 0.5))
      at(11430, () => {
        fire('pointerup', 86, H() * 0.5)
        log('[probe] 内侧抓取后 innerWidth', w0, '→', window.innerWidth, `（期望 ${w0 - 120}，抓左边框往右拖 = 缩小）`)
      })
    })
    // ⑨ 抓上边框「往上」拖：以前 dy 为负 → 越拉越小，现在应该放大
    at(14000, () => {
      interact?.enterEdit()
      const w0 = window.innerWidth
      log('[probe] ⑨ 抓上边框往上拖 60px（期望变大）')
      at(14100, () => fire('pointerdown', W() * 0.5, 6))
      at(14160, () => fire('pointermove', W() * 0.5, -54))
      at(14230, () => {
        fire('pointerup', W() * 0.5, -54)
        log('[probe] 上边框上拉后 innerWidth', w0, '→', window.innerWidth, `（期望 ${w0 + 120}）`)
      })
    })

    // ⑩ 用户报的那个：右键按住不放**穿过整个扫过动画**（松手前已经是 edit + 拖动），
    //    拖一段再松手 → 期望 1s 倒计时正常启动、1.6s 后回到 idle。
    //    旧版这里 editEntryRelease 会把这次松手当成「进入编辑的动作结尾」，
    //    于是倒计时根本不启动，框要等下一次交互。
    at(15400, () => {
      log('[probe] ⑩ 右键长按穿越扫过 → 直接拖 → 松手（期望 1s 后自动退出）')
      fire('pointerdown', W() * 0.5, H() * 0.4, 2)
      at(16500, () => fire('pointermove', W() * 0.5 + 60, H() * 0.4 + 40))
      at(16700, () => fire('pointermove', W() * 0.5 + 80, H() * 0.4 + 50))
      at(16900, () => fire('pointerup', W() * 0.5 + 80, H() * 0.4 + 50, 2))
    })
    at(17600, () => log('[probe] ⑩ 松手后 0.7s mode =', mode(), '（应仍是 edit）'))
    at(18600, () => log('[probe] ⑩ 松手后 1.7s mode =', mode(), '（期望 idle）'))

    // ⑧ 正中间按下：应走「拖动位置」，宽度不能变
    at(12600, () => {
      interact?.enterEdit()
      const w0 = window.innerWidth
      log('[probe] ⑧ 画面正中按下 80px（应移动、不改尺寸）')
      at(12700, () => fire('pointerdown', W() * 0.5, H() * 0.5))
      at(12760, () => fire('pointermove', W() * 0.5 + 80, H() * 0.5))
      at(12830, () => {
        fire('pointerup', W() * 0.5 + 80, H() * 0.5)
        log('[probe] 中心拖动后 innerWidth', w0, '→', window.innerWidth, '（应与前者相同）')
      })
    })
  }

  // 探针：--debug-han 检查「流冷汗」这个表情到底卡在哪一层。
  // 已知：Part79（汗）下有 6 个网格、UV 指向 texture_02 的汗滴区域，但 drawable opacity 全 0。
  // 这里强制把 Part79 的部件不透明度设成 1，看能否在不改 moc3 的前提下把汗放出来。
  if (payload.__debugHan) {
    const core = stage.core
    const P = 'Part79'
    const pi = stage.part.index(P)
    const keyInfo = stage.param.info('key13')
    log('[han] Part79 index', pi, 'partOpacity', pi >= 0 ? core.getPartOpacityByIndex(pi) : '?')
    log('[han] key13', keyInfo ? JSON.stringify(keyInfo) : '模型里不存在')

    const dumpDrawables = (tag) => {
      if (pi < 0) return
      let n = 0
      for (let i = 0; i < core.getDrawableCount(); i++) {
        if (core.getDrawableParentPartIndex(i) !== pi) continue
        n += 1
        const vp = core.getDrawableVertexPositions(i)
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
        for (let k = 0; k < vp.length; k += 2) {
          const x = vp[k], y = vp[k + 1]
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
        log('[han]', tag, '#' + i,
          'op=' + Number(core.getDrawableOpacity(i)).toFixed(3),
          'vtx=' + core.getDrawableVertexCount(i),
          'box=[' + x0.toFixed(0) + ',' + y0.toFixed(0) + ' → ' + x1.toFixed(0) + ',' + y1.toFixed(0) + ']')
      }
      log('[han]', tag, '共', n, '个网格；Part79 opacity =', core.getPartOpacityByIndex(pi))
    }

    dumpDrawables('原始')

    // 列出模型里所有参数（含取值范围），找哪个可能控制「汗」
    log('[han] 参数总数', stage.param.count)
    log('[han] 全部参数:', stage.param.ids.join(' '))
    for (const id of stage.param.ids) {
      if (/sweat|汗|key1[0-9]|key[0-9]/i.test(id)) {
        const inf = stage.param.info(id)
        log('[han] 候选', id, `min=${inf.min} max=${inf.max} def=${inf.default} 当前=${stage.param.get(id)}`)
      }
    }

    // 对照组：随便取几个正常 drawable 看 box，确认「顶点全是 0/1」不是读取时机造成的假象
    const boxOf = (i) => {
      const vp = core.getDrawableVertexPositions(i)
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
      for (let k = 0; k < vp.length; k += 2) {
        const x = vp[k], y = vp[k + 1]
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      return `[${x0.toFixed(0)},${y0.toFixed(0)} → ${x1.toFixed(0)},${y1.toFixed(0)}]`
    }
    for (const i of [0, 1, 2, 100, 300, 500, 700]) {
      if (i < core.getDrawableCount()) {
        log('[han][对照] #' + i, 'part=' + core.getDrawableParentPartIndex(i), 'box=' + boxOf(i))
      }
    }

    // 关键一步：模型里有 SweatBurst1..6（正好 6 个，对应 Part79 的 6 个网格）和 Sweat1/Sweat2，
    // 而作者的 exp3 里写的是 key13 —— 大概率根本没连上。这里逐个试。
    const sweep = ['SweatBurst1', 'SweatBurst2', 'SweatBurst3', 'SweatBurst4', 'SweatBurst5', 'SweatBurst6', 'Sweat1', 'Sweat2']
    log('[han] 开始逐个试 Sweat* 参数')
    stage.onBeforeUpdate(() => {
      for (const id of sweep) stage.param.set(id, 1)
      if (pi >= 0) core.setPartOpacityByIndex(pi, 1)
    })
    setTimeout(() => {
      log('[han] Sweat* 回读 =', sweep.map((id) => id + ':' + Number(stage.param.get(id)).toFixed(2)).join(' '))
      dumpDrawables('Sweat*=1 后')
    }, 1500)
  }


  // 用途：区分「表情写了参数却没画面」的两种根因 ——
  //   (a) 该 Part 下压根没有 drawable（建模漏绑，代码无解）
  //   (b) 有 drawable，但被遮挡 / 全透明 / UV 指到贴图空白处（可在渲染层补救）
  if (payload.__debugDrawables) {
    const core = stage.core
    const txt = (h) => {
      if (h == null) return ''
      if (typeof h === 'string') return h
      const s = typeof h.getString === 'function' ? h.getString() : h
      return typeof s === 'string' ? s : (s && s.s) || ''
    }
    const partCount = core.getPartCount()
    const partIds = []
    for (let i = 0; i < partCount; i++) partIds.push(txt(core.getPartId(i)))
    const n = typeof core.getDrawableCount === 'function' ? core.getDrawableCount() : 0
    log('[draw] drawable 总数', n, '/ part 总数', partCount)

    const rows = []
    for (let i = 0; i < n; i++) {
      const pi = core.getDrawableParentPartIndex(i)
      const uvs = core.getDrawableVertexUvs ? core.getDrawableVertexUvs(i) : []
      let u0 = 9, v0 = 9, u1 = -9, v1 = -9
      for (let k = 0; k < uvs.length; k += 2) {
        const u = uvs[k], v = uvs[k + 1]
        if (u < u0) u0 = u
        if (u > u1) u1 = u
        if (v < v0) v0 = v
        if (v > v1) v1 = v
      }
      rows.push({
        i,
        id: txt(core.getDrawableId ? core.getDrawableId(i) : ''),
        partId: partIds[pi] || ('#' + pi),
        tex: core.getDrawableTextureIndex ? core.getDrawableTextureIndex(i) : -1,
        vtx: core.getDrawableVertexCount ? core.getDrawableVertexCount(i) : -1,
        op: core.getDrawableOpacity ? Number(core.getDrawableOpacity(i)).toFixed(3) : '?',
        uv: uvs.length ? [u0, v0, u1, v1].map((x) => Number(x).toFixed(3)).join(',') : 'no-uv',
      })
    }

    const sweat = rows.filter((r) => /汗|sweat/i.test(r.partId + ' ' + r.id + ' ' + partIds.join(' ')))
    const hitSweat = rows.filter((r) => /汗|sweat/i.test(r.partId + ' ' + r.id))
    log('[draw][汗] 命中 drawable', hitSweat.length, '条')
    for (const r of hitSweat) log('[draw][汗]', JSON.stringify(r))
    log('[draw][汗] 相关 Part：', partIds.filter((p) => /汗|sweat/i.test(p)).join(',') || '（Part 名里没有「汗」）')

    const byPart = new Map()
    for (const r of rows) byPart.set(r.partId, (byPart.get(r.partId) || 0) + 1)
    const emptyParts = partIds.filter((p) => !byPart.has(p))
    log('[draw] 无 drawable 的空壳 Part', emptyParts.length, '个：', emptyParts.join(',') || '无')

    log('[draw] 全部明细（partId | tex | vtx | opacity | uv包围盒）')
    for (const r of rows) log('[draw]', String(r.i).padStart(3), r.partId, '| tex=' + r.tex, '| vtx=' + r.vtx, '| op=' + r.op, '| uv=' + r.uv)
  }


  // 关键点：我们靠「每帧重写激活集合」实现效果，如果引擎不会把参数复位，
  // 那取消激活之后旧值会一直留着，效果就撤不掉。
  if (payload.__debugClear) {
    const name = '加载'
    exprProbe.on = true
    exprProbe.id = (expressions[name] || [])[0]?.id || 'key8'
    setTimeout(() => { activateExpression(name); log('[clear-probe] 已激活', name) }, 500)
    setTimeout(() => { deactivateExpression(name); log('[clear-probe] 已取消激活') }, 3000)
    for (const ms of [1500, 2500, 4000, 6000]) {
      setTimeout(() => {
        log('[clear-probe] t=' + ms + 'ms',
          exprProbe.id + ' 帧末=' + Number(exprProbe.after ?? 0).toFixed(2),
          '集合', exprNames().join('+') || '无')
      }, ms)
    }
  }

  // 探针：--selftest-compose 同时激活几个「参数不重叠」的表达式，确认能叠加。
  // 修复前那套「全局清零」会把另一个一起清掉 —— 表现就是「开了尾巴，切个表情尾巴又出来了」。
  if (payload.__debugCompose) {
    const want = ['加载', '尾巴开关', '体型1']
    exprProbe.on = true
    exprProbe.watch = []
    for (const n of want) {
      const ps = expressions[n]
      if (!ps || !ps.length) continue
      activateExpression(n)
      exprProbe.watch.push({ name: n, id: ps[0].id, want: ps[0].value, got: null })
    }
    log('[compose-probe] 激活', exprNames().join('+'),
      '监视', exprProbe.watch.map((w) => w.id).join(','))
    for (const ms of [500, 3000]) {
      setTimeout(() => {
        log('[compose-probe] t=' + ms + 'ms',
          exprProbe.watch.map((w) => `${w.id}=${Number(w.got ?? 0).toFixed(2)}(要${w.want})`).join(' '))
      }, ms)
    }
  }

  // 探针：--selftest-gaze 时模拟视线左→右，并回读 ParamAngleX。
  // 用来确认角度没有被物理吃回去（数值应随目标变化，而不是恒为 0）。
  if (payload.__debugGaze) {
    probeMode = true
    const probes = [1, -1, 0]
    probes.forEach((v, i) => {
      setTimeout(() => {
        gazeTarget.x = v
        gazeTarget.y = 0.3
      }, 1200 + i * 1600)
      setTimeout(() => {
        log('[gaze-frame] 目标', v,
          '帧内眼珠X', (sample.eyeX ?? 0).toFixed(3),
          '帧内头X', (sample.angleX ?? 0).toFixed(2),
          '帧内头Y', (sample.angleY ?? 0).toFixed(2),
          '帧内身体X', (sample.bodyX ?? 0).toFixed(2),
          '呼吸', (sample.breath ?? 0).toFixed(3),
          '阻尼眼', gazeState.eyeX.toFixed(2),
          '阻尼头', gazeState.headX.toFixed(2))
      }, 2400 + i * 1600)
    })
  }
}

boot().catch((e) => fail(`启动失败：\n${e?.message || e}\n\n${e?.stack || ''}`))
