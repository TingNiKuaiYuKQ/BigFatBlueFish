// 临时：解码 session.v4.jsonl.zstd（多帧 zstd 串接），打印尾部若干行的 type + source
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const frames = []
for (let i = 0; i < buf.length;) {
  const j = buf.indexOf(MAGIC, i === 0 ? 0 : i)
  if (j < 0) break
  const k = buf.indexOf(MAGIC, j + 4)
  frames.push(buf.subarray(j, k < 0 ? buf.length : k))
  i = k < 0 ? buf.length : k
}
const lines = frames.flatMap((f) => zstdDecompressSync(f).toString('utf8').split('\n')).filter(Boolean)
const rows = lines.map((l) => { try { return JSON.parse(l) } catch { return { type: '<unparsed>', raw: l.slice(0, 120) } } })
const n = Number(process.argv[3] || 25)
for (const r of rows.slice(-n)) {
  const d = r.data || {}
  const msgs = r.type === 'user/message' ? [d] : ['system/message', 'assistant/message', 'tool/result'].includes(r.type) ? [d.message]
    : r.type === 'agent/inbox/spliced' ? (d.inserted || []) : []
  const srcs = msgs.filter(Boolean).map((m) => JSON.stringify(m.source)).join(' | ')
  console.log(`${r.seq ?? '-'} ${r.type} ${srcs}` + (msgs.length ? ` :: ${String(msgs[0]?.content?.[0]?.text || '').replace(/\s+/g, ' ').slice(0, 70)}` : ''))
}
