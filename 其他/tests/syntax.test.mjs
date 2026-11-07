// 语法体检：所有页面内联脚本 + 所有主体/插件脚本能不能被解析。
//
// 起因（0.5.6）：settings.html 里一行注释的结尾和下一行代码黏在一起，
// 「// …（参数与 --install-shortcut 完全一致）  document.getElementById(...)」
// 整行都成了注释，后面的 `})` 让脚本语法错误 —— 整页脚本一行都没执行，
// 设置窗口打开后只有左上角一小块底纹。主进程只看到 did-finish-load，
// 日志里全是「页面加载完成」，完全看不出问题。
//
// 这个测试就是那道闸：页面打不开之前先在这里红。
//
//   node 其他/tests/syntax.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const MODULES = join(REPO, 'main', 'modules')
const SCRIPTS = join(REPO, 'main', 'scripts')
const PLUGIN_LIB = join(REPO, 'plugins', 'dsh', 'lib')

const checks = []
const ok = (label, cond, extra = '') => checks.push({ label, pass: !!cond, extra })

function walk(dir, out = []) {
  let list = []
  try { list = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const ent of list) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'build' || ent.name === 'node_modules') continue
      walk(p, out)
    } else {
      out.push(p)
    }
  }
  return out
}

/* ---------------- 页面内联脚本 ----------------
 * 这些页面里的 <script> 都是**普通脚本**（不是 module）：没有 import/export，
 * 顶层 await 在浏览器里就是语法错误。用 new Function 校验，语义和浏览器一致。
 */
const pages = walk(MODULES).filter((f) => f.endsWith('.html'))
// 这几页是「靠脚本活」的：一个脚本块都没有说明模板被改坏了
const SCRIPTED = new Set(['settings.html', 'menu.html', 'tutorial.html', 'bubble.html'])
for (const file of pages) {
  const html = readFileSync(file, 'utf8')
  const name = relative(REPO, file).replace(/\\/g, '/')
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  if (SCRIPTED.has(file.split(/[\\/]/).pop())) ok(`${name}：找到脚本块`, blocks.length > 0, `共 ${blocks.length} 块`)
  blocks.forEach((m, i) => {
    const code = m[1]
    if (!code.trim()) return
    // 行号起点：脚本块在文件里的起始行，报错时能直接定位
    const line0 = html.slice(0, m.index).split('\n').length
    try {
      // eslint-disable-next-line no-new-func
      new Function(code)
      ok(`${name} 脚本块#${i + 1} 可解析`, true)
    } catch (e) {
      ok(`${name} 脚本块#${i + 1} 可解析（第 ${line0} 行起）`, false, e && e.message)
    }
  })
}

/* ---------------- 主体与插件脚本（ESM / CJS） ----------------
 * 用 node --check 走真正的解析器（package.json 的 type 决定 .js 按 ESM 还是 CJS）。
 */
const candidates = [
  ...walk(MODULES).filter((f) => /\.(mjs|js|cjs)$/.test(f)),
  ...walk(SCRIPTS).filter((f) => /\.(mjs|js|cjs)$/.test(f)),
  ...walk(PLUGIN_LIB).filter((f) => f.endsWith('.js')),
  join(REPO, 'main', 'launch.mjs'),
  join(REPO, 'plugins', 'install.mjs'),
]
for (const f of [...new Set(candidates)]) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  const name = relative(REPO, f).replace(/\\/g, '/')
  ok(`${name} 可解析`, r.status === 0, (r.stderr || '').split('\n').slice(0, 3).join(' ').trim())
}

/* ------------------------------ 汇总 ------------------------------ */

const failed = checks.filter((c) => !c.pass)
for (const c of checks) if (!c.pass) console.log('  ✗', c.label, c.extra ? `(${c.extra})` : '')
console.log(`syntax: ${checks.length - failed.length}/${checks.length} 通过`)
process.exit(failed.length ? 1 : 0)
