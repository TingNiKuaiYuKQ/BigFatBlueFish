// 把带透明通道的 PNG（capturePage 在透明窗口上得到的就是这种）合成到白底。
// 纯 Node 实现：zlib 解/压 + 手写 PNG 反过滤 + 重编码，不依赖任何第三方库。
// 用在截图通道里，让「透明背景」在普通看图器里也看得清（否则被渲染成黑/棋盘格）。

const zlib = require('node:zlib')

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * 输入 RGBA PNG 的 Buffer，返回白底合成后的 RGBA PNG Buffer。
 * 非 RGBA（colorType !== 6）原样返回，避免误伤。
 */
function flattenToWhite(png) {
  if (!Buffer.isBuffer(png) || png.readUInt32BE(0) !== 0x89504e47) return png
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const bitDepth = png[24]
  const colorType = png[25]
  if (bitDepth !== 8 || colorType !== 6) return png // 只处理 8-bit RGBA

  // 收齐 IDAT
  let idat = Buffer.alloc(0)
  let off = 8
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('ascii', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IDAT') idat = Buffer.concat([idat, data])
    off += 12 + len
  }

  const raw = zlib.inflateSync(idat)
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  const prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p++]
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[p++]
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v
      switch (filter) {
        case 0: v = rawByte; break
        case 1: v = rawByte + a; break
        case 2: v = rawByte + b; break
        case 3: v = rawByte + ((a + b) >> 1); break
        case 4: v = rawByte + paeth(a, b, c); break
        default: v = rawByte
      }
      cur[x] = v & 0xff
    }
    // 白底合成：src*alpha + 255*(1-alpha)
    for (let x = 0; x < width; x += 1) {
      const i = x * bpp
      const alpha = cur[i + 3] / 255
      const ia = 1 - alpha
      out[y * stride + i] = Math.round(cur[i] * alpha + 255 * ia)
      out[y * stride + i + 1] = Math.round(cur[i + 1] * alpha + 255 * ia)
      out[y * stride + i + 2] = Math.round(cur[i + 2] * alpha + 255 * ia)
      out[y * stride + i + 3] = 255
    }
    cur.copy(prev)
  }

  // 重编码：每行 filter 0
  const rawOut = Buffer.alloc(height * (stride + 1))
  let q = 0
  for (let y = 0; y < height; y += 1) {
    rawOut[q++] = 0
    out.copy(rawOut, q, y * stride, y * stride + stride)
    q += stride
  }
  const idatOut = zlib.deflateSync(rawOut)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idatOut),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

module.exports = { flattenToWhite }
