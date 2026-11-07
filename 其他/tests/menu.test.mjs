// 菜单规则的离线测试：层级折叠、深层查找、三态文案、行数上限。
// 只测 modules/menu/menu.mjs 里的纯函数，不开窗口、不碰 HTTP。
//
//   node test/menu.test.mjs

import { normalizeMenu, fillDynamic, findMenuItem, menuDepth, menuStatus, maxRows, windowRows, stackRows } from '../../main/modules/menu/menu.mjs'

const checks = []
const ok = (label, cond, extra = '') => checks.push({ label, pass: !!cond, extra })
const eq = (label, actual, expect) => ok(label, actual === expect, `got ${JSON.stringify(actual)}`)

/* ------------------------------ 层树归一 ------------------------------ */

{
  // 新写法：children 直接嵌
  const tree = normalizeMenu([
    { id: 'more', label: '做点什么……', children: [
      { id: 'pose', label: '换个姿势', action: 'pose-cycle' },
      { id: 'other', label: '其他', children: [{ id: 'quit', label: '退下吧', action: 'quit' }] },
    ] },
  ])
  eq('根项数', tree.length, 1)
  eq('二级项数', tree[0].children.length, 2)
  eq('三级可达', tree[0].children[1].children[0].id, 'quit')
  eq('深度 3', menuDepth(tree), 3)
  ok('深层查找', findMenuItem(tree, 'quit')?.label === '退下吧')
}

{
  // 老写法：扁平 level:2 + expand 根 —— 必须自动折进去，不能丢
  const tree = normalizeMenu([
    { id: 'pose', label: '换个姿势', action: 'pose-cycle', level: 2 },
    { id: 'more', label: '做点什么……', action: 'expand', level: 1 },
    { id: 'quit', label: '退下吧', action: 'quit', level: 2 },
  ])
  eq('老配置根项数', tree.length, 1)
  eq('老配置二级项数', tree[0].children.length, 2)
  ok('老配置顺序保持', tree[0].children.map((c) => c.id).join(',') === 'pose,quit')
}

{
  // 只有 level:2、没有 expand 根：自动补一个宿主，别让菜单项凭空消失
  const tree = normalizeMenu([{ id: 'a', label: 'A', level: 2 }])
  eq('补出根项', tree.length, 1)
  eq('补出的根 id', tree[0].id, 'more')
  eq('子项还在', tree[0].children[0].id, 'a')
}

{
  eq('空配置', normalizeMenu(null).length, 0)
  eq('缺 id 的项被丢掉', normalizeMenu([{ label: 'x' }]).length, 0)
}

/* ------------------------------ 三态文案 ------------------------------ */

{
  const now = 1_000_000
  const unbound = menuStatus({}, null, now)
  eq('未绑定文案', unbound.text, '未绑定驾驶员')
  eq('未绑定禁用输入', unbound.disabled, true)
  ok('未绑定不提示输入', !unbound.text.includes('请输入'))

  const offline = menuStatus({ bind: 'sess-1' }, { at: now - 60000 }, now)
  eq('离线文案', offline.text, '驾驶员离线')
  eq('离线禁用输入', offline.disabled, true)

  const online = menuStatus({ bind: 'sess-1' }, { at: now - 3000 }, now)
  eq('在线文案', online.text, '请输入文本 > _ ')
  eq('在线可输入', online.disabled, false)

  // 边界：刚好 15s 还算新鲜（插件 3s 一次上报，15s 已经是「掉了」）
  eq('15s 边界仍在线', menuStatus({ bind: 's' }, { at: now - 14999 }, now).kind, 'input')
  eq('15s 过了算离线', menuStatus({ bind: 's' }, { at: now - 15001 }, now).kind, 'offline')
}

/* ------------------------------ 行数 ------------------------------ */

{
  eq('大屏 6 行封顶', maxRows({ screenH: 1600, inH: 168, row: 84, gap: 15, pad: 36 }), 6)
  // 800 高：800-16-168-36 = 580，每行 99 → 5 行（放不下第 6 行）
  eq('小屏按高度夹', maxRows({ screenH: 800, inH: 168, row: 84, gap: 15, pad: 36 }), 5)
  const tiny = maxRows({ screenH: 400, inH: 168, row: 84, gap: 15, pad: 36 })
  ok('极小屏至少 1 行', tiny >= 1)
}

{
  const tree = normalizeMenu([
    { id: 'more', label: 'M', children: [
      { id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' },
    ] },
    { id: 'x', label: 'X' },
  ])
  // 0.5.7：深层多一颗固定的「返回」，所以最深那层要按 4 项 + 1 颗返回 = 5 行算
  eq('按最深一层定行数（含固定返回）', windowRows(tree, 6), 5)
  eq('超过上限时夹住', windowRows(tree, 3), 3)
  eq('空树保底 1', windowRows([], 6), 1)
}

/* ------------------------------ 0.5.7 动态分类 / 固定返回 / 在线判定 ------------------------------ */

{
  const tree = normalizeMenu([
    { id: 'more', label: '做点什么……', action: 'expand', children: [
      { id: 'faces', label: '表情和姿势', source: 'faces' },
      { id: 'cmds', label: '快捷操作', source: 'commands' },
      { id: 'config', label: '打开设置', action: 'open-settings' },
      { id: 'other', label: '其他', children: [{ id: 'low', label: '省电模式', action: 'low-interrupt' }] },
    ] },
  ])
  eq('source 被保留', tree[0].children[0].source, 'faces')

  const filled = fillDynamic(tree, {
    faces: [
      { label: '体型1', action: 'expr:体型1', group: '表情' },
      { label: '姿势1', action: 'pose:grass', group: '姿势' },
    ],
    commands: Array.from({ length: 25 }, (_, i) => ({ id: 'c' + i, label: '命令' + i })),
    maxCommands: 20,
  })
  eq('表情填进去', filled[0].children[0].children.length, 2)
  eq('表情 id 带前缀', filled[0].children[0].children[0].id, 'face:expr:体型1')
  eq('表情分组保留', filled[0].children[0].children[0].groupLabel, '表情')
  eq('指令上限 20', filled[0].children[1].children.length, 20)
  eq('指令 id 带前缀', filled[0].children[1].children[0].id, 'cmd:c0')
  eq('指令动作形状', filled[0].children[1].children[0].action, 'command:c0')
  eq('原树没被改', tree[0].children[0].children, undefined)
  eq('普通项不受影响', filled[0].children[2].action, 'open-settings')
  ok('深层仍可查找', findMenuItem(filled, 'cmd:c19')?.label === '命令19')

  // 顶层没有返回，整块都是列表；深层要扣掉固定的那颗返回
  eq('顶层列表行数', stackRows(5, 0), 5)
  eq('深层列表行数（扣返回）', stackRows(5, 1), 4)
  eq('极小屏也不小于 1', stackRows(1, 1), 1)
}

{
  const now = 1_000_000
  const bound = { bind: 's1' }
  ok('没绑 → 未绑定', menuStatus({ bind: null }, { at: now }, now).kind === 'unbound')
  ok('老字段 seenAt 也认', menuStatus(bound, { seenAt: now - 1000 }, now).kind === 'input')
  ok('at 新鲜 → 在线', menuStatus(bound, { at: now - 3000 }, now).kind === 'input')
  ok('at 过期 → 离线', menuStatus(bound, { at: now - 20000 }, now).kind === 'offline')
  ok('没有时间戳 → 离线', menuStatus(bound, {}, now).kind === 'offline')
}

/* ------------------------------ 汇总 ------------------------------ */

const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  if (!c.pass) console.log('  ✗', c.label, c.extra ? `(${c.extra})` : '')
}
console.log(`menu: ${checks.length - failed.length}/${checks.length} 通过`)
process.exit(failed.length ? 1 : 0)
