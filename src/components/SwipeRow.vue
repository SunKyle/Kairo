<script setup lang="ts">
/**
 * 可滑动的列表行 —— React Bits「SwipeRow」移植到本项目。
 *
 * 原来那一份是 React + motion/react 写的,删除语义:全滑过去 → 行折叠消失,而且是
 * **多动作**设计:一行底下铺一层抽屉底色,右端站第一个动作块,越过提交点它才"跳"
 * 出来填满整行。
 *
 * 这里移植成 Vue 之后,抽屉结构换掉了 —— 因为我们是**单动作**(就是"置顶"),
 * 那套"多动作 + 抽屉底色 + 块跳出来填满"在只有一个动作时反而露怯:揭开一旦超过
 * 一个动作宽,块停在右缘不动,左边空出的一截用的是抽屉底色,而抽屉底色 (--bg-elev)
 * 又跟行面 (--surface) 几乎同色 —— 用户看到的就是一段"空缝",要再拉到提交点
 * 块才跳上来补齐。单动作不需要那层区分,于是改成 iOS 短信那种**跟随式抽屉**:
 * 抽屉面(就是动作色)从右缘长出来,宽度等于当前揭开量,始终贴住行面右边缘 ——
 * 拉到哪一段都不留缝,动作字在抽屉面里居中,拉得越宽越显完整。
 *
 * 其余手感配方(橡皮筋、提交点、甩动落点、越点提示)按原样保留,数学收在
 * lib/swipeTrack 单独有单测。语义上:全滑越点 / 轻点抽屉面 = 执行宿主动作(置顶),
 * **行不折叠** —— 置顶之后它还在名单里,提交动画走完后行面弹回闭合,状态由父组件
 * 从外面改(pinned 一变,抽屉标签自然从 Pin 变 Unpin)。
 *
 * 配色全部走设计 token(面 --surface、动作面 --cta / 字 --cta-text),浅/深主题自动
 * 反相;原组件写死的暗色色板照搬会破坏双主题。
 *
 * 键盘:不再自带隐藏开关钮 —— 等价入口由**宿主**提供(左栏用的是头像上那枚图钉,
 * 聚焦即现)。滑动手势只是同一件事的快捷路径,不是唯一路径。
 *
 * 每帧的 transform / 宽度由 MotionValue 订阅直接写 DOM(与 RubberSegment 同一个理由):
 * 走响应式绑定的话每一帧都要整个组件重渲染,那就白用 MotionValue 了。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import { animate, motionValue } from 'motion'
import {
  FLICK_VELOCITY,
  MOVE_HYSTERESIS,
  clamp,
  exposeDistance,
  fingerDistance,
  isArmed,
  releasePlan,
  velocityOf,
  type SwipeTrack
} from '../lib/swipeTrack'

const props = withDefaults(
  defineProps<{
    /** 这一行是什么(读屏用,一般给角色名) */
    label: string
    /** 动作面的字与图标:「Pin / Unpin」由宿主按当前状态给 */
    actionLabel: string
    actionIcon: Component
    /** 越过提交点时读屏念的那句;不给就用 `Release to <actionLabel>` */
    armedLabel?: string
    /** 打开一档的宽度(px),也是刚够放下动作字的最窄抽屉 */
    actionWidth?: number
    /** 揭开多少(占行宽比例)才算「真的想执行」 */
    commitAt?: number
    /** 越界跟手系数,同 RubberSegment 的橡皮筋 */
    resistance?: number
    disabled?: boolean
    /** 受控展开。宿主用它保证整列同时只开一个抽屉;不传则自管 */
    open?: boolean
  }>(),
  {
    armedLabel: undefined,
    actionWidth: 76,
    commitAt: 0.6,
    resistance: 0.55,
    disabled: false,
    open: undefined
  }
)

const emit = defineEmits<{
  /** 全滑越点、或按抽屉面。行面弹回闭合,状态变化归宿主 */
  (e: 'commit'): void
  (e: 'update:open', open: boolean): void
}>()

const EASE_OUT = [0.23, 1, 0.32, 1] as const
const SPRING_UI = { type: 'spring', duration: 0.3, bounce: 0 } as const
/** 甩出去那一档的回弹:0.2 刚好「落地抖一下」不晃 */
const SPRING_MOMENTUM = { type: 'spring', duration: 0.4, bounce: 0.2 } as const
/** 速度采样只留最近四帧:更老的样本会被慢启动稀释 */
const HIST_MAX = 4

const rootEl = ref<HTMLElement | null>(null)
const surfaceEl = ref<HTMLElement | null>(null)
const drawerEl = ref<HTMLElement | null>(null)

const width = ref(0)
const reduce = ref(false)
const phase = ref<'idle' | 'committing'>('idle')
const dragging = ref(false)
const armed = ref(false)
const internalOpen = ref(false)
const say = ref('')

/** 受控优先:父组件给了 open 就听它的,没给就自管 */
const isOpen = computed(() => props.open ?? internalOpen.value)

const A = computed(() => props.actionWidth)

function trackOf(): SwipeTrack {
  return {
    width: width.value,
    drawer: A.value,
    action: A.value,
    resistance: props.resistance,
    commitAt: props.commitAt,
    fullSwipe: true
  }
}

/* 手势方向固定在「向左滑」(与 iOS 列表、微信一样;左栏在左边,向右滑就出栏了,
   方向反过来手指要绕过大半个屏幕)。所以:x 是负数往左走,exposed = -x。 */
const x = motionValue(0)

/** 抽屉面右锚定、宽度=揭开量;动作字在抽屉面里居中,越宽越显完整 */
function sync() {
  if (!surfaceEl.value || !drawerEl.value) return
  const W = width.value
  const ex = -x.get()
  surfaceEl.value.style.transform = `translateX(${x.get()}px)`
  /* 反向橡皮筋(ex<0)与过界(ex>W)都夹在 0..W:抽屉面只可能在正方向长出来 */
  const w = clamp(ex, 0, W)
  drawerEl.value.style.width = `${w}px`
  /* 刚起步那一丝不留一条纯色发丝,免得看着像描边 */
  drawerEl.value.style.visibility = w < 1 ? 'hidden' : 'visible'
}

let heading: number | null = null

function setOpen(next: boolean) {
  if (next === isOpen.value) return
  internalOpen.value = next
  emit('update:open', next)
}

/** 把行面放到 target(揭开距离)上:甩过的带速度进弹簧、慢放的安静落位 */
function settle(target: number, v = 0) {
  heading = target
  if (reduce.value) {
    animate(x, -target, { duration: 0.2, ease: EASE_OUT })
    return
  }
  const flick = Math.abs(v) >= FLICK_VELOCITY
  animate(
    x,
    -target,
    flick
      ? { ...SPRING_MOMENTUM, velocity: -clamp(v, -1500, 1500) }
      : { ...SPRING_UI, velocity: -v }
  )
}

function setArmed(on: boolean) {
  if (armed.value === on) return
  armed.value = on
  if (on) {
    say.value = props.armedLabel ?? `Release to ${props.actionLabel.toLowerCase()}`
    /* 触屏过点振一下 —— 手比眼睛先知道「松手就执行了」 */
    if (grip?.touch) navigator.vibrate?.(8)
  }
}

/** 执行:行面一路滑出去、抽屉面填满整行(那一下「吞掉」的瞬间),再弹回闭合。
 *  与删除不同,这里**不折叠** —— 置顶之后这行还在,只是父组件会把它的标签换掉。 */
function commit(v = 0) {
  if (phase.value !== 'idle') return
  phase.value = 'committing'
  say.value = props.actionLabel
  setOpen(false)
  /* 滑动执行之后手指抬起会跟着触发一次 click,别让它落到行按钮上 */
  suppressClick = true
  const back = () => {
    if (destroyed) return
    emit('commit')
    animate(x, 0, SPRING_UI).then(() => {
      if (destroyed) return
      heading = 0
      setArmed(false)
      phase.value = 'idle'
    })
  }
  if (reduce.value) {
    x.set(-width.value)
    back()
    return
  }
  animate(x, -width.value, { ...SPRING_UI, velocity: -v }).then(back)
}

/** 按抽屉面:开着的时候它就是「执行」按钮(不用非要甩过提交点,轻点也算数)。
 *  手势尾巴上的那次 click 已经在 clip 的捕获阶段被咽掉(见 onClickCapture),
 *  能走到这里的都是真实的一次点击。 */
function onDrawerClick() {
  if (phase.value !== 'idle' || !isOpen.value) return
  commit()
}

/** 捕获阶段拦一次「拖完/点闭合之后才补到」的 click:
 *  按下与抬起之间行面挪了位置,浏览器还是会把 click 派给手指底下的行按钮 ——
 *  置顶滑完却把会话切了,这是这类组件最经典的一脚坑。
 *  只咽鼠标/触摸补出来的(detail>0);键盘敲出的 Enter/Space(detail=0)照常放行。
 *  陈旧标记不会连吃两次:真正的点击前必有 pointerdown,根上的捕获会先清掉它。 */
function onClickCapture(e: MouseEvent) {
  if (suppressClick && e.detail > 0) {
    suppressClick = false
    e.preventDefault()
    e.stopPropagation()
  }
}

/* —— 手势 ——
   pointer 走 window 级监听(与原组件一致):手指/光标滑出行面之后还得继续跟手,
   行面自己接不到那些事件。 */
interface Grip {
  id: number
  x0: number
  y0: number
  /** 锚点:raw = -clientX - grab;还没定锚时为 null(迟滞期内) */
  grab: number | null
  moved: boolean
  /** 是否已经 setPointerCapture —— 只在手势确立后才捕获(见 onWindowMove),纯点击不捕获 */
  captured: boolean
  hist: [number, number][]
  touch: boolean
}
let grip: Grip | null = null
let unwatch: (() => void) | null = null
/** 拖过/点过闭合之后的那一次 click 要咽下去(行按钮就在手指底下) */
let suppressClick = false

function onDown(e: PointerEvent) {
  if (props.disabled || phase.value !== 'idle' || grip || e.button !== 0) return
  suppressClick = false
  x.stop()
  heading = null
  grip = {
    id: e.pointerId,
    x0: e.clientX,
    y0: e.clientY,
    grab: null,
    moved: false,
    captured: false,
    hist: [],
    touch: e.pointerType === 'touch'
  }
  /* 按下**不**捕获指针。捕获要留到手势真正确立时(见 onWindowMove):
     在按下瞬间就 setPointerCapture(surfaceEl),Chrome 会把随后补出的 click 目标
     改判到捕获元素 .swipe-row__surface,而宿主的"选它"按钮(.rail-row)是它的**子节点**,
     click 从 surface 向上传播根本不经过那颗按钮 → 点角色切不动会话(2026-10 修)。
     迟滞期内(pointermove 不足 10px)本就该是一次点击,不捕获才对。 */
  unwatch?.()
  const onMove = (ev: PointerEvent) => {
    if (ev.isTrusted) onWindowMove(ev)
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.isTrusted) onWindowUp(ev)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  unwatch = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
}

function onWindowMove(e: PointerEvent) {
  const g = grip
  if (!g || g.id !== e.pointerId) return
  const t = trackOf()
  if (g.grab === null) {
    const dx = e.clientX - g.x0
    const dy = e.clientY - g.y0
    /* 迟滞:横向不足 10px、或者纵向还压着横向,都先不动 —— 点击与滚动的命 */
    if (Math.abs(dx) < MOVE_HYSTERESIS || Math.abs(dx) < Math.abs(dy)) return
    g.grab = -(g.x0 + Math.sign(dx) * MOVE_HYSTERESIS) - fingerDistance(-x.get(), t)
    g.moved = true
    dragging.value = true
    /* 到这一步才确认"是要拖",此刻捕获指针:后续 pointermove 即便滑出行面也照样跟手。
       纯点击永远走不到这里,于是 click 正常落回行按钮 */
    if (!g.captured) {
      try {
        surfaceEl.value?.setPointerCapture(e.pointerId)
        g.captured = true
      } catch {
        /* 个别环境不支持捕获,忽略 */
      }
    }
  }
  const exposed = exposeDistance(-e.clientX - g.grab, t)
  x.set(-exposed)
  g.hist.push([performance.now(), exposed])
  if (g.hist.length > HIST_MAX) g.hist.shift()
  setArmed(isArmed(exposed, t))
}

function onWindowUp(e: PointerEvent) {
  const g = grip
  if (!g || g.id !== e.pointerId) return
  grip = null
  unwatch?.()
  unwatch = null
  dragging.value = false
  if (g.captured) {
    try {
      surfaceEl.value?.releasePointerCapture(g.id)
    } catch {
      /* 同上 */
    }
  }
  const exposed = -x.get()
  const v = velocityOf(g.hist)
  if (!g.moved) {
    /* 没挪动:抽屉开着就是「点行面 = 收抽屉」,不能顺手把会话切了 */
    if (isOpen.value) {
      setOpen(false)
      settle(0)
      setArmed(false)
      suppressClick = true
    }
    return
  }
  suppressClick = true
  const plan = releasePlan(exposed, v, trackOf())
  if (plan === 'commit') {
    setArmed(true)
    commit(v)
    return
  }
  const target = plan === 'open' ? A.value : 0
  setArmed(false)
  setOpen(target > 0)
  settle(target, v)
}

/* 受控开合与外部状态变化:非手势期间,行面要跟着 open 走(父组件用它关掉上一行)。
   committing 期间不插手 —— 那段动画由 commit() 自己收尾 */
watch(isOpen, (next) => {
  if (grip || phase.value !== 'idle') return
  const target = next ? A.value : 0
  if (heading === target) return
  setArmed(false)
  settle(target)
})

let observer: ResizeObserver | undefined
let offChange: (() => void) | undefined
let destroyed = false

onMounted(() => {
  const el = rootEl.value
  reduce.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  width.value = el?.offsetWidth || 0
  if (el) {
    observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) {
        width.value = w
        sync()
      }
    })
    observer.observe(el)
  }
  /* set() 值没变化时不派发 change,这里显式订阅一次并在挂载后手动画初值 */
  offChange = x.on('change', sync)
  sync()
})

onBeforeUnmount(() => {
  destroyed = true
  unwatch?.()
  offChange?.()
  observer?.disconnect()
  x.stop()
})

defineExpose({
  /** 宿主用它关掉这一行(比如另一个抽屉开了) */
  close() {
    if (phase.value !== 'idle') return
    setOpen(false)
    if (-x.get() !== 0) settle(0)
  }
})
</script>

<template>
  <div
    ref="rootEl"
    class="swipe-row"
    role="group"
    :aria-label="label"
    :data-open="isOpen || undefined"
    :data-armed="armed || undefined"
    :data-dragging="dragging || undefined"
    :data-disabled="disabled || undefined"
    :style="{ '--sr-a': `${A}px` }"
    @pointerdown.capture="suppressClick = false"
  >
    <div class="swipe-row__clip" @click.capture="onClickCapture">
      <!-- 抽屉面:右锚定,宽度由 sync 写成当前揭开量 —— 永远贴住行面右缘,不留缝。
           整块就是动作热区(单动作,填满=执行),所以它直接是一颗按钮。 -->
      <button
        ref="drawerEl"
        type="button"
        class="swipe-row__drawer"
        :inert="!isOpen || undefined"
        :aria-label="actionLabel"
        @click="onDrawerClick"
      >
        <span class="swipe-row__glyph">
          <component :is="actionIcon" class="swipe-row__icon" aria-hidden="true" />
          <span>{{ actionLabel }}</span>
        </span>
      </button>
      <!-- 行面:宿主的内容都在这一层,拖的就是它 -->
      <div ref="surfaceEl" class="swipe-row__surface" @pointerdown="onDown">
        <slot />
      </div>
    </div>
    <span class="swipe-row__sr" aria-live="polite">{{ say }}</span>
  </div>
</template>

<style scoped>
.swipe-row {
  --sr-r: var(--r-sm, 8px);
  --sr-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  position: relative;
}
.swipe-row[data-disabled] {
  opacity: 0.55;
  pointer-events: none;
}

.swipe-row__clip {
  position: relative;
  border-radius: var(--sr-r);
  overflow: hidden;
  /* 反向橡皮筋时露出的那条左边缘「还是这一行的面」,抽屉色只在滑动方向那侧出现 */
  background: var(--surface);
}

/* 抽屉面 = 动作色实心,右锚定,宽度跟揭开量走 */
.swipe-row__drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  margin: 0;
  padding: 0;
  border: 0;
  background: var(--cta);
  color: var(--cta-text);
  font: inherit;
  cursor: pointer;
  outline: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  transition: background 140ms var(--sr-ease-out);
}
.swipe-row[data-armed] .swipe-row__drawer {
  /* 越过提交点:换成悬停档,给「松手即执行」一点反馈 */
  background: var(--cta-hover);
}

.swipe-row__glyph {
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 0 10px;
  min-width: calc(var(--sr-a) - 20px);
  font-size: var(--fs-micro, 11px);
  font-weight: 500;
  letter-spacing: 0.01em;
  line-height: 1.1;
  white-space: nowrap;
  transition: transform 160ms var(--sr-ease-out);
}

.swipe-row__icon {
  width: 16px;
  height: 16px;
}

.swipe-row__drawer:active .swipe-row__glyph {
  transform: scale(0.97);
}

.swipe-row__surface {
  position: relative;
  z-index: 1;
  background: var(--surface);
  color: var(--text);
  touch-action: pan-y;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}

/* 拖拽期间别选中文字/图片 —— 行面上有名字与摘要,浏览器会当成选区 */
.swipe-row[data-dragging] .swipe-row__surface,
.swipe-row[data-dragging] .swipe-row__surface * {
  user-select: none;
  -webkit-user-select: none;
}
@media (hover: hover) and (pointer: fine) {
  .swipe-row[data-dragging],
  .swipe-row[data-dragging] .swipe-row__surface,
  .swipe-row[data-dragging] .swipe-row__surface * {
    cursor: grabbing;
  }
}

.swipe-row__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

@media (prefers-reduced-motion: reduce) {
  .swipe-row__drawer:active .swipe-row__glyph {
    transform: none;
  }
}
</style>
