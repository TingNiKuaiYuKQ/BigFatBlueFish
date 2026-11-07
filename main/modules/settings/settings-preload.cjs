// 设置窗口的 preload：只暴露「关掉」。
// 设置项全部在渲染层本地生效（CSS 变量），暂时不需要回传主进程。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settingsApi', {
  close: () => ipcRenderer.send('settings:close'),
})
