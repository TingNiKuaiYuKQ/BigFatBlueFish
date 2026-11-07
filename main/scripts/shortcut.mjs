// 快捷方式助手（node 进程）：写/删 .lnk，读状态。
//
// 快捷方式的目标是 **wscript.exe**，参数是生成的 main/launcher.vbs：
//
//   wscript（GUI 子系统）→ launcher.vbs → node launch.mjs → electron
//
// 为什么不用 electron.exe 做启动器：本机安全策略会连 electron 的子进程一起
// 挡在 ~/.dsh 外（实测 EPERM），launch.mjs 的 endpoint 镜像写不出去，插件就
// 找不到桌宠。WSH 从 Explorer 直接启动时不在 electron 进程树里，node 正常。
// 为什么不用 node.exe 直接做目标：node 是控制台子系统，会闪黑框。
//
// 实现走 PowerShell 的 WScript.Shell COM（Windows 自带，无第三方依赖）。
// 命令用 -EncodedCommand（UTF-16LE base64）传：中文路径/参数不过控制台代码页。
//
//   node main/scripts/shortcut.mjs status
//   node main/scripts/shortcut.mjs install            # launcher.vbs + 根 launcher + 桌面 + 开始菜单
//   node main/scripts/shortcut.mjs autostart on|off   # Startup 目录
//
// 输出：一行 JSON。

import { spawnSync } from 'node:child_process'
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAIN_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(MAIN_ROOT, '..')
const SYSTEM32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
const WSCRIPT = join(SYSTEM32, 'wscript.exe')
const LAUNCH_SCRIPT = join(MAIN_ROOT, 'launch.mjs')
const LAUNCHER_VBS = join(MAIN_ROOT, 'launcher.vbs')
const ICON = join(MAIN_ROOT, 'deps', 'node_modules', 'electron', 'dist', 'electron.exe')
const EXE = WSCRIPT

const APPDATA = process.env.APPDATA || ''
const USERPROFILE = process.env.USERPROFILE || ''
const desktop = join(USERPROFILE, 'Desktop')
const startMenu = APPDATA ? join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : ''
const startup = APPDATA ? join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : ''

/** 快捷方式参数：**必须 ≤259 字符**（实测 261 起被截断），只放 vbs 路径 */
const ARGS = `"${LAUNCHER_VBS}"`

const vbsStr = (s) => '"' + String(s).replace(/"/g, '""') + '"'

/**
 * 生成 launcher.vbs（UTF-16LE + BOM）。
 * 把 node 路径写死在脚本里，避免依赖 Explorer 的 PATH；仓库移动后重跑 install 即可。
 */
function writeLauncherVbs() {
  const node = process.execPath
  const lines = [
    'Option Explicit',
    'Dim sh, fso, node, script, cmd',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `node = ${vbsStr(node)}`,
    `script = ${vbsStr(LAUNCH_SCRIPT)}`,
    'If Not fso.FileExists(node) Then',
    '  MsgBox "找不到 Node.js：" & node & vbCrLf & "请安装 Node.js 22+ 后重试。", vbCritical, "桌宠启动失败"',
    '  WScript.Quit 1',
    'End If',
    'If Not fso.FileExists(script) Then',
    '  MsgBox "找不到启动脚本：" & script, vbCritical, "桌宠启动失败"',
    '  WScript.Quit 1',
    'End If',
    `sh.CurrentDirectory = ${vbsStr(MAIN_ROOT)}`,
    'cmd = """" & node & """ """ & script & """"',
    'sh.Run cmd, 0, False',
    '',
  ]
  mkdirSync(MAIN_ROOT, { recursive: true })
  // 先写 BOM：wscript 默认按 ANSI 读无 BOM 文件，中文路径会乱。
  writeFileSync(LAUNCHER_VBS, '\uFEFF' + lines.join('\r\n'), { encoding: 'utf16le' })
  return { ok: true, path: LAUNCHER_VBS, node }
}

/** 从 PowerShell 的 CLIXML 噪声里抽出真正的错误行（给用户 / 日志看的那一句） */
function cleanPsError(err, out) {
  const text = String(err || '')
  if (text.includes('<Objs')) {
    const hits = [...text.matchAll(/<S S="(?:error|warning)">([\s\S]*?)<\/S>/g)].map((m) => m[1])
    if (hits.length) return hits.join(' / ').replace(/\s+/g, ' ').slice(0, 400)
    return 'PowerShell 返回错误（详见 runtime/logs/shortcut-helper.log）'
  }
  return (text || out || '').replace(/\s+/g, ' ').slice(0, 400)
}

function runPs(script) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
    { encoding: 'utf8', windowsHide: true, timeout: 25000 })
  const out = (r.stdout || '').trim()
  const err = (r.stderr || '').trim()
  // PowerShell 的报错在 CLIXML 里会带一大段进度噪声，且应用侧看不到控制台 ——
  // 全部原样落盘到 runtime/logs/shortcut-helper.log，出问题直接看这个文件。
  if ((r.status !== 0 || err) && process.env.PET_SHORTCUT_LOG !== '0') {
    try {
      const { appendFileSync, mkdirSync } = require('node:fs')
      mkdirSync(join(MAIN_ROOT, 'runtime', 'logs'), { recursive: true })
      appendFileSync(join(MAIN_ROOT, 'runtime', 'logs', 'shortcut-helper.log'),
        `[${new Date().toISOString()}] code=${r.status} err=${err.slice(0, 4000)} out=${out.slice(0, 500)}\n`, 'utf8')
    } catch { /* 日志写不了不影响主流程 */ }
  }
  return {
    code: r.status,
    out,
    err,
    failed: r.error ? String(r.error.message) : '',
  }
}

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`

function makeLinkScript(linkPath, description) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$dir = Split-Path -Parent ${psq(linkPath)}`,
    'if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }',
    '$W = New-Object -ComObject WScript.Shell',
    `$s = $W.CreateShortcut(${psq(linkPath)})`,
    `$s.TargetPath = ${psq(EXE)}`,
    `$s.Arguments = ${psq(ARGS)}`,
    `$s.WorkingDirectory = ${psq(MAIN_ROOT)}`,
    `$s.IconLocation = ${psq((existsSync(ICON) ? ICON : EXE) + ',0')}`,
    `$s.Description = ${psq(description)}`,
    '$s.Save()',
    "Write-Output 'ok'",
  ].join('\r\n')
}

function writeLink(linkPath, description) {
  if (!linkPath) return { ok: false, error: '目标目录不可用' }
  try { writeLauncherVbs() } catch (e) { return { ok: false, error: '写 launcher.vbs 失败：' + ((e && e.message) || e) } }
  if (!existsSync(EXE)) return { ok: false, error: '找不到 wscript.exe' }
  const r = runPs(makeLinkScript(linkPath, description))
  const ok = r.code === 0 && existsSync(linkPath)
  if (!ok) {
    return { ok: false, error: `写入失败（powershell code=${r.code}）：${cleanPsError(r.err, r.out)}`.slice(0, 400) }
  }
  return { ok: true, path: linkPath }
}

function removeLink(linkPath) {
  try {
    if (linkPath && existsSync(linkPath)) unlinkSync(linkPath)
    return { ok: true, path: linkPath }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

function status() {
  return {
    ok: true,
    mainRoot: MAIN_ROOT,
    launcherVbs: { path: LAUNCHER_VBS, exists: existsSync(LAUNCHER_VBS) },
    target: WSCRIPT,
    args: ARGS,
    argsLength: ARGS.length,
    links: {
      launcher: { path: join(REPO_ROOT, 'launcher.lnk'), exists: existsSync(join(REPO_ROOT, 'launcher.lnk')) },
      desktop: { path: join(desktop, '桌宠.lnk'), exists: existsSync(join(desktop, '桌宠.lnk')) },
      startMenu: { path: startMenu ? join(startMenu, '桌宠.lnk') : '', exists: !!(startMenu && existsSync(join(startMenu, '桌宠.lnk'))) },
      startup: { path: startup ? join(startup, '桌宠.lnk') : '', exists: !!(startup && existsSync(join(startup, '桌宠.lnk'))) },
    },
  }
}

const cmd = String(process.argv[2] || '').trim()

if (cmd === 'status') {
  console.log(JSON.stringify(status()))
} else if (cmd === 'write') {
  // 给 main.cjs 用的单条写入：write <linkPath> [描述]
  const linkPath = String(process.argv[3] || '').trim()
  const desc = String(process.argv[4] || '桌宠').trim()
  console.log(JSON.stringify(writeLink(linkPath, desc)))
} else if (cmd === 'install') {
  const v = writeLauncherVbs()
  const r = writeLink(join(REPO_ROOT, 'launcher.lnk'), '启动桌宠')
  const d = writeLink(join(desktop, '桌宠.lnk'), '启动桌宠')
  const m = writeLink(startMenu ? join(startMenu, '桌宠.lnk') : '', '启动桌宠')
  console.log(JSON.stringify({ ok: v.ok && (r.ok || d.ok || m.ok), launcherVbs: v, launcher: r, desktop: d, startMenu: m }))
} else if (cmd === 'autostart') {
  const on = String(process.argv[3] || '') === 'on'
  if (!startup) {
    console.log(JSON.stringify({ ok: false, error: '拿不到 APPDATA，无法定位 Startup 目录' }))
  } else if (on) {
    console.log(JSON.stringify(writeLink(join(startup, '桌宠.lnk'), '桌宠（开机自启）')))
  } else {
    console.log(JSON.stringify(removeLink(join(startup, '桌宠.lnk'))))
  }
} else {
  console.log(JSON.stringify({ ok: false, error: '用法: status | install | autostart on|off' }))
}
