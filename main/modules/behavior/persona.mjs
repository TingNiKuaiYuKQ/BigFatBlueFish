/**
 * 人设行为卡（persona pack）—— 一个可替换的目录，决定「她是谁」和「她闲着时做什么」。
 *
 * 目录约定（`main/persona/<id>/`）：
 *   persona.json   人设卡：名字/绰号/称呼/道具/口癖/prompt（prompt 会原样注入驾驶会话）
 *   behavior.json  默认行为规划：小时规划时段 + idleActions（权重/时段/动作）+ reactions
 *   presets.json   出厂演出预设：名字 → step 序列，可在说话里用〔预设:名字〕调用
 *
 * 用户态（可写）在 `main/runtime/app/`：
 *   presets-user.json  { saved:{名字:预设}, deleted:[名字], notes:{名字:注释}, order:[名字] }
 *
 * 换人设 = 改 config.json 的 persona 字段 + 换模型目录；代码不用动。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import paths from '../core/paths.cjs'

const DEFAULT_ID = 'blue-whale-maid'

function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

/** 人设包根目录（main/persona），由唯一路径契约给出 */
export function packRoot() {
  return paths.PERSONA_DIR
}

export function listPacks() {
  const root = packRoot()
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/**
 * 载入一个人设包。
 * 缺文件不致命：缺 persona.json 用内置兜底，缺 behavior.json 退回 config.behavior，
 * 缺 presets.json 就是没有出厂预设 —— 桌宠永远能起来，这是硬要求。
 */
export function loadPersona({ id, log = () => {} }) {
  const wanted = String(id || DEFAULT_ID)
  const root = packRoot()
  const dir = join(root, wanted)

  const card = readJson(join(dir, 'persona.json'), null)
  const behavior = readJson(join(dir, 'behavior.json'), null)
  const factory = readJson(join(dir, 'presets.json'), { presets: [] })

  if (!card) log(`[persona] 没读到 ${wanted}/persona.json，用兜底人设`)
  if (!behavior) log(`[persona] 没读到 ${wanted}/behavior.json，行为退回 config.behavior`)
  if (!existsSync(join(dir, 'presets.json'))) log(`[persona] ${wanted} 没有出厂预设`)

  return {
    id: card?.id || wanted,
    dir,
    available: listPacks(),
    card: card || {
      id: wanted,
      name: '桌宠',
      nickname: '',
      tagline: '',
      prompt: '桌面有一个 Live2D 角色陪着你。',
      props: [],
    },
    behavior: behavior || null,
    factoryPresets: Array.isArray(factory?.presets) ? factory.presets : [],
  }
}

/* ------------------------------------------------------------ 演出预设（含用户态） */

function userFile(userDataDir) {
  return join(userDataDir, 'presets-user.json')
}

function readUser(userDataDir) {
  return readJson(userFile(userDataDir), { saved: {}, deleted: [], notes: {}, order: [] })
}

function writeUser(userDataDir, data) {
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(userFile(userDataDir), JSON.stringify(data, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 一步的时长（毫秒）：after 缺省按 cue 里的动作估 */
const DEFAULT_AFTER = 800

function normalizePreset(raw, source = 'factory') {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.name || '').trim()
  if (!name) return null
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((s) => (typeof s === 'string' ? { cue: s } : s))
    .filter((s) => s && (s.cue || s.action || s.op))
    .slice(0, 24)
    .map((s) => ({
      cue: s.cue ? String(s.cue) : null,
      action: s.action ? String(s.action) : null,
      op: s.op ? String(s.op) : 'cue',
      after: Math.min(20000, Math.max(0, Number(s.after) || DEFAULT_AFTER)),
    }))
  if (!steps.length) return null
  return {
    name: name.slice(0, 16),
    desc: String(raw.desc || '').slice(0, 120),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).slice(0, 12)).slice(0, 4) : [],
    say: raw.say ? String(raw.say).slice(0, 60) : null,
    source,
    steps,
  }
}

/**
 * 合并出厂预设与用户态，返回 { list, get }。
 * 名字是唯一键：用户存过就覆盖出厂，删过就藏起来。
 */
export function makePresetStore({ persona, userDataDir, log = () => {} }) {
  const user = readUser(userDataDir)
  const map = new Map()

  for (const raw of persona.factoryPresets) {
    const p = normalizePreset(raw, 'factory')
    if (p) map.set(p.name, p)
  }
  for (const [name, raw] of Object.entries(user.saved || {})) {
    const p = normalizePreset({ ...raw, name }, 'user')
    if (p) map.set(p.name, p)
  }
  for (const name of user.deleted || []) map.delete(name)
  // 注释（desc）与顺序：用户改过的注释优先
  for (const [name, note] of Object.entries(user.notes || {})) {
    const p = map.get(name)
    if (p) p.desc = String(note).slice(0, 120)
  }

  const order = Array.isArray(user.order) ? user.order : []
  function list() {
    const all = [...map.values()]
    const rank = (n) => {
      const i = order.indexOf(n)
      return i < 0 ? order.length + all.indexOf(map.get(n)) : i
    }
    return all.sort((a, b) => rank(a.name) - rank(b.name))
  }

  function save(raw) {
    const p = normalizePreset(raw, 'user')
    if (!p) return { ok: false, error: '预设至少要有一个 step（{cue:"歪头"} 这种）' }
    const cur = readUser(userDataDir)
    cur.saved = cur.saved || {}
    cur.saved[p.name] = p
    cur.deleted = (cur.deleted || []).filter((n) => n !== p.name)
    if (!p.desc && cur.notes?.[p.name]) p.desc = cur.notes[p.name]
    map.set(p.name, p)
    writeUser(userDataDir, cur)
    log('[preset] 保存', p.name, p.steps.length, '步')
    return { ok: true, preset: p }
  }

  function remove(name) {
    const key = String(name || '')
    if (!map.has(key)) return { ok: false, error: `没有预设「${key}」` }
    const cur = readUser(userDataDir)
    delete (cur.saved || {})[key]
    cur.deleted = [...new Set([...(cur.deleted || []), key])]
    map.delete(key)
    writeUser(userDataDir, cur)
    log('[preset] 删除', key)
    return { ok: true }
  }

  /** 只改注释，不动步骤 */
  function annotate(name, desc) {
    const key = String(name || '')
    const p = map.get(key)
    if (!p) return { ok: false, error: `没有预设「${key}」` }
    p.desc = String(desc || '').slice(0, 120)
    const cur = readUser(userDataDir)
    cur.notes = { ...(cur.notes || {}), [key]: p.desc }
    writeUser(userDataDir, cur)
    log('[preset] 注释', key, '→', p.desc)
    return { ok: true, preset: p }
  }

  /** 调整顺序（可选，给设置页拖拽用） */
  function reorder(names) {
    const cur = readUser(userDataDir)
    cur.order = (Array.isArray(names) ? names : []).map(String)
    writeUser(userDataDir, cur)
    return { ok: true }
  }

  return { list, get: (n) => map.get(String(n || '')) || null, save, remove, annotate, reorder }
}
