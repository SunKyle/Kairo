<script setup lang="ts">
import type { Theme } from '../lib/theme'
import RubberSegment from './RubberSegment.vue'

/* 外观(设置页的「Appearance」分区)。
   只有两项,而且都是**这台设备上这个人怎么看界面**的偏好 ——
   它们与"数据长什么样"无关,所以放在用户向设置的第一位。

   —— 与顶栏那枚主题按钮的关系 ——

   两处都能切主题,而且**都读写同一个状态**(主界面的 theme,见 App.vue)——
   不存在两份真相。顶栏那枚是随手一按,这一页是"我来看设置"时能找到它。
   沉浸模式同理:对话页顶上有一枚,这里也有。

   —— 为什么用分段控件而不是开关 ——

   开关只能表达"开/关",而主题是"亮/暗"两个平级的名字 ——
   一个写着"Dark mode"的开关在关闭时读起来像"黑暗模式被关掉了",
   而它其实可能本来就是亮的。分段控件把两个名字都摆出来,没有这种歧义;
   沉浸那项反过来本是开/关,但同一页两行控件形状不同会显乱,于是同样用分段。

   控件本体复用全站那枚 <RubberSegment>(顶栏导航也是它):滑块带弹性动效、
   键盘方向键可选、reduced-motion 自动收。外壳(卡片 / 行 / 卡头)走设置页
   共享类 `.k-*`(见 styles/settings.css),这里不再各写一份 scoped。 */

defineProps<{
  theme: Theme
  /** 用户的沉浸偏好(存盘的那一个,不是"此刻这一页长什么样") */
  immersive: boolean
}>()

const emit = defineEmits<{
  (e: 'theme', v: Theme): void
  (e: 'immersive', on: boolean): void
}>()

const THEME_ITEMS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]
const CHAT_ITEMS = [
  { value: 'regular', label: 'Regular' },
  { value: 'immersive', label: 'Immersive' }
]
</script>

<template>
  <section class="k-card">
    <div class="k-card__head">
      <h3 class="k-card__title">Appearance</h3>
      <span class="k-card__note">How Kairo looks on this device. Nothing here changes your data.</span>
    </div>

    <div class="k-card__rows">
      <div class="k-row">
        <div class="k-row__label">
          <span class="k-row__name">Theme</span>
          <span class="k-row__hint">Follows your system setting until you pick one here.</span>
        </div>
        <div class="k-row__ctl">
          <RubberSegment
            :items="THEME_ITEMS"
            :model-value="theme"
            :radius="999"
            :inset="4"
            aria-label="Theme"
            @change="(v) => emit('theme', v as Theme)"
          />
        </div>
      </div>

      <div class="k-row">
        <div class="k-row__label">
          <span class="k-row__name">Chat</span>
          <span class="k-row__hint">
            Immersive hides the header and lets the conversation fill the screen. You can still
            leave it from inside Chat.
          </span>
        </div>
        <div class="k-row__ctl">
          <RubberSegment
            :items="CHAT_ITEMS"
            :model-value="immersive ? 'immersive' : 'regular'"
            :radius="999"
            :inset="4"
            aria-label="Chat layout"
            @change="(v) => emit('immersive', v === 'immersive')"
          />
        </div>
      </div>
    </div>
  </section>
</template>
