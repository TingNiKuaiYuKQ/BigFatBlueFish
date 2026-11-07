// 顺序跑全部离线测试，汇总结果。
//
//   node 其他/tests/run-all.mjs
//
// 退出码：全绿 0，任一失败 1。每套测试自己负责退出码。

import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SUITES = [
  'syntax.test.mjs',
  'menu.test.mjs',
  'sequence.test.mjs',
  'projection.test.mjs',
  'delivery.test.mjs',
]

const results = []
for (const suite of SUITES) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [join(HERE, suite)], { stdio: 'inherit' })
  results.push({ suite, ok: r.status === 0, ms: Date.now() - t0, code: r.status })
}

console.log('\n================ run-all =================')
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.suite.padEnd(22)} ${String(r.ms).padStart(6)}ms  exit=${r.code}`)
}
const failed = results.filter((r) => !r.ok)
console.log(`  ${results.length - failed.length}/${results.length} 套通过`)
process.exit(failed.length ? 1 : 0)
