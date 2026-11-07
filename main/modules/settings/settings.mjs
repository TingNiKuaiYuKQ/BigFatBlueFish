// 运行时设置存储（main/runtime/app/settings.json）。
//
// 为什么不在 config.json：config 是「改了要重启」的设计参数，由人手维护；
// 这里是设置页随时可改的运行时偏好（主题、主动说话、频率、绑定会话），
// 程序自己读写。混在一起会互相覆盖 —— 和 window.json 分出来的理由相同。

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const SETTINGS_DEFAULTS = {
  // 主题三色 + 文字色（外观页）
  theme: { uiBg: '#ffffff', uiStar: '#e6efff', uiEdge: '#5686fe', uiText: '#2f5aa8' },
  uiScale: 1,
  // 主动说话：关 = 任何自动事件都不发给驾驶员；频率只影响自动事件，
  // 用户在输入胶囊里手动说的话不受门控
  proactive: false,
  freq: 'low',           // low 25% / mid 66% / high 100%
  // 绑定的驾驶员会话（插件上报的 id）。null = 没绑，主动说话静默丢弃
  bind: null,
  // 帧率上限（外观页）：30 / 60 / 0（0 = 屏幕支持的最大帧率，交给 vsync）
  fpsCap: 0,
  // 全屏应用/游戏时自动进入省电模式（设置页保存后必须能跨重启保留）
  autoLowInterrupt: false,
}

/** 外观页的三个档位；其它值一律按「无限制」处理（别让手改坏文件把画面卡成 3fps） */
export const FPS_CHOICES = [30, 60, 0]

/** 从设置里取帧率上限（0 = 不限） */
export function fpsFrom(settings) {
  const v = Number(settings && settings.fpsCap)
  return FPS_CHOICES.includes(v) ? v : 0
}

const FREQS = new Set(['low', 'mid', 'high'])

// 主题色的键名有两套写法：设置页按 CSS 变量名传 `ui-bg`，本文件内部按驼峰存
// `uiBg`。之前只认驼峰，页面传的四个颜色全被丢掉 —— 表现是「改完主题色，
// 关掉设置页再打开就回默认」。这里两种都收，统一成驼峰。
const THEME_KEYS = { 'ui-bg': 'uiBg', 'ui-star': 'uiStar', 'ui-edge': 'uiEdge', 'ui-text': 'uiText', uiBg: 'uiBg', uiStar: 'uiStar', uiEdge: 'uiEdge', uiText: 'uiText' }

function sanitize(input) {
  const s = input && typeof input === 'object' ? input : {}
  const out = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS))
  if (s.theme && typeof s.theme === 'object') {
    for (const [rawKey, v] of Object.entries(s.theme)) {
      const k = THEME_KEYS[rawKey]
      if (k && typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) out.theme[k] = v
    }
  }
  const scale = Number(s.uiScale)
  if (Number.isFinite(scale) && scale >= 0.2 && scale <= 3) out.uiScale = scale
  out.proactive = !!s.proactive
  if (FREQS.has(s.freq)) out.freq = s.freq
  if (s.bind === null || typeof s.bind === 'string') out.bind = s.bind || null
  const fps = Number(s.fpsCap)
  if (FPS_CHOICES.includes(fps)) out.fpsCap = fps
  out.autoLowInterrupt = s.autoLowInterrupt === true
  return out
}

/** 深合并读取：文件坏了/不存在都退默认，绝不影响主流程 */
export function loadSettings(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return sanitize({ ...SETTINGS_DEFAULTS, ...raw, theme: { ...SETTINGS_DEFAULTS.theme, ...(raw && raw.theme) } })
  } catch {
    return JSON.parse(JSON.stringify(SETTINGS_DEFAULTS))
  }
}

/** 合并写入（原子替换）。返回保存后的完整设置 */
export function saveSettings(path, patch) {
  const next = sanitize({ ...loadSettings(path), ...(patch && typeof patch === 'object' ? patch : {}) })
  if (patch && patch.theme && typeof patch.theme === 'object') Object.assign(next.theme, sanitize({ theme: patch.theme }).theme)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(path + '.tmp') } catch { /* 没写出来就算了 */ }
    throw e
  }
  return next
}
