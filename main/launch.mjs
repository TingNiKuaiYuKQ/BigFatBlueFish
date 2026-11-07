// 启动器：用一个「全新」的环境块拉起 Electron。
//
// 为什么不用 start.cmd 直接跑：本机环境块里同时存在 HTTPS_PROXY 与 https_proxy
// （Windows 环境变量大小写不敏感，这两条互为重复键）。重复键会让 CreateProcess
// 拿到的环境块不合法 —— PowerShell 的 Start-Process 直接报
// 「已添加项。字典中的关键字:HTTPS_PROXY」，cmd 也清不干净。
//
// Node 的 spawn 传 env 时是**重建**整个环境块（不是继承再改），
// 所以只要在这里显式列出需要的变量，重复键问题就彻底消失。
//
//   node launch.mjs            启动
//   node launch.mjs --debug    带 Chromium 日志
//   额外参数会原样透传给 Electron

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync, statSync, appendFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import paths from './modules/core/paths.cjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXE = join(paths.NODE_MODULES, 'electron', 'dist', 'electron.exe')

/* ------------------------------------------------------------------ 启动日志（0.5.1）
 *
 * 无控制台启动之后，launch.mjs 的 stdout 是黑洞（stdio:ignore），
 * 「双击没反应」将变成完全不可查。这里把所有输出同时追加到
 * runtime/logs/launch.log（1 MB 轮转一份 .1），启动器也写同一个文件。
 */
const LAUNCH_LOG = paths.LAUNCH_LOG
let logBroken = false
function appendLaunchLog(line) {
  if (logBroken) return
  try {
    mkdirSync(paths.RUNTIME_LOGS, { recursive: true })
    let size = 0
    try { size = statSync(LAUNCH_LOG).size } catch { size = 0 }
    if (size > 1024 * 1024) {
      try { renameSync(LAUNCH_LOG, LAUNCH_LOG + '.1') } catch { /* 占用中就直接续写 */ }
    }
    appendFileSync(LAUNCH_LOG, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { logBroken = true }
}
const _log = console.log.bind(console)
const _err = console.error.bind(console)
console.log = (...a) => { _log(...a); appendLaunchLog(a.map(String).join(' ')) }
console.error = (...a) => { _err(...a); appendLaunchLog('[err] ' + a.map(String).join(' ')) }

if (!existsSync(EXE)) {
  console.error(`找不到 Electron：${EXE}\n先运行 npm install`)
  process.exit(1)
}

// Chromium 的 --user-data-dir 指到 runtime/chromium，父目录必须提前存在。
mkdirSync(paths.CHROMIUM_DIR, { recursive: true })

// app 路径用绝对路径；cwd 指到 runtime/，让 NVIDIA/Chromium 之类的缓存不落在 main/ 根上。
const args = [HERE, '--no-sandbox']

// --force-device-scale-factor=1 是必须的。
//
// 本机缩放 175%（非整数）。透明无边框窗口在这种缩放下，每次 SetWindowPos
// 都会把尺寸顶大 1~2 DIP：实测拖 80 次 520×780 → 602×861，resize 事件 129 次，
// setSize 强行按回去也没用（系统层的事）。强制 1x 后同样 80 次移动尺寸完全不变。
//
// 代价是窗口尺寸要自己按 DPI 放大（main.cjs 里用注册表读到的比例乘上去），
// 这样物理尺寸不变、像素 1:1，既清晰又稳。
args.push('--force-device-scale-factor=1')

// --user-data-dir 必须显式给。
// 不给的话 Chromium 会去解析默认的 %APPDATA%\<name>，在本机这套环境下
// 解析阶段直接崩掉（退出码 0xffff7003，无任何日志），加上就好了。
// 顺便也让程序变成绿色便携：所有缓存都落在自己的目录里。
args.push(`--user-data-dir=${paths.CHROMIUM_DIR}`)

// Chromium 沙箱在本机起不来（不加 --no-sandbox 直接退出码 3）。
// 桌宠是本地自用小程序，这个取舍可以接受；要更严可以自己改回并排查驱动/杀软。
const passthrough = process.argv.slice(2)
if (passthrough.includes('--debug')) {
  args.push('--enable-logging=stderr', '--v=1')
  passthrough.splice(passthrough.indexOf('--debug'), 1)
}
args.push(...passthrough.filter((a) => a !== '--debug'))

// 只用这几个变量，其它一概不带：代理、ELECTRON_RUN_AS_NODE 都在这里被挡掉。
const env = {
  SYSTEMROOT: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  PATH: [
    'C:\\Windows\\system32',
    'C:\\Windows',
    'C:\\Windows\\System32\\Wbem',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  ].join(';'),
  TEMP: process.env.TEMP || 'C:\\Windows\\Temp',
  TMP: process.env.TMP || 'C:\\Windows\\Temp',
  USERPROFILE: process.env.USERPROFILE || '',
  APPDATA: process.env.APPDATA || '',
  LOCALAPPDATA: process.env.LOCALAPPDATA || '',
  HOMEDRIVE: 'C:',
  HOMEPATH: process.env.HOMEPATH || '',
  // 桌宠用不到代理；显式留空也能让 Chromium 不去读系统代理设置
  NO_PROXY: '*',
  no_proxy: '*',
}

console.log('[launch]', EXE, args.join(' '))

// 秒退且 code=0 几乎只有一种原因：单实例锁被上一个进程占着（Electron
// requestSingleInstanceLock 失败 → app.quit()）。上一个实例刚被 taskkill /
// 崩溃后 Windows 可能还短暂持锁，这时直接放弃会表现为「双击没反应」。
// 这里自动重试两次，间隔 800ms —— 比让用户再点一次靠谱。
let attempt = 0
function run() {
  attempt += 1
  const startedAt = Date.now()
  const child = spawn(EXE, args, {
    cwd: paths.RUNTIME_DIR,
    env,
    stdio: 'inherit',
    windowsHide: false,
  })

  child.on('exit', (code, signal) => {
    const lived = Date.now() - startedAt
    if (code === 0 && lived < 4000 && attempt < 3) {
      console.log(`[launch] 秒退（${lived}ms）——疑似上一实例未退干净，800ms 后重试（第 ${attempt} 次）`)
      setTimeout(run, 800)
      return
    }
    console.log(`[launch] 退出 code=${code} signal=${signal}`)
    try { stopMirror() } catch { /* 定时器早停了 */ }
    process.exit(code ?? 0)
  })
  child.on('error', (e) => {
    console.error('[launch] 启动失败', e)
    process.exit(1)
  })
}
run()

/* ------------------------------------------------------------------ 握手镜像
 *
 * 为什么由启动器来写 endpoint.json：
 *
 *   本机的安全策略把 `electron.exe` 往 `C:\Users\...` 的写入整个挡掉了 ——
 *   不是某个目录、不是 ACL，连「新建一个空文件」都报 EPERM(-4048)；
 *   同一个路径用 `node.exe` 写完全正常，连 `electron.exe` 以
 *   `ELECTRON_RUN_AS_NODE=1` 跑也一样被拦。等于说被拦的是这个二进制本身。
 *
 *   舞台（Electron 侧）因此只能把 endpoint 写进自己的 runtime/app；再由这里
 *   —— 一个 node 进程 —— 镜像到 `~/.dsh/live2d/endpoint.json` 给驾驶员读。
 *
 * 两条约束保持不变：
 *   · 父目录不存在就不写（没装 DSH 的机器上不该凭空建别人的目录）；
 *   · 原子替换（写 .tmp 再 rename），驾驶员不会读到半截 JSON。
 */
const HANDSHAKE_DIR = join(process.env.USERPROFILE || homedir(), '.dsh', 'live2d')
const HANDSHAKE = join(HANDSHAKE_DIR, 'endpoint.json')
const MIRROR = paths.ENDPOINT_MIRROR
// 指令白名单同理：commands.json 是唯一真源，舞台写进 runtime/app 的镜像，
// 这里再镜像到 ~/.dsh/live2d/shortcuts.json 给插件；不镜像插件就只能读到旧表。
const SHORTCUTS_HANDSHAKE = join(HANDSHAKE_DIR, 'shortcuts.json')
const SHORTCUTS_MIRROR = paths.SHORTCUTS_MIRROR

// --no-driver = 纯独立模式（测试/演示用），这时不该去碰驾驶员的握手文件。
// 之前漏了这一条：探针跑一次就把 endpoint.json 换成自己的（然后退出），
// 正经实例的握手被踩掉，插件直接连不上。
const MIRROR_ON = !passthrough.includes('--no-driver')

/**
 * 一条镜像通道：src（舞台写的 runtime 文件）→ dst（握手目录里的协议文件）。
 * 只在 dst 的父目录已存在时才写 —— 没装 DSH 的机器上不该凭空建别人的目录。
 */
function makeMirror(src, dst, label) {
  return { src, dst, label, stamp: 0, warned: false, waitLogged: false, lastError: '' }
}

const mirrors = [
  makeMirror(MIRROR, HANDSHAKE, '握手'),
  makeMirror(SHORTCUTS_MIRROR, SHORTCUTS_HANDSHAKE, '指令白名单'),
]

/** @returns {boolean} 这次是否真的写了 */
function mirrorOnce(m) {
  if (!existsSync(m.src)) {
    if (!m.waitLogged) {
      m.waitLogged = true
      console.log(`[launch] 等待${m.label}镜像文件：` + m.src)
    }
    return false
  }
  if (!existsSync(HANDSHAKE_DIR)) return false   // 没装 DSH → 不创建
  const stamp = statSync(m.src).mtimeMs
  if (stamp === m.stamp) return false
  const text = readFileSync(m.src, 'utf8')
  JSON.parse(text)                               // 校验完整性，半截文件不镜像
  // 临时名带 pid：上一实例被强杀后 Windows 可能短暂持有固定 .tmp，
  // 复用同名会一直 EPERM（server.mjs 的 endpoint 写入也踩过同一个坑）。
  const tmp = `${m.dst}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, m.dst)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 没写出来就算了 */ }
    throw e
  }
  m.stamp = stamp
  m.lastError = ''
  if (!m.warned) {
    console.log(`[launch] ${m.label}已镜像 →`, m.dst)
    m.warned = true
  }
  return true
}

const mirrorTimer = setInterval(() => {
  if (!MIRROR_ON) return
  for (const m of mirrors) {
    try {
      mirrorOnce(m)
    } catch (e) {
      // 只记变化后的错误，避免 600ms 刷屏；静默失败会让「插件连不上」变得没法查。
      const msg = `${e && e.code ? e.code + ': ' : ''}${(e && e.message) || e}`
      if (msg !== m.lastError) {
        m.lastError = msg
        console.error(`[launch] ${m.label}镜像失败：` + msg)
      }
    }
  }
}, 600)

// 进程真正退出时收尾（重试期间不要清掉镜像定时器，否则重启后不再镜像）
function stopMirror() { clearInterval(mirrorTimer) }
