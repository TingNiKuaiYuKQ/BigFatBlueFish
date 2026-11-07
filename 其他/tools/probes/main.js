// One-off probes for the 0.5.x plan. Not part of the product.
const { app, BrowserWindow, screen, desktopCapturer, shell } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const argv = process.argv.slice(1)

function arg(name, fallback = '') {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(`--${name}=`.length)
  const i = argv.indexOf(`--${name}`)
  if (i >= 0) {
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) return next
    return 'true'
  }
  return fallback
}

const has = (name) => argv.includes(`--${name}`) || argv.some((a) => a.startsWith(`--${name}=`))
const out = (obj) => {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const mode = arg('mode')
const marker = arg('marker')
const here = __dirname
const finish = (code = 0) => setTimeout(() => app.exit(code), 250)

function writeJson(file, obj) {
  if (!file) return
  try { fs.writeFileSync(file, JSON.stringify(obj)) } catch (e) { out({ error: 'marker: ' + String(e) }) }
}

function writeMarker(extra = {}) {
  writeJson(marker, { at: Date.now(), pid: process.pid, mode, ...extra })
}

// ---- launcher simulation: GUI subsystem parent -> hidden node hop -> electron ----
if (has('launcher')) {
  const hop = path.join(here, 'hop.mjs')
  const electron = process.execPath
  const markerPath = marker || path.join(here, 'launcher-child.json')
  const userData = arg('probe-ud', '') || arg('user-data-dir', path.join(here, '.userdata', 'hop-' + process.pid))
  const childMode = arg('child-mode', 'childready')
  const t0 = Date.now()
  try {
    const c = spawn(process.env.PROBE_NODE || 'node', [hop, electron, here, markerPath, userData, childMode], {
      cwd: here,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    c.unref()
    out({ mode: 'launcher', spawned: c.pid, spawnMs: Date.now() - t0 })
  } catch (e) {
    out({ mode: 'launcher', error: String(e && (e.stack || e)) })
  }
  setTimeout(() => process.exit(0), 120)
  return
}

if (mode === 'opacity') app.commandLine.appendSwitch('force-device-scale-factor', '1')

function samplePixel(x, y) {
  const ps = path.join(here, 'pixel.ps1')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, String(x), String(y)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  })
  const text = String(r.stdout || '').trim().split(/\r?\n/).pop() || ''
  const m = text.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!m) return { error: text || String(r.stderr || '').slice(0, 300) }
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
}

async function runOpacity() {
  // A known white backdrop makes the blend value an exact alpha measurement.
  const back = new BrowserWindow({
    x: 2140,
    y: 60,
    width: 400,
    height: 400,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    roundedCorners: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: true,
    backgroundColor: '#ffffff',
    webPreferences: { backgroundThrottling: false },
  })
  back.setAlwaysOnTop(true, 'floating')
  back.show()
  back.moveTop()
  const win = new BrowserWindow({
    x: 2140,
    y: 60,
    width: 320,
    height: 320,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    roundedCorners: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: true,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  await win.loadFile(path.join(here, 'opacity.html'))
  win.show()
  win.focus()
  win.moveTop()
  await sleep(900)

  const b = win.getBounds()
  const px = Math.round(b.x + b.width / 2)
  const py = Math.round(b.y + b.height / 2)
  const d = screen.getPrimaryDisplay()
  const backOnly = { x: 2500, y: 420 }
  const pageCenter = async () => {
    try {
      const img = await win.webContents.capturePage()
      const size = img.getSize()
      const bmp = img.getBitmap()
      const idx = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4
      return { b: bmp[idx], g: bmp[idx + 1], r: bmp[idx + 2], size }
    } catch (e) { return { error: String(e) } }
  }
  const snap = (phase) => {
    out({
      mode: 'opacity',
      phase,
      rgb: samplePixel(px, py),
      backdrop: samplePixel(backOnly.x, backOnly.y),
      getOpacity: win.getOpacity(),
    })
  }
  out({ mode: 'opacity', phase: 'meta', bounds: b, display: { bounds: d.bounds, size: d.size, scaleFactor: d.scaleFactor }, sample: { x: px, y: py }, visible: win.isVisible(), focused: win.isFocused(), pageCenter: await pageCenter() })
  snap('before (opacity 1)')

  win.setOpacity(0.5)
  await sleep(900)
  snap('after win.setOpacity(0.5)')

  win.setOpacity(0.25)
  await sleep(900)
  snap('after win.setOpacity(0.25)')

  win.setOpacity(1)
  await win.webContents.executeJavaScript(`
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.querySelector('div').style.opacity = '0.5'
  `)
  await sleep(900)
  snap('after CSS div opacity 0.5')

  win.destroy()
  back.destroy()
  out({ mode: 'opacity', done: true })
  finish(0)
}

async function runDisplays() {
  const list = screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
    size: d.size,
    scaleFactor: d.scaleFactor,
    rotation: d.rotation,
    internal: d.internal,
  }))
  out({ mode: 'displays', primary: screen.getPrimaryDisplay().id, displays: list, argv })
  finish(0)
}

async function runFullscreen() {
  const d = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    fullscreen: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00ff00',
    webPreferences: { backgroundThrottling: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.focus()
  win.moveTop()
  await sleep(600)
  const hwndBuf = win.getNativeWindowHandle()
  const hwnd = Number(hwndBuf.readBigUInt64LE(0))
  out({ mode: 'fullscreen', bounds: win.getBounds(), displayBounds: d.bounds, hwnd })
  writeMarker({ bounds: win.getBounds(), hwnd })
  setTimeout(() => { win.destroy(); app.exit(0) }, 4200)
}

async function runMaximized() {
  const win = new BrowserWindow({
    x: 120,
    y: 120,
    width: 800,
    height: 600,
    show: true,
    alwaysOnTop: true,
    backgroundColor: '#ffff00',
    webPreferences: { backgroundThrottling: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.maximize()
  win.show()
  win.focus()
  win.moveTop()
  await sleep(800)
  const hwndBuf = win.getNativeWindowHandle()
  const hwnd = Number(hwndBuf.readBigUInt64LE(0))
  out({ mode: 'maximized', bounds: win.getBounds(), maximized: win.isMaximized(), hwnd })
  writeMarker({ bounds: win.getBounds(), hwnd })
  setTimeout(() => { win.destroy(); app.exit(0) }, 3600)
}

async function runLockHold() {
  const lock = app.requestSingleInstanceLock()
  if (!lock) {
    writeJson(marker ? marker + '.second' : '', { at: Date.now(), pid: process.pid, locked: false })
    out({ mode: 'lockhold', role: 'second', locked: false })
    app.exit(0)
    return
  }
  app.on('second-instance', () => {
    writeJson(marker ? marker + '.second' : '', { at: Date.now(), pid: process.pid, event: 'second-instance' })
    out({ mode: 'lockhold', role: 'first', event: 'second-instance' })
  })
  await app.whenReady()
  writeMarker({ role: 'first', locked: true })
  const keep = new BrowserWindow({ width: 1, height: 1, show: false })
  out({ mode: 'lockhold', role: 'first', ready: true })
  setTimeout(() => { keep.destroy(); app.exit(0) }, 5200)
}

async function runSpawnHidden() {
  const child = spawn('node', ['-e', 'setTimeout(()=>{},5000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  writeMarker({ childPid: child.pid })
  out({ mode: 'spawnhidden', childPid: child.pid })
  await sleep(5000)
  app.exit(0)
}

async function runMkLinks() {
  const electronLnk = path.join(here, 'electron-run.lnk')
  const nodeLnk = path.join(here, 'node-run.lnk')
  // Keep the shortcut command line short: Windows truncates the .lnk arguments field.
  // 临时件放系统临时目录：以前写死了作者的 D 盘根目录，换台机器就跑不了。
  const electronMarker = path.join(os.tmpdir(), 'bfbf-pm.json')
  const nodePidFile = path.join(os.tmpdir(), 'bfbf-pn.txt')
  const shortUserData = path.join(os.tmpdir(), 'bfbf-pu')
  for (const f of [electronLnk, nodeLnk, electronMarker, nodePidFile]) {
    try { fs.unlinkSync(f) } catch { /* absent */ }
  }
  const electronArgs = [
    `"${here}"`,
    '--no-sandbox',
    '--force-device-scale-factor=1',
    '--mode=marker',
    `--marker="${electronMarker}"`,
    `--user-data-dir="${shortUserData}"`,
  ].join(' ')
  const nodeArgs = [
    `"${path.join(here, 'console-hold.mjs')}"`,
    `"${nodePidFile}"`,
  ].join(' ')
  let eOk = false
  let nOk = false
  try {
    eOk = shell.writeShortcutLink(electronLnk, 'create', {
      target: process.execPath,
      args: electronArgs,
      cwd: here,
      description: 'pet probe electron',
      icon: process.execPath,
      iconIndex: 0,
    })
  } catch (e) { out({ mode: 'mklinks', electronError: String(e) }) }
  try {
    nOk = shell.writeShortcutLink(nodeLnk, 'create', {
      target: 'C:\\Program Files\\nodejs\\node.exe',
      args: nodeArgs,
      cwd: here,
      description: 'pet probe node',
      icon: 'C:\\Program Files\\nodejs\\node.exe',
      iconIndex: 0,
    })
  } catch (e) { out({ mode: 'mklinks', nodeError: String(e) }) }
  const read = (p) => {
    try { return shell.readShortcutLink(p) } catch (e) { return { error: String(e) } }
  }
  const info = {
    mode: 'mklinks',
    electron: { ok: eOk, lnk: electronLnk, read: read(electronLnk) },
    node: { ok: nOk, lnk: nodeLnk, read: read(nodeLnk) },
    launch: {},
  }
  if (eOk && nOk) {
    info.launch.electronError = await shell.openPath(electronLnk)
    info.launch.nodeError = await shell.openPath(nodeLnk)
    const waitFile = async (file, ms) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        if (fs.existsSync(file)) return true
        await sleep(100)
      }
      return false
    }
    info.launch.electronMarker = (await waitFile(electronMarker, 7000))
      ? (() => { try { return JSON.parse(fs.readFileSync(electronMarker, 'utf8')) } catch { return 'bad-json' } })()
      : null
    info.launch.nodePid = (await waitFile(nodePidFile, 7000))
      ? Number(String(fs.readFileSync(nodePidFile, 'utf8')).trim()) || 0
      : 0
  }
  out(info)
  finish(eOk && nOk ? 0 : 1)
}

async function runLinkLength() {
  const res = []
  for (const n of [80, 160, 200, 240, 250, 255, 256, 260, 280, 320, 400]) {
    const p = path.join(here, `len-${n}.lnk`)
    const args = '--pad=' + 'a'.repeat(n)
    let ok = false
    let err = ''
    try {
      ok = shell.writeShortcutLink(p, 'create', { target: process.execPath, args, cwd: here, description: 'len probe' })
    } catch (e) { err = String(e) }
    let got = null
    try { got = shell.readShortcutLink(p).args } catch (e) { err = String(e) }
    res.push({ n, requested: args.length, ok, readLength: got ? got.length : null, exact: got === args, err })
  }
  out({ mode: 'linklength', res })
  finish(0)
}

async function runMarker() {
  writeMarker({ role: 'marker' })
  out({ mode: 'marker', pid: process.pid })
  await sleep(4200)
  app.exit(0)
}

async function runChildReady() {
  await app.whenReady()
  writeMarker({ role: 'childready' })
  out({ mode: 'childready', pid: process.pid })
  await sleep(200)
  app.exit(0)
}

app.whenReady().then(async () => {
  switch (mode) {
    case 'opacity': return runOpacity()
    case 'displays': return runDisplays()
    case 'fullscreen': return runFullscreen()
    case 'maximized': return runMaximized()
    case 'lockhold': return runLockHold()
    case 'spawnhidden': return runSpawnHidden()
    case 'mklinks': return runMkLinks()
    case 'linklength': return runLinkLength()
    case 'marker': return runMarker()
    case 'childready': return runChildReady()
    default:
      out({ error: 'unknown mode', mode, argv })
      finish(2)
  }
}).catch((e) => {
  out({ error: String(e && (e.stack || e)) })
  finish(1)
})
