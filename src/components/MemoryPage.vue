<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  PhPlus,
  PhTrash,
  PhPencilSimple,
  PhStar,
  PhUsersThree,
  PhArrowsClockwise,
  PhStack,
  PhCheck,
  PhEye,
  PhEraser
} from '@phosphor-icons/vue'
import {
  MEMORY_CATEGORIES,
  MEMORY_TEXT_MAX,
  categoryNeedsChar,
  isProfileMemory,
  memoryAudience,
  sortMemories
} from '../lib/memory'
import { CHAT_MEMORY_CHARS, coverSrc } from '../api'
import type { Character, ChatSummary, MemoryCategory, MemoryItem } from '../types'

/* ===== 记忆中心(PRD §5.5)—— 主从双栏 =================================
   这一页回答的是"它到底记得我什么",以及"我能不能改"。
   PRD 把"角色将 AI 推测当成用户明确说过的事实"列进了反目标 ——
   所以**来源与推断标识是这一页的主干**,不是附属信息:
   一眼看不出"这条是它猜的还是我说的",这一页就白做了。

   —— 为什么是"左栏挑人、右栏读内容" ——

   记忆天生按"谁看得到"分簇(PRD §3.2-F:角色专属不得跨角色共享,画像要授权才共享)。
   旧版把这层归属压平成一整列卡片、靠四个 chip 横向筛,"三棵树"在界面上其实看不见。
   现在把归属提成**左栏的导航本身**:
   - 共享画像单独成一组(About you)置顶,一眼看出"这是关于你的、全员可见";
   - 每个有记忆的角色各占一行,点它 = 只看这段关系记得什么 —— 隐私边界第一次在版式上显形;
   - All / Important 是两个横切视角,仍留在栏顶,不丢原有能力。
   右栏只铺当前这一组,注意力集中;角色多了也不塌。

   —— "回看对话"为什么挪进右栏 ——

   抽取是**对某一段关系**的动作(读的是这个角色的近况)。旧版把它做成整页底部一个
   带下拉的独立面板,和"我在看谁"是脱节的。主从双栏里左栏选中已经是"挑人",
   所以"Look back"就落在**选中角色的详情头部**,直接对那个人发起,不必再选一遍。

   —— 与对话页的关系(2026-10-17 起重划)——

   这一页是**唯一的记忆管理入口**。对话页过去顶部那张能改能忘的记忆卡已整个撤下,
   现在"查看 / 编辑 / 忘掉"都收在这儿,一处管理、一处口径 —— 两个地方各摆一套编辑,
   迟早会给出不同的说法,也会让用户不确定"到底哪儿才是正门"。

   记忆仍是**两层**,只是第一次并到同一个屋檐下、按"谁"分好组:
   - **记忆条目**(MemoryItem):一条条独立的事实,跨对话留存,各自改 / 删 / 标记 / 授权 ——
     走上面这些 emit,写回 useMemories;
   - **对话简报**(chat_summary):一整段对话压成的叙事纪要,随对话走、按段重写 ——
     只在选中某个角色时出现,落在下方那块 Briefing 里,走 editSummary / forgetSummary,
     写回 useChat。两层刻意不合成一份:一个成篇会被反复重写,一个逐条独立地改;
     合并会让"改一条事实"与"重压整段纪要"互相污染。
   - 写入那一侧(两类的所有增删改)都在 composables 里,这一页只把意图 emit 出去 ——
     与 HistoryPage / ChatPage 同一套分工。这里是**受控组件**:props 进来,意图出去,
     自己不碰 IndexedDB。简报也一样:主界面把整份 chatSummary 透传进来(summaries),
     每个角色组自己认领它那一份,编辑/忘掉只是把 charId 递回去。
     正因为如此,左栏的角色"头像"用真封面(coverSrc(ref))或首字母花名,
     而这一页从不为了显示图片去亲自读 Blob。
   -------------------------------------------------------------------- */

interface Props {
  memories: MemoryItem[]
  /** 每个角色的**对话简报**(chat_summary),按 charId 存。主界面把整份 chatSummary
   *  透传进来,选中哪个角色就认领哪一份 —— 与记忆条目平行、但落在下方 Briefing 块。
   *  给一个空对象兜底:这一页是异步 chunk,若某次挂载父级还没把 summaries 递到,
   *  简报整块不显示(降级)就够了,不该让 currentSummary 去索引 undefined 而抛错 */
  summaries?: Record<string, ChatSummary>
  /** 角色目录。三处要用:归属名、手动补充时挑人、左栏分组 */
  characters: Character[]
  /** 正在抽取的角色(见 useMemories)。同一时刻一个角色只该有一个抽取在跑 */
  extracting: ReadonlySet<string>
  /** 对话那条模型配置配没配全。没配就抽不了 —— 按钮据此给出理由而不是点了没反应 */
  canExtract: boolean
}

const props = withDefaults(defineProps<Props>(), {
  summaries: () => ({})
})

const emit = defineEmits<{
  /** 手写一条。charId 对 profile 类没有意义(它不属于任何一段关系),
   *  所以这里允许给 null,真正的收口在 useMemories.addMemory 里 */
  (e: 'add', input: { charId: string | null; category: MemoryCategory; text: string }): void
  (e: 'edit', id: string, text: string): void
  (e: 'remove', id: string): void
  (e: 'important', id: string, on: boolean): void
  (e: 'shared', id: string, on: boolean): void
  /** 回看:从某个角色最近那段对话里抽几条值得记的 */
  (e: 'extract', charId: string): void
  /** 改写某个角色的**对话简报**(chat_summary 正文)。只动正文、不动游标,
   *  否则下一轮会把已经压过的老消息重新压一遍(见 useChat.editChatSummary) */
  (e: 'editSummary', charId: string, text: string): void
  /** 忘掉某个角色的简报。消息一条不删 —— "不再记得"与"这事发生过"是两回事;
   *  游标推到最新,免得忘掉的那段下一轮又被压回来(见 useChat.forgetChatSummary) */
  (e: 'forgetSummary', charId: string): void
}>()

/* 相对时间。只到"天"这一档就够 —— 记忆本来就是隔一阵才更新一次的 */
function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/* 归属名。共享画像没有主人 —— 它属于用户,不归任何角色。
 *  这一层只管"把 id 翻成名字";名字翻出来之后说什么,归 lib/memory
 *  的 memoryAudience(那条边界得与数据层同一口径,不能在这里另写一份) */
function ownerOf(m: MemoryItem): string {
  if (m.charId === null) return ''
  return props.characters.find((c) => c.id === m.charId)?.name || ''
}

/* 首字母花名。单词取前两个字母,多词取前两词首字母。只用于左栏那枚小圆,
 *  翻不出名字(空)时给一个占位问号而不是留白 —— 空白看起来像渲染坏了 */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/** 一组里的最近更新时刻(用来给左栏的角色排序:还在聊的浮上来) */
function latest(items: MemoryItem[]): number {
  return items.reduce((n, m) => Math.max(n, m.updatedAt || 0), 0)
}

/* —— 左栏的那些分组 ——
   两个横切视角(All / Important)+ 一个共享画像组(About you)+ 每个**真有记忆**的角色。
   没有记忆的角色不进栏:摆一行"0"只会稀释导航,那点信息 All 里已经说了。
   About you 只收 profile(charId 为 null 那种);角色组只收非 profile 且挂在它名下的 ——
   与 lib/memory 的 selectMemories 是同一口径的"谁的记忆",各写一份迟早走偏 */
type GroupIcon = 'stack' | 'star' | 'users' | 'mono'
interface MemGroup {
  key: string
  label: string
  hint: string
  icon: GroupIcon
  initials: string
  /** 角色真封面(coverSrc(ref))。画像/横切组留空 → 用图标;角色没出过图 → 回退首字母 */
  cover: string
  isCharacter: boolean
  isProfile: boolean
  items: MemoryItem[]
}

const groups = computed<MemGroup[]>(() => {
  const all = sortMemories(props.memories)
  const out: MemGroup[] = [
    {
      key: 'all',
      label: 'All memories',
      hint: 'Everything it has kept about you, newest first. Marked memories stay on top.',
      icon: 'stack',
      initials: '',
      cover: '',
      isCharacter: false,
      isProfile: false,
      items: all
    }
  ]
  const marked = all.filter((m) => m.important)
  if (marked.length) {
    out.push({
      key: 'important',
      label: 'Important',
      hint: 'The ones you marked. They are never cleaned up automatically.',
      icon: 'star',
      initials: '',
      cover: '',
      isCharacter: false,
      isProfile: false,
      items: marked
    })
  }
  const profiles = all.filter(isProfileMemory)
  if (profiles.length) {
    out.push({
      key: 'profile',
      label: 'About you',
      hint: 'Things about you — interests, habits, long-term plans. Share one and every character may bring it up when it fits.',
      icon: 'users',
      initials: '',
      cover: '',
      isCharacter: false,
      isProfile: true,
      items: profiles
    })
  }
  props.characters
    .map((c) => ({ c, items: all.filter((m) => !isProfileMemory(m) && m.charId === c.id) }))
    .filter((x) => x.items.length)
    .sort((a, b) => latest(b.items) - latest(a.items))
    .forEach(({ c, items }) =>
      out.push({
        key: c.id,
        label: c.name,
        hint: `Private to ${c.name}. Other characters can't see these — they come up when you two talk.`,
        icon: 'mono',
        initials: initialsOf(c.name),
        cover: coverSrc(c.ref),
        isCharacter: true,
        isProfile: false,
        items
      })
    )
  return out
})

/* 当前选中的那一组。默认 All;选中项被删空(角色删了 / 最后一条记忆删了)时,
   上面的 watch 会把选择退回 All,免得右栏停在一个已经不存在的组 */
const selected = ref('all')
const activeGroup = computed(() => groups.value.find((g) => g.key === selected.value) || groups.value[0])
watch(groups, (gs) => {
  if (!gs.some((g) => g.key === selected.value)) selected.value = 'all'
})

/* —— 右栏内的第二根轴:按"哪种"再筛一次 ——
   All / Important / 某个角色 都可能同时躺着 character 与 event(甚至 profile)。
   这一排 chip 是对**当前这一组**的收窄,和左栏的"谁"正交 ——
   左栏管归属、chip 管种类,两个念头各有各的位置,不再挤在同一排。
   只有一组里确实混了 >1 种时才露出来:纯 profile 组(About you)没什么可筛的,
   摆一排全灰的 chip 是噪声 */
const kind = ref<'all' | MemoryCategory>('all')
const distinctKinds = computed(() => new Set(activeGroup.value.items.map((m) => m.category)))
const showKindChips = computed(() => distinctKinds.value.size > 1)
const kindChips = computed(() => [
  { key: 'all' as const, label: 'All kinds', n: activeGroup.value.items.length },
  ...MEMORY_CATEGORIES.filter((c) => distinctKinds.value.has(c.key)).map((c) => ({
    key: c.key as 'all' | MemoryCategory,
    label: c.label,
    n: activeGroup.value.items.filter((m) => m.category === c.key).length
  }))
])
const currentItems = computed(() =>
  kind.value === 'all'
    ? activeGroup.value.items
    : activeGroup.value.items.filter((m) => m.category === kind.value)
)

const totalMarked = computed(() => props.memories.filter((m) => m.important).length)

/* —— 手动补充 ——
   三个字段收在一个表单里,常态只占顶部一个按钮。
   点开时按当前选中的组兜一个默认:选中某角色 → 直接是"你们之间"挂在它名下;
   选中 About you → 直接是画像。省掉一次"挑人"的来回 */
const adding = ref(false)
const draftText = ref('')
const draftCategory = ref<MemoryCategory>('profile')
const draftCharId = ref('')

const draftTooLong = computed(() => draftText.value.trim().length > MEMORY_TEXT_MAX)
/** "你们之间"与"事件与计划"必须挂在某个角色上;画像不要主人。
 *  规则本身在 lib/memory(写入那一侧用的是同一条),这里只负责界面表现 */
const draftNeedsChar = computed(() => categoryNeedsChar(draftCategory.value))
const canSubmit = computed(
  () => !!draftText.value.trim() && !draftTooLong.value && (!draftNeedsChar.value || !!draftCharId.value)
)

function openAdd() {
  if (adding.value) {
    closeAdd()
    return
  }
  if (activeGroup.value.isCharacter) {
    draftCategory.value = 'character'
    draftCharId.value = activeGroup.value.key
  } else if (activeGroup.value.isProfile) {
    draftCategory.value = 'profile'
  }
  if (!draftCharId.value) draftCharId.value = props.characters[0]?.id || ''
  adding.value = true
}

function closeAdd() {
  adding.value = false
  draftText.value = ''
}

function submitAdd() {
  if (!canSubmit.value) return
  emit('add', {
    /* 画像不挂人:它是"关于用户"的,不属于这段关系(见 types 的 MemoryItem.charId) */
    charId: draftCategory.value === 'profile' ? null : draftCharId.value,
    category: draftCategory.value,
    text: draftText.value.trim()
  })
  closeAdd()
}

/* —— 改一条 ——
   编辑态是"这一条临时在做什么",归组件自己管;写回库里的动作交给主界面 */
const editing = ref('')
const editDraft = ref('')
const editTooLong = computed(() => editDraft.value.trim().length > MEMORY_TEXT_MAX)

function startEdit(m: MemoryItem) {
  editing.value = m.id
  editDraft.value = m.text
}
function cancelEdit() {
  editing.value = ''
  editDraft.value = ''
}
function saveEdit(m: MemoryItem) {
  const next = editDraft.value.trim()
  if (!next || editTooLong.value) return
  if (next !== m.text) emit('edit', m.id, next)
  cancelEdit()
}

/* —— 回看对话 ——
   只对"选中了某个角色"时成立:抽取的对象就是这一组那个人,不再另设下拉。
   All / Important / About you 是横切与画像视角,没有"某一段对话"可回看,所以不出现 */
const extractTarget = computed(() => (activeGroup.value.isCharacter ? activeGroup.value.key : ''))
const extractBusy = computed(() => !!extractTarget.value && props.extracting.has(extractTarget.value))
function runExtract() {
  if (!extractTarget.value || !props.canExtract || extractBusy.value) return
  emit('extract', extractTarget.value)
}

/* —— 对话简报(Briefing)——
   选中某个角色时才出现:这是"你俩这一整段对话被压成的那段纪要",
   与上面一条条的记忆条目是两层。常态是**只读优先** —— 先让人读到它记得什么,
   编辑与忘掉收在角落。太长时按行数裁切,给一个"看全"的展开,而不是一上来就铺满屏。 */
const currentSummary = computed<ChatSummary | null>(() =>
  activeGroup.value.isCharacter ? props.summaries[activeGroup.value.key] || null : null
)
const hasBriefing = computed(() => !!currentSummary.value?.text.trim())
/* 模板里直接用这两条,省掉 currentSummary! 的断言(v-if 的收窄不会传到取正文那一步) */
const briefText = computed(() => currentSummary.value?.text || '')
const briefUpdated = computed(() => currentSummary.value?.updatedAt || 0)
/* 裁切只由"要不要展开"这个念头管,写进数据里而不是模板上,免得哪天 v-for/v-if 嵌套踩了作用域的坑 */
const expanded = ref(false)
const briefOverflow = computed(() => briefText.value.length > 320)
const briefClamped = computed(() => briefOverflow.value && !expanded.value)

const briefEditing = ref(false)
const briefDraft = ref('')
const briefLen = computed(() => briefDraft.value.trim().length)
const briefTooLong = computed(() => briefLen.value > CHAT_MEMORY_CHARS)
const briefCanSave = computed(() => !!briefLen.value && !briefTooLong.value)

function startBriefEdit() {
  briefDraft.value = currentSummary.value?.text || ''
  briefEditing.value = true
  confirmForget.value = false
}
function cancelBriefEdit() {
  briefEditing.value = false
  briefDraft.value = ''
}
function saveBrief() {
  if (!briefCanSave.value) return
  const next = briefDraft.value.trim()
  const charId = activeGroup.value.key
  if (currentSummary.value && next !== currentSummary.value.text) emit('editSummary', charId, next)
  cancelBriefEdit()
}

/* 忘掉是**两步**:第一下把按钮换成"确认忘掉?",再点一下才真发出去。
   简报是整段对话的浓缩,一键就没太轻率 —— 但也不弹窗、不二次跳转,就地确认最轻。 */
const confirmForget = ref(false)
function askForget() {
  confirmForget.value = true
}
function cancelForget() {
  confirmForget.value = false
}
function doForget() {
  const charId = activeGroup.value.key
  confirmForget.value = false
  briefEditing.value = false
  briefDraft.value = ''
  emit('forgetSummary', charId)
}

/* 换组 / 换种类时把简报的编辑态、确认态、展开态一并收掉:
   指着一个已经看不见的角色的草稿最容易出现"改了却没生效"的错觉 */
watch([selected, kind], () => {
  cancelEdit()
  cancelBriefEdit()
  confirmForget.value = false
  expanded.value = false
})

const nothingAtAll = computed(() => props.memories.length === 0)
</script>

<template>
  <section class="mem" aria-label="Memory">
    <!-- 一条都还没有:先讲清它是怎么攒起来的,再给一个手写入口 -->
    <div v-if="nothingAtAll" class="mem-none">
      <h1 class="none-title">Memory</h1>
      <p class="none-sub">
        Nothing remembered yet. Memories build up on their own as you talk — it picks out the
        things worth keeping and leaves the small talk behind. Anything it <em>worked out</em> is
        marked <span class="tag-inline">Inferred</span>, so you always know what it guessed versus
        what you actually said. You can also write one yourself.
      </p>
      <button type="button" class="mem-add" @click="openAdd()">
        <PhPlus aria-hidden="true" />
        Add the first one
      </button>
    </div>

    <template v-else>
      <header class="mem-head">
        <!-- 页面名在这儿立住(h1):旧版只有横条字标说"Memory",整页零标题元素。
             头一行同时把总量与"几条被标记"说清 —— 这一页特有的东西 -->
        <div class="mem-title">
          <h1>Memory</h1>
          <p class="mem-sub">
            {{ memories.length }} {{ memories.length === 1 ? 'memory' : 'memories' }}
            <template v-if="totalMarked">· {{ totalMarked }} marked</template>
          </p>
        </div>
        <div class="mem-acts">
          <button type="button" class="mem-add" :aria-pressed="adding" @click="openAdd()">
            <PhPlus aria-hidden="true" />
            Add a memory
          </button>
        </div>
      </header>

      <p class="mem-note">
        This is what it has kept about you. Anything it <em>worked out</em> is marked
        <span class="tag-inline">Inferred</span> — that is a guess, not something you said. Pick who
        on the left; you can edit, delete, or mark any of it.
      </p>

      <div class="mem-cols">
        <!-- 左栏:谁的记忆。角色栏选本身就是"挑人",回看因此能落进右栏那一段 -->
        <aside class="mem-rail" aria-label="Memory groups">
          <button
            v-for="g in groups"
            :key="g.key"
            type="button"
            class="rail-item"
            :class="{ on: activeGroup.key === g.key }"
            :aria-pressed="activeGroup.key === g.key"
            @click="selected = g.key"
          >
            <span class="rail-av" aria-hidden="true">
              <img
                v-if="g.cover"
                class="rail-img"
                :src="g.cover"
                alt=""
                loading="lazy"
                decoding="async"
              />
              <PhStack v-else-if="g.icon === 'stack'" />
              <PhStar v-else-if="g.icon === 'star'" />
              <PhUsersThree v-else-if="g.icon === 'users'" />
              <template v-else>{{ g.initials }}</template>
            </span>
            <span class="rail-n">{{ g.label }}</span>
            <span class="rail-c">{{ g.items.length }}</span>
          </button>
        </aside>

        <!-- 右栏:当前这一组 -->
        <div class="mem-detail">
          <!-- 手动补充。点开时就在"我在看谁"下面出现,归属一眼对得上 -->
          <form v-if="adding" class="mem-form" @submit.prevent="submitAdd">
            <div class="mf-row">
              <label class="mf-field">
                <span class="mf-label">Kind</span>
                <select v-model="draftCategory" class="mf-input">
                  <option v-for="c in MEMORY_CATEGORIES" :key="c.key" :value="c.key">
                    {{ c.label }}
                  </option>
                </select>
              </label>
              <!-- 画像没有主人,所以这一格在"关于你"下整格不出现 ——
                   摆一个禁用状态在那儿只会让人问"为什么不能选" -->
              <label v-if="draftNeedsChar" class="mf-field">
                <span class="mf-label">Who it is with</span>
                <select v-model="draftCharId" class="mf-input">
                  <option v-for="c in characters" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
              </label>
            </div>
            <textarea
              v-model="draftText"
              class="mf-text"
              rows="2"
              :placeholder="
                draftCategory === 'profile'
                  ? 'Something about you — an interest, a habit, a long-term goal…'
                  : 'Something worth keeping from your conversations…'
              "
              aria-label="Memory text"
            ></textarea>
            <p v-if="draftTooLong" class="mf-warn">
              Keep it to {{ MEMORY_TEXT_MAX }} characters — a memory is a line, not a story.
            </p>
            <div class="mf-acts">
              <button type="submit" class="mem-add" :disabled="!canSubmit">Remember this</button>
              <button type="button" class="mem-btn" @click="closeAdd">Cancel</button>
            </div>
          </form>

          <div class="detail-head">
            <div class="detail-id">
              <h2>{{ activeGroup.label }}</h2>
              <p class="detail-hint">{{ activeGroup.hint }}</p>
            </div>
            <!-- 回看:落在选中角色的详情头部,对象就是这个人 -->
            <button
              v-if="activeGroup.isCharacter"
              type="button"
              class="mem-btn"
              :disabled="!canExtract || extractBusy"
              @click="runExtract"
            >
              <PhArrowsClockwise aria-hidden="true" :class="{ spin: extractBusy }" />
              {{ extractBusy ? 'Looking…' : 'Look back' }}
            </button>
          </div>
          <p v-if="activeGroup.isCharacter && !canExtract" class="look-warn">
            Set up a chat model first — this re-reads the recent messages with the same model your
            character talks with.
          </p>

          <!-- 对话简报(Briefing)。只在选中某个角色、且它确实压过一段纪要时出现。
               只读优先:先让人读到"这段对话被它记成了什么",编辑/忘掉收在角落 -->
          <section v-if="hasBriefing" class="briefing" aria-label="Conversation briefing">
            <div class="brief-head">
              <span class="brief-eyebrow">Briefing</span>
              <span class="brief-when">updated {{ ago(briefUpdated) }}</span>
            </div>

            <template v-if="!briefEditing">
              <p class="brief-text" :class="{ clamped: briefClamped }">{{ briefText }}</p>
              <button v-if="briefOverflow" type="button" class="brief-more" @click="expanded = !expanded">
                {{ expanded ? 'Show less' : 'Show the whole briefing' }}
              </button>
              <div class="brief-acts">
                <button type="button" class="mem-btn sm" @click="startBriefEdit">
                  <PhPencilSimple aria-hidden="true" />
                  Edit
                </button>
                <button v-if="!confirmForget" type="button" class="mem-btn sm danger" @click="askForget">
                  <PhEraser aria-hidden="true" />
                  Forget
                </button>
                <template v-else>
                  <span class="brief-confirm">Forget this briefing?</span>
                  <button type="button" class="mem-add sm" @click="doForget">Confirm</button>
                  <button type="button" class="mem-btn sm" @click="cancelForget">Keep it</button>
                </template>
              </div>
            </template>

            <!-- 编辑态:就地换成一只可写的框。简报比一条记忆长得多,给 6 行 -->
            <template v-else>
              <textarea
                v-model="briefDraft"
                class="brief-edit"
                rows="6"
                aria-label="Edit briefing"
              ></textarea>
              <div class="brief-meter">
                <span class="brief-count" :class="{ over: briefTooLong }">
                  {{ briefLen }} / {{ CHAT_MEMORY_CHARS }}
                </span>
                <span v-if="briefTooLong" class="brief-warn">
                  Trim it — past {{ CHAT_MEMORY_CHARS }} characters the tail won't reach
                  {{ activeGroup.label }}.
                </span>
              </div>
              <div class="brief-acts">
                <button type="button" class="mem-add sm" :disabled="!briefCanSave" @click="saveBrief">
                  Save
                </button>
                <button type="button" class="mem-btn sm" @click="cancelBriefEdit">Cancel</button>
              </div>
            </template>
          </section>

          <!-- 种类副筛:只在当前这组混了 >1 种时出现 -->
          <div v-if="showKindChips" class="mem-chips" role="group" aria-label="Filter by kind">
            <button
              v-for="c in kindChips"
              :key="c.key"
              type="button"
              class="chip"
              :class="{ on: kind === c.key }"
              :aria-pressed="kind === c.key"
              @click="kind = c.key"
            >
              {{ c.label }}
              <span class="chip-n">{{ c.n }}</span>
            </button>
          </div>

          <!-- 条目。重要的在前、其余按最近更新(左栏组内已按 sortMemories 排好) -->
          <ul v-if="currentItems.length" class="mem-list">
            <li v-for="m in currentItems" :key="m.id" class="mi" :class="{ 'is-important': m.important }">
              <div class="mi-top">
                <!-- 来源那一枚:这是这一页最要紧的一处标识。
                     做成"实心=你说的 / 描边=它猜的",再各配一个图标 + 文字 ——
                     不只靠颜色(无障碍),也不用旧版那枚 11px 虚线小标签 -->
                <span class="mi-origin" :class="m.origin">
                  <PhCheck v-if="m.origin === 'user'" aria-hidden="true" />
                  <PhEye v-else aria-hidden="true" />
                  {{ m.origin === 'user' ? 'You said this' : 'It worked this out' }}
                </span>
                <span v-if="m.important" class="mi-star" title="Marked important">
                  <PhStar weight="fill" aria-hidden="true" />
                  <span class="sr-only">Marked important</span>
                </span>
                <span v-if="isProfileMemory(m) && m.shared" class="mi-shared">
                  <PhUsersThree aria-hidden="true" />
                  Shared
                </span>
                <span class="mi-when">{{ ago(m.updatedAt) }}</span>
              </div>

              <template v-if="editing !== m.id">
                <p class="mi-text">{{ m.text }}</p>
              </template>
              <template v-else>
                <textarea v-model="editDraft" class="mi-edit" rows="2" aria-label="Edit memory"></textarea>
                <p v-if="editTooLong" class="mf-warn">
                  Keep it to {{ MEMORY_TEXT_MAX }} characters.
                </p>
              </template>

              <p v-if="m.note && editing !== m.id" class="mi-note">{{ m.note }}</p>
              <!-- 谁会知道这一条、以及它会被用在哪儿(lib/memory 的 memoryAudience)。
                   它把"共享"那个开关的后果说在明面上 -->
              <p class="mi-audience">{{ memoryAudience(m, ownerOf(m)) }}</p>

              <div class="mi-acts">
                <template v-if="editing === m.id">
                  <button
                    type="button"
                    class="mem-add sm"
                    :disabled="!editDraft.trim() || editTooLong"
                    @click="saveEdit(m)"
                  >
                    Save
                  </button>
                  <button type="button" class="mem-btn sm" @click="cancelEdit">Cancel</button>
                </template>
                <template v-else>
                  <button type="button" class="mem-btn sm" @click="startEdit(m)">
                    <PhPencilSimple aria-hidden="true" />
                    Edit
                  </button>
                  <button
                    type="button"
                    class="mem-btn sm"
                    :aria-pressed="m.important"
                    @click="emit('important', m.id, !m.important)"
                  >
                    <PhStar :weight="m.important ? 'fill' : 'regular'" aria-hidden="true" />
                    {{ m.important ? 'Unmark' : 'Important' }}
                  </button>
                  <!-- 共享授权只给共享画像。角色专属记忆永远私有,
                       给它一个开关就是在骗人(见 lib/memory 的 selectMemories) -->
                  <button
                    v-if="isProfileMemory(m)"
                    type="button"
                    class="mem-btn sm"
                    :aria-pressed="!!m.shared"
                    @click="emit('shared', m.id, !m.shared)"
                  >
                    <PhUsersThree aria-hidden="true" />
                    {{ m.shared ? 'Stop sharing' : 'Share with all' }}
                  </button>
                  <button type="button" class="mem-btn sm danger" @click="emit('remove', m.id)">
                    <PhTrash aria-hidden="true" />
                    Delete
                  </button>
                </template>
              </div>
            </li>
          </ul>

          <!-- 组里没有(通常是种类筛到空)-->
          <div v-else class="mem-none sm">
            <p class="none-title">Nothing here</p>
            <p class="none-sub">
              {{
                kind !== 'all'
                  ? `No ${MEMORY_CATEGORIES.find((c) => c.key === kind)?.label || 'such'} memories in ${activeGroup.label} yet.`
                  : activeGroup.isCharacter
                    ? `Nothing remembered about your talks with ${activeGroup.label} yet. Talk a while, or add one by hand.`
                    : 'Nothing under this view yet.'
              }}
            </p>
            <button type="button" class="mem-btn" @click="selected = 'all'; kind = 'all'">
              Show everything
            </button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* 页面骨架:头一行是页名 + 总量 + 主操作,下面一行说明,再左栏右栏 */
.mem {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.mem-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  padding-top: var(--sp-2);
}
.mem-title h1 {
  font-size: var(--fs-3xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  line-height: 1.15;
}
.mem-sub {
  margin-top: 4px;
  font-size: var(--fs-sm);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.mem-acts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2) var(--sp-3);
}

/* 说明那一行:比正文轻、比注解重,占整幅宽 */
.mem-note {
  max-width: 72ch;
  margin-top: calc(var(--sp-2) * -1);
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
.mem-note em {
  font-style: italic;
  color: var(--text);
}
/* 行内那枚"推断"标记,与条目上那枚同一套配色 */
.tag-inline {
  padding: 1px 6px;
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  color: var(--text);
  font-size: var(--fs-micro);
  letter-spacing: var(--ls-wide);
  white-space: nowrap;
}

/* —— 主从双栏 —— */
.mem-cols {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: var(--sp-6);
  align-items: start;
}

/* 左栏:分组导航。粘在顶部,滚到长列表里也认得自己在看谁 */
.mem-rail {
  position: sticky;
  top: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rail-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 0;
  background: none;
  font-family: inherit;
  font-size: var(--fs-sm);
  color: var(--text-2);
  padding: 9px 10px;
  border-radius: var(--r-sm);
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.rail-item:hover {
  background: var(--bg-elev);
  color: var(--text);
}
/* 选中 = 墨色实底(暗色主题里 accent 是近白,所以压在其上的字走 --accent-contrast,
   绝不写死 #fff —— 写死会在暗主题变成白压白) */
.rail-item.on {
  background: var(--accent);
  color: var(--accent-contrast);
}
.rail-av {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--image-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-2);
}
.rail-av svg {
  width: 14px;
  height: 14px;
}
/* 真封面铺满那枚小圆,按中心裁切。选中态的 accent 反色描边仍由外层 rail-item 负责 */
.rail-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.rail-item.on .rail-av {
  background: var(--accent-contrast);
  color: var(--accent);
}
.rail-n {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-c {
  font-size: var(--fs-xs);
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}

/* 右栏:当前一组 */
.mem-detail {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
}
.detail-head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
}
.detail-id {
  min-width: 0;
}
.detail-head h2 {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  line-height: 1.25;
}
.detail-hint {
  margin-top: 2px;
  max-width: 60ch;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-3);
}
.detail-head .mem-btn {
  margin-left: auto;
  flex: none;
}

/* —— 药丸按钮 ——
   主操作(黑底)与次操作(描边)同一尺寸,分量不同 */
.mem-add,
.mem-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 40px;
  padding: 0 16px;
  border-radius: 999px;
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}
.mem-add {
  border: 0;
  background: var(--cta);
  color: var(--cta-text);
}
.mem-add:hover:not(:disabled) {
  background: var(--cta-hover);
}
.mem-add:disabled {
  opacity: 0.5;
  cursor: default;
}
.mem-btn {
  border: 1px solid var(--line);
  background: none;
  color: var(--text);
}
.mem-btn:hover:not(:disabled) {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.mem-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.mem-btn.danger {
  color: var(--danger);
}
.mem-btn.danger:hover {
  border-color: var(--danger);
  background: none;
}
/* 条目上那一排比页级动作矮一档:它们是一张卡片自己的事 */
.mem-add.sm,
.mem-btn.sm {
  height: 32px;
  padding: 0 12px;
  font-size: var(--fs-xs);
}
.mem-add svg,
.mem-btn svg {
  width: 14px;
  height: 14px;
}

/* 种类副筛 chip,与全站同一套 */
.mem-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
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
.chip-n {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

/* —— 手动补充那张表单 —— */
.mem-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
.mf-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
}
.mf-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mf-label {
  font-size: var(--fs-micro);
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: var(--text-3);
}
.mf-input {
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--text);
  font-size: var(--fs-sm);
  font-family: inherit;
}
.mf-text,
.mi-edit {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--text);
  font-size: var(--fs-base);
  font-family: inherit;
  line-height: 1.6;
  resize: vertical;
}
.mf-text:focus,
.mi-edit:focus,
.mf-input:focus {
  outline: none;
  border-color: var(--line-strong);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.mf-acts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.mf-warn {
  font-size: var(--fs-xs);
  color: var(--danger);
}

/* —— 条目 —— */
.mem-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.mi {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
/* 标记过的那几条:左边一道墨色细条。只动这一处 ——
   整卡换底会把"重要"与"选中"混成同一件事 */
.mi.is-important {
  border-left: 3px solid var(--accent);
}
.mi-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
}
/* 来源那两枚。**形态 + 颜色 + 文字三重区分**:实心(你说的)/ 描边(它猜的),
   各带一个图标。推断那一条必须一眼挑出来 —— 它是 PRD 反目标那条边界的界面侧执行者。
   旧版是 11px 虚线小标签,太轻;提到 fs-xs(12px)+ 图标 + 600 字重 */
.mi-origin {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: var(--ls-wide);
  background: var(--accent);
  color: var(--accent-contrast);
}
.mi-origin svg {
  width: 12px;
  height: 12px;
}
.mi-origin.ai {
  background: none;
  border: 1px solid var(--line-strong);
  color: var(--text-2);
}
/* 星标改用墨色,不再占用电橙的 --ai-halo(那枚 token 只该给"加载光晕") */
.mi-star {
  display: inline-flex;
  color: var(--text);
}
.mi-star svg {
  width: 14px;
  height: 14px;
}
.mi-shared {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-xs);
  color: var(--text-2);
}
.mi-shared svg {
  width: 13px;
  height: 13px;
}
.mi-when {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.mi-text {
  font-size: var(--fs-base);
  line-height: 1.6;
  color: var(--text);
}
.mi-note {
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-3);
}
.mi-audience {
  font-size: var(--fs-xs);
  color: var(--text-2);
}
.mi-acts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

/* —— 空态 —— */
.mem-none {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-7) var(--sp-4);
  border: 1px dashed var(--line);
  border-radius: var(--r);
  text-align: center;
}
.mem-none.sm {
  padding: var(--sp-6) var(--sp-4);
}
.none-title {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text-2);
}
/* 整页空态那条说明要留成左右居中的散文,em 仍是"它猜的"那层强调 */
.none-sub {
  max-width: 56ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-3);
}
.none-sub em {
  font-style: italic;
  color: var(--text-2);
}
.mem-none .mem-add,
.mem-none .mem-btn {
  margin-top: var(--sp-3);
}

.look-warn {
  font-size: var(--fs-xs);
  color: var(--danger);
}

/* —— 对话简报(Briefing)——
   它是"这段对话被压成的纪要",与一条条事实刻意做出观感区分:
   用微微抬起的 --bg-elev 面板 + 顶部一枚 eyebrow 标签,而不是事实条那样
   的 --surface 描边卡。简报会被反复重写,是一块"活的"面板,不该长得像归档条目。 */
.briefing {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--bg-elev);
}
.brief-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}
.brief-eyebrow {
  font-size: var(--fs-micro);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: var(--text-3);
}
.brief-when {
  margin-left: auto;
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
/* 简报正文是**要读的一段话**,给到 --text-2 且留住换行(纪要常有分行)。
   只读态默认裁到四行,把长纪要"收一下"而不是铺满整屏 */
.brief-text {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.brief-text.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 展开/收起是一条安静的链接式文字,不抢简报正文的视线 */
.brief-more {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-xs);
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.brief-more:hover {
  color: var(--text);
}
.brief-acts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
}
.brief-confirm {
  font-size: var(--fs-xs);
  color: var(--text-2);
}
/* 编辑态那只框与其它 textarea 同一套,只是更高一点(纪要比一条记忆长得多) */
.brief-edit {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--text);
  font-size: var(--fs-base);
  font-family: inherit;
  line-height: 1.6;
  resize: vertical;
}
.brief-edit:focus {
  outline: none;
  border-color: var(--line-strong);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
/* 水位:数字右贴、超长那句左占。超过 CHAT_MEMORY_CHARS 时整行转红 ——
   超出部分到不了模型(server 注入那一路会切),先在这儿拦住,别让它静默掉尾 */
.brief-meter {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: var(--fs-xs);
}
.brief-count {
  margin-left: auto;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.brief-count.over {
  color: var(--danger);
  font-weight: 600;
}
.brief-warn {
  color: var(--danger);
}

/* 抽取在跑时那枚箭头转起来。它要打一次模型,快不了 ——
   不给这个信号的话,界面在那几秒里毫无反应 */
.spin {
  animation: mem-spin 1s linear infinite;
}
@keyframes mem-spin {
  to {
    transform: rotate(360deg);
  }
}
/* 只给读屏用的一行字(星标那枚图标本身没有文字) */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* 窄屏:左右栏收成一段 —— 左栏抬到顶上变成横向 chip,
   触屏下动作保持常驻(不吃 hover) */
@media (max-width: 760px) {
  .mem-cols {
    grid-template-columns: 1fr;
    gap: var(--sp-4);
  }
  .mem-rail {
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
  }
  .rail-item {
    width: auto;
    border: 1px solid var(--line);
  }
  .rail-item.on {
    border-color: var(--accent);
  }
}

/* 更窄:chip 与按钮抬到 40px(站内对触屏的底线),
   输入框提到 --fs-lg —— 低于 16px 时 iOS 一聚焦就把整页放大 */
@media (max-width: 640px) {
  .chip,
  .mem-add.sm,
  .mem-btn.sm {
    min-height: 40px;
  }
  .mf-input,
  .mf-text,
  .mi-edit,
  .brief-edit {
    font-size: var(--fs-lg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
