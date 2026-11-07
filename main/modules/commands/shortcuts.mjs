// 快捷指令执行器。安全模型只有一条：
//
//   命令和参数来自本地 shortcuts.json，绝不来自网络请求。
//   请求里只允许出现 id（和可选的额外参数），所以模型无法构造任意命令。
//
// 两种执行模式：
//   exec  —— spawn(cmd, args, { shell: false })。默认，也是最安全的。
//   shell —— 过 cmd.exe /c 跑一整串。只给 code / npm 这类 .cmd 包装器用；
//            因为它绕过了参数边界，所以**禁止**附加参数（加载时就拒绝）。
//
// capture:true 的指令把 stdout 回给模型（查询类）；其余只报启动成败，
// 因为 GUI 程序不会退出，等它输出等于挂住。

import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import paths from '../core/paths.cjs'

const RUN_TIMEOUT = 30_000
const OUTPUT_MAX = 4_000

export function loadShortcuts(file = paths.SHORTCUTS) {
  if (!existsSync(file)) return { list: [], error: `找不到 ${file}` }
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { list: [], error: `shortcuts.json 解析失败：${e.message}` }
  }
  const raw = Array.isArray(data?.shortcuts) ? data.shortcuts : []
  const list = []
  const problems = []
  for (const s of raw) {
    if (!s || typeof s.id !== 'string' || !s.id.trim()) {
      problems.push('有条目缺 id，已跳过')
      continue
    }
    const mode = s.mode === 'shell' ? 'shell' : 'exec'
    if (typeof s.cmd !== 'string' || !s.cmd.trim()) {
      problems.push(`${s.id}: 缺 cmd`)
      continue
    }
    const args = Array.isArray(s.args) ? s.args.map(String) : []
    list.push({
      id: s.id.trim(),
      label: String(s.label || s.id),
      cmd: s.cmd,
      args,
      mode,
      cwd: s.cwd ? String(s.cwd) : undefined,
      capture: s.capture === true,
      // shell 模式不允许附加参数：否则一段空格分隔的字符串就是裸 shell
      allowExtraArgs: mode === 'exec' && s.allowExtraArgs === true,
    })
  }
  return { list, error: problems.length ? problems.join('；') : null }
}

/** 额外参数切分：按空白拆，不做引号解析（不引 shell，解析越简单越安全） */
function splitExtra(extra) {
  const t = String(extra || '').trim()
  return t ? t.split(/\s+/) : []
}

/**
 * 执行一条白名单指令。
 * @returns {Promise<{ok:boolean, id?:string, pid?:number, code?:number|null, stdout?:string, stderr?:string, error?:string}>}
 */
export function runShortcut(entry, extra) {
  return new Promise((resolve) => {
    if (!entry) return resolve({ ok: false, error: '没有这条指令' })

    const extraArgs = entry.allowExtraArgs ? splitExtra(extra) : []
    if (String(extra || '').trim() && !entry.allowExtraArgs) {
      return resolve({
        ok: false,
        error: `指令 ${entry.id} 不接受附加参数`,
      })
    }

    let child
    try {
      if (entry.mode === 'shell') {
        const line = [entry.cmd, ...entry.args].join(' ')
        child = spawn(line, {
          shell: true,
          cwd: entry.cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        })
      } else {
        child = spawn(entry.cmd, [...entry.args, ...extraArgs], {
          shell: false,
          cwd: entry.cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        })
      }
    } catch (e) {
      return resolve({ ok: false, error: `启动失败：${e.message}` })
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }

    const timer = setTimeout(() => {
      // 长驻 GUI 程序不该被杀：只回报「已启动」
      if (entry.capture) {
        try { child.kill() } catch { /* 已经退了 */ }
        finish({ ok: true, id: entry.id, pid: child.pid, code: null, timedOut: true, stdout, stderr })
      } else {
        finish({ ok: true, id: entry.id, pid: child.pid, detached: true })
      }
    }, RUN_TIMEOUT)
    if (timer.unref) timer.unref()

    child.stdout?.on('data', (b) => {
      if (stdout.length < OUTPUT_MAX) stdout += b.toString()
    })
    child.stderr?.on('data', (b) => {
      if (stderr.length < OUTPUT_MAX) stderr += b.toString()
    })

    child.on('error', (e) => {
      finish({ ok: false, id: entry.id, error: `启动失败：${e.message}` })
    })

    child.on('exit', (code) => {
      if (entry.capture) {
        finish({
          ok: code === 0,
          id: entry.id,
          code,
          stdout: stdout.slice(0, OUTPUT_MAX),
          stderr: stderr.slice(0, OUTPUT_MAX),
        })
      } else {
        finish({ ok: true, id: entry.id, code })
      }
    })
  })
}
