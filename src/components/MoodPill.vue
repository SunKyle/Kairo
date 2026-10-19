<script setup lang="ts">
/* 角色此刻的情绪胶囊（方向 C：表情图标 + 淡 tint 底）。
 *
 *  它只负责"把一枚词长什么样"画出来，判据全在 lib/moodDisplay —— 命中给中文+表情+
 *  温度桶，没命中回显原词走灰。词表是纯展示、不进对话回路（见那份文件的说明）。
 *
 *  父组件把 :key 绑在词上：词一变就换节点，入场动画因此重播一次 —— 情绪变了该被
 *  看见，而不是悄无声息换个字（沿用旧 .mood 的思路）。 */
import { computed } from 'vue'
import { resolveMood } from '../lib/moodDisplay'

const props = defineProps<{ mood: string }>()

const d = computed(() => resolveMood(props.mood))
</script>

<template>
  <span v-if="d" class="mood-pill" :data-tone="d.tone" :title="mood">
    <i v-if="d.face" class="ic" aria-hidden="true">{{ d.face }}</i>
    <span class="lbl">{{ d.label }}</span>
  </span>
</template>

<style scoped>
.mood-pill {
  /* 中性兜底：没温度时就是站内那档克制的灰 */
  --t-bg: var(--bg-elev);
  --t-fg: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--t-bg);
  color: var(--t-fg);
  font-size: var(--fs-micro);
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
  animation: mood-in 280ms var(--ease) both;
}
/* 四个温度桶：低饱和、无发光，只"泄露一点温度"，不破坏 Apple+Linear 墨色基调 */
.mood-pill[data-tone="warm"] { --t-bg: rgba(211, 163, 42, 0.14); --t-fg: #8a6a12; }
.mood-pill[data-tone="hot"]  { --t-bg: rgba(176, 82, 60, 0.13);  --t-fg: #9c3e2e; }
.mood-pill[data-tone="cool"] { --t-bg: rgba(78, 117, 148, 0.15); --t-fg: #33556e; }
.mood-pill[data-tone="low"]  { --t-bg: rgba(122, 115, 154, 0.15); --t-fg: #5b5474; }

/* 表情坐进一枚白底小圆，像贴纸；没有对应脸（未命中的词）时这层不出现 */
.ic {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  flex: none;
  margin-left: -5px;
  display: grid;
  place-items: center;
  font-size: 11px;
  line-height: 1;
  background: rgba(255, 255, 255, 0.65);
}

@keyframes mood-in {
  from {
    opacity: 0;
    transform: translateY(-3px) scale(0.92);
  }
}

/* 暗色：前景必须提亮一档，否则深色 fg 压在暗底上读不出；白底小圆也收暗 */
html[data-theme="dark"] .mood-pill { --t-bg: var(--bg-elev); --t-fg: var(--text-2); }
html[data-theme="dark"] .mood-pill[data-tone="warm"] { --t-bg: rgba(241, 198, 75, 0.15); --t-fg: #e6bc4a; }
html[data-theme="dark"] .mood-pill[data-tone="hot"]  { --t-bg: rgba(255, 92, 95, 0.16);  --t-fg: #ff8a87; }
html[data-theme="dark"] .mood-pill[data-tone="cool"] { --t-bg: rgba(120, 160, 200, 0.18); --t-fg: #9cc0de; }
html[data-theme="dark"] .mood-pill[data-tone="low"]  { --t-bg: rgba(160, 150, 190, 0.18); --t-fg: #bdb6d8; }
html[data-theme="dark"] .mood-pill .ic { background: rgba(255, 255, 255, 0.12); }

@media (prefers-reduced-motion: reduce) {
  .mood-pill {
    animation: none;
  }
}
</style>
