// 序列编排的离线测试：只测「拍平 + 定时派发」，不碰 HTTP 也不碰渲染。
//
//   node test/sequence.test.mjs

import { planSequence, createSequencer } from '../../main/modules/behavior/sequence.mjs'

const checks = []
const ok = (label, cond, extra = '') => checks.push({ label, pass: !!cond, extra })
const eq = (label, actual, expect) => ok(label, actual === expect, `got ${JSON.stringify(actual)}`)

/* ------------------------------ 拍平 ------------------------------ */

{
  const r = planSequence([
    { op: 'expression', name: '爱心眼' },
    { op: 'motion', name: '伸懒腰' },            // 时长从 config.motions 查
    { op: 'say', text: '搞定啦' },
  ], (n) => (n === '伸懒腰' ? 4200 : 0))

  ok('三步序列可用', r.ok === true, r.error)
  eq('步数', r.plan.length, 3)
  eq('expression 先派发', r.plan[0].evt.kind, 'expression')
  eq('motion 用内置时长', r.plan[1].evt.name, '伸懒腰')
  eq('motion 等它演完', r.plan[1].after, 4200)
  eq('say 不等满 9 秒', r.plan[2].after, 2600)
  eq('总时长', r.ms, 260 + 4200 + 2600)
  ok('派发顺序与入参一致', r.plan.map((s) => s.evt.kind).join(',') === 'expression,motion,say')
}

{
  // tracks 现编：没给 ms 时按 2000，没给 after 时等它演完
  const r = planSequence([{ op: 'motion', tracks: { ParamAngleZ: [[0, 0], [0.5, 4], [1, 0]] } }])
  ok('tracks 步可用', r.ok === true, r.error)
  eq('tracks 默认 2000ms', r.plan[0].after, 2000)
  ok('tracks 原样带过去', !!r.plan[0].evt.tracks?.ParamAngleZ)
  eq('tracks 步不带 name', r.plan[0].evt.name, null)
}

{
  // after 可以被显式覆盖；wait 步不发事件只占时间
  const r = planSequence([
    { op: 'motion', name: '抖尾巴', after: 300 },
    { op: 'wait', ms: 800 },
    { op: 'pose', name: 'chest' },
  ], () => 5000)
  eq('after 覆盖生效', r.plan[0].after, 300)
  eq('wait 不发事件', r.plan[1].evt, null)
  eq('wait 占 800ms', r.plan[1].after, 800)
  eq('pose 后等补间', r.plan[2].after, 420)
}

{
  // 别名与容错：模型常把 op 写成 kind / do；expression 空 name = 清空
  const r = planSequence([
    { kind: 'expression', name: '' },
    { do: 'say', text: '嗯哼' },
  ])
  ok('kind/do 别名可用', r.ok === true, r.error)
  eq('空 name 保留为 null（清空表情）', r.plan[0].evt.name, null)
}

/* ------------------------------ 校验 ------------------------------ */

{
  const cases = [
    [[], '空数组'],
    [null, 'null'],
    [[{ op: 'dance' }], '未知 op'],
    [[{ op: '' }], '空 op'],
    [[{ op: 'motion' }], 'motion 缺 name 和 tracks'],
    [[{ op: 'say' }], 'say 缺 text'],
    [Array.from({ length: 25 }, () => ({ op: 'wait', ms: 100 })), '超过 24 步'],
    [Array.from({ length: 20 }, () => ({ op: 'wait', ms: 9000 })), '超过 120 秒'],
  ]
  for (const [steps, label] of cases) {
    const r = planSequence(steps)
    ok(`拒绝：${label}`, r.ok === false && typeof r.error === 'string' && r.error.length > 4, r.error)
  }
  // 错误信息要指到具体第几步
  const r = planSequence([{ op: 'wait', ms: 100 }, { op: 'say' }])
  ok('错误里带步号', /第 2 步/.test(String(r.error)), r.error)
}

/* ------------------------------ 派发 ------------------------------ */

{
  const seen = []
  const stopped = []
  const sq = createSequencer({
    onEvent: (e) => seen.push(e.kind + ':' + (e.name || e.text || '')),
    record: () => {},
    log: (m) => stopped.push(m),
  })

  const r = planSequence([
    { op: 'expression', name: '脸红', after: 40 },
    { op: 'motion', name: '抖尾巴', after: 40 },
    { op: 'say', text: '嘿嘿', after: 40 },
  ])
  sq.run(r.plan)
  await new Promise((res) => setTimeout(res, 200))

  eq('按序派发三步', seen.join('|'), 'expression:脸红|motion:抖尾巴|say:嘿嘿')
  ok('事件带步号', seen.length === 3)
  ok('跑完后不再 running', sq.running === false, String(sq.running))
  sq.stop()
}

{
  // 新序列顶掉旧序列：第一条只演第一步就该停
  const seen = []
  const sq = createSequencer({ onEvent: (e) => seen.push(e.name), record: () => {}, log: () => {} })
  const a = planSequence([
    { op: 'expression', name: 'A1', after: 150 },
    { op: 'expression', name: 'A2', after: 60 },
    { op: 'expression', name: 'A3', after: 60 },
  ])
  sq.run(a.plan)
  await new Promise((res) => setTimeout(res, 40))   // A1 已发，A2 还在等
  const b = planSequence([{ op: 'expression', name: 'B1', after: 40 }])
  sq.run(b.plan)
  await new Promise((res) => setTimeout(res, 250))
  ok('旧序列被顶掉', !seen.includes('A2') && !seen.includes('A3'), seen.join(','))
  ok('新序列接上', seen.includes('B1'), seen.join(','))
  sq.stop()
}

{
  // stop 之后不再派发（已发出去的那一步不受影响）
  const seen = []
  const sq = createSequencer({ onEvent: (e) => seen.push(e.name), record: () => {}, log: () => {} })
  const r = planSequence([
    { op: 'expression', name: 'X1', after: 50 },
    { op: 'expression', name: 'X2', after: 50 },
  ])
  sq.run(r.plan)
  sq.stop()
  await new Promise((res) => setTimeout(res, 120))
  eq('stop 后只剩第一步', seen.join(','), 'X1')
}

/* ------------------------------ 报告 ------------------------------ */

const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`${c.pass ? '  ok  ' : ' FAIL '} ${c.label}${c.extra ? `  → ${c.extra}` : ''}`)
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
process.exit(failed.length ? 1 : 0)
