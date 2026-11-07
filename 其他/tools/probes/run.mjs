// Orchestrates the one-off probes. Writes results.json next to this file.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ELECTRON = path.resolve(HERE, '../../../main/deps/node_modules/electron/dist/electron.exe')
const NODE = 'C:/Program Files/nodejs/node.exe'
const OBSERVER = path.join(HERE, 'observer.ps1')
const FOCUS = path.join(HERE, 'focus.ps1')
const WRITE_PROBE = path.join(HERE, 'write-probe.cjs')
const results = {}
// Same clean block launch.mjs builds: no duplicate proxy keys, no ELECTRON_RUN_AS_NODE.
const BASE_ENV = {
  SYSTEMROOT: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  PATH: [
    'C:\\Windows\\system32',
    'C:\\Windows',
    'C:\\Windows\\System32\\Wbem',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    'C:\\Program Files\\nodejs',
  ].join(';'),
  TEMP: process.env.TEMP || 'C:\\Windows\\Temp',
  TMP: process.env.TMP || 'C:\\Windows\\Temp',
  USERPROFILE: process.env.USERPROFILE || '',
  APPDATA: process.env.APPDATA || '',
  LOCALAPPDATA: process.env.LOCALAPPDATA || '',
  HOMEDRIVE: 'C:',
  HOMEPATH: process.env.HOMEPATH || '',
  NO_PROXY: '*',
  no_proxy: '*',
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const udArgs = (ud) => [`--user-data-dir=${ud}`, `--probe-ud=${ud}`]

function rm(file) {
  try { fs.unlinkSync(file) } catch { /* absent */ }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function jsonLines(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { out.push(JSON.parse(t)) } catch { /* ignore */ }
  }
  return out
}

function run(cmd, args, { timeout = 30000, env = BASE_ENV, cwd = HERE } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timed = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { timed = true; try { child.kill() } catch { /* gone */ } }, timeout)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timed, ms: Date.now() - t0, stdout, stderr })
    })
  })
}

function runElectron(args, opts) {
  return run(ELECTRON, [HERE, '--no-sandbox', '--force-device-scale-factor=1', ...args], opts)
}

function spawnElectron(args) {
  return spawn(ELECTRON, [HERE, '--no-sandbox', '--force-device-scale-factor=1', ...args], { cwd: HERE, env: BASE_ENV, windowsHide: true, stdio: 'ignore' })
}

function closed(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
}

async function waitFile(file, timeout = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (fs.existsSync(file)) return true
    await sleep(50)
  }
  return false
}

function median(list) {
  const a = [...list].sort((x, y) => x - y)
  if (!a.length) return null
  return a[Math.floor(a.length / 2)]
}

function windowHandle(pid) {
  const ps = `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { Write-Output ("{0}|{1}" -f $p.MainWindowHandle, $p.MainWindowTitle) } else { Write-Output 'gone' }`
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })
  const line = String(r.stdout || '').trim().split(/\r?\n/).pop() || 'gone'
  if (line === 'gone') return { alive: false, handle: 0, title: '' }
  const [h, ...rest] = line.split('|')
  return { alive: true, handle: Number(h) || 0, title: rest.join('|') }
}

function cpuSeconds(pid) {
  const ps = `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.CPU } else { '' }`
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })
  const n = Number(String(r.stdout || '').trim())
  return Number.isFinite(n) ? n : null
}

function focusWindow(hwnd) {
  if (!hwnd) return
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FOCUS, String(hwnd)], { windowsHide: true, timeout: 10000 })
}

const ONLY = process.argv.slice(2)
// Opacity/fullscreen put windows in front of the user. They only run when asked by name.
const INTRUSIVE = new Set(['opacity', 'fullscreenObserver'])
async function section(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return
  if (!ONLY.length && INTRUSIVE.has(name)) return
  process.stdout.write(`\n== ${name} ==\n`)
  try {
    results[name] = await fn()
  } catch (e) {
    results[name] = { error: String(e && (e.stack || e)) }
  }
  process.stdout.write(JSON.stringify(results[name], null, 2) + '\n')
}

await section('displays', async () => {
  const ud = path.join(HERE, '.userdata', 'displays')
  const r = await runElectron(['--mode=displays', ...udArgs(ud)], { timeout: 20000 })
  const line = jsonLines(r.stdout).find((x) => x.mode === 'displays')
  return line || { error: 'no displays line', code: r.code, stdout: r.stdout.slice(0, 500), stderr: r.stderr.slice(0, 500) }
})

await section('opacity', async () => {
  const ud = path.join(HERE, '.userdata', 'opacity')
  const r = await runElectron(['--mode=opacity', ...udArgs(ud)], { timeout: 45000 })
  return { lines: jsonLines(r.stdout).filter((x) => x.mode === 'opacity'), code: r.code, stderr: r.stderr.slice(0, 400) }
})

await section('startup', async () => {
  async function onceChild() {
    const marker = path.join(HERE, '.userdata', `child-${process.pid}-${Date.now()}-${Math.random()}.json`)
    const ud = path.join(HERE, '.userdata', `child-ud-${process.pid}-${Date.now()}-${Math.random()}`)
    rm(marker)
    const t0 = Date.now()
    const child = spawnElectron(['--mode=childready', '--marker', marker, ...udArgs(ud)])
    const ok = await waitFile(marker, 15000)
    const ms = ok ? Date.now() - t0 : null
    await closed(child)
    return { ms, ok }
  }
  async function onceLauncher() {
    const marker = path.join(HERE, '.userdata', `launch-${process.pid}-${Date.now()}-${Math.random()}.json`)
    const ud = path.join(HERE, '.userdata', `launch-ud-${process.pid}-${Date.now()}-${Math.random()}`)
    rm(marker)
    const t0 = Date.now()
    const child = spawnElectron(['--launcher', '--marker', marker, ...udArgs(ud)])
    let launcherExitMs = null
    const launcherClose = new Promise((resolve) => child.once('close', () => {
      launcherExitMs = Date.now() - t0
      resolve()
    }))
    const ok = await waitFile(marker, 15000)
    const ms = ok ? Date.now() - t0 : null
    await launcherClose
    return { ms, ok, launcherExitMs }
  }
  async function onceNode() {
    const t0 = Date.now()
    const r = await run(NODE, ['-e', 'process.exit(0)'], { timeout: 10000 })
    return { ms: r.ms, code: r.code }
  }

  await onceChild()
  await onceLauncher()
  await onceNode()

  const child = []
  const launcher = []
  const node = []
  for (let i = 0; i < 5; i += 1) {
    child.push(await onceChild())
    launcher.push(await onceLauncher())
    node.push(await onceNode())
  }
  const clean = (list) => list.map((x) => x.ms).filter((x) => Number.isFinite(x))
  return {
    childReadyMs: { runs: child, median: median(clean(child)) },
    launcherToChildReadyMs: { runs: launcher, median: median(clean(launcher)) },
    nodeStartupMs: { runs: node, median: median(clean(node)) },
    launcherOverheadMedianMs: median(clean(launcher)) - median(clean(child)),
  }
})

await section('singleInstance', async () => {
  async function scenario(label, useLauncher) {
    const ud = path.join(HERE, '.userdata', `lock-${label}-${Date.now()}`)
    const m1 = path.join(HERE, '.userdata', `lock-${label}-first.json`)
    const m2 = path.join(HERE, '.userdata', `lock-${label}-second.json`)
    for (const f of [m1, m1 + '.second', m2, m2 + '.second']) rm(f)
    const first = useLauncher
      ? spawnElectron(['--launcher', '--child-mode=lockhold', '--marker', m1, ...udArgs(ud)])
      : spawnElectron(['--mode=lockhold', '--marker', m1, ...udArgs(ud)])
    const ready = await waitFile(m1, 15000)
    const t0 = Date.now()
    const second = await runElectron(['--mode=lockhold', '--marker', m2, ...udArgs(ud)], { timeout: 15000 })
    const secondMs = Date.now() - t0
    const firstSecondInstance = fs.existsSync(m1 + '.second')
    const secondOwn = fs.existsSync(m2 + '.second')
    await closed(first)
    await sleep(500)
    return {
      ready,
      secondExitCode: second.code,
      secondExitMs: secondMs,
      firstSawSecondInstance: firstSecondInstance,
      secondSawLockFalse: secondOwn,
      secondStdout: second.stdout.slice(0, 300),
    }
  }
  return {
    direct: await scenario('direct', false),
    viaLauncher: await scenario('launcher', true),
  }
})

await section('hiddenNodeChild', async () => {
  const marker = path.join(HERE, '.userdata', 'spawnhidden.json')
  const ud = path.join(HERE, '.userdata', 'spawnhidden-ud')
  rm(marker)
  const child = spawnElectron(['--mode=spawnhidden', '--marker', marker, ...udArgs(ud)])
  const ok = await waitFile(marker, 15000)
  const meta = readJson(marker)
  await sleep(1200)
  const handle = meta && meta.childPid ? windowHandle(meta.childPid) : null
  await closed(child)
  return { ok, meta, childWindow: handle }
})

await section('shortcutLinks', async () => {
  const r = await runElectron(['--mode=mklinks', `--user-data-dir=${path.join(HERE, '.userdata', 'mklinks')}`], { timeout: 25000 })
  const info = jsonLines(r.stdout).find((x) => x.mode === 'mklinks')
  if (!info || !info.electron || !info.node) return { error: 'mklinks failed', info, stderr: r.stderr.slice(0, 500) }

  await sleep(500)
  const eMeta = info.launch && info.launch.electronMarker
  const eHandle = eMeta && eMeta.pid ? windowHandle(eMeta.pid) : null
  const nPid = (info.launch && info.launch.nodePid) || 0
  const nHandle = nPid ? windowHandle(nPid) : null

  return {
    links: info,
    electron: { launched: !!eMeta, marker: eMeta, window: eHandle },
    nodeConsoleControl: { launched: !!nPid, pid: nPid, window: nHandle },
  }
})

await section('fullscreenObserver', async () => {
  const samples = []
  let buf = ''
  let stderr = ''
  const obs = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OBSERVER, '-IntervalMs', '2000'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  obs.stdout.setEncoding('utf8')
  obs.stderr.setEncoding('utf8')
  obs.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { samples.push(JSON.parse(line)) } catch { /* ignore */ }
    }
  })
  obs.stderr.on('data', (d) => { stderr += d })

  await sleep(3000)
  const cpu0 = cpuSeconds(obs.pid)
  const tCpu0 = Date.now()

  const fsMarker = path.join(HERE, '.userdata', 'fullscreen.json')
  const fsUd = path.join(HERE, '.userdata', 'fullscreen-ud')
  rm(fsMarker)
  const fsWin = spawnElectron(['--mode=fullscreen', '--marker', fsMarker, ...udArgs(fsUd)])
  const fsReady = await waitFile(fsMarker, 15000)
  const fsMeta = readJson(fsMarker)
  focusWindow(fsMeta && fsMeta.hwnd)
  await sleep(3200)
  const fsSamples = samples.filter((s) => fsMeta && s.pid === fsMeta.pid)
  const fsFull = fsSamples.some((s) => s.full === true)
  const fsBounds = fsMeta ? fsMeta.bounds : null
  await closed(fsWin)
  await sleep(3000)
  const afterFullscreen = samples[samples.length - 1] || null

  const mxMarker = path.join(HERE, '.userdata', 'maximized.json')
  const mxUd = path.join(HERE, '.userdata', 'maximized-ud')
  rm(mxMarker)
  const mxWin = spawnElectron(['--mode=maximized', '--marker', mxMarker, ...udArgs(mxUd)])
  const mxReady = await waitFile(mxMarker, 15000)
  const mxMeta = readJson(mxMarker)
  focusWindow(mxMeta && mxMeta.hwnd)
  await sleep(2800)
  const mxSamples = samples.filter((s) => mxMeta && s.pid === mxMeta.pid)
  const mxFull = mxSamples.some((s) => s.full === true)
  const mxBounds = mxMeta ? mxMeta.bounds : null
  await closed(mxWin)

  const cpu1 = cpuSeconds(obs.pid)
  const wall = (Date.now() - tCpu0) / 1000
  obs.kill()

  return {
    observerPid: obs.pid,
    samples: samples.length,
    fullscreen: { ready: fsReady, meta: fsMeta, bounds: fsBounds, detectedFull: fsFull, samples: fsSamples.slice(-4) },
    afterFullscreen,
    maximized: { ready: mxReady, meta: mxMeta, bounds: mxBounds, detectedFull: mxFull, samples: mxSamples.slice(-3) },
    cpu: { seconds: cpu0 !== null && cpu1 !== null ? Number((cpu1 - cpu0).toFixed(3)) : null, wallSeconds: Number(wall.toFixed(1)), percentOneCore: cpu0 !== null && cpu1 !== null ? Number((((cpu1 - cpu0) / wall) * 100).toFixed(2)) : null },
    stderr: stderr.slice(0, 400),
  }
})

await section('dshLive2dWrite', async () => {
  const dir = path.join(os.homedir(), '.dsh', 'live2d')
  const exists = fs.existsSync(dir)
  const out = { dir, exists }
  if (!exists) return out
  const nodeFile = path.join(dir, `probe-node-${process.pid}-${Date.now()}.tmp`)
  const electronFile = path.join(dir, `probe-electron-${process.pid}-${Date.now()}.tmp`)
  rm(nodeFile)
  rm(electronFile)
  const nr = await run(NODE, [WRITE_PROBE, nodeFile], { timeout: 15000 })
  out.node = { result: jsonLines(nr.stdout)[0] || null, stderr: nr.stderr.slice(0, 200) }
  const er = await run(ELECTRON, [WRITE_PROBE, electronFile], { timeout: 20000, env: { ...BASE_ENV, ELECTRON_RUN_AS_NODE: '1' } })
  out.electronAsNode = { result: jsonLines(er.stdout)[0] || null, stdout: er.stdout.slice(0, 300), stderr: er.stderr.slice(0, 300), code: er.code }
  rm(nodeFile)
  rm(electronFile)
  return out
})

await section('menuGeometry', async () => {
  const d = results.displays
  if (!d || !Array.isArray(d.displays)) return { error: 'no display data' }
  const menuH = (rows) => rows * 84 + 168 + rows * 15 + 36
  const menuW = 696
  const slack = menuW - 330
  return {
    constants: { menuW, capW: 330, capH: 84, rowGap: 15, inputW: 660, inputH: 168, pad: 36, layerOffsetCandidate: 24, maxLayerOffset: 48, horizontalSlack: slack },
    displays: d.displays.map((x) => {
      const pw = Math.round(x.bounds.width * x.scaleFactor)
      const ph = Math.round(x.bounds.height * x.scaleFactor)
      const ww = Math.round(x.workArea.width * x.scaleFactor)
      const wh = Math.round(x.workArea.height * x.scaleFactor)
      return {
        id: x.id,
        scaleFactor: x.scaleFactor,
        physical: { w: pw, h: ph },
        workPhysical: { w: ww, h: wh },
        menu5: { w: menuW, h: menuH(5), fits: menuW <= pw - 16 && menuH(5) <= ph - 16 },
        menu6: { w: menuW, h: menuH(6), fits: menuW <= pw - 16 && menuH(6) <= ph - 16 },
        offsetsFit: { 24: 330 + 24 <= menuW, 48: 330 + 48 <= menuW },
      }
    }),
  }
})

await section('linkLength', async () => {
  const r = await runElectron(['--mode=linklength', `--user-data-dir=${path.join(HERE, '.userdata', 'linklength')}`], { timeout: 30000 })
  return jsonLines(r.stdout).find((x) => x.mode === 'linklength') || { error: 'no output', stdout: r.stdout.slice(0, 500), stderr: r.stderr.slice(0, 500) }
})

await section('bubbleWindowFacts', async () => ({
  source: 'pet/stage/app/main.cjs:939-968',
  focusable: false,
  ignoreMouseEvents: true,
  note: 'The speech bubble cannot host buttons as-is. The tutorial guide needs a separate interactive window (or a temporary mode that flips both flags).',
}))

fs.writeFileSync(path.join(HERE, 'results.json'), JSON.stringify(results, null, 2))
process.stdout.write('\nresults.json written: ' + path.join(HERE, 'results.json') + '\n')
