<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { siDeepseek, siGooglegemini, siAlibabacloud, siBytedance } from 'simple-icons'
import { PhOpenAiLogo, PhPlugsConnected } from '@phosphor-icons/vue'

/* 厂商品牌标。
   四家能拿到官方图形:Gemini、DeepSeek、阿里云(百炼)、字节跳动
   (火山方舟/豆包的母品牌 —— 火山自己没有进这个库)。
   拿不到的走兜底:simple-icons 因商标原因删掉了 OpenAI,所以改用 Phosphor
   画的那个标 —— 同一个图形,只是来自另一个库。两边都按实心渲染,
   一列图标不会一半实心一半描边。
   认不出的厂商(自填的中转站)用接线图标:它没有品牌可言,给谁都算冒名。 */

const props = withDefaults(defineProps<{ brand: string; size?: number }>(), { size: 16 })

const PATHS: Record<string, string> = {
  gemini: siGooglegemini.path,
  deepseek: siDeepseek.path,
  dashscope: siAlibabacloud.path,
  'dashscope-compat': siAlibabacloud.path,
  ark: siBytedance.path
}
const COMPONENTS: Record<string, Component> = {
  openai: PhOpenAiLogo
}

const path = computed(() => PATHS[props.brand] || '')
const comp = computed(() => COMPONENTS[props.brand])
/* 尺寸走行内样式而不是各自的 CSS:三种用它的地方(列表行、预设芯片、
   快捷入口)尺寸不同,而这是个多根组件,父组件的 scoped 选择器
   到不了它内部 */
const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
</script>

<template>
  <svg
    v-if="path"
    class="v-ic"
    :style="box"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path :d="path" />
  </svg>
  <component
    v-else-if="comp"
    :is="comp"
    class="v-ic"
    :style="box"
    weight="fill"
    aria-hidden="true"
  />
  <PhPlugsConnected v-else class="v-ic" :style="box" weight="fill" aria-hidden="true" />
</template>

<style scoped>
.v-ic {
  flex: none;
  display: block;
  opacity: 0.85;
}
</style>
