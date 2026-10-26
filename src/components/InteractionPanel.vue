<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  INTERACTION_DIMENSIONS,
  defaultInteractionPrefs,
  isNeutralInteraction,
  loadInteractionPrefsOf,
  saveInteractionPrefsOf,
  type PrefDimension
} from '../lib/prefs'
import type { InteractionPrefs } from '../types'

/* 相处偏好(PRD §3.2-D):用户希望**被怎么对待**。
   与同一页的 Personality 那张卡是两件不同的事 ——
   那张写的是"这个角色是谁"(角色的人格),这一张写的是
   "我希望这段相处是什么样"(用户的偏好)。所以标题刻意不叫 Personality。

   它落在角色详情页而不是全局设置里:PRD §3.2-C 说"每个角色与用户拥有
   独立的关系状态",相处方式自然也是每个角色各一份(跟 A 可以爱开玩笑、
   跟 B 希望它正经),放全局就没有地方表达这个差别。

   状态只有本组件持有:它不进任何 composable、也不进主界面的状态树 ——
   读的人只有一处(发请求那一刻按角色现读,见 useChatFlow 的 guidance),
   中间不需要任何缓存。选完立刻落盘,没有"保存"按钮:
   这一栏全是单选,没有可丢失的草稿(与向导里那些表单字段不同)。

   **必须说清它不覆盖人格**。PRD 把这条列进了反目标
   ("所有角色最后都变成同一种温柔、顺从的聊天机器人")——
   而用户看到一排"更直接 / 更幽默"的开关时,最自然的误解就是
   "我在改它是什么人"。那句说明因此写在卡头,不藏进注释。

   —— 控件为什么用淡底档位,而不是顶栏那枚分段控件 ——
   一屏五组、每组三到四档,而且标签是一句人话("Take my mind off it")。
   实心滑块的分段在这种密度下会立起一片黑,压过内容;这里"选中"本该是轻的。
   于是用 `.k-tier` 淡底档位(见 styles/settings.css),选中靠淡底 + 描边加深 +
   那颗空心圈填实三重信号。外壳(卡片 / 行 / 卡头)同样走共享类,不再各写一份。 */

const props = defineProps<{
  /** 这份偏好属于哪个角色 */
  charId: string
}>()

function read(id: string): InteractionPrefs {
  return loadInteractionPrefsOf(id) ?? defaultInteractionPrefs()
}

const current = ref<InteractionPrefs>(read(props.charId))
/* 详情页在角色之间切换时,同一份组件实例会被复用(props 变了、组件不重建),
   不跟着重读的话,会拿上一个角色的档位显示在下一个角色头上 */
watch(
  () => props.charId,
  (id) => {
    current.value = read(id)
  }
)

/** 选一档。立刻落盘 —— 下一次发言就该按新的来(见 lib/prefs 的说明) */
function choose(key: PrefDimension['key'], value: string) {
  const next = { ...current.value, [key]: value } as InteractionPrefs
  current.value = next
  /* 全部拨回"没有偏好"时,saveInteractionPrefsOf 会把这一条删掉 ——
     盘上不留一堆全是中性的空壳 */
  saveInteractionPrefsOf(props.charId, next)
}

const isSet = () => !isNeutralInteraction(current.value)
</script>

<template>
  <section class="k-card">
    <div class="k-card__head">
      <h3 class="k-card__title">How you two get along</h3>
      <span class="k-card__note">
        How it treats you in Chat. It shapes the manner, never who it is.
      </span>
    </div>

    <div class="k-card__rows">
      <div v-for="d in INTERACTION_DIMENSIONS" :key="d.key" class="k-row">
        <div class="k-row__label">
          <span class="k-row__name">{{ d.label }}</span>
          <span class="k-row__hint">{{ d.hint }}</span>
        </div>
        <!-- 一组单选。用 radiogroup 而不是一排开关:这些档位是互斥的,
             而且读屏要能念出"这一组在选什么" -->
        <div class="k-row__opts" role="radiogroup" :aria-label="d.label">
          <button
            v-for="o in d.options"
            :key="o.value"
            type="button"
            class="k-tier"
            :class="{ on: current[d.key] === o.value }"
            role="radio"
            :aria-checked="current[d.key] === o.value"
            @click="choose(d.key, o.value)"
          >
            {{ o.label }}
          </button>
        </div>
      </div>
    </div>

    <p class="pref-foot">
      {{
        isSet()
          ? 'Saved — it applies from your next message.'
          : 'Nothing set. It will talk to you however it naturally would.'
      }}
    </p>
  </section>
</template>

<style scoped>
/* 外壳与档位都走全局共享类(styles/settings.css)。这里只留两件本地事:
   ① 卡片在角色详情页里要跟前一张卡拉开一档(设置里则由外层负责间距);
   ② 卡脚那句状态说明。 */
.k-card {
  margin-top: var(--sp-4);
}
.pref-foot {
  margin-top: var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--text-3);
}
</style>
