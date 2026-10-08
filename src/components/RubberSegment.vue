<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { animate, motionValue } from 'motion'
import type { MotionValue } from 'motion'

export interface SegmentItem {
  value: string
  label: string
}

const props = withDefaults(
  defineProps<{
    items: SegmentItem[]
    /** 受控值。不传则用 defaultValue 自管(与原组件一致) */
    modelValue?: string
    defaultValue?: string
    size?: 'sm' | 'md' | 'lg'
    radius?: number
    inset?: number
    /** 轨道高度,覆盖 size 预设。用于「轨道加高、滑块高度不变」的场合:
        只调 inset 会连带把滑块压小,要拉开白底与滑块的高度差就得两个一起给 */
    height?: number
    equalSlots?: boolean
    stretch?: number
    squash?: number
    speed?: number
    glide?: number
    draggable?: boolean
    disabled?: boolean
    ariaLabel?: string
  }>(),
  {
    size: 'md',
    radius: 10,
    inset: 3,
    equalSlots: true,
    stretch: 100,
    squash: 3,
    speed: 1,
    glide: 75,
    draggable: true,
    disabled: false,
    ariaLabel: 'Segmented control'
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'change', value: string, index: number): void
}>()

const EASE_OUT = [0.23, 1, 0.32, 1] as const
const SPRING_UI = { type: 'spring', duration: 0.3, bounce: 0 } as const
const SPRING_MOMENTUM = { type: 'spring', duration: 0.4, bounce: 0.2 } as const
const SPRING_RELAX = { type: 'spring', duration: 0.16, bounce: 0 } as const
const DILATE = 0.19
const HANDOFF = 0.15
const FLICK = 110
const DEADZONE = 4
const SLOP = 10
const RUBBER = 0.55
const SIZES = {
  sm: { height: 28, font: 12, pad: 10, min: 36 },
  md: { height: 36, font: 13, pad: 14, min: 44 },
  lg: { height: 44, font: 14, pad: 18, min: 48 }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const rubber = (over: number, dim: number) => (over * dim * RUBBER) / (dim + RUBBER * Math.abs(over))
const project = (v: number, glide: number) => {
  const d = 1 - 0.1 * Math.pow(0.05, glide / 100)
  return ((v / 1000) * d) / (1 - d)
}
const velocityOf = (hist: [number, number][], now: number) => {
  const recent = hist.filter(([t]) => now - t <= 100)
  if (recent.length < 2) return 0
  const [t0, x0] = recent[0]
  const [t1, x1] = recent[recent.length - 1]
  return t1 - t0 >= 8 ? ((x1 - x0) / (t1 - t0)) * 1000 : 0
}

const list = computed(() => props.items)
const inner = ref(props.defaultValue ?? props.items[0]?.value ?? '')
const current = computed(() => (props.modelValue !== undefined ? props.modelValue : inner.value))
const index = computed(() => Math.max(0, list.value.findIndex((i) => i.value === current.value)))

const reduce = ref(false)
const pressed = ref(-1)
const held = ref(false)

const trackRef = ref<HTMLElement | null>(null)
const itemEls: (HTMLElement | null)[] = []
const setItemRef = (el: unknown, i: number) => {
  itemEls[i] = (el as HTMLElement | null) ?? null
}
const slots = ref<{ l: number; r: number }[]>([])
let box: { left: number } | null = null
const committed = ref(0)
let handoff: ReturnType<typeof setTimeout> | undefined
let gen = 0

const edgeL = motionValue(0)
const edgeR = motionValue(0)
const innerW = motionValue(0)
const thumbRadius = computed(() => Math.max(0, props.radius - props.inset))

// 对应原组件的 useTransform:三个 MotionValue 任一变化就重算裁剪路径。
// 这里必须直接写 DOM —— 若改成给 ref 赋值,每帧都会触发一次整组件重渲染,
// 而 MotionValue 的设计初衷恰恰是绕开框架的渲染周期
const thumbEl = ref<HTMLElement | null>(null)
function syncClip() {
  const el = thumbEl.value
  if (!el) return
  el.style.clipPath = `inset(0 ${Math.max(0, innerW.get() - edgeR.get())}px 0 ${Math.max(
    0,
    edgeL.get()
  )}px round ${thumbRadius.value}px)`
}

const t = (seconds: number) => seconds / props.speed

function jumpTo(i: number) {
  const s = slots.value[i]
  if (!s) return
  clearTimeout(handoff)
  gen += 1
  edgeL.jump(s.l)
  edgeR.jump(s.r)
}

function measure() {
  const track = trackRef.value
  if (!track) return
  const rect = track.getBoundingClientRect()
  box = { left: rect.left }
  slots.value = list.value.map((_, i) => {
    const el = itemEls[i]
    if (!el) return { l: 0, r: 0 }
    const r = el.getBoundingClientRect()
    return { l: r.left - rect.left - props.inset, r: r.right - rect.left - props.inset }
  })
  innerW.set(rect.width - props.inset * 2)
  jumpTo(committed.value)
  // 首个槽位的 l 为 0,上面的 jump 不会派发 change,这里补一次保证初值正确
  syncClip()
}

function commit(i: number) {
  committed.value = i
  if (i === index.value) return
  if (props.modelValue === undefined) inner.value = list.value[i].value
  emit('update:modelValue', list.value[i].value)
  emit('change', list.value[i].value, i)
}

type DragState = {
  id: number
  x0: number
  slot: number
  onThumb: boolean
  live: boolean
  offset: number
  w: number
  hist: [number, number][]
}
let drag: DragState | null = null

function land(to: number, v: number | null, flick: boolean, withSquash: boolean) {
  const b = slots.value[to]
  if (!b) return
  const g = ++gen
  const dir = Math.sign((b.l + b.r) / 2 - (edgeL.get() + edgeR.get()) / 2) || 1
  const [lead, leadTo, trail, trailTo]: [MotionValue<number>, number, MotionValue<number>, number] =
    dir > 0 ? [edgeR, b.r, edgeL, b.l] : [edgeL, b.l, edgeR, b.r]
  const velocityFor = (mv: MotionValue<number>) => (v === null ? mv.getVelocity() : v)
  animate(lead, leadTo, {
    ...(flick ? SPRING_MOMENTUM : SPRING_UI),
    duration: t(flick ? 0.4 : 0.3),
    velocity: velocityFor(lead)
  })
  const trailVelocity = velocityFor(trail)
  if (!withSquash || props.squash <= 0) {
    animate(trail, trailTo, { ...SPRING_UI, duration: t(0.3), velocity: trailVelocity })
    return
  }
  animate(trail, trailTo + dir * props.squash, {
    ...SPRING_UI,
    duration: t(0.3),
    velocity: trailVelocity
  }).then(() => {
    if (gen === g) animate(trail, trailTo, { ...SPRING_RELAX, duration: t(0.16) })
  })
}

function travel(from: number, to: number) {
  const a = slots.value[from]
  const b = slots.value[to]
  if (!a || !b) return
  clearTimeout(handoff)
  gen += 1
  if (reduce.value) {
    edgeL.jump(b.l)
    edgeR.jump(b.r)
    return
  }
  const u = props.stretch / 100
  const tween = { duration: t(DILATE), ease: EASE_OUT }
  animate(edgeL, b.l + (Math.min(a.l, b.l) - b.l) * u, tween)
  animate(edgeR, b.r + (Math.max(a.r, b.r) - b.r) * u, tween)
  handoff = setTimeout(() => land(to, null, false, true), t(HANDOFF) * 1000)
}

const localX = (e: PointerEvent) => e.clientX - (box ? box.left : 0) - props.inset

function onItemDown(e: PointerEvent, i: number) {
  if (props.disabled || drag || e.button !== 0) return
  const track = trackRef.value
  if (!track) return
  box = track.getBoundingClientRect()
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 某些环境不支持捕获,忽略即可 */
  }
  const x = localX(e)
  const onThumb = props.draggable && x >= edgeL.get() && x <= edgeR.get()
  drag = { id: e.pointerId, x0: x, slot: i, onThumb, live: false, offset: 0, w: 0, hist: [[e.timeStamp, x]] }
  if (onThumb) {
    clearTimeout(handoff)
    gen += 1
    edgeL.stop()
    edgeR.stop()
  } else if (!reduce.value) {
    pressed.value = i
  }
}

function onPointerMove(e: PointerEvent) {
  const d = drag
  if (!d || e.pointerId !== d.id || !d.onThumb) return
  const x = localX(e)
  d.hist.push([e.timeStamp, x])
  if (d.hist.length > 8) d.hist.shift()
  if (!d.live) {
    if (Math.abs(x - d.x0) < DEADZONE) return
    d.live = true
    d.offset = x - edgeL.get()
    d.w = edgeR.get() - edgeL.get()
    held.value = true
  }
  const width = innerW.get()
  const l = x - d.offset
  const maxL = width - d.w
  if (reduce.value) {
    const c = clamp(l, 0, maxL)
    edgeL.set(c)
    edgeR.set(c + d.w)
  } else if (l < 0) {
    edgeL.set(0)
    edgeR.set(d.w - rubber(-l, d.w))
  } else if (l > maxL) {
    edgeR.set(width)
    edgeL.set(maxL + rubber(l - maxL, d.w))
  } else {
    edgeL.set(l)
    edgeR.set(l + d.w)
  }
}

function release() {
  const d = drag
  drag = null
  held.value = false
  pressed.value = -1
  return d
}

function onPointerUp(e: PointerEvent) {
  const d = drag
  if (!d || e.pointerId !== d.id) return
  release()
  const x = localX(e)
  if (!d.live) {
    if (Math.abs(x - d.x0) <= SLOP && d.slot !== committed.value) {
      const from = committed.value
      commit(d.slot)
      travel(from, d.slot)
    }
    return
  }
  const v = velocityOf(d.hist, e.timeStamp)
  const flick = Math.abs(v) > FLICK
  let to = nearestSlot((edgeL.get() + edgeR.get()) / 2 + project(v, props.glide))
  if (flick && to === committed.value) to = clamp(to + Math.sign(v), 0, list.value.length - 1)
  commit(to)
  if (reduce.value) jumpTo(to)
  else land(to, v, flick, flick)
}

function nearestSlot(x: number) {
  let best = 0
  for (let i = 1; i < slots.value.length; i++) {
    const a = slots.value[i]
    const b = slots.value[best]
    if (Math.abs((a.l + a.r) / 2 - x) < Math.abs((b.l + b.r) / 2 - x)) best = i
  }
  return best
}

function onPointerCancel(e: PointerEvent) {
  const d = drag
  if (!d || e.pointerId !== d.id) return
  release()
  if (!d.live) return
  if (reduce.value) jumpTo(committed.value)
  else land(committed.value, null, false, false)
}

function onKeyDown(e: KeyboardEvent) {
  if (props.disabled) return
  const last = list.value.length - 1
  let next: number | null = null
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(last, index.value + 1)
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, index.value - 1)
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = last
  if (next === null) return
  e.preventDefault()
  if (next === index.value) return
  commit(next)
  jumpTo(next)
  itemEls[next]?.focus()
}

const preset = computed(() => SIZES[props.size] || SIZES.md)
const trackStyle = computed(() => ({
  '--rs-radius': `${props.radius}px`,
  '--rs-inset': `${props.inset}px`,
  '--rs-thumb-radius': `${thumbRadius.value}px`,
  '--rs-h': `${props.height ?? preset.value.height}px`,
  '--rs-font': `${preset.value.font}px`,
  '--rs-pad': `${preset.value.pad}px`,
  '--rs-min': `${preset.value.min}px`
}))

const listKey = computed(() => list.value.map((i) => i.value).join('|'))
let observer: ResizeObserver | undefined
const stops: (() => void)[] = []

onMounted(() => {
  reduce.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  committed.value = index.value
  // 三个 MotionValue 任一变化就重算裁剪路径(对应原组件的 useTransform)。
  // 必须显式订阅:set() 的值没变化时不会派发 change
  stops.push(edgeL.on('change', syncClip), edgeR.on('change', syncClip), innerW.on('change', syncClip))
  measure()
  observer = new ResizeObserver(measure)
  if (trackRef.value) observer.observe(trackRef.value)
  // 手写体等字体晚到会改变槽位宽度,加载完再量一次
  document.fonts?.ready.then(measure)
})

onBeforeUnmount(() => {
  stops.forEach((off) => off())
  observer?.disconnect()
  clearTimeout(handoff)
  edgeL.stop()
  edgeR.stop()
})

// 外部改动受控值时,滑块直接落位不做动画(对应原组件的 useEffect)
watch(index, (i) => {
  if (!drag && committed.value !== i) {
    committed.value = i
    jumpTo(i)
  }
})

watch(
  [listKey, () => props.size, () => props.inset, () => props.height, () => props.equalSlots, () => props.radius],
  () => {
    committed.value = index.value
    measure()
  }
)
</script>

<template>
  <div
    ref="trackRef"
    class="rs"
    role="radiogroup"
    :aria-label="ariaLabel"
    :aria-disabled="disabled || undefined"
    :data-equal="equalSlots ? '' : undefined"
    :data-draggable="draggable && !disabled ? '' : undefined"
    :data-held="held ? '' : undefined"
    :style="trackStyle"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @lostpointercapture="onPointerCancel"
  >
    <button
      v-for="(item, i) in list"
      :key="item.value"
      :ref="(el) => setItemRef(el, i)"
      type="button"
      role="radio"
      :aria-checked="i === index"
      :aria-label="item.label"
      :tabindex="i === index ? 0 : -1"
      :disabled="disabled"
      class="rs-item tip-below"
      :data-pressed="pressed === i ? '' : undefined"
      :data-tip="item.label"
      @pointerdown="onItemDown($event, i)"
      @keydown="onKeyDown"
    >
      <slot :name="item.value" :item="item">{{ item.label }}</slot>
    </button>

    <!-- 滑块:同一份内容再画一层,用 clip-path 裁出滑块范围内的"反色"文字。
         clip-path 由 syncClip 直接写,不走模板绑定 -->
    <div ref="thumbEl" class="rs-thumb" aria-hidden="true">
      <span v-for="item in list" :key="item.value" class="rs-item rs-copy">
        <slot :name="item.value" :item="item">{{ item.label }}</slot>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* 轨道/滑块配色取自本项目 token(原组件是写死的深色,直接用会破坏亮暗主题)。
   轨道刻意与导航里的 .icob 图标按钮取同一组值(同样的 --surface 透明度和
   --line 描边),两个元素并排时才是同一套材质。
   需要局部改色时,在父级给这个组件挂 class 覆写 --rs-* 变量即可 */
.rs {
  --rs-track: color-mix(in srgb, var(--surface) 88%, transparent);
  --rs-ring: color-mix(in srgb, var(--line) 80%, transparent);
  --rs-thumb: var(--cta);
  --rs-ink: var(--text);
  --rs-ink-active: var(--cta-text);
  --rs-idle: 0.62;
  --rs-hover: 0.85;
  --rs-ease-out: cubic-bezier(0.23, 1, 0.32, 1);

  position: relative;
  display: inline-grid;
  grid-auto-flow: column;
  grid-auto-columns: auto;
  vertical-align: middle;
  padding: var(--rs-inset);
  border-radius: var(--rs-radius);
  background: var(--rs-track);
  /* 用内阴影做描边,不吃 1px 布局高度 */
  box-shadow: inset 0 0 0 1px var(--rs-ring);
  font-family: inherit;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}
.rs[data-equal] {
  grid-auto-columns: minmax(0, 1fr);
}
.rs[aria-disabled='true'] {
  opacity: 0.5;
  pointer-events: none;
}

.rs-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: calc(var(--rs-h) - var(--rs-inset) * 2);
  min-width: var(--rs-min);
  margin: 0;
  padding: 0 var(--rs-pad);
  border: 0;
  border-radius: var(--rs-thumb-radius);
  background: none;
  color: var(--rs-ink);
  opacity: var(--rs-idle);
  font: inherit;
  font-size: var(--rs-font);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  outline: none;
  transition: opacity 160ms ease, transform 160ms var(--rs-ease-out);
}
.rs-item[aria-checked='true'] {
  cursor: default;
}
.rs[data-draggable] .rs-item[aria-checked='true'] {
  cursor: grab;
}
.rs[data-held],
.rs[data-held] .rs-item {
  cursor: grabbing;
}
.rs-item[data-pressed] {
  transform: scale(0.96);
}
@media (hover: hover) and (pointer: fine) {
  .rs-item[aria-checked='false']:hover {
    opacity: var(--rs-hover);
  }
}

.rs-thumb {
  position: absolute;
  inset: var(--rs-inset);
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: auto;
  background: var(--rs-thumb);
  color: var(--rs-ink-active);
  pointer-events: none;
}
.rs[data-equal] .rs-thumb {
  grid-auto-columns: minmax(0, 1fr);
}
.rs-copy {
  color: inherit;
  opacity: 1;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .rs-item {
    transition: opacity 160ms ease;
  }
}
</style>
