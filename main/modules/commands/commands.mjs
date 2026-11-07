/**
 * 快捷指令：数据 + 校验 + 执行器（0.5.3）。
 *
 * 三件事必须守住，否则这就是个「给 AI 任意执行命令」的洞：
 *   1. **参数只能以 argv 传**（shell:false）。除了 mode:"shell" 里作者写死的那一串，
 *      任何地方都不拼命令字符串 —— 拼了就有注入面。
 *   2. mode:"shell" 不接受额外参数（连 allowArgs 都不允许），因为整串已经是 shell 语义。
 *   3. 改文件必须走「临时文件 + rename」，并留一份 .bak —— 半截 JSON 会让整个指令库消失。
 *
 * 数据文件：main/config/commands.json
 * 审计：  main/runtime/audit/commands-audit.jsonl（1 MB 轮转）
 */

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import paths from '../core/paths.cjs'

// 本文件是 ESM，`require` 不存在。electron 是 CJS 模块，只能这样拿
// （0.6.1 才修：shortcut 类型一直因为 `require is not defined` 跑不起来）。
const requireCjs = createRequire(import.meta.url)

export const MAIN_ROOT = paths.MAIN_ROOT

const TYPES = ['cmd', 'powershell', 'bat', 'shortcut', 'exe']
const MODES = ['exec', 'shell']
const MAX_CAPTURE = 4000
// 快捷操作只有 20 个槽（用户口径）：菜单里就是 20 行，多出来的没地方放，
// 不如在「加」的时候就说清楚，别让人加完发现菜单里少了几条。
export const MAX_ITEMS = 20
const MAX_CONCURRENT = 3

/** 空表种子：commands.json 被人删掉时按这个重建，别让整个指令库消失。
 *  0.6.x 起不再从 shortcuts.legacy.json 迁移 —— 那个文件带的是作者本机的路径，
 *  已经删了；示例指令直接写在 main/config/commands.json 里。 */
function emptySeed() {
  return { version: 1, groups: [{ id: 'builtin', label: '内置', items: [] }] }
}

/** 读：不存在就写一份空表种子，解析失败则报错并给空表 */
export function loadCommands(file = paths.COMMANDS_FILE) {
  if (!existsSync(file)) {
    const seed = emptySeed()
    try { writeAtomic(file, seed) } catch { /* 写不了就只在内存里用 */ }
    return { data: seed, error: null, migrated: false }
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || !Array.isArray(data.groups)) throw new Error('缺少 groups 数组')
    return { data, error: null, migrated: false }
  } catch (e) {
    return { data: { version: 1, groups: [] }, error: `commands.json 解析失败：${e.message}`, migrated: false }
  }
}

function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  if (existsSync(file)) {
    try { copyFileSync(file, file + '.bak') } catch { /* 备份失败不阻塞 */ }
  }
  renameSync(tmp, file)
}

export function saveCommands(data, file = paths.COMMANDS_FILE) {
  writeAtomic(file, data)
  return { ok: true, groups: data.groups.length, items: countItems(data) }
}

export function countItems(data) {
  return (data.groups || []).reduce((s, g) => s + (Array.isArray(g.items) ? g.items.length : 0), 0)
}

export function listItems(data) {
  const out = []
  for (const g of data.groups || []) {
    for (const it of g.items || []) out.push({ ...it, group: g.id, groupLabel: g.label })
  }
  return out
}

export function findItem(data, id) {
  return listItems(data).find((x) => x.id === id) || null
}

/**
 * 把指令库翻译成 `~/.dsh/live2d/shortcuts.json` 的白名单形状。
 *
 * 为什么还要这一份：插件（pet-bridge）跟舞台之间只有这一份**协议文件**，
 * 它不认识 commands.json。以前两边各存一份，指令 id 一改就「菜单里点得动、
 * 执行说没有这条指令」—— 现在 commands.json 是唯一真源，这里只是投影。
 */
export function toShortcutEntries(data) {
  return listItems(data).map((it) => ({
    id: it.id,
    label: it.label,
    cmd: it.cmd,
    args: it.args || [],
    mode: it.mode === 'shell' ? 'shell' : 'exec',
    cwd: it.cwd,
    capture: it.capture === true,
    allowExtraArgs: it.mode !== 'shell' && it.allowArgs === true,
  }))
}

/** 把当前指令库写成插件读的那份白名单（协议文件，字段名不能改）。
 *  注意写的是 **runtime/app 的镜像**：electron 往 `C://Users//...` 写会 EPERM，
 *  由 launch.mjs（node 进程）再镜像到 `~/.dsh/live2d/shortcuts.json`。 */
export function publishShortcuts(data, file = paths.SHORTCUTS_MIRROR) {
  const payload = {
    version: 1,
    _comment: '由桌宠从 main/config/commands.json 自动生成，改这里会被下次启动覆盖。',
    shortcuts: toShortcutEntries(data),
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return { ok: true, count: payload.shortcuts.length, file }
  } catch (e) {
    return { ok: false, error: e.message, file }
  }
}

/**
 * 校验一条指令。返回 { ok, item, errors[] }。
 * 宁可拒绝也不猜：id 重复、cmd 为空、shell 模式想带参数，全是明确的错误。
 */
export function validateItem(raw, data, { isNew = true } = {}) {
  const errors = []
  const it = {
    id: String(raw?.id || '').trim(),
    label: String(raw?.label || '').trim(),
    type: String(raw?.type || 'exe').trim(),
    cmd: String(raw?.cmd || '').trim(),
    args: Array.isArray(raw?.args) ? raw.args.map(String) : [],
    cwd: raw?.cwd ? String(raw.cwd) : null,
    mode: MODES.includes(raw?.mode) ? raw.mode : 'exec',
    capture: raw?.capture === true,
    visible: raw?.visible === true,
    timeoutMs: Math.max(1000, Math.min(600000, Number(raw?.timeoutMs) || 30000)),
    allowArgs: raw?.allowArgs === true,
  }
  if (!it.id) errors.push('id 不能为空')
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(it.id)) errors.push('id 只能用字母/数字/下划线/短横线（≤40）')
  if (!it.label) errors.push('名称不能为空')
  if (!TYPES.includes(it.type)) errors.push(`type 只能是 ${TYPES.join(' / ')}`)
  if (!it.cmd) errors.push('命令不能为空')
  if (it.mode === 'shell') {
    it.allowArgs = false
    if (it.type === 'exe' || it.type === 'shortcut') errors.push('shell 模式只用于 cmd/powershell/bat')
  }
  for (const a of [...it.args, ...(raw?.extraArgs || [])]) {
    if (/[\0\r\n]/.test(String(a))) errors.push('参数里不能有换行或 NUL')
  }
  if (it.cwd && !isAbsolute(it.cwd)) errors.push('cwd 必须是绝对路径')
  if (isNew) {
    const dup = listItems(data).some((x) => x.id === it.id)
    if (dup) errors.push(`id「${it.id}」已存在`)
    if (listItems(data).length >= MAX_ITEMS) errors.push(`最多 ${MAX_ITEMS} 条快捷操作，删一条再加`)
  }
  return { ok: errors.length === 0, item: it, errors }
}

/** 审计：一行一条 JSON，1 MB 轮转一份 .1 */
export function audit(entry, file = paths.AUDIT_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    let size = 0
    try { size = statSync(file).size } catch { size = 0 }
    if (size > 1024 * 1024) {
      try { renameSync(file, file + '.1') } catch { /* 占用中就续写 */ }
    }
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  } catch { /* 审计写不了不影响执行 */ }
}

export function readAudit(limit = 50, file = paths.AUDIT_FILE) {
  try {
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

/* -------------------------------------------------------------- 执行器 */

const running = new Map()     // id → { startedAt, source }

export function runningIds() {
  return [...running.keys()]
}

/**
 * 跑一条指令。
 *
 * @param {object} item validateItem 出来的指令
 * @param {string[]} extraArgs 运行时参数（只以 argv 追加；shell 模式直接拒绝）
 * @param {object} o { source: 'menu'|'driver'|'test' }
 * @returns {Promise<{ok, code?, output?, error?, ms}>}
 */
export function runCommand(item, extraArgs = [], o = {}) {
  return new Promise((resolve) => {
    if (!item) return resolve({ ok: false, error: '没有这条指令' })
    const extra = (Array.isArray(extraArgs) ? extraArgs : []).map(String).filter((s) => s !== '')
    if (extra.length && (item.mode === 'shell' || !item.allowArgs)) {
      return resolve({ ok: false, error: `${item.id} 不接受运行时参数` })
    }
    if (running.has(item.id)) {
      return resolve({ ok: false, error: `${item.id} 正在运行，等它结束再说` })
    }
    if (running.size >= MAX_CONCURRENT) {
      return resolve({ ok: false, error: `同时最多跑 ${MAX_CONCURRENT} 条指令，稍后再试` })
    }

    const t0 = Date.now()
    const source = o.source || 'menu'
    const finish = (r) => {
      running.delete(item.id)
      const out = {
        ...r,
        ms: Date.now() - t0,
        id: item.id,
        label: item.label,
      }
      audit({
        source, id: item.id, args: extra, code: r.code ?? null,
        ok: r.ok !== false, ms: out.ms, error: r.error || null,
        output: r.output ? String(r.output).slice(0, 500) : null,
      })
      resolve(out)
    }

    // shortcut：交给系统 shell 打开（文件 / 文件夹 / 程序都行），没有 argv 概念。
    //
    // 为什么这条路比 spawn 可靠：explorer.exe、taskmgr.exe 这类 autoElevate 程序，
    // 从 Electron 主进程（Chromium 会把自己放进 Job 对象）直接 CreateProcess 会拿到
    // 0xC0000142（DLL 初始化失败），实测必失败；shell.openPath 委托给已有 shell，不受影响。
    // 商店版程序（记事本/画图）直连也会崩，同样走这条。
    if (item.type === 'shortcut') {
      running.set(item.id, { startedAt: t0, source })
      try {
        const { shell } = requireCjs('electron')
        const target = expandEnv(item.cmd)
        shell.openPath(target).then((err) => finish(err
          ? { ok: false, error: `打不开 ${target}：${err}` }
          : { ok: true, opened: target }))
          .catch((e) => finish({ ok: false, error: String(e && e.message) }))
      } catch (e) {
        finish({ ok: false, error: 'shortcut 只能在舞台进程里跑：' + (e && e.message) })
      }
      return
    }

    const { exe, argv, shellMode } = buildSpawn(item, extra)
    if (!exe) return finish({ ok: false, error: '无法构造启动参数' })

    running.set(item.id, { startedAt: t0, source })
    let child
    try {
      child = spawn(exe, argv, {
        cwd: item.cwd || MAIN_ROOT,
        windowsHide: !item.visible,
        shell: shellMode,
        env: process.env,
      })
    } catch (e) {
      return finish({ ok: false, error: String((e && e.message) || e) })
    }

    // 输出按字节收，退出时再解码：中文 Windows 的 cmd/dir 吐的是 GBK（代码页 936），
    // 直接 toString('utf8') 会得到一串乱码 —— 默认示例「列出下载文件夹」就会看起来是坏的。
    const outChunks = []
    const errChunks = []
    let outBytes = 0
    let errBytes = 0
    let killedByTimeout = false
    const BYTE_CAP = MAX_CAPTURE * 8
    const keep = (chunks, n, d) => {
      chunks.push(d)
      return n + d.length > BYTE_CAP ? n + d.length - BYTE_CAP : n   // 超出就拿掉最前面的字节
    }
    const drain = (chunks, over) => {
      while (over > 0 && chunks.length) {
        const head = chunks[0]
        if (head.length <= over) { over -= head.length; chunks.shift() } else { chunks[0] = head.subarray(over); over = 0 }
      }
    }
    /** 先按 UTF-8 严格解，失败再按 GBK 解；都不行就退回宽松 UTF-8。 */
    const decode = (chunks) => {
      if (!chunks.length) return ''
      const buf = Buffer.concat(chunks)
      let text
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
      } catch {
        try { text = new TextDecoder('gbk').decode(buf) } catch { text = buf.toString('utf8') }
      }
      return text.length > MAX_CAPTURE ? text.slice(text.length - MAX_CAPTURE) : text
    }

    if (item.capture) {
      child.stdout?.on('data', (d) => { outBytes = keep(outChunks, outBytes, d); drain(outChunks, outBytes - BYTE_CAP) })
      child.stderr?.on('data', (d) => { errBytes = keep(errChunks, errBytes, d); drain(errChunks, errBytes - BYTE_CAP) })
    }

    const timer = setTimeout(() => {
      killedByTimeout = true
      try { child.kill('SIGKILL') } catch { /* 已经死了 */ }
    }, item.timeoutMs)
    if (timer.unref) timer.unref()

    // 不开 capture 的多半是 GUI（记事本/控制面板/浏览器）：它会一直活着，
    // 等它退出等于永远不返回 —— 以前就变成「点了没反应，30 秒后报超时」。
    // 这里给 1.2 秒观察窗：还活着就认为启动成功立刻返回；期间退出则按退出码判成败。
    let quick = null
    if (!item.capture) {
      quick = setTimeout(() => {
        finish({ ok: true, state: 'running', pid: child.pid })
      }, 1200)
      if (quick.unref) quick.unref()
    }

    child.on('error', (e) => {
      clearTimeout(timer)
      if (quick) clearTimeout(quick)
      finish({ ok: false, error: String((e && e.message) || e) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (quick) clearTimeout(quick)
      const out = decode(outChunks)
      const err = decode(errChunks)
      const output = [out.trim(), err.trim()].filter(Boolean).join('\n')
      if (killedByTimeout) return finish({ ok: false, code, error: `超时（>${item.timeoutMs}ms）已终止`, output })
      // 不捕获输出时只管「起没起来」：GUI 程序会一直活着，等它退出等于永远不返回。
      // 但「起来了又立刻崩」要和「成功」分开：0xC0000000 以上是 NTSTATUS 失败码
      // （0xC0000142 = DLL 初始化失败、0xC0000409 = 崩溃），这种必须报错，
      // 否则用户看到的就是「点了没反应」。
      if (!item.capture) {
        const c = Number(code) || 0
        if (c >= 0xc0000000) return finish({ ok: false, code: c, error: explainExitCode(c) })
        return finish({ ok: true, code: c })
      }
      finish({ ok: code === 0, code: code ?? 0, output, error: code === 0 ? null : `退出码 ${code}` })
    })
  })
}

/**
 * 展开 `%VAR%`（Windows 风格的环境变量）。
 *
 * 为什么需要：`cmd` / `bat` 走 cmd.exe，变量由它自己展开；但 `shortcut` / `exe` 走的是
 * shell.openPath / CreateProcess，不认 `%TEMP%` —— 默认示例里写 `%TEMP%` 才能换机器即用。
 */
export function expandEnv(text) {
  const raw = String(text || '')
  if (!raw.includes('%')) return raw
  return raw.replace(/%([^%\s]+)%/g, (m, name) => {
    const hit = process.env[name] ?? process.env[name.toUpperCase()]
    return hit === undefined ? m : hit
  })
}

/** 把 NTSTATUS 失败码翻成人话（只覆盖真踩过的几个） */
export function explainExitCode(code) {
  const c = Number(code) || 0
  const table = {
    0xc0000142: '程序拒绝启动（DLL 初始化失败）。常见于资源管理器、任务管理器这类需要提权的程序 —— 改用 type:"shortcut" 走系统打开',
    0xc0000409: '启动后立即崩溃（应用包激活失败）。商店版程序（记事本、画图）请改用 type:"shortcut"',
    0xc0000135: '缺少依赖 DLL',
    0xc0000005: '访问冲突（程序自己崩了）',
  }
  return table[c] || `进程异常退出（0x${(c >>> 0).toString(16).toUpperCase()}）`
}

/** 把指令翻译成 spawn 的 exe/argv。**不拼命令字符串**（shell 模式除外，它本来就是整串）。 */
export function buildSpawn(item, extra = []) {
  const args = [...(item.args || []), ...extra]
  if (item.mode === 'shell') {
    return { exe: item.cmd, argv: [], shellMode: true }
  }
  if (item.type === 'powershell') {
    return {
      exe: 'powershell.exe',
      argv: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', item.cmd, ...args],
      shellMode: false,
    }
  }
  if (item.type === 'bat') {
    return { exe: 'cmd.exe', argv: ['/d', '/c', item.cmd, ...args], shellMode: false }
  }
  if (item.type === 'cmd') {
    // cmd.exe 下用 /c 加一个「参数已分开」的命令：Windows 上 cmd 仍需要一个字符串，
    // 所以这里只允许单 token（可执行文件名或内置命令），参数走 argv 追加。
    return { exe: 'cmd.exe', argv: ['/d', '/s', '/c', item.cmd, ...args], shellMode: false }
  }
  // exe
  return { exe: item.cmd, argv: args, shellMode: false }
}
