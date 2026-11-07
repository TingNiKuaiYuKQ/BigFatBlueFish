// 模型准备层：贴图按需压缩 + 表情文件扫描。
//
// 为什么要压贴图：这个大肥鱼模型的贴图是 4096×8192、8192×8192 各一张，
// 8192² 单张解码后就是 256MB 显存，整模型能吃到 600MB，桌宠这种常驻小程序受不了。
// 压到最长边 2048 后，520×780 的窗口上肉眼看不出差别，显存掉到 1/16。
//
// 为什么用 nativeImage：Electron 自带，不引 sharp / canvas 这些原生依赖，
// 少一个编译点就少一类装不上的故障。
//
// 产物写回模型目录（不复制 moc3/physics）：
//   <modelDir>/大肥鱼.opt2048.model3.json   ← 只改了 Textures 指向
//   <modelDir>/大肥鱼.4096_opt2048/texture_00.png ...
// 原文件一个字节都不动，想还原把 opt 文件删掉即可。

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'
// 刻意不 import 'electron'：这个模块由主进程（CJS）动态导入，
// 而 Electron 45 的 ESM 看板对 electron 包的导出支持不全。
// 需要 nativeImage 的地方由调用方传进来，模块本身保持可单测。

/** 读 model3.json，换成绝对路径 */
export function readModelJson(modelDir, modelFile) {
  const p = join(modelDir, modelFile)
  return { path: p, json: JSON.parse(readFileSync(p, 'utf8')) }
}

/**
 * 确保存在压缩后的 model3，返回它的绝对路径。
 * @param {object} o
 * @param {string} o.modelDir 模型目录绝对路径
 * @param {string} o.modelFile model3 文件名
 * @param {number} o.maxEdge 最长边上限，0/负数 = 跳过
 * @param {(msg:string)=>void} [o.log]
 */
export function ensureOptimizedModel({ modelDir, modelFile, maxEdge, nativeImage, log = () => {} }) {
  if (!maxEdge || maxEdge <= 0) return join(modelDir, modelFile)
  if (!nativeImage) throw new Error('ensureOptimizedModel 需要传入 nativeImage（由主进程给）')

  const { path: srcPath, json } = readModelJson(modelDir, modelFile)
  const base = basename(modelFile, extname(modelFile))
  const outName = `${base}.opt${maxEdge}.model3.json`
  const outPath = join(modelDir, outName)
  const textures = json?.FileReferences?.Textures || []
  if (!textures.length) return srcPath

  // 缓存判定：产物存在且比源 model3 与所有源贴图都新，就直接用
  if (existsSync(outPath)) {
    const outAt = statSync(outPath).mtimeMs
    const sources = [srcPath, ...textures.map((t) => join(modelDir, t))]
    const newestSrc = Math.max(...sources.map((s) => (existsSync(s) ? statSync(s).mtimeMs : 0)))
    if (outAt >= newestSrc) {
      log(`贴图已压缩过，复用 ${outName}`)
      return outPath
    }
    log('源文件比压缩产物新，重新压缩')
  }

  const nextJson = JSON.parse(JSON.stringify(json))
  const nextTextures = []

  for (const rel of textures) {
    const abs = join(modelDir, rel)
    if (!existsSync(abs)) {
      log(`缺贴图：${rel}，跳过压缩`)
      return srcPath
    }
    const img = nativeImage.createFromPath(abs)
    if (img.isEmpty()) {
      log(`贴图读不出：${rel}，跳过压缩`)
      return srcPath
    }
    const { width, height } = img.getSize()
    const longest = Math.max(width, height)
    if (longest <= maxEdge) {
      nextTextures.push(rel)
      continue
    }
    const k = maxEdge / longest
    const tw = Math.max(1, Math.round(width * k))
    const th = Math.max(1, Math.round(height * k))
    const resized = img.resize({ width: tw, height: th, quality: 'good' })

    const texDir = dirname(rel)
    const outDirRel = `${texDir}_opt${maxEdge}`
    const outFileRel = `${outDirRel}/${basename(rel)}`
    const outFileAbs = join(modelDir, outFileRel)
    mkdirSync(dirname(outFileAbs), { recursive: true })
    writeFileSync(outFileAbs, resized.toPNG())
    nextTextures.push(outFileRel)
    log(`贴图 ${rel} ${width}×${height} → ${tw}×${th}`)
  }

  nextJson.FileReferences.Textures = nextTextures
  writeFileSync(outPath, JSON.stringify(nextJson, null, '\t'), 'utf8')
  log(`已生成 ${outName}`)
  return outPath
}

/**
 * 扫描 Exp3 目录，把每个 .exp3.json 读成 { 参数: 值, blend }。
 * 表情名用文件名（去掉扩展名），和 VTube Studio / Live2D 的习惯一致。
 */
export function loadExpressions(modelDir, expDir = 'Exp3') {
  const dir = join(modelDir, expDir)
  const out = {}
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.exp3.json')) continue
    const name = f.replace(/\.exp3\.json$/, '')
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      const params = Array.isArray(d?.Parameters) ? d.Parameters : []
      out[name] = params
        .filter((p) => p && typeof p.Id === 'string' && Number.isFinite(Number(p.Value)))
        .map((p) => ({
          id: p.Id,
          value: Number(p.Value),
          blend: p.Blend === 'Multiply' || p.Blend === 'Overwrite' ? p.Blend : 'Add',
        }))
    } catch {
      // 单个表情坏了不该拖垮启动，跳过并让上层打日志
    }
  }
  return out
}

/** 模型目录里的动作文件清单（暂时不用，留给以后接 mot3） */
export function loadMotions(modelDir, animDir = 'Animation') {
  const dir = join(modelDir, animDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.motion3.json')).map((f) => f.replace(/\.motion3\.json$/, ''))
}
