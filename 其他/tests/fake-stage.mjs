// 假舞台：不装 Electron、不载 Live2D，只验证「插件 ↔ 协议 ↔ 桌宠」这条链路。
//
// 它做的事和真桌宠完全一样：把 endpoint.json 写出去、轮询 status.json、
// 处理 /api/say 等反向调用、执行白名单指令。区别只是「画」的那一步换成打日志。
//
//   node 其他/tests/fake-stage.mjs
//
// 然后在 DSH 里问一句「你在吗」，看这边是否打出 思考中 → 干活中 → 成功。

import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import paths from '../../main/modules/core/paths.cjs'
import { startStageServer } from '../../main/modules/core/server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const POLL_MS = 250

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

const STATE_LABEL = {
  thinking: '思考中',
  working: '干活中',
  result: '出结果',
  waiting: '等你确认',
  success: '成功',
  error: '出错',
  null: '空闲',
}

/** 首次运行把仓库里的白名单复制到握手目录，插件才读得到 */
function ensureShortcuts() {
  mkdirSync(paths.DIR, { recursive: true })
  if (!existsSync(paths.SHORTCUTS)) {
    const src = paths.LEGACY_SHORTCUTS
    if (existsSync(src)) {
      copyFileSync(src, paths.SHORTCUTS)
      console.log(C.dim(`已复制快捷指令白名单 → ${paths.SHORTCUTS}`))
    }
  }
}

function readStatus() {
  try {
    return JSON.parse(readFileSync(paths.STATUS, 'utf8'))
  } catch {
    return null
  }
}

async function main() {
  ensureShortcuts()

  let last = null
  const stage = await startStageServer({
    modulesRoot: paths.MODULES_DIR,
    modelDir: paths.MODEL_DIR,
    vendorDir: paths.VENDOR_DIR,
    getState: () => last || {},
    onEvent: (evt) => {
      // 真桌宠在这里驱动模型；假舞台只打印
      if (evt.kind === 'say') {
        const bits = []
        if (evt.expression) bits.push(`表情=${evt.expression}`)
        if (evt.pose) bits.push(`姿势=${evt.pose}`)
        const tail = bits.length ? C.dim(`  〔${bits.join(' · ')}〕`) : ''
        console.log(`${C.bold('💬 气泡')} ${evt.text}  ${C.dim(`(${evt.ms}ms)`)}${tail}`)
      } else if (evt.kind === 'expression') {
        console.log(`${C.bold('😊 表情')} ${evt.name || '默认'}`)
      } else if (evt.kind === 'pose') {
        console.log(`${C.bold('🤚 姿势')} ${evt.name}`)
      } else if (evt.kind === 'shortcut') {
        const tag = evt.ok ? C.green('✓') : C.red('✗')
        console.log(`${C.bold('⚡ 快捷指令')} ${tag} ${evt.id} ${C.dim(evt.label || '')}`)
      }
    },
  })

  console.log()
  console.log(C.bold('  桌宠假舞台已就绪（协议验证模式）'))
  console.log(C.dim(`  endpoint  ${stage.url}`))
  console.log(C.dim(`  状态文件  ${paths.STATUS}`))
  console.log(C.dim(`  白名单    ${stage.info.shortcuts.length} 条：`
    + (stage.info.shortcuts.map((s) => s.id).join(', ') || '无')))
  console.log(C.dim('  按 Ctrl+C 退出。下面开始跟随 DSH 会话状态：'))
  console.log()

  const timer = setInterval(() => {
    const st = readStatus()
    if (!st) {
      if (last !== null) {
        console.log(C.dim('　（状态文件消失：DSH 可能已退出）'))
        last = null
      }
      return
    }
    const key = `${st.state}|${st.task}|${st.detail}|${st.expression}|${st.pose}`
    const prevKey = last && `${last.state}|${last.task}|${last.detail}|${last.expression}|${last.pose}`
    if (key === prevKey) return
    last = st

    const label = STATE_LABEL[String(st.state)] || st.state
    const color = st.state === 'error' ? C.red
      : st.state === 'success' ? C.green
        : st.state === 'waiting' ? C.yellow
          : C.cyan
    const parts = [color(label.padEnd(6))]
    if (st.task) parts.push(C.dim('任务:') + st.task)
    if (st.detail) parts.push(C.dim('细节:') + st.detail)
    if (st.expression) parts.push(C.dim('表情:') + st.expression)
    if (st.pose && st.pose !== 'default') parts.push(C.dim('姿势:') + st.pose)
    console.log(parts.join('  '))
  }, POLL_MS)

  const shutdown = async () => {
    clearInterval(timer)
    await stage.close()
    console.log(C.dim('\n  已退出，endpoint.json 已清理。'))
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error(C.red('启动失败：') + (e?.stack || e))
  process.exit(1)
})
