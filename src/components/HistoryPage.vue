<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  PhHeart,
  PhTrash,
  PhClockCounterClockwise,
  PhDownloadSimple,
  PhCheckCircle,
  PhCircle,
  PhMagnifyingGlass,
  PhStack,
  PhPlus,
  PhX
} from '@phosphor-icons/vue'
import { exportImages, imageSrc, thumbSrc, downloadImageUrl } from '../api'
/* "叫什么、读哪一句、从哪来"的唯一口径。对话里生成的那两张图没有它,
   就只能拿一整段摄影提示词当标题(见 lib/chatWork) */
import { chatWorkLabel, workText, workTitle } from '../lib/chatWork'
import { matchesHistoryQuery, normalizeQuery, type HistorySearchNames } from '../lib/historySearch'
import type { Collection, HistoryEntry, ResultItem } from '../types'

/** 读屏念出来的名字用短标题:整段提示词可能有上百字,念完没人记得住,
 *  也与图砖角标、提示词库卡片的口径对不上(那份口径见 lib/chatWork) */
function titleOf(entry: HistoryEntry) {
  return workTitle(entry)
}

/* 历史记录:独立页面。
   展示沿用首页「Recent creations」图墙的做法 —— 一条记录里的多张图摊平成一块块图,
   每块按自己的出图比例定尺寸,默认只露图,提示词与参数悬停时才浮出来。
   这和首页图墙是同一套词汇,两处不必再学两种看图的习惯。 */

type Tile = { key: string; entry: HistoryEntry; index: number; item: ResultItem }

const props = defineProps<{
  items: HistoryEntry[]
  collections: Collection[]
  /* 角色 id → 名字。历史记录里存的是 id,而搜索要按"跟谁那张"找 ——
     反查表由主界面给(它手上才有角色目录),这一页不碰那份数据 */
  charNames: Record<string, string>
}>()

const emit = defineEmits<{
  /* index 是"这一条记录里的第几张"。图块是按张摊平的,所以点第 3 张
     就该看到第 3 张 —— 少了它,预览永远从第一张开始 */
  (e: 'open', entry: HistoryEntry, index: number): void
  (e: 'remove', entry: HistoryEntry): void
  (e: 'mark', entry: HistoryEntry, index: number): void
  (e: 'create-collection', title: string): void
  (e: 'delete-collection', id: string): void
}>()

// 摊平:一条记录三张图就是三块,每块都能点开预览,标记也各标各的
const tiles = computed<Tile[]>(() =>
  props.items.flatMap((entry) =>
    entry.results.map((item, index) => ({ key: `${entry.id}-${index}`, entry, index, item }))
  )
)
const imageCount = computed(() => tiles.value.length)

/* ===== 搜索 =====
   三处匹配:提示词正文、角色名、作品集名(见 lib/historySearch)。
   只搜"画的是什么、跟谁、归在哪个集"—— 尺寸与模型是"怎么生成的",
   不是用户找图时脑子里的抓手;按图搜图要把每张图喂给视觉模型,
   成本与延迟都不是搜索该有的。

   搜索与筛选是**两件事**,叠在一起用:搜索回答"哪张",筛子回答
   "只看收藏的 / 只看这个集"。所以先搜后筛,两块区域(图墙与图片条)
   用的是同一份结果 —— 两处数量对不上会让人以为漏了。 */
const query = ref('')
const searching = computed(() => !!normalizeQuery(query.value))
const searchNames = computed<HistorySearchNames>(() => ({
  charNames: props.charNames,
  collTitles: Object.fromEntries(props.collections.map((c) => [c.id, c.title]))
}))
const clearSearch = () => {
  query.value = ''
}

// 筛选的是图块,所以数量按张算而不是按条算
const onlyMarked = ref(false)
const markedCount = computed(() => tiles.value.filter((t) => t.item.marked).length)
// 作品集筛选:'' = 不在任意作品集?不 —— '' 表示「不筛」,看全量。
// 选中某集时只留归属它的记录;选中后想重回全量,再点一次该集即可
const activeColl = ref('')
const shownTiles = computed(() =>
  tiles.value.filter(
    (t) =>
      matchesHistoryQuery(t.entry, query.value, searchNames.value) &&
      (!onlyMarked.value || t.item.marked) &&
      (!activeColl.value || t.entry.collectionId === activeColl.value)
  )
)
// 命中多少条记录(与命中多少张图分开报:用户找的是"那张图",但记录是它的来处)
const shownRecords = computed(() => new Set(shownTiles.value.map((t) => t.entry.id)).size)
// 有没有一个筛子在起作用,决定空态文案与「查看全部」的去向
const filterActive = computed(() => onlyMarked.value || !!activeColl.value || searching.value)

/* —— 图片条 ——
   搜索结果里"命中的图"单独排一块。它**不是图墙的缩略复制**,两边答的不是
   同一件事:图墙是浏览(悬停才出提示词与参数、动作按记录),这一条是
   "就是这张"(一张一块、动作常驻、标着它从哪条记录来)。

   只在搜索时出现:没有关键词时图墙本来就把全部图铺在那儿了,
   再来一条一模一样的只会让人以为页面重了。
   条数封顶:横向滚动能放很多,但没必要为一次搜索挂上几千个节点 ——
   两者会同时挂在页面上(图墙也在),所以这一条给得比图墙的首批少一档。 */
const IMG_STRIP_MAX = 36
const stripTiles = computed(() => shownTiles.value.slice(0, IMG_STRIP_MAX))
const stripHidden = computed(() => Math.max(0, shownTiles.value.length - stripTiles.value.length))

/** 图片条里的一张:存这一张。走共享实现(见 api.ts 的 downloadImageUrl)——
 *  扩展名判据与预览卡、批量导出是同一份 */
function saveTile(t: Tile) {
  downloadImageUrl(imageSrc(t.item), t.item)
}

/* —— 分段渲染 ——
   记录是摊平成图砖的,500 条 × 2 张就是 1012 块、两万五千多个节点(实测),
   而屏幕上一次只看得到十几块。所以先渲染一批,滚到近底部再补一批。

   **选择与导出仍然走完整的 shownTiles / tiles**(见 toggleAll / downloadSelected)——
   若跟着渲染窗口算,"全选"与"Download all"会静默漏掉还没渲染的那些,
   而这种漏是看不出来的:计数显示 500,实际只带走 120。 */
const WALL_PAGE = 120
const wallShown = ref(WALL_PAGE)
const visibleTiles = computed(() => shownTiles.value.slice(0, wallShown.value))
const wallRemaining = computed(() => Math.max(0, shownTiles.value.length - visibleTiles.value.length))
function showMore() {
  wallShown.value += WALL_PAGE
}
/* 换了筛子或关键词要把窗口收回去:否则从「Marked」切回「全部」时,
   窗口还停在上一批的位置,看起来像"全部都在这儿了" */
watch([onlyMarked, activeColl, query], () => {
  wallShown.value = WALL_PAGE
})

/* 滚到底部附近自动补一批。用 IntersectionObserver 而不是监听 scroll:
   后者每次滚动都要读一次布局,而这里只需要知道"哨兵露头了没有"。
   哨兵与按钮都在 DOM 里(见模板)—— 不做纯无限滚动:
   键盘用户没有任何"滚到底"的动作,没有按钮就永远看不到后面的图 */
const wallMoreEl = ref<HTMLElement | null>(null)
let wallObserver: IntersectionObserver | null = null
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined' || !wallMoreEl.value) return
  wallObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) showMore()
    },
    // 提前一屏开始补,滚到底时下一批已经在了
    { rootMargin: '600px 0px' }
  )
  wallObserver.observe(wallMoreEl.value)
})
onBeforeUnmount(() => wallObserver?.disconnect())

// 作品集的新建:一排胶囊后跟一个「+」,点开变成行内小输入框,回车即建
const adding = ref(false)
const newTitle = ref('')
function submitNew() {
  const t = newTitle.value.trim()
  if (!t) return
  emit('create-collection', t)
  newTitle.value = ''
  adding.value = false
}
function activeCollTitle() {
  const c = props.collections.find((c) => c.id === activeColl.value)
  return c?.title ?? ''
}
function clearFilter() {
  /* 空态那枚按钮按"最可能挡住结果的那一个"来:正在搜就先把关键词清掉
     (搜窄了是更常见的原因),没搜才去动筛子 */
  if (searching.value) {
    clearSearch()
    return
  }
  onlyMarked.value = false
  activeColl.value = ''
}
// 正在筛的那个集被删掉了,就回落回全量 —— 不然筛着一个不存在的集,页面卡在空态
/* 两个来源分开列:写成 () => [a, b] 也能跑,但每次求值都返回一个新数组,
   读起来像在依赖"这个数组",而它其实什么都不是 */
watch([() => props.collections, activeColl], () => {
  if (activeColl.value && !props.collections.some((c) => c.id === activeColl.value)) {
    activeColl.value = ''
  }
})

/* —— 多选下载 ——
   下载不写死"已标记的那些":标记是一份长期收藏,而"这次要带走哪几张"
   往往只是一次性的挑选。所以走一次显式的多选 —— 进来选,选完下载,退出即清空。
   选择按图块记(与 tiles 同粒度),所以一条记录里可以只挑一张 */
const selecting = ref(false)
const selected = ref(new Set<string>())
const selectedCount = computed(() => selected.value.size)

function toggleSelect(t: Tile) {
  const s = selected.value
  if (s.has(t.key)) s.delete(t.key)
  else s.add(t.key)
}
function startSelect() {
  selecting.value = true
  selected.value = new Set()
}
function endSelect() {
  selecting.value = false
  selected.value = new Set()
}
/* 进入选择后,整块图砖就是勾选框 —— 不再开预览,这里统一出口 */
function onTileClick(t: Tile) {
  if (selecting.value) toggleSelect(t)
  else emit('open', t.entry, t.index)
}
/* 「全选」作用于当前筛出来的那些:切到 Marked 再全选,正好就是标记过的那批 */
const allShownSelected = computed(
  () => shownTiles.value.length > 0 && shownTiles.value.every((t) => selected.value.has(t.key))
)
function toggleAll() {
  const next = new Set(selected.value)
  if (allShownSelected.value) shownTiles.value.forEach((t) => next.delete(t.key))
  else shownTiles.value.forEach((t) => next.add(t.key))
  selected.value = next
}
/* 图块消失(记录被删、或被存储清理淘汰)时把对应的键一并摘掉。
   不摘的话:计数会虚高 —— 显示 Download 3,实际只有 1 张可导;
   而"全选"是把旧集合复制一份再增删,悬挂的键会被一直复制下去,再也清不掉。
   这里只数还存在的键,所以 selectedCount 直接取集合大小是准的 */
watch(tiles, (list) => {
  const alive = new Set(list.map((t) => t.key))
  const next = [...selected.value].filter((k) => alive.has(k))
  if (next.length !== selected.value.size) selected.value = new Set(next)
})

const exporting = ref(false)
const exportDone = ref(0)
const exportTotal = ref(0)
const exportMsg = ref('')
const exportErr = ref('')
let msgTimer: number | undefined

/** 打包进度放在按钮左边的状态位里,按钮文案保持不变 ——
    否则逐张读字节时按钮会一直改宽度,右缘固定也照样晃 */
const exportProgress = computed(() =>
  exporting.value && exportTotal.value ? `Packing ${exportDone.value} of ${exportTotal.value}…` : ''
)

async function downloadSelected() {
  if (exporting.value || !selectedCount.value) return
  /* 按 tiles 的顺序取,而不是按点击顺序:导出结果与图墙从左到右的排布一致,
     回头核对时不用在两张表之间找对应 */
  const picks = tiles.value
    .filter((t) => selected.value.has(t.key))
    /* 文件名用"画的是什么"那句(对话里生成的图读的是场景,见 lib/chatWork)——
       拆包出来是一堆摄影指令当文件名,回头谁也认不出哪张是哪张 */
    .map((t) => ({ prompt: workText(t.entry), item: t.item }))

  exporting.value = true
  exportMsg.value = ''
  exportErr.value = ''
  exportDone.value = 0
  exportTotal.value = picks.length
  try {
    const out = await exportImages(picks, (done, total) => {
      exportDone.value = done
      exportTotal.value = total
    })
    const total = out.exported + out.skipped
    if (!out.exported) {
      // 全是远端 URL 且都被跨域拦下时会走到这里:如实报错,不要静默什么都不发生
      exportErr.value = `Couldn't read any of the ${total} ${total === 1 ? 'image' : 'images'}`
    } else if (out.skipped) {
      /* 少了几张必须说出来:不然用户以为"导出了 10 张",实际只拿到 8 张。
         这一趟没交付完整,所以留在选择态里,让他能就着原选择重试 */
      exportMsg.value = `Exported ${out.exported} of ${total} — ${out.skipped} couldn't be read`
    } else {
      exportMsg.value = `Exported ${out.exported} ${out.exported === 1 ? 'image' : 'images'}`
      // 整套都拿到手了,选择态就没有留着的理由,自动收起
      endSelect()
    }
  } catch (e) {
    exportErr.value = e instanceof Error ? e.message : 'Export failed'
  } finally {
    exporting.value = false
    // 这条状态回答的是"刚刚发生了什么",过一会儿就该让位,不该一直挂着
    window.clearTimeout(msgTimer)
    msgTimer = window.setTimeout(() => {
      exportMsg.value = ''
      exportErr.value = ''
    }, 6000)
  }
}

/* 选择态是个模式,Esc 是最自然的出口。预览的 Esc 只在它自己可见时生效,
   而选择态下根本开不了预览,两者不会撞 */
function onKey(e: KeyboardEvent) {
  if (selecting.value && e.key === 'Escape') endSelect()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.clearTimeout(msgTimer)
})

/** 缩略块的比例夹取。上下各 2 / 0.5:极端长条(全景图、长截图)按原比例排会把
 *  整面墙撑得高低不齐,夹到 2:1 之后仍然看得出是宽幅 */
function clampRatio(n: number) {
  return Math.min(2, Math.max(0.5, n))
}

/** 记录的尺寸解析成宽高比;'auto' 之类解析不出来时返回 null */
function ratioOfSize(size: string): number | null {
  const [w, h] = size.split('x').map(Number)
  if (!w || !h) return null
  return clampRatio(w / h)
}

/* 缩略块按图片真实比例排,而不是按当初选的尺寸 —— 上游可能返回不同比例的图。
   优先级:加载时量到的真实比例 → 入库时量到的 w/h → 解析 entry.size → 方形兜底。
   尺寸解析不出来时先按方形占位,免得图还没到、高度算成 0、整墙塌一下再撑开 */
const measured = ref<Record<string, number>>({})
function tileRatio(t: Tile) {
  const m = measured.value[t.key]
  if (m) return m
  const { w, h } = t.entry
  if (w && h) return clampRatio(w / h)
  return ratioOfSize(t.entry.size) ?? 1
}
function onTileLoad(t: Tile, e: Event) {
  // 已经有精确比例(量过,或入库记了 w/h)就不再重复量
  if (measured.value[t.key] || (t.entry.w && t.entry.h)) return
  const img = e.target as HTMLImageElement
  if (!img.naturalWidth || !img.naturalHeight) return
  measured.value[t.key] = clampRatio(img.naturalWidth / img.naturalHeight)
}

/* 记录被删掉、或被存储清理淘汰之后,它量出来的比例就没用了 ——
   键只增不减会一直挂在内存里(一张图一个数字,长期使用是笔小账) */
watch(tiles, (list) => {
  const alive = new Set(list.map((t) => t.key))
  const next: Record<string, number> = {}
  let dropped = false
  for (const k of Object.keys(measured.value)) {
    if (alive.has(k)) next[k] = measured.value[k]
    else dropped = true
  }
  if (dropped) measured.value = next
})

/* 低清底图:先把入库时存的缩略图铺上,原图到了再盖住。
   这样整墙不会先是一片色块、再一起跳出来 */
function tileBg(entry: HistoryEntry) {
  return entry.thumb ? { backgroundImage: `url(${thumbSrc(entry)})` } : undefined
}

function fmt(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <section class="lib" aria-label="History">
    <header class="lib-head">
      <!-- 页面名不在这儿写第二遍:顶部横条的字标已经在说"History"。
           这里留的是只有这一页才有的东西 —— 有多少条记录、多少张图 -->
      <p class="lib-sub">
        {{ items.length }} {{ items.length === 1 ? 'record' : 'records' }} · {{ imageCount }} {{ imageCount === 1 ? 'image' : 'images' }}
      </p>
      <!-- 页级动作:常态是「进入多选」,进了多选就换成那一套动作。
           整个块跟着一起收 —— 空的历史页不该在标题旁留一段空白 -->
      <div v-if="tiles.length || exportMsg || exportErr || exportProgress" class="lib-acts">
        <p
          v-if="exportErr || exportMsg || exportProgress"
          class="dl-msg"
          :class="{ bad: !!exportErr }"
          role="status"
        >
          {{ exportErr || exportMsg || exportProgress }}
        </p>
        <template v-if="selecting">
          <button v-if="shownTiles.length" type="button" class="lib-btn" @click="toggleAll">
            {{ allShownSelected ? 'Deselect all' : 'Select all' }}
          </button>
          <button
            type="button"
            class="lib-dl"
            :disabled="exporting || !selectedCount"
            @click="downloadSelected"
          >
            <PhDownloadSimple aria-hidden="true" />
            Download{{ selectedCount ? ` (${selectedCount})` : '' }}
          </button>
          <button type="button" class="lib-btn" @click="endSelect">Cancel</button>
        </template>
        <!-- 没有图可挑时不给这个入口,免得点进一个空的选择态 -->
        <button v-else-if="tiles.length" type="button" class="lib-btn" @click="startSelect">
          Select
        </button>
      </div>
    </header>

    <!-- 保留规则单独占一行:不写出来,记录被自动清掉时用户会以为丢了 -->
    <div class="lib-tools">
      <!-- 搜索。放在筛选之前:它回答的是"哪一张",而筛选回答的是"哪一批" ——
           先想起来的一般是"我记得写过 window" -->
      <div class="search">
        <PhMagnifyingGlass class="search-ico" aria-hidden="true" />
        <input
          v-model="query"
          class="search-input"
          type="search"
          placeholder="Search prompts, characters, collections…"
          aria-label="Search history"
        />
        <button v-if="searching" class="search-x" aria-label="Clear search" @click="clearSearch">
          <PhX aria-hidden="true" />
        </button>
      </div>
      <div class="filters">
        <div class="mark-filter" role="group" aria-label="Filter">
          <button class="chip" :class="{ on: !onlyMarked }" :aria-pressed="!onlyMarked" @click="onlyMarked = false">
            All
          </button>
          <button class="chip" :class="{ on: onlyMarked }" :aria-pressed="onlyMarked" @click="onlyMarked = true">
            Marked <span class="chip-n">{{ markedCount }}</span>
          </button>
        </div>
        <!-- 作品集筛选:按集看整组作品。没建过集时不占位,免得空页面多一行噪声 -->
        <div v-if="collections.length || adding" class="coll-filter" role="group" aria-label="Collections">
          <PhStack class="coll-ico" aria-hidden="true" />
          <span v-for="c in collections" :key="c.id" class="coll-chip">
            <button
              class="chip"
              :class="{ on: activeColl === c.id }"
              :aria-pressed="activeColl === c.id"
              @click="activeColl = activeColl === c.id ? '' : c.id"
            >
              {{ c.title }}
            </button>
            <button
              class="chip-x"
              :aria-label="`Delete collection ${c.title}`"
              @click="emit('delete-collection', c.id)"
            >
              <PhX aria-hidden="true" />
            </button>
          </span>
          <template v-if="adding">
            <input
              v-model="newTitle"
              class="coll-input"
              :placeholder="`Name…`"
              aria-label="New collection name"
              @keyup.enter="submitNew"
              @keyup.esc="adding = false"
            />
            <button class="chip" :disabled="!newTitle.trim()" @click="submitNew">Add</button>
            <button class="chip" @click="adding = false">Cancel</button>
          </template>
          <button v-else class="chip coll-add" aria-label="New collection" @click="adding = true">
            <PhPlus aria-hidden="true" />
          </button>
        </div>
      </div>
      <p class="lib-note">
        {{
          searching
            ? `${shownRecords} ${shownRecords === 1 ? 'record' : 'records'} · ${shownTiles.length} ${shownTiles.length === 1 ? 'image' : 'images'} match “${query.trim()}”`
            : selecting
              ? 'Pick images to download, then hit Download.'
              : activeColl
                ? `In “${activeCollTitle()}” — saved here isn't cleared by storage cleanup.`
                : 'Saved locally. Oldest records are cleared automatically when storage runs low.'
        }}
      </p>
    </div>

    <!-- —— 命中的图片:一张一块 ——
         与下面的图墙分开,是因为两者答的不是同一件事:图墙是浏览
         (悬停才出提示词与参数,动作按记录),这一条是"就是这张"
         (动作常驻,标着它从哪条记录来)。只在搜索时出现(见 stripTiles 的说明) -->
    <section v-if="searching && stripTiles.length" class="strip" aria-label="Matching images">
      <div class="strip-head">
        <h2 class="strip-title">Images</h2>
        <span class="strip-n">{{ shownTiles.length }}</span>
        <span v-if="stripHidden" class="strip-more">
          showing the first {{ IMG_STRIP_MAX }} — narrow the search for the rest
        </span>
      </div>
      <ul class="strip-list no-bar">
        <li v-for="t in stripTiles" :key="t.key" class="scard">
          <button
            type="button"
            class="scard-open"
            :aria-label="`Open ${titleOf(t.entry)}`"
            @click="emit('open', t.entry, t.index)"
          >
            <img loading="lazy" decoding="async" :src="imageSrc(t.item)" alt="" />
          </button>
          <!-- 动作常驻。图墙那边是悬停才出(浏览态要安静),而这里的每一张
               都是用户刚刚**搜出来**的,他要做的就是在这张上做点什么 -->
          <div class="scard-ops">
            <button
              class="stop"
              :class="{ 'top-on': t.item.marked }"
              :aria-label="t.item.marked ? 'Unmark image' : 'Mark image'"
              :aria-pressed="!!t.item.marked"
              @click.stop="emit('mark', t.entry, t.index)"
            >
              <PhHeart :weight="t.item.marked ? 'fill' : 'regular'" aria-hidden="true" />
            </button>
            <button
              class="stop"
              :aria-label="`Save this image: ${titleOf(t.entry)}`"
              @click.stop="saveTile(t)"
            >
              <PhDownloadSimple aria-hidden="true" />
            </button>
          </div>
          <!-- 出处那句压在图上,而不是塞进下面那一行:这一条只有 132px 宽,
               日期 + 出处 + 角色名 + "1 of 2" 挤不下 —— 宁可让它在图上占一角 -->
          <span v-if="chatWorkLabel(t.entry.source)" class="scard-src" aria-hidden="true">
            {{ chatWorkLabel(t.entry.source) }}
          </span>
          <div class="scard-foot">
            <span class="scard-when">{{ fmt(t.entry.createdAt) }}</span>
            <span v-if="t.entry.characterId" class="scard-who">
              {{ charNames[t.entry.characterId] || 'Character' }}
            </span>
            <span class="scard-of">
              {{ t.entry.results.length > 1 ? `${t.index + 1} of ${t.entry.results.length}` : '' }}
            </span>
          </div>
        </li>
      </ul>
    </section>

    <!-- 外层用 template 包一层:图墙与"加载更多"是两件东西,而 v-else 要配在同一层 -->
    <template v-if="shownTiles.length">
    <div
      class="wall"
      :role="selecting ? 'group' : undefined"
      :aria-label="selecting ? 'Select images to download' : undefined"
    >
      <div
        v-for="t in visibleTiles"
        :key="t.key"
        class="tile"
        :class="{ picking: selecting, sel: selecting && selected.has(t.key) }"
        :style="{ aspectRatio: String(tileRatio(t)) }"
      >
        <!-- 画面单占一层:选择态要淡出的是"画面",而砖自己那层画布底必须留着。
             整块一起淡出会让页面纹理从图后透出来,和图片糊成一片 -->
        <div class="tile-media" :style="tileBg(t.entry)">
          <img
            loading="lazy"
            decoding="async"
            :src="imageSrc(t.item)"
            alt=""
            @load="onTileLoad(t, $event)"
          />
        </div>
        <!-- 整块覆盖的按钮:键盘、读屏与鼠标都走它 ——
             inset:0 铺满整块,所以外层不需要再挂一个点击 -->
        <button
          type="button"
          class="tile-open"
          :aria-label="
            selecting ? `Select: ${titleOf(t.entry)}` : `Open preview: ${titleOf(t.entry)}`
          "
          :aria-pressed="selecting ? selected.has(t.key) : undefined"
          @click.stop="onTileClick(t)"
        ></button>
        <!-- 标记过的角标常驻:不悬停也要看得出哪些标了。
             选择态里它不撤 —— "哪些是我标过的"与"这次挑哪几张"是两件事,
             同时看得见才知道自己在挑的是不是收藏的那批 -->
        <span v-if="t.item.marked" class="tile-mark" aria-hidden="true">
          <PhHeart weight="fill" aria-hidden="true" />
        </span>
        <!-- 来源角标:对话里生成的那两种图(见 lib/chatWork)。常驻而不是悬停才出,
             因为它回答的是"这张是哪来的" —— 而图墙正是靠扫的。
             选择态让位给左上角那枚勾选圈(两枚都在左上,同一处不叠两个符号) -->
        <span
          v-if="!selecting && chatWorkLabel(t.entry.source)"
          class="tile-src"
          aria-hidden="true"
        >
          {{ chatWorkLabel(t.entry.source) }}
        </span>
        <!-- 勾选角标只在选择态出现,放左上角,与右上的收藏角标各占一隅。
             两态同为圆形轮廓,只差中间有没有那枚勾 —— 不垫底、不换形状 -->
        <span v-if="selecting" class="tile-pick" aria-hidden="true">
          <PhCheckCircle v-if="selected.has(t.key)" weight="bold" aria-hidden="true" />
          <PhCircle v-else aria-hidden="true" />
        </span>
        <!-- 悬停/聚焦才浮出:图墙默认只应该是图 -->
        <div class="tile-veil">
          <div class="tile-text">{{ workText(t.entry) }}</div>
          <div class="tile-foot">
            <span class="tile-meta">
              {{ fmt(t.entry.createdAt) }} · {{ t.entry.size === 'auto' ? 'Auto' : t.entry.size.replace('x', '×') }}<template
                v-if="t.entry.results.length > 1"
              > · {{ t.entry.results.length }} images</template>
            </span>
            <!-- 图块本身的点击是打开预览(选择态下是勾选),这几个必须 stop。
                 选择态里收起这排操作:这一刻整块砖的语义是勾选框,
                 混进收藏/复用/删除只会让人点错 -->
            <div v-if="!selecting" class="tile-ops">
              <button
                class="top"
                :class="{ 'top-on': t.item.marked }"
                :aria-label="t.item.marked ? 'Unmark image' : 'Mark image'"
                :aria-pressed="!!t.item.marked"
                @click.stop="emit('mark', t.entry, t.index)"
              >
                <PhHeart :weight="t.item.marked ? 'fill' : 'regular'" aria-hidden="true" />
              </button>
              <button
                class="top top-del"
                :aria-label="`Delete: ${titleOf(t.entry)}`"
                @click.stop="emit('remove', t.entry)"
              >
                <PhTrash aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 还有没渲染的:给出"现在看到多少 / 一共有多少"与一个明确的按钮。
         哨兵自己不可见、也不占位,只用来触发自动补一批 ——
         纯无限滚动对键盘用户等于"后面那些永远看不到"。
         这一块**不能放进 .wall**:那是多列瀑布流,块会掉进某一列里挤成一条 -->
    <div v-if="wallRemaining" class="wall-more">
      <p class="wall-count" aria-live="polite">
        Showing {{ visibleTiles.length }} of {{ shownTiles.length }} images
      </p>
      <span ref="wallMoreEl" class="wall-sentinel" aria-hidden="true"></span>
      <button type="button" class="lib-btn" @click="showMore">
        Show {{ Math.min(WALL_PAGE, wallRemaining) }} more
      </button>
    </div>
    </template>

    <div v-else class="lib-none">
      <div class="none-ico" aria-hidden="true">
        <PhMagnifyingGlass v-if="searching" aria-hidden="true" />
        <PhStack v-else-if="activeColl" aria-hidden="true" />
        <PhHeart v-else-if="onlyMarked" aria-hidden="true" />
        <PhClockCounterClockwise v-else aria-hidden="true" />
      </div>
      <h2 class="none-title">
        {{
          searching
            ? `Nothing matches “${query.trim()}”`
            : activeColl
              ? onlyMarked
                ? 'No marked images in this collection yet'
                : 'No images in this collection yet'
              : onlyMarked
                ? 'No marked images yet'
                : 'No generations yet'
        }}
      </h2>
      <p class="none-sub">
        {{
          searching
            ? 'Search looks at the prompt, the character and the collection name — not at what is inside the picture.'
            : activeColl
              ? onlyMarked
                ? 'Open a collection image in the preview and mark it — or drop the mark filter to see the whole collection.'
                : 'Open any result in the preview and add it to this collection there.'
              : onlyMarked
                ? 'Hover an image and click the heart to mark it. Marks are per image, so images in a record stay independent.'
                : 'Images your characters send in chat are saved here automatically, ready to revisit and download.'
        }}
      </p>
      <button v-if="filterActive" class="none-action" @click="clearFilter">
        {{ searching ? 'Clear search' : 'View all' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
/* 以下骨架与提示词库页保持一致 */
.lib-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  padding-top: var(--sp-2);
}
.lib-sub {
  margin-top: 6px;
  font-size: var(--fs-sm);
  color: var(--text-2);
}

/* 页级动作与它的状态位同处一行:状态就贴在它说明的那个动作旁边。
   选择态下这里会并排三个按钮,窄屏靠换行收下去 */
.lib-acts {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: var(--sp-2) var(--sp-3);
}
.dl-msg {
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.dl-msg.bad {
  color: var(--danger);
}
/* 与提示词库页的「新建」同一套规格:页级主操作,40px 触控目标 */
.lib-dl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.lib-dl svg {
  width: 15px;
  height: 15px;
}
.lib-dl:hover:not(:disabled) {
  background: var(--cta-hover);
}
/* 打包期间置灰而不是换文案:逐张读字节时按钮一直改宽度会晃 */
.lib-dl:disabled {
  opacity: 0.6;
  cursor: default;
}
/* 次级动作:进入多选 / 全选 / 退出,与黑药丸主操作同一尺寸、更轻的分量 */
.lib-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 40px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.lib-btn:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}

.lib-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-5);
  padding-bottom: var(--sp-4);
  border-bottom: 1px solid var(--line);
}
/* 两块筛选(全部/已标记 + 作品集)收在一列,换行时整体对齐 */
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-3) var(--sp-4);
}
/* 搜索框:与胶囊同一行、同一高度档。宽度给到 260px ——
   再窄一点就看不见自己打了什么,再宽会把筛选挤到第二行 */
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 260px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  transition: box-shadow var(--dur) var(--ease);
}
/* 聚焦用 box-shadow 补一圈,不切 border —— 切了里面整行会挪一下
   (与对话页那张输入卡片同一条手法) */
.search:focus-within {
  box-shadow: 0 0 0 1px var(--line-strong);
}
.search-ico {
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--text-4);
}
.search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm);
}
.search-input:focus {
  outline: none;
}
.search-input::-webkit-search-cancel-button {
  display: none;
}
.search-x {
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
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.search-x:hover {
  background: var(--accent-soft);
  color: var(--text);
}
.search-x svg {
  width: 13px;
  height: 13px;
}

/* —— 命中的图片:横向一条 ——
   一条而不是一面墙,是为了与下面的图墙**看起来就是两件事**:
   横着排、一张一块、动作常驻,扫一眼就知道这是"搜出来的那几张" */
.strip {
  padding: var(--sp-4) 0 0;
}
.strip-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: var(--sp-2);
}
.strip-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
.strip-n {
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.strip-more {
  font-size: var(--fs-micro);
  color: var(--text-3);
}
.strip-list {
  display: flex;
  gap: var(--sp-2);
  margin: 0;
  padding: 0 0 var(--sp-2);
  list-style: none;
  overflow-x: auto;
  /* 滚动条占位一致:不然鼠标进来时才冒出一条,整条会跳 10px */
  scrollbar-gutter: stable;
}
.scard {
  position: relative;
  flex: none;
  width: 132px;
}
.scard-open {
  display: block;
  width: 100%;
  height: 132px;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--image-bg);
  cursor: pointer;
}
.scard-open img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* 动作常驻(与图墙相反:那边悬停才出)。这一张是用户刚搜出来的,
   要做的就是在它身上做点什么,而"再悬停一次"是白多一步 */
.scard-ops {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
}
.scard-ops .stop {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 999px;
  background: rgba(24, 24, 22, 0.42);
  color: #fbfaf7;
  backdrop-filter: blur(6px);
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.scard-ops .stop:hover {
  background: rgba(24, 24, 22, 0.62);
}
.scard-ops .stop.top-on {
  color: #ff7a8a;
}
.scard-ops .stop svg {
  width: 14px;
  height: 14px;
}
.scard-foot {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 4px;
  font-size: var(--fs-micro);
  /* 这一条没有暗幕垫底(图墙那份 tile-meta 有),所以字要按"白底上的小字"
     来选:--text-3 是站内为浅色面上的小字定的那一档(≥4.6:1),
     --text-4 是禁用档,铺在这儿等于看不见 */
  color: var(--text-3);
}
.scard-when {
  font-variant-numeric: tabular-nums;
}
/* 出处那句(只有对话里生成的图有,见 lib/chatWork)。
   **压在图上,不进下面那一行** —— 这一条只有 132px 宽,日期、角色名与
   "1 of 2" 已经把那一行占满了。放左下角(右上留给标记/保存那两枚按钮),
   垫一层半透明底,与图墙那枚角标同一套做法 */
.scard-src {
  position: absolute;
  bottom: 6px;
  left: 6px;
  max-width: calc(100% - 12px);
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(24, 24, 22, 0.45);
  color: #fff;
  font-size: var(--fs-micro);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  backdrop-filter: blur(6px);
  pointer-events: none;
}
.scard-who {
  overflow: hidden;
  color: var(--text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scard-of {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
/* 筛选胶囊与提示词库页的分类胶囊同一套规格 */
.mark-filter {
  display: flex;
  gap: 6px;
}
/* 作品集筛选组:图标打头,中间每个集一颗可点胶囊 + 一颗删除小圆点;
   空集也照样显示,好让用户回头删掉或往里面加图 */
.coll-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.coll-ico {
  width: 15px;
  height: 15px;
  color: var(--text-3);
  margin-right: 2px;
}
.coll-chip {
  display: inline-flex;
  align-items: center;
}
/* 删除集的小叉:贴着胶囊放,点击目标是 24px 圆形,够得着又不太戳眼 */
.chip-x {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 2px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.chip-x:hover {
  color: var(--danger);
  background: color-mix(in oklch, var(--danger) 10%, transparent);
}
.chip-x svg {
  width: 14px;
  height: 14px;
}
/* 行内新建框:比胶囊矮一档,回车确认,Esc 取消 */
.coll-input {
  width: 130px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font-size: var(--fs-xs);
  outline: none;
  transition: border-color var(--dur) var(--ease);
}
.coll-input:focus {
  border-color: var(--accent);
}
.chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: none;
  color: var(--text-2);
  font-size: var(--fs-xs);
  cursor: pointer;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.chip:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
.chip.on {
  background: var(--accent-soft);
  border-color: color-mix(in oklch, var(--accent) 45%, transparent);
  color: var(--accent-strong);
}
.chip-n {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}
.lib-note {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--text-2);
}

/* 图墙:固定列宽、列数由容器宽度自己算,不用媒体查询。
   多列布局天然错落,配合每块各自的出图比例就是首页图墙的样子 */
.wall {
  margin-top: var(--sp-4);
  column-width: 240px;
  column-gap: var(--sp-3);
}
.tile {
  position: relative;
  display: block;
  width: 100%;
  /* 多列布局下用 margin 撑开纵向间距,break-inside 防止一块被拆到两列 */
  margin: 0 0 var(--sp-3);
  border-radius: var(--r);
  overflow: hidden;
  break-inside: avoid;
  /* 画布底色:画面层淡出时露出来的就是它。它必须不透明 ——
     整块砖一起变透明的话,页面纹理会从图后透出来 */
  background-color: var(--image-bg);
  cursor: zoom-in;
  transition: box-shadow var(--dur) var(--ease);
}
/* 画面层:画布底图(缩略图)与原图同处这一层,要淡出的正是这一整层 */
.tile-media {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  transition: opacity var(--dur) var(--ease);
}
/* 聚焦态跟着内部按钮走:焦点环由 :focus-within 表达 */
.tile:hover,
.tile:focus-within {
  box-shadow: var(--sh-md);
}
.tile:focus-within {
  box-shadow: var(--sh-md), 0 0 0 3px var(--accent-soft);
}
/* 选择态:整块砖是勾选框,所以光标从"放大看"变成"点选" */
.tile.picking,
.tile.picking .tile-open {
  cursor: pointer;
}
/* 没被挑中的退到背后:这一刻要看的不再是这一墙图,而是"我挑中了哪几张"。
   把其余的压暗,选中的那几张自然浮出来 —— 于是"选中"不必再往图上加东西:
   描边、底片、遮罩都是在图上多糊一层,压暗其余才是减法。
   淡的是画面层而不是整块砖:砖的画布底留在底下接着,页面纹理透不上来。
   刻意不给 hover 提亮:一墙里"亮的"只该有一个含义 —— 被选中了;
   悬停的反馈由 .tile:hover 那条投影负责 */
.tile.picking:not(.sel) .tile-media {
  opacity: 0.3;
}
/* 覆盖整块的打开按钮:透明无边框,聚焦环交给 .tile:focus-within */
.tile-open {
  position: absolute;
  inset: 0;
  padding: 0;
  border: 0;
  background: none;
  cursor: zoom-in;
  outline: none;
}
.tile-media img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 600ms var(--ease);
}
.tile:hover .tile-media img {
  transform: scale(1.04);
}

/* 角标:默认隐去,悬停/聚焦时浮出提示词与参数 */
.tile-veil {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 26px 8px 8px;
  text-align: left;
  color: #fff;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.62), transparent);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur) var(--ease);
}
/* 标记角标常驻:压在图上,用投影保住任何底色下的可读性 */
.tile-mark {
  position: absolute;
  top: 8px;
  right: 8px;
  color: #fff;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.55));
  pointer-events: none;
}
.tile-mark svg {
  display: block;
  width: 16px;
  height: 16px;
}
/* 来源角标:对话里生成的那两种图(见 lib/chatWork)。**常驻**,不像图砖正文那样
   悬停才出 —— 它回答"这张是哪来的",而图墙正是靠扫的。
   放左上角,与右上的收藏角标各占一隅;选择态让位给勾选圈(见模板上那个 v-if)。
   垫一层半透明底:图墙什么底色的图都有,只靠白字加投影在浅色照片上读不出来 */
.tile-src {
  position: absolute;
  top: 8px;
  left: 8px;
  max-width: calc(100% - 44px);
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(24, 24, 22, 0.45);
  color: #fff;
  font-size: var(--fs-micro);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  backdrop-filter: blur(6px);
  pointer-events: none;
}
/* 勾选角标:放左上角,与右上的收藏角标各占一隅,互不遮挡。
   两态同为圆形轮廓,只差中间那枚勾;不垫底、不换形状 ——
   "选中"主要靠未选中的那些被压暗来读(见上面的 .tile.picking:not(.sel)),
   这一枚只负责把选中项本身点明。
   白色 + 投影那套与收藏角标一致,图墙什么底色上都能认出来 */
.tile-pick {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  color: #fff;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.55));
  pointer-events: none;
}
.tile-pick svg {
  display: block;
  width: 20px;
  height: 20px;
}
.tile:hover .tile-veil,
.tile:focus-visible .tile-veil,
.tile:focus-within .tile-veil {
  opacity: 1;
  /* 只有浮出来的时候才接事件,否则它会挡住图块本身的点击 */
  pointer-events: auto;
}
.tile-text {
  font-size: var(--fs-xs);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tile-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tile-meta {
  min-width: 0;
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tile-ops {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  margin-left: auto;
}
/* 压在图片+黑色渐变上,所以用半透明白底而不是主题色。
   24px 比图块外的按钮小一档:这里同时要放三个,再宽元信息就被挤没了 */
.top {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--r-sm);
  color: #fff;
  background: rgba(255, 255, 255, 0.18);
  cursor: pointer;
  transition: background var(--dur) var(--ease), transform 120ms var(--ease);
}
.top svg {
  width: 14px;
  height: 14px;
}
.top:hover {
  background: rgba(255, 255, 255, 0.32);
}
.top:active {
  transform: scale(0.94);
}
/* 已标记:星标实心且底色加重,和未标记区分得开 */
.top-on {
  background: rgba(255, 255, 255, 0.9);
  color: #1a1a1a;
}
.top-on:hover {
  background: #fff;
}
.top-del:hover {
  background: color-mix(in oklch, var(--danger) 78%, transparent);
}

.lib-none {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--sp-8) var(--sp-4);
}
.none-ico {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  opacity: 0.7;
}
.none-ico svg {
  width: 28px;
  height: 28px;
}
.none-title {
  margin-top: var(--sp-3);
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text-2);
}
.none-sub {
  margin-top: 8px;
  max-width: 380px;
  font-size: var(--fs-sm);
  line-height: 1.7;
  color: var(--text-2);
}
.none-action {
  margin-top: var(--sp-5);
  height: 34px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.none-action:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}

/* 窄屏:选择态下这里有三个按钮,挤不进计数那一行 —— 让它独占据一行,自己再换行 */
@media (max-width: 640px) {
  /* 手机上把这一排的触控目标抬到 40px —— 站内对触屏的底线
     (见 App.vue 里 .param-btn / .clear-icon 那几条)。桌面维持原尺寸:
     那边有鼠标,把它撑大只会让版面变松 */
  .chip {
    min-height: 40px;
  }

  /* 搜索框 <16px 时,iOS Safari 一聚焦就把整页放大(站内硬约束,
     见 style.css 的 --fs-lg)。这是这一页上唯一的输入框,单独提一档即可 */
  .search-input {
    font-size: var(--fs-lg);
  }
  .lib-acts {
    width: 100%;
    justify-content: flex-start;
  }
}

/* —— 分段渲染的尾巴 ——
   居中一行"看到多少 / 一共多少"加一个按钮。哨兵是空的、不占位:
   它只承担 IntersectionObserver 的目标,不该在视觉上留下任何痕迹 */
.wall-more {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-6) 0 var(--sp-2);
}
.wall-count {
  font-size: var(--fs-xs);
  color: var(--text-3);
  letter-spacing: var(--ls-wide);
}
.wall-sentinel {
  display: block;
  width: 1px;
  height: 1px;
}
</style>
