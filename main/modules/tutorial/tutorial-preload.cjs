// 教程窗口的 preload：关闭 / 标记已读 / 打开某一章。
// 教程内容是只读的，不需要更多能力。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tutorialApi', {
  close: () => ipcRenderer.send('tutorial:close'),
  markSeen: () => ipcRenderer.send('tutorial:seen'),
})
