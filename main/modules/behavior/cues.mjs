/**
 * 动作语法层（cue）—— 她在说的话里用〔〕插动作。
 *
 * 设计来源：参考实现 WHALEL2D 的 Body.cs（owner 逐条试过词表），这里把词表
 * 重新映射到**本模型**的参数 id 上（那套用 VTube 虚拟名，我们直接写模型参数）。
 *
 * 四类词：
 *   channel（保持）同一个通道后来者覆盖，多个通道在同一参数上相加
 *   overlay（表情开关）对应 Exp3 里的表情，可叠加
 *   hand（成对原生动画）抚胸 / 竖手指 / 狗尾草 / 放下手 —— 只有动画能驱动手臂链
 *   move（一次性关键帧）点头、叹气、吓一跳…… 增量写法，起止归零，天然可叠加
 *
 * 语法：
 *   〔歪头〕〔歪头:左〕〔点头×3〕〔微前倾〕〔快摇头〕〔-脸红〕〔恢复〕
 *   〔动作:伸懒腰〕〔预设:害羞〕← 引用动作库 / 演出预设
 *   同一括号里用空格/、/，分隔多个词
 *
 * 语气联动（照抄参考实现的调参）：后文带「！」动作大 1.2×、快 0.85×；
 * 带「……」小 0.85×、慢 1.25×。语速联动：pace = clamp(后文朗读时长/动作原长, 0.7, 1.6)。
 */

/* ---------------------------------------------------------------- 词表 */

const S = (where) => (where === '右' ? -1 : 1)

/** 关键帧串 "0:0 .17:-10 .4:1 .54:0" → [[t,v],…]（t 秒 → 归一化由调用方做） */
function keys(str) {
  return str.trim().split(/\s+/).map((k) => {
    const [t, v] = k.split(':')
    return [Number(t), Number(v)]
  })
}

const scaleKeys = (list, by) => list.map(([t, v]) => [t, v * by])
const paceKeys = (list, by) => list.map(([t, v]) => [t * by, v])
const endOf = (list) => list.reduce((m, [t]) => Math.max(m, t), 0)

/** 同一个动作重复 n 次：每次下去再回来，最后一次停一小会儿 */
function repeat(times, each, down, back, downV, backV, rest) {
  const out = [[0, 0]]
  let at = 0
  for (let i = 0; i < times; i += 1) {
    out.push([at + down, downV], [at + back, backV])
    at += each
  }
  out.push([at + rest, 0])
  return out
}

/**
 * 词表。每项返回：
 *   channel  保持通道名（同通道后来者覆盖）
 *   hold     该通道写哪些参数（缺省值 0）
 *   overlay  Exp3 表情名
 *   hand     'chest' | 'finger' | 'grass' | 'down'
 *   move     一次性关键帧 { 参数: [[秒, 增量], …] }
 *   clear    要清掉的通道
 *   reset    整体复位
 */
const WORDS = {
  /* ---- 视线 ----
   *
   * 本模型（大肥鱼）**头部没有可驱动的旋转骨骼**：2026-11-05 实测
   *   ParamAngleX/Y/Z = ±30 → 画面纹丝不动（眼球有效、头部无效）
   *   AngleX/Y/Z      = ±30 → 同上
   *   ParamBodyAngleZ = 12  → 整体倾斜，肉眼非常明显 ← 只有身体级参数真的动
   * 所以「歪头 / 转头 / 点头 / 摇头」统一改走 ParamBodyAngle*（整体倾斜/前后微动），
   * 幅度按身体尺度重给。宁可看起来像「歪身」，也别一动不动。
   */
  看左: () => ({ channel: 'gaze', hold: { ParamEyeBallX: -0.75, ParamBodyAngleX: -4 } }),
  看右: () => ({ channel: 'gaze', hold: { ParamEyeBallX: 0.75, ParamBodyAngleX: 4 } }),
  看上: () => ({ channel: 'gaze', hold: { ParamEyeBallY: 0.6, ParamBodyAngleY: 2.5 } }),
  看下: () => ({ channel: 'gaze', hold: { ParamEyeBallY: -0.6, ParamBodyAngleY: -3.5 } }),
  看你: () => ({ clear: ['gaze'] }),
  正视: () => ({ clear: ['gaze', 'tilt', 'turn', 'pitch'] }),

  /* ---- 头 / 身体 ---- */
  歪头: (w, s) => ({ channel: 'tilt', hold: { ParamBodyAngleZ: 9 * s * S(w) } }),
  转头: (w, s) => ({ channel: 'turn', hold: { ParamBodyAngleX: 10 * s * S(w) } }),
  低头: (_w, s) => ({ channel: 'pitch', hold: { ParamBodyAngleY: -6 * s } }),
  抬头: (_w, s) => ({ channel: 'pitch', hold: { ParamBodyAngleY: 5 * s } }),
  前倾: (_w, s) => ({ channel: 'lean', hold: { LeanInput: -14 * s } }),
  后仰: (_w, s) => ({ channel: 'lean', hold: { LeanInput: 9 * s } }),
  站直: () => ({ clear: ['lean'] }),

  /* ---- 眼 ---- */
  // 睁大：模型参数上限就是 1，再大没用；靠挑眉一起给「睁大」的观感
  睁大: () => ({ channel: 'eyes', hold: { ParamEyeLOpen: 1, ParamEyeROpen: 1, BrowInnerUp: 0.35 } }),
  半睁: (_w, s) => ({ channel: 'eyes', hold: { ParamEyeLOpen: 1 - 0.55 * s, ParamEyeROpen: 1 - 0.55 * s } }),
  闭眼: () => ({ channel: 'eyes', hold: { ParamEyeLOpen: 0, ParamEyeROpen: 0 } }),
  眯眼笑: () => ({ channel: 'eyes', hold: { ParamEyeLOpen: 0, ParamEyeROpen: 0, EyeSmile: 1 } }),
  笑眼: () => ({ channel: 'eyes', hold: { ParamEyeLOpen: 0.45, ParamEyeROpen: 0.45, EyeSmile: 1 } }),
  斜眼: (_w, s) => ({ channel: 'eyes', hold: { REyeSquint: 0.9 * s, LEyeSquint: 0.9 * s, ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7 } }),
  眨单眼: () => ({ channel: 'eyes', hold: { ParamEyeLOpen: 0, EyeSmile: 1 } }),

  /* ---- 眉 ---- */
  挑眉: (_w, s) => ({ channel: 'brows', hold: { ParamBrowLY: 0.6 * s, ParamBrowRY: 0.6 * s, BrowInnerUp: 0.4 * s } }),
  皱眉: (_w, s) => ({ channel: 'brows', hold: { ParamBrowLY: -0.8 * s, ParamBrowRY: -0.8 * s, ParamBrowLAngle: -s, ParamBrowRAngle: -s } }),
  八字眉: (_w, s) => ({ channel: 'brows', hold: { BrowInnerUp: s, ParamBrowLAngle: 0.6 * s, ParamBrowRAngle: 0.6 * s } }),

  /* ---- 嘴 ---- */
  微笑: (_w, s) => ({ channel: 'mouth', hold: { ParamMouthForm: s } }),
  大笑: (_w, s) => ({ channel: 'mouth', hold: { ParamMouthForm: 1, ParamMouthOpenY: 0.6 * s, JawOpen: 0.3 * s } }),
  坏笑: (w, s) => ({ channel: 'mouth', hold: { ParamMouthForm: 1, MouthX: 0.6 * s * S(w) } }),
  瘪嘴: (_w, s) => ({ channel: 'mouth', hold: { ParamMouthForm: -s } }),
  张嘴: (_w, s) => ({ channel: 'mouth', hold: { ParamMouthOpenY: 0.7 * s, JawOpen: 0.4 * s, MouthFunnel: 0.3 } }),
  嘟嘴: () => ({ channel: 'mouth', hold: { MouthFunnel: 0.7, Mouthpucker: 1, ParamMouthForm: -0.4 } }),
  鼓腮: () => ({ channel: 'mouth', hold: { CheeckPuff: 1 } }),
  抿嘴: () => ({ channel: 'mouth', hold: { MouthPressLipOpen: -1, ParamMouthForm: -0.5 } }),
  吐舌: () => ({ channel: 'mouth', hold: { TongueOut: 1, ParamMouthOpenY: 0.35 } }),

  /* ---- 表情（Exp3） ---- */
  脸红: () => ({ overlay: '脸红' }),
  黑脸: () => ({ overlay: '黑脸' }),
  冷汗: () => ({ overlay: '流冷汗' }),
  眼泪: () => ({ overlay: '流泪' }),
  爱心眼: () => ({ overlay: '爱心眼' }),
  圈圈眼: () => ({ overlay: '圈圈眼' }),
  '＞＜': () => ({ overlay: '＞＜' }),
  屑屑眼: () => ({ overlay: '屑屑眼' }),

  /* ---- 道具（Exp3） ---- */
  钢盆: () => ({ overlay: '钢盆' }),
  单片眼镜: () => ({ overlay: '单片眼镜' }),
  黑框眼镜: () => ({ overlay: '黑框眼镜' }),
  尾巴: () => ({ overlay: '尾巴开关' }),
  裙子: () => ({ overlay: '裙子切换' }),

  /* ---- 手（成对原生动画；只有动画能驱动手臂链） ---- */
  抚胸: () => ({ hand: 'chest' }),
  竖手指: () => ({ hand: 'finger' }),
  狗尾草: () => ({ hand: 'grass' }),
  放下手: () => ({ hand: 'down' }),

  /* ---- 一次性小动作 ---- */
  点头: (_w, s, n) => ({ move: { ParamBodyAngleY: scaleKeys(repeat(n || 2, 0.46, 0.17, 0.4, -6, 1, 0.14), s) } }),
  摇头: (_w, s, n) => ({ move: { ParamBodyAngleX: scaleKeys(repeat(n || 2, 0.56, 0.17, 0.45, -7, 7, 0.22), s) } }),
  眨眼: (_w, _s, n) => ({ move: { ParamEyeLOpen: repeat(n || 1, 0.22, 0.07, 0.16, -1, 0, 0), ParamEyeROpen: repeat(n || 1, 0.22, 0.07, 0.16, -1, 0, 0) } }),
  瞟一眼: (w, s) => (w === '上' || w === '下'
    ? { move: { ParamEyeBallY: scaleKeys(keys('0:0 .12:.7 .55:.7 .8:0'), s * (w === '上' ? 1 : -1)) } }
    : { move: { ParamEyeBallX: scaleKeys(keys('0:0 .12:.85 .55:.85 .8:0'), s * S(w)) } }),
  挑一下眉: (_w, s) => ({
    move: {
      ParamBrowLY: scaleKeys(keys('0:0 .1:.7 .45:.7 .7:0'), s),
      ParamBrowRY: scaleKeys(keys('0:0 .1:.7 .45:.7 .7:0'), s),
      BrowInnerUp: scaleKeys(keys('0:0 .1:.5 .45:.5 .7:0'), s),
    },
  }),
  歪一下头: (w, s) => ({ move: { ParamBodyAngleZ: scaleKeys(keys('0:0 .2:9 .6:9 .9:0'), s * S(w)) } }),
  晃头: (_w, s) => ({ move: { ParamBodyAngleZ: scaleKeys(keys('0:0 .3:-7 .7:7 1.1:-5 1.5:4 2:0'), s) } }),
  // 缩一下：本模型没有 ViewSquash，用「低头 + 收肩」代替「整身压扁」
  缩一下: (_w, s) => ({ move: { ParamBodyAngleY: scaleKeys(keys('0:0 .08:-5 .6:0'), s), ShoulderY: scaleKeys(keys('0:0 .1:-1 .5:0'), s) } }),
  抖一下: (_w, s) => ({ move: { ParamBodyAngleZ: scaleKeys(keys('0:0 .08:4 .2:-3 .32:3 .45:0'), s) } }),
  叹气: () => ({
    move: {
      LeanInput: keys('0:0 .8:5 1.8:-7 2.8:-6 3.5:0'),
      ParamBodyAngleY: keys('0:0 .8:4 1.8:-6 2.8:-5 3.5:0'),
      ParamEyeLOpen: keys('0:0 .8:-.2 1.8:-.6 2.8:-.55 3.5:0'),
      ParamEyeROpen: keys('0:0 .8:-.2 1.8:-.6 2.8:-.55 3.5:0'),
      MouthFunnel: keys('0:0 1.1:0 1.4:.9 2.2:.6 2.6:0'),
      ParamMouthOpenY: keys('0:0 1.1:0 1.4:.3 2.2:.12 2.6:0'),
    },
  }),
  吓一跳: (_w, s) => ({
    move: {
      // 本模型没有 ViewY（离地），用「抬头 + 睁大 + 挑眉」的惊起感代替
      ParamBodyAngleY: scaleKeys(keys('0:0 .06:-5 .2:3 .4:0'), s),
      ParamEyeLOpen: scaleKeys(keys('0:0 .08:.35 .8:.3 1.2:0'), s),
      ParamEyeROpen: scaleKeys(keys('0:0 .08:.35 .8:.3 1.2:0'), s),
      BrowInnerUp: scaleKeys(keys('0:0 .08:.9 1:.6 1.4:0'), s),
    },
  }),

  /* ---- 复位 ---- */
  恢复: () => ({ reset: true }),
}

/** 不用等身体的动作（照参考实现：这些是反射，按自己的速度走） */
const REFLEX = new Set(['吓一跳', '眨眼', '缩一下', '抖一下'])

const BEAT = 0.35        // 一般动作：说完这句等 0.35s 再往下
const HAND_BEAT = 0.7    // 抬手/放手：等它起手
const STARTLE_BEAT = 0.45
const LONGEST_WAIT = 2.4

/* ---------------------------------------------------------------- 解析 */

/** 括号里的 cue 串 → token 列表（含加减号、次数、方向、修饰前缀） */
export function parseCue(cue) {
  const out = []
  for (const raw of String(cue || '').split(/[\s　、，,]+/)) {
    if (!raw) continue
    let token = raw
    let undo = false
    if (token[0] === '-' || token[0] === '－') { undo = true; token = token.slice(1) }
    let action = null
    const colon = token.match(/^(动作|预设)[:：](.+)$/)
    if (colon) { action = { kind: colon[1], name: colon[2].trim() }; out.push({ undo, action }); continue }
    // ×N / xN / *N
    let count = null
    const star = token.match(/^(.+?)[×xX*](\d+)$/)
    if (star) { token = star[1]; count = Number(star[2]) }
    // 方向
    let where = null
    const dir = token.match(/^(.+?)[:：](.+)$/)
    if (dir) { token = dir[1]; where = dir[2].trim() }
    // 微 / 大 / 快 / 慢 前缀（词表里本来就有的词（如 大笑）不算前缀）
    let size = null
    let speed = null
    while (token.length > 1 && !WORDS[token] && '微大快慢'.includes(token[0])) {
      const p = token[0]
      if (p === '微') size = 0.5
      else if (p === '大') size = 1.4
      else if (p === '快') speed = 0.65
      else speed = 1.7
      token = token.slice(1)
    }
    out.push({ undo, name: token, where, count, size, speed, action: null })
  }
  return out
}

/** 模型支持的全部 cue 词（给工具描述与设置页用） */
export function listCueWords() {
  const out = []
  for (const [name, make] of Object.entries(WORDS)) {
    const w = make(null, 1, null)
    const kind = w.overlay ? '表情' : w.hand ? '手' : w.move ? '小动作'
      : w.reset ? '复位' : w.clear ? '复位通道' : '保持'
    out.push({ name, kind })
  }
  return out
}

/* ---------------------------------------------------------------- 朗读节奏 */

const DOTS = 0.25
const PAUSE = 0.12
const STOPS = '，。！？、,!?;；：:~～—'
const PER_CHAR = 1 / 9        // 9 字/秒

/**
 * 把一段话拆成「说多久 + 什么时候插动作」。
 * 时间轴和气泡无关：气泡整段显示，动作按「这句话念到那儿」的时刻落点。
 * @returns {{ plain: string, cues: {at:number, cue:string, spoken:number, tone:string}[], ms:number }}
 */
export function planSpeech(text) {
  const src = String(text || '')
  const plain = []
  const cues = []
  let at = 0
  let i = 0
  const pushText = (seg) => {
    for (const ch of seg) {
      plain.push(ch)
      if (/\s/.test(ch)) continue
      if (ch === '…' || ch === '⋯') at += DOTS
      else if (STOPS.includes(ch)) at += PAUSE
      else at += PER_CHAR
    }
  }
  const re = /〔([^〔〕]*)〕/g
  let last = 0
  let m
  while ((m = re.exec(src))) {
    if (m.index > last) pushText(src.slice(last, m.index))
    // 这一段动作之后还有多少字要念 → 语速联动；以及语气（！/……）
    const after = src.slice(m.index + m[0].length)
    const nextCue = after.search(/〔[^〔〕]*〕/)
    const words = nextCue >= 0 ? after.slice(0, nextCue) : after
    let spoken = 0
    for (const ch of words) {
      if (/\s/.test(ch)) continue
      if (ch === '…' || ch === '⋯') spoken += DOTS
      else if (STOPS.includes(ch)) spoken += PAUSE
      else spoken += PER_CHAR
    }
    const tone = /[！!]/.test(words) ? '！' : /[….⋯]\s*$/.test(words.trimEnd()) ? '…' : ''
    cues.push({ at, cue: m[1], spoken, tone })
    last = m.index + m[0].length
  }
  if (last < src.length) pushText(src.slice(last))
  return { plain: plain.join(''), cues, ms: Math.round(at * 1000) }
}

/** 一段话里有没有动作标记 */
export const hasCue = (text) => /〔[^〔〕]*〕/.test(String(text || ''))
/** 去掉动作标记，只留要说的话（气泡 / 气泡标题用） */
export const stripCue = (text) => String(text || '').replace(/〔[^〔〕]*〕/g, '')
/** 这个词表里有没有这个词（act 用名字直接调动作时要判） */
export const hasCueWord = (name) => Object.prototype.hasOwnProperty.call(WORDS, String(name || ''))

/* ---------------------------------------------------------------- 播放器 */

/**
 * 造一个 cue 播放器。
 * @param {object} h 钩子：expression(name,on) / hand(kind) / motion(tracks,ms) /
 *                   action(name) / preset(name) / log(msg)
 */
export function createCueEngine(h) {
  const channels = new Map()     // 通道 → { 参数: 值 }
  const overlays = new Set()     // 亮着的表情
  let handNow = null             // 'chest' | 'finger' | 'grass'
  const log = h.log || (() => {})

  /** 多个通道对同一参数相加（和参考实现一致：斜着看 + 转头会看更多） */
  function params() {
    const total = {}
    for (const hold of channels.values()) {
      for (const [id, v] of Object.entries(hold)) total[id] = (total[id] || 0) + v
    }
    // 屑屑眼自带嘴型：别让其它嘴部通道把它盖掉（舌头会飘到脸外）
    if (overlays.has('屑屑眼')) {
      for (const id of ['ParamMouthForm', 'ParamMouthOpenY', 'MouthX', 'MouthFunnel', 'Mouthpucker', 'TongueOut', 'JawOpen', 'CheeckPuff', 'MouthPressLipOpen']) {
        delete total[id]
      }
    }
    return total
  }

  function putHandDown() {
    if (!handNow) return
    const back = { chest: '举手切默认手', finger: '竖手指切回默认', grass: '狗尾草切回默认手' }[handNow]
    const kind = handNow
    handNow = null
    try { h.pose?.('default') } catch { /* 没这个钩子 */ }
    if (back) { try { h.anim?.(back) } catch { /* 同上 */ } }
    log('[cue] 放下手（' + kind + '）')
  }

  /**
   * 演一个 cue 串。返回「说完这句要等多久」（秒）。
   * @param {{spoken?:number, tone?:string}} opt spoken=后面还有多少秒的字要念
   */
  function apply(cue, opt = {}) {
    let wait = 0
    const tone = opt.tone || ''
    const spoken = Number(opt.spoken) || 0
    const toneSize = tone === '！' ? 1.2 : tone === '…' ? 0.85 : 1
    const toneSpeed = tone === '！' ? 0.85 : tone === '…' ? 1.25 : 1

    for (const tk of parseCue(cue)) {
      // 撤销：-脸红 / -钢盆 / -歪头
      if (tk.undo) {
        if (tk.action) { log('[cue] 不支持撤销引用：' + tk.action.kind); continue }
        const w = WORDS[tk.name]?.(tk.where, 1, null)
        if (!w) { log('[cue] 没有这个词：' + tk.name); continue }
        if (w.overlay && overlays.delete(w.overlay)) h.expression?.(w.overlay, false)
        if (w.channel) channels.delete(w.channel)
        if (w.hand && handNow) putHandDown()
        continue
      }
      // 引用：〔动作:伸懒腰〕〔预设:害羞〕
      if (tk.action) {
        if (tk.action.kind === '动作') { try { h.action?.(tk.action.name) } catch { /* 忽略 */ } } else { try { h.preset?.(tk.action.name) } catch { /* 忽略 */ } }
        wait = Math.max(wait, BEAT)
        continue
      }
      const make = WORDS[tk.name]
      if (!make) { log('[cue] 没有这个词：' + tk.name); continue }
      const reflex = REFLEX.has(tk.name)
      let word = make(tk.where, tk.size ?? 1, tk.count)
      // 没写幅度时，跟着语气走（！更大、……更小）
      if (word.move && tk.size == null && !reflex) word = make(tk.where, toneSize, tk.count)
      let move = word.move ? { ...word.move } : null
      if (move && !reflex) {
        const length = Math.max(...Object.values(move).map(endOf))
        const pace = Math.min(1.8, Math.max(0.6,
          tk.speed ?? toneSpeed * (spoken > 0 ? Math.min(1.6, Math.max(0.7, spoken / length)) : 1)))
        if (pace !== 1) {
          for (const id of Object.keys(move)) move[id] = paceKeys(move[id], pace)
        }
      } else if (move && tk.speed) {
        for (const id of Object.keys(move)) move[id] = paceKeys(move[id], tk.speed)
      }
      const moving = move ? Math.max(...Object.values(move).map(endOf)) : 0

      // 等待：说话时只等「起手」，没话说了就等整套演完
      wait = Math.max(wait, spoken <= 0
        ? Math.max(0.8, moving, word.hand ? 1.1 : 0)
        : tk.name === '吓一跳' ? STARTLE_BEAT : word.hand ? HAND_BEAT : BEAT)

      if (word.reset) relax()
      for (const c of word.clear || []) channels.delete(c)
      if (word.channel && word.hold) channels.set(word.channel, word.hold)
      if (word.overlay && !overlays.has(word.overlay)) {
        overlays.add(word.overlay)
        h.expression?.(word.overlay, true)
      }
      if (word.hand === 'down') { putHandDown(); continue }
      if (word.hand && handNow !== word.hand) {
        putHandDown()
        handNow = word.hand
        try { h.hand?.(word.hand) } catch { /* 忽略 */ }
      }
      if (move) {
        // 关键帧是「秒」，舞台要毫秒 + 归一化 t
        const ms = Math.max(160, Math.round(moving * 1000))
        const tracks = {}
        for (const [id, list] of Object.entries(move)) {
          tracks[id] = list.map(([t, v]) => [Math.min(1, t / (moving || 1)), v])
        }
        try { h.motion?.(tracks, ms) } catch { /* 忽略 */ }
      }
    }
    return Math.min(wait, LONGEST_WAIT)
  }

  /** 回到「什么都没说」的样子。只撤她自己的：体型、用户给她换的衣服都留着 */
  function relax() {
    channels.clear()
    for (const name of overlays) h.expression?.(name, false)
    overlays.clear()
    putHandDown()
  }

  /**
   * 外部把表情栈整个清空之后，把本地记账对齐。
   *
   * restoreStage / resetToInitial 会 clearExpressions()，但这里还记着「脸红亮着」，
   * 于是之后再〔脸红〕会被 `overlays.has` 挡掉、再也不亮 —— 表现是「说第二遍没反应」。
   */
  function resync(names) {
    const live = new Set(Array.isArray(names) ? names : [])
    for (const n of [...overlays]) if (!live.has(n)) overlays.delete(n)
  }

  return {
    apply,
    relax,
    resync,
    params,
    active: () => channels.size > 0 || overlays.size > 0 || !!handNow,
    overlays: () => [...overlays],
  }
}
