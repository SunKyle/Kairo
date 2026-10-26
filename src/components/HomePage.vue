<script setup lang="ts">
import { computed } from 'vue'
import { PhArrowRight, PhMaskHappy, PhSparkle } from '@phosphor-icons/vue'
import { coverSrc } from '../api'
import { homeAgo, homeGrid, homeIdentity, homeSnippet, recentChats } from '../lib/homeList'
import type { Character, ChatMessage } from '../types'

/* ===== 首页(PRD §5.1 / §11.2) ==========================================
   主区「Your characters」是**视觉中心**:一墙图片优先的角色卡,名字 + 一句
   简短身份 + 一个自然的开口。次区「Continue where you left off」是辅:
   最近聊过的几个,带最后一句摘要,点了就回到那段对话。

   **这一页刻意不做的东西**(PRD §11.2 给它列了"避免项"):
   - 统计面板与消息数排行榜 —— 所以卡上不写"出过几张图",标题旁不写"聊过多少句";
   - 密集按钮 —— 卡上只有两个动作;
   - 商城式卡片 —— 卡是海报,不是商品。

   两块的顺序由 lib/homeList 定(它答的是两个不同的问题:最近造的谁 / 最近聊的谁),
   这一页只负责把它们铺出来 + 把点击报上去。真正的跳转、开向导都在主界面 ——
   与别处"子页面只发意图"同一套分工。
   -------------------------------------------------------------------- */

const props = defineProps<{
  characters: Character[]
  /** "某个角色最后一句"的取法。**传函数而不是对象**(见 lib/homeList 的说明) */
  lastOf: (id: string) => ChatMessage | undefined
}>()

const emit = defineEmits<{
  /* 拿这个角色进对话:跳对话页并选中它,由主界面负责跳转 */
  (e: 'chat', id: string): void
  /* 看这个角色的详情 */
  (e: 'detail', id: string): void
  /* 去建第一个 / 再建一个角色 */
  (e: 'create'): void
}>()

const grid = computed(() => homeGrid(props.characters))
const recent = computed(() => recentChats(props.characters, props.lastOf))

/** 卡的封面 = 主视图。生成正脸时会写回 c.ref(见 App 的 genCharView),
 *  所以读 ref 就够,不必为每张卡去加载设定图 —— 整页十几张卡都是同一个理由 */
function coverOf(c: Character): string {
  return coverSrc(c.ref)
}
</script>

<template>
  <section class="home" aria-label="Home">
    <!-- 页头:标题在左,动作在右。
         页面**有多少个角色**只写成一句副标题,不做成统计卡 ——
         那正是 PRD §11.2 "避免统计面板"的第一行 -->
    <header class="home-head">
      <div>
        <h2 class="home-title">Your characters</h2>
        <p class="home-sub">
          {{ grid.length ? `${grid.length} ${grid.length === 1 ? 'character' : 'characters'}` : 'Nothing here yet' }}
        </p>
      </div>
      <button class="home-new" @click="emit('create')">
        <PhSparkle aria-hidden="true" />
        New character
      </button>
    </header>

    <!-- 空态:一个角色都没有。**把"去建"放在最显眼的地方** ——
         新用户进站看到的就是这一屏,而这里唯一该做的事就是建第一个 -->
    <div v-if="!grid.length" class="home-empty">
      <span class="home-empty-ico" aria-hidden="true">
        <PhMaskHappy />
      </span>
      <h3 class="home-empty-title">No characters yet</h3>
      <p class="home-empty-sub">
        Describe someone you'd like to meet, or upload a reference image — Kairo fills in the
        rest and draws them for you.
      </p>
      <button class="home-new big" @click="emit('create')">
        <PhSparkle aria-hidden="true" />
        Create your first character
      </button>
    </div>

    <!-- 主区:图片优先的角色卡。**没有统计、没有 ⋮ 菜单** ——
         那是角色管理页(§11.11)那张卡的事;首页这张卡只负责"认出它、开口跟它说话"。
         整卡命中区是上面那一层(见 .hcard-main),底部两枚动作透传点击 -->
    <div v-else class="home-grid">
      <article v-for="c in grid" :key="c.id" class="hcard">
        <div class="hcard-main">
          <span class="hcard-img">
            <img v-if="coverOf(c)" :src="coverOf(c)" alt="" loading="lazy" decoding="async" />
            <span v-else class="hcard-ph" aria-hidden="true">
              <PhMaskHappy />
            </span>
          </span>
          <div class="hcard-body">
            <h3 class="hcard-name">{{ c.name }}</h3>
            <p class="hcard-id">{{ homeIdentity(c) }}</p>
          </div>
          <!-- 底部两条动作。Chat 是主,Details 是辅 ——
               首页的主动作是"开口说话",看设定是下一步才做的事 -->
          <div class="hcard-acts">
            <button class="hcard-act primary" @click="emit('chat', c.id)">Chat</button>
            <button class="hcard-act" @click="emit('detail', c.id)">Details</button>
          </div>
        </div>
      </article>
    </div>

    <!-- 次区:最近聊过的那几个。**只在真聊过时出现** ——
         一个都没有聊过的话,这一块整块不渲染(而不是显示"没有最近对话") -->
    <section v-if="recent.length" class="recent">
      <h3 class="recent-title">Continue where you left off</h3>
      <ul class="recent-list">
        <li v-for="r in recent" :key="r.char.id">
          <button class="recent-row" @click="emit('chat', r.char.id)">
            <span class="recent-av">
              <img v-if="coverOf(r.char)" :src="coverOf(r.char)" alt="" loading="lazy" decoding="async" />
              <span v-else class="recent-ph" aria-hidden="true">
                <PhMaskHappy />
              </span>
            </span>
            <span class="recent-body">
              <span class="recent-name">{{ r.char.name }}</span>
              <span class="recent-snippet">{{ homeSnippet(r.last) }}</span>
            </span>
            <span class="recent-when">{{ homeAgo(r.last.createdAt) }}</span>
            <PhArrowRight class="recent-go" aria-hidden="true" />
          </button>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
/* 页容器与左右留白都由 .shell 给(App.vue),这一页不再自己套一层 ——
   与 History / Memory / Settings 三页同一套 */
.home {
  min-width: 0;
}
.home-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  padding-top: var(--sp-2);
}
.home-title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}
.home-sub {
  margin-top: 6px;
  font-size: var(--fs-sm);
  color: var(--text-2);
}

/* —— 建角色那一枚 —— 描边款:这一页的主动作在卡上(那一颗颗 Chat),
   标题旁这一颗是"再多建一个",不该抢同一个层级 */
.home-new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 var(--sp-4);
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: none;
  font-size: var(--fs-sm);
  color: var(--text);
  cursor: pointer;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    transform var(--dur-spring) var(--spring);
}
.home-new svg {
  width: 15px;
  height: 15px;
}
.home-new:hover {
  background: var(--bg-elev);
  border-color: var(--text-3);
}
/* 按下弹回:与卡片里的 CTA 同一条手感(压下去快、松手 spring 过冲) */
.home-new:active {
  transform: scale(0.94);
  transition: transform 120ms var(--ease);
}
/* 空态里那一颗大一点:那一屏只有它一件事可做 */
.home-new.big {
  height: 44px;
  padding: 0 var(--sp-5);
  font-size: var(--fs-base);
  color: var(--cta-text);
  background: var(--cta);
  border-color: transparent;
}
.home-new.big:hover {
  background: var(--cta-hover);
}

/* —— 空态 —— */
.home-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-7);
  padding: var(--sp-7) var(--sp-5);
  border: 1px dashed var(--line-strong);
  border-radius: var(--r);
  text-align: center;
}
.home-empty-ico {
  display: flex;
  color: var(--text-4);
}
.home-empty-ico svg {
  width: 40px;
  height: 40px;
}
.home-empty-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
}
.home-empty-sub {
  max-width: 44ch;
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}

/* —— 主区那一墙卡 ——
   等宽自动排:放得下几列就几列,不再手调"一行三张"那种数
   (与详情页 .sheet 同一条理由 —— 手调的格数排法加一次格子就废一次)。
   最小宽度给到 168px:再窄一档,卡里那行身份文字就会被折成三行。
   **最大宽度封顶 232px**:这里上一档写的是 1fr,而 auto-fit 会把空列塌缩掉,
   于是仅剩的那一列会长满整行 —— 只有一个角色时正视图撑满整屏(3:4 取景下
   宽度即高度),两三个时同样过大。海报该有尺寸上限,不是商品(PRD §11.2)。
   **封顶取 232 而不是 240**:1440 桌面上内容栏 ≈ 1000px,四张 240 的卡加三道
   16px 间距正好是 4×240+3×16=1008,超了 8px —— auto-fit 于是退成三列,
   第四张单独坠到下一行,排成 3+1。232 让四列稳稳排满(4×232+3×16=976)。
   封顶后再配 justify-content: center 把这一墙居中,而不是左贴边拉满。 */
.home-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(168px, 232px));
  justify-content: center;
  gap: var(--sp-4);
  margin-top: var(--sp-5);
}

/* 角色卡:海报式取景,顶图全出血,文字贴底。
   **与角色管理页那张卡(CharacterCard)不是同一个东西** —— 那张带统计与 ⋮ 菜单,
   是管理用的;这一张只有图、名字、一句身份、两个动作,是"认出它、跟它说话"用的。
   两份各自简单,共用一个只会让两边都带上对方不需要的东西 */
.hcard {
  position: relative;
  border-radius: var(--r);
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--line);
}
.hcard-main {
  display: flex;
  flex-direction: column;
}
.hcard-img {
  position: relative;
  display: block;
  aspect-ratio: 3 / 4;
  background: var(--image-bg);
}
.hcard-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 700ms var(--ease);
}
.hcard:hover .hcard-img img {
  transform: scale(1.04);
}
/* 没有图时画一枚占位图标:那几句"这个角色还没有图"不该占正文的位置 */
.hcard-ph {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-4);
}
.hcard-ph svg {
  width: 32px;
  height: 32px;
}
.hcard-body {
  padding: var(--sp-3);
}
.hcard-name {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 那一行简短身份。夹两行 —— 一行的身份栏(见 CharacterFields.identity)本身
   就可能写到"veteran space smuggler, worn flight jacket"这么长 */
.hcard-id {
  margin: 2px 0 0;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.hcard-acts {
  display: flex;
  gap: var(--sp-2);
  padding: 0 var(--sp-3) var(--sp-3);
}
.hcard-act {
  flex: 1;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  font-size: var(--fs-xs);
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease),
    border-color var(--dur) var(--ease), transform var(--dur-spring) var(--spring);
}
/* 按下弹回:一张卡上的 Chat / Details 两颗键一起有这个手感,不厚此薄彼 */
.hcard-act:active {
  transform: scale(0.94);
  transition: transform 120ms var(--ease);
}
.hcard-act:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.hcard-act.primary {
  color: var(--cta-text);
  background: var(--cta);
  border-color: transparent;
}
.hcard-act.primary:hover {
  background: var(--cta-hover);
  color: var(--cta-text);
}

/* —— 次区 ——
   与主区之间用一条发丝线隔开,不用第二块大底色:两块仍然是"同一页的两段",
   而不是两个页面。留白也压过一档 —— 这一块是辅 */
.recent {
  margin-top: var(--sp-6);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--line);
}
.recent-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: var(--text-3);
}
.recent-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.recent-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2);
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.recent-row:hover {
  background: var(--bg-elev);
}
.recent-av {
  position: relative;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--image-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-4);
}
.recent-av img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.recent-ph svg {
  width: 18px;
  height: 18px;
}
.recent-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.recent-name {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
/* 那行摘要:一行,超长省略。**不带角色名前缀** —— 名字就在它上面,
   再说一句"Alice 说:"是把同一句话说两遍 */
.recent-snippet {
  font-size: var(--fs-xs);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-when {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-4);
  font-variant-numeric: tabular-nums;
}
.recent-go {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  color: var(--text-4);
  transition: transform var(--dur) var(--ease), color var(--dur) var(--ease);
}
.recent-row:hover .recent-go {
  color: var(--text-2);
  transform: translateX(2px);
}

/* —— 窄屏 —— */
@media (max-width: 720px) {
  /* 触控目标放到 40px:与别处同一档底线 */
  .home-new {
    min-height: 40px;
  }
  .hcard-act {
    height: 36px;
  }
  /* 时间比摘要先消失:窄屏上一行里最不重要的就是它 */
  .recent-when {
    display: none;
  }
}
@media (max-width: 640px) {
  .home-grid {
    /* 上限与桌面同一档 232px:手机上只有一个角色时,1fr 同样会把那一列拉满整屏 */
    grid-template-columns: repeat(auto-fit, minmax(132px, 232px));
    gap: var(--sp-3);
  }
}
</style>
