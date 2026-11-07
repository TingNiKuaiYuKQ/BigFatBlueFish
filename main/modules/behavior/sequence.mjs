// 多步动作序列的调度。
//
// 为什么调度放在舞台侧，而不是让插件连着发几次 /api/motion：
//
//   只有舞台知道「一步真实有多长」——动作的 ms 在 config.motions 里，
//   姿势补间是 260ms，气泡默认停留 9s。插件那边只能猜，猜早了后一步会和
//   前一步抢通道（claim 会把它丢掉），猜晚了序列中间就有空拍。
//
// 所以插件把 steps 原样发过来，这里拍平成单步事件、按各自的时长推进。
// 一步的 after 是「发出去之后等多久」，不是「这一步完全结束」：
// 气泡可以一边念，动作一边接上来，两者本来就是不同通道。

const OPS = new Set(['say', 'expression', 'pose', 'motion', 'wait'])
const MAX_STEPS = 24
const MAX_TOTAL = 120000
const MAX_TEXT = 120

/** 各 op 发出去之后默认等多久（ms）。motion 不在这里，它要等自己演完。 */
const AFTER = { expression: 260, pose: 420, wait: 600, say: 2600 }

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

function clipText(v) {
  return Array.from(String(v || '').trim()).slice(0, MAX_TEXT).join('')
}

/**
 * 把一份 steps 校验并拍平成 [{ evt, after }]。
 *
 * 校验失败返回 { ok:false, error }，error 是给模型看的人话 ——
 * 它要能照着改，所以要说清「第几步、哪个字段、可选值是什么」。
 *
 * @param {Array} raw          原始 steps
 * @param {(name:string)=>number} motionMs 内置动作的时长查询（来自 config.motions）
 * @param {object} [names]     合法名单（expression/pose/motion），不传则跳过校验
 */
export function planSequence(raw, motionMs = () => 0, names = {}) {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: 'steps 需要一个非空数组' }
  if (raw.length > MAX_STEPS) {
    return { ok: false, error: `最多 ${MAX_STEPS} 步，收到 ${raw.length} 步` }
  }

  // 名字校验要在拍平之前做：错误里带上可用清单，模型一次就能改对
  const nameBad = (list, label, got, where) => {
    if (!Array.isArray(list) || !list.length || !got) return null
    if (list.includes(got)) return null
    return {
      ok: false,
      error: `${where}的${label}不存在：${got}；可选 ${list.slice(0, 12).join(' / ')}`,
    }
  }
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: 'steps 需要一个非空数组' }
  if (raw.length > MAX_STEPS) {
    return { ok: false, error: `最多 ${MAX_STEPS} 步，收到 ${raw.length} 步` }
  }

  const plan = []
  let total = 0
  let skipped = 0

  for (let i = 0; i < raw.length; i += 1) {
    const s = raw[i] || {}
    const where = `第 ${i + 1} 步`
    // op 是首选字段名；kind/do 是顺手兼容的别名 —— 模型经常把外层字段名带进来
    const op = String(s.op || s.kind || s.do || '').trim()
    if (!OPS.has(op)) {
      return { ok: false, error: `${where}的 op 不认识：${op || '(空)'}；可选 ${[...OPS].join(' / ')}` }
    }

    let evt = null
    let after = 0

    if (op === 'say') {
      const text = clipText(s.text)
      if (!text) return { ok: false, error: `${where} say 缺 text` }
      const expr = s.expression ? String(s.expression) : null
      const pose = s.pose ? String(s.pose) : null
      const badE = nameBad(names.expressions, '表情', expr, where)
      if (badE) return badE
      const badP = nameBad(names.poses, '姿势', pose, where)
      if (badP) return badP
      const ms = Math.max(800, num(s.ms) || 9000)
      evt = {
        kind: 'say',
        text,
        ms,
        expression: expr,
        pose,
      }
      after = num(s.after) > 0 ? num(s.after) : AFTER.say
    } else if (op === 'expression') {
      // name 为空 = 清空所有表情，回到默认脸（和 /api/expression 一致）
      const name = s.name ? String(s.name) : null
      const bad = nameBad(names.expressions, '表情', name, where)
      if (bad) return bad
      evt = { kind: 'expression', name }
      after = num(s.after) > 0 ? num(s.after) : AFTER.expression
    } else if (op === 'pose') {
      const name = s.name ? String(s.name) : 'default'
      const bad = nameBad(names.poses, '姿势', name, where)
      if (bad) return bad
      evt = { kind: 'pose', name }
      after = num(s.after) > 0 ? num(s.after) : AFTER.pose
    } else if (op === 'motion') {
      const tracks = s.tracks && typeof s.tracks === 'object' ? s.tracks : null
      const name = s.name ? String(s.name) : null
      if (!name && !tracks) return { ok: false, error: `${where} motion 需要 name 或 tracks` }
      // 动作名无效就跳过这一步（用户约定）：序列里一步即兴的动作名不该让整段失败。
      // 表情/姿势仍然报错 —— 那两个是明确的选项列表，传错就是该修的错。
      if (nameBad(names.motions, '动作', name, where)) {
        skipped += 1
        continue
      }
      // name 的时长查内置表；查不到就用 3200 兜底，免得后一步踩上来
      const ms = Math.max(160, num(s.ms) || (tracks ? 2000 : num(motionMs(name)) || 3200))
      evt = { kind: 'motion', name, ms: tracks ? ms : null, tracks }
      after = s.after !== undefined && num(s.after) >= 0 ? num(s.after) : ms
    } else {
      // wait：不发事件，只占时间
      after = Math.max(60, num(s.ms) || AFTER.wait)
    }

    total += after
    plan.push({ evt, after })
  }

  if (total > MAX_TOTAL) {
    return { ok: false, error: `序列太长（${Math.round(total / 1000)}s），上限 ${MAX_TOTAL / 1000}s` }
  }
  return { ok: true, plan, ms: total, skipped }
}

/**
 * 序列执行器。同一时刻只跑一条：新的序列直接顶掉旧的。
 *
 * 为什么不排队：序列是「现在要演的一段」，等两条 20s 的序列串起来，
 * 第二条开演时语境早就变了 —— 和随机事件不排队的理由一样。
 */
export function createSequencer({ onEvent, record = () => {}, log = () => {} }) {
  let timer = null
  let token = 0
  let running = false
  let step = 0
  let steps = 0

  function stop() {
    token += 1
    running = false
    step = 0
    if (timer) { clearTimeout(timer); timer = null }
  }

  function run(plan) {
    stop()
    const my = token
    let i = 0
    steps = plan.length
    running = true

    const tick = () => {
      if (my !== token) return          // 被新序列顶掉了
      if (i >= plan.length) { running = false; step = 0; return }
      const { evt, after } = plan[i]
      i += 1
      step = i
      if (evt) {
        const e = { ...evt, at: Date.now(), seqStep: i, seqTotal: plan.length }
        record(e)
        onEvent(e)
      }
      timer = setTimeout(tick, after)
      if (timer.unref) timer.unref()
    }

    log(`序列开演：${plan.length} 步`)
    tick()
  }

  return {
    run,
    stop,
    get running() { return running },
    get progress() { return { step, steps } },
  }
}
