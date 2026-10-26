<script setup lang="ts">
/* ===== 穹顶画廊 · 历史页的第二种看法 ==================================
   一个可以拖着转的 3D 展陈:图块贴在一个球壳内壁上,拖拽让球体在水平/垂直
   两个方向转动(垂直夹紧,免得仰角翻了面),松手带惯性慢慢停下来。点一张
   把 id 抛给父层 —— 预览/标记/下载都还在 HistoryPage 那边,这里只负责"看"。

   为什么要单独抽一个组件:
   - 这一整块是纯几何 + 纯事件,没有业务、没有 API、没有 store 依赖。
     数据只从 `images` 进,事件只从 `open` 出。
   - 它的样式(暖炭底 + 深色图砖)与全站浅色系故意不搭 —— 穹顶天生就要
     "浮在一个暗空间里",这是它作为展陈的一部分。样式全部走 scoped 变量,
     不污染 Kairo 的 token。
   - 拖动/惯性是 rAF + pointer 事件,不套任何第三方库。
     `prefers-reduced-motion` 下**惯性直接关掉**、拖拽与滚轮仍然工作(样式表
     那条全局 `transition-duration:.001ms` 只管 CSS,不管 JS,见记忆)。
   -------------------------------------------------------------------- */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/** 一张图:父层负责取地址(blob/dataURL 都行),这里只按 id 认回来 */
type DomeImage = { id: string; src: string; alt?: string }

const props = withDefaults(
  defineProps<{
    /** 要展陈的图。列表会循环铺满所有格子(少于格数会重复,多于格数只取前 N)。 */
    images: DomeImage[]
    /** 行列分段数。偶数列取 evenYs(5 行),奇数列取 oddYs(5 行,偏移半格错开)。
     *  26 → 130 格。数字越大越密,越小穹顶越"空气感"。 */
    seg?: number
    /** 半径相对容器短边的系数。0.5 是样张里调出来的稳值。 */
    fit?: number
    /** 垂直方向的最大仰角(度)。夹紧是为了不让人拖到底面/顶面。 */
    maxVerticalDeg?: number
    /** 拖影敏感度。数字越大越"钝"(要拖更多像素才转同样角度)。 */
    dragSensitivity?: number
  }>(),
  { seg: 26, fit: 0.55, maxVerticalDeg: 6, dragSensitivity: 22 }
)

const emit = defineEmits<{
  /** 点了一张图。父层用 id 找回对应的 Tile 再走自己的 open 逻辑。 */
  (e: 'open', id: string): void
}>()

const rootEl = ref<HTMLElement | null>(null)
const mainEl = ref<HTMLElement | null>(null)
const sphereEl = ref<HTMLElement | null>(null)

/* —— 网格布局 ——
   x 从 -(seg-1) 起步长 2 覆盖 [-seg+1, seg-1];y 只有 5 档、错开半格。
   seg × 5 就是总格数。 */
const evenYs = [-4, -2, 0, 2, 4]
const oddYs = [-3, -1, 1, 3, 5]

type Tile = { x: number; y: number; src: string; alt: string; id: string; key: string }

const tiles = computed<Tile[]>(() => {
  const seg = Math.max(6, Math.min(60, Math.floor(props.seg)))
  const cols = Array.from({ length: seg }, (_, i) => -(seg - 1) + i * 2)
  const coords = cols.flatMap((x, c) => {
    const ys = c % 2 === 0 ? evenYs : oddYs
    return ys.map((y) => ({ x, y }))
  })
  const pool = props.images
  if (!pool.length) return []
  /* 循环铺满,并尽量让相邻两张不同 —— 图少于格数时"重复"是必然的,
     但连着两张一模一样会破坏展陈的呼吸感,遇到就往后找一张不同 src 的换过来。 */
  const used: typeof pool = []
  for (let i = 0; i < coords.length; i++) {
    let pick = pool[i % pool.length]
    if (used.length && pick.src === used[used.length - 1].src) {
      for (let j = 1; j < pool.length; j++) {
        const cand = pool[(i + j) % pool.length]
        if (cand.src !== pick.src) {
          pick = cand
          break
        }
      }
    }
    used.push(pick)
  }
  return coords.map((c, i) => ({
    x: c.x,
    y: c.y,
    src: used[i].src,
    alt: used[i].alt ?? '',
    /* 同 src 会占多格(池子小于格数时),i 保证 :key 稳定且不重复。
       emit 出去仍是原 id,父层拿到"用户真点的这一格"对应的那张图。 */
    id: used[i].id,
    key: `${used[i].id}-${i}`
  }))
})

/* —— 半径自适应 ——
   basis = 宽>1.3×高取宽,否则取短边;radius = clamp(basis×fit, 320, 1400),
   再压一层 h×1.35 的"高度闸"防竖屏把穹顶顶出画面。 */
function applyRadius(w: number, h: number) {
  const basis = w / h >= 1.3 ? w : Math.min(w, h)
  let radius = Math.min(Math.max(basis * props.fit, 320), 1400)
  radius = Math.min(radius, h * 1.35)
  const root = rootEl.value
  if (!root) return
  root.style.setProperty('--radius', `${Math.round(radius)}px`)
  applyTransform(rot.x, rot.y)
}

/* —— 旋转状态 —— */
const rot = { x: 0, y: 0 }
function applyTransform(xDeg: number, yDeg: number) {
  const el = sphereEl.value
  if (!el) return
  el.style.transform = `translateZ(calc(var(--radius) * -1)) rotateX(${xDeg}deg) rotateY(${yDeg}deg)`
}
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)
const wrapSigned = (deg: number) => {
  const a = (((deg + 180) % 360) + 360) % 360
  return a - 180
}

/* —— 拖拽 + 惯性 ——
   只跟"是否真在拖"两态,不额外做 hit-test;点图与拖动靠 16px 位移阈值区分
   (样张那条:dx²+dy²>16 才算 moved),松手后 80ms 内的 click 也算拖尾吞掉。 */
let dragging = false
let moved = false
let startX = 0
let startY = 0
let startRotX = 0
let startRotY = 0
let lastDragEndAt = 0
let inertiaId: number | null = null
let prevX = 0
let prevT = 0
let velX = 0 // px/ms

const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

function stopInertia() {
  if (inertiaId !== null) {
    cancelAnimationFrame(inertiaId)
    inertiaId = null
  }
}
function startInertia(vx: number) {
  /* 关掉系统动画 → 不播惯性。拖到的位置就是最终位置。 */
  if (reducedMotion()) return
  const MAX_V = 1.4
  let v = clamp(vx, -MAX_V, MAX_V) * 80
  let frames = 0
  const friction = 0.94 + 0.055 * 0.6
  const stopThreshold = 0.005
  const maxFrames = 180
  stopInertia()
  const step = () => {
    v *= friction
    if (Math.abs(v) < stopThreshold || ++frames > maxFrames) {
      inertiaId = null
      return
    }
    rot.y = wrapSigned(rot.y + v / 200)
    applyTransform(rot.x, rot.y)
    inertiaId = requestAnimationFrame(step)
  }
  inertiaId = requestAnimationFrame(step)
}

function onPointerDown(e: PointerEvent) {
  const main = mainEl.value
  if (!main || e.button !== 0 && e.pointerType === 'mouse') return
  dragging = true
  moved = false
  startX = e.clientX
  startY = e.clientY
  startRotX = rot.x
  startRotY = rot.y
  prevX = e.clientX
  prevT = performance.now()
  velX = 0
  stopInertia()
  try {
    main.setPointerCapture(e.pointerId)
  } catch {
    /* 极少见:某些环境 capture 会抛(比如 id 已失效)。吞掉,不阻断拖 */
  }
  main.classList.add('is-grabbing')
}
function onPointerMove(e: PointerEvent) {
  if (!dragging) return
  const dx = e.clientX - startX
  const dy = e.clientY - startY
  if (!moved && dx * dx + dy * dy > 16) moved = true
  rot.x = clamp(startRotX - dy / props.dragSensitivity, -props.maxVerticalDeg, props.maxVerticalDeg)
  rot.y = wrapSigned(startRotY + dx / props.dragSensitivity)
  applyTransform(rot.x, rot.y)
  const now = performance.now()
  const dt = now - prevT
  if (dt > 0) {
    velX = (e.clientX - prevX) / dt
    prevX = e.clientX
    prevT = now
  }
}
function endDrag(e: PointerEvent) {
  if (!dragging) return
  dragging = false
  mainEl.value?.classList.remove('is-grabbing')
  try {
    mainEl.value?.releasePointerCapture(e.pointerId)
  } catch {
    /* 见上 */
  }
  if (moved) {
    lastDragEndAt = performance.now()
    startInertia(velX * 1000)
  }
}
function onPointerUp(e: PointerEvent) {
  endDrag(e)
}
function onPointerCancel(e: PointerEvent) {
  dragging = false
  mainEl.value?.classList.remove('is-grabbing')
  try {
    mainEl.value?.releasePointerCapture(e.pointerId)
  } catch {
    /* 见上 */
  }
}

/* 桌面滚轮横转:不接管纵向页面滚动(那是父层的事),只吃 deltaX。 */
function onWheel(e: WheelEvent) {
  if (!e.deltaX) return
  e.preventDefault()
  rot.y = wrapSigned(rot.y + e.deltaX / 6)
  applyTransform(rot.x, rot.y)
}

/* 点图:走事件委托,避免为每格挂一个监听。moved 或刚拖完就吞掉。 */
function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  const btn = target?.closest('[data-tile-id]') as HTMLElement | null
  if (!btn) return
  if (moved || performance.now() - lastDragEndAt < 80) return
  const id = btn.dataset.tileId
  if (id) emit('open', id)
}

let ro: ResizeObserver | null = null
/* images 变了要让球壳重新排砖。tiles 用 computed 已经自动算,但 applyRadius
   依赖实测尺寸,DOM 更新后需要一帧回调再算一次,免得 --radius 落后于新格数。 */
watch(
  () => props.images,
  () => {
    requestAnimationFrame(() => {
      const root = rootEl.value
      if (!root) return
      const r = root.getBoundingClientRect()
      applyRadius(Math.max(1, r.width), Math.max(1, r.height))
    })
  }
)

onMounted(() => {
  const root = rootEl.value
  const main = mainEl.value
  if (!root || !main) return
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect
      applyRadius(Math.max(1, cr.width), Math.max(1, cr.height))
    })
    ro.observe(root)
  }
  applyRadius(root.clientWidth || 1, root.clientHeight || 1)
  main.addEventListener('pointerdown', onPointerDown)
  main.addEventListener('pointermove', onPointerMove)
  main.addEventListener('pointerup', onPointerUp)
  main.addEventListener('pointercancel', onPointerCancel)
  main.addEventListener('wheel', onWheel, { passive: false })
  main.addEventListener('click', onClick)
})

onBeforeUnmount(() => {
  stopInertia()
  ro?.disconnect()
  ro = null
  const main = mainEl.value
  if (main) {
    main.removeEventListener('pointerdown', onPointerDown)
    main.removeEventListener('pointermove', onPointerMove)
    main.removeEventListener('pointerup', onPointerUp)
    main.removeEventListener('pointercancel', onPointerCancel)
    main.removeEventListener('wheel', onWheel)
    main.removeEventListener('click', onClick)
  }
})
</script>

<template>
  <div
    ref="rootEl"
    class="dome-root"
    :style="{ '--seg': String(Math.max(6, Math.min(60, Math.floor(seg)))) }"
    aria-label="Dome gallery"
    role="group"
  >
    <main ref="mainEl" class="dome-main">
      <div class="dome-stage">
        <div ref="sphereEl" class="dome-sphere">
          <div
            v-for="t in tiles"
            :key="t.key"
            class="dome-item"
            :style="{ '--offset-x': t.x, '--offset-y': t.y }"
          >
            <button
              type="button"
              class="dome-tile"
              :data-tile-id="t.id"
              :aria-label="t.alt ? `Open ${t.alt}` : 'Open image'"
            >
              <img :src="t.src" :alt="t.alt" draggable="false" />
            </button>
          </div>
        </div>
      </div>
      <!-- 边缘径向压暗 + 上下渐隐:让球壳出画处不生硬,和样张一致 -->
      <div class="dome-vignette" aria-hidden="true"></div>
      <div class="dome-fade dome-fade--top" aria-hidden="true"></div>
      <div class="dome-fade dome-fade--bottom" aria-hidden="true"></div>
      <!-- 首次进入的一句轻提示:说清"这是能拖着转的"。fadehint 5s 后消失 -->
      <p class="dome-hint" aria-hidden="true">
        <svg
          class="dome-hint-ico"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4" />
        </svg>
        拖动旋转 · 点一张进预览
      </p>
    </main>
  </div>
</template>

<style scoped>
/* 穹顶**不再自带暗舞台**:外层不铺背景、不加边缘压暗、不切圆角 ——
   图砖直接浮在 Kairo 的浅色页上。所有色值收在 scoped 里,不外溢污染全站 token。 */
.dome-root {
  --tile-bg: var(--surface, #ffffff); /* 图砖占位底:还没加载完时露出,与页面卡片同色 */
  --radius: 520px; /* JS 会按容器覆盖 */
  --circ: calc(var(--radius) * 3.14159);
  --rot-y: calc((360deg / var(--seg)) / 2);
  --rot-x: calc((360deg / var(--seg)) / 2);
  --item-width: calc(var(--circ) / var(--seg));
  --item-height: calc(var(--circ) / var(--seg));
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 320px;
  /* overflow:hidden 只是为了切掉跑出容器的图砖撑出页面滚动条,
     不再画圆角 —— 画圆角就等于又框出一块"舞台",正是要拿掉的东西 */
  overflow: hidden;
}
.dome-main {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  touch-action: none; /* 交给 pointer 事件,浏览器不再横向滑页 */
  user-select: none;
  -webkit-user-select: none;
  cursor: grab;
}
.dome-main.is-grabbing {
  cursor: grabbing;
}
.dome-stage {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  perspective: calc(var(--radius) * 2);
  perspective-origin: 50% 50%;
  contain: layout paint size;
}
.dome-sphere {
  transform: translateZ(calc(var(--radius) * -1));
  will-change: transform;
}
.dome-sphere,
.dome-item,
.dome-tile,
.dome-tile img {
  transform-style: preserve-3d;
}
.dome-item {
  width: calc(var(--item-width) * 2);
  height: calc(var(--item-height) * 2);
  position: absolute;
  top: -999px;
  bottom: -999px;
  left: -999px;
  right: -999px;
  margin: auto;
  transform-origin: 50% 50%;
  backface-visibility: hidden;
  transform:
    rotateY(calc(var(--rot-y) * (var(--offset-x) + 0.5)))
    rotateX(calc(var(--rot-x) * (var(--offset-y) - 0.5)))
    translateZ(var(--radius));
}
.dome-tile {
  position: absolute;
  inset: 8px;
  display: block;
  padding: 0;
  /* 一条 1px 细边:让图砖"坐在页面上"而不是"浮在页面上"——
     没有边的一堆悬浮卡,集体观感就是贴了一块 UI 面板 */
  border: 1px solid var(--line, #e8e6e1);
  border-radius: var(--r, 16px); /* 与图墙 .tile 同一档圆角,两处不必再学两种看图习惯 */
  background: var(--tile-bg);
  overflow: hidden;
  backface-visibility: hidden;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(17, 17, 17, 0.06), 0 1px 3px rgba(17, 17, 17, 0.04);
  transition:
    transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1),
    box-shadow 220ms ease,
    border-color 220ms ease;
  -webkit-tap-highlight-color: transparent;
}
.dome-tile:hover {
  transform: translateZ(0) scale(1.05);
  box-shadow: 0 10px 24px rgba(17, 17, 17, 0.12);
  border-color: var(--text-2, #6b6b6b);
}
/* 键盘可达:焦点态用一条琥珀环,和主站同一色语 */
.dome-tile:focus-visible {
  outline: 2px solid #b4641c;
  outline-offset: 3px;
}
.dome-tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
  /* 静息态轻微降饱和:一堆照片不至于和安静的页面抢注意力。
     悬停/聚焦再回到原色,让"正在看的那张"自己跳出来 */
  filter: saturate(0.9);
  transition: filter 220ms ease;
}
.dome-tile:hover img,
.dome-tile:focus-visible img {
  filter: saturate(1);
}

/* 边缘压暗:让球壳在画布边缘不生硬收掉 —— 亮底上不需要,整段关掉;
   模板节点仍保留,日后要恢复只删下面这条 display:none 就行 */
.dome-vignette,
.dome-fade {
  display: none;
}
.dome-vignette {
  position: absolute;
  inset: 0;
  margin: auto;
  z-index: 3;
  pointer-events: none;
  background-image: radial-gradient(rgba(0, 0, 0, 0) 62%, var(--stage) 100%);
}
.dome-fade {
  position: absolute;
  left: 0;
  right: 0;
  height: 96px;
  z-index: 5;
  pointer-events: none;
  background: linear-gradient(to bottom, transparent, var(--stage));
}
.dome-fade--top {
  top: 0;
  transform: rotate(180deg);
}
.dome-fade--bottom {
  bottom: 0;
}

.dome-hint {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 6;
  margin: 0;
  /* 亮底上写灰,不再假设底下是暗的 */
  color: rgba(23, 21, 15, 0.55);
  font-size: 12px;
  letter-spacing: 0.02em;
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  animation: domeFadeHint 5s ease forwards;
}
.dome-hint-ico {
  width: 16px;
  height: 16px;
  opacity: 0.8;
}
@keyframes domeFadeHint {
  0%,
  70% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
/* 无障碍:动画类提示直接不给 */
@media (prefers-reduced-motion: reduce) {
  .dome-hint {
    animation: none;
    opacity: 0.7;
  }
}
</style>
