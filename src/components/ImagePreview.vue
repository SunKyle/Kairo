<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import type { Component } from 'vue'
import {
  PhCaretLeft,
  PhCaretRight,
  PhCaretUp,
  PhCaretDown,
  PhImageSquare,
  PhX,
  PhCopy,
  PhHeart,
  PhStack,
  PhPlus,
  PhCrop,
  PhSparkle,
  PhCube,
  PhHash,
  PhSquare,
  PhTimer,
  PhCalendarBlank,
  PhChatCircleDots,
  PhDownloadSimple,
  PhTrash,
  PhCheck,
  PhMaskHappy
} from '@phosphor-icons/vue'
import { BACKGROUND_OPTIONS, QUALITY_OPTIONS, downloadImageUrl, imageSrc, optionLabel, thumbSrc } from '../api'
import type { HistoryEntry, Collection, Character } from '../types'
/* 对话里生成的那两种图的"出处那句话"(见 lib/chatWork)。
   没有它,预览卡上那段提示词是一整串机位与光,读不出这张画的是什么 */
import { chatWorkLabel } from '../lib/chatWork'
// 浮层的公共行为(Tab 圈定 / 点外收起 / Esc 逐层退)
import { isInside, layerOnEscape, trapTab } from '../lib/ui'

const props = defineProps<{
  visible: boolean
  entry: HistoryEntry | null
  // 全部历史,用于上下翻页在记录之间切换
  items: HistoryEntry[]
  // 作品集目录:这张卡把当前记录挂到某个集下
  collections: Collection[]
  // 角色目录:用来把记录上的 characterId 翻成名字
  characters: Character[]
  /* 打开时先落在第几张(从 0 数)。历史页的搜索结果是一张图一块,
     点第 3 张就该看到第 3 张 —— 默认 0 是"从记录的第一张看起" */
  startIndex?: number
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'navigate', entry: HistoryEntry): void
  (e: 'remove'): void
  (e: 'mark', entry: HistoryEntry, index: number): void
  (e: 'assign-collection', collectionId: string): void
  (e: 'create-collection', title: string): void
}>()

const active = ref(0)
// 作品集的「新建」输入框:点开就地在行尾长出来,点别处即放弃
const collAdding = ref(false)
const collNewTitle = ref('')
const collEl = ref<HTMLElement | null>(null)
function onDocPointerDown(e: PointerEvent) {
  if (isInside(e.target, collEl.value)) return
  // 点开输入框又去点别处,当作放弃新建:残留一个半截名字比直接收起更碍事
  if (collAdding.value) {
    collAdding.value = false
    collNewTitle.value = ''
  }
}
// 复制后的短暂回执:复制 Prompt 现在是显眼的主操作,必须有反馈
const copied = ref(false)
// 复制失败也是一种必须给出的回执:写不进剪贴板时不能假装成功
const copyFailed = ref(false)
let copiedTimer: number | undefined
// 弹层的焦点管理:打开时记住原来的焦点,关闭时还回去;容器负责接住初始焦点
const panelEl = ref<HTMLElement | null>(null)
let lastFocused: HTMLElement | null = null

const imgs = computed(() => {
  return props.entry ? props.entry.results.map(imageSrc) : []
})

// 记录里的尺寸能解析出比例就直接用;'auto' 之类解析不出来时返回 0
const sizeRatio = computed(() => {
  const [w, h] = (props.entry?.size || '').split('x').map(Number)
  return w > 0 && h > 0 ? w / h : 0
})
// 缩略图收窄极端比例,免得竖条太细、横条太扁
const thumbRatio = computed(() => Math.min(2, Math.max(0.5, sizeRatio.value || 1)))

// 主图盒子:优先用记录里的尺寸。取不到才等图片加载,而且只锁第一张 ——
// 同一条记录里的图尺寸一致,锁定它才不会在左右翻页时反复改卡片宽度
const loadedRatio = ref(0)
const boxRatio = computed(() => sizeRatio.value || loadedRatio.value || 1)
function onImgLoad(e: Event) {
  if (loadedRatio.value) return
  const el = e.target as HTMLImageElement
  if (el.naturalWidth && el.naturalHeight) loadedRatio.value = el.naturalWidth / el.naturalHeight
}

// 每次打开、或上下翻到另一条记录,都回到初始视图
function resetView() {
  /* 落点由调用方给(历史页"点第几张就看第几张"),但要夹进这一条记录的范围:
     记录被删过图、或调用方给的索引过期时,active 越界会让图片区一片空 */
  const count = props.entry?.results.length || 0
  const at = props.startIndex ?? 0
  active.value = count ? Math.min(Math.max(0, at), count - 1) : 0
  collAdding.value = false
  collNewTitle.value = ''
  copied.value = false
  copyFailed.value = false
  loadedRatio.value = 0
}
watch(
  () => props.visible,
  (v) => {
    if (v) {
      lastFocused = (document.activeElement as HTMLElement) || null
      resetView()
      // 焦点先落到弹层上:Tab 从这里开始走,读屏也会念出对话框
      nextTick(() => panelEl.value?.focus({ preventScroll: true }))
    } else {
      lastFocused?.focus?.()
      lastFocused = null
    }
  }
)
// 翻到别的记录时,单独重置(此时 visible 不变,上面那个 watch 不会触发)
watch(
  () => props.entry?.id,
  () => {
    if (props.visible) resetView()
  }
)

/** 时间戳取 "Sep 26, 18:52":toLocaleString 近 20 个字符,定宽侧栏里会被省略号吃掉 */
function fmtTime(ts: number) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

// —— 记录导航:上下翻的是历史,左右翻的是本条内的多张图 ——
const entryIndex = computed(() => {
  const cur = props.entry
  return cur ? props.items.findIndex((e) => e.id === cur.id) : -1
})
const canGoUp = computed(() => entryIndex.value > 0)
const canGoDown = computed(() => entryIndex.value >= 0 && entryIndex.value < props.items.length - 1)
/** 沿历史列表上下移动:history 是最新在前,所以 -1 是更新的那条。
 *  当前这条已经不在列表里时(entryIndex 为 -1)先退出 —— 拿 -1 去加步长,
 *  会算出 items[0],也就是"翻到最新那条",而用户其实什么都没按 */
function goEntry(step: number) {
  if (entryIndex.value < 0) return
  const next = props.items[entryIndex.value + step]
  if (next) emit('navigate', next)
}

function close() {
  emit('close')
}

/* 一张图都没有时不动:取余的分母是 0,active 会变成 NaN,
   之后 imgs[NaN] 取不到东西,整块图区空着也说不清为什么 */
function prev() {
  if (!imgs.value.length) return
  active.value = (active.value - 1 + imgs.value.length) % imgs.value.length
}
function next() {
  if (!imgs.value.length) return
  active.value = (active.value + 1) % imgs.value.length
}

/** 按载荷真实类型推下载扩展名:结果可能是 jpeg / webp,写死 png 名不对。
 *  实现与批量导出、历史页的单张保存共用一份(见 api.ts 的 downloadImageUrl) */
function download() {
  const url = imgs.value[active.value]
  if (!url) return
  downloadImageUrl(url, props.entry?.results[active.value])
}

async function copyPrompt() {
  if (!props.entry) return
  copyFailed.value = false
  try {
    await navigator.clipboard.writeText(props.entry.prompt)
    copied.value = true
  } catch {
    // 写不进剪贴板(无权限 / 非安全上下文)就如实报错,别显示"已复制"
    copyFailed.value = true
  }
  window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copied.value = false
    copyFailed.value = false
  }, 1600)
}

// 标记标的是"当前这张图",所以要跟着 active 走:一条记录里几张图各标各的。
// 字段和历史图墙共用(entry.results[].marked),这边只负责触发,落盘在主界面
const marked = computed(() => !!props.entry?.results[active.value]?.marked)
function toggleMark() {
  if (!props.entry) return
  emit('mark', props.entry, active.value)
}

// 耗时:10 秒以内保留一位小数,再长就取整,避免数字跳动太碎
function fmtElapsed(ms: number) {
  const s = ms / 1000
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`
}

/** 焦点是不是在一个能打字的地方。进到这里说明不是 Esc、也不是 Tab ——
 *  那剩下的方向键就该归输入框:左右是移光标,上下更糟 ——
 *  它会顺着历史翻到下一条,连带把刚敲的名字与输入态一起清掉 */
function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  return (
    !!t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable)
  )
}

// 键盘:左右翻本条的多张图,上下翻历史记录;Esc 分两级,Tab 锁在弹层内
function onKey(e: KeyboardEvent) {
  if (!props.visible) return
  if (
    layerOnEscape(e.key, [
      // 作品集的新建框开着先收它,再按一次才关预览
      {
        open: collAdding.value,
        close: () => {
          collAdding.value = false
          collNewTitle.value = ''
        }
      },
      { open: props.visible, close }
    ])
  ) {
    return
  }
  if (e.key === 'Tab') trapTab(panelEl.value, e)
  else if (isTyping(e)) return
  else if (e.key === 'ArrowLeft') prev()
  else if (e.key === 'ArrowRight') next()
  else if (e.key === 'ArrowUp') {
    // 拦下默认行为,否则上下键会去滚侧栏
    e.preventDefault()
    goEntry(-1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    goEntry(1)
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  document.addEventListener('pointerdown', onDocPointerDown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('pointerdown', onDocPointerDown)
  window.clearTimeout(copiedTimer)
})

/* —— 创作链 ——
   这条记录如果是从另一条「改一个变量重跑」来的,就一路往上游找父记录。
   只在预览里逆行看链条(最多 3 层),不做全屏树 —— 克制,够用就行。
   chain[0] 是最近的那条父记录(直接来源),越往后越旧 */
const chain = computed<HistoryEntry[]>(() => {
  const out: HistoryEntry[] = []
  let pid = props.entry?.parentId
  while (pid && out.length < 3) {
    const parent = props.items.find((e) => e.id === pid)
    if (!parent) break
    out.push(parent)
    pid = parent.parentId
  }
  return out
})

/* —— 生成信息 ——
   把这条记录的出图条件摊成"标签 + 值"的规格项,只列真有的:
   全是「自动」的记录不必堆一排没信息的占位 */
const specs = computed<{ icon: Component; k: string; v: string }[]>(() => {
  const e = props.entry
  if (!e) return []
  const out: { icon: Component; k: string; v: string }[] = [
    { icon: PhCrop, k: 'Aspect Ratio', v: e.size === 'auto' ? 'Auto' : e.size.replace('x', '×') }
  ]
  /* 对话里生成的那两种图:它是**聊出来的**,与工作台里手写提示词做出来的
     不是一回事。这一行说清来路 —— 上面那段提示词是整段摄影指令,
     没有这一行用户会奇怪"我什么时候写过这种提示词" */
  const src = chatWorkLabel(e.source)
  if (src) out.unshift({ icon: PhChatCircleDots, k: 'From', v: src })
  if (e.quality) out.push({ icon: PhSparkle, k: 'Quality', v: optionLabel(QUALITY_OPTIONS, e.quality) })
  if (e.background)
    out.push({ icon: PhSquare, k: 'Background', v: optionLabel(BACKGROUND_OPTIONS, e.background) })
  /* 套了哪个角色:这张图里"是谁"。角色被删掉之后只剩一个翻不出名字的 id,
     那种情况不占一行 —— 宁可少一行,也别显示一串十六进制 */
  if (e.characterId) {
    const name = props.characters.find((c) => c.id === e.characterId)?.name
    if (name) out.push({ icon: PhMaskHappy, k: 'Character', v: name })
  }
  if (e.hasRef) out.push({ icon: PhImageSquare, k: 'Reference', v: 'Included' })
  if (e.seed !== undefined) out.push({ icon: PhHash, k: 'Seed', v: String(e.seed) })
  if (e.elapsedMs) out.push({ icon: PhTimer, k: 'Duration', v: fmtElapsed(e.elapsedMs) })
  out.push({ icon: PhCalendarBlank, k: 'Created', v: fmtTime(e.createdAt) })
  return out
})

/* —— 作品集 ——
   一行可见的集卡片:封面取该集最新一条的缩略图,张数按归属统计。
   点一下就把当前记录归到那个集;再点当前所在的集即摘出。
   目录由主界面持有并落盘,这里只发意图 */
const collCards = computed(() =>
  props.collections.map((c) => {
    // history 最新在前,所以第一条就是该集最近的一张,拿它当封面
    const owned = props.items.filter((h) => h.collectionId === c.id)
    return {
      id: c.id,
      title: c.title,
      count: owned.length,
      cover: owned.length ? thumbSrc(owned[0]) : ''
    }
  })
)
function toggleColl(id: string) {
  emit('assign-collection', props.entry?.collectionId === id ? '' : id)
}
function createColl() {
  const t = collNewTitle.value.trim()
  if (!t) return
  emit('create-collection', t)
  collNewTitle.value = ''
  collAdding.value = false
}
// 输入框长在行尾,行是横滑的 —— 点开时把它滚进视野并聚焦,否则可能露不出来
const collInputEl = ref<HTMLInputElement | null>(null)
watch(collAdding, async (v) => {
  if (!v) return
  await nextTick()
  collEl.value?.scrollTo({ left: collEl.value.scrollWidth })
  collInputEl.value?.focus()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible && entry" class="mask" @click.self="close">
        <div
          ref="panelEl"
          class="preview"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          tabindex="-1"
          :style="{ '--ratio': String(boxRatio), '--rail': imgs.length > 1 ? 1 : 0 }"
        >
          <!-- 主体:左图右信息 -->
          <div class="body no-bar">
            <!-- 图片区 -->
            <div class="stage">
              <div class="img-wrap" :style="{ aspectRatio: String(boxRatio) }">
                <img :src="imgs[active]" :alt="`Result ${active + 1}`" @load="onImgLoad" />
              </div>

              <!-- 缩略图行:横排在主图下方,两端各一枚左右翻页键。
                   这两颗不给文字提示 —— 左右箭头本身已经说明动作,
                   而气泡贴在卡片边缘,怎么摆都容易被裁掉一截。
                   键盘方向键一样能翻,读屏靠 aria-label -->
              <div v-if="imgs.length > 1" class="rail">
                <button class="rail-nav" @click="prev" aria-label="Previous">
                  <PhCaretLeft aria-hidden="true" />
                </button>
                <div class="thumbs no-bar">
                  <button
                    v-for="(src, i) in imgs"
                    :key="i"
                    class="thumb"
                    :class="{ active: i === active }"
                    :style="{ aspectRatio: String(thumbRatio) }"
                    :aria-label="`Image ${i + 1}`"
                    @click="active = i"
                  >
                    <img :src="src" :alt="`Thumbnail ${i + 1}`" />
                  </button>
                </div>
                <button class="rail-nav" @click="next" aria-label="Next">
                  <PhCaretRight aria-hidden="true" />
                </button>
              </div>
            </div>

            <!-- 信息侧栏 -->
            <aside class="side no-bar">
              <!-- 顶行:左边是这条记录的操作(标记 / 下载 / 删除),
                   右边是沿历史翻记录与关闭。原先这两组压在图上,
                   现在统一收到这里 —— 图片区因此完全让给图片本身 -->
              <div class="toolbar">
                <div class="tbar-acts">
                  <button
                    class="tbtn tip-below tip-start"
                    @click="toggleMark"
                    :aria-pressed="marked"
                    :data-tip="marked ? 'Unmark image' : 'Mark image'"
                    :aria-label="marked ? 'Unmark image' : 'Mark image'"
                  >
                    <PhHeart :weight="marked ? 'fill' : 'regular'" aria-hidden="true" />
                  </button>
                  <button
                    class="tbtn tip-below"
                    @click="download"
                    data-tip="Download"
                    aria-label="Download"
                  >
                    <PhDownloadSimple aria-hidden="true" />
                  </button>
                  <button
                    class="tbtn danger tip-below"
                    @click="emit('remove')"
                    data-tip="Delete"
                    aria-label="Delete"
                  >
                    <PhTrash aria-hidden="true" />
                  </button>
                </div>

                <div class="tbar-end">
                  <!-- 上下翻历史:history 最新在前,所以 ↑ 是更新的那条。
                       这两枚不给文字提示 —— 方向 + 计数已经说明一切 -->
                  <template v-if="items.length > 1">
                    <button class="tbtn" :disabled="!canGoUp" @click="goEntry(-1)" aria-label="Newer">
                      <PhCaretUp aria-hidden="true" />
                    </button>
                    <span class="tbar-num">{{ entryIndex + 1 }} / {{ items.length }}</span>
                    <button class="tbtn" :disabled="!canGoDown" @click="goEntry(1)" aria-label="Older">
                      <PhCaretDown aria-hidden="true" />
                    </button>
                  </template>
                  <button class="tbtn tip-below tip-end" @click="close" data-tip="Close (Esc)" aria-label="Close">
                    <PhX aria-hidden="true" />
                  </button>
                </div>
              </div>

              <!-- 提示词:侧栏的主角,独占一张可滚的卡 ——
                   与下面几张信息卡同一套外观,复制/存库贴在正文下方。
                   对话里生成的那两种图上面先给一段"场景"(见 lib/chatWork):
                   它们真正发出去的是一整段摄影指令,而用户读得懂的是那句场景 -->
              <section class="block card">
                <header class="card-head">
                  <span class="card-title">Prompt</span>
                  <span v-if="chatWorkLabel(entry.source)" class="card-chip">
                    {{ chatWorkLabel(entry.source) }}
                  </span>
                </header>
                <div class="prompt-scroll">
                  <p v-if="entry.scene" class="prompt-scene">{{ entry.scene }}</p>
                  <!-- 标一句"下面是完整提示词":Copy 与 Save to library 动的都是它,
                       而不是上面那句场景 —— 不写清的话,用户读完场景去点 Copy,
                       拿到的却是另一段文字 -->
                  <p v-if="entry.scene" class="prompt-cap">Full prompt</p>
                  <p class="prompt">{{ entry.prompt }}</p>
                </div>
                <div class="prompt-acts">
                  <button
                    class="blk-act tip-below tip-start"
                    :class="{ done: copied, fail: copyFailed }"
                    @click="copyPrompt"
                    :data-tip="copyFailed ? 'Copy failed — select the text manually' : 'Copy to clipboard'"
                    :aria-label="copyFailed ? 'Copy failed' : copied ? 'Copied' : 'Copy to clipboard'"
                  >
                    <!-- 复制成功后换成对钩:文字 Copy → Copied 只是一处变化,
                         图标一起换才一眼看得出来。图标同为 14px,按钮宽度不会跳 -->
                    <PhCheck v-if="copied" aria-hidden="true" />
                    <PhCopy v-else aria-hidden="true" />
                    <span>{{ copyFailed ? 'Copy failed' : copied ? 'Copied' : 'Copy' }}</span>
                  </button>
                </div>
              </section>

              <!-- 生成信息:模型打头,下面是出图条件的规格表。
                   用卡片把它跟提示词分开 —— 提示词是"要什么",这里是"怎么生成的" -->
              <section class="card gen-card">
                <header class="card-head">
                  <PhCube class="card-ico" aria-hidden="true" />
                  <span class="card-title">{{ entry.model || 'Unknown model' }}</span>
                </header>
                <div class="gen-grid">
                  <div v-for="s in specs" :key="s.k" class="gen-item">
                    <component :is="s.icon" class="gen-item-ico" aria-hidden="true" />
                    <span class="gen-item-text">
                      <span class="gen-k">{{ s.k }}</span>
                      <span class="gen-v">{{ s.v }}</span>
                    </span>
                  </div>
                </div>
              </section>

              <!-- 灵感来源:从别的记录改一个变量跑出来的,就往上游列几层父记录。
                   点任一层直接翻到那条 —— 顺链回溯不用退出预览 -->
              <section v-if="chain.length" class="stack">
                <div class="sec-cap">Inspired by</div>
                <div class="card card-rows">
                  <button
                    v-for="(anc, i) in chain"
                    :key="anc.id"
                    class="chain-row"
                    :aria-label="`Open ${i === 0 ? 'the source' : 'an earlier source'} record`"
                    @click="emit('navigate', anc)"
                  >
                    <img class="chain-thumb" :src="thumbSrc(anc)" alt="" />
                    <span class="chain-text">{{ anc.prompt }}</span>
                    <PhCaretRight class="chain-go" aria-hidden="true" />
                  </button>
                </div>
              </section>

              <!-- 作品集:一行的集卡片,点一下归到那个集、再点摘出。
                   张数与封面都按归属现算,一眼看出每组装了多少 -->
              <section class="stack">
                <div class="sec-cap">Collections</div>
                <div ref="collEl" class="coll-row no-bar">
                  <button
                    v-for="c in collCards"
                    :key="c.id"
                    class="coll-card"
                    :class="{ on: entry.collectionId === c.id }"
                    :aria-pressed="entry.collectionId === c.id"
                    @click="toggleColl(c.id)"
                  >
                    <img v-if="c.cover" class="coll-cover" :src="c.cover" alt="" />
                    <span v-else class="coll-cover coll-cover-ph" aria-hidden="true">
                      <PhStack />
                    </span>
                    <span class="coll-meta">
                      <span class="coll-name">{{ c.title }}</span>
                      <span class="coll-count">{{ c.count }} {{ c.count === 1 ? 'image' : 'images' }}</span>
                    </span>
                  </button>

                  <!-- 新建:点开就地在行尾长出一个输入框,回车即建 -->
                  <template v-if="collAdding">
                    <input
                      ref="collInputEl"
                      v-model="collNewTitle"
                      class="coll-input"
                      placeholder="Name…"
                      aria-label="New collection name"
                      @keyup.enter="createColl"
                      @keyup.esc="collAdding = false"
                    />
                    <button class="coll-card coll-confirm" :disabled="!collNewTitle.trim()" @click="createColl">
                      Add
                    </button>
                  </template>
                  <button v-else class="coll-card coll-new" aria-label="New collection" @click="collAdding = true">
                    <span class="coll-cover coll-cover-ph" aria-hidden="true"><PhPlus /></span>
                    <span class="coll-meta">
                      <span class="coll-name">New</span>
                      <span class="coll-count">collection</span>
                    </span>
                  </button>
                </div>
              </section>
            </aside>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  /* 与抽屉同一套蒙层:主题化半透明黑 + 轻毛玻璃 */
  background: color-mix(in oklch, #000 30%, transparent);
  backdrop-filter: blur(6px) saturate(130%);
  -webkit-backdrop-filter: blur(6px) saturate(130%);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 收成一个变量:卡片的高度上限要用同一个数(见 .preview 的 max-height) */
  --pv-pad: clamp(12px, 4vw, 40px);
  padding: var(--pv-pad);
}
.preview {
  /* 出图比例(--ratio)与是否有缩略图行(--rail,0/1)由组件按当前这张图注入 */
  --prev-h: min(92vh, 880px);
  --stage-pad: var(--sp-4);
  /* 320px 而不是 300px:300 减去左右各 16 的内边距只剩 268,
     提示词换行太密、作品集一行排不下 */
  --side-w: 320px;
  /* 缩略图行的总高:46px 的图块 + 上下各 2px 内边距 */
  --thumb-h: 50px;
  /* 主图与缩略图行之间的间距 */
  --rail-gap: var(--sp-3);

  /* 高度取确定值,不随内容伸缩:展开提示词只在侧栏内部滚动,卡片高度保持不变 */
  height: var(--prev-h);
  /* 宽度跟着图片比例走。缩略图行改到主图下方后占了高度,要先把这一条减掉,
     再按比例推出图宽,加上内边距与侧栏 —— 否则竖图会顶破卡片底部 */
  width: min(
    100%,
    calc(
      (
          var(--prev-h) - 2 * var(--stage-pad) -
            var(--rail, 0) * (var(--thumb-h) + var(--rail-gap))
        ) * var(--ratio, 1) + 2 * var(--stage-pad) + var(--side-w)
    )
  );
  /* 高度上限由蒙层给:蒙层是 fixed + inset:0 + 内边距,
     它的 content box 就是"此刻看得见的那一块"。这一条是必须的 ——
     --prev-h 用的是 92vh,而移动端的 vh 指地址栏收起时的高度,
     比可视区大;卡片又是在蒙层里居中的,一旦高过可视区,
     上下两头一起被切,底下那排动作(下载 / 用作参考)正好压在地址栏底下,
     而蒙层自己不滚 —— 够不到,也没有任何办法滚过去。
     第二行是双保险:个别 webview 里 fixed 的包含块比可视区大,
     那时 100% 也跟着偏大,而 dvh 认得当前可视高度 */
  max-height: 100%;
  max-height: calc(100dvh - 2 * var(--pv-pad));
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--sh-md);
}

/* 顶行分两组:左=本条记录的操作,右=翻记录与关闭 */
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.tbar-acts,
.tbar-end {
  display: flex;
  align-items: center;
  gap: 2px;
}
/* 右组吃满剩余宽度:不管有没有翻记录那几枚,关闭都落在最右 */
.tbar-end {
  margin-left: auto;
  gap: 6px;
}
/* 面板里的图标按钮:底本身就是 --surface,不需要图上那层深色覆盖层。
   一行六个全描边会太吵,所以留白 + 悬停出底 */
.tbtn {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.tbtn svg {
  width: 17px;
  height: 17px;
}
.tbtn:hover {
  color: var(--text);
  background: var(--bg-elev);
}
/* 翻到头的那一端不参与悬停反馈 */
.tbtn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.tbtn:disabled:hover {
  background: none;
}
/* 删除是整行里唯一的破坏性动作:悬停才转红 */
.tbtn.danger:hover {
  color: var(--danger);
  background: color-mix(in oklch, var(--danger) 10%, transparent);
}
/* 翻记录的计数:等宽数字,免得 1/9 与 12/58 之间宽度跳 */
.tbar-num {
  min-width: 40px;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.body {
  display: grid;
  /* 图片列必须写 minmax(0, …):1fr 的自动最小尺寸会被图盒的固有宽度顶开,
     结果就是宽图把固定宽度的侧栏挤扁 */
  grid-template-columns: minmax(0, 1fr) var(--side-w);
  /* 行高填满 body:两栏等高,侧栏内容再多也只在自己内部滚动 */
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}

/* 图片区:主图在上、缩略图行在下,整块居中 */
.stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--rail-gap);
  padding: var(--stage-pad);
  min-height: 0;
  background: var(--stage-bg);
}
/* 图盒按出图比例收缩:高度吃掉缩略图行以外的可用空间,宽度由 aspect-ratio 推出。
   max-width 兜住超宽图。
   圆角落在 img 上而不是靠 overflow:hidden 裁盒子:裁掉的话图片边缘会被切出一道
   和卡片圆角不重合的直角 */
.img-wrap {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.img-wrap img {
  /* 撑满已定比例的盒子;比例与图一致时不留边,不一致时 contain 也不会变形 */
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  border-radius: var(--r);
}
/* 缩略图行:两端各一枚左右翻页键,中间是可滚的缩略图 */
.rail {
  display: flex;
  align-items: center;
  /* 与主图等宽 */
  align-self: stretch;
  gap: var(--sp-2);
}
/* 行首行尾的翻页键:细箭头、不描边,免得跟缩略图抢视线 */
.rail-nav {
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.rail-nav svg {
  width: 15px;
  height: 15px;
}
.rail-nav:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.thumbs {
  display: flex;
  align-items: center;
  /* 吃掉翻页键之间的剩余宽度;图多时这一条自己左右滚,不把卡片撑高 */
  flex: 1;
  min-width: 0;
  /* safe:溢出时从左边起排 —— 单纯的 center 会把最前几张顶进滚不到的地方 */
  justify-content: safe center;
  gap: var(--sp-2);
  padding: 2px;
  overflow-x: auto;
  overflow-y: hidden;
}
.thumb {
  flex-shrink: 0;
  /* 高固定,宽由 aspect-ratio 决定:与出图比例一致,一眼看出竖幅还是横幅 */
  height: 46px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--line);
  opacity: 0.5;
  cursor: pointer;
  transition: opacity var(--dur) var(--ease), border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.thumb img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.thumb:hover {
  opacity: 0.85;
}
.thumb.active {
  border-color: color-mix(in oklch, var(--accent) 70%, transparent);
  opacity: 1;
  box-shadow: 0 0 0 1px color-mix(in oklch, var(--accent) 70%, transparent);
}
/* 信息侧栏 */
.side {
  display: flex;
  flex-direction: column;
  /* 顶边收到 16px 与左栏图片对齐:头部行去掉后,这条基准线才露出来。
     左右也收到 16px —— 作品集那行卡片横铺,省下的 16px 正好多露出一张 */
  padding: var(--sp-4) var(--sp-4) var(--sp-5);
  border-left: 1px solid var(--line);
  /* 收紧到 16px:卡片多了之后,24px 的间隙会把提示词挤没 */
  gap: var(--sp-4);
  /* 整栏不滚:只有提示词那块在自己内部滚,工具栏、生成信息与底部操作始终留在原位 */
  overflow: hidden;
}
/* —— 通用卡片:提示词 / 生成信息表 / 灵感来源都用它 ——
   卡片本身不裁切:卡里的气泡提示要能探出卡片下缘。
   整卡铺满列表行的那种(灵感来源)另加 .card-rows 去裁圆角 */
.card {
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
}
/* 行铺满整卡的列表:行的悬停底色要裁进圆角里 */
.card-rows {
  overflow: hidden;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
}
.card-ico {
  width: 15px;
  height: 15px;
  color: var(--text-2);
  flex: none;
}
/* 小标题:一行全大写标签,给下面的卡起名,不占一条分割线 */
.sec-cap {
  font-size: var(--fs-micro);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}
/* 小标题 + 卡的组合 */
.stack {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
/* 卡头标题:提示词的「Prompt」与生成信息里的模型名共用 */
.card-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
/* 卡头右边那枚出处胶囊(只有对话里生成的那两种图有,见 lib/chatWork)。
   推到最右,与标题拉开 —— 它说的是"这条从哪来",不是标题的一部分 */
.card-chip {
  flex: none;
  margin-left: auto;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-2);
  font-size: var(--fs-micro);
  font-weight: 500;
  white-space: nowrap;
}
/* —— 生成信息 —— */
/* 两列规格:每项一个小图标 + 「标签 / 值」两行 */
.gen-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
  padding: 11px 12px;
}
.gen-item {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  min-width: 0;
}
.gen-item-ico {
  width: 14px;
  height: 14px;
  color: var(--text-3);
  flex: none;
  margin-top: 1px;
}
.gen-item-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.gen-k {
  font-size: var(--fs-micro);
  color: var(--text-3);
}
.gen-v {
  font-size: var(--fs-xs);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 提示词小节吃掉侧栏的剩余高度,再在里面划出滚动区:
   长提示词只把这一个区域撑出滚动条,不会把下面的参数和按钮推出视野 */
.block {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
/* min-height 必须归零:flex 子项默认不肯收缩到内容以下,不归零滚动条就不出现 */
.prompt-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 左侧与卡头的内边距对齐;右侧留 4px,再加滚动条自己的 8px,
     合起来也是 12px,两边留白才对得上 */
  padding: 10px 4px 0 12px;
}
/* 提示词卡底部的两个动作:描边胶囊,读作"对这段文字做的事" */
.prompt-acts {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 11px;
}
/* 卡里的动作:只留描边、不填底 —— 卡底本身就是 --surface,填同色看不出来 */
.blk-act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  background: none;
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.blk-act svg {
  width: 14px;
  height: 14px;
}
.blk-act:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
/* done = 复制成功后的短暂回执(1.6 秒) */
.blk-act.done {
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-color: color-mix(in oklch, var(--accent) 40%, var(--line));
}
/* fail = 复制没写进剪贴板,如实标红 */
.blk-act.fail {
  color: var(--danger);
  background: color-mix(in oklch, var(--danger) 10%, transparent);
  border-color: color-mix(in oklch, var(--danger) 40%, var(--line));
}
/* 气泡默认居中展开。靠边的按钮(侧栏左右缘、缩略图行两端)居中会探出容器被裁掉,
   所以给它们加 tip-start / tip-end 贴边对齐。
   贴边后不再横向滑入:滑动的方向本来就会被容器裁掉一半,看着像抖了一下 */
[data-tip].tip-start::after {
  left: 0;
  transform: translateY(0);
}
[data-tip].tip-start::before {
  left: 12px;
  transform: none;
}
[data-tip].tip-end::after {
  left: auto;
  right: 0;
  transform: translateY(0);
}
[data-tip].tip-end::before {
  left: auto;
  right: 12px;
  transform: none;
}
/* 弹层容器只用来接住初始焦点,聚焦环由内部控件承担 */
.preview:focus {
  outline: none;
}
/* 提示词是这张卡真正的主角:给正文色、并比按钮再大一档,
   参数标签退到 --text-2 去当注脚 */
.prompt {
  font-size: var(--fs-md);
  line-height: 1.75;
  color: var(--text);
  white-space: pre-wrap;
}
/* 对话里生成的那两种图先给一句"场景"(见 lib/chatWork)。它才是人读的那句;
   紧跟其后的整段摄影指令退到次级色与小一档 —— 那是要复现时才读的,
   两者平铺会让人以为这是两段并列的提示词 */
.prompt-scene {
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
  font-size: var(--fs-md);
  line-height: 1.7;
  color: var(--text);
  white-space: pre-wrap;
}
/* 那行小注:横在场景与完整提示词之间,说明下面那段是什么 */
.prompt-cap {
  margin-bottom: 4px;
  font-size: var(--fs-micro);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: var(--text-3);
}
/* 那行小注之后的那段:整段摄影指令退到次级色与小一档 ——
   要复现时才读它,与上面那句场景平铺会让人以为这是两段并列的提示词 */
.prompt-cap + .prompt {
  font-size: var(--fs-sm);
  color: var(--text-2);
}
/* 提示词不再折叠:内容长了就在 .prompt-scroll 里滚,不必先点一次「展开」 */
/* 底部操作并排,等分侧栏宽度,和顶部的胶囊形成一轻一重的收尾。
   留白已由 .block 的 flex: 1 吃掉,不再需要 margin-top: auto 把它顶到底 */
.side-actions {
  display: flex;
  /* 允许换行:「Edit on canvas」整行铺开,上面两枚仍在同一行并排 */
  flex-wrap: wrap;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
}
/* 独占整行(不计 gap 的 8px) */
.act.wide {
  flex: 1 0 100%;
}
.act {
  flex: 1;
  /* 图标 + 文案,所以用 flex 居中并给个间距:原来靠 text-align 居中,
     那一套对 flex 子项不再生效(全局 button 重置把 text-align 改成了 inherit) */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  /* 侧栏只有 320px,两个按钮各占一半 —— 左右各 16px 会让「As reference」挤到换行 */
  padding: 11px 12px;
  border-radius: var(--r-sm);
  font-size: var(--fs-base);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.act:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
/* 主操作用 --cta(黑药丸),与主页面发送键同一套 token:
   深色模式下它会自动反相成白底黑字,不用另写主题覆盖。
   accent 在这套设计里的职责是 AI 状态/高亮,不作为按钮底色。 */
.act.primary {
  background: var(--cta);
  color: var(--cta-text);
  border-color: var(--cta);
}
.act.primary:hover {
  background: var(--cta-hover);
  border-color: var(--cta-hover);
  box-shadow: 0 8px 22px -12px color-mix(in oklch, var(--cta) 55%, transparent);
}
.act svg {
  width: 16px;
  height: 16px;
  flex: none;
}

/* —— 灵感来源(创作链) ——
   一张卡里叠几行父记录:缩略图 + 提示词截断 + 右箭 */
.chain-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
/* 行与行之间一条发丝线,最后一行不画 */
.chain-row + .chain-row {
  border-top: 1px solid var(--line);
}
.chain-row:hover {
  background: var(--bg-elev);
}
.chain-thumb {
  flex: none;
  width: 34px;
  height: 34px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--line);
}
.chain-text {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: 1.45;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.chain-go {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--text-3);
}

/* —— 作品集 ——
   一行横铺的集卡片:封面 + 名字 + 张数。多了左右滑,不进第二行把侧栏撑高 */
.coll-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.coll-card {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  /* 宽度跟着标题走,但给个下限,免得只剩一个封面 */
  min-width: 112px;
  max-width: 168px;
  padding: 6px 10px 6px 6px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.coll-card:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
/* 当前这条归属的集:淡紫描边 + 浅底,一眼看出"就在这组里" */
.coll-card.on {
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  background: var(--accent-soft);
}
.coll-cover {
  flex: none;
  width: 30px;
  height: 30px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--line);
}
/* 还没图的集:一枚灰底图标占位,免得卡片高低不齐 */
.coll-cover-ph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elev);
  color: var(--text-3);
}
.coll-cover-ph svg {
  width: 14px;
  height: 14px;
}
.coll-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.coll-name {
  font-size: var(--fs-xs);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.coll-count {
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
}
/* 新建:虚线的"空卡",与已有的集并排但不抢注意力 */
.coll-new {
  border-style: dashed;
}
.coll-new .coll-name {
  color: var(--text-2);
}
/* 行内新建输入框:与卡片同高,回车即建 */
.coll-input {
  flex: none;
  width: 124px;
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid var(--accent);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--text);
  font-size: var(--fs-xs);
  outline: none;
}
.coll-confirm {
  flex: none;
  min-width: 0;
  min-height: 44px;
  justify-content: center;
  padding: 0 12px;
  border-color: var(--cta);
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-xs);
}
.coll-confirm:hover:not(:disabled) {
  border-color: var(--cta-hover);
  background: var(--cta-hover);
}
.coll-confirm:disabled {
  opacity: 0.5;
  cursor: default;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity var(--dur) var(--ease);
}
.modal-enter-active .preview,
.modal-leave-active .preview {
  transition: transform var(--dur) var(--ease);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .preview,
.modal-leave-to .preview {
  transform: scale(0.96) translateY(8px);
}

@media (max-width: 720px) {
  .mask {
    /* 手机上不再垂直居中:卡片几乎占满整屏,居中只会让它在
       "包含块比可视区大"的那种浏览器里整体下沉、下沿出屏。
       贴顶之后,底边只由卡片自己的高度决定 */
    align-items: flex-start;
  }
  .preview {
    /* 竖排后侧栏在下方,按比例推出来的宽度不再成立,直接铺满可用宽度 */
    width: 100%;
    /* 高度也一并交给可视区(92vh 在手机上靠不住,见上面 max-height 那条)。
       卡片于是正好占满"看得见的那一块",里面 .body 自己滚 */
    height: 100%;
  }
  /* 底部那三枚(Reuse / As reference / Edit on canvas)在竖排之后排在最下面,
     而这一屏的高度大半给了图片 —— 不吸底的话,一打开就只看得见图,
     要先在卡里滚一段才够得到它们,而"卡里还能滚"这件事本身没有提示。
     吸在滚动区下沿之后,无论滚到哪儿它们都在拇指这一侧。
     左右用负外边距补回 .side 的 16px,让这条横贯卡片整宽 */
  .side-actions {
    position: sticky;
    bottom: 0;
    z-index: 1;
    margin: 0 calc(-1 * var(--sp-4));
    padding: var(--sp-3) var(--sp-4);
    background: var(--bg);
    /* 上沿一道极淡的影:说明它下面是滚过去的内容,而不是到此为止 */
    box-shadow: 0 -10px 18px -14px rgba(0, 0, 0, 0.35);
  }
  /* 吸底之后那 24px 的收尾留白成了重复的一截 */
  .side {
    padding-bottom: var(--sp-3);
  }
  .body {
    grid-template-columns: 1fr;
    /* 窄屏改为上下堆叠:行高交还给内容,由 body 整体滚动 */
    grid-template-rows: auto auto;
    overflow-y: auto;
  }
  .stage {
    /* 竖排后这一行的高度由内容决定,图盒的 flex 高度会失去依据,
       所以这里给一个确定高度,顺带保证图片有足够的展示空间;
       缩略图行现在也在 stage 里,高度比之前多留一条(48vh → 56vh) */
    height: 56vh;
    min-height: 300px;
  }
  /* 触控目标放大到 40px:30px 在手机上容易点错 */
  .tbtn {
    width: 40px;
    height: 40px;
  }
  .tbtn svg {
    width: 18px;
    height: 18px;
  }
  /* 缩略图行两端的翻页键也一样 */
  .rail-nav {
    width: 40px;
    height: 40px;
  }
  /* 底部两个主次按钮同步加厚,与放大的图标按钮观感一致 */
  .act {
    padding: 13px 16px;
  }
  .side {
    border-left: none;
    border-top: 1px solid var(--line);
    overflow: visible;
  }
  /* 竖排后卡片高度由内容决定,「区域内滚」失去约束:
     取消 flex 分配与滚动,把高度交还给内容,整页滚更自然 */
  .block {
    flex: none;
  }
  .prompt-scroll {
    overflow-y: visible;
    /* 竖排后整页滚,卡内不再出滚动条,右侧也就不必再让出那 8px */
    padding: 10px 12px 0;
  }
  /* iOS Safari 聚焦字号 <16px 的输入框会放大整页,作品集新建框提到 16px */
  .coll-input {
    font-size: var(--fs-lg);
  }
}
</style>