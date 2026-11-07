/**
 * 菜单逻辑（纯函数，给主进程与测试共用）。
 *
 * 为什么不写在 menu.html 里：三级菜单的「层级怎么折、状态文案写什么、最多几行」
 * 都是可离线验证的规则；DOM 只负责把结果画出来。把规则留在这里，
 * `其他/tests/menu.test.mjs` 就能不开窗口验证。
 */

/**
 * 把 config.interact.menu 归一成树。
 *
 * 兼容两种写法：
 *   · 新写法：{ id, label, children: [...] }（任意深度，实践上三级封顶）
 *   · 老写法：扁平的 { level: 2 } 项 + 一个 action:"expand" 的根开关
 *     —— 老配置不改也照样能弹出二级，不会因为升级就少了一半菜单。
 */
export function normalizeMenu(raw) {
  const list = Array.isArray(raw) ? raw.filter((x) => x && x.id && x.label) : []
  const roots = []
  const expandRoot = list.find((x) => x.action === 'expand') || null
  const legacySubs = []

  for (const it of list) {
    const node = toNode(it)
    if (Number(it.level) === 2 || Number(it.level) === 3) {
      legacySubs.push(node)
      continue
    }
    roots.push(node)
  }

  // 老写法：二级项挂到「做点什么……」下面。没有 expand 项就新建一个，
  // 否则那些二级项会凭空消失（比多一个分类更糟）。
  if (legacySubs.length) {
    let host = roots.find((n) => n.action === 'expand')
    if (!host) {
      host = toNode({ id: 'more', label: '做点什么……', action: 'expand', back: '返回' })
      roots.push(host)
    }
    host.children = [...(host.children || []), ...legacySubs]
  }

  // 老写法里 action=expand 的根开关：有 children 才是真正的分类，否则保留原样（点击展开由 UI 处理）
  return roots
}

function toNode(it) {
  const node = {
    id: String(it.id),
    label: String(it.label),
    action: it.action || '',
    back: it.back || '返回',
  }
  if (it.groupLabel) node.groupLabel = String(it.groupLabel)
  // source = 「内容在运行时才知道」的分类（表情/姿势、快捷操作）。
  // 不在 config 里写死 27 个表情，是因为表情来自模型扫描、指令来自 commands.json ——
  // 写死就是第二份真相，加一个表情/一条指令就得改配置。
  if (it.source) node.source = String(it.source)
  if (Array.isArray(it.children) && it.children.length) {
    node.children = it.children.filter((x) => x && x.id && x.label).map(toNode)
  }
  return node
}

/**
 * 把 source 分类填成真正的子项（每次打开菜单都重算，改完指令立刻看得到）。
 *
 * @param {object[]} tree normalizeMenu 的结果
 * @param {{faces?:{label:string,action:string,group?:string}[], commands?:{id:string,label:string}[], maxCommands?:number}} ctx
 */
export function fillDynamic(tree, ctx = {}) {
  const faces = Array.isArray(ctx.faces) ? ctx.faces : []
  const commands = Array.isArray(ctx.commands) ? ctx.commands : []
  const maxCommands = Math.max(1, Number(ctx.maxCommands) || 20)
  const walk = (nodes) => (nodes || []).map((n) => {
    const out = { ...n }
    let filled = null
    if (n.source === 'faces') {
      // 表情在前、姿势在后，用 groupLabel 分段（列表里会画分组标题）
      filled = faces.map((f) => ({
        id: 'face:' + f.action,
        label: f.label,
        action: f.action,
        groupLabel: f.group || undefined,
        back: n.back,
      }))
    } else if (n.source === 'commands') {
      // 快捷操作只有 20 个槽：超出的不进菜单（设置页会提示）
      filled = commands.slice(0, maxCommands).map((c) => ({
        id: 'cmd:' + c.id,
        label: c.label,
        action: 'command:' + c.id,
        back: n.back,
      }))
    }
    if (filled) out.children = filled
    if (Array.isArray(n.children) && n.children.length) out.children = walk(n.children)
    return out
  })
  return walk(tree)
}

/** 深度优先找 id 对应的项（任意层级） */
export function findMenuItem(tree, id) {
  const stack = [...(tree || [])]
  while (stack.length) {
    const n = stack.shift()
    if (!n) continue
    if (n.id === id) return n
    if (Array.isArray(n.children)) stack.unshift(...n.children)
  }
  return null
}

/** 树里最深的层级（1 = 只有一级）。用于「三级封顶」的断言与测试。 */
export function menuDepth(tree) {
  let max = 0
  const walk = (nodes, d) => {
    for (const n of nodes || []) {
      max = Math.max(max, d)
      if (Array.isArray(n.children) && n.children.length) walk(n.children, d + 1)
    }
  }
  walk(tree, 1)
  return max
}

/**
 * 输入胶囊的三态文案。
 *
 * 为什么「未绑定」不能还显示「请输入文本」：用户打了字也没人接 —— 舞台会把
 * 事件丢进 outbox 等一个不存在的绑定。文案必须直接说出「没人接」。
 *
 * @param {object} settings 舞台设置（bind）
 * @param {object|null} health 插件健康上报（at = 收到上报的时间戳，seenAt 是旧字段）
 * @param {number} now 当前时间（测试注入）
 */
export function menuStatus(settings, health, now = Date.now()) {
  const bind = settings && settings.bind ? String(settings.bind) : ''
  if (!bind) return { kind: 'unbound', text: '未绑定驾驶员', disabled: true }
  // 0.5.7 修：插件上报的 healthSnapshot 里没有 `at`（它刻意不带时间戳），
  // 而这里只认 at → at 恒为 0 → 只要绑定了就永远显示「驾驶员离线」。
  // 现在以「舞台收到上报的时刻」为准（main 在 setBridgeHealth 里补 at），
  // 兼容老的 seenAt，两边都没有才判离线。
  const at = Number((health && (health.at ?? health.seenAt)) || 0)
  const fresh = at > 0 && now - at < 15000
  if (!fresh) return { kind: 'offline', text: '驾驶员离线', disabled: true }
  return { kind: 'input', text: '请输入文本 > _ ', disabled: false }
}

/**
 * 一行按钮的高度约束：最多 6 行，且必须放得进屏幕。
 *
 * @param {object} g { screenH, inH, row, gap, pad }
 * @returns {number} 当前允许的行数（≥1）
 */
export function maxRows(g) {
  const screenH = Number(g.screenH) || 0
  const avail = screenH - 16 - (Number(g.inH) || 0) - (Number(g.pad) || 0)
  const per = (Number(g.row) || 84) + (Number(g.gap) || 15)
  const fit = Math.floor(avail / per)
  return Math.max(1, Math.min(6, fit || 6))
}

/**
 * 窗口要开几行：按「最深的一层有几项」算，且不超过 maxRows。
 *
 * 为什么不是永远开 6 行：窗口越大、贴模型时的落点越靠上，菜单和人物之间
 * 会空出一大块。按最大层开，层级切换时高度仍然不变（不会闪），又不会离人太远。
 *
 * 0.5.7：深层多一颗**固定不滚动**的「返回」，所以每一深一层要 +1 格。
 */
export function windowRows(tree, cap = 6) {
  let need = 1
  const walk = (nodes, depth) => {
    need = Math.max(need, nodes.length + (depth > 0 ? 1 : 0))
    for (const n of nodes) if (Array.isArray(n.children) && n.children.length) walk(n.children, depth + 1)
  }
  walk(Array.isArray(tree) ? tree : [], 0)
  return Math.max(1, Math.min(cap, need))
}

/**
 * 某一层里「可滚动列表」能看到几行：深层要扣掉固定的那颗「返回」。
 * 顶部（depth 0）没有返回，整块都是列表。
 */
export function stackRows(rows, depth) {
  const n = Number(rows) || 1
  return Math.max(1, depth > 0 ? n - 1 : n)
}
