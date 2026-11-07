// 行为状态机：以「小时」为单位规划桌宠的自发行为（行为状态机.txt）。
//
// 身份区分：这里只安排「舞台」的自发行为（1 档，随机事件层）。
// 「驾驶员」（LLM）和用户交互属于 0 档，由插件 / interact.js 触发，
// 到了渲染层由优先级仲裁（renderer.js 的 claim）自然压制本模块的事件 ——
// 也就是说规划不必精确执行：0 档正在演的时候，这里发的事件会被丢弃，
// 这正是「可被覆盖」想要的形态。
//
// 一小时的规划：
//   · 盯盯（鼠标追踪）：总计 8~24 分钟，拆成若干随机段，每段至少 2 分钟。
//     段内鼠标静止超过 min(3min, 段时长 50%) → 探测前台窗口标题，
//     气泡「[窗口名]是什么？」；开了主动说话再给驾驶员发一条观察。
//   · 东张西望 / 抖尾巴 / 抖动身体：各 4~28 次，随机间隔，互不复用时间点；
//     任意两个小动作之间至少隔 1 秒（发的时候再查一次，双保险）。
//
// 初始状态：鼠标追踪关闭。追踪只在盯盯段内开启，段结束立刻关掉 ——
// 「恢复初始状态」语义（/api/reset）同样以关追踪为初始。

import { execFile } from 'node:child_process'

const TICK_MS = 1000
const HOUR_MS = 60 * 60 * 1000
const SMALL_GAP_MS = 1000

const DEFAULTS = {
  enabled: true,
  // 盯盯总时长区间 / 单段时长区间（毫秒）
  gazeMinMs: 8 * 60 * 1000,
  gazeMaxMs: 24 * 60 * 1000,
  gazeSegMinMs: 2 * 60 * 1000,
  gazeSegMaxMs: 6 * 60 * 1000,
  // 三个小动作每小时各触发多少次（随机取区间内的整数）。
  // 4~28 是行为状态机.txt 的原始计划，实测太密 —— 三个动作叠加最多 84 次/小时，
  // 几乎每分钟都在动。默认收到 2~8（合计 6~24 次/小时），要密可以改 config。
  smallMin: 2,
  smallMax: 8,
  // 盯盯段内鼠标静止多久触发「[窗口]是什么？」
  focusIdleMs: 3 * 60 * 1000,
  smallMotions: ['东张西望', '抖尾巴', '抖动身体'],
}

const rand = (a, b) => a + Math.random() * (b - a)
const randInt = (a, b) => Math.floor(rand(a, b + 1))

/* ---------------------------------------------------- 前台窗口标题（PowerShell） */

// 本机安全策略封了 reg.exe 之类，但 powershell.exe 可用；Add-Type 每次带一份
// 内联源码（不落 .ps1 文件，避免非 ASCII 路径编码坑）。调用频率极低
// （盯盯段内鼠标静止数分钟才一次），1~2s 的启动开销可以接受。
const PS_SCRIPT = [
  'Add-Type -TypeDefinition \'',
  'using System; using System.Runtime.InteropServices; using System.Text;',
  'public class PetFW {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '}',
  "' -Language CSharp;",
  '$sb = New-Object System.Text.StringBuilder 512;',
  '[void][PetFW]::GetWindowText([PetFW]::GetForegroundWindow(), $sb, 512);',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
  '$sb.ToString()',
].join(' ')

// 系统壳进程名不值得一问（「Program Manager」是桌面本身）
const IGNORE_TITLES = new Set(['', 'Program Manager', 'Windows Input Experience', 'NVIDIA GeForce Overlay'])

let psBusy = false
function queryForegroundWindow() {
  return new Promise((resolve) => {
    if (psBusy) return resolve(null)
    psBusy = true
    const done = (v) => { psBusy = false; resolve(v) }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      { timeout: 9000, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return done(null)
        done(String(stdout || '').trim())
      })
  })
}

/* ---------------------------------------------------- 规划 */

/**
 * 生成一小时的盯盯段：总时长落在 [gazeMin, gazeMax]，每段 [segMin, segMax]。
 * 放置方式：把一小时均分成 n 个槽，段在槽内随机偏移 —— 天然不重叠且撒得开。
 */
function planGaze(cfg) {
  const minTotal = Math.min(cfg.gazeMinMs, cfg.gazeMaxMs)
  const maxTotal = Math.max(cfg.gazeMinMs, cfg.gazeMaxMs)
  const total = rand(minTotal, maxTotal)
  const segMin = Math.min(cfg.gazeSegMinMs, cfg.gazeSegMaxMs)
  const segMax = Math.max(cfg.gazeSegMinMs, cfg.gazeSegMaxMs)

  const segs = []
  let acc = 0
  while (acc < total && segs.length < 8) {
    const len = Math.min(rand(segMin, segMax), total - acc)
    if (len < segMin * 0.6) break
    segs.push(len)
    acc += len
  }
  // 凑不够总量就把每段等比拉长（上限放到 1.5 倍段长）——总时长优先级更高
  if (acc < total && segs.length) {
    const k = Math.min(1.5 * segMax / segMax, total / acc)
    for (let i = 0; i < segs.length; i += 1) segs[i] = Math.min(segs[i] * k, segMax * 1.5)
  }

  const slot = HOUR_MS / segs.length
  return segs.map((len) => ({ len, at: rand(0, slot - len) }))
}

/** 一个小动作的随机时刻表：4~28 次，均匀撒进一小时后排序 */
function planSmall(cfg, name) {
  const n = randInt(Math.min(cfg.smallMin, cfg.smallMax), Math.max(cfg.smallMin, cfg.smallMax))
  const times = []
  for (let i = 0; i < n; i += 1) times.push(rand(0, HOUR_MS - 8000))
  times.sort((a, b) => a - b)
  return times.map((at) => ({ at, name }))
}

/**
 * 从人设卡的行为规划里挑一条 idleAction。
 *
 * 权重 + 时段决定「现在这个点她该干什么」：深夜才打瞌睡、上午才戴单片眼镜，
 * 不是全天均匀随机 —— 这是「有生命力」和「随机乱动」的区别。
 * @param {Array} actions persona.behavior.idleActions
 * @param {number} hour 0-23
 */
function pickIdle(actions, hour) {
  const pool = actions.filter((a) => {
    if (!a || a.enabled === false) return false
    const hours = Array.isArray(a.hours) ? a.hours : []
    return hours.length === 0 || hours.includes(hour)
  })
  if (!pool.length) return null
  const total = pool.reduce((s, a) => s + Math.max(0.1, Number(a.weight) || 1), 0)
  let r = Math.random() * total
  for (const a of pool) {
    r -= Math.max(0.1, Number(a.weight) || 1)
    if (r <= 0) return a
  }
  return pool[pool.length - 1]
}

/* ---------------------------------------------------- 状态机主体 */

export function createBehavior(o = {}) {
  const cfg = { ...DEFAULTS, ...(o.config && typeof o.config === 'object' ? o.config : {}) }
  if (cfg.enabled === false) {
    o.log?.('已关闭（config.behavior.enabled=false）')
    return { start() {}, stop() {}, get plan() { return null } }
  }

  const log = o.log || (() => {})
  // 人设行为卡的动作池（behavior.json 的 idleActions）。有它就按「权重+时段」抽，
  // 没有才退回 config.behavior.smallMotions 的固定名单。
  const idleActions = (o.persona && Array.isArray(o.persona.idleActions)) ? o.persona.idleActions : []
  // 逐条事件的调试日志（v0.4.1）。默认开：一小时的规划本来就只有几十条，
  // 出问题时「到底有没有按时发、发的是哪一条、被谁挡了」必须能从日志里读出来 ——
  // 没有这些行，桌宠「一直不动」和「动作被更高的档位顶掉」在外部长得一模一样。
  // config.behavior.debug = false 可关掉逐条，只留规划与告警。
  const dlog = cfg.debug === false ? () => {} : log
  // send：发渲染层事件（pet:action 通道）。sendDriver：发给驾驶员（main 里做频率门控）
  const send = o.send || (() => {})
  const sendDriver = o.sendDriver || (() => {})
  const getCursorIdleMs = o.getCursorIdleMs || (() => 0)
  const getSettings = o.getSettings || (() => ({ proactive: false, freq: 'low' }))

  let timer = 0
  let hourStart = 0
  let gazeSegs = []        // [{ at, len, fired }]
  let smallEvents = []     // [{ at, name }]
  let gazeIdx = 0
  let smallIdx = 0
  let tracking = false
  let lastSmallAt = 0
  let segment = null       // 当前盯盯段 { len, startAt, focusFired }
  // 调试统计：这一小时到底触发了几次（日志里能对账，不用翻历史行）
  const stat = { small: 0, smallSkipped: 0, gaze: 0, focus: 0, focusMiss: 0 }
  let lastBeatAt = 0

  function buildPlan() {
    hourStart = Date.now()
    lastBeatAt = hourStart
    stat.small = 0; stat.smallSkipped = 0; stat.gaze = 0; stat.focus = 0; stat.focusMiss = 0
    gazeSegs = planGaze(cfg).map((s) => ({ ...s, fired: false }))
    smallIdx = 0
    gazeIdx = 0
    if (idleActions.length) {
      // 人设卡模式：只排「时刻」，具体做哪一条在触发那一刻按权重+时段抽
      // —— 这样一小时跨过整点也不会拿错时段的动作。
      // 密度特意给高（18~34 次/小时，约 2~3 分钟一次）：用户反馈「不要长时间
      // 保持一个动作」，渲染层 claim 会按优先级挡掉冲突的，宁多勿僵。
      const n = randInt(18, 34)
      const times = []
      for (let i = 0; i < n; i += 1) times.push(rand(0, HOUR_MS - 8000))
      times.sort((a, b) => a - b)
      smallEvents = times.map((at) => {
        const hour = new Date(hourStart + at).getHours()
        return { at, idle: pickIdle(idleActions, hour), hour }
      }).filter((e) => e.idle)
    } else {
      // 老模式：config.behavior.smallMotions 固定几个动作各自排表
      smallEvents = (cfg.smallMotions || [])
        .flatMap((name) => planSmall(cfg, name))
        .sort((a, b) => a.at - b.at)
    }
    const totalSeg = Math.round(gazeSegs.reduce((s, x) => s + x.len, 0) / 1000)
    log(`新规划：盯盯 ${gazeSegs.length} 段 / 共 ${totalSeg}s，`
      + `小动作 ${smallEvents.length} 次`
      + (idleActions.length ? `（人设卡 ${idleActions.length} 条动作池）` : ''))
    if (cfg.debug !== false) {
      log('  盯盯时间表：' + gazeSegs
        .map((s, i) => `#${i + 1} ${Math.round(s.at / 1000)}s+${Math.round(s.len / 1000)}s`)
        .join(' | '))
      log('  小动作时间表：' + smallEvents.slice(0, 12)
        .map((e) => `${Math.round(e.at / 1000)}s ${e.idle ? idleLabel(e.idle) : e.name}`).join(' | ')
        + (smallEvents.length > 12 ? ` …共 ${smallEvents.length} 次` : ''))
    }
  }

  /** 日志里怎么称呼这条 idleAction */
  function idleLabel(a) {
    const act = a.action || {}
    return `${a.id || '?'}(${act.kind || '?'}:${act.name || act.cue || '?'})`
  }

  /** idleAction → 渲染层事件（动作 / 姿势 / 原生动画 / cue 串 / 表情） */
  function idleEvents(a) {
    const act = a.action || {}
    const out = []
    if (act.kind === 'motion' && act.name) out.push({ kind: 'motion', name: act.name, prio: 1 })
    else if (act.kind === 'animation' && act.name) out.push({ kind: 'motion', animation: act.name, prio: 1 })
    else if (act.kind === 'pose' && act.name) out.push({ kind: 'pose', name: act.name, prio: 1 })
    else if (act.kind === 'cue' && act.cue) out.push({ kind: 'cue', cue: act.cue, prio: 1 })
    else if (act.kind === 'expression' && act.name) out.push({ kind: 'expression', name: act.name, prio: 1 })
    if (a.say) {
      const lines = Array.isArray(a.say) ? a.say : [a.say]
      const text = lines[Math.floor(Math.random() * lines.length)]
      if (text) out.push({ kind: 'say', text: String(text), ms: Number(a.bubbleMs) || 2400, prio: 1 })
    }
    return out
  }

  function stopTracking(reason) {
    if (!tracking) return
    tracking = false
    send({ kind: 'tracking', on: false, prio: 1 })
    log('盯盯结束（' + reason + '），追踪关闭')
  }

  async function focusProbe(segLenMs) {
    const title = await queryForegroundWindow()
    if (!title) {
      stat.focusMiss += 1
      log('焦点探测：没拿到窗口标题（PowerShell 失败/超时，或前台是系统壳）')
      return
    }
    if (IGNORE_TITLES.has(title)) {
      stat.focusMiss += 1
      dlog('焦点探测：忽略系统窗口「' + title + '」')
      return
    }
    stat.focus += 1
    // 标题太长塞不进气泡：取前 24 个字符
    const short = Array.from(title).slice(0, 24).join('')
    send({ kind: 'say', text: `${short}是什么？`, ms: 3200, prio: 1 })
    const s = getSettings()
    if (s.proactive) {
      sendDriver({
        kind: 'observe',
        text: `用户正在使用「${short}」，也许可以说点什么或做点什么。`,
        state: null,   // main 侧补当前舞台状态
      })
    }
    log('焦点窗口：', short, s.proactive ? '（已上报驾驶员）' : '（主动说话关着，只冒气泡）')
  }

  function tick() {
    const now = Date.now()
    if (now - hourStart >= HOUR_MS) buildPlan()

    const t = now - hourStart

    // ---- 盯盯段 ----
    while (gazeIdx < gazeSegs.length && t >= gazeSegs[gazeIdx].at + gazeSegs[gazeIdx].len) {
      if (segment && segment.idx === gazeIdx) {
        segment = null
        stopTracking('到点')
      }
      gazeIdx += 1
    }
    if (gazeIdx < gazeSegs.length && !segment && t >= gazeSegs[gazeIdx].at) {
      segment = { idx: gazeIdx, len: gazeSegs[gazeIdx].len, startAt: now, focusFired: false }
      tracking = true
      stat.gaze += 1
      send({ kind: 'tracking', on: true, prio: 1 })
      log(`盯盯开始（第 ${gazeIdx + 1}/${gazeSegs.length} 段，${Math.round(segment.len / 1000)}s，`
        + `时刻 ${Math.round(t / 1000)}s）`)
    }
    if (segment && tracking) {
      const idle = getCursorIdleMs()
      const threshold = Math.min(cfg.focusIdleMs, segment.len * 0.5)
      if (!segment.focusFired && idle >= threshold) {
        segment.focusFired = true
        dlog(`盯盯段内鼠标静止 ${Math.round(idle / 1000)}s ≥ ${Math.round(threshold / 1000)}s → 探测前台窗口`)
        focusProbe(segment.len)
      }
    }

    // ---- 小动作 ----
    while (smallIdx < smallEvents.length && t >= smallEvents[smallIdx].at) {
      const ev = smallEvents[smallIdx]
      smallIdx += 1
      // 1 秒间隔双保险：渲染层 claim 还会按优先级再挡一次，这里只管节奏
      if (now - lastSmallAt < SMALL_GAP_MS) {
        stat.smallSkipped += 1
        dlog(`[small] 跳过 ${ev.idle ? idleLabel(ev.idle) : ev.name}：距上一个动作只有 ${now - lastSmallAt}ms（< ${SMALL_GAP_MS}ms）`)
        continue
      }
      lastSmallAt = now
      stat.small += 1
      if (ev.idle) {
        // 人设卡条目：一条可能带多个事件（动作 + 台词），全部发出去
        const events = idleEvents(ev.idle)
        dlog(`[small] 触发 ${idleLabel(ev.idle)}（第 ${smallIdx}/${smallEvents.length} 次，时刻 ${Math.round(t / 1000)}s）`)
        for (const e of events) send(e)
      } else {
        dlog(`[small] 触发 ${ev.name}（第 ${smallIdx}/${smallEvents.length} 次，时刻 ${Math.round(t / 1000)}s）`)
        send({ kind: 'motion', name: ev.name, prio: 1 })
      }
    }

    // ---- 心跳：每 10 分钟一行，证明状态机还活着、这一小时跑到哪儿了 ----
    if (now - lastBeatAt >= 10 * 60 * 1000) {
      lastBeatAt = now
      log(`[tick] 运行 ${Math.round(t / 1000)}s｜小动作 ${stat.small}/${smallEvents.length}`
        + `（跳过 ${stat.smallSkipped}）｜盯盯段 ${stat.gaze}/${gazeSegs.length}`
        + `（${tracking ? '进行中' : '空闲'}）｜焦点探测 ${stat.focus} 次，失败 ${stat.focusMiss} 次`)
    }
  }

  function start() {
    buildPlan()
    timer = setInterval(tick, TICK_MS)
    if (timer.unref) timer.unref()
    log(`状态机启动（初始待机：追踪关）`)
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = 0
    stopTracking('状态机停止')
  }

  return {
    start, stop,
    /** 当前是否在盯盯（设置页/诊断用） */
    get tracking() { return tracking },
    get plan() { return { gazeSegs, smallCount: smallEvents.length, hourStart } },
  }
}
