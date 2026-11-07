// preload：渲染层唯一能碰到主进程的口子。
// 只暴露明确的方法，不暴露 ipcRenderer 本体 —— 渲染层拿不到任意通道。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  boot: () => ipcRenderer.invoke('boot'),

  bounds: () => ipcRenderer.invoke('win:bounds'),
  move: (x, y) => ipcRenderer.send('win:move', x, y),

  ignoreMouse: (v) => ipcRenderer.send('win:ignore-mouse', v),
  menu: () => ipcRenderer.send('ui:menu'),
  // 右键短按 → 胶囊菜单（暂时复用原生菜单通道，interact.js 里调）
  openMenu: () => ipcRenderer.send('ui:menu'),
  // 进入/退出「编辑模式」：期间主进程暂停自动穿透判定
  setEdit: (v) => ipcRenderer.send('pet:edit', v),
  // 低打扰（0.5.4）：左键单击退出、右键短按退出，都走这条
  lowExit: () => ipcRenderer.send('pet:low-exit'),
  // 等比缩放：只给目标宽度，主进程按原始宽高比换算高度并以中心为锚点
  resize: (w) => ipcRenderer.send('win:resize', w),

  quit: () => ipcRenderer.send('app:quit'),
  openConfig: () => ipcRenderer.send('app:open-config'),
  openStatus: () => ipcRenderer.send('app:open-status'),

  runShortcut: (id) => ipcRenderer.invoke('shortcut:run', id),

  log: (...a) => ipcRenderer.send('log', ...a),

  // 模型在窗口里的实际显示矩形（CSS 像素）：菜单要贴着「人物」而不是窗口边缘，
  // 因为窗口左右各有约 120px 的透明留白（模型比窗口窄）
  // 气泡是独立窗口：内容宽度不该被舞台宽度限制（舞台缩到 300px 时，
  // 画在舞台里的气泡会把一句话切成五六行）
  bubbleShow: (payload) => ipcRenderer.send('pet:bubble', payload),
  bubbleHide: () => ipcRenderer.send('pet:bubble-hide'),
  modelRect: (r) => ipcRenderer.send('pet:model-rect', r),
  // 轮廓掩码送给主进程做穿透判定（主进程有全局光标，不会死锁）
  sendMask: (m) => ipcRenderer.send('pet:mask', m),
  setDragging: (v) => ipcRenderer.send('pet:dragging', v),
  // 当前激活的表情集合，主进程用它画右键菜单的勾选状态
  exprState: (names) => ipcRenderer.send('pet:expr-state', names),
  // 姿势上报：驾驶员事件附带「当前舞台状态」用
  stageState: (s) => ipcRenderer.send('pet:stage-state', s),
  // 参数转储（调试 /api/params 用）：主进程发快照请求，渲染层采集后回传
  onDumpParams: (cb) => {
    const h = () => { try { cb() } catch { /* 采集失败不影响主流程 */ } }
    ipcRenderer.on('pet:dump-params', h)
    return () => ipcRenderer.removeListener('pet:dump-params', h)
  },
  dumpParams: (list) => ipcRenderer.send('pet:params-dump', list),
  // 动画遥测（1.0.0 调试 /api/debug/frames 用）：开关走主动下发，快照走请求-应答。
  // 平滑度问题（一顿一顿、跳帧）只有逐帧数据能定位，参数转储是「某一刻」的，不够。
  onTelemetry: (cb) => {
    const h = (_e, o) => { try { cb(o) } catch { /* 开关失败不影响演出 */ } }
    ipcRenderer.on('pet:telemetry-set', h)
    return () => ipcRenderer.removeListener('pet:telemetry-set', h)
  },
  onDumpFrames: (cb) => {
    const h = () => { try { cb() } catch { /* 采集失败不影响主流程 */ } }
    ipcRenderer.on('pet:dump-frames', h)
    return () => ipcRenderer.removeListener('pet:dump-frames', h)
  },
  dumpFrames: (payload) => ipcRenderer.send('pet:frames-dump', payload),
  // 交互/观察类事件上报：主进程按「主动说话」频率门控后写 pet-events.json，
  // 插件轮询转发到绑定的驾驶员会话
  driverEvent: (payload) => ipcRenderer.send('pet:driver-event', payload),

  onState: (cb) => {
    const h = (_e, s) => cb(s)
    ipcRenderer.on('pet:state', h)
    return () => ipcRenderer.removeListener('pet:state', h)
  },
  // 窗口尺寸被编辑模式改过之后通知一次，渲染层据此重设 PIXI 分辨率
  onResized: (cb) => {
    const h = (_e, s) => cb(s)
    ipcRenderer.on('pet:resized', h)
    return () => ipcRenderer.removeListener('pet:resized', h)
  },
  // 胶囊菜单里「渲染层负责」的动作（换装 / 换表情 / 换姿势）
  onMenuAction: (cb) => {
    const h = (_e, a) => cb(a)
    ipcRenderer.on('pet:menu-action', h)
    return () => ipcRenderer.removeListener('pet:menu-action', h)
  },
  onAction: (cb) => {
    const h = (_e, a) => cb(a)
    ipcRenderer.on('pet:action', h)
    return () => ipcRenderer.removeListener('pet:action', h)
  },
  // 全局光标位置（归一化到屏幕，-1..1）：眼神要跟全屏，不能只用窗口内坐标
  onGaze: (cb) => {
    const h = (_e, g) => cb(g)
    ipcRenderer.on('pet:gaze', h)
    return () => ipcRenderer.removeListener('pet:gaze', h)
  },
})
