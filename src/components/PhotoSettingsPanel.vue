<script setup lang="ts">
import { ref } from 'vue'
import type { PhotoFrequency } from '../lib/prefs'
import {
  savePhotoDirector,
  savePhotoFrequency,
  savedPhotoDirector,
  savedPhotoFrequency
} from '../lib/prefs'
import RubberSegment from './RubberSegment.vue'

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
   (2026-10-03 的产品决定,见 doc/角色出图.md §4.1.2)。

   两行都是平级、短选项 —— 用全站那枚 <RubberSegment> 分段控件;外壳
   (卡片 / 行 / 卡头)走设置页共享类 `.k-*`(见 styles/settings.css)。 */

const FREQUENCIES: { value: PhotoFrequency; label: string }[] = [
  { value: 'rare', label: 'Rarely' },
  { value: 'normal', label: 'Sometimes' },
  { value: 'often', label: 'Often' }
]

const DIRECTOR_ITEMS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
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
  <section class="k-card">
    <div class="k-card__head">
      <h3 class="k-card__title">Pictures in Chat</h3>
      <span class="k-card__note">
        Applies to every character on this device. Both rows only matter once an Image generation
        model is set up in AI connections.
      </span>
    </div>

    <div class="k-card__rows">
      <div class="k-row">
        <div class="k-row__label">
          <span class="k-row__name">How often they send pictures</span>
          <span class="k-row__hint">
            A lean in the prompt, not a quota — they still decide when a picture is the point of
            the message.
          </span>
        </div>
        <div class="k-row__ctl">
          <RubberSegment
            :items="FREQUENCIES"
            :model-value="frequency"
            :radius="999"
            :inset="4"
            aria-label="How often they send pictures"
            @change="(v) => pickFrequency(v as PhotoFrequency)"
          />
        </div>
      </div>

      <div class="k-row">
        <div class="k-row__label">
          <span class="k-row__name">Photography director</span>
          <span class="k-row__hint">
            One quick text pass per picture, to set framing, light and lens. Off draws the scene
            exactly as the character wrote it.
          </span>
        </div>
        <div class="k-row__ctl">
          <RubberSegment
            :items="DIRECTOR_ITEMS"
            :model-value="director ? 'on' : 'off'"
            :radius="999"
            :inset="4"
            aria-label="Photography director"
            @change="(v) => pickDirector(v === 'on')"
          />
        </div>
      </div>
    </div>
  </section>
</template>
