<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import InteractionPanel from './InteractionPanel.vue'
import type { Character } from '../types'

/* 相处偏好(设置页的「Getting along」分区)。

   —— 它只是"挑一个角色"+ 那一张卡 ——

   档位控件那一整块**没有在这里写第二份**:它就是 InteractionPanel
   (角色详情页上那张卡)。同一个东西在设置里再实现一遍,迟早会有一处
   改了另一处没改 —— 而这一页要的只是"换个人看"。

   所以这一区自己只管一件事:**挑人**。相处偏好是按角色存的
   (跟 A 可以爱开玩笑、跟 B 希望它正经,见 lib/prefs),设置页若不给
   挑人的地方,用户就只能回角色页一个个点开。

   —— 为什么用一排名字而不是下拉框 ——

   角色的数量是个位数,而"我现在在给谁调"是这一区最要紧的信息 ——
   一排名字能同时表达"有哪几个人"与"选中了谁";下拉框把前者藏了起来。 */

const props = defineProps<{
  characters: Character[]
}>()

const picked = ref(props.characters[0]?.id || '')

/* 角色目录变了(新建 / 删掉 / 另一标签页改了)时把选择收回来 ——
   留着一个人已经不在的 id,InteractionPanel 会照常渲染出一份"没有偏好"的
   空档位,而那一份**改不动**(saveInteractionPrefsOf 会为一个不存在的角色
   建一条记录)。不报错,所以很难被发现 */
watch(
  () => props.characters,
  (list) => {
    if (!list.some((c) => c.id === picked.value)) picked.value = list[0]?.id || ''
  }
)

const currentName = computed(() => props.characters.find((c) => c.id === picked.value)?.name || '')
</script>

<template>
  <section class="wrap">
    <!-- 一个角色都没有:这一区整块没法用。说清为什么,而不是给一排空控件 -->
    <div v-if="!characters.length" class="none">
      <p class="none-title">No characters yet</p>
      <p class="none-sub">
        These settings are per character — how one of them treats you, which can differ from
        the next. Create a character first and it will show up here.
      </p>
    </div>

    <template v-else>
      <div class="pick">
        <span class="k-eyebrow">Tuning for</span>
        <div class="pick-chips" role="radiogroup" aria-label="Character">
          <button
            v-for="c in characters"
            :key="c.id"
            type="button"
            class="chip"
            :class="{ on: c.id === picked }"
            role="radio"
            :aria-checked="c.id === picked"
            @click="picked = c.id"
          >
            {{ c.name }}
          </button>
        </div>
      </div>

      <!-- 挑中的那个人的那一张卡。它自带存取,不经过这一层 -->
      <InteractionPanel v-if="picked" :char-id="picked" />
      <p v-if="currentName" class="who">
        These apply to {{ currentName }} only. Every character keeps its own.
      </p>
    </template>
  </section>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
}

.pick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2) var(--sp-3);
}
.pick-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
/* 与 MemoryPage / HistoryPage 同一套 chip */
.chip {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-xs);
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.chip:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
.chip.on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}
.chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.who {
  margin-top: var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--text-3);
}

/* 空态 */
.none {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-7) var(--sp-4);
  border: 1px dashed var(--line);
  border-radius: var(--r);
  text-align: center;
}
.none-title {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text-2);
}
.none-sub {
  max-width: 52ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-3);
}

@media (max-width: 640px) {
  .chip {
    min-height: 40px;
  }
}
</style>
