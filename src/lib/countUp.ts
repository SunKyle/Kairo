import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/* ===== 数字滚动(进场 CountUp)========================================
   历史页/记忆页头部那两个总量数字("多少条记录 · 多少张图"),从前是啪一下
   直接出现。让它从 0 数到真值,才有一点"落定"的重量感 —— 借的是 React Bits
   那类 CountUp 的手感,不碰配色与版式。
   分层:曲线与逐帧取值是纯函数(可单测);要窗口的动画编排在组合式里。
   -------------------------------------------------------------------- */

/** easeOutCubic:起步快、收尾缓。数字滚动的"落定感"正是这条曲线给的 */
export function easeOutCubic(t: number): number {
  const p = Math.min(1, Math.max(0, t))
  return 1 - Math.pow(1 - p, 3)
}

/**
 * 给定目标值与归一化进度(0→1),算出这一帧该显示的数字(整数)。
 * 越界的进度由 easeOutCubic 夹回 [0,1],所以 0 之前不会出负数、1 之后不越过目标。
 */
export function countValueAt(target: number, progress: number): number {
  return Math.round(target * easeOutCubic(progress))
}

export interface CountUpOptions {
  /** 滚动时长(ms),默认 900 */
  duration?: number
}

/**
 * 页面进场时让一个统计数字从 0 数到 `source()` 的当前值。
 *
 * 刻意**只在进场时数一次**:这些数字会随搜索/增删实时变化,若每次变化都重播,
 * 一筛选项那一排数字全在跳,反倒吵。所以初次挂载动画跑完后转入"直接跟真值",
 * 不再动画。
 *
 * 尊重"减弱动效":系统开了 prefers-reduced-motion 时直接落终值,不滚动。
 * (CSS 那侧的 spring 由 style.css 里那条全局 reduced-motion 兜底;这里是 JS rAF,
 *  不吃那条,得自己判。)
 *
 * @param source 返回目标数字的取值函数(通常传某个 computed 的 getter)
 */
export function useCountUp(
  source: () => number,
  opts: CountUpOptions = {}
): { display: Ref<number> } {
  const duration = opts.duration ?? 900
  const display = ref(0)
  // 初次进场动画是否已结束。结束前不响应源值变化(否则动画会被中途改写),
  // 结束后源值一变就直接跟,不再起新动画。
  let settled = false
  let raf = 0

  const reduced = (): boolean =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  function animateTo(target: number): void {
    if (reduced() || target <= 0) {
      display.value = target
      settled = true
      return
    }
    const t0 =
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    const step = (now: number): void => {
      const elapsed = now - t0
      const p = elapsed / duration
      if (p >= 1) {
        display.value = target
        settled = true
        return
      }
      display.value = countValueAt(target, p)
      raf = requestAnimationFrame(step)
    }
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(step)
  }

  onMounted(() => animateTo(source()))

  watch(source, (v) => {
    if (settled) display.value = v
  })

  onBeforeUnmount(() => cancelAnimationFrame(raf))

  return { display }
}
