// Writes a tiny file, then reports the result. Used to check .dsh/live2d ACLs.
const fs = require('node:fs')

const file = process.argv[2]
try {
  fs.writeFileSync(file, 'probe')
  console.log(JSON.stringify({ ok: true, file }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, file, code: e.code, message: e.message }))
}
