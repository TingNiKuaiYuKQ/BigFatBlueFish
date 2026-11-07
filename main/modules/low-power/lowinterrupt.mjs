/**
 * 低打扰模式的状态机（0.5.4）。
 *
 * 只负责「现在是开是关、谁开的、该恢复到什么值」；真正的效果
 * （setOpacity / 帧率 / 行为抑制 / outbox）由 main 在 apply 回调里做。
 * 这样状态迁移可以离线测，不用开窗口。
 *
 * 三条口径（计划书）：
 *   · 不跨重启保留 —— 状态只在内存里；
 *   · 重复调用幂等 —— 已经开着再 enter 不覆盖已保存的恢复值；
 *   · 自动模式的手动覆盖 —— 全屏期间用户手动退出后，本次全屏不再自动进；
 *     全屏结束后复位，下一次全屏照常。
 */

export function createLowInterrupt(o = {}) {
  const log = o.log || (() => {})
  const apply = o.apply || (() => {})
  const snapshot = o.snapshot || (() => ({}))

  let on = false
  let saved = null
  let source = ''
  let manualOverride = false     // 本次全屏期间用户手动退出过
  let fullscreenSince = 0        // 连续全屏的起点（去抖）
  let lastAutoAt = 0

  const MIN_FULLSCREEN_MS = 3000  // 连续全屏 3s 才自动进入，避免切换瞬间误触

  function enter(src = 'menu') {
    if (on) return false
    on = true
    source = src
    saved = snapshot() || {}
    apply(true, saved, src)
    log('[low] 进入（来源 ' + src + '），已保存恢复值', JSON.stringify(saved))
    return true
  }

  function exit(src = 'click') {
    if (!on) return false
    on = false
    const prev = saved
    saved = null
    source = ''
    apply(false, prev || {}, src)
    log('[low] 退出（来源 ' + src + '）')
    // 用户手动退出：如果是自动模式拉起的，记下「这次全屏别再自动进」
    if (src === 'click' || src === 'menu' || src === 'tray') {
      if (lastAutoAt && Date.now() - lastAutoAt < 24 * 3600 * 1000 && fullscreenSince) manualOverride = true
    }
    return true
  }

  function toggle(src = 'menu') {
    return on ? exit(src) : enter(src)
  }

  /**
   * 自动模式的一拍。由 main 每 2s 用观察器结果调用。
   * @param {boolean} fullscreen 当前是否「真的全屏」（visible && cover && !IsZoomed）
   * @param {boolean} enabled 设置里的 autoLowInterrupt
   */
  function tick(fullscreen, enabled) {
    if (!enabled) {
      fullscreenSince = 0
      manualOverride = false
      return
    }
    if (!fullscreen) {
      // 全屏结束：清掉去抖与手动覆盖，下次全屏重新判断
      fullscreenSince = 0
      manualOverride = false
      if (on && source === 'auto') exit('auto-end')
      return
    }
    if (!fullscreenSince) fullscreenSince = Date.now()
    if (manualOverride || on) return
    if (Date.now() - fullscreenSince < MIN_FULLSCREEN_MS) return
    if (Date.now() - lastAutoAt < MIN_FULLSCREEN_MS) return
    lastAutoAt = Date.now()
    enter('auto')
  }

  return {
    enter, exit, toggle, tick,
    isOn: () => on,
    get source() { return source },
    get saved() { return saved },
    get override() { return manualOverride },
    /** 测试用：伪造一次全屏起点 */
    _forceFullscreenSince: (t) => { fullscreenSince = t },
  }
}
