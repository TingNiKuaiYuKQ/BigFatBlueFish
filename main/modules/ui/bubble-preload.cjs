// 气泡窗口的 preload。
//
// 只有三件事：收「显示/隐藏」指令、把量好的尺寸回传（主进程据此改窗口大小）、
// 以及「我说完了」信号（主进程据此把窗口藏起来，省一次合成）。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bubbleApi', {
  onShow: (cb) => ipcRenderer.on('bubble:show', (_e, payload) => cb(payload || {})),
  onTail: (cb) => ipcRenderer.on('bubble:tail', (_e, x) => cb(x)),
  onHide: (cb) => ipcRenderer.on('bubble:hide', () => cb()),
  resize: (w, h) => ipcRenderer.send('bubble:size', { w, h }),
  done: () => ipcRenderer.send('bubble:done'),
})
