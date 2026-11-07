const { app } = require('electron')
console.log('HELLO', process.versions.electron, process.versions.node)
app.whenReady().then(() => { console.log('READY'); setTimeout(() => app.exit(0), 300) })
