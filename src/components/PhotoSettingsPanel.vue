<script setup lang="ts">
import { ref } from 'vue'
import type { PhotoFrequency } from '../lib/prefs'
import {
  savePhotoDirector,
  savePhotoFrequency,
  savedPhotoDirector,
  savedPhotoFrequency
} from '../lib/prefs'

/* 出图(设置页的「Photos」分区)。

   —— 为什么是全局而不是按角色 ——

   相处偏好按角色存,因为"跟 A 可以爱开玩笑、跟 B 希望它正经"是两个人的事;
   这两项不是:摄影指导多不多花一次文本调用、图该稀还是密,是**这台设备上
   这个人**的取舍。硬把它们塞进 Getting along 那一区,会让那个按角色存的
   面板突然混进两条全局项 —— 用户会以为换个人就跟着变。

   —— 为什么自己存取,不走 App ——

   与 InteractionPanel 同一条:这两项没有任何别处要**响应式**地看。
   摄影指导在每次出图那一刻现读(useGeneration),频率在发请求那一刻现读
   (useChatFlow)—— 都发生在别的时刻,不靠这一页把状态传下去。
   所以这一层管"显示 + 落盘",少一层 props 转手。

   —— 频率为什么没有 Off ——

   Off 会把"发图"整个关掉,而那件事已经由"配不配出图模型"决定了
   (见 lib 的 imageConfigReady)。再摆一个 Off,用户会以为两个开关是一回事。
   最低档 Rarely 仍然保留"图是这句话的重点才发"这条判据,不是禁止。

   文字上刻意写 "lean / not a quota":它是提示词倾向,不是客户端硬拦截
   (2026-10-03 的产品决定,见 doc/角色出图.md §4.1.2)。 */

const FREQUENCIES: ReadonlyArray<{ value: PhotoFrequency; label: string }> = [
  { value: 'rare', label: 'Rarely' },
  { value: 'normal', label: 'Sometimes' },
  { value: 'often', label: 'Often' }
]

/* 初值现读盘。存取都可能被禁,但 prefs 里的函数一律不抛 ——
   读不到时就是默认(指导开 / 频率 Sometimes),与没设过一样 */
const director = ref(savedPhotoDirector())
const frequency = ref(savedPhotoFrequency())

function pickDirector(on: boolean): void {
  director.value = on
  savePhotoDirector(on)
}

function pickFrequency(v: PhotoFrequency): void {
  frequency.value = v
  savePhotoFrequency(v)
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h3 class="panel-title">Pictures in Chat</h3>
      <span class="panel-note">
        Applies to every character on this device. Both rows only matter once an Image generation
        model is set up in AI connections.
      </span>
    </div>

    <div class="rows">
      <div class="row">
        <div class="row-label">
          <span class="row-name">How often they send pictures</span>
          <span class="row-hint">
            A lean in the prompt, not a quota — they still decide when a picture is the point
            of the message.
          </span>
        </div>
        <div class="row-opts" role="radiogroup" aria-label="How often they send pictures">
          <button
            v-for="f in FREQUENCIES"
            :key="f.value"
            type="button"
            class="opt"
            :class="{ on: frequency === f.value }"
            role="radio"
            :aria-checked="frequency === f.value"
            @click="pickFrequency(f.value)"
          >
            {{ f.label }}
          </button>
        </div>
      </div>

      <div class="row">
        <div class="row-label">
          <span class="row-name">Photography director</span>
          <span class="row-hint">
            One quick text pass per picture, to set framing, light and lens. Off draws the
            scene exactly as the character wrote it.
          </span>
        </div>
        <div class="row-opts" role="radiogroup" aria-label="Photography director">
          <button
            type="button"
            class="opt"
            :class="{ on: director }"
            role="radio"
            :aria-checked="director"
            @click="pickDirector(true)"
          >
            On
          </button>
          <button
            type="button"
            class="opt"
            :class="{ on: !director }"
            role="radio"
            :aria-checked="!director"
            @click="pickDirector(false)"
          >
            Off
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 与 AppearancePanel / InteractionPanel 同一套卡(同色面上的同一种卡)。
   两份而不是共享:那些类是 scoped 的 —— 改这里的值时顺手看一眼那边 */
.panel {
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
.panel-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: var(--sp-3);
}
.panel-title {
  font-size: var(--fs-lg);
  color: var(--text);
}
.panel-note {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}

.rows {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}
.row-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.row-name {
  font-size: var(--fs-sm);
  color: var(--text);
}
.row-hint {
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}
.row-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}
/* 档位按钮:选中用淡底 + 墨色字(与相处偏好那边同一套)。
   一页里全用实心墨底的话会立起好几块黑,而"选中"在这里本该是轻的 */
.opt {
  padding: 8px 12px;
  font-size: var(--fs-xs);
  font-family: inherit;
  line-height: 1.2;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.opt:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.opt.on {
  background: var(--accent-soft);
  border-color: var(--line-strong);
  color: var(--text);
}
.opt:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 窄屏落到上下两段:三档按钮挤在半行里会换行,反而更难扫(与外观 / 相处偏好同一条) */
@media (max-width: 720px) {
  .row {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-2);
  }
  .row-opts {
    justify-content: flex-start;
  }
  /* 触屏目标抬到 40px */
  .opt {
    min-height: 40px;
  }
}
</style>
