// 构建渲染包。
//
// 不能直接用 esbuild CLI：它按「导入文件所在目录」向上找 node_modules，
// 而 0.6.0 的依赖实体在 main/deps/node_modules，modules/ui 不是它的子目录。
// JS API 的 nodePaths 可以显式补上这个搜索根，不必再建 node_modules 联接。
//
//   cd main/deps && npm run build
//   或 node main/scripts/build-renderer.mjs

import { createRequire } from 'node:module'
import { join } from 'node:path'
import paths from '../modules/core/paths.cjs'

// 依赖实体在 main/deps，脚本自身不在它的 node_modules 搜索链上。
const require = createRequire(join(paths.NODE_MODULES, 'noop.js'))
const { build } = require('esbuild')

await build({
  entryPoints: [join(paths.UI_DIR, 'renderer.js')],
  outfile: join(paths.UI_DIR, 'build', 'renderer.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome130',
  nodePaths: [paths.NODE_MODULES],
  logLevel: 'info',
})
