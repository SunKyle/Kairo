<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/* 出图 / 起稿时的加载指示,形态是「取景框」:
   四角括弧向内收放,像相机对焦锁定的那一下。
   动画全部交给 CSS —— 呼吸走 scale 这个独立变换属性,于是它能和
   结束态收拢用的 transform 叠加而互不覆盖,也就不必为切换态再包一层壳。
   运行期唯一写 DOM 的地方是秒表计时器(每 100ms 一次),走 ref 直接改
   textContent,不触发组件重渲染 —— 与 RubberSegment 里滑块裁剪同一个理由。 */

type Mark = 'done' | 'error'

/* 勾与叉各一条路径(viewBox 24×24)。
   配 pathLength="1" 把实际长度归一化,描边进度就能写成与图形长度无关的 dashoffset */
const MARK_PATH: Record<Mark, string> = {
  done: 'M7.6 12.3 10.9 15.6 16.6 8.6',
  error: 'M8.6 8.6 15.4 15.4M15.4 8.6 8.6 15.4'
}

/** 十分之一秒 → “12.3s” / “1m 02.3s” */
function fmt(ds: number) {
  return ds < 600 ? `${(ds / 10).toFixed(1)}s` : `${Math.floor(ds / 600)}m ${((ds % 600) / 10).toFixed(1)}s`
}
/** 同上,给读屏用,不要缩写成 m/s */
function spoken(ds: number) {
  return ds < 600
    ? `${(ds / 10).toFixed(1)} seconds`
    : `${Math.floor(ds / 600)} minutes ${((ds % 600) / 10).toFixed(1)} seconds`
}

const props = withDefaults(
  defineProps<{
    /** 工作中的动词 */
    label?: string
    /** 完成后的动词,后面跟冻结的时间 */
    doneLabel?: string
    /** 出错后的动词 */
    errorLabel?: string
    status?: 'working' | 'done' | 'error'
    /** 括弧的墨色,默认继承当前文字颜色 */
    color?: string
    doneColor?: string
    errorColor?: string
    /** 取景框边长由它推算:两处的量级都要和相邻文字对齐 */
    fontSize?: number
    /** 静息的浓度。工作途中不再明暗起伏,起伏只由缩放表达 */
    idleOpacity?: number
    showTimer?: boolean
    /** 受控的已用秒数;给了就不再自己计时 */
    elapsed?: number
  }>(),
  {
    label: 'Thinking',
    doneLabel: 'Done in',
    errorLabel: 'Failed after',
    status: 'working',
    color: 'currentColor',
    doneColor: '#22c55e',
    errorColor: '#ef4444',
    fontSize: 14,
    idleOpacity: 0.72,
    showTimer: true
  }
)

/* 边长取 1.25 倍字号:三个尺寸(边长、臂长、线宽)都按它等比推出去,
   于是 20px 的区段标题和 12px 的面板小字共用一套几何,不必各配一遍 */
const size = computed(() => Math.round(props.fontSize * 1.25))
const vars = computed(() => ({
  '--ll-size': `${size.value}px`,
  '--ll-stroke': `${(size.value * 0.072).toFixed(2)}px`,
  '--ll-arm': `${(size.value * 0.336).toFixed(2)}px`,
  '--ll-corner': `${(size.value * 0.112).toFixed(2)}px`,
  '--ll-font': `${props.fontSize}px`,
  '--ll-color': props.color,
  '--ll-mark': props.status === 'error' ? props.errorColor : props.doneColor,
  '--ll-idle': String(props.idleOpacity)
}))

/* 只有非工作态才挂这条路径:靠 v-if 连元素一起换掉,
   描边进度才会重新跑一遍 —— 只改 d 是唤不醒 CSS 动画的 */
const markPath = computed(() => (props.status === 'error' ? MARK_PATH.error : MARK_PATH.done))

const announce = ref('')

watch(
  () => props.status,
  (s) => {
    announce.value =
      s === 'working'
        ? `${props.label}, in progress`
        : `${s === 'done' ? props.doneLabel : props.errorLabel}${props.showTimer ? ` ${spoken(ds)}` : ''}`
  },
  { immediate: true }
)

const timerEl = ref<HTMLElement | null>(null)
let ds = 0
let ticker: number | undefined

function paint(v: number) {
  ds = v
  if (timerEl.value) timerEl.value.textContent = fmt(v)
}

function startClock() {
  if (ticker !== undefined) {
    clearInterval(ticker)
    ticker = undefined
  }
  if (props.elapsed != null) {
    // 受控:外部给多少就是多少,不起自己的表
    paint(Math.round(props.elapsed * 10))
    return
  }
  if (props.status !== 'working') return
  const startedAt = performance.now()
  paint(0)
  ticker = window.setInterval(() => paint(Math.floor((performance.now() - startedAt) / 100)), 100)
}

onMounted(startClock)
// 两个来源分开列:写成 () => [a, b] 每次求值都返回新数组,
// 依赖读起来像"这个数组",而它其实什么都不是
watch([() => props.status, () => props.elapsed], startClock)
onBeforeUnmount(() => {
  if (ticker !== undefined) clearInterval(ticker)
})
</script>

<template>
  <span class="lattice-loader" role="status" :data-status="status" :style="vars">
    <span class="lattice-loader__glyph" aria-hidden="true">
      <span class="lattice-loader__run">
        <i></i><i></i><i></i><i></i>
      </span>
      <svg class="lattice-loader__mark" viewBox="0 0 24 24">
        <path v-if="status !== 'working'" :key="status" :d="markPath" pathLength="1" />
      </svg>
    </span>
    <span class="lattice-loader__label" aria-hidden="true">
      <span class="lattice-loader__text" :data-active="status === 'working' ? '' : undefined">{{ label }}</span>
      <span class="lattice-loader__text" :data-active="status === 'done' ? '' : undefined">{{ doneLabel }}</span>
      <span class="lattice-loader__text" :data-active="status === 'error' ? '' : undefined">{{ errorLabel }}</span>
    </span>
    <span v-if="showTimer" ref="timerEl" class="lattice-loader__timer" aria-hidden="true">0.0s</span>
    <span class="lattice-loader__sr">{{ announce }}</span>
  </span>
</template>

<style scoped>
.lattice-loader {
  --ll-size: 18px;
  --ll-stroke: 1.3px;
  --ll-arm: 6px;
  --ll-corner: 2px;
  --ll-font: 14px;
  --ll-color: currentColor;
  --ll-mark: #22c55e;
  --ll-idle: 0.72;
  /* 对焦一个来回的时长。想改速就从外面盖它,不必碰组件 */
  --ll-cycle: 2000ms;
  --ll-ease-out: cubic-bezier(0.23, 1, 0.32, 1);

  display: inline-flex;
  align-items: center;
  gap: calc(var(--ll-font) * 0.625);
  font-family: inherit;
  font-size: var(--ll-font);
  line-height: 1;
}

.lattice-loader__glyph {
  position: relative;
  flex: none;
  width: var(--ll-size);
  height: var(--ll-size);
}

/* 呼吸只动 scale,收拢只动 transform:两个属性各自独立叠加,
   所以结束态能在"还在轻轻呼吸"的同时往内收,不必拆成两层元素 */
.lattice-loader__run {
  position: absolute;
  inset: 0;
  color: var(--ll-color);
  opacity: var(--ll-idle);
  animation: ll-breathe var(--ll-cycle) cubic-bezier(0.4, 0, 0.6, 1) infinite;
  transition:
    opacity 260ms ease,
    transform 300ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* 四角括弧:每片只画相邻两条边,角上给一点圆角收势 */
.lattice-loader__run i {
  position: absolute;
  width: var(--ll-arm);
  height: var(--ll-arm);
}

.lattice-loader__run i:nth-child(1) {
  top: 0;
  left: 0;
  border-top: var(--ll-stroke) solid currentColor;
  border-left: var(--ll-stroke) solid currentColor;
  border-top-left-radius: var(--ll-corner);
}

.lattice-loader__run i:nth-child(2) {
  top: 0;
  right: 0;
  border-top: var(--ll-stroke) solid currentColor;
  border-right: var(--ll-stroke) solid currentColor;
  border-top-right-radius: var(--ll-corner);
}

.lattice-loader__run i:nth-child(3) {
  right: 0;
  bottom: 0;
  border-right: var(--ll-stroke) solid currentColor;
  border-bottom: var(--ll-stroke) solid currentColor;
  border-bottom-right-radius: var(--ll-corner);
}

.lattice-loader__run i:nth-child(4) {
  bottom: 0;
  left: 0;
  border-bottom: var(--ll-stroke) solid currentColor;
  border-left: var(--ll-stroke) solid currentColor;
  border-bottom-left-radius: var(--ll-corner);
}

/* 收工:括弧往内收拢着退场,像快门合上 —— 位置让给随后画出来的勾/叉 */
.lattice-loader:not([data-status='working']) .lattice-loader__run {
  opacity: 0;
  transform: scale(0.62);
}

.lattice-loader__mark {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}

.lattice-loader__mark path {
  fill: none;
  stroke: var(--ll-mark);
  /* 视口是 24,与 --ll-stroke 的 0.072 同源,所以随尺寸等比缩放 */
  stroke-width: 1.73;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: ll-draw 380ms var(--ll-ease-out) 80ms forwards;
}

/* 对焦:口径往内收再放回,收得最深的一刻像合焦 */
@keyframes ll-breathe {
  0%,
  100% {
    scale: 1;
  }

  50% {
    scale: 0.72;
  }
}

@keyframes ll-draw {
  to {
    stroke-dashoffset: 0;
  }
}

.lattice-loader__label {
  position: relative;
  display: inline-block;
  font-weight: 500;
}

.lattice-loader__text {
  position: absolute;
  top: 0;
  left: 0;
  white-space: nowrap;
  opacity: 0;
  filter: blur(2px);
  transition:
    opacity 200ms ease,
    filter 200ms ease;
}

.lattice-loader__text[data-active] {
  position: static;
  opacity: 1;
  filter: blur(0);
}

.lattice-loader__timer {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: calc(var(--ll-font) * 0.875);
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}

.lattice-loader__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* 减少动态:定在一个中间口径的对焦位上;勾/叉也不再自绘,直接给完整的。
   这一段的 animation: none 盖得住 style.css 里那条全局的 animation-duration 抑制 */
@media (prefers-reduced-motion: reduce) {
  .lattice-loader__run {
    animation: none;
    scale: 0.88;
  }

  .lattice-loader__mark path {
    animation: none;
    stroke-dashoffset: 0;
  }

  .lattice-loader__text {
    filter: none;
  }
}
</style>
