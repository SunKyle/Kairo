<script setup lang="ts">
import { computed } from 'vue'
import { PhArrowRight, PhLockSimple, PhUsersThree } from '@phosphor-icons/vue'
import { isProfileMemory, sortMemories } from '../lib/memory'
import type { Character, MemoryItem } from '../types'

/* 记忆与隐私(设置页的「Memory & privacy」分区)。

   —— 它为什么不是记忆中心 ——

   记忆中心(PRD §5.5)是**干活的地方**:一条条看、改、删、标记、授权。
   这一区回答的是另一个问题:"这些东西存在哪、谁看得到" ——
   也就是用户来设置页时会有的那两个疑问。所以这里**不重复**那些操作,
   只把边界说清楚、把数字摆出来,再把入口指向记忆中心。

   —— 那一句边界必须写在这里 ——

   PRD §8 的已确认决策原文是"共享用户画像,**但不共享角色专属经历**"。
   这是整个记忆系统里最容易误解的一条 —— 用户看到"共享"两个字,
   很自然会以为"我把一条授权了,所有角色就都知道了";而实际上
   **跟某个角色说过的事永远只属于那个角色**,能授权的只有"关于我自己"的画像。
   这句话不写在用户看得见的地方,等于没写。 */

const props = defineProps<{
  memories: MemoryItem[]
  characters: Character[]
}>()

const emit = defineEmits<{
  (e: 'open'): void
}>()

/** 授权给所有角色的画像条目。**按 lib/memory 的判据筛**,不在这里另写一遍 ——
 *  它同时就是服务端注入时用的那条边界(selectMemories),两处必须同源 */
const shared = computed(() =>
  sortMemories(props.memories.filter((m) => isProfileMemory(m) && m.shared === true))
)

/** 还没授权出去的画像条数。**这一条必须说出来** ——
 *  没勾共享的画像谁都看不到(见 selectMemories),而"抽取会自动生成画像"
 *  这件事用户并不知道:不摆出来的话,他会以为这些事角色们早就都知道了,
 *  于是永远想不到要去记忆中心里把它们打开 */
const privateProfiles = computed(
  () => props.memories.filter((m) => isProfileMemory(m) && m.shared !== true).length
)

/** 各个角色各自留着的记忆条数。共享画像不计入任何一个角色(它不属于任何一段关系) */
const perChar = computed(() =>
  props.characters.map((c) => ({
    id: c.id,
    name: c.name,
    n: props.memories.filter((m) => !isProfileMemory(m) && m.charId === c.id).length
  }))
)

/** 没有主人的记忆条数。理论上只该是画像,但盘上可能留着手改过的脏数据 ——
 *  把它算出来而不是假装没有:那些条目谁都读不到(见 selectMemories),
 *  是个真实存在的问题,不是显示上的瑕疵 */
const orphans = computed(
  () => props.memories.filter((m) => !isProfileMemory(m) && !perChar.value.some((p) => p.id === m.charId)).length
)
</script>

<template>
  <section class="k-card k-card--stack">
    <div class="k-card__head">
      <h3 class="k-card__title">Memory &amp; privacy</h3>
      <span class="k-card__note">Where it lives, and who gets to know what.</span>
    </div>

    <!-- 第一句先答"存在哪"。它是最常被问、也最该先说清的一件事 -->
    <p class="lede">
      Everything Kairo knows is stored in this browser, on this device. There is no account
      and nothing is uploaded — clearing your browser data would take it all with it.
    </p>

    <div class="stats">
      <div class="stat">
        <span class="stat-n">{{ memories.length }}</span>
        <span class="stat-l">{{ memories.length === 1 ? 'memory kept' : 'memories kept' }}</span>
      </div>
      <div class="stat">
        <span class="stat-n">{{ shared.length }}</span>
        <span class="stat-l">shared with everyone</span>
      </div>
      <div class="stat">
        <span class="stat-n">{{ characters.length }}</span>
        <span class="stat-l">{{ characters.length === 1 ? 'character' : 'characters' }}</span>
      </div>
    </div>

    <!-- 边界那一句。分成两条写,因为它们是两件事:
         一条说"私人经历不会外流",一条说"什么才可能被共享" -->
    <div class="rules">
      <p class="rule">
        <PhLockSimple aria-hidden="true" />
        <span>
          <b>What you talk about with one character stays with them.</b>
          Their memories are never handed to another character — not even if you mark one
          important.
        </span>
      </p>
      <p class="rule">
        <PhUsersThree aria-hidden="true" />
        <span>
          <b>Only your own profile can be shared.</b>
          A memory about you — a habit, an interest, a plan — can be opened up to every
          character, and you can close it again whenever you like.
        </span>
      </p>
    </div>

    <!-- 授权出去的到底是哪几条:摆出来,而不是让用户自己去记忆中心里找 -->
    <div class="shared">
      <p class="k-eyebrow">
        Every character can know
        <span class="shared-n">{{ shared.length }}</span>
      </p>
      <ul v-if="shared.length" class="shared-list">
        <li v-for="m in shared" :key="m.id" class="shared-item">{{ m.text }}</li>
      </ul>
      <p v-else class="shared-none">
        Nothing yet. Memories you mark as shared will be listed here.
      </p>
      <!-- 还没打开的那些。它回答的是"那我是不是漏了什么" ——
           不写的话,用户看到"Nothing yet"会以为根本没有可共享的东西 -->
      <p v-if="privateProfiles" class="shared-more">
        {{ privateProfiles }}
        {{ privateProfiles === 1 ? 'memory about you is' : 'memories about you are' }}
        still private — open the Memory Center to share
        {{ privateProfiles === 1 ? 'it' : 'them' }}.
      </p>
    </div>

    <!-- 各个角色各留了多少条。它回答的是"它到底记得我多少",
         同时也是"哪个角色我聊得多"的一个侧影 -->
    <div v-if="perChar.length" class="per">
      <p class="k-eyebrow">Kept per character</p>
      <ul class="per-list">
        <li v-for="p in perChar" :key="p.id" class="per-item">
          <span class="per-name">{{ p.name }}</span>
          <span class="per-n">{{ p.n }}</span>
        </li>
      </ul>
    </div>

    <!-- 孤儿条目:谁都读不到的那些。它是盘上的脏数据,不该被悄悄藏起来 -->
    <p v-if="orphans" class="orphan">
      {{ orphans }} {{ orphans === 1 ? 'memory' : 'memories' }} no longer belong to any
      character. They are not used in chat. You can delete them in the Memory Center.
    </p>

    <button type="button" class="go" @click="emit('open')">
      Open the Memory Center
      <PhArrowRight aria-hidden="true" />
    </button>
  </section>
</template>

<style scoped>
/* 卡片外壳与 eyebrow 走全局共享类(styles/settings.css):这里只留本区特有的
   数据块 / 边界说明 / 列表 / 去记忆中心那颗按钮。 */
.lede {
  max-width: 68ch;
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--text-2);
}

/* 三个数字。等宽数字让它们竖着对齐,扫起来才像一张表 */
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-4) var(--sp-7);
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stat-n {
  font-size: var(--fs-2xl);
  line-height: 1.1;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.stat-l {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.rules {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.rule {
  display: flex;
  gap: 10px;
  max-width: 68ch;
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--text-2);
}
.rule svg {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 3px;
  color: var(--text-3);
}
.rule b {
  font-weight: 600;
  color: var(--text);
}

.shared,
.per {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line);
}
.shared-n {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--text);
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.shared-list,
.per-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.shared-item {
  font-size: var(--fs-sm);
  line-height: 1.55;
  color: var(--text);
}
.shared-none,
.orphan {
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-3);
}
/* "还有几条没打开" —— 比"什么都没有"重一档(用正文色而不是注解色),
   因为它是一个**可操作**的提示,而不是一句"空" */
.shared-more {
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-2);
}
.orphan {
  color: var(--danger);
}
.per-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.per-n {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

/* 去记忆中心。它是这一区唯一的动作,所以摆在最后、占满一行 */
.go {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  align-self: flex-start;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-sm);
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.go:hover {
  background: var(--cta-hover);
}
.go:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.go svg {
  width: 15px;
  height: 15px;
}

@media (max-width: 640px) {
  .stats {
    gap: var(--sp-3) var(--sp-5);
  }
  .go {
    align-self: stretch;
  }
}
</style>
