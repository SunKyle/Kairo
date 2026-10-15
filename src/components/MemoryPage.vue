<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  PhPlus,
  PhTrash,
  PhPencilSimple,
  PhStar,
  PhUsersThree,
  PhSparkle,
  PhArrowsClockwise
} from '@phosphor-icons/vue'
import {
  MEMORY_CATEGORIES,
  MEMORY_TEXT_MAX,
  categoryNeedsChar,
  isProfileMemory,
  memoryAudience,
  sortMemories
} from '../lib/memory'
import type { Character, MemoryCategory, MemoryItem } from '../types'

/* ===== 记忆中心(PRD §5.5) ==========================================
   这一页回答的是"它到底记得我什么",以及"我能不能改"。
   PRD 把"角色将 AI 推测当成用户明确说过的事实"列进了反目标 ——
   所以**来源与推断标识是这一页的主干**,不是附属信息:
   一眼看不出"这条是它猜的还是我说的",这一页就白做了。

   —— 与别处的关系 ——

   - 它管的是**记忆条目**(MemoryItem,一条条独立的事实),不是对话页顶部
     那张卡片(那是一整段对话的压缩纪要)。两者刻意分成两处:
     纪要随对话走、按段重写;条目跨对话留、各自独立地改/删/标记。
     合成一处会让"忘掉这条"与"重压这段"变成同一个动作;
   - 写入那一侧(增删改、标记、授权、抽取)全在 composables/useMemories.ts,
     这一页只把意图 emit 出去 —— 与 HistoryPage / ChatPage 同一套分工。
     所以这里是**受控组件**:props 进来,意图出去,自己不碰 IndexedDB。

   —— 四个筛子而不是三棵树 ——

   分类(关于你 / 你们之间 / 事件与计划)是三棵并排的树,而"标记重要"
   是横切它们的第四个视角。做成同一排 chip 而不是两级导航:
   用户找一条记忆时脑子里想的是"那条重要的"或者"关于我的",
   这两种念头是并列的,没有谁在谁里面。
   -------------------------------------------------------------------- */

const props = defineProps<{
  memories: MemoryItem[]
  /** 角色目录。三处要用:归属名、手动补充时挑人、整理时挑一段对话 */
  characters: Character[]
  /** 正在抽取的角色(见 useMemories)。同一时刻一个角色只该有一个抽取在跑 */
  extracting: ReadonlySet<string>
  /** 对话那条模型配置配没配全。没配就抽不了 —— 按钮据此给出理由而不是点了没反应 */
  canExtract: boolean
}>()

const emit = defineEmits<{
  /** 手写一条。charId 对 profile 类没有意义(它不属于任何一段关系),
   *  所以这里允许给 null,真正的收口在 useMemories.addMemory 里 */
  (e: 'add', input: { charId: string | null; category: MemoryCategory; text: string }): void
  (e: 'edit', id: string, text: string): void
  (e: 'remove', id: string): void
  (e: 'important', id: string, on: boolean): void
  (e: 'shared', id: string, on: boolean): void
  /** 手动整理:从某个角色最近那段对话里抽几条值得记的 */
  (e: 'extract', charId: string): void
}>()

/* 相对时间。只到"天"这一档就够 —— 记忆本来就是隔一阵才更新一次的。
   ChatPage 里那份是同口径的一份拷贝(那边只服务对话页顶上那张卡片),
   两处合并留给设置页 IA 那一轮统一,这里先照抄 */
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

/* —— 筛子 ——
   四个值:'all' / 三个分类 / 'important'。用一个联合而不是两个独立状态,
   因为它们互斥 —— 两个独立状态会造出"分类 A 且只看重要的"这种
   界面上根本表达不出来的组合 */
type Filter = 'all' | MemoryCategory | 'important'

const filter = ref<Filter>('all')

const sorted = computed(() => sortMemories(props.memories))

function countOf(f: Filter): number {
  if (f === 'all') return props.memories.length
  if (f === 'important') return props.memories.filter((m) => m.important).length
  return props.memories.filter((m) => m.category === f).length
}

const shown = computed(() =>
  filter.value === 'all'
    ? sorted.value
    : filter.value === 'important'
      ? sorted.value.filter((m) => m.important)
      : sorted.value.filter((m) => m.category === filter.value)
)

/** 筛子那一排。分类的标签从 lib/memory 来 —— 与"手动补充"里的下拉是同一份,
 *  两处各写一份迟早会有一处改了另一处没改 */
const chips = computed(() => [
  { key: 'all' as const, label: 'All', n: countOf('all') },
  ...MEMORY_CATEGORIES.map((c) => ({ key: c.key as Filter, label: c.label, n: countOf(c.key) })),
  { key: 'important' as const, label: 'Important', n: countOf('important') }
])

/** 当前这个筛子在解释什么。分类的说明取自 lib/memory 的 hint ——
 *  "这条以后会被用在哪儿"正是用户勾共享之前要知道的事 */
const hint = computed(() => {
  if (filter.value === 'all') {
    return 'Everything it has kept about you, newest first. Marked memories stay on top.'
  }
  if (filter.value === 'important') {
    return 'The ones you marked. They are never cleaned up automatically.'
  }
  return MEMORY_CATEGORIES.find((c) => c.key === filter.value)?.hint || ''
})

/* —— 手动补充 ——
   三个字段收在一个表单里,收起时只占一个按钮。
   分类一变就重挑归属:选了"关于你"还挂着一个角色名,是自相矛盾的 */
const adding = ref(false)
const draftText = ref('')
const draftCategory = ref<MemoryCategory>('profile')
const draftCharId = ref('')

const draftTooLong = computed(() => draftText.value.trim().length > MEMORY_TEXT_MAX)
/** "你们之间"与"事件与计划"必须挂在某个角色上;画像不要主人。
 *  规则本身在 lib/memory(写入那一侧用的是同一条),这里只负责界面表现 */
const draftNeedsChar = computed(() => categoryNeedsChar(draftCategory.value))
const canSubmit = computed(
  () =>
    !!draftText.value.trim() &&
    !draftTooLong.value &&
    (!draftNeedsChar.value || !!draftCharId.value)
)

function openAdd(category?: MemoryCategory) {
  if (category) draftCategory.value = category
  /* 挑一个默认归属:当前筛子里的那个角色优先,否则第一个角色。
     一个角色都没有时留空 —— 那时"你们之间"这一类提交不了,是应该的 */
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

/* —— 手动整理 ——
   自动抽取挂在"压完记忆"那一步后面(见 useChat 的 onSummarized),
   而用户不该只能等它。这里给一个当场可点的入口 */
const extractCharId = ref('')
const extractTarget = computed(() => extractCharId.value || props.characters[0]?.id || '')
const extractBusy = computed(() => props.extracting.has(extractTarget.value))
function runExtract() {
  if (!extractTarget.value || !props.canExtract || extractBusy.value) return
  emit('extract', extractTarget.value)
}

const nothingAtAll = computed(() => props.memories.length === 0)
</script>

<template>
  <section class="mem" aria-label="Memory">
    <header class="mem-head">
      <!-- 页面名不在这儿写第二遍:顶部横条的字标已经在说"Memory"。
           这里留的是只有这一页才有的东西 —— 记住了多少条、几条是重要的 -->
      <p class="mem-sub">
        {{ memories.length }} {{ memories.length === 1 ? 'memory' : 'memories' }}
        <template v-if="countOf('important')">
          · {{ countOf('important') }} marked
        </template>
      </p>
      <div class="mem-acts">
        <button type="button" class="mem-add" @click="openAdd()">
          <PhPlus aria-hidden="true" />
          Add a memory
        </button>
      </div>
    </header>

    <!-- 这一页存在的理由,写在最上面一行:
         它记得什么、这些从哪来、用户能拿它们怎么办。
         PRD 要求"展示来源与推断性质" —— 所以这里先把规矩说清楚,
         每一条上再各标一次 -->
    <p class="mem-note">
      This is what it has kept about you. Anything it <em>worked out</em> is marked
      <span class="tag-inline">Inferred</span> — that is a guess, not something you said.
      You can edit, delete, or mark any of it.
    </p>

    <!-- 筛子。同一排里的四个分类与"重要"是并列的视角:
         用户找一条记忆时想的是"那条重要的"或"关于我的",没有谁在谁里面 -->
    <div class="mem-tools">
      <div class="mem-chips" role="group" aria-label="Filter memories">
        <button
          v-for="c in chips"
          :key="c.key"
          type="button"
          class="chip"
          :class="{ on: filter === c.key }"
          :aria-pressed="filter === c.key"
          @click="filter = c.key"
        >
          {{ c.label }}
          <span class="chip-n">{{ c.n }}</span>
        </button>
      </div>
      <p class="mem-hint">{{ hint }}</p>
    </div>

    <!-- 手动补充。收起来时只占一个按钮 —— 常态是"看",不是"写" -->
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

    <!-- 条目。重要的排在前、其余按最近更新(lib/memory 的 sortMemories) -->
    <ul v-if="shown.length" class="mem-list">
      <li v-for="m in shown" :key="m.id" class="mi" :class="{ 'is-important': m.important }">
        <div class="mi-top">
          <!-- 来源那一枚:这是这一页最要紧的一处标识 -->
          <span class="mi-origin" :class="m.origin">
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
          <textarea
            v-model="editDraft"
            class="mi-edit"
            rows="2"
            aria-label="Edit memory"
          ></textarea>
          <p v-if="editTooLong" class="mf-warn">
            Keep it to {{ MEMORY_TEXT_MAX }} characters.
          </p>
        </template>

        <p v-if="m.note && editing !== m.id" class="mi-note">{{ m.note }}</p>
        <!-- 谁会知道这一条、以及它会被用在哪儿(lib/memory 的 memoryAudience)。
             它把"共享"那个开关的后果说在明面上 —— 不写出来的话,
             用户没法判断勾下去会发生什么 -->
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

    <!-- 空态分两种:一条都没有(讲讲它是怎么攒起来的),还是这个筛子是空的 -->
    <div v-else class="mem-none">
      <template v-if="nothingAtAll">
        <p class="none-title">Nothing remembered yet</p>
        <p class="none-sub">
          Memories build up on their own as you talk — it picks out the things worth
          keeping and leaves the small talk behind. You can also write one yourself.
        </p>
        <button type="button" class="mem-add" @click="openAdd()">
          <PhPlus aria-hidden="true" />
          Add the first one
        </button>
      </template>
      <template v-else>
        <p class="none-title">Nothing here</p>
        <p class="none-sub">No memories under this filter yet.</p>
        <button type="button" class="mem-btn" @click="filter = 'all'">Show everything</button>
      </template>
    </div>

    <!-- 手动整理。自动抽取挂在"压完记忆"那一步后面,但用户不该只能等它 ——
         一个角色都没有时整块不出现(没什么可整理的) -->
    <section v-if="characters.length" class="mem-look" aria-label="Look back over a conversation">
      <div class="look-text">
        <p class="look-title">
          <PhSparkle aria-hidden="true" />
          Look back over a conversation
        </p>
        <p class="look-sub">
          It re-reads the recent messages with one character and keeps whatever it finds
          worth remembering. Anything already here is skipped.
        </p>
        <p v-if="!canExtract" class="look-warn">
          Set up a chat model first — this uses the same one the character talks with.
        </p>
      </div>
      <div class="look-acts">
        <select v-model="extractCharId" class="mf-input" aria-label="Character to look back on">
          <option v-for="c in characters" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <button
          type="button"
          class="mem-add"
          :disabled="!canExtract || extractBusy"
          @click="runExtract"
        >
          <PhArrowsClockwise aria-hidden="true" :class="{ spin: extractBusy }" />
          {{ extractBusy ? 'Looking…' : 'Look back' }}
        </button>
      </div>
    </section>
  </section>
</template>

<style scoped>
/* 页面骨架与 HistoryPage 那套一致:头一行是"这一页有多少东西",
   下面依次是工具行、内容、空态 */
.mem-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  padding-top: var(--sp-2);
}
.mem-sub {
  font-size: var(--fs-sm);
  color: var(--text-2);
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
  margin-top: calc(var(--sp-3) * -1);
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

.mem-tools {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.mem-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.mem-hint {
  max-width: 72ch;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-3);
}

/* —— 药丸按钮 ——
   主操作(黑底)与次操作(描边)同一尺寸,分量不同。两处都用到:
   页头的"Add a memory"与条目上的那一排 */
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
.mem-btn:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
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

/* 筛选 chip,与 HistoryPage 同一套 */
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
/* 来源那两枚。**颜色不同是有意的**:推断出来的那一条必须一眼能挑出来,
   它是 PRD 反目标里那条边界的界面侧执行者 */
.mi-origin {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: var(--fs-micro);
  letter-spacing: var(--ls-wide);
  background: var(--accent-soft);
  color: var(--text);
}
.mi-origin.ai {
  background: none;
  border: 1px dashed var(--line-strong);
  color: var(--text-2);
}
.mi-star {
  display: inline-flex;
  color: var(--ai-halo);
}
.mi-star svg {
  width: 14px;
  height: 14px;
}
.mi-shared {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-micro);
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
.mem-none .mem-add,
.mem-none .mem-btn {
  margin-top: var(--sp-3);
}

/* —— 手动整理 —— */
.mem-look {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--bg-elev);
}
.look-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.look-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
.look-title svg {
  width: 15px;
  height: 15px;
  color: var(--ai-halo);
}
.look-sub {
  max-width: 56ch;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-2);
}
.look-warn {
  font-size: var(--fs-xs);
  color: var(--danger);
}
.look-acts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
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

/* 窄屏:chip 与按钮抬到 40px(站内对触屏的底线),
   输入框提到 --fs-lg —— 低于 16px 时 iOS 一聚焦就把整页放大 */
@media (max-width: 640px) {
  .chip,
  .mem-add.sm,
  .mem-btn.sm {
    min-height: 40px;
  }
  .mf-input,
  .mf-text,
  .mi-edit {
    font-size: var(--fs-lg);
  }
  .mem-look {
    flex-direction: column;
    align-items: stretch;
  }
  .look-acts {
    justify-content: space-between;
  }
  .look-acts .mf-input {
    flex: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
