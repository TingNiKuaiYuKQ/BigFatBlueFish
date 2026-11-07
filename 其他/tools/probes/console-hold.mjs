// Console-subsystem process used to prove MainWindowHandle detects a console window.
import { writeFileSync } from 'node:fs'

writeFileSync(process.argv[2], String(process.pid))
setTimeout(() => {}, 4500)
