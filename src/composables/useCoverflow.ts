import { onBeforeUnmount, type Ref } from 'vue'

/* ===== 弧形封面流（Coverflow）==========================================
 *  参照 React Bits <CircularCarousel> 的「展示方式 + 动效」，取它最值钱的几件：
 *  居中的卡是焦点（平视、清晰、可点），两侧后退、轻微内倾、按景深渐隐；
 *  可拖拽甩动带惯性并自动吸附到整张；载入时 rise 逐张升起。
 *
 *  刻意**不收成整圈 cylinder 环**：角色页常有 15+ 张，摊成一圈会糊成一面墙，
 *  弧形靠「滚动穿越」逐张看反而读得清。卡片本体不动 —— 这一块只管
 *  把已经渲染好的 .cf-slot 逐个摆到弧上，谁被点到就把焦点移到它。
 *
 *  本地优先的约束顺带满足：动画只在用户交互的那一小段才跑（无 autoplay，
 *  静止即停 rAF），开了系统「减弱动态效果」则跳过入场、切换即刻到位。 */

interface Press {
  x: number
  focus: number
  moved: boolean
  samples: { t: number; f: number }[]
}

export interface CoverflowDeps {
  /** 承载 .cf-slot 子元素的那层 DOM */
  root: Ref<HTMLElement | null>
  /** 焦点序号变了就回调（给标题行 / 页码用） */
  onChange?: (index: number) => void
}

// 弹簧：临界阻尼（damping = 2√k），落到整数即停
const SPRING = 120
const DAMP = 2 * Math.sqrt(SPRING)
const SETTLE = 0.001
// 弧线形状
// 间距系数 ≥1 是关键:小于 1 相邻卡会交叠,而层级按「离焦点越远越靠后」压下去,
// 交叠那一条正好盖在侧卡的名字 / Chat / 特征 / 用量上(下半截),看着就是被挡住。
// 所以让卡基本并排(1.05 留一点空气,倾斜时边缘也不会蹭到),弧线靠倾角 + 景深 + 渐隐读出来。
const TILT_MAX = 30 // 侧卡最大内倾角(压到 30:斜得太狠时底部外角会甩进邻卡)
const SLOT_RATIO = 1.05 // 水平间距 = 卡宽 × 这个系数(>1 让相邻卡并排不压身)
const DEPTH_STEP = 42 // 每远一格往景深后退的像素(收着点,别让中央卡压得两侧太扁)
const SHRINK = 0.05 // 每远一格缩小的比例
// 侧卡一律不透明(0 衰减)：卡片底部那层暗幕用了 backdrop-filter，
// 一旦给整张卡压 opacity<1，模糊就取不到身后照片、糊成一块白霜盖住下半张脸。
// 景深感改由 scale + translateZ 透视 + 容器两端羽化承担，不靠透明度。
const FADE = 0 // 每远一格透明度衰减
const WINDOW = 5.4 // 超过这么远就收起（visibility:hidden），别离屏堆一堆
// 自动滚动：一张停一会儿再飘到下一张（乒乓来回走，不瞬移回开头，看着像慢扫）
const AUTO_MS = 3200 // 每张停留时长（到点飘一格）；指针停在弧上会按暂停
const AUTO_RETRY = 500 // 被暂停（悬停/拖拽/切走）时，隔这么久再探一次能不能走

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5)

export function useCoverflow({ root, onChange }: CoverflowDeps) {
  const reduced =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  let slots: HTMLElement[] = []
  let count = 0
  let focus = 0
  let target = 0
  let vel = 0
  let dragging = false
  let press: Press | null = null
  let suppressClick = false
  let raf = 0
  let last = 0
  let lastIdx = -1
  let cardW = 260
  let cardH = (260 * 4) / 3
  let slot = 260 * SLOT_RATIO
  let drop = cardH * 1.1
  let introStart = 0
  let introDone = reduced
  let ro: ResizeObserver | null = null
  // 自动滚动这一摊：running=弧形正开着（activate/deactivate 拨），paused=指针停在弧上，
  // autoDir=乒乓方向（+1 往右扫，到末张翻 -1 往回）。autoTimer 只挂一个待走的 setTimeout。
  let running = false
  let paused = false
  let autoDir = 1
  let autoTimer = 0

  /* 卡宽同时受容器宽与高夹住：宽向按 ~3 张铺开（clamp 到 150–320），
     高向保证整张卡（含底部那行字）落进这一屏、不被上下切掉 —— 卡是 3:4，
     所以高向允许的宽 = 可用高 × (3/4)。取两者较小值。量到 0 就跳过。 */
  function measure() {
    const el = root.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const byWidth = rect.width * 0.33
    // 0.86：留出景深/倾斜的余量，别让最外侧的卡顶到容器上下边被裁
    const byHeight = rect.height * 0.86 * (3 / 4)
    cardW = clamp(Math.min(byWidth, byHeight), 150, 320)
    cardH = (cardW * 4) / 3
    slot = cardW * SLOT_RATIO
    drop = cardH * 1.1
    slots = Array.from(el.querySelectorAll<HTMLElement>('.cf-slot'))
    count = slots.length
    for (const s of slots) {
      s.style.width = `${cardW}px`
      s.style.height = `${cardH}px`
      s.style.marginLeft = `${-cardW / 2}px`
      s.style.marginTop = `${-cardH / 2}px`
    }
    // 角色增减后焦点别越界
    focus = clamp(focus, 0, Math.max(0, count - 1))
    target = clamp(target, 0, Math.max(0, count - 1))
  }

  function render(now: number) {
    if (!count) return
    // rise 入场：整层一起升（远处卡错峰更晚，靠 y 里那点 ad 权重）
    let lift = 0
    let introP = 1
    if (!introDone) {
      const p = easeOutQuint(clamp((now - introStart) / 900, 0, 1))
      introP = p
      lift = (1 - p) * drop
      if (p >= 1) introDone = true
    }
    const focusIdx = clamp(Math.round(focus), 0, count - 1)
    for (let i = 0; i < count; i++) {
      const s = slots[i]
      const d = i - focus
      const ad = Math.abs(d)
      const t = clamp(d, -1.4, 1.4)
      const tilt = -(t / 1.4) * TILT_MAX
      const x = d * slot
      const z = -Math.min(ad, 6) * DEPTH_STEP
      const sc = clamp(1 - Math.min(ad, 6) * SHRINK, 0.6, 1)
      const op = clamp(1 - ad * FADE, 0.06, 1) * introP
      const y = lift * (0.3 + Math.min(ad, 4) * 0.18)
      s.style.transform = `translate3d(${x}px, ${y}px, ${z}px) rotateY(${tilt}deg) scale(${sc})`
      s.style.opacity = String(op)
      s.style.zIndex = String(100 - Math.round(ad * 10))
      s.style.visibility = ad > WINDOW ? 'hidden' : 'visible'
      s.classList.toggle('is-focus', i === focusIdx)
    }
    if (focusIdx !== lastIdx) {
      lastIdx = focusIdx
      onChange?.(focusIdx)
    }
  }

  function frame(now: number) {
    raf = 0
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60
    last = now
    let busy = !introDone
    if (dragging) {
      busy = true
    } else if (Math.abs(target - focus) > SETTLE || Math.abs(vel) > 0.02) {
      vel += (SPRING * (target - focus) - DAMP * vel) * dt
      focus += vel * dt
      busy = true
      if (Math.abs(target - focus) < SETTLE && Math.abs(vel) < 0.02) {
        focus = target
        vel = 0
      }
    } else if (focus !== target) {
      focus = target
      vel = 0
    }
    render(now)
    if (busy && !document.hidden) raf = requestAnimationFrame(frame)
    else last = 0
  }

  function wake() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame)
  }

  function goTo(i: number) {
    if (!count) return
    target = clamp(i, 0, count - 1)
    // 人手动跳（点侧卡 / 点圆点 / 键盘）之后，重新计时，别刚跳完又被自动推着走
    restartAuto()
    if (reduced) {
      focus = target
      vel = 0
      render(performance.now())
    } else {
      wake()
    }
  }

  /* —— 自动滚动 ——
   *  乒乓：往一个方向逐张飘，到端点翻方向；全程用现成的弹簧，落定一张再走下一张，
   *  绝不瞬移回开头。三条闸门都关掉它：减弱动态效果（reduced，JS 动画得自判，
   *  全局那条只压 CSS）、切到后台标签（rAF 冻着、setTimeout 又被限流）、指针停在弧上或正在拖。 */
  function autoStep() {
    const cur = Math.round(target)
    let next = cur + autoDir
    if (next > count - 1) {
      autoDir = -1
      next = count - 2
    } else if (next < 0) {
      autoDir = 1
      next = 1
    }
    if (next < 0 || next > count - 1) next = cur
    // 直接挪 target（不走 goTo，免得把刚排好的自动计时又重置一次）
    target = clamp(next, 0, count - 1)
    wake()
  }
  function autoTick() {
    autoTimer = 0
    if (!running || reduced || count < 2) return
    if (document.hidden) return // 切走了：停摆，等可见性事件回来再启
    if (paused || dragging || press) {
      autoTimer = window.setTimeout(autoTick, AUTO_RETRY) // 正被占着：过会儿再探
      return
    }
    autoStep()
    autoTimer = window.setTimeout(autoTick, AUTO_MS)
  }
  function startAuto() {
    if (reduced || !running || count < 2 || autoTimer) return
    autoTimer = window.setTimeout(autoTick, AUTO_MS)
  }
  function stopAuto() {
    if (autoTimer) {
      window.clearTimeout(autoTimer)
      autoTimer = 0
    }
  }
  function restartAuto() {
    if (!running || reduced) return
    stopAuto()
    startAuto()
  }

  /* —— 指针拖拽（含甩动惯性）—— */
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return
    press = { x: e.clientX, focus, moved: false, samples: [{ t: performance.now(), f: focus }] }
    suppressClick = false
  }
  function onPointerMove(e: PointerEvent) {
    if (!press) return
    const dx = e.clientX - press.x
    if (!press.moved) {
      if (Math.abs(dx) < 5) return
      press.moved = true
      dragging = true
      suppressClick = true
      root.value?.setAttribute('data-dragging', '')
      try {
        root.value?.setPointerCapture(e.pointerId)
      } catch {
        /* 极端情况拿不到捕获，不拦拖拽本身 */
      }
    }
    // 手指向右 → 整排向右移 → 左侧的卡进入视野（焦点序号变小）；给半格回弹余量
    focus = clamp(press.focus - dx / slot, -0.5, count - 0.5)
    const now = performance.now()
    press.samples.push({ t: now, f: focus })
    while (press.samples.length > 2 && now - press.samples[0].t > 110) press.samples.shift()
    wake()
  }
  function onPointerUp() {
    if (!press) return
    if (press.moved) {
      dragging = false
      root.value?.removeAttribute('data-dragging')
      const s0 = press.samples[0]
      const s1 = press.samples[press.samples.length - 1]
      const span = (s1.t - s0.t) / 1000
      const v = span > 0.008 ? (s1.f - s0.f) / span : 0
      vel = reduced ? 0 : clamp(v, -8, 8)
      target = clamp(Math.round(focus + vel * 0.14), 0, count - 1)
    }
    press = null
    wake()
    restartAuto() // 甩完这一下重新计时，别手一松立刻又被自动推走
  }

  /* 点侧卡 → 把它转到中间（拖完那一下不算点，靠 suppressClick 挡掉） */
  function onClick(e: MouseEvent) {
    if (suppressClick) {
      suppressClick = false
      return
    }
    const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.cf-slot')
    if (el) goTo(Number(el.dataset.i))
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowRight') {
      goTo(Math.round(focus) + 1)
      e.preventDefault()
    } else if (e.key === 'ArrowLeft') {
      goTo(Math.round(focus) - 1)
      e.preventDefault()
    } else if (e.key === 'Home') {
      goTo(0)
      e.preventDefault()
    } else if (e.key === 'End') {
      goTo(count - 1)
      e.preventDefault()
    }
  }

  /* 触控板横滑：攒一点惯性，停手 140ms 后吸附到整张 */
  let wheelTimer = 0
  function onWheel(e: WheelEvent) {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0
    if (!dx) return
    e.preventDefault()
    target = clamp(target + dx * 0.004, 0, count - 1)
    window.clearTimeout(wheelTimer)
    wheelTimer = window.setTimeout(() => {
      target = clamp(Math.round(target), 0, count - 1)
      wake()
    }, 140)
    wake()
  }

  /* 悬停即停：指针落到弧上（要读了）就暂停自动滚动，移开再走（autoTick 会探 paused）。
     切后台标签也停：rAF 冻着、setTimeout 又被限流，硬走会乱；回到前台靠 visibilitychange 重启。 */
  function onEnter() {
    paused = true
  }
  function onLeave() {
    paused = false
  }
  function onVisibility() {
    if (document.hidden) stopAuto()
    else if (running) startAuto()
  }

  function bind() {
    const el = root.value
    if (!el) return
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)
    el.addEventListener('click', onClick)
    el.addEventListener('keydown', onKey)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerenter', onEnter)
    el.addEventListener('pointerleave', onLeave)
    document.addEventListener('visibilitychange', onVisibility)
  }
  function unbind() {
    const el = root.value
    if (!el) return
    el.removeEventListener('pointerdown', onPointerDown)
    el.removeEventListener('pointermove', onPointerMove)
    el.removeEventListener('pointerup', onPointerUp)
    el.removeEventListener('pointercancel', onPointerUp)
    el.removeEventListener('click', onClick)
    el.removeEventListener('keydown', onKey)
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('pointerenter', onEnter)
    el.removeEventListener('pointerleave', onLeave)
    document.removeEventListener('visibilitychange', onVisibility)
  }

  /* 切到弧形时调用：量尺寸、起入场、绑事件、观察容器变化。
     重复调用先清干净，免得监听器叠两层。 */
  function activate() {
    deactivate()
    running = true
    paused = false
    autoDir = 1
    bind()
    introStart = performance.now()
    introDone = reduced
    lastIdx = -1
    measure()
    render(performance.now())
    if (!ro && typeof ResizeObserver !== 'undefined' && root.value) {
      ro = new ResizeObserver(() => {
        measure()
        render(performance.now())
      })
      ro.observe(root.value)
    }
    wake()
    startAuto()
  }

  /* 角色增减后（v-for 换了卡，slot 数变了）而弧形正开着：重算尺寸并重画一次。
     容器尺寸没变时 ResizeObserver 不会自己触发，得手动刷这一下。 */
  function refresh() {
    measure()
    render(performance.now())
    wake()
    // 初次挂载时可能还没有角色、自动滚动没起来；角色来了这次刷新顺手把它补上
    // （startAuto 自己会挡：非 running / reduced / 不足 2 张 / 已排 timer 都不重复起）
    startAuto()
  }

  /* 切回网格：把弧形写进每张 slot 的行内样式（尺寸 / transform / 透明 / 层级 /
     可见性）与 .is-focus 一律抹干净 —— 网格与弧形复用同一批 DOM 节点，
     不清就会带着上一摆法的位移残影。 */
  function clear() {
    for (const s of slots) {
      s.style.cssText = ''
      s.classList.remove('is-focus')
    }
  }

  /* 切回网格 / 离开这一页 / 卸载时调用：停 rAF、停自动、解绑、断观察。 */
  function deactivate() {
    running = false
    paused = false
    stopAuto()
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    dragging = false
    press = null
    root.value?.removeAttribute('data-dragging')
    window.clearTimeout(wheelTimer)
    unbind()
    ro?.disconnect()
    ro = null
    clear()
  }

  onBeforeUnmount(() => {
    deactivate()
  })

  /* 页面级开关：新建 / 编辑向导这类盖在上层的模态打开时暂停自动滚动，
     免得焦点在蒙层底下悄悄漂走；关掉再续。减弱动效下本就是关的,不干涉。 */
  function pauseAuto() {
    stopAuto()
  }
  function resumeAuto() {
    if (running && !document.hidden) startAuto()
  }

  return { activate, deactivate, goTo, measure, refresh, pauseAuto, resumeAuto }
}
