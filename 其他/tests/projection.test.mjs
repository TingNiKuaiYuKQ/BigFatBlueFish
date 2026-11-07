// 投影逻辑的离线测试：不开 DSH、不开桌宠，只喂事件序列，断言状态文件产出。
//
// 做法：把 USERPROFILE/HOME 指到临时目录，再把插件复制进去，
// 这样插件算出来的 ~/.dsh/live2d 落在沙箱里，不会踩到真实状态文件。
// @deepseek-ai/dsh-tools 用桩替代 —— 这里测的是归约与写盘，不是宿主集成。
//
//   node test/projection.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const sandbox = mkdtempSync(join(tmpdir(), 'pet-test-'))

// 1) 沙箱 + dsh-tools 桩 + 插件本体
mkdirSync(join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })
writeFileSync(join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', main: 'index.js' }))
writeFileSync(join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'),
  'export const defineTool = (t) => t\n')
mkdirSync(join(sandbox, 'bridge', 'lib'), { recursive: true })
copyFileSync(join(ROOT, 'plugins', 'dsh', 'lib', 'index.js'), join(sandbox, 'bridge', 'lib', 'index.js'))
// 白名单也要放进沙箱，否则「桌宠没开」那几条会走成「找不到指令」，测不到真正的降级路径。
// 0.6.x：不再从 shortcuts.legacy.json 抄（那个文件带作者本机路径，已删），
// 直接从默认 commands.json 的当前内容生成 —— 默认值改了测试也跟着走，不会失配。
mkdirSync(join(sandbox, '.dsh', 'live2d'), { recursive: true })
const defaultCommands = JSON.parse(readFileSync(join(ROOT, 'main', 'config', 'commands.json'), 'utf8'))
writeFileSync(join(sandbox, '.dsh', 'live2d', 'shortcuts.json'), JSON.stringify({
  shortcuts: defaultCommands.groups.flatMap((g) => g.items || []).map((it) => ({
    id: it.id, label: it.label, cmd: it.cmd, args: it.args || [],
    mode: it.mode || 'exec', capture: it.capture === true,
  })),
}))

// 2) 在 import 之前改 homedir，让插件把状态写进沙箱
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const plugin = await import(pathToFileURL(join(sandbox, 'bridge', 'lib', 'index.js')).href)

// 3) 假 ctx
const tools = new Map()
const handlers = new Map()
const promptSections = []
let disposed = false
const ctx = {
  tools: { register: (t) => tools.set(t.name, t) },
  systemPrompt: { section: (s) => promptSections.push(s) },
  on: (ev, fn) => handlers.set(ev, fn),
  get: () => undefined,
  logger: { info() {}, warn() {} },
}

const checks = []
const ok = (label, cond, extra = '') => checks.push({ label, pass: !!cond, extra })

// 坏缓存：v0.4.1 把宿主的标题快照对象 String() 成了 "[object Object]" 并落盘。
// 载入时必须当成空值作废，否则设置页要等 30 分钟 TTL 才有机会自愈。
const TITLES = join(sandbox, 'bridge', 'data', 'session-titles.json')
mkdirSync(join(sandbox, 'bridge', 'data'), { recursive: true })
writeFileSync(TITLES, JSON.stringify({
  v: 1,
  titles: {
    'session-bad': { title: '[object Object]', at: Date.now() },
    'session-good': { title: '真标题', at: Date.now() },
  },
}), 'utf8')

plugin.apply(ctx)

const STATUS = join(sandbox, '.dsh', 'live2d', 'status.json')
const read = () => JSON.parse(readFileSync(STATUS, 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const emit = (event) => handlers.get('session/event')?.({ header: { id: 's1' }, seq: event.seq }, event)

// --- 装配期断言 ---
// 0.5.x：工具从「pet + run_shortcut」扩成五件套（说话 / 演出动作 / 演出预设 / 指令 / 旧白名单）
ok('注册了 5 个工具', tools.size === 5, [...tools.keys()].join(','))
ok('工具有 pet', tools.has('pet'))
ok('工具有 run_shortcut', tools.has('run_shortcut'))
ok('工具有 pet_act', tools.has('pet_act'))
ok('工具有 pet_preset', tools.has('pet_preset'))
ok('工具有 pet_command', tools.has('pet_command'))
ok('注册了提示词', promptSections.length >= 1, promptSections.map((x) => x.name).join(','))

// --- 事件归约 ---
let seq = 1
emit({ type: 'turn/start', seq: seq++ })
await sleep(200)
let st = read()
ok('turn/start → thinking', st.state === 'thinking', st.state)
ok('thinking 映射为 前倾', st.expression === '前倾', String(st.expression))
ok('协议版本 v2', st.v === 2, String(st.v))

emit({ type: 'tool/call', seq: seq++, data: { name: 'write', arguments: '{"file_path":"D:/x/editor.js"}' } })
await sleep(200)
st = read()
ok('tool/call → working', st.state === 'working', st.state)
ok('细节取到文件名', st.detail === 'editor.js', String(st.detail))
ok('working 映射为 兔牙', st.expression === '兔牙', String(st.expression))

emit({ type: 'tool/call', seq: seq++, data: { name: 'ask_user_question', arguments: '{}' } })
await sleep(200)
st = read()
ok('问用户 → waiting', st.state === 'waiting', st.state)
ok('waiting 映射为 ＞＜', st.expression === '＞＜', String(st.expression))
ok('waiting 姿势为 chest', st.pose === 'chest', String(st.pose))

emit({ type: 'turn/end', seq: seq++, data: { reason: { kind: 'completed' } } })
await sleep(200)
st = read()
ok('turn/end completed → success', st.state === 'success', st.state)
ok('success 映射为 爱心眼', st.expression === '爱心眼', String(st.expression))

// --- 工具降级路径（桌宠没开）---
const r1 = await tools.get('run_shortcut').execute({ id: 'rm_rf' })
ok('未知 id 被拒', r1.ok === false && /没有这条指令/.test(r1.error), JSON.stringify(r1.error))
const r2 = await tools.get('run_shortcut').execute({ id: 'open_control' })
ok('白名单命中但桌宠没开 → 明确的降级', r2.ok === false && /桌宠没开/.test(String(r2.error)), String(r2.error))

// --- 陈旧握手：桌宠被强杀后 endpoint.json 会留在磁盘上 ---
// 这种时候端口已经没人监听。模型不能只看到「fetch failed」，得知道该重启桌宠。
writeFileSync(join(sandbox, '.dsh', 'live2d', 'endpoint.json'),
  JSON.stringify({ url: 'http://127.0.0.1:1', token: 'stale', pid: 999999 }))
const r5 = await tools.get('run_shortcut').execute({ id: 'open_control' })
ok('陈旧握手 → 指出进程已退出', r5.ok === false && /进程已退出/.test(String(r5.error)), String(r5.error))
rmSync(join(sandbox, '.dsh', 'live2d', 'endpoint.json'), { force: true })
const r3 = await tools.get('pet').execute({ kind: 'say', text: '' })
ok('空台词被拒', r3.ok === false)
const r4 = await tools.get('pet').execute({ kind: 'dance' })
ok('未知 kind 被拒', r4.ok === false)
ok('自述里带预设清单', /还没有自定义预设/.test(String(tools.get('pet').description)))
// 0.5.x：pet 的描述改成「说话 + 内联演出」，sequence/preset 的旧文案已经移走
ok('自述点明内联〔〕与预设引用', /〔/.test(String(tools.get('pet').description))
  && /预设/.test(String(tools.get('pet').description)))

// --- 自定义预设：存的是 steps，播的时候原样转发 ---
const rp = (a) => tools.get('pet').execute({ kind: 'preset', ...a })
const p0 = await rp({ op: 'list' })
ok('初始没有预设', p0.ok === true && p0.presets.length === 0, JSON.stringify(p0))
const steps = [
  { op: 'expression', name: '爱心眼' },
  { op: 'motion', name: '伸懒腰' },
  { op: 'say', text: '嗨' },
]
const ps = await rp({ op: 'save', name: '打招呼', desc: '开心地打招呼', steps })
ok('保存预设', ps.ok === true && ps.saved === '打招呼' && ps.steps === 3, JSON.stringify(ps))
ok('预设落在插件目录（随插件卸载一起删）',
  existsSync(join(sandbox, 'bridge', 'data', 'presets.json')), 'bridge/data/presets.json')
const p1 = await rp({ op: 'list' })
ok('list 能看到且步数正确', p1.presets.length === 1 && p1.presets[0].steps === 3, JSON.stringify(p1.presets))
const pe = await rp({ op: 'save', name: '空的' })
ok('save 缺 steps 被拒', pe.ok === false && /steps/.test(String(pe.error)), String(pe.error))
const pp = await rp({ op: 'play', name: '打招呼' })
ok('桌宠没开时 play 明确降级', pp.ok === false && /桌宠没开/.test(String(pp.error)), String(pp.error))
const pm = await rp({ op: 'play', name: '不存在的' })
ok('不存在的预设给出可用清单', pm.ok === false && Array.isArray(pm.available), JSON.stringify(pm))
const pd = await rp({ op: 'delete', name: '打招呼' })
ok('删除预设', pd.ok === true && pd.deleted === '打招呼', JSON.stringify(pd))

// --- 会话标题：宿主 readTitleSnapshots 给的是快照对象，不是裸字符串 ---
ok('快照对象取内层 title', plugin.titleText({ title: '聊天标题', messageSeqs: [1], eventSeq: 3 }) === '聊天标题')
ok('裸字符串照用（session/title 事件）', plugin.titleText('聊天标题') === '聊天标题')
ok('快照里 title 为 null → 空串', plugin.titleText({ title: null }) === '')
ok('拿不到 → 空串', plugin.titleText(undefined) === '' && plugin.titleText(null) === '')
ok('历史坏值 [object Object] 视为无效', plugin.titleText('[object Object]') === '')

// 事件回填 + 顺带把坏缓存洗成空（洗空后它走 3 分钟重读分支，不再占 30 分钟 TTL）
emit({ type: 'session/title', seq: seq++, data: { title: '事件标题' } })
await sleep(1800)   // saveTitleCache 有 1.5s 防抖
const savedTitles = JSON.parse(readFileSync(TITLES, 'utf8')).titles
ok('事件标题落盘', savedTitles.s1?.title === '事件标题', JSON.stringify(savedTitles.s1))
ok('坏缓存洗成空串', savedTitles['session-bad']?.title === '', JSON.stringify(savedTitles['session-bad']))
ok('好标题不受影响', savedTitles['session-good']?.title === '真标题', JSON.stringify(savedTitles['session-good']))

// --- 卸载 ---
handlers.get('dispose')?.()
disposed = existsSync(STATUS) // 状态文件故意保留
ok('dispose 后状态文件保留', disposed)

// --- 报告 ---
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`${c.pass ? '  ok  ' : ' FAIL '} ${c.label}${c.extra ? `  → ${c.extra}` : ''}`)
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
