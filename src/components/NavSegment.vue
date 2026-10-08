<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import {
  PhHouse,
  PhMaskHappy,
  PhChatCircleDots,
  PhFrameCorners,
  PhBooks,
  PhClockCounterClockwise,
  PhGear
} from '@phosphor-icons/vue'
import RubberSegment from './RubberSegment.vue'
import { NAV_ITEMS } from '../lib/nav'

/* 顶部导航(分段控件)。
   六个条目是六个平级页面,不是六个动作:滑块停在哪儿就是当前在看哪一页。
   条目清单在 lib/nav.ts —— 顶部字标也要按页面取名字,那份清单两处共用。

   这里只管渲染与转手状态,当前是哪一页由主界面持有(page / navView)。
   它是最顶层那条横条上的控件,每一页都在,切页时位置不动。

   value 与 App 的 Page 联合类型对得上,但这里不做类型收敛 ——
   它只负责把视图状态转手,不认识具体有哪些页 */

const view = defineModel<string>({ required: true })

defineProps<{
  /* 未配置接口时把设置那枚齿轮标红 */
  warn?: boolean
}>()

/* 窄屏把整条导航抬高一档。
   为什么不能只靠 CSS:条目高度 = 轨道高 - 上下 inset,而这两个数是由
   RubberSegment 的 props 写进内联样式的 —— 滑块的位置又是它按每一条的
   实际矩形量出来的(见那边的 measure)。只改 CSS 的话轨道变了、滑块还是旧几何;
   改 props 则会被 watch 接到,量一遍就对齐了。
   40 → 48:手机上的触控目标,这一条是每一页都要点的那一个控件,
   30px 的条目(40 − 上下各 5)在拇指下确实容易点错 */
const narrow = ref(false)
const mq = window.matchMedia('(max-width: 720px)')
const sync = () => (narrow.value = mq.matches)
sync()
mq.addEventListener('change', sync)
onBeforeUnmount(() => mq.removeEventListener('change', sync))
</script>

<template>
  <RubberSegment
    v-model="view"
    class="nav-seg"
    :items="NAV_ITEMS"
    :radius="999"
    :height="narrow ? 48 : 40"
    :inset="narrow ? 4 : 5"
    aria-label="Main navigation"
  >
    <template #home>
      <PhHouse class="seg-ico" aria-hidden="true" />
    </template>
    <template #chars>
      <!-- 人形:角色是"同一个人跨图保持一致"的那件事 -->
      <PhMaskHappy class="seg-ico" aria-hidden="true" />
    </template>
    <template #chat>
      <!-- 圆头对话气泡:跟这个角色说话,与 CharacterPage 那次对话是同一件事 -->
      <PhChatCircleDots class="seg-ico" aria-hidden="true" />
    </template>
    <template #canvas>
      <!-- 四角取景框:画布是"框住一块地方来加工"的工作台 -->
      <PhFrameCorners class="seg-ico" aria-hidden="true" />
    </template>
    <template #lib>
      <!-- Phosphor 的 Books:表达"收藏成册的提示词库" -->
      <PhBooks class="seg-ico" aria-hidden="true" />
    </template>
    <template #history>
      <PhClockCounterClockwise class="seg-ico" aria-hidden="true" />
    </template>
    <template #settings>
      <PhGear class="seg-ico" :class="{ 'is-warn': warn }" aria-hidden="true" />
    </template>
  </RubberSegment>
</template>

<style scoped>
/* 17px 是照 34px 胶囊定的,导航条加高到 40px 后配套提到 19px,
   与主题按钮的图标同档,两个控件在一行里视觉重量才对得上 */
.nav-seg .seg-ico {
  width: 19px;
  height: 19px;
}
/* 未配置接口时齿轮标红。选中态那层由滑块的反色副本接管,所以排除 .rs-copy */
.nav-seg :deep(.rs-item:not(.rs-copy)[aria-checked='false'] .is-warn) {
  color: var(--danger);
}
</style>
