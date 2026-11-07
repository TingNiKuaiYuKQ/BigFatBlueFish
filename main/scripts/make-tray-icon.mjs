// 生成托盘图标 modules/ui/assets/tray.png（32×32，RGBA，透明背景）。
//
// 为什么自己画而不是从模型截图裁：截图是白底不透明，贴到深色任务栏上就是一块
// 白方块；裁模型头部又会在 16px 缩放下糊成一团。这里用纯几何画一只「蓝鱼」：
// 圆身 + 浅色肚皮 + 两只眼 + 尾巴三角，16/32px 都认得出来。
//
// 手写 PNG（zlib + CRC），不引第三方依赖 —— 这张图只会生成一次，产物进 git。

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'modules', 'ui', 'assets', 'tray.png')
const S = 32

const px = new Uint8Array(S * S * 4)

function put(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return
  const i = (y * S + x) * 4
  // 简单 alpha 混合（图标是画在透明底上的，重叠处按 a 加权）
  const sa = a / 255
  const da = px[i + 3] / 255
  const oa = sa + da * (1 - sa)
  if (oa <= 0) return
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa)
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa)
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa)
  px[i + 3] = Math.round(oa * 255)
}

/** 抗锯齿圆：按到圆心的距离做 1px 羽化 */
function circle(cx, cy, rad, color) {
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const a = Math.max(0, Math.min(1, rad - d + 0.5))
      if (a > 0) put(x, y, color[0], color[1], color[2], Math.round(255 * a))
    }
  }
}

/** 三角形（尾巴）：重心坐标判定 + 边缘羽化 */
function tri(p1, p2, p3, color) {
  const sign = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const p = [x + 0.5, y + 0.5]
      const d1 = sign(p, p1, p2)
      const d2 = sign(p, p2, p3)
      const d3 = sign(p, p3, p1)
      const neg = d1 < 0 || d2 < 0 || d3 < 0
      const pos = d1 > 0 || d2 > 0 || d3 > 0
      if (!(neg && pos)) put(x, y, color[0], color[1], color[2], 255)
    }
  }
}

// 身体：深蓝圆（#2F6FD0），尾巴：同色三角（右上）
circle(15, 17, 11, [47, 111, 208])
tri([24, 9], [31, 4], [28, 16], [47, 111, 208])
// 肚皮：浅蓝（#CDE6FF）
circle(15, 19.5, 6.5, [205, 230, 255])
// 眼睛：深色两点 + 高光
circle(11.5, 13.5, 1.8, [24, 40, 66])
circle(18.5, 13.5, 1.8, [24, 40, 66])
put(11, 13, 255, 255, 255)
put(18, 13, 255, 255, 255)
// 嘴：一条浅色小弧（用三点近似）
put(15, 19, 120, 160, 210)
put(14, 19, 120, 160, 210)
put(16, 19, 120, 160, 210)

/* ---------------- PNG 编码 ---------------- */

const table = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8      // bit depth
ihdr[9] = 6      // color type RGBA

// 每行前面加过滤字节 0（None）
const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y += 1) {
  raw[y * (S * 4 + 1)] = 0
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, png)
console.log('已生成', OUT, png.length, 'bytes')
