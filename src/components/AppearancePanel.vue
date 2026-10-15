<script setup lang="ts">
import type { Theme } from '../lib/theme'

/* 外观(设置页的「Appearance」分区)。
   只有两项,而且都是**这台设备上这个人怎么看界面**的偏好 ——
   它们与"数据长什么样"无关,所以放在用户向设置的第一位。

   —— 与顶栏那枚主题按钮的关系 ——

   两处都能切主题,而且**都读写同一个状态**(主界面的 theme,见 App.vue)——
   不存在两份真相。顶栏那枚是随手一按,这一页是"我来看设置"时能找到它。
   沉浸模式同理:对话页顶上有一枚,这里也有。

   —— 为什么用两档分段而不是开关 ——

   开关只能表达"开/关",而主题是"亮/暗"两个平级的名字 ——
   一个写着"Dark mode"的开关在关闭时读起来像"黑暗模式被关掉了",
   而它其实可能本来就是亮的。两档分段把两个名字都摆出来,没有这种歧义。
   沉浸模式那项反过来,它本来就是开/关,但同一页两行不同控件会显得杂,
   所以同样用分段 —— 顺带把"关"这个状态写成了"Stay in the page"这种人话。 */

const props = defineProps<{
  theme: Theme
  /** 用户的沉浸偏好(存盘的那一个,不是"此刻这一页长什么样") */
  immersive: boolean
}>()

const emit = defineEmits<{
  (e: 'theme', v: Theme): void
  (e: 'immersive', on: boolean): void
}>()
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h3 class="panel-title">Appearance</h3>
      <span class="panel-note">How Kairo looks on this device. Nothing here changes your data.</span>
    </div>

    <div class="rows">
      <div class="row">
        <div class="row-label">
          <span class="row-name">Theme</span>
          <span class="row-hint">
            Follows your system setting until you pick one here.
          </span>
        </div>
        <div class="row-opts" role="radiogroup" aria-label="Theme">
          <button
            type="button"
            class="opt"
            :class="{ on: props.theme === 'light' }"
            role="radio"
            :aria-checked="props.theme === 'light'"
            @click="emit('theme', 'light')"
          >
            Light
          </button>
          <button
            type="button"
            class="opt"
            :class="{ on: props.theme === 'dark' }"
            role="radio"
            :aria-checked="props.theme === 'dark'"
            @click="emit('theme', 'dark')"
          >
            Dark
          </button>
        </div>
      </div>

      <div class="row">
        <div class="row-label">
          <span class="row-name">Chat</span>
          <span class="row-hint">
            Immersive hides the header and lets the conversation fill the screen. You can
            still leave it from inside Chat.
          </span>
        </div>
        <div class="row-opts" role="radiogroup" aria-label="Chat layout">
          <button
            type="button"
            class="opt"
            :class="{ on: !props.immersive }"
            role="radio"
            :aria-checked="!props.immersive"
            @click="emit('immersive', false)"
          >
            Regular
          </button>
          <button
            type="button"
            class="opt"
            :class="{ on: props.immersive }"
            role="radio"
            :aria-checked="props.immersive"
            @click="emit('immersive', true)"
          >
            Immersive
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 与 InteractionPanel 那张卡同一套(同色面上的同一种卡)。
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

/* 窄屏落到上下两段:三档按钮挤在半行里会换行,反而更难扫(与相处偏好同一条) */
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
