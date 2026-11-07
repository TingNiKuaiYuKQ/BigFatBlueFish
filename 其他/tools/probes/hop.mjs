// Simulates launch.mjs: a hidden node process that spawns electron.
import { spawn } from 'node:child_process'

const [electron, appDir, marker, userData, childMode = 'childready'] = process.argv.slice(2)
const child = spawn(electron, [
  appDir,
  '--no-sandbox',
  '--force-device-scale-factor=1',
  `--mode=${childMode}`,
  '--marker', marker,
  `--user-data-dir=${userData}`,
], {
  cwd: appDir,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
child.unref()
