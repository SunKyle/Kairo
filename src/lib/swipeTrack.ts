/**
 * 滑动行的几何与判据 —— SwipeRow 的数学部分。
 *
 * 手势本身留在组件里(pointer 事件、MotionValue,组合式组件按站内规矩不写单测),
 * 但"写错就会当场出丑"的三件事都在这里,每一条都值得单独按住测:
 *
 *  1. 橡皮筋(rubber):手指越界后行还跟手,但阻尼必须收敛 —— 它决定拖过头
 *     那一截看起来是"有弹性的边界"还是"脱手的卡片";
 *  2. 提交点(commitPoint):行要揭开多少才算"用户真的想执行",以及
 *     抽屉比提交点更宽时怎么兜底(取 max,保证动作块永远先于提交露出来);
 *  3. 松手判定(releasePlan):甩动按速度投影落点,慢放按当前位置落点。
 *
 * 全部以"揭开距离 exposed"(正数=朝打开方向移动了多少 px)为口径,
 * 方向镜像(-1/1)留在组件里处理 —— 数学不关心你往哪边滑。
 */

/** 超过这个速度(px/s)算"甩"(flick),落点由速度而不是位置决定 */
export const FLICK_VELOCITY = 110
/** 起始迟滞:横向位移不足这个像素数不认为是滑动(保护点击与纵向滚动) */
export const MOVE_HYSTERESIS = 10
/** 速度投影用的衰减因子:指数衰减模型的一步,越大惯性越远 */
const DECEL = 0.998
/** 速度上限:防止偶发的超大 pointermove 间隔把投影甩到天边 */
const VELOCITY_MAX = 1500

export interface SwipeTrack {
  /** 行宽(px),运行时实测 */
  width: number
  /** 抽屉总宽 = 动作个数 × 单动作宽;单动作时就是动作块自己 */
  drawer: number
  /** 单个动作块宽度,决定提交点下限 */
  action: number
  /** 橡皮筋阻尼(0.05..1):越界距离按这个比例"打折"跟手 */
  resistance: number
  /** 提交阈值:揭开宽度过 行宽 × commitAt 即"够狠了" */
  commitAt: number
  /** 关闭则只有抽屉、没有"全滑直接执行" */
  fullSwipe: boolean
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

/** 阻尼:over 是越界距离,返回"行实际跟着走了多少"。单调递增、以 dim×resist 为上渐近 */
export const rubber = (over: number, dim: number, resist: number) =>
  (over * dim * resist) / (dim + resist * Math.abs(over))

/** rubber 的解析反函数:从"行走了 y"回推"手指到了 over" */
export const unrubber = (y: number, dim: number, resist: number) =>
  (y * dim) / (resist * Math.max(1, dim - Math.abs(y)))

/** 速度 v(px/s)→ 若无阻力还会滑多远(px) */
export const projectDistance = (v: number) => {
  const d = DECEL / (1 - DECEL) // ~499
  return ((v / 1000) * d)
}

/**
 * 原始位移 raw(带符号的"想揭开的距离")→ 行实际揭开多少。
 * 分四段(与 RubberSegment 同一族的手感配方):
 *  - raw<0:关侧橡皮筋(反向拖不动,只是弹一下);
 *  - 0..drawer:一比一跟手,抽屉滑进来;
 *  - drawer..commitPoint:按阻力打折(这段是"要不要更狠"的犹豫区);
 *  - 过了提交点再拖:橡皮筋 —— 已经够狠了,再多拖只是确认,不是拉开更远。
 * 不可提交(关闭全滑或行太窄)时,过了抽屉就一路橡皮筋。
 */
export const exposeDistance = (raw: number, t: SwipeTrack) => {
  const W = t.width
  const c = clamp(t.resistance, 0.05, 1)
  if (raw < 0) return rubber(raw, W, c)
  if (raw <= t.drawer) return raw
  if (!canCommit(t)) return t.drawer + rubber(raw - t.drawer, W, c)
  const C = commitPoint(t)
  const knee = t.drawer + (C - t.drawer) / c
  return raw <= knee ? t.drawer + c * (raw - t.drawer) : C + rubber(raw - knee, W, c)
}

/** exposeDistance 的反函数:从揭开距离回推手指位置(手势接续、状态还原用) */
export const fingerDistance = (exposed: number, t: SwipeTrack) => {
  const W = t.width
  const c = clamp(t.resistance, 0.05, 1)
  if (exposed < 0) return unrubber(exposed, W, c)
  if (exposed <= t.drawer) return exposed
  if (!canCommit(t)) return t.drawer + unrubber(exposed - t.drawer, W, c)
  const C = commitPoint(t)
  const knee = t.drawer + (C - t.drawer) / c
  return exposed <= C ? t.drawer + (exposed - t.drawer) / c : knee + unrubber(exposed - C, W, c)
}

/** 提交点:行宽 × 阈值,但不小于"抽屉 + 半个动作" —— 动作块得先露全了才谈得上全滑提交 */
export const commitPoint = (t: SwipeTrack) =>
  Math.max(t.commitAt * t.width, t.drawer + t.action / 2)

/** 这一行到底能不能"全滑直接执行" */
export const canCommit = (t: SwipeTrack) => t.fullSwipe && commitPoint(t) <= t.width

/** 当前揭开程度是否已越过提交点(动作块该跳出来填满、提示该说"松手即执行"了) */
export const isArmed = (exposed: number, t: SwipeTrack) => canCommit(t) && exposed >= commitPoint(t)

/**
 * 速度估算:取采样历史(时间升序的 [t, exposed])首尾差。
 * 少于两点给 0 —— 慢启动时不要把"刚动了一下"当成甩。
 */
export const velocityOf = (hist: [number, number][]) => {
  if (hist.length < 2) return 0
  const first = hist[0]
  const last = hist[hist.length - 1]
  const dt = Math.max(1, last[0] - first[0])
  return clamp(((last[1] - first[1]) / dt) * 1000, -VELOCITY_MAX, VELOCITY_MAX)
}

export type ReleasePlan = 'commit' | 'open' | 'close'

/**
 * 松手之后这一行去哪:
 *  - 已越过提交点 → 直接执行(commit);
 *  - 甩动看速度方向;慢放把当前揭开按速度投影一下,过抽屉中点才算想打开。
 */
export const releasePlan = (exposed: number, velocity: number, t: SwipeTrack): ReleasePlan => {
  if (isArmed(exposed, t)) return 'commit'
  if (Math.abs(velocity) >= FLICK_VELOCITY) return velocity > 0 ? 'open' : 'close'
  return exposed + projectDistance(velocity) > t.drawer / 2 ? 'open' : 'close'
}
