<script setup lang="ts">
import { computed, ref } from 'vue'
import { PhMagnifyingGlass, PhMaskHappy, PhPushPin, PhX } from '@phosphor-icons/vue'
import type { Character, ChatMessage } from '../types'
import { coverSrc } from '../api'
/* 左栏的顺序与"某个角色最后一句"的取法:与主界面进页面时的那一挑**共用同一份**
   (见 lib/chatOrder 的说明) */
import { lastMessageLookup, orderConversations } from '../lib/chatOrder'

/* 对话左栏:搜索 + 对话目录。
 *
 *  **它有两处用处** —— 并排布局里的 aside,以及窄屏下那个"换角色"浮层。
 *  两块内容一字不差(从前是各写一遍),差别只在外层容器与滚动条那一档,
 *  所以收成一个组件、由 variant 决定那点差异。
 *
 *  这一格只做展示与本地过滤:消息从哪来、排序口径、点选之后去哪,
 *  全归对话页(与这一页其余部分同一条分工)。 */
const props = defineProps<{
  characters: Character[]
  /** 当前选中的角色 id。空 = 还没挑 */
  active: string
  /** 已取到的消息,按角色 id 缓存。只用来在本地过滤时读"最后一句" */
  messages: Record<string, ChatMessage[]>
  /* 每个角色的最后一条消息,只用来画左栏那一行摘要、并给左栏排序。
     消息按角色懒加载,没打开过的读不到 —— 少了这一份,
     它们在左栏一律显示 No messages yet 并排到最后(明明聊过,看着像没聊过) */
  lastMsg: Record<string, ChatMessage>
  /* 写在 aside 里时藏掉滚动条:列表与搜索框共用同一条内缩线,那条轨道会把
     两者错开一格。浮层里的容器自带滚动,不用藏 —— 于是它按宽屏那份排版 */
  hideScrollbar?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', charId: string): void
  /* 置顶 / 取消置顶。落在角色自己身上(Character.pinned),由主界面写盘 ——
     左栏与角色页两处都从这里出去,两个入口不该各写一套 */
  (e: 'pin', charId: string): void
}>()

/* 最近活跃在前:**置顶的永远在最前**,其余按最后一条消息的时间排,
   没聊过的排在后面(按创建时间)。注意列的是**全部**角色,不是"聊过的那些":
   只列聊过的,新角色就永远开不了头。
   规则本身在 lib/chatOrder —— 主界面进对话页替用户挑一个时问的是同一件事 */
const lastOf = lastMessageLookup(
  () => props.messages,
  () => props.lastMsg
)

const ordered = computed(() => orderConversations(props.characters, lastOf))

/* 搜索词。**只在本地过滤** —— 对话目录本来就在手上,
   没有请求、没有新状态,清空即回到原样 */
const railQuery = ref('')
/** 按"名字 或 最后一句"过滤。两句都过 trim+小写:
 *  用户不会为了搜一个人先去把首字母大写打对 */
const railList = computed(() => {
  const q = railQuery.value.trim().toLowerCase()
  if (!q) return ordered.value
  return ordered.value.filter(
    (c) => c.name.toLowerCase().includes(q) || lastLine(c).toLowerCase().includes(q)
  )
})
function clearRailQuery() {
  railQuery.value = ''
}

function avatarOf(c: Character): string {
  return coverSrc(c.ref)
}

/** 那一行右上角的时刻:最后一条消息**什么时候说的**。
 *
 *  取的是最后一条消息的 createdAt —— 与摘要那一行同源,所以"谁说的"与
 *  "什么时候说的"永远指同一条,不会一个说新、一个说旧。
 *  没有消息时返回 0,那一格就不渲染。
 *
 *  **只有"今天"才报到分钟**:更早的报日期。那一格只有 42px 宽,
 *  11px 下 "Aug 3" 刚好、"Yesterday" 就放不下了;而列表本来就是索引 ——
 *  今天精确到分有价值,上周三说了什么,看日期比看钟点有用。 */
function lastAt(c: Character): number {
  return lastOf(c.id)?.createdAt ?? 0
}
function railStamp(t: number): string {
  const d = new Date(t)
  if (d.toDateString() === new Date().toDateString()) {
    /* 24 小时制、不带 AM/PM:那一格放不下,而列表里"10:52 / 15:52"不会认错 */
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
/** <time datetime> 要的是机器可读的那一刻;给人看的那句由 railStamp 给 */
function stampOf(t: number): string {
  return new Date(t).toISOString()
}

/** 那一行摘要:最后一句说了什么 */
function lastLine(c: Character): string {
  const m = lastOf(c.id)
  if (!m) return 'No messages yet'
  const t = m.content.replace(/\s+/g, ' ').trim()
  if (!t) return m.stopped ? '…' : 'Empty message'
  return (m.role === 'user' ? 'You: ' : '') + t
}
</script>

<template>
  <!-- 搜索只过滤这一份列表(见 railList)。放在列表之上:
       它是"在这些对话里找",不是页面上另开一块。
       与历史页那一枚同款 —— 同一语义在全站用同一套视觉 -->
  <div class="rail-search">
    <PhMagnifyingGlass class="rail-search-ico" aria-hidden="true" />
    <input
      v-model="railQuery"
      class="rail-search-input"
      type="search"
      placeholder="Search conversations…"
      aria-label="Search conversations"
    />
    <button
      v-if="railQuery"
      class="rail-search-x"
      aria-label="Clear search"
      @click="clearRailQuery"
    >
      <PhX aria-hidden="true" />
    </button>
  </div>
  <!-- 搜不到时**教它怎么搜**,不是干巴巴一句"没有" -->
  <p v-if="characters.length && !railList.length" class="rail-none">
    No conversation matches that. Try a name, or a word from what they said.
  </p>
  <div v-if="characters.length" class="rail-list" :class="{ 'no-bar': hideScrollbar }">
    <!-- 一行 = 一个"选它"按钮 + 一枚图钉(两个兄弟节点)。
         **不能把图钉嵌在行按钮里**:按钮不能套按钮,那是无效 HTML,
         读屏与键盘也会跟着乱 -->
    <div
      v-for="c in railList"
      :key="c.id"
      class="rail-item"
      :class="{ on: c.id === active, pinned: c.pinned }"
    >
      <button
        class="rail-row"
        :aria-current="c.id === active ? 'true' : undefined"
        @click="emit('select', c.id)"
      >
        <span class="rail-ava">
          <img v-if="avatarOf(c)" :src="avatarOf(c)" alt="" />
          <PhMaskHappy v-else aria-hidden="true" />
        </span>
        <span class="rail-text">
          <!-- 名字与时间同一行:时间在流里,**按构造就不会压到右边那枚图钉** ——
               行的右内边距已经为图钉留出 42px,时间自然止在那条线之前 -->
          <span class="rail-top">
            <span class="rail-name">{{ c.name }}</span>
            <time v-if="lastAt(c)" class="rail-time" :datetime="stampOf(lastAt(c))">
              {{ railStamp(lastAt(c)) }}
            </time>
          </span>
          <span class="rail-last">{{ lastLine(c) }}</span>
        </span>
      </button>
      <!-- 置顶就在这一行上做:要置顶的念头多半是"在聊天列表里找不到它"
           的那一刻冒出来的,逼人先切去角色页再回来是绕路。
           置顶的那一枚常驻(它是状态),其余悬停才浮出 -->
      <button
        class="rail-pin"
        :aria-label="c.pinned ? `Unpin ${c.name}` : `Pin ${c.name}`"
        :aria-pressed="!!c.pinned"
        @click="emit('pin', c.id)"
      >
        <PhPushPin aria-hidden="true" />
      </button>
    </div>
  </div>
  <p v-else class="rail-empty">No characters yet.</p>
</template>

<style scoped>
/* ===== 左栏 =====
   外层容器(.chat-rail / .picker-box)留在对话页 —— 它决定这一格摆在哪。
   这里只管格子内部:目录行、头像、置顶、搜索。 */
.rail-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
}
/* 一行 = 选它 + 置顶。定位上下文在这一层,图钉才能贴住行右缘 */
.rail-item {
  position: relative;
}
.rail-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  /* 触控目标 ≥40px */
  min-height: 52px;
  /* **不再为图钉留右侧那一格** —— 它已经挪到头像框上了(见 .rail-pin),
     腾出来的 42px 全给名字与摘要 */
  padding: 6px 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.rail-row:hover {
  background: var(--surface-hover);
}
/* 选中态只用淡底 + 字重,不用彩色 —— 与站内克制的灰度一致 */
.rail-item.on .rail-row {
  background: var(--accent-soft);
}
/* —— 置顶 = **行底加深一档**,不再有角标 ——
 *
 *  取值是"墨 8% 混进面",不是直接取某个现成档:现有那几档在浅色下彼此只差
 *  一两级(#EFEFEA 与 #F0F0F0 几乎看不出差别),而这一档要**单独承担
 *  "这行置顶了"**,必须和悬停、常态都分得开。
 *  用 --text 而不是写死的黑:它在深色主题下会反相,于是两套主题都得到
 *  "离底再重一档"的同一种效果 —— 浅色更深、深色更亮,而两者都是"更重"。
 *  三档在两种主题下的顺序一致:常态 < 悬停 < 置顶。
 *
 *  写在 .on 之后:**又置顶又正开着**的那一行,底色按置顶走。
 *  "正开着"不会因此丢掉 —— 它还有一条 .rail-item.on .rail-name 的字重与深色 */
.rail-item.pinned .rail-row {
  background: color-mix(in oklab, var(--text) 8%, var(--surface));
}
/* 名字那一行:名字吃掉剩余宽度,时间按自身宽度靠右收口 */
.rail-top {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
/* 每行名字右侧那一刻。**在流里** —— 行的右内边距已为图钉留出 42px,
   它自然落在图钉左边,不需要绝对定位,也就没有"压到图钉"这回事。
   等宽数字:一列时间右对齐时才不会抖 */
.rail-time {
  flex: none;
  /* --text-3 而不是 --text-4:后者是**禁用**档(浅 #C5C5C5 / 深 #45454A),
     在两种主题下都只有约 1.9:1 —— 而这条时间是真信息,不是禁用态。
     与下面那行摘要同色同级(它俩本来就是同一层信息),靠字号(11 vs 12)再分主次 */
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
}
.rail-pin {
  position: absolute;
  /* 贴在**头像框右上角**,像一枚状态徽章。坐标是从行的几何推出来的,不是随手填的:
       头像 36px、行高 52px、行左内边距 8px(--sp-2)、行高内边距 6px
       → 头像占 x 8..44、y 8..44
       → 徽章 22px 且外沿出头像 3px:left = 44+3-22 = 25,top = 8-3 = 5
     改头像尺寸或行内边距时,这两个数要跟着重算 */
  left: 25px;
  top: 5px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  /* 压在头像这张图上,得有自己的底与一圈边,否则图形和脸糊在一起 */
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.rail-item:hover .rail-pin,
.rail-item:focus-within .rail-pin {
  opacity: 1;
}
/* **置顶不再有角标** —— 那件事已经由行底承担(见 .rail-item.pinned)。
   这枚图钉于是退回成**纯动作**:平时不出现,悬停(或键盘聚焦)才浮出来,
   点了就是"置顶 / 取消置顶"。
   触屏没有悬停,那边仍靠 @media (hover: none) 让它常驻一份淡的,
   否则置顶过的行就没有取消的入口了 */
.rail-pin:hover {
  background: var(--accent-soft);
  color: var(--text);
}
.rail-pin svg {
  width: 11px;
  height: 11px;
}
/* 触屏没有 hover:常驻但压暗一档,免得名单看起来很吵 */
@media (hover: none) {
  .rail-pin {
    opacity: 0.55;
  }
}
.rail-ava {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-3);
}
.rail-ava img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.rail-ava svg {
  font-size: 18px;
}
.rail-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* **撑满行内剩下的宽度** —— 少了这一条,这一栏就按内容宽度收着,
     于是名字右边那一枚时间只是"跟在名字后面",而不是贴着行右缘对齐;
     摘要那行也失去一个明确的宽度边界,省略号什么时候出现全看运气 */
  flex: 1;
  min-width: 0;
}
.rail-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-sm);
  color: var(--text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-item.on .rail-name {
  font-weight: 600;
  color: var(--text);
}
.rail-last {
  overflow: hidden;
  font-size: var(--fs-xs);
  color: var(--text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-empty {
  padding: 0 6px;
  font-size: var(--fs-sm);
  color: var(--text-3);
}

/* —— 搜索 ——
   与历史页那一枚同款(圆角胶囊 / 1px 线 / 聚焦用 box-shadow 补一圈而不切 border:
   切了里面整行会挪一下)。**同一语义在全站用同一套视觉**是这一站的纪律,
   所以这里是照抄它的取值,不是另设计一个 */
.rail-search {
  display: flex;
  align-items: center;
  gap: 8px;
  /* **不许被压缩**。它是 .chat-rail(纵向 flex)的子项,默认 flex-shrink 是 1 ——
     对话一多,列表把剩余空间吃光之后,被压的就是它:14 行时实测从 56 掉到 53。
     要滚的是 .rail-list(它自己有 overflow-y 与 min-height: 0),不是这一格。
     (浮层里那个容器不是 flex,这一条在那里不生效,也不会反过来添乱) */
  flex: none;
  /* **44**。站内控件的常规档是 40,44 是它上面那一档;也在文档
     "触控目标 ≥40px"那条硬约束之上 */
  height: 44px;
  /* **不外探**。让它和列表行共用同一条内缩线(都从外层容器的 padding 起算)——
     外探过的那一版,框几乎贴到栏的边上,两侧一点余量都没有。
     与列表行的底距给足 --sp-3,免得框和第一行粘在一起 */
  margin: 0 0 var(--sp-3);
  padding: 0 12px;
  border: 1px solid var(--line);
  /* 圆角矩形(与列表行、图标键同一档),不做胶囊:这个高度上胶囊两端各是半个圆,
     框里可用的横向空间也被啃掉一截 —— 这正是它看起来"窄"的原因之一 */
  border-radius: var(--r-sm);
  background: var(--surface);
  transition: box-shadow var(--dur) var(--ease);
}
.rail-search:focus-within {
  box-shadow: 0 0 0 1px var(--line-strong);
}
.rail-search-ico {
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--text-4);
}
.rail-search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm);
}
.rail-search-input:focus {
  outline: none;
}
/* 原生那枚清除键与右边自绘的那枚重复,藏掉 */
.rail-search-input::-webkit-search-cancel-button {
  display: none;
}
.rail-search-x {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-3);
  cursor: pointer;
}
.rail-search-x:hover {
  background: var(--accent-soft);
  color: var(--text);
}
.rail-search-x svg {
  width: 13px;
  height: 13px;
}
/* 搜不到时那一行。**教它怎么搜**,不是干巴巴一句"没有" */
.rail-none {
  margin: 0;
  padding: 14px 8px;
  color: var(--text-3);
  font-size: var(--fs-xs);
  line-height: 1.5;
}
/* 窄屏才把输入框字号提回 16px:低于这个值 iOS Safari 聚焦时会放大整页
   (站内硬约束,见 style.css 的 --fs-lg)。桌面没有这个问题。
   这一条跟着搜索框走 —— 窄屏下左栏收起,它是从"换角色"那个浮层里用的,
   也就是**手机上真的会被聚焦**,同样躲不开这条 */
@media (max-width: 860px) {
  .rail-search-input {
    font-size: var(--fs-lg);
  }
}
</style>
