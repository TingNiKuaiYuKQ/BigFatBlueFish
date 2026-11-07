// 胶囊菜单窗口的 preload：暴露「选了哪项」「输入框提交」「关掉」「入场动画放完了」，
// 以及主进程反过来通知页面「该收场了」（失焦时先播完消失动画再关窗口）。
// 展开/收起二级是纯页面内的事（窗口尺寸不变），所以这里没有对应的通道。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('menuApi', {
  pick: (id) => ipcRenderer.send('menu:pick', id),
  input: (text) => ipcRenderer.send('menu:input', text),
  close: () => ipcRenderer.send('menu:close'),
  armed: () => ipcRenderer.send('menu:armed'),
  onDismiss: (fn) => ipcRenderer.on('menu:dismiss', () => fn()),
  // 0.5.7：菜单开着的时候驾驶员可能刚上线/刚下线，输入胶囊的三态要能自己变，
  // 不能只在弹窗那一刻拍一张快照（用户看到的是「打开 DSH 了还显示离线」）。
  status: () => ipcRenderer.invoke('menu:status'),
})
