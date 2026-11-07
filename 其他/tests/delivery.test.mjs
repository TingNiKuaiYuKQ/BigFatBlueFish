// 投递确认链路的离线测试：假舞台 HTTP + 假 agent + 真事件流，不开 DSH。
//
// 测的是「送成功 ≠ 送达」这条：followup() 不抛异常只代表消息进了收件箱，
// 回合里失败（DSH-API.md §6.1 那种一次性的 UNSUPPORTED_CONTENT）必须重投一次，
// 确认完成才 ACK outbox 里的事件 —— 旧行为是不管回合死活都 ACK，那句话永久丢失。
//
//   node test/delivery.test.mjs

import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const sandbox = mkdtempSync(join(tmpdir(), 'pet-delivery-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 9000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(120)
  }
  return false
}

// 1) 沙箱 + dsh-tools 桩 + 插件本体（和 projection.test.mjs 同一套路）
mkdirSync(join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })
writeFileSync(join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', main: 'index.js' }))
writeFileSync(join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'),
  'export const defineTool = (t) => t\n')
mkdirSync(join(sandbox, 'bridge', 'lib'), { recursive: true })
copyFileSync(join(ROOT, 'plugins', 'dsh', 'lib', 'index.js'), join(sandbox, 'bridge', 'lib', 'index.js'))
mkdirSync(join(sandbox, '.dsh', 'live2d'), { recursive: true })
writeFileSync(join(sandbox, '.dsh', 'live2d', 'shortcuts.json'), JSON.stringify({ v: 1, shortcuts: [] }))

// 2) 假舞台：driver-info / bridge-health / events-ack，事件表就是磁盘上的一个文件
const EVENTS = join(sandbox, 'pet-events.json')
const acks = []
const healthPosts = []
let bind = 'sess-bound'
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const url = String(req.url)
    res.setHeader('content-type', 'application/json')
    if (url === '/api/driver-info') {
      // stageFetch 把整个响应体当 data 用，所以这里不能多套一层 data
      return res.end(JSON.stringify({
        ok: true, since: 1, bind, proactive: true, freq: 'high',
      }))
    }
    if (url === '/api/bridge-health') {
      try { healthPosts.push(JSON.parse(body)) } catch { /* 忽略坏体 */ }
      return res.end(JSON.stringify({ ok: true }))
    }
    if (url === '/api/events-ack') {
      const ids = (JSON.parse(body || '{}').ids || []).map(Number)
      acks.push(...ids)
      const box = JSON.parse(readFileSync(EVENTS, 'utf8'))
      box.events = box.events.filter((e) => !ids.includes(Number(e.id)))
      writeFileSync(EVENTS, JSON.stringify(box))
      return res.end(JSON.stringify({ ok: true, removed: ids.length }))
    }
    res.end(JSON.stringify({ ok: true }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
writeFileSync(join(sandbox, '.dsh', 'live2d', 'endpoint.json'), JSON.stringify({
  url: `http://127.0.0.1:${port}`, token: 'test-token', pid: process.pid, events: EVENTS,
}))

const EV_ID = Date.now()
const writeEvent = (text, id = EV_ID) => writeFileSync(EVENTS, JSON.stringify({
  v: 1, events: [{ id, at: Date.now(), kind: 'user-input', text }],
}))
writeEvent('你好')

// 3) 假 ctx：agents.get() 给一个能记录 followup 的假 agent
const agent = { status: 'idle', sent: [], followup(m) { this.sent.push(m) }, steer(m) { this.sent.push(m) } }
const sessionsSvc = { list: () => [{ header: { id: bind, createdAt: 1 } }] }
const handlers = new Map()
const ctx = {
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  on: (ev, fn) => handlers.set(ev, fn),
  get: (name) => (name === 'agents' ? { get: (sid) => (sid === bind ? agent : null) }
    : name === 'sessions' ? sessionsSvc : undefined),
  agents: { get: (sid) => (sid === bind ? agent : null) },
  sessions: sessionsSvc,
  logger: { info() {}, warn() {} },
}

process.env.USERPROFILE = sandbox
process.env.HOME = sandbox
const plugin = await import(pathToFileURL(join(sandbox, 'bridge', 'lib', 'index.js')).href)
plugin.apply(ctx)

const checks = []
const ok = (label, cond, extra = '') => checks.push({ label, pass: !!cond, extra })
const emitTurnEnd = (kind, message) => handlers.get('session/event')?.(
  { header: { id: bind } },
  { type: 'turn/end', seq: 1, data: { reason: { kind, error: message ? { message } : undefined } } },
)

// ① 投递成功就 ACK（不等回合：agent 一轮跑几分钟很常见，等的话舞台 90s 收不到
//    ACK 会冒「好像断连了」的误报）。确认与重投靠插件自己留的那份文本。
//
// v4 落盘校验（@deepseek-ai/dsh-session-format-v3-to-v4）：inserted 里的消息
// source.kind 为空或等于 'plugin' 就整批抛错；role 决定适配器怎么转 wire 形状；
// id 是 inbox 投影的去重键。少一个都会让回合失败，而且用户自己那条一起没。
const v4ok = (m) => m && m.role === 'user'
  && typeof m.id === 'string' && m.id.length >= 32
  && typeof m.source?.kind === 'string' && m.source.kind.length > 0 && m.source.kind !== 'plugin'
  && Array.isArray(m.content) && m.content.every((b) => typeof b?.type === 'string')
ok('消息进了假 agent 的收件箱', await waitFor(() => agent.sent.length >= 1), `sent=${agent.sent.length}`)
ok('按 user-input 身份投递（source.kind=user）',
  agent.sent[0]?.source?.kind === 'user', JSON.stringify(agent.sent[0]?.source))
ok('v4 消息形状合规（role/id/source.kind/content）', v4ok(agent.sent[0]),
  JSON.stringify({ role: agent.sent[0]?.role, id: !!agent.sent[0]?.id, source: agent.sent[0]?.source }))
ok('投递即 ACK（outbox 不留副本）', await waitFor(() => acks.includes(EV_ID)), JSON.stringify(acks))
ok('已投递但未确认 → inflight=1',
  await waitFor(() => (healthPosts[healthPosts.length - 1] || {}).inflight === 1),
  JSON.stringify((healthPosts[healthPosts.length - 1] || {}).inflight))

// ② 回合报那条已知错误 → 用留底的那份文本重投一次
emitTurnEnd('error', 'DeepSeek Messages cannot represent system update without a preceding user or tool-result turn')
ok('已知错误触发重投', await waitFor(() => agent.sent.length >= 2), `sent=${agent.sent.length}`)
ok('重投期间仍未算确认', (healthPosts[healthPosts.length - 1] || {}).confirmed === 0,
  String((healthPosts[healthPosts.length - 1] || {}).confirmed))

// ③ 这次回合跑完 → 才算送达
emitTurnEnd('completed')
ok('回合完成 → 记为已确认', await waitFor(() => (healthPosts[healthPosts.length - 1] || {}).confirmed === 1),
  JSON.stringify(healthPosts[healthPosts.length - 1] || {}))
const last = healthPosts[healthPosts.length - 1] || {}
ok('未确认计数为 0', last.dropped === 0, JSON.stringify({ c: last.confirmed, d: last.dropped }))
ok('inflight 已清空', last.inflight === 0, String(last.inflight))

// ④ 未知错误不重投（避免无关回合失败造成重复消息），直接放弃并 ACK
const EV2 = EV_ID + 7
writeEvent('再说一句', EV2)
ok('第二条也投出去了', await waitFor(() => agent.sent.length >= 3), `sent=${agent.sent.length}`)
const before = agent.sent.length
emitTurnEnd('error', '上游网络断了')
await sleep(3600)   // 两轮轮询：未知错误不该触发重投
ok('未知错误不重投（避免无关回合失败造成重复消息）', agent.sent.length === before,
  `sent ${before} → ${agent.sent.length}`)
ok('放弃后 inflight 归零（不会反复重投）', await waitFor(() => {
  const h = healthPosts[healthPosts.length - 1] || {}
  return h.inflight === 0 && h.dropped >= 1
}), JSON.stringify(healthPosts[healthPosts.length - 1] || {}))

// ⑤ 非 user-input 的事件（桌宠自己报的）走插件自己的 producer kind
const EV3 = EV_ID + 21
writeFileSync(EVENTS, JSON.stringify({
  v: 1, events: [{ id: EV3, at: Date.now(), kind: 'pet-say', text: '她想说：该喝水了' }],
}))
ok('桌宠事件也投出去了', await waitFor(() => agent.sent.some((m) => m.source?.kind === 'pet-bridge')),
  JSON.stringify(agent.sent.map((m) => m.source?.kind)))
ok('桌宠事件同样是合规的 v4 消息', v4ok(agent.sent[agent.sent.length - 1]),
  JSON.stringify(agent.sent[agent.sent.length - 1]))
ok('全程没有一条消息用退休的 kind=plugin', agent.sent.every((m) => m.source?.kind !== 'plugin'),
  JSON.stringify(agent.sent.map((m) => m.source)))

// ⑥ 换绑定时不该把旧会话的 in-flight 当确认（这里只验不炸）
bind = 'sess-other'
emitTurnEnd('completed')
ok('换绑定后仍能正常轮询', await waitFor(() => healthPosts.length > 4), `posts=${healthPosts.length}`)

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? '  ok  ' : ' FAIL '} ${c.label}${c.extra ? `  → ${c.extra}` : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
server.close()
process.exit(failed.length ? 1 : 0)
