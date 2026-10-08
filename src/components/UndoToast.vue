<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { PhArrowULeftUp } from '@phosphor-icons/vue'

/* 撤销条:删除不再弹确认框,而是"立刻生效 + 几秒内可撤销"。
   样式与交互取自 React Bits 的 FuseButton(引信绕外框燃烧),这里用 Vue + WAAPI 重写:
   确认框要求用户在什么都还没发生之前就做出判断,而真正需要的是"做错了能回头"。

   它只有一种相位(已点燃),因为条目在删除那一刻就已经从列表上消失了 ——
   React 原版那套 idle/armed 换面在这里没有意义。 */
const props = defineProps<{
  /** 说明删掉了什么,如 "Prompt deleted" */
  label: string
  /** 保险丝烧完用多久(毫秒) */
  duration: number
}>()
const emit = defineEmits<{
  (e: 'undo'): void
  (e: 'expire'): void
}>()

const rim = ref<SVGRectElement | null>(null)
const btn = ref<HTMLButtonElement | null>(null)
let anim: Animation | null = null
/* 悬停与"页面切到后台"时停烧:这两种情况都可能让用户来不及点。
   用普通对象而不是 ref —— 它只影响动画,不参与渲染 */
const hold = { hover: false, hidden: false }

/* 偏好减少动态时那条引信不烧(WAAPI 动画不受 style.css 里那条 CSS 抑制影响,
   它只管 CSS 动画与过渡),但"到点自动消失"和"悬停暂停"这两条行为得原样保住 ——
   于是同一段时间改由一个定时器来走 */
const reduceMotion =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
let fuseTimer = 0
/** 定时器这一轮还剩多少毫秒(暂停时按已走过的扣掉) */
let fuseRemain = 0
let fuseAt = 0

function sync() {
  if (reduceMotion) {
    if (fuseTimer) {
      window.clearTimeout(fuseTimer)
      fuseTimer = 0
      fuseRemain -= Date.now() - fuseAt
    }
    if (hold.hover || hold.hidden) return
    fuseAt = Date.now()
    fuseTimer = window.setTimeout(() => emit('expire'), Math.max(0, fuseRemain))
    return
  }
  const a = anim
  if (!a) return
  // 已经烧完(playState 为 finished)时不要再 play,否则会把 onfinish 又跑一遍
  if (hold.hover || hold.hidden) a.pause()
  else if (a.playState === 'paused') a.play()
}

/* 烧的是外框那条线:rect 配 pathLength=1 + dasharray:1,
   把 dashoffset 从 0 推到 -1 就是"绕一圈烧完" */
function burn() {
  anim?.cancel()
  window.clearTimeout(fuseTimer)
  fuseTimer = 0
  const el = rim.value
  if (!el) return
  if (reduceMotion) {
    fuseRemain = props.duration
    fuseAt = Date.now()
    fuseTimer = window.setTimeout(() => emit('expire'), props.duration)
    return
  }
  anim = el.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -1 }], {
    duration: props.duration,
    easing: 'linear',
    fill: 'forwards'
  })
  anim.onfinish = () => emit('expire')
  sync()
}

function onVisibility() {
  hold.hidden = document.hidden
  sync()
}
function onEnter() {
  hold.hover = true
  sync()
}
function onLeave() {
  hold.hover = false
  sync()
}

onMounted(() => {
  burn()
  document.addEventListener('visibilitychange', onVisibility)
  /* 删除之后,原来那个「删除」菜单项已经不存在了,焦点会掉到 body 上。
     接过来放在撤销按钮上:键盘用户接着按 Enter/Escape 就能撤销。

     但有两件事不该被这一下打断:焦点还稳稳待在别处(用户正在别的地方操作),
     以及正落在输入框里 —— 抢过来会打断正在敲的字,移动端还会弹起键盘。
     所以只认"焦点真的丢了"那一种 */
  const at = document.activeElement as HTMLElement | null
  const typing =
    !!at && (at.tagName === 'INPUT' || at.tagName === 'TEXTAREA' || at.isContentEditable)
  const lost = !at || at === document.body || !at.isConnected
  if (lost && !typing) btn.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  window.clearTimeout(fuseTimer)
  anim?.cancel()
})
</script>

<template>
  <!-- 整个胶囊都是撤销按钮:想撤销的人不该还要瞄准某个小块 -->
  <div class="undo" @pointerenter="onEnter" @pointerleave="onLeave">
    <button
      ref="btn"
      type="button"
      class="undo-btn"
      aria-keyshortcuts="Escape"
      @click="emit('undo')"
      @keydown.escape.stop="emit('undo')"
    >
      <span class="undo-icon" aria-hidden="true"><PhArrowULeftUp /></span>
      Undo
      <span class="undo-label">{{ label }}</span>
    </button>
    <svg class="undo-rim" aria-hidden="true">
      <rect ref="rim" pathLength="1" />
    </svg>
    <!-- 读屏用户看不到那条燃烧的线,所以把"还能撤销"这件事说出来 -->
    <span class="undo-sr" role="status" aria-live="polite">{{ label }}. Undo available.</span>
  </div>
</template>

<style scoped>
.undo {
  --undo-ink: var(--cta-text);
  --undo-bg: var(--cta);
  /* 引信本来就该是暖色的:它是这条界面上唯一一个"正在流逝"的东西 */
  --undo-fuse: #f5a524;
  --undo-thick: 1.5px;
  --undo-radius: 22px;

  position: fixed;
  left: 0;
  right: 0;
  bottom: 28px;
  z-index: 60;
  /* 居中不用 translateX(-50%):进出场的位移也要用 transform,
     两者撞在一起会把这条推到屏幕外。margin 居中就没有这个冲突 */
  margin-inline: auto;
  width: fit-content;
  max-width: calc(100vw - 32px);
  display: inline-grid;
  grid-template-columns: minmax(0, 1fr);
  height: 44px;
  border-radius: 999px;
  background: var(--undo-bg);
  color: var(--undo-ink);
  box-shadow: var(--sh-md);
  overflow: hidden;
  isolation: isolate;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
/* 对话页:抬到输入区**之上**。
   两件事挤在同一个位置 —— 撤销条是 bottom: 28px 的居中浮条,而聊天页的
   输入卡片也是底部居中(卡片底边离视口底约 40px)。实测重叠 32px,
   而且它不只是难看:那一块**会吃掉点击**,想点进输入框打字的那一下
   会落在撤销键上,把刚删掉的东西撤销回来。
   值 = 输入卡片顶边到视口底的距离(约 92px)+ 一道缝。
   类名由主界面按"当前是不是对话页"给(见 App.vue) */
.undo.over-compose {
  bottom: 100px;
}
.undo-btn {
  grid-area: 1 / 1;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 100%;
  padding: 0 20px;
  font-size: var(--fs-sm);
  font-weight: 500;
  color: inherit;
  white-space: nowrap;
  cursor: pointer;
  transition: background 160ms var(--ease);
}
.undo-icon {
  display: inline-flex;
  width: 15px;
  height: 15px;
}
.undo-icon svg {
  width: 100%;
  height: 100%;
}
/* 说明文字比动作轻一档,免得整条看起来像两个按钮 */
.undo-label {
  font-weight: 400;
  color: color-mix(in srgb, var(--undo-ink) 62%, transparent);
}
@media (hover: hover) and (pointer: fine) {
  .undo-btn:hover {
    background: color-mix(in srgb, var(--undo-ink) 9%, transparent);
  }
}
.undo-rim {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
  filter: drop-shadow(0 0 3px color-mix(in srgb, var(--undo-fuse) 60%, transparent));
}
.undo-rim rect {
  x: calc(var(--undo-thick) / 2);
  y: calc(var(--undo-thick) / 2);
  width: calc(100% - var(--undo-thick));
  height: calc(100% - var(--undo-thick));
  rx: calc(var(--undo-radius) - var(--undo-thick) / 2);
  fill: none;
  stroke: var(--undo-fuse);
  stroke-width: var(--undo-thick);
  stroke-linecap: round;
  stroke-dasharray: 1;
}
.undo-sr {
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
@media (prefers-contrast: more) {
  .undo {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--undo-ink) 40%, transparent), var(--sh-md);
  }
}
@media (forced-colors: active) {
  .undo-rim rect {
    stroke: Highlight;
  }
}
</style>
