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
   "我在改它是什么人"。那句说明因此写在卡头,不藏进注释。 */

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
  <section class="panel">
    <div class="panel-head">
      <h3 class="panel-title">How you two get along</h3>
      <span class="panel-note">
        How it treats you in Chat. It shapes the manner, never who it is.
      </span>
    </div>

    <div class="prefs">
      <div v-for="d in INTERACTION_DIMENSIONS" :key="d.key" class="pref">
        <div class="pref-label">
          <span class="pref-name">{{ d.label }}</span>
          <span class="pref-hint">{{ d.hint }}</span>
        </div>
        <!-- 一组单选。用 radiogroup 而不是一排开关:这些档位是互斥的,
             而且读屏要能念出"这一组在选什么" -->
        <div class="pref-opts" role="radiogroup" :aria-label="d.label">
          <button
            v-for="o in d.options"
            :key="o.value"
            type="button"
            class="pref-opt"
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
/* 与 CharacterPage 的 .panel 同一套:同色面上的同一种卡(见那边的说明)。
   这里复制一份而不是共享,是因为那个类是 scoped 的 —— 改这里的值时
   要顺手看一眼那边,别让两处慢慢分叉 */
.panel {
  margin-top: var(--sp-4);
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

/* 每一维一行:左边是名字与说明,右边是档位。
   窄屏落到上下两段(见下面的断点)—— 三档按钮挤在半行里会换行成两行,
   反而比"标题一行、按钮一行"更难扫 */
.prefs {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.pref {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}
.pref-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.pref-name {
  font-size: var(--fs-sm);
  color: var(--text);
}
.pref-hint {
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}
.pref-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}
/* 档位按钮:选中用**淡底 + 墨色字**,不用实心墨底。
   一屏五组、每组三档,全用实心的话一页会立起五块黑 ——
   而"选中"这个语义在这一页本来就该轻(它是相处方式的微调,不是主操作) */
.pref-opt {
  padding: 6px 10px;
  font-size: var(--fs-xs);
  font-family: inherit;
  line-height: 1.2;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.pref-opt:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.pref-opt.on {
  background: var(--accent-soft);
  border-color: var(--line-strong);
  color: var(--text);
}
/* 全站一致的键盘兜底描边(见 PRODUCT.md 的无障碍要求) */
.pref-opt:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.pref-foot {
  margin-top: var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--text-3);
}

@media (max-width: 720px) {
  .pref {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-2);
  }
  .pref-opts {
    justify-content: flex-start;
  }
}
</style>
