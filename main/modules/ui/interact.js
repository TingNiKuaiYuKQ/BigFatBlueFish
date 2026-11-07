/**
 * 交互层：左键点区域、右键短按开菜单、右键长按进「编辑模式」改位置和大小。
 *
 * 为什么单独一个文件：renderer.js 已经够长了，而这里的逻辑是纯状态机 + DOM，
 * 不碰渲染内核，独立出来以后换 UI 风格（比如换成别的菜单样式）不用动主渲染。
 *
 * 状态流转：
 *
 *   idle ──右键按下──> pressing ──<0.5s 松手──> idle（并弹菜单）
 *                        │
 *                        └──≥0.5s──> sweeping ──扫完 360°──> edit
 *
 *   edit ──拖动/缩放一次──> (松手后) 1 秒倒计时 ──> idle
 *   edit ──长按后原样松手（没动过）──> 虚线框常驻，直到真的动过为止
 */

const NS = 'http://www.w3.org/2000/svg'

/** 扫过指示器：8 条绕中心放射的短棒，用 conic-gradient 遮罩做「时钟扫过」 */
function buildSweep(root) {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 100 100')
  svg.setAttribute('width', '100%')
  svg.setAttribute('height', '100%')
  const g = document.createElementNS(NS, 'g')
  g.setAttribute('transform', 'translate(50,50)')
  const N = 8
  for (let i = 0; i < N; i++) {
    const r = document.createElementNS(NS, 'rect')
    r.setAttribute('x', '-3.2')
    r.setAttribute('y', '-41')
    r.setAttribute('width', '6.4')
    r.setAttribute('height', '16')
    r.setAttribute('rx', '3.2')
    r.setAttribute('fill', '#2e2e2e')
    r.setAttribute('transform', `rotate(${(360 / N) * i})`)
    g.appendChild(r)
  }
  svg.appendChild(g)
  root.appendChild(svg)
  return root
}

export function setupInteract(o) {
  const {
    stageEl, api, cfg, log = () => {},
    onGreet, onSkirt, onAction, refreshMask = () => {}, onMenu = null,
    // 双击（同区域 350ms 内第二次点击）。目前只有头部有分支（钢盆）。
    onDouble = null,
    // 进出编辑模式的业务回调（说话 / 换表情 / 退出时恢复）交给 renderer 决定
    onEnterEdit = null, onExitEdit = null,
  } = o

  const I = cfg.interact || {}
  const LONG_MS = Number(I.longPressMs) || 500
  const SWEEP_MS = Number(I.sweepMs) || 500
  const HIDE_MS = Number(I.frameHideDelayMs) || 1000
  const EDGE = Number(I.edgeGrabPx) || 16
  const SMIN = Number(I.scaleMin) || 0.45
  const SMAX = Number(I.scaleMax) || 2.2
  const REGIONS = Array.isArray(I.regions) ? I.regions : []

  let mode = 'idle'          // idle | pressing | sweeping | edit
  let pressTimer = 0
  let pressInEdit = false    // 这次右键按下是不是发生在编辑模式里（短按仍要出菜单）
  let editEntryRelease = false  // 结束「长按进入编辑」的那次松手不算一次交互
  let sweepRaf = 0
  let sweepRoot = null
  let hideTimer = 0
  let editDirty = false      // 这一轮编辑里有没有真的动过
  let left = null            // 左键手势
  let rightDown = false      // 右键是否还按着（长按进编辑后要能直接接着拖）
  // 低打扰（0.5.4）：这段时间里手势全部反转 —— 左键单击退出、右键按住拖动、
  // 不弹菜单、不进编辑、不判区域点击（详见 onDown/onUp 里的分支）。
  let lowMode = false
  let lastPt = { x: 0, y: 0, sx: 0, sy: 0 }
  let drag = null            // 编辑模式拖动
  let resize = null          // 编辑模式缩放
  let pendingMove = null
  let moveRaf = 0

  /* ---------------- DOM：扫过指示器 + 编辑虚线框 ---------------- */

  const sweepEl = document.createElement('div')
  sweepEl.className = 'sweep hidden'
  sweepRoot = buildSweep(sweepEl)

  const frameEl = document.createElement('div')
  frameEl.className = 'eframe hidden'

  // 编辑模式的提示条：进来先告诉你「能拖、能拉」，2.6 秒淡出。
  // 之前只有一根虚线，用户根本不知道边缘能拉 —— 这是「缩放像没实现」的主因。
  const hintEl = document.createElement('div')
  hintEl.className = 'ehint'
  hintEl.textContent = '拖动调位置，拉边框调尺寸'
  let hintTimer = 0

  document.body.appendChild(sweepEl)
  document.body.appendChild(frameEl)
  document.body.appendChild(hintEl)

  /* ---------------- 几何换算：窗口坐标 → 模型归一化 ---------------- */

  // 模型按 k = min(W/ow, H/oh) * scale 缩放，水平居中、底部贴窗口底。
  // 区域表用的是「模型画布归一化坐标」，所以要反算一遍。
  function toModelNorm(cx, cy) {
    const W = window.innerWidth
    const H = window.innerHeight
    const sz = window.__modelSize || { width: 3749, height: 7697 }
    const m = cfg.model || {}
    const scale = Number(m.scale) || 1
    const k = Math.min(W / sz.width, H / sz.height) * scale
    const dw = sz.width * k
    const dh = sz.height * k
    const lx = (W - dw) / 2
    const ty = H - dh - (Number(m.offsetY) || 0)
    return { x: (cx - lx) / dw, y: (cy - ty) / dh }
  }

  function hitRegion(cx, cy) {
    const p = toModelNorm(cx, cy)
    for (const r of REGIONS) {
      const [x0, y0, x1, y1] = r.rect || []
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return r
    }
    return null
  }

  /* ---------------- 扫过动画 ---------------- */

  function startSweep(cx, cy) {
    mode = 'sweeping'
    sweepEl.classList.remove('hidden')
    sweepEl.style.left = cx + 'px'
    sweepEl.style.top = cy + 'px'
    sweepEl.style.setProperty('--deg', '0deg')
    const t0 = performance.now()
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / SWEEP_MS)
      sweepEl.style.setProperty('--deg', (p * 360).toFixed(1) + 'deg')
      if (p < 1) {
        sweepRaf = requestAnimationFrame(tick)
      } else {
        sweepRaf = 0
        sweepEl.classList.add('hidden')
        enterEdit()
        // 关键：长按到扫过走完时手指通常还按着。以前这里不接手势，用户必须
        // 松开再重新按下才能拖 —— 违背直觉。现在直接接着用当前指针起拖。
        if (rightDown) {
          beginDrag()
          // 紧接着的那次松手是「进入编辑」这个动作的结尾，不计为交互
          editEntryRelease = true
        }
      }
    }
    sweepRaf = requestAnimationFrame(tick)
  }

  function cancelSweep() {
    if (sweepRaf) cancelAnimationFrame(sweepRaf)
    sweepRaf = 0
    sweepEl.classList.add('hidden')
  }

  /* ---------------- 编辑模式 ---------------- */

  function enterEdit() {
    mode = 'edit'
    editDirty = false
    frameEl.classList.remove('hidden')
    clearTimeout(hideTimer)
    hintEl.classList.add('show')
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => hintEl.classList.remove('show'), 2600)
    api.setEdit(true)      // 期间禁止自动穿透，否则鼠标移到透明区就收不到事件
    try { onEnterEdit?.() } catch (err) { log('[edit] onEnterEdit 抛错: ' + (err && err.message)) }
    log('[edit] 进入编辑模式')
  }

  /**
   * 用「当前指针位置」起一次拖动。
   *
   * 起点取 window.screenX/screenY（同步、即时），不用 api.bounds()：
   * 后者是异步的，长按扫完立刻移动鼠标时，第一个 pointermove 可能早于
   * bounds 返回，dx 就会被加到 wx=0 上，窗口直接跳到屏幕左上角。
   */
  function beginDrag() {
    drag = { sx: lastPt.sx, sy: lastPt.sy, wx: window.screenX, wy: window.screenY, moved: 0 }
    setCursor('move')
    api.setDragging(true)
    log('[edit] 按住右键直接进入拖动')
  }

  function exitEdit() {
    mode = 'idle'
    editEntryRelease = false
    pressInEdit = false
    frameEl.classList.add('hidden')
    clearTimeout(hideTimer)
    clearTimeout(hintTimer)
    hintEl.classList.remove('show')
    setCursor('')
    api.setEdit(false)
    try { onExitEdit?.() } catch (err) { log('[edit] onExitEdit 抛错: ' + (err && err.message)) }
    log('[edit] 退出编辑模式')
  }

  function markDirty() {
    if (editDirty) return
    editDirty = true
    log('[edit] 已完成一次位置/尺寸调整')
  }

  /**
   * 松手后启动 1s 退出倒计时。
   * 规则（用户定的）：编辑模式里**任意一次交互**都启动倒计时 —— 包括点一下没拖动、
   * 点在区域外的空白处。只有「进了编辑模式什么都没干」（含只是失焦）才让虚线框常驻。
   */
  function armHide() {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (mode !== 'edit') return
      // 走到这里说明「已经松手 1s 了」。如果 drag/resize 还挂着，那是指针事件
      // 丢了（拖到窗口外松手、被系统吃掉 up）：按松手补齐再退，否则框会永远留着。
      if (drag || resize) {
        drag = null
        resize = null
        api.setDragging(false)
        log('[edit] 收尾时发现手势未释放，按松手处理')
      }
      exitEdit()
    }, HIDE_MS)
  }

  /**
   * 缩放判定的基准是**那根虚线**，不是窗口边缘。
   *
   * 之前判的是「离窗口边 16px 内」，但窗口边缘和用户看到的虚线之间隔着 FRAME_INSET，
   * 于是手感是「明明点在框上却没反应，点在框里面反而能拉」。改成量到框线的距离，
   * 用户看到什么就能抓到什么 —— 框线的任意一段（四条边 + 四个圆角）都算缩放。
   */
  const FRAME_INSET = (() => {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--frame-inset'))
    return Number.isFinite(v) ? v : 6
  })()

  function frameDist(cx, cy) {
    const W = window.innerWidth
    const H = window.innerHeight
    const I = FRAME_INSET
    return {
      l: Math.abs(cx - I), r: Math.abs(cx - (W - I)),
      t: Math.abs(cy - I), b: Math.abs(cy - (H - I)),
    }
  }

  function nearFrame(cx, cy) {
    const d = frameDist(cx, cy)
    return Math.min(d.l, d.r, d.t, d.b) <= EDGE
  }

  /**
   * 光标提示：贴着框线就换成双箭头。
   * 距左右框线近 → 横向箭头；距上下近 → 纵向；两边都近（四个圆角处）→ 斜向。
   * 等比缩放用哪个角都一样，所以斜向只看象限，不看具体方向。
   */
  function frameCursor(cx, cy) {
    const d = frameDist(cx, cy)
    const lr = Math.min(d.l, d.r)
    const tb = Math.min(d.t, d.b)
    if (Math.min(lr, tb) > EDGE) return ''
    if (lr <= EDGE && tb <= EDGE) {
      const left = d.l < d.r
      const top = d.t < d.b
      return (left && top) || (!left && !top) ? 'nwse-resize' : 'nesw-resize'
    }
    return lr <= EDGE ? 'ew-resize' : 'ns-resize'
  }

  let cursorNow = null
  function setCursor(c) {
    if (cursorNow === c) return
    cursorNow = c
    // 三处都设：canvas 在 #stage 里，body/html 管空白区，漏一个就会出现
    // 「边框上变了、画面里没变」的半生效状态。
    for (const el of [document.documentElement, document.body, stageEl]) {
      if (el && el.style) el.style.cursor = c || ''
    }
  }

  /* ---------------- 拖动 / 缩放 ---------------- */

  const flushMove = () => {
    moveRaf = 0
    if (!pendingMove) return
    api.move(Math.round(pendingMove.x), Math.round(pendingMove.y))
    pendingMove = null
  }
  const queueMove = (x, y) => {
    pendingMove = { x, y }
    if (!moveRaf) moveRaf = requestAnimationFrame(flushMove)
  }

  /* ---------------- 指针捕获（合成事件会抛，统一兜住） ---------------- */

  const capture = (e) => { try { stageEl.setPointerCapture?.(e.pointerId) } catch { /* 合成事件没有真实 pointer */ } }
  const release = (e) => { try { stageEl.releasePointerCapture?.(e.pointerId) } catch { /* 同上 */ } }

  /* ---------------- 指针事件 ---------------- */

  function onDown(e) {
    // 低打扰（0.5.4）：手势整体反转 —— 右键按住拖窗口、左键单击退出，
    // 不弹菜单、不进编辑、不判区域。这段必须排在所有其它判定之前。
    if (lowMode) {
      if (e.button === 2) {
        rightDown = true
        drag = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, moved: 0 }
        api.setDragging(true)
        capture(e)
        return
      }
      if (e.button === 0) {
        left = { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, t: performance.now() }
        capture(e)
      }
      return
    }

    // 右键先判：0.5s 内抬起 = 弹菜单，按住超过 0.5s = 交给位置/尺寸（编辑）。
    // 必须排在编辑分支之前 —— 以前进了编辑模式后右键全被当成拖动，
    // 抬手既不弹菜单也拖不动，两条手势互相吃掉（用户报的「小冲突」）。
    if (e.button === 2) {
      rightDown = true
      lastPt = { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY }
      capture(e)
      if (mode === 'edit' && nearFrame(e.clientX, e.clientY)) {
        // 编辑模式里抓到虚线框边缘 = 明确的缩放意图，直接交给尺寸，不参与菜单计时
        clearTimeout(hideTimer)
        const fd = frameDist(e.clientX, e.clientY)
        resize = {
          sx: e.screenX, sy: e.screenY,
          w0: window.innerWidth, h0: window.innerHeight,
          edges: { l: fd.l <= EDGE, r: fd.r <= EDGE, t: fd.t <= EDGE, b: fd.b <= EDGE },
        }
        setCursor(frameCursor(e.clientX, e.clientY) || 'ew-resize')
        api.setDragging(true)
        return
      }
      pressInEdit = mode === 'edit'
      mode = 'pressing'
      pressTimer = setTimeout(() => {
        pressTimer = 0
        if (mode !== 'pressing') return
        if (pressInEdit) {
          // 已经在编辑模式了，不用再扫一遍：按住直接接着当前指针起拖
          mode = 'edit'
          clearTimeout(hideTimer)
          beginDrag()
        } else {
          startSweep(e.clientX, e.clientY)
        }
      }, LONG_MS)
      return
    }

    // 编辑模式（左键）：先判是不是抓到了虚线框边缘
    if (mode === 'edit') {
      clearTimeout(hideTimer)
      if (nearFrame(e.clientX, e.clientY)) {
        // 记住抓的是哪几条边：缩放要按「往外拉 = 变大」算方向。
        // 以前只看 |dx| 和 |dy| 谁大，从上边框往上拉（dy 为负）就变成了缩小。
        const fd = frameDist(e.clientX, e.clientY)
        resize = {
          sx: e.screenX, sy: e.screenY,
          w0: window.innerWidth, h0: window.innerHeight,
          edges: { l: fd.l <= EDGE, r: fd.r <= EDGE, t: fd.t <= EDGE, b: fd.b <= EDGE },
        }
        setCursor(frameCursor(e.clientX, e.clientY) || 'ew-resize')
      } else {
        drag = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, moved: 0 }
        setCursor('move')
      }
      api.setDragging(true)
      capture(e)
      return
    }

    if (e.button === 0) {
      // 左键只当「点击」，不再拖窗口。
      //
      // 原因有两层：一是左键要留给直接交互（摸头/裙摆/说话），拖动会把「点一下」
      // 和「挪一下」混在一起，手感必然糊；二是 Windows 上透明窗口靠 setPosition
      // 高频移动，本身就会有旧合成帧残留 —— 拖动一律收到编辑模式里，只留一条路径。
      // 记录按下点是为了「按下和抬起差太多就不算点击」（比如手滑划走）。
      left = { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, t: performance.now() }
      capture(e)
    }
  }

  function onMove(e) {
    lastPt = { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY }
    if (resize) {
      const dx = e.screenX - resize.sx
      const dy = e.screenY - resize.sy
      // 把位移换算成「往外拉了多少」：左边框往外是 dx<0，上边框往外是 dy<0。
      // 取抓到的几条边里最"外"的那个方向，所以无论抓哪条边、往哪边拉，
      // 「往外 = 变大」这件事都成立。四个角（两条边）取较大者即可。
      const e0 = resize.edges || {}
      const outs = []
      if (e0.l) outs.push(-dx)
      if (e0.r) outs.push(dx)
      if (e0.t) outs.push(-dy)
      if (e0.b) outs.push(dy)
      const d = outs.length ? Math.max(...outs) : (Math.abs(dx) >= Math.abs(dy) ? dx : dy)
      const f = Math.max(0.05, (resize.w0 + d * 2) / resize.w0)
      const w = Math.round(resize.w0 * f)
      const minW = Math.round(resize.w0 * SMIN)
      const maxW = Math.round(resize.w0 * SMAX)
      api.resize(Math.max(minW, Math.min(maxW, w)))
      if (Math.abs(d) > 3) markDirty()
      return
    }
    if (drag) {
      const dx = e.screenX - drag.sx
      const dy = e.screenY - drag.sy
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy))
      if (drag.moved > 3) {
        queueMove(drag.wx + dx, drag.wy + dy)
        markDirty()
      }
      return
    }
    // 编辑模式下没按着任何东西：跟着指针换光标，让人知道边缘可拉、中间可拖
    if (mode === 'edit') {
      setCursor(frameCursor(e.clientX, e.clientY) || 'default')
    }
  }

  function onUp(e) {
    // 低打扰（0.5.4）：右键拖动 = 移动窗口；右键/左键「没拖动就松手」= 退出低打扰。
    if (lowMode) {
      const moved = !!(drag && drag.moved > 3)
      if (drag) { drag = null; api.setDragging(false) }
      release(e)
      if (e.button === 2) {
        rightDown = false
        if (!moved) api.lowExit()
        return
      }
      if (e.button === 0) {
        const dx = Math.abs(e.screenX - (left ? left.sx : e.screenX))
        const dy = Math.abs(e.screenY - (left ? left.sy : e.screenY))
        left = null
        if (!moved && dx < 5 && dy < 5) api.lowExit()
        return
      }
      return
    }

    // 编辑模式
    if (mode === 'edit') {
      // 这一轮到底动过没有：拖动看 moved，缩放看 markDirty 打的 editDirty。
      // 必须在清空 drag/resize 之前取，否则「拖完松手」会被当成「只是长按进来又松开」。
      const didWork = editDirty || (drag != null && drag.moved > 3)
      resize = null
      drag = null
      api.setDragging(false)
      release(e)
      setCursor(frameCursor(e.clientX, e.clientY) || 'default')
      // 用户报的 bug：长按进入时是「按住直接接着拖」，那次松手被 editEntryRelease
      // 当成「只是进入编辑」，于是 1s 倒计时根本没启动 —— 虚线框要等下一次交互才消失。
      // 现在只有「真的没动过」才保留常驻；拖过/缩放过就照常启动倒计时。
      if (editEntryRelease) {
        editEntryRelease = false
        if (!didWork) return
      }
      armHide()
      return
    }

    // 右键：区分短按开菜单 / 长按交给位置与尺寸
    if (e.button === 2) {
      rightDown = false
      if (pressTimer) {
        clearTimeout(pressTimer)
        pressTimer = 0
        if (mode === 'pressing') {
          // 0.5s 内抬起 → 菜单。编辑模式里按下的，模式要还原成 edit
          mode = pressInEdit ? 'edit' : 'idle'
          if (mode === 'edit') armHide()   // 弹菜单也算动了一下 → 启动退出倒计时
          pressInEdit = false
          release(e)
          try { (onMenu || api.openMenu)() } catch (err) { log('[ir] 开菜单失败: ' + (err && err.message)) }
          return
        }
      }
      if (mode === 'sweeping') {
        // 扫过动画还在跑 → 松手不打断，让它走完再进编辑模式
        release(e)
        return
      }
      release(e)
      return
    }

    // 左键：只当「点击」。位移超过 6px 视为手滑，不触发交互。
    if (left) {
      const dx = Math.abs(e.screenX - left.sx)
      const dy = Math.abs(e.screenY - left.sy)
      const wandered = dx > 6 || dy > 6
      const quick = performance.now() - left.t < 600
      const at = { x: left.x, y: left.y }
      left = null
      release(e)
      if (!wandered && quick) handleClick(at.x, at.y)
    }
  }

  // 双击判别：同区域 350ms 内第二次点击。头部的单击要延迟派发，
  // 给双击留出判别窗口 —— 否则摸头先播一遍、钢盆紧跟着又来一遍。
  let tapLast = { t: 0, region: '', timer: 0 }
  const clearTap = () => {
    if (tapLast.timer) { clearTimeout(tapLast.timer); tapLast.timer = 0 }
  }

  function handleClick(cx, cy) {
    const r = hitRegion(cx, cy)
    const region = r ? r.name : ''
    log('[tap] 命中区域', r ? r.name + ' → ' + r.action : '无（默认招呼）')
    if (r && r.action === 'skirt') {
      clearTap()
      onSkirt()
      return
    }
    const now = performance.now()
    if (region === '头' && tapLast.region === '头' && now - tapLast.t < 350) {
      clearTap()
      tapLast = { t: 0, region: '', timer: 0 }
      if (onDouble) { onDouble('头'); return }
      // 没配 onDouble 就当两次单击，走延迟派发
    }
    clearTap()
    tapLast = { t: now, region, timer: 0 }
    if (region === '头') {
      tapLast.timer = setTimeout(() => {
        tapLast.timer = 0
        onGreet('头')
      }, 360)
    } else {
      onGreet(region)
    }
  }

  /* ---------------- 绑定 ---------------- */

  stageEl.addEventListener('pointerdown', onDown)
  stageEl.addEventListener('pointermove', onMove)
  stageEl.addEventListener('pointerup', onUp)
  stageEl.addEventListener('pointercancel', onUp)

  // 右键菜单必须自己接管，否则会弹系统菜单
  window.addEventListener('contextmenu', (e) => e.preventDefault())

  // 失焦兜底：手势中途窗口失焦（切程序、被遮挡）不能卡在 pressing/edit
  window.addEventListener('blur', () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0 }
    if (mode === 'pressing') mode = 'idle'
    pressInEdit = false
    if (sweepRaf) cancelSweep()
    resize = null
    drag = null
    left = null
    rightDown = false
    clearTap()
    setCursor('')
    api.setDragging(false)
  })

  return {
    get mode() { return mode },
    enterEdit,
    exitEdit,
    /** 低打扰开关（0.5.4）：渲染层收到主进程事件后调这里 */
    setLowMode(on) {
      lowMode = !!on
      if (lowMode) {
        // 进入时把可能在跑的手势全部作废，避免半截拖动带到低打扰里
        if (drag) { drag = null; api.setDragging(false) }
        resize = null
        left = null
        rightDown = false
        mode = 'idle'
        clearTimeout(pressTimer); pressTimer = 0
        clearTimeout(hideTimer); hideTimer = 0
      }
      log('[low] 交互手势' + (lowMode ? '已切换为低打扰' : '已恢复正常'))
    },
    /** 供探针脚本调用 */
    _debug: { hitRegion, toModelNorm, startSweep },
  }
}
