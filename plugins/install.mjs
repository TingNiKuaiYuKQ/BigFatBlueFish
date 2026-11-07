// 把 pet-bridge 挂进 DSH 的 desktop profile。
//
// 默认只预览，不写任何文件：
//     node plugins/install.mjs
// 确认无误后再落盘：
//     node plugins/install.mjs --apply
//
// 落盘做的事（可重复执行）：
//   1. 备份 profile 的 package.json 到 .bak-<时间戳>
//   2. 在插件根目录（PET_PLUGIN_ROOT 或 %LOCALAPPDATA%\BigFatBlueFish\Plugin）
//      建一个指向本仓库 plugins/dsh/ 的目录联接
//      （用联接而不是拷贝：改代码即时生效，不用每次重装）
//   3. dependencies 加 "pet-bridge": "link:<联接路径>"
//   4. bundles 数组尾部加 "pet-bridge"
//
// 不会动 settings.yaml、不删任何东西、不执行 pnpm。

import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'dsh')

/**
 * 插件装到哪里：不写死任何盘符。
 *   1. 环境变量 PET_PLUGIN_ROOT 优先（想装到别处就设它）；
 *   2. 否则 %LOCALAPPDATA%\BigFatBlueFish\Plugin（Windows），
 *      其它平台 ~/.local/share/bigfatbluefish/plugin。
 * 预览模式会把最终路径打出来，确认后再 --apply。
 */
function resolvePluginRoot() {
  const fromEnv = String(process.env.PET_PLUGIN_ROOT || '').trim()
  if (fromEnv) return { root: fromEnv, from: 'PET_PLUGIN_ROOT' }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return { root: join(process.env.LOCALAPPDATA, 'BigFatBlueFish', 'Plugin'), from: '%LOCALAPPDATA%' }
  }
  return { root: join(homedir(), '.local', 'share', 'bigfatbluefish', 'plugin'), from: '~/.local/share' }
}

const { root: PLUGIN_ROOT, from: ROOT_FROM } = resolvePluginRoot()
const LINK = join(PLUGIN_ROOT, 'pet-bridge')
const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json')
const APPLY = process.argv.includes('--apply')

const ok = (s) => `\x1b[32m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const warn = (s) => `\x1b[33m${s}\x1b[0m`
const bad = (s) => `\x1b[31m${s}\x1b[0m`

function fail(msg) {
  console.error(bad('✗ ') + msg)
  process.exit(1)
}

if (!existsSync(join(SRC, 'lib', 'index.js'))) fail(`找不到插件源码：${SRC}/lib/index.js`)
if (!existsSync(PROFILE)) fail(`找不到 profile：${PROFILE}（DSH 装过吗？）`)

const raw = readFileSync(PROFILE, 'utf8')
let pkg
try { pkg = JSON.parse(raw) } catch (e) { fail(`profile 不是合法 JSON：${e.message}`) }

pkg.dependencies ||= {}
pkg.dsh ||= {}
pkg.dsh.profile ||= {}
pkg.dsh.profile.bundles ||= []

const already = pkg.dependencies['pet-bridge']
const inBundles = pkg.dsh.profile.bundles.includes('pet-bridge')

console.log(`\n  profile   ${PROFILE}`)
console.log(`  源码      ${SRC}`)
console.log(`  联接      ${LINK}  ${dim(`（来自 ${ROOT_FROM}）`)}`)
console.log(`  当前状态  ${already ? dim('依赖已存在: ' + already) : '依赖未添加'} / ${inBundles ? dim('bundles 已含') : 'bundles 未含'}`)
console.log(dim('  想装到别处：设环境变量 PET_PLUGIN_ROOT 再跑一次'))

// 只加缺的那部分，重复执行不会产生重复项
pkg.dependencies['pet-bridge'] = `link:${LINK}`
if (!inBundles) pkg.dsh.profile.bundles.push('pet-bridge')

const next = JSON.stringify(pkg, null, 2) + '\n'

console.log('\n  package.json 变动：')
if (next === raw) {
  console.log(dim('    （无变化）'))
} else {
  if (already !== `link:${LINK}`) console.log(`    + dependencies["pet-bridge"] = "link:${LINK}"`)
  if (!inBundles) console.log('    + dsh.profile.bundles += "pet-bridge"')
}
console.log('    bundles 顺序：', pkg.dsh.profile.bundles.join(' → '))

if (!APPLY) {
  console.log(warn('\n  预览模式，什么都没写。确认后执行：node install.mjs --apply\n'))
  process.exit(0)
}

// 1) 备份
if (next !== raw) {
  const bak = `${PROFILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(PROFILE, bak)
  console.log(ok('  ✓ ') + `已备份 → ${bak}`)
  writeFileSync(PROFILE, next, 'utf8')
  console.log(ok('  ✓ ') + 'profile package.json 已更新')
} else {
  console.log(dim('  · package.json 无需改动'))
}

// 2) 目录联接（已存在就跳过；存在但指向别处会提示，不擅自删）
mkdirSync(PLUGIN_ROOT, { recursive: true })
if (existsSync(LINK)) {
  console.log(dim(`  · 联接已存在，跳过：${LINK}`))
} else {
  try {
    symlinkSync(SRC, LINK, 'junction')
    console.log(ok('  ✓ ') + `已建立目录联接 → ${LINK}`)
  } catch (e) {
    console.log(warn('  ! ') + `联接失败（${e.message}），改用拷贝`)
    mkdirSync(LINK, { recursive: true })
    for (const f of ['package.json', 'cordis.patch.yml']) {
      copyFileSync(join(SRC, f), join(LINK, f))
    }
    mkdirSync(join(LINK, 'lib'), { recursive: true })
    mkdirSync(join(LINK, 'docs'), { recursive: true })
    mkdirSync(join(LINK, 'data'), { recursive: true })
    copyFileSync(join(SRC, 'lib', 'index.js'), join(LINK, 'lib', 'index.js'))
    copyFileSync(join(SRC, 'docs', 'DSH-API.md'), join(LINK, 'docs', 'DSH-API.md'))
    console.log(warn('  ! ') + '已拷贝（改代码后需要重跑本脚本）')
  }
}

console.log(`
${ok('安装完成。')}接下来两步：

  1. 装依赖（link: 协议需要 pnpm 建链接）
     ${dim(`cd "${dirname(PROFILE)}" && pnpm install`)}

  2. 重启 DSH Desktop

验证：重启后打开 ${dim('~/.dsh/live2d/')}，应出现 status.json；
      另开一个终端跑 ${dim('node 其他/tests/fake-stage.mjs')}，随便问 DSH 一句话，
      终端里应依次打出 思考中 → 干活中 → 成功。

出问题看 ${dim('~/.dsh/live2d/bridge-error.log')}；不想用了把 bundles 里那行删掉即可。
`)
