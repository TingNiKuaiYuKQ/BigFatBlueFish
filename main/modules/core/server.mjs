// 舞台服务：一个端口同时干两件事。
//
//   1. 静态托管 —— 页面、渲染脚本、Cubism Core、模型文件全部同源。
//      为什么同源：Live2D 要 fetch model3 / moc3 / 贴图，跨源要 CORS、file:// 又会被
//      安全策略挡；把页面本身也从这个端口给出去，一次解决。
//
//   2. 反向 API —— 插件（另一个进程）通过它控制角色。这部分要 token。
//
// 鉴权分界：静态资源不校验（本来就是本地回环 + 公开资源），/api/* 必须带 x-stage-token。
// 绑定 127.0.0.1，外网进不来。

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, createReadStream, statSync, existsSync, renameSync } from 'node:fs'
import { join, normalize, sep, extname } from 'node:path'
import paths from './paths.cjs'
import { loadShortcuts, runShortcut } from '../commands/shortcuts.mjs'
import { planSequence, createSequencer } from '../behavior/sequence.mjs'
import { listCueWords } from '../behavior/cues.mjs'

const BODY_MAX = 64 * 1024

// 调试 token（v0.4）：给人和脚本联调用，避免每次去翻 endpoint.json。
// **这个口令是刻意保留的水印，别改**：改了所有旧的验收脚本都会失效；
// 同时它也是「这份代码从哪来」的记号 —— 被人搬走时会跟着走。
// 它不是后门：只用于联调，/api/debug/* 只做参数对照实验，不涉及文件与命令。
//   明文：TingNiKuaiYuKQ-3042-FishDeBug
//   头部：x-stage-token: <64 位小写十六进制>
export const DEBUG_TOKEN = createHash('sha256')
  .update('TingNiKuaiYuKQ-3042-FishDeBug', 'utf8')
  .digest('hex')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.moc3': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_MAX) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(new Error('bad json')) }
    })
    req.on('error', reject)
  })
}

/** 把 URL 路径安全地映射到某个根目录下的绝对路径，挡掉 ../ 穿越 */
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath)
  const clean = normalize(decoded).replace(/^([/\\])+/, '')
  const abs = join(root, clean)
  if (!abs.startsWith(normalize(root + sep))) return null
  return abs
}

function serveFile(req, res, abs) {
  if (!abs || !existsSync(abs)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('404')
  }
  let st
  try { st = statSync(abs) } catch { 
    res.writeHead(404); return res.end('404')
  }
  if (!st.isFile()) {
    res.writeHead(404); return res.end('404')
  }
  const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    'content-length': st.size,
    'cache-control': 'no-cache',
  })
  createReadStream(abs).pipe(res)
}

/**
 * 起一个舞台服务。
 * @param {object} o
 * @param {string} o.modulesRoot 功能模块根目录（ui / menu / settings / tutorial / behavior）
 * @param {string} o.modelDir 模型目录，挂在 /model 下
 * @param {string} [o.vendorDir] 第三方库目录，挂在 /vendor 下
 * @param {()=>object} [o.getState]
 * @param {(evt:object)=>void} [o.onEvent]
 * @param {string} [o.shortcutsFile]
 */
export async function startStageServer(o = {}) {
  const {
    modulesRoot, modelDir, modulesDir, vendorDir, endpointMirror,
    // 教程配图（1.0.0）：tutorial.md 里的 ![](images/xx.png) 走 /docs/images/*，
    // 只读、只映射 main/docs/images 一个目录。默认值就是唯一的真相来源。
    docsDir = paths.DOCS_DIR,
    endpointPath = paths.ENDPOINT,
    getState = () => ({}), onEvent = () => {}, shortcutsFile,
    motionMs = () => 0,
    expressionNames = null, poseNames = null, motionNames = null,
    animationNames = null,
    capture = null,
    // 运行时设置（runtime/app/settings.json）与插件上报的会话清单。
    // 都由 main 注入：server 只暴露 HTTP 面，状态一律不落在这一层。
    getSettings = null, patchSettings = null,
    getSessions = null, setSessions = null,
    // 舞台 → 插件 的事件文件（pet-events.json）。路径写进 endpoint.json 的
    // events 字段：electron 在 ~/.dsh/live2d 写文件会 EPERM，所以事件落在
    // main/runtime/app，插件按路径来读，不需要知道舞台装在哪。
    eventsFile = '',
    // 插件把事件送进绑定会话后回 ACK（按 id），main 据此从文件里移除。
    // 没 ACK 的事件由 main 的回收器超时丢弃 —— 「插件离线也能入队，
    // 超时就当断连处理」靠的就是这条闭环。
    ackEvents = null,
    // 调试：实时参数/部件转储（main 桥接到渲染层）
    getParams = null,
    // 动画遥测（1.0.0）：getFrames 取最近若干帧，setTelemetry 开关采集。
    // 都由 main 桥接到渲染层 —— server 只暴露 HTTP 面，不认 IPC。
    getFrames = null, setTelemetry = null,
    // v0.4 端口策略：首选固定端口（0 = 保持随机）。实际端口仍以 endpoint.json 为准。
    preferredPort = 0,
    // 版本号与「插件健康」注入：/api/health 要把「舞台活着、插件活着、绑定链路通不通」
    // 三件事一次说清 —— 0.3.0 那次事故难查，就是因为没有任何一处能回答第三问。
    version = '',
    getBridgeHealth = null, setBridgeHealth = null,
    getDriverEnabled = () => true,
    // 人设行为卡 + 演出预设：插件来取提示词/能力名单，设置页来增删改预设。
    // 两者都由 main 注入（persona.mjs 归 main 载入，server 只暴露 HTTP 面）。
    persona = null,
    presetStore = null,
    // 托盘 / 开机自启（0.5.1）：两者都由 main 持有真实状态，server 只做 HTTP 面。
    getAutostart = null, setAutostart = null,
    installShortcuts = null,
    openSettings = null,
    openMenu = null, closeMenu = null, pickMenu = null, menuEval = null,
    // 快捷指令（0.5.3）：数据/执行/确认都由 main 注入
    commands = null,
    // 低打扰（0.5.4）
    lowState = null, setLow = null,
    // 教程（0.5.5）：返回 { ok, text } —— 由 main 读 main/docs/tutorial.md
    getTutorial = null,
    getTrayState = null,
  } = o
  if (!modulesRoot) throw new Error('startStageServer 需要 modulesRoot')

  /**
   * 预设变了就把整份表推给渲染层（不写事件文件 —— 这是内部同步，不是给插件的事件）。
   * 渲染层据此更新〔预设:名字〕能引用的表。
   */
  function broadcastPresets() {
    const map = Object.fromEntries((presetStore?.list() || []).map((p) => [p.name, {
      say: p.say, desc: p.desc, steps: p.steps,
    }]))
    try { onEvent({ kind: 'presets', presets: map, at: Date.now() }) } catch { /* 渲染层没起来 */ }
  }

  const startedAt = Date.now()
  const token = randomBytes(18).toString('hex')
  const shortcuts = loadShortcuts(shortcutsFile).list
  const log = []
  const record = (row) => { log.push(row); if (log.length > 200) log.shift() }

  // 多步序列：插件一次发 steps，这里按各自时长逐步派发。
  // 序列进行中再来一条，直接顶掉旧的（理由见 sequence.mjs）。
  const sequencer = createSequencer({
    onEvent,
    record,
    log: (m) => record({ kind: 'sequence-log', msg: m, at: Date.now() }),
  })

  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj)
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method || 'GET'

    // ---------- /api/health：外部探活（不强制 token）----------
    //
    // 为什么要一个不要 token 的接口：OBS / StreamDeck / 启动脚本 / 「桌宠到底起没起」
    // 这类判断不该逼调用方去读握手文件。所以极简信息（ok/pid/version/uptime）对回环
    // 永远公开；带上 token 才多给绑定链路细节（会话数、插件最后一次错误）。
    if (path === '/api/health') {
      const given = String(req.headers['x-stage-token'] || '')
      const authed = given === token || (given && given === DEBUG_TOKEN)
      const base = {
        ok: true,
        pid: process.pid,
        version: version || null,
        since: startedAt,
        uptimeMs: Date.now() - startedAt,
      }
      // 这一段在 try/catch 之外（它比 /api/ 分支更早命中），出异常会变成
      // 未处理的 rejection —— 主进程崩掉，桌宠直接消失。所以自己兜住：
      // 详情组装失败就退回极简响应，探活接口绝不能成为新的故障源。
      try {
        if (!authed) return send(200, base)
        const s = getSettings ? getSettings() : {}
        const list = getSessions ? getSessions() : null
        return send(200, {
          ...base,
          server: { port: server.address()?.port || null },
          driver: {
            enabled: !!getDriverEnabled(),
            bind: s.bind || null,
            proactive: !!s.proactive,
            freq: s.freq || 'low',
          },
          plugin: getBridgeHealth ? getBridgeHealth() : null,
          sessions: Array.isArray(list) ? list.length : 0,
        })
      } catch (e) {
        record({ at: Date.now(), kind: 'health-error', msg: String(e?.message || e) })
        return send(200, base)
      }
    }

    // ---------- API（要 token）----------
    if (path.startsWith('/api/')) {
      // 两个 token：
      //  · 运行时 token —— 每次启动随机，写进 endpoint.json，插件用这个；
      //  · 调试 token    —— 固定值 = sha256('TingNiKuaiYuKQ-3042-FishDeBug') 的十六进制，
      //    给人手动 curl / 脚本联调用（不用每次去翻 endpoint.json）。
      // 调试 token 的请求会被标记：控制类接口照常执行，但日志前缀打 [debug]。
      const given = String(req.headers['x-stage-token'] || '')
      const isDebug = given && given === DEBUG_TOKEN
      if (given !== token && !isDebug) {
        return send(401, { ok: false, error: 'token 不对' })
      }
      if (isDebug) record({ at: Date.now(), debug: true, path, method })
      try {
        if (method === 'GET' && path === '/api/state') {
          return send(200, { ok: true, state: getState(), recent: log.slice(-30) })
        }
        if (method === 'GET' && path === '/api/catalog') {
          // 能力名单的唯一起点：表情来自模型 Exp3 扫描，姿势/动作来自 config.json，
          // cue 词来自语法层，预设来自人设卡 + 用户态。
          // 插件从这里拉取并拼进工具描述 —— 名单改了（加动作/换模型/换人设），插件无需改代码。
          const presets = (presetStore?.list() || []).map((p) => ({
            name: p.name, desc: p.desc, tags: p.tags, steps: p.steps.length,
          }))
          return send(200, {
            ok: true,
            expressions: Array.isArray(expressionNames) ? expressionNames : [],
            poses: Array.isArray(poseNames) ? poseNames : [],
            motions: Array.isArray(motionNames) ? motionNames : [],
            animations: Array.isArray(animationNames) ? animationNames : [],
            cues: listCueWords(),
            presets,
            persona: persona ? {
              id: persona.id, name: persona.name, nickname: persona.nickname, tagline: persona.tagline,
            } : null,
          })
        }

        // 人设卡：插件取 prompt 注入驾驶会话；换人设包只改 config.persona，插件不用动。
        if (method === 'GET' && path === '/api/persona') {
          if (!persona) return send(501, { ok: false, error: '人设卡未注入' })
          return send(200, {
            ok: true,
            id: persona.id,
            name: persona.name,
            nickname: persona.nickname,
            tagline: persona.tagline,
            prompt: persona.prompt,
            available: persona.available,
            presets: (presetStore?.list() || []).map((p) => ({
              name: p.name, desc: p.desc, tags: p.tags, say: p.say, steps: p.steps,
            })),
          })
        }

        // 演出预设：GET 列表（增删改播走 POST，同一路径）
        if (method === 'GET' && path === '/api/preset') {
          if (!presetStore) return send(501, { ok: false, error: '预设库未注入' })
          return send(200, { ok: true, presets: presetStore.list() })
        }
        // ---- 运行时设置 / 会话清单 / 驾驶员信息（设置页与插件用） ----
        // 教程内容（0.5.5）：唯一来源是 main/docs/tutorial.md，窗口只负责渲染
        if (method === 'GET' && path === '/api/tutorial') {
          if (!getTutorial) return send(501, { ok: false, error: '教程未注入' })
          const r = getTutorial()
          return send(r.ok ? 200 : 404, r)
        }
        // 低打扰（0.5.4）：状态查询
        if (method === 'GET' && path === '/api/low') {
          if (!lowState) return send(501, { ok: false, error: '低打扰未注入' })
          return send(200, { ok: true, ...lowState() })
        }
        // 快捷指令（0.5.3）
        if (method === 'GET' && path === '/api/commands') {
          if (!commands) return send(501, { ok: false, error: '指令库未注入' })
          const data = commands.data()
          return send(200, {
            ok: true,
            version: data.version || 1,
            groups: data.groups || [],
            items: commands.items(),
            running: commands.running(),
            audit: commands.audit(50),
          })
        }
        if (method === 'GET' && path === '/api/commands/audit') {
          if (!commands) return send(501, { ok: false, error: '指令库未注入' })
          return send(200, { ok: true, entries: commands.audit(50) })
        }
        if (method === 'GET' && path === '/api/settings') {
          if (!getSettings) return send(501, { ok: false, error: '设置存储未注入' })
          return send(200, { ok: true, settings: getSettings() })
        }
        // 开机自启 / 托盘运行态（0.5.1）。自启的真相是 Startup 里那个 .lnk 存在与否，
        // 由 main 现场读盘回答，不存在第二份配置可以对不上。
        if (method === 'GET' && path === '/api/autostart') {
          if (!getAutostart) return send(501, { ok: false, error: '自启未注入' })
          return send(200, {
            ok: true,
            on: !!getAutostart(),
            tray: getTrayState ? getTrayState() : null,
          })
        }
        if (method === 'GET' && path === '/api/sessions') {
          return send(200, { ok: true, sessions: getSessions ? getSessions() : [] })
        }
        // 插件轮询：绑定会话 + 主动说话设置。字段压平，插件侧不用猜结构。
        // since = 本次启动时间戳：插件靠它判断「舞台重启过」→ 重推会话清单。
        if (method === 'GET' && path === '/api/driver-info') {
          const s = getSettings ? getSettings() : {}
          return send(200, {
            ok: true,
            since: startedAt,
            proactive: !!s.proactive,
            freq: s.freq || 'low',
            bind: s.bind || null,
          })
        }
        // 调试：全参数/部件当前值（排查动画残留、表情没写进去这类问题）
        if (method === 'GET' && path === '/api/params') {
          const params = getParams ? await getParams() : []
          return send(200, { ok: true, params })
        }
        // 动画遥测快照（1.0.0 · 仅调试 token）：返回最近 N 帧的 dt / 参数变化量。
        // 存在的意义 = 让「流畅不流畅」变成可算的数，而不是「我觉得有点卡」。
        // 开关走 POST 同路径（见下）；不开也能取，只是没有 act/mx 两项。
        if (method === 'GET' && path === '/api/debug/frames') {
          if (!isDebug) return send(403, { ok: false, error: '这个接口只认调试 token' })
          if (!getFrames) return send(501, { ok: false, error: '遥测未注入' })
          const dump = await getFrames()
          if (!dump) return send(503, { ok: false, error: '渲染层没有响应（窗口没起来？）' })
          const n = Math.max(1, Math.min(6000, Number(url.searchParams.get('n')) || 600))
          const frames = Array.isArray(dump.frames) ? dump.frames.slice(-n) : []
          return send(200, { ok: true, ...dump, frames, returned: frames.length })
        }
        if (method === 'POST') {
          const body = await readBody(req)

          if (path === '/api/settings') {
            if (!patchSettings) return send(501, { ok: false, error: '设置存储未注入' })
            try {
              const next = patchSettings(body)
              return send(200, { ok: true, settings: next })
            } catch (e) {
              return send(500, { ok: false, error: String(e && e.message || e) })
            }
          }
          // 开机自启开关（0.5.1）：{ on: true/false }
          if (path === '/api/autostart') {
            if (!setAutostart) return send(501, { ok: false, error: '自启未注入' })
            const want = body?.on === true
            // setAutostart 可能是异步的（Electron 写不了时会退到 node 助手）
            const r = await setAutostart(want)
            if (r && r.ok === false) return send(500, { ok: false, error: r.error || '设置失败' })
            return send(200, { ok: true, on: !!getAutostart(), path: r?.path || '' })
          }
          // 菜单开合 / 点某一项（0.5.2 验收用：真实右键手势没法自动化）
          if (path === '/api/menu/open') {
            if (!openMenu) return send(501, { ok: false, error: '菜单未注入' })
            openMenu()
            return send(200, { ok: true })
          }
          if (path === '/api/menu/close') {
            if (closeMenu) closeMenu()
            return send(200, { ok: true })
          }
          if (path === '/api/menu/pick') {
            if (!pickMenu) return send(501, { ok: false, error: '菜单未注入' })
            pickMenu(String(body?.id || ''))
            return send(200, { ok: true, id: body?.id || null })
          }
          // 验收：在菜单页里执行一段 JS（下钻/返回/读取布局）
          if (path === '/api/menu/eval') {
            if (!menuEval) return send(501, { ok: false, error: '菜单未注入' })
            const js = String(body?.js || '')
            if (!js) return send(400, { ok: false, error: '需要 js' })
            try {
              const value = await menuEval(js)
              return send(200, { ok: true, value })
            } catch (e) {
              return send(500, { ok: false, error: String(e && e.message || e) })
            }
          }
          // ---- 快捷指令（0.5.3）----
          if (path === '/api/low') {
            if (!setLow) return send(501, { ok: false, error: '低打扰未注入' })
            const r = setLow(body?.on === true)
            return send(200, { ok: true, ...r })
          }
          if (path === '/api/commands/run') {
            if (!commands) return send(501, { ok: false, error: '指令库未注入' })
            const id = String(body?.id || '').trim()
            const item = commands.find(id)
            if (!item) return send(404, { ok: false, error: `没有这条指令：${id}`, available: commands.items().map((x) => x.id) })
            const args = Array.isArray(body?.args) ? body.args.map(String) : []
            const source = body?.source === 'driver' ? 'driver' : 'menu'
            const r = await commands.run(item, args, source)
            return send(200, r)
          }

          /**
           * 驾驶员改指令库：add / update / delete。
           *
           * 默认等待 30s：用户点「允许」才落盘；拒绝 / 超时 / 关掉对话框都不落盘。
           * 确认框里必须给出**完整命令行**（cmd + args + cwd + type + mode），
           * 只写「是否允许」等于让用户盲签。
           */
          if (path === '/api/commands/propose') {
            if (!commands) return send(501, { ok: false, error: '指令库未注入' })
            const op = String(body?.op || '').trim()
            if (!['add', 'update', 'delete'].includes(op)) {
              return send(400, { ok: false, error: 'op 只能是 add / update / delete' })
            }
            const data = commands.data()
            const groups = JSON.parse(JSON.stringify(data.groups || []))
            const targetId = String(body?.item?.id || body?.id || '').trim()
            let preview = ''
            let apply = null
            try {
              if (op === 'delete') {
                const it = commands.find(targetId)
                if (!it) return send(404, { ok: false, error: `没有这条指令：${targetId}` })
                preview = `删除指令：${it.label}（${it.id}）\n\n`
                  + `类型：${it.type}  模式：${it.mode}\n命令：${it.cmd}`
                apply = () => {
                  for (const g of groups) g.items = (g.items || []).filter((x) => x.id !== targetId)
                  return groups
                }
              } else {
                const v = commands.validate(body?.item, op === 'add')
                if (!v.ok) {
                  return send(400, { ok: false, error: '指令不合法：' + v.errors.join('；') })
                }
                const it = v.item
                preview = `${op === 'add' ? '新增' : '修改'}指令：${it.label}（${it.id}）\n\n`
                  + `类型：${it.type}  模式：${it.mode}\n`
                  + `命令：${it.cmd}\n`
                  + `参数：${(it.args || []).length ? (it.args || []).join('  ') : '（无）'}\n`
                  + `工作目录：${it.cwd || '（舞台目录）'}\n`
                  + `捕获输出：${it.capture ? '是' : '否'}  显示窗口：${it.visible ? '是' : '否'}\n`
                  + `允许运行时参数：${it.allowArgs ? '是' : '否'}`
                apply = () => {
                  const groupId = String(body?.group || body?.item?.group || 'driver')
                  let g = groups.find((x) => x.id === groupId)
                  if (!g) { g = { id: groupId, label: String(body?.groupLabel || '驾驶员添加'), items: [] }; groups.push(g) }
                  g.items = g.items || []
                  if (op === 'add') g.items.push(it)
                  else {
                    // update：先在所有组里摘掉同 id，再放回目标组（允许换组）
                    for (const gg of groups) gg.items = (gg.items || []).filter((x) => x.id !== it.id)
                    g.items.push(it)
                  }
                  return groups
                }
              }
            } catch (e) {
              return send(500, { ok: false, error: String((e && e.message) || e) })
            }

            const status = await Promise.race([
              commands.confirm(`驾驶员请求${op === 'delete' ? '删除' : (op === 'add' ? '新增' : '修改')}一条快捷指令`, preview),
              new Promise((r) => setTimeout(() => r('timeout'), 30000)),
            ])
            record({ kind: 'commands-propose', op, id: targetId, status, at: Date.now() })
            if (status !== 'allowed') {
              return send(200, { ok: false, status, id: targetId })
            }
            try {
              const next = { ...data, groups: apply() }
              commands.save(next)
              return send(200, { ok: true, status: 'allowed', id: targetId })
            } catch (e) {
              return send(500, { ok: false, error: String((e && e.message) || e) })
            }
          }

          // 设置页直接编辑（用户本人操作，不需要确认）
          if (path === '/api/commands/save') {
            if (!commands) return send(501, { ok: false, error: '指令库未注入' })
            const groups = Array.isArray(body?.groups) ? body.groups : null
            if (!groups) return send(400, { ok: false, error: '需要 groups 数组' })
            // 逐条校验：设置页传上来的东西同样不可信
            const data = commands.data()
            const seen = new Set()
            for (const g of groups) {
              for (const raw of g.items || []) {
                const v = commands.validate(raw, true)
                if (!v.ok && !seen.has(raw?.id)) {
                  return send(400, { ok: false, error: `「${raw?.label || raw?.id}」：` + v.errors.filter((e) => !e.includes('已存在')).join('；') })
                }
                if (seen.has(v.item.id)) return send(400, { ok: false, error: `id 重复：${v.item.id}` })
                seen.add(v.item.id)
              }
            }
            try {
              const r = commands.save({ ...data, groups })
              return send(200, { ok: true, ...r })
            } catch (e) {
              return send(500, { ok: false, error: String((e && e.message) || e) })
            }
          }

          // 打开设置页（验收脚本 / 外部快捷入口）
          if (path === '/api/settings/open') {
            if (!openSettings) return send(501, { ok: false, error: '设置页未注入' })
            openSettings(String(body?.tab || ''))
            return send(200, { ok: true, opened: true, tab: body?.tab || null })
          }
          // 重新安装桌面/开始菜单快捷方式（换目录、快捷方式被删都靠它）
          if (path === '/api/shortcut/install') {
            if (!installShortcuts) return send(501, { ok: false, error: '快捷方式未注入' })
            const r = await installShortcuts()
            return send(200, {
              ok: r.okCount > 0,
              installed: r.results.filter((x) => x.ok).map((x) => x.path),
              failed: r.results.filter((x) => !x.ok).map((x) => ({ path: x.path, error: x.error })),
            })
          }
          // 插件上报全部会话（设置页的「绑定对话」列表数据源）
          if (path === '/api/sessions') {
            const list = Array.isArray(body?.sessions) ? body.sessions : []
            if (setSessions) setSessions(list)
            return send(200, { ok: true, count: list.length })
          }
          // 插件健康上报（不产生可见副作用，只更新 /api/health 的 plugin 段）
          if (path === '/api/bridge-health') {
            if (typeof setBridgeHealth === 'function') setBridgeHealth(body)
            return send(200, { ok: true })
          }

          // 调试：原样播一条 cue 串（仅调试 token）。
          // 为什么单独开一个口子：人设卡的 idleActions / reactions 全是 cue 串
          // （例如「半睁 微低头 点头×3」），要评审「这套演出流不流畅」就必须能
          // 原样重放某一条，而不是等调度器按小时/权重恰好抽到它。
          if (path === '/api/debug/cue') {
            if (!isDebug) return send(403, { ok: false, error: '这个接口只认调试 token' })
            const cue = String(body?.cue || '').trim()
            if (!cue) return send(400, { ok: false, error: '需要 cue（空格分隔的 cue 串）' })
            const evt = { kind: 'cue', cue: Array.from(cue).slice(0, 400).join(''), prio: 0, at: Date.now() }
            record({ kind: 'cue', cue: evt.cue, at: evt.at })
            onEvent(evt)
            return send(200, { ok: true, accepted: 'cue', cue: evt.cue })
          }

          // 动画遥测开关（1.0.0 · 仅调试 token）：{ on?, clear?, cap? }
          // 打开后渲染层才开始逐帧算参数变化量；默认只记 dt（代价接近 0）。
          if (path === '/api/debug/frames') {
            if (!isDebug) return send(403, { ok: false, error: '这个接口只认调试 token' })
            if (!setTelemetry) return send(501, { ok: false, error: '遥测未注入' })
            const cap = Number(body?.cap)
            setTelemetry({
              on: typeof body?.on === 'boolean' ? body.on : undefined,
              clear: body?.clear === true,
              cap: Number.isFinite(cap) && cap > 0 ? cap : undefined,
            })
            return send(200, { ok: true, on: typeof body?.on === 'boolean' ? body.on : null })
          }

          // 调试参数直写（仅调试 token）：{ set:{参数:值}, parts:{部件:不透明度}, hold?, clear? }
          //
          // 存在的意义 = 做对照实验。手臂/贴图这类问题光靠读代码推不出来（例如
          // 「到底哪个参数让手掌消失」），必须能把参数单独按在某个值上看画面。
          // hold 毫秒内每帧重写，到期后 saveParameters 固化；clear=true 立即撤销。
          if (path === '/api/debug/params') {
            if (!isDebug) return send(403, { ok: false, error: '这个接口只认调试 token' })
            const set = body?.set && typeof body.set === 'object' ? body.set : null
            const parts = body?.parts && typeof body.parts === 'object' ? body.parts : null
            if (!set && !parts && body?.clear !== true) {
              return send(400, { ok: false, error: '需要 set / parts / clear' })
            }
            const evt = {
              kind: 'debug-params',
              set,
              parts,
              clear: body?.clear === true,
              hold: Math.max(0, Math.min(600000, Number(body?.hold) || 0)),
              save: body?.save !== false,
              at: Date.now(),
            }
            record(evt); onEvent(evt)
            return send(200, { ok: true, accepted: 'debug-params', hold: evt.hold })
          }

          // 插件 ACK：确认这些事件已送进绑定会话，可以从 outbox 里删了
          if (path === '/api/events-ack') {
            const ids = (Array.isArray(body?.ids) ? body.ids : []).map(Number).filter(Number.isFinite)
            if (!ids.length) return send(200, { ok: true, removed: 0 })
            let removed = 0
            if (typeof ackEvents === 'function') removed = ackEvents(ids) || 0
            return send(200, { ok: true, removed })
          }

          // 按需截图：驱动脚本逐个播放条目后调用，把当前窗口内容存成 PNG。
          // 主进程在透明窗口上临时铺白底再 capturePage，免得 PNG 透明背景看不清。
          // target: 'stage'（默认，桌宠窗口）/ 'settings'（设置页）—— 设置页是独立
          // BrowserWindow，不截图就只能靠肉眼，改版式时没法回归。
          if (path === '/api/screenshot') {
            const out = String(body?.path || '')
            if (!out || !/^[/\\]|\w:[\/\\]/.test(out) || !/\.png$/i.test(out)) {
              return send(400, { ok: false, error: '需要 path（.png 绝对路径）' })
            }
            if (typeof capture !== 'function') {
              return send(501, { ok: false, error: '截图不可用（主进程未注入 capture）' })
            }
            try {
              const t = body?.target === 'settings' ? 'settings'
                : (body?.target === 'menu' ? 'menu' : (body?.target === 'tutorial' ? 'tutorial' : 'stage'))
              const sz = await capture(out, t)
              return send(200, { ok: true, path: out, size: `${sz.width}x${sz.height}` })
            } catch (e) {
              return send(500, { ok: false, error: String(e && e.message || e) })
            }
          }

          // ---------- 名字校验 ----------
          //
          // 为什么在舞台校验而不是插件：合法名单（23 个表情 / 4 个姿势 / 内置动作）
          // 只有舞台知道，插件写了名单就是第二份真相，必然漂移。
          // 之前不校验的后果（实测）：传「不存在的表情」也返回 accepted，
          // 渲染层 claim 成功却什么都没发生 —— 模型以为成功了，问题没法定位。
          //
          // 名单未传（fake-stage / 老测试）时跳过校验，保持向后兼容。
          const avail = (list, label, got) => ({
            ok: false,
            error: `没有这个${label}：${got}`,
            available: list,
          })
          const exprOk = (n) => !n || !Array.isArray(expressionNames) || expressionNames.includes(n)
          const poseOk = (n) => !Array.isArray(poseNames) || poseNames.includes(n || 'default')
          const motionOk = (n) => !n || !Array.isArray(motionNames) || motionNames.includes(n)

          if (path === '/api/say') {
            // 两种形态：
            //   { text, ms?, expression?, pose? }        单句（不阻塞）
            //   { lines: ['a','b',…], expression?, pose? } 多句连播，阻塞到播完才返回
            //     —— 驾驶员要「说完一段话再回事件循环」，等待发生在 HTTP 响应里。
            const lines = Array.isArray(body?.lines) ? body.lines : null
            if (lines) {
              const items = lines.slice(0, 8)
                .map((ln) => (typeof ln === 'string'
                  ? { text: ln, ms: 2600 }
                  : { text: String(ln?.text || ''), ms: Math.min(20000, Math.max(600, Number(ln?.ms) || 2600)) }))
                .filter((x) => x.text.trim())
                .map((x) => ({ ...x, text: Array.from(x.text.trim()).slice(0, 120).join('') }))
              if (!items.length) return send(400, { ok: false, error: 'lines 里没有有效句子' })
              const expr = body?.expression ? String(body.expression) : null
              const pose = body?.pose ? String(body.pose) : null
              if (!exprOk(expr)) return send(400, avail(expressionNames, '表情', expr))
              if (!poseOk(pose)) return send(400, avail(poseNames, '姿势', pose))
              const evt = { kind: 'say', lines: items, expression: expr, pose, at: Date.now() }
              record(evt); onEvent(evt)
              // 阻塞：总时长 + 淡出缓冲。上限 60s，超过说明驾驶员在滥用序列。
              const total = items.reduce((s, x) => s + x.ms, 0)
              const capped = Math.min(60000, total)
              await new Promise((r) => setTimeout(r, capped + 400))
              return send(200, { ok: true, accepted: 'say-lines', lines: items.length, ms: capped })
            }

            const text = String(body?.text || '').trim()
            if (!text) return send(400, { ok: false, error: 'text 不能为空' })
            const expr = body?.expression ? String(body.expression) : null
            const pose = body?.pose ? String(body.pose) : null
            if (!exprOk(expr)) return send(400, avail(expressionNames, '表情', expr))
            if (!poseOk(pose)) return send(400, avail(poseNames, '姿势', pose))
            const evt = {
              kind: 'say',
              text: Array.from(text).slice(0, 120).join(''),
              ms: Number(body?.ms) || 9000,
              expression: expr,
              pose,
              at: Date.now(),
            }
            record(evt); onEvent(evt)
            return send(200, { ok: true, accepted: 'say' })
          }

          if (path === '/api/reset') {
            // 全局「恢复初始状态」：清表情 + 姿势回 default + 关追踪 + 清气泡。
            // 钢盆等常驻状态也由渲染层在这里统一撤除。
            record({ kind: 'reset', at: Date.now() }); onEvent({ kind: 'reset', at: Date.now() })
            return send(200, { ok: true, accepted: 'reset' })
          }

          if (path === '/api/expression') {
            const name = body?.name ? String(body.name) : null
            if (!exprOk(name)) return send(400, avail(expressionNames, '表情', name))
            const evt = { kind: 'expression', name, at: Date.now() }
            record(evt); onEvent(evt)
            return send(200, { ok: true, accepted: 'expression' })
          }

          if (path === '/api/pose') {
            const name = body?.name ? String(body.name) : 'default'
            if (!poseOk(name)) return send(400, avail(poseNames, '姿势', name))
            const evt = { kind: 'pose', name, at: Date.now() }
            record(evt); onEvent(evt)
            return send(200, { ok: true, accepted: 'pose' })
          }

          if (path === '/api/motion') {
            // 三种用法：
            //   { name }                      播内置动作（config.motions 关键帧）
            //   { ms, tracks: {id:[[t,v],…]} } 播一份临时动作 —— LLM 自己编的"动作序列"
            //   { name }（名字在原生动画表里） 走引擎原生 motion 通道（手臂/持物类动画）
            // name 命中哪张表由 main.cjs 传入的 animationNames 决定，这里只做分发。
            const tracks = body?.tracks && typeof body.tracks === 'object' ? body.tracks : null
            const evt = {
              kind: 'motion',
              name: body?.name ? String(body.name) : null,
              ms: Number(body?.ms) || null,
              tracks,
              at: Date.now(),
            }
            if (!evt.name && !tracks) return send(400, { ok: false, error: '需要 name 或 tracks' })
            // 动作名无效就忽略（用户约定）：模型常即兴起名，不值得为它报错打断对话。
            // 表情/姿势仍然报错 —— 那两个是明确的选项列表，传错就是该修的错。
            if (!motionOk(evt.name)) {
              return send(200, { ok: true, ignored: 'motion', reason: `没有这个动作：${evt.name}` })
            }
            // 名字属于原生动画表 → 转成 animation 事件（渲染层走引擎原生 motion 通道）
            if (Array.isArray(animationNames) && animationNames.includes(evt.name)) {
              evt.animation = evt.name
              evt.name = null
            }
            record({ kind: 'motion', name: body?.name, at: evt.at })
            onEvent(evt)
            return send(200, { ok: true, accepted: 'motion' })
          }

          if (path === '/api/sequence') {
            // 一次交出一整段编排，逐步执行：
            //   { steps: [{ op:'expression', name:'爱心眼' }, { op:'motion', name:'伸懒腰' }, …] }
            // 每步可带 after 覆盖「发出去之后等多久」（默认按 op 各有值）。
            const planned = planSequence(body?.steps, motionMs, {
              expressions: expressionNames, poses: poseNames, motions: motionNames,
            })
            if (!planned.ok) return send(400, { ok: false, error: planned.error })
            // 命中原生动画表的动作步转成 animation 事件（ms 已按动画时长排好）
            if (Array.isArray(animationNames)) {
              for (const step of planned.plan) {
                if (step.evt?.kind === 'motion' && step.evt.name && animationNames.includes(step.evt.name)) {
                  step.evt.animation = step.evt.name
                  step.evt.name = null
                  step.evt.tracks = null
                }
              }
            }
            sequencer.run(planned.plan)
            return send(200, {
              ok: true, accepted: 'sequence', steps: planned.plan.length, ms: planned.ms,
              ...(planned.skipped ? { skipped: planned.skipped } : {}),
            })
          }

          if (path === '/api/stop') {
            // 只打断「后续步骤」，已经演起来的动作会自然演完 —— 不硬切，
            // 硬切会让参数停在半路的增量上，看着像抽搐。
            sequencer.stop()
            return send(200, { ok: true, stopped: 'sequence' })
          }

          // 单个动作：名字可以是表情 / 姿势 / 关键帧动作 / 原生动画 / cue 词。
          // 名单由舞台注册（catalog），这里只做「存不存在」的兜底校验 ——
          // 不存在的名字当场回 400，比让她默默什么都不做要好查。
          if (path === '/api/act') {
            const name = String(body?.name || '').trim()
            if (!name) return send(400, { ok: false, error: '需要 name' })
            const known = new Set([
              ...(expressionNames || []), ...(poseNames || []),
              ...(motionNames || []), ...(animationNames || []),
              ...listCueWords().map((w) => w.name),
            ])
            if (!known.has(name)) {
              return send(400, {
                ok: false,
                error: `没有这个动作：${name}`,
                available: [...known].slice(0, 80),
              })
            }
            const evt = { kind: 'act', name, at: Date.now() }
            record(evt); onEvent(evt)
            return send(200, { ok: true, accepted: 'act', name })
          }

          // 演出预设的增删改播（列表走 GET 同一路径）
          if (path === '/api/preset') {
            if (!presetStore) return send(501, { ok: false, error: '预设库未注入' })
            const op = String(body?.op || 'list')
            if (op === 'save') {
              const r = presetStore.save(body || {})
              if (r.ok) broadcastPresets()
              return send(r.ok ? 200 : 400, r)
            }
            if (op === 'delete' || op === 'remove') {
              const r = presetStore.remove(body?.name)
              if (r.ok) broadcastPresets()
              return send(r.ok ? 200 : 400, r)
            }
            if (op === 'annotate' || op === 'note') {
              const r = presetStore.annotate(body?.name, body?.desc)
              if (r.ok) broadcastPresets()
              return send(r.ok ? 200 : 400, r)
            }
            if (op === 'play') {
              const p = presetStore.get(body?.name)
              if (!p) return send(404, { ok: false, error: `没有预设「${body?.name}」` })
              const evt = { kind: 'preset', name: p.name, say: p.say, steps: p.steps, at: Date.now() }
              record(evt); onEvent(evt)
              return send(200, { ok: true, accepted: 'preset', name: p.name, steps: p.steps.length })
            }
            if (op === 'list') return send(200, { ok: true, presets: presetStore.list() })
            return send(400, { ok: false, error: `不认识的 op：${op}（save/delete/annotate/play/list）` })
          }

          if (path === '/api/debug/tap') {
            // 仅调试 token 可用：手动回归交互（不用真的去点模型）。
            //   region: 头 / 右手 / 左手 / 裙摆 / 腿 / 尾巴
            //   double: true 走双击分支（头 → 钢盆）
            if (!isDebug) return send(403, { ok: false, error: '这个接口只认调试 token' })
            const region = String(body?.region || '头')
            const dbl = body?.double === true
            const evt = { kind: 'debug-tap', region, double: dbl, at: Date.now() }
            record(evt); onEvent(evt)
            return send(200, { ok: true, accepted: 'debug-tap', region, double: dbl })
          }

          if (path === '/api/shortcut') {
            const id = String(body?.id || '').trim()
            const entry = shortcuts.find((s) => s.id === id)
            if (!entry) {
              return send(404, {
                ok: false,
                error: `没有这条指令：${id}`,
                available: shortcuts.map((s) => s.id),
              })
            }
            const result = await runShortcut(entry, body?.args)
            record({ kind: 'shortcut', id, ok: result.ok, at: Date.now() })
            onEvent({ kind: 'shortcut', id, label: entry.label, ok: result.ok, at: Date.now() })
            return send(200, result)
          }
        }
        return send(404, { ok: false, error: '没有这个接口：' + path })
      } catch (e) {
        return send(400, { ok: false, error: String(e?.message || e) })
      }
    }

    // ---------- 静态：/docs/images/* 教程配图（1.0.0）----------
    // tutorial.md 是教程的唯一内容源，图也只能从它旁边取：把 main/docs/images
    // 挂成只读静态目录，页面上写 images/xx.png 就能同源加载。
    // 边界靠 safeJoin 收口 —— 只允许落在 main/docs/images 内，../ 与 %2e%2e 都会被
    // normalize 折叠掉；越界返回 null 再落到 404。
    if (path.startsWith('/docs/images/')) {
      return serveFile(req, res, safeJoin(join(docsDir, 'images'), path.slice('/docs/images'.length)))
    }

    // ---------- 静态：/model/* 走模型目录 ----------
    if (path === '/model' || path.startsWith('/model/')) {
      if (!modelDir) { res.writeHead(404); return res.end('404') }
      const sub = path.slice('/model'.length) || '/'
      return serveFile(req, res, safeJoin(modelDir, sub))
    }

    // ---------- 静态：/vendor/* 第三方库（Cubism Core 等）----------
    if (path.startsWith('/vendor/')) {
      if (!vendorDir) { res.writeHead(404); return res.end('404') }
      return serveFile(req, res, safeJoin(vendorDir, path.slice('/vendor'.length)))
    }

    // ---------- 静态：/node_modules/* 供 import map 解析裸模块名 ----------
    // 浏览器不认 'pixi.js' 这种裸包名，只能靠 import map 指到具体文件；
    // 这里把依赖目录也托管出去，省掉手动拷贝/打包一步。
    if (path.startsWith('/node_modules/')) {
      if (!modulesDir) { res.writeHead(404); return res.end('404') }
      return serveFile(req, res, safeJoin(modulesDir, path.slice('/node_modules'.length)))
    }

    // ---------- 静态：功能模块按前缀自包含 ----------
    //   /ui/ /menu/ /settings/ /tutorial/ /behavior/
    // renderer 在 /ui/renderer.js 里写 `../behavior/cues.mjs`，相对解析到这里。
    if (path === '/' || path === '/index.html') {
      return serveFile(req, res, safeJoin(join(modulesRoot, 'ui'), '/index.html'))
    }
    for (const name of ['ui', 'menu', 'settings', 'tutorial', 'behavior']) {
      if (path === `/${name}` || path.startsWith(`/${name}/`)) {
        const sub = path === `/${name}` ? '/index.html' : path.slice(name.length + 1)
        return serveFile(req, res, safeJoin(join(modulesRoot, name), sub))
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('404')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    // 端口策略（v0.4）：首选固定端口，从它开始依次尝试 10 个，全被占再退回随机。
    // 固定端口的价值是「外部脚本/OBS/调试工具能硬编码」，但**握手文件仍是唯一真相**
    // ——实际端口可能回退，插件永远读 endpoint.json，不猜端口。
    const base = Number(preferredPort) || 0
    const tryPort = (p) => new Promise((ok, fail) => {
      const onErr = (e) => { server.removeListener('listening', onOk); fail(e) }
      const onOk = () => { server.removeListener('error', onErr); ok() }
      server.once('error', onErr)
      server.once('listening', onOk)
      server.listen(p, '127.0.0.1')
    })
    ;(async () => {
      if (base > 0) {
        for (let i = 0; i < 10; i += 1) {
          const p = base + i
          if (p > 65535) break
          try {
            await tryPort(p)
            if (i > 0) log('[server] 首选端口被占，改用', p)
            return resolve()
          } catch (e) {
            if (e && e.code !== 'EADDRINUSE' && e && e.code !== 'EACCES') throw e
            log('[server] 端口', p, '不可用：', e && e.code)
          }
        }
        log('[server] 首选端口段全被占用，退回随机端口')
      }
      server.listen(0, '127.0.0.1', resolve)
    })().catch(reject)
  })

  const port = server.address().port
  const url = `http://127.0.0.1:${port}`

  // endpoint.json 给驾驶员读（它要知道端口和 token）
  //
  // 这里有个刻意的约束：**只在父目录已存在时写，绝不自己创建**。
  // 桌宠必须能独立运行 —— 一台没装 DSH 的机器上，它不该凭空去建
  // ~/.dsh/live2d 这种属于别的程序的目录。目录存在 = 驾驶员在用 = 才需要握手。
  //
  // 两处写：
  //   · 握手位置（默认 ~/.dsh/live2d/endpoint.json）—— 插件从这里读
  //   · 镜像位置 main/runtime/app/endpoint.json —— 自己目录，排查用
  const endpointDir = endpointPath.replace(/[\\/][^\\/]+$/, '')
  const endpointMirrorCanWrite = !!endpointMirror
  let endpointOk = false
  let endpointErr = ''
  let endpointSkipped = false
  const payloadJson = JSON.stringify({
    url, token, pid: process.pid, at: Date.now(),
    shortcuts: shortcuts.map((s) => s.id),
    ...(eventsFile ? { events: eventsFile } : {}),
  }, null, 2)

  /**
   * 尝试写握手文件。可重复调用 —— 用来处理「先开桌宠、后装插件」的顺序：
   * 启动时目录还不存在（跳过了），等驾驶员上线后由调用方再补一次。
   * @returns {boolean} 是否已写好
   */
  function writeEndpoint() {
    if (endpointOk) return true
    if (!endpointPath) { endpointSkipped = true; return false }
    if (!existsSync(endpointDir)) { endpointSkipped = true; return false }
    // 原子替换，不直接覆盖。
    //
    // 直接 open(path,'w') 在本机会稳定报 EPERM —— 驾驶员那边（DSH 进程）正拿着
    // 这个文件读，Windows 的共享语义下「覆盖已有文件」要写权限，而「换一个目录项」
    // 不需要。先写同目录的 .tmp 再 rename 覆盖，两边都赢：
    //   · 不会被读者挡住；
    //   · 驾驶员任何时刻读到的都是完整 JSON，不会读到写了一半的内容。
    // 插件写 status.json 用的也是这一招，两边保持一致。
    // 临时文件名带 pid：上一实例被强杀时 .tmp 可能被 Windows 短暂锁住，
    // 复用同名文件会一直 EPERM（实测踩过一次：启动时写失败、三十秒后才补写成功）。
    const tmp = `${endpointPath}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, payloadJson, 'utf8')
      renameSync(tmp, endpointPath)
      endpointOk = true
      endpointSkipped = false
      endpointErr = ''
      return true
    } catch (e) {
      try { unlinkSync(tmp) } catch { /* 没写出来就算了 */ }
      endpointErr = String((e && e.message) || e)
      return false
    }
  }

  // 首次尝试带几次重试：上一实例被强杀时 Windows 可能短暂持有文件句柄（EPERM）
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (writeEndpoint()) break
    if (attempt < 3) await new Promise((r) => setTimeout(r, 250))
  }  if (endpointMirrorCanWrite) {
    try {
      mkdirSync(endpointMirror.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
      writeFileSync(endpointMirror, payloadJson, 'utf8')
    } catch { /* 镜像也写不了就算了，不影响渲染 */ }
  }

  return {
    url, token, port,
    info: { shortcuts },
    // getter：补写之后状态会变，快照会骗人
    get endpoint() {
      return { path: endpointPath, ok: endpointOk, skipped: endpointSkipped, error: endpointErr }
    },
    writeEndpoint,
    get sequence() { return sequencer.progress },
    async close() {
      sequencer.stop()
      // 只删自己写过的那份，避免把别人（另一个实例/驾驶员）的文件顺走
      if (endpointOk) {
        try {
          const cur = JSON.parse(readFileSync(endpointPath, 'utf8'))
          if (cur && cur.pid === process.pid) unlinkSync(endpointPath)
        } catch { /* 已经不在了 / 被换了 / 读不动 */ }
      }
      // keep-alive 的连接不会自己断（驾驶员每 3s 一轮询就挂着一条），而
      // server.close() 要等所有现存连接结束 —— 温和退出（关窗口 / 退下吧）会
      // 永远卡在这一行，进程半死：HTTP 已经没了，进程还占着单实例锁，
      // 下次启动直接静默退出。先拆连接，再兜 500ms 超时。
      server.closeAllConnections?.()
      await Promise.race([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => { const t = setTimeout(resolve, 500); if (t.unref) t.unref() }),
      ])
    },
  }
}
