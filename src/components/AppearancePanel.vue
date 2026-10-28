<script setup lang="ts">
import { computed } from 'vue'
import type { Theme } from '../lib/theme'
import { t, type Locale } from '../lib/i18n'
import RubberSegment from './RubberSegment.vue'

/* 外观(设置页的「Appearance」分区)。
   三项,而且都是**这台设备上这个人怎么看界面**的偏好 ——
   它们与"数据长什么样"无关,所以放在用户向设置的第一位。

   —— 与顶栏那枚主题按钮的关系 ——

   两处都能切主题,而且**都读写同一个状态**(主界面的 theme,见 App.vue)——
   不存在两份真相。顶栏那枚是随手一按,这一页是"我来看设置"时能找到它。
   沉浸模式同理:对话页顶上有一枚,这里也有。语言只有这一个入口(顶栏没有语言按钮),
   但它与主题同源:都收在 lib/i18n / lib/theme 那一份状态上,App 只做转手。

   —— 为什么用分段控件而不是开关 ——

   开关只能表达"开/关",而主题是"亮/暗"两个平级的名字 ——
   一个写着"Dark mode"的开关在关闭时读起来像"黑暗模式被关掉了",
   而它其实可能本来就是亮的。分段控件把两个名字都摆出来,没有这种歧义;
   沉浸那项反过来本是开/关,但同一页几行控件形状不同会显乱,于是同样用分段。

   —— 语言那行为什么写 "English / 中文" 而不是跟着界面翻译 ——

   语言名一律用**它自己的语言**写(English 永远写 English、中文永远写中文),
   这是切换器领域的通行做法:一个还没看懂当前界面语言的人,最需要认得的是
   "哪一种是我母语"。所以 appearance.english / appearance.chinese 两份包里同值。

   控件本体复用全站那枚 <RubberSegment>(顶栏导航也是它):滑块带弹性动效、
   键盘方向键可选、reduced-motion 自动收。外壳(卡片 / 行 / 卡头)走设置页
   共享类 `.k-*`(见 styles/settings.css),这里不再各写一份 scoped。 */

defineProps<{
  theme: Theme
  /** 用户的沉浸偏好(存盘的那一个,不是"此刻这一页长什么样") */
  immersive: boolean
  /** 当前界面语言(存盘的那一个,见 lib/i18n 的 locale) */
  locale: Locale
}>()

const emit = defineEmits<{
  (e: 'theme', v: Theme): void
  (e: 'immersive', on: boolean): void
  (e: 'locale', v: Locale): void
}>()

/* 三份分段条目都用 computed:标签按当前语言取,切了语言这一页跟着重渲染。
   label 只喂 RubberSegment 的 aria-label / 悬停提示。 */
const THEME_ITEMS = computed(() => [
  { value: 'light', label: t('appearance.light') },
  { value: 'dark', label: t('appearance.dark') }
])
const CHAT_ITEMS = computed(() => [
  { value: 'regular', label: t('appearance.regular') },
  { value: 'immersive', label: t('appearance.immersive') }
])
const LANGUAGE_ITEMS = computed(() => [
  { value: 'en', label: t('appearance.english') },
  { value: 'zh', label: t('appearance.chinese') }
])
</script>

<template>
  <section class="k-card">
    <div class="k-card__head">
      <h3 class="k-card__title">{{ t('appearance.title') }}</h3>
      <span class="k-card__note">{{ t('appearance.note') }}</span>
    </div>

    <div class="k-card__rows">
      <div class="k-row">
        <div class="k-row__label">
          <span class="k-row__name">{{ t('appearance.theme') }}</span>
          <span class="k-row__hint">{{ t('appearance.themeHint') }}</span>
        </div>
        <div class="k-row__ctl">
          <RubberSegment
            :items="THEME_ITEMS"
            :model-value="theme"
            :radius="999"
            :inset="4"
            :aria-label="t('appearance.theme')"
            @change="(v) => emit('theme', v as Theme)"
          />
        </div>
      </div>

      <div class="k-row">
        <div class="k-row__label">
          <span class="k-row__name">{{ t('appearance.chat') }}</span>
          <span class="k-row__hint">{{ t('appearance.chatHint') }}</span>
        </div>
        <div class="k-row__ctl">
          <RubberSegment
            :items="CHAT_ITEMS"
            :model-value="immersive ? 'immersive' : 'regular'"
            :radius="999"
            :inset="4"
            :aria-label="t('appearance.chatAria')"
            @change="(v) => emit('immersive', v === 'immersive')"
          />
        </div>
      </div>

      <div class="k-row">
        <div class="k-row__label">
          <span class="k-row__name">{{ t('appearance.language') }}</span>
          <span class="k-row__hint">{{ t('appearance.languageHint') }}</span>
        </div>
        <div class="k-row__ctl">
          <RubberSegment
            :items="LANGUAGE_ITEMS"
            :model-value="locale"
            :radius="999"
            :inset="4"
            :aria-label="t('appearance.language')"
            @change="(v) => emit('locale', v as Locale)"
          />
        </div>
      </div>
    </div>
  </section>
</template>
