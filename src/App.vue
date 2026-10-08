<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { PhSun, PhMoon, PhX } from '@phosphor-icons/vue'
import ImagePreview from './components/ImagePreview.vue'
import HistoryPage from './components/HistoryPage.vue'
import CharacterPage from './components/CharacterPage.vue'
import ChatPage from './components/ChatPage.vue'
import SettingsPage from './components/SettingsPage.vue'
import NavSegment from './components/NavSegment.vue'
import UndoToast from './components/UndoToast.vue'
import {
  generate,
  uid,
  loadConfigs,
  /* 设定图的提示词由 api.ts 那份纯函数拼(设定 + 取景 + 参考图那句)——
     它是那五格提示词的唯一出处,单测直接断言 */
  characterViewPrompt,
  loadCharacters,
  saveCharacters,
  exportCharacter,
  readCharacterZip,
  getProvider,
  vendorOf,
  coverSrc,
  releaseSrc,
  CHARACTER_VIEWS
} from './api'
import {
  blobToDataURL,
  // 这些由删角色连带删对话、角色设定图/嗓音样本与角色导入用着
  deleteChatOf,
  getCharViews,
  putCharView,
  deleteVoiceSample,
  putChatImage
} from './lib/idb'
import { NAV_ITEMS, type Page } from './lib/nav'
import { formatHash, parseHash } from './lib/router'
import { useFeedback } from './composables/useFeedback'
import { useConfigs } from './composables/useConfigs'
import { useHistory } from './composables/useHistory'
import { useCharacters } from './composables/useCharacters'
import { useChat } from './composables/useChat'
import { useChatFlow } from './composables/useChatFlow'
import { useGeneration } from './composables/useGeneration'
// 另一个标签页改了 localStorage 里的目录时,本页要跟着重载(见 lib/crossTab.ts)
import {
  openSyncChannel,
  syncTargetsOf,
  type SyncChannel,
  type SyncKind,
  type SyncMessage
} from './lib/crossTab'
// 角色参考图的尺寸上限(角色发图、设定图两条路都从它取)
import { REF_IMAGE_EDGE } from './lib/payload'
import {
  applyTheme,
  currentTheme,
  saveTheme,
  watchSystemTheme,
  type Theme
} from './lib/theme'
/* 界面偏好(不是数据)。与主题同一类:不跨标签页同步,丢了不影响任何东西 */
import { saveImmersive, savedImmersive } from './lib/prefs'
/* 对话背景图:沉浸页铺满屏幕的那一张。**单独一张表**(见 idb.ts 的 BACKDROP_STORE) */
import {
  deleteChatBackdrop,
  getChatBackdrop,
  putChatBackdrop,
  type ChatBackdrop
} from './lib/idb'
import type { HistoryEntry, Character, CharacterFields, CharacterPersona, CharacterViewKind, CharacterVoice, ImportedCharacter } from './types'

// —— 状态 ——
/* 反馈三通道(错误 / 中性提示 / 删除撤销)收在 composables/useFeedback.ts ——
   它们是每一块业务域都要用的东西,留在主界面里会让后面每抽一个域都反向依赖它 */
const {
  error,
  notice,
  clearNotice,
  holdNotice,
  releaseNotice,
  pendingUndo,
  UNDO_MS,
  scheduleUndo,
  commitUndo,
  runUndo
} = useFeedback()

/* 接口配置这一域(列表 / 五类当前生效 / 能力派生 / 增删改与导入导出)收在
   composables/useConfigs.ts —— 它只依赖「删除的撤销窗口」与「怎么进设置页」两件事 */
const {
  configs,
  config,
  activeId,
  textConfig,
  activeTextId,
  chatConfig,
  chatBorrowed,
  activeChatId,
  visionConfig,
  activeVisionId,
  ttsConfig,
  activeTtsId,
  cfgView,
  cfgSeed,
  chatConfigs,
  provider,
  capabilityNote,
  configured,
  initConfigs,
  repickActiveImage,
  repickActiveText,
  repickActiveChat,
  repickActiveVision,
  repickActiveTts,
  activateConfig,
  activateTextConfig,
  activateChatConfig,
  activateVisionConfig,
  activateTtsConfig,
  newConfig,
  duplicateConfig,
  editConfig,
  cancelConfig,
  saveSettings,
  removeConfig,
  importConfigs
} = useConfigs({
  scheduleUndo,
  // 从参数面板进设置页:切页与收起面板都归主界面
  enterSettings: () => {
    page.value = 'settings'
    openPanel.value = ''
  }
})


/* 历史 / 作品集这一域收在 composables/useHistory.ts ——
   它只依赖「广播给别的标签页」「删除的撤销窗口」「中性提示」三件事 */
const {
  history,
  collections,
  initHistory,
  initCollections,
  reloadHistoryFromDb,
  reloadCollectionsFromDb,
  persist,
  removeHistoryEntry,
  toggleMark,
  createCollection,
  deleteCollection,
  assignCollectionTo,
  createAndAssign
} = useHistory({ announce, scheduleUndo, notice })

/* —— 角色 ——
   一个角色 = 一组设定图 + 一段固定描述。目录(名字/描述)放 localStorage,
   图是 Blob,按 id 存在 IndexedDB(见 api.ts 的 loadCharacters)。
   角色是独立的输入:它只在发请求那一刻并进参考图一起送(见 charRefSrcs) */
/* 角色这一域(目录 / 设定图缓存 / 读取侧原语)收在 composables/useCharacters.ts。
   写入那一侧(saveCharFromPage / deleteChar / duplicateChar / genCharView /
   导入导出)暂时留在主界面:它们要么跨到对话域(删角色连带删对话、导出带上记忆),
   要么要动页面切换 —— 归属没定清之前先不搬 */
const {
  characters,
  activeCharId,
  charViews,
  charViewBusy,
  charViewControllers,
  charPageRef,
  charViewKey,
  charStats,
  charWorks,
  normalizeChar,
  detachCharacter,
  viewOf,
  viewSize,
  charImageBlob,
  resultRefBlob,
  reBlob,
  charRefSrcsOf,
  stopCharView,
  loadCharViews,
  reloadCharViewsFromDb
} = useCharacters({
  history,
  provider,
  /* 挖不出合适档位时退回的那一档。KImage 那份这里读的是创作区当前尺寸,
     而那个工作台已经删了 —— 设定图那条路本来就按比例挑帧(见 useCharacters
     的 viewSize),挑不出来交给 auto 就行 */
  coverSize: () => 'auto',
  // 角色图要给人看,走显示级压缩那条路
  compressImage
})

/* 对话这一域分两处:非流式那一半（消息、长期记忆、清空、导入导出）收在
   composables/useChat.ts;**流式那一轮**（进对话页挑人 / 发一句 / 重生成 /
   停止 / 出图调度 / 单条删除的撤销）现在收在 composables/useChatFlow.ts */
const {
  chatCharId,
  chatMessages,
  chatHasMore,
  chatSummary,
  chatMood,
  chatLast,
  chatLastReady,
  chatBusy,
  chatControllers,
  bumpChatSeq,
  chatSeqOf,
  loadChatLast,
  setChatLast,
  setChatMood,
  dropChatMood,
  dropChatLast,
  loadChatMessages,
  loadEarlierChat,
  maybeSummarize,
  editChatSummary,
  forgetChatSummary,
  readChatForExport,
  writeImportedChat,
  clearChat
} = useChat({ characters, chatConfig, notice, announce, scheduleUndo })

/* —— 页面落在哪一页:由 hash 说了算(见 lib/router.ts) ——
   页面与对话对象都进地址栏,于是刷新不再回到首页,某段对话也能直接把链接发给别人。
   两个方向各管一头:这里读进来,下面的 watch 写回去;用户手改地址或按前进后退
   则由 onHashChange 接住 */
const initialRoute = parseHash(typeof window !== 'undefined' ? window.location.hash : '')
const page = ref<Page>(initialRoute.page)
if (initialRoute.id && initialRoute.page === 'chat') {
  chatCharId.value = initialRoute.id
}

/* 状态变了就写回地址栏。用 replaceState 而不是 pushState:这些变化
   (切页、换对话对象)每一步都进历史栈的话,用户按一次后退只退回上一个 tab,
   而返回上一页这个动作本身就被埋掉了 */
watch([page, chatCharId], ([p, cid]) => {
  if (typeof window === 'undefined') return
  const id = p === 'chat' && cid ? cid : undefined
  const targetHash = formatHash(p, id)
  if (window.location.hash !== targetHash) {
    window.history.replaceState(null, '', targetHash)
  }
})

/* 反方向:用户手改地址、或按了前进后退。**只认 hash**,不碰别处状态 */
function onHashChange() {
  const { page: p, id } = parseHash(window.location.hash)
  if (page.value !== p) page.value = p
  if (id && p === 'chat' && chatCharId.value !== id) {
    chatCharId.value = id
  }
}

/* —— 沉浸式对话页 ——
   它是**同一个对话页的第二种骨架**,不是第二个页面:状态、消息、输入、流式全复用,
   只换外层 chrome(见 doc/沉浸式对话页面设计.md)。

   两个状态而不是一个,是因为它们回答的问题不同:
   - `immersive` 是**用户的偏好**(存盘,离开这一页也不变);
   - `immersiveOn` 是**此刻这一页长什么样** —— 顶栏是全站唯一去别的页的入口,
     所以只要不在对话页,chrome 就必须回到普通。偏好留着,下次进对话页直接生效。 */
const immersive = ref(savedImmersive())
const immersiveOn = computed(() => immersive.value && page.value === 'chat')
function toggleImmersive() {
  immersive.value = !immersive.value
  saveImmersive(immersive.value)
}

/* —— 对话背景图 ——
   沉浸页铺满屏幕的那一张,**与设定图、参考图、消息里的图各存各的**
   (用户特意交代过)。它按"当前这一场戏"画:戏换了就该换一张。

   三条刻意的取舍(**2026-10-05 改过一次,见下**):
   - **只有用户点 `⋮` 里的 New background 才画**。原先写的是"进沉浸页时才画 ——
     那一页要它,别的时候不花这个钱",但"进页面"本身不是花钱的理由:
     用户 2026-10-05 明确说"不需要每次进入沉浸页面就自动生图,只有我点击的时候
     才重新生成"。所以进沉浸页、换角色、对话里换了一场戏,一律**只把库里那张
     读回来铺上**,不再自动出图;
   - **一场戏一张,存在库里**:画过的留在 `chat_backdrops`,下次进来直接铺,
     反复进出不会重复付费;想换一张就再点一次;
   - **失败如实说**:它现在是一条用户主动触发的动作,静默失败会让人以为按钮坏了 */
const backdrops = ref<Record<string, ChatBackdrop>>({})
const backdropBusy = ref<Record<string, boolean>>({})

/* 正在重画的那几张图,按**消息 id** 记(不是按角色 —— 同一段对话里可以有好几张图,
   而"这一张在画"是那一条消息自己的状态)。
   为什么非要有它:重画一张**已经画好**的图时,photoId 还在、旧图照旧显示,
   于是"正在重画"在界面上本来没有任何痕迹 —— 用户点完看不出发生了什么,
   还能连点好几次。它只喂给那一枚重画键(见 ChatPage 的 .photo-redraw) */
const chatPhotoBusy = ref<Record<string, boolean>>({})

/** 当前这一场戏的描述:最后一条**已经画出来**的剧照写的那段场景。
 *  与沉浸页头部那行、以及背景本身取自同一条消息(三处必须一致) */
function currentScene(id: string): string {
  const list = chatMessages.value[id] || []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.photoId && m.photo) return m.photo
  }
  return ''
}

/** 用户手动要一张新的背景图(沉浸页 `⋮` 里那条 New background)。
 *
 *  **这是唯一会为背景图花钱的入口**(见上面那段)。所以几处提前收手都要
 *  说清原因 —— 点一下什么都没发生,比失败更让人摸不着头脑:
 *  - 还没有场景(它还没发过图):告诉他先让它发一张;
 *  - 没配出图那条接口:与别的出图入口同一句话;
 *  - 正在画:不叠第二次,静默(界面那一刻本来就写着"Drawing…")。 */
async function drawBackdrop(id: string) {
  if (!id || backdropBusy.value[id]) return
  const scene = currentScene(id)
  if (!scene) {
    notice.value = 'Nothing to draw from yet — let it send you a photo first.'
    return
  }
  const cfg = config.value
  if (!cfg.baseUrl) {
    notice.value = 'Set an image API in Settings first.'
    return
  }

  const had = backdrops.value[id]
  backdropBusy.value = { ...backdropBusy.value, [id]: true }
  try {
    const out = await generateChatBackdrop(id, scene)
    if (!out.blob) {
      notice.value = out.error || 'Could not draw a background for this scene.'
      return
    }
    /* 换掉旧的那张:它不再被界面引用,连同 objectURL 一起放掉 */
    const stale = had?.blob
    const rec: ChatBackdrop = { charId: id, scene, blob: out.blob, createdAt: Date.now() }
    backdrops.value = { ...backdrops.value, [id]: rec }
    await putChatBackdrop(rec)
    if (stale && stale !== rec.blob) releaseSrc(stale)
    /* 背景图也进历史(见 saveChatWork):它同样是这个角色的一张作品。
       从前它只活在库里那一条记录上 —— 换一场戏就被下一张顶掉,
       画它花的钱也就跟着没了,用户再也找不回来 */
    await saveChatWork(id, out, 'chat-backdrop', scene)
  } finally {
    const rest = { ...backdropBusy.value }
    delete rest[id]
    backdropBusy.value = rest
  }
}

/* 进沉浸页 / 换角色:把库里那张背景读回来铺上。
   **只读不画** —— 要新的得自己点 New background(见 drawBackdrop)。
   没有现成的就退到剧照 → 正脸 → 底图 → 主题色(见 ChatPage 的 bgSrc) */
watch(immersiveOn, (on) => {
  if (!on || !chatCharId.value) return
  void loadBackdrop(chatCharId.value)
})
watch(chatCharId, (id) => {
  if (!id) return
  void loadBackdrop(id)
})
/* 对话里又出了一张新剧照 = 换了一场戏。**这里刻意什么都不做** ——
   自动重画正是用户 2026-10-05 要去掉的那件事 */
/* 进页面时把库里那张读回来(每个角色一张,一次读完不心疼) */
async function loadBackdrop(id: string) {
  if (!id || backdrops.value[id]) return
  const rec = await getChatBackdrop(id)
  if (rec) backdrops.value = { ...backdrops.value, [id]: rec }
}
/* 背景图给界面的那一份地址(按 Blob 缓存,与头像那张共用一套) */
const backdropSrc = computed(() => {
  const rec = backdrops.value[chatCharId.value]
  return rec ? coverSrc(rec.blob) : ''
})
const previewEntry = ref<HistoryEntry | null>(null)
/* 预览打开时落在第几张。与 previewEntry 一起设:历史页是按张摊平的,
   "点的是哪一张"是打开动作的一部分,不该由预览卡自己从头数 */
const previewIndex = ref(0)

/** 角色 id → 名字。历史搜索要按"跟谁那张"找,而记录里存的是 id ——
 *  这份反查表由主界面给历史页(角色目录本来就在这边手上),那一页不碰它 */
const charNames = computed(() =>
  Object.fromEntries(characters.value.map((c) => [c.id, c.name]))
)

/* 顶部横条的实际高度,写进 --mast-h 给沉浸页的聊天区用。
   导航条是最顶层、每一页都在,让出多少高度得知道。
   不能写死:窄屏下这条会从一行变成两行,高度跟着变 */
const mastEl = ref<HTMLElement | null>(null)
let mastRO: ResizeObserver | null = null
onMounted(() => {
  const el = mastEl.value
  if (!el || typeof ResizeObserver === 'undefined') return
  const sync = () =>
    document.documentElement.style.setProperty('--mast-h', `${el.offsetHeight}px`)
  sync()
  mastRO = new ResizeObserver(sync)
  mastRO.observe(el)
})
onBeforeUnmount(() => mastRO?.disconnect())

/* 参数面板的开合状态。KImage 那份里它是创作区那排参数图标的状态机,
   这里只剩"进设置页时顺手收起"这一个用途(见 useConfigs 的 enterSettings
   与 useChatFlow 的 openChatConfigSettings),所以类型收成普通字符串 */
const openPanel = ref('')

/* 出图这一层只服务对话:角色发的那张照片 + 沉浸页的背景图
   (见 composables/useGeneration.ts) */
const { generateChatPhoto, generateChatBackdrop, recordFor } = useGeneration({
  config,
  textConfig,
  characters,
  charRefSrcsOf,
  compressImage
})

// —— 主题 ——
/* 初值必须与 main.ts 同一套口径(存档优先、否则跟随系统)。
   原来这里只认存档、没有就硬当浅色,于是系统是深色且用户没手动设过时:
   页面已是深色,按钮却显示"切到深色",点一下毫无变化 —— 要连点两次才对 */
const theme = ref<Theme>(currentTheme())
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme(theme.value)
  saveTheme(theme.value)
}
/* 系统里切深浅色,页面要跟着走(用户手动设过就不再跟,见 watchSystemTheme) */
let unwatchSystemTheme: (() => void) | null = null
onMounted(() => {
  unwatchSystemTheme = watchSystemTheme((t) => {
    theme.value = t
    applyTheme(t)
  })
})
onBeforeUnmount(() => unwatchSystemTheme?.())

// —— 顶部导航滚动状态:页面一滑动就浮出毛玻璃底,避免与内容糊在一起 ——
const scrolled = ref(false)
function onScroll() {
  scrolled.value = window.scrollY > 4
}
onMounted(() => {
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
})
onBeforeUnmount(() => window.removeEventListener('scroll', onScroll))
onBeforeUnmount(() => window.removeEventListener('storage', onStorageSync))
onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange))
onBeforeUnmount(() => syncChannel?.close())

/* —— 顶部导航(分段控件) ——
   条目清单在 lib/nav.ts(导航与字标共用那一份)。这里只留状态:
   视图状态只有 page 一份,navView 只是把它的类型收紧回联合类型
   (分段控件的 v-model 说的是普通字符串)。
   必须放在 page 声明之后:getter 引用了它 */
const navView = computed({
  get: () => page.value as string,
  set: (v: string) => {
    /* 认过再写:主区是几个 v-if 铺出来的,page 落到清单外的值上,整页就是空白
       (没有任何兜底分支)。控件那边给的都是清单里的值,但这是唯一的入口,
       在这里收一次窄,比给每个分支补 v-else 划算 */
    if (NAV_ITEMS.some((i) => i.value === v)) page.value = v as Page
  }
})
/* 字标里跟在 Kairo 后面那一截:当前在哪一页。
   名字取自导航那份清单(lib/nav.ts),不另抄一份 */
const wordmarkSuffix = computed(() => NAV_ITEMS.find((i) => i.value === page.value)?.label ?? '')
// 切视图后回到顶部:否则在某一页滚到一半再切过去,新页面会停在半空
watch(navView, () => window.scrollTo({ top: 0 }))

onMounted(() => {
  // 五类「当前生效」的启动挑选(含「存的 id 已失效 / 用途被改」的回退)
  initConfigs()
  // 两份目录:历史(含缩略图后台补齐)与作品集
  void initHistory()
  initCollections()
  // 角色要连 IndexedDB 里的参考图一起取,所以是异步的
  loadCharacters().then((list) => {
    characters.value = list.map(normalizeChar)
    /* 左栏那行"最后说了什么"需要每个角色各读一条 ——
       没打开过的角色在 chatMessages 里没有键,光靠它是读不到的(见 loadChatLast)。
       启动时补一趟就够:之后每一句都由 sendChat / runChat 就地更新 */
    void loadChatLast()
  })
  window.addEventListener('storage', onStorageSync)
  window.addEventListener('hashchange', onHashChange)
  /* 记录与字节那一侧走广播(BroadcastChannel)。它与上面的 storage 事件
     互不重复:那个管被整份覆盖写的目录,这个管 IndexedDB 里的记录 */
  syncChannel = openSyncChannel((batch) => void handleRemoteSync(batch))
})

/* 跨标签页广播:另一页改了 IndexedDB 里的东西(历史/设定图/对话)时,
   本页把受影响的那一类重读一遍。localStorage 那条(storage 事件)只管目录,
   改记录与字节不会触发它 —— 见 lib/crossTab.ts 的说明 */
let syncChannel: SyncChannel | null = null
function announce(kind: SyncKind, charId?: string) {
  syncChannel?.post(charId ? { kind, charId } : { kind })
}

/* —— 跨标签页同步 ——
   localStorage 里的目录都是整份覆盖写的(见 api.ts 的 save* 那几个)。
   两个标签页同时开着,A 页删掉一个角色,B 页内存里还留着旧目录,
   于是 B 页下一次保存会把它整个写回去 —— 用户看到的是"删掉的又回来了"。
   storage 事件只在**其他**标签页写入时触发,正好是我们要的信号。
   处理方式就是把受影响的那份目录重读一遍(见 lib/crossTab.ts 的取舍说明)。 */
function onStorageSync(e: StorageEvent) {
  const targets = syncTargetsOf(e.key)
  if (!targets.length) return
  const labels: string[] = []

  if (targets.includes('configs')) {
    configs.value = loadConfigs()
    // 重挑五类的「当前生效」:另一个标签页可能把当前那条删了或改了用途
    repickActiveImage()
    repickActiveText()
    repickActiveChat()
    repickActiveVision()
    repickActiveTts()
    labels.push('API settings')
  }
  if (targets.includes('characters')) {
    loadCharacters().then((list) => {
      characters.value = list.map(normalizeChar)
      // 目录变了,左栏那行"最后说了什么"也要跟着对齐
      void loadChatLast()
    })
    labels.push('characters')
  }
  if (targets.includes('collections')) {
    reloadCollectionsFromDb()
    labels.push('collections')
  }

  /* 说一声。不说的话用户只会觉得"我明明没动,列表却变了" ——
     这是同步本身带来的观感问题,不是噪音 */
  notice.value = `Updated from another tab — reloaded ${labels.join(' and ')}.`
}

/* —— 另一页改了 IndexedDB 里的东西 ——
   粒度是"哪一类变了",收到就把那一类重读一遍。重读是幂等的,所以消息即使
   合并、乱序或重复也不会让两端对不上 —— 代价只是多读几条记录 */
async function handleRemoteSync(batch: SyncMessage[]) {
  const labels: string[] = []

  if (batch.some((m) => m.kind === 'history')) {
    await reloadHistoryFromDb()
    labels.push('history')
  }

  const viewIds = batch.filter((m) => m.kind === 'charViews').map((m) => m.charId)
  if (viewIds.length) {
    /* 没带 charId 的(删角色)就把已缓存的都过一遍 —— 反正只动内存里已有的那几格 */
    const ids = viewIds.some((id) => !id) ? Object.keys(charViews.value) : (viewIds as string[])
    for (const id of ids) await reloadCharViewsFromDb(id)
    labels.push('characters')
  }

  const chatIds = batch.filter((m) => m.kind === 'chat').map((m) => m.charId).filter(Boolean) as string[]
  if (chatIds.length) {
    for (const id of chatIds) await reloadChatFromDb(id)
    labels.push('conversations')
  }

  if (labels.length) {
    notice.value = `Updated from another tab — reloaded ${[...new Set(labels)].join(' and ')}.`
  }
}

/** 重读历史。**合并而不是整份替换**,理由见 api.ts 的 mergeHistory */
/** 重读某个角色的设定图。缓存那一格本身就是"已加载过"的标记(loader 见到就返回),
 *  所以要先把这一格丢掉再取 */
/** 重读某个角色的对话。**正在流式说话时跳过**:库里的副本还没有刚落下的这句,
 *  重读会把流式的正文抹掉 —— 那一轮说完还会再广播一次,那时再对齐也不迟 */
async function reloadChatFromDb(id: string) {
  if (chatBusy.value[id]) return
  const drop = <T>(rec: Record<string, T>) => {
    const next = { ...rec }
    delete next[id]
    return next
  }
  chatMessages.value = drop(chatMessages.value)
  chatHasMore.value = drop(chatHasMore.value)
  /* 记忆也要先摘掉:loadChatMessages 只在"库里有"时才写回这一格,
     另一页刚点了"忘记"的话,留着旧的那份会让本页继续拿旧记忆说话 */
  chatSummary.value = drop(chatSummary.value)
  await loadChatMessages(id)
  // 左栏那行"最后说了什么"同样要跟上
  await loadChatLast()
}

/* 用 canvas 压缩图片:超过 maxEdge 的最长边等比缩放,透明图铺白底,输出 JPEG。
   force = 即使是"本来就小于上限"的图也重编码一遍 —— 默认不这么做是为了
   让调用方能把没缩过的原始载荷原样留下(画质一点不丢);
   但原图如果是 PNG(模型给的多半是),原样留下就是 1MB 上下,那时才需要 force */
function compressImage(
  dataUrl: string,
  maxEdge = REF_IMAGE_EDGE,
  quality = 0.85,
  force = false
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      const scale = Math.min(1, maxEdge / Math.max(width, height))
      if (scale >= 1 && !force) return resolve(dataUrl) // 本来就小,原样保留
      width = Math.round(width * scale)
      height = Math.round(height * scale)
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      const ctx = c.getContext('2d')
      if (!ctx) return resolve(dataUrl)
      ctx.fillStyle = '#fff' // 透明 PNG 转 JPEG 时铺白底,避免变黑
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      resolve(c.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}
/* —— 角色 ——
   一个角色 = 一组设定图 + 一段固定描述 + 人格与嗓音。目录(名字 / 描述)放
   localStorage,图是 Blob,按 id 存在 IndexedDB(见 api.ts 的 loadCharacters)。
   设定图那条链与对话都用它 —— 前者拿它当参考图,后者拿它当"这个人是谁"。 */

/** 读进来时校正一下角色记录,顺带补上后来才有的字段。
 *
 *  底图(sourceRef)是"其余四张要拿它当参考"之后才单独存的一份。在这之前,
 *  记录里只有 ref,它装的是这两者之一:上传的底图,或某张设定图提升来的副本 ——
 *  而 refKind 正好是这两者的标记(有值说明 ref 是某张视图的副本)。
 *  所以只有不带 refKind 的老记录,它的 ref 才是真底图,可以补进 sourceRef。
 *  反过来,refKind 是 'front' 的那种拿不回底图:那张早被正脸顶掉了。
 *
 *  主视图只能是正面 —— 老数据里可能留着被设成别张的 refKind(那个功能已经去掉),
 *  清掉即可。ref 不动:它是这张角色的封面,丢了卡片就只剩占位图标 */
/* 存角色这条链不算快(参考图要压缩、角色要落 IndexedDB),而第 1 步那个按钮
   在等待期间仍可点 —— 连点两下就会建出两个角色,第一个还没有任何界面引用它。
   所以做一次幂等。判定放在这个唯一的写入入口上,而不是角色页那个按钮上 */
let savingChar = false

/** 存下角色页交过来的草稿:带 id 是改这一条,不带就是新建。
 *  名字必填 —— 没名字的卡没法认 */
async function saveCharFromPage(d: {
  /* 带 id = 改这一条,不带 = 新建。角色页那边按"向导里有没有正在编辑的对象"给 */
  id?: string
  name: string
  fields: CharacterFields
  desc: string
  /* 人格设定。与 fields 分开进(见 types.ts 的 CharacterPersona)——
     它只服务对话,不该混进任何出图的提示词 */
  persona: CharacterPersona
  /* 嗓音。与 persona 同一条理由:只服务对话。它比 persona 多一层 ——
     clone 档会在库里留下一段样本音频(按 sampleId 认领) */
  voice: CharacterVoice
  refData: string
}) {
  const name = d.name.trim()
  if (!name || savingChar) return
  savingChar = true
  try {
    /* 上传的参考图会当角色卡封面直接铺出来,所以按显示级存(见 CHAR_IMAGE_MAX),
       不走那条"只喂给模型"的 refThumbOf —— 512 做卡面一眼就糊 */
    const ref = d.refData ? await charImageBlob(d.refData) : undefined

    /* —— 改一条已有的 ——
       名字与设定照单更新;参考图只有真换了才动(refData 为空 = 没换那张)。
       封面 ref 一律不碰:它要么是生成出来的正脸,要么是这张角色最初那张图 ——
       换一张参考图不该顺手把脸也换掉 */
    if (d.id) {
      const c = characters.value.find((x) => x.id === d.id)
      if (!c) return
      /* 备注也算设定的一部分:它同样会拼进提示词(见 characterDesc),
         改它的效果和改某一栏字段是一样的 */
      const before = JSON.stringify({ ...(c.fields || {}), desc: c.desc || '' })
      c.name = name
      c.fields = { ...d.fields }
      c.desc = d.desc.trim()
      c.persona = { ...d.persona }
      /* 换音色时旧的那段克隆样本要跟着清掉 —— 留着就是一段没人认领的录音。
         只在"换了另一个样本"时清:同一个 sampleId 再存一次当然不动它 */
      const prevSample = c.voice?.sampleId
      const nextSample = d.voice.sampleId
      c.voice = { ...d.voice }
      if (prevSample && prevSample !== nextSample) void deleteVoiceSample(prevSample)
      if (ref) c.sourceRef = ref
      await saveCharacters(characters.value)
      /* 改的可能只是一个名字,也可能把脸改了。设定动了就得说一声 ——
         那五张设定图是按旧设定生成的,不提示的话用户会以为它们跟着一起变了。
         一张视图都没有时不必说这句:没有"旧的"可以重跑 */
      const hasViews = (charViews.value[c.id] || []).length > 0
      notice.value =
        hasViews && before !== JSON.stringify({ ...d.fields, desc: c.desc })
          ? 'Saved. The reference views were made from the old spec — regenerate them if the face changed.'
          : `Saved “${c.name}”.`
      /* 编辑没有第 2、3 步要走,收尾就是回到这个人自己的详情页 */
      charPageRef.value?.onUpdated(c.id)
      return
    }

    const c: Character = {
      id: uid(),
      name,
      createdAt: Date.now(),
      fields: { ...d.fields },
      desc: d.desc.trim(),
      persona: { ...d.persona },
      voice: { ...d.voice },
      /* 这一张同时是封面的底图(正脸出来之前先用它顶着)和"第一步的参考图"。
         两者指向同一个 Blob,但语义不同,所以两个字段都写 ——
         正脸生成后封面会被换成正脸,而参考图那份还得留着给其余四张用 */
      ...(ref ? { ref, sourceRef: ref } : {})
    }
    characters.value = [c, ...characters.value]
    await saveCharacters(characters.value)
    /* 存完把 id 交回角色页,让向导推进到"主视图"那一步。
       这里不负责跳转 —— 向导的步数归角色页自己管 */
    charPageRef.value?.onSaved(c.id)
  } finally {
    // 失败时也要松开,否则按钮从此点不动
    savingChar = false
  }
}

/* 置顶 / 取消置顶。
 *
 *  与删除、复制不同,**它不进撤销窗口**:置顶只是把这个人挪到列表最前面,
 *  一眼看得见、再点一次就回去了,没有"说没就没"的风险 ——
 *  给它配一条撤销条反而会让一次轻量操作显得很重(与标记一张图同一个分寸)。
 *
 *  直接落盘:置顶的意义就是下次打开还在最前面,缓冲一步再写没有好处。 */
async function togglePinChar(id: string) {
  const c = characters.value.find((x) => x.id === id)
  if (!c) return
  c.pinned = !c.pinned
  /* 取消置顶时把字段删掉而不是写 false:老角色与"从没置顶过"在数据里
     保持同一种形状,导出的包也才不会被一个 false 撑出一项 */
  if (!c.pinned) delete c.pinned
  await saveCharacters(characters.value)
  notice.value = c.pinned ? `Pinned “${c.name}”.` : `Unpinned “${c.name}”.`
}

/* 删掉一个角色。与别处(提示词 / 配置 / 历史)同一套:
   立刻从列表消失、几秒内可撤销,真正落盘发生在窗口结束时。
   落盘那一步顺带把它的图一起收走 —— saveCharacters → putCharRefs 是按 key 归属
   清理的,角色不在了,它的主参考图与五张设定图会一并删掉(见 idb.ts) */
function deleteChar(id: string) {
  const at = characters.value.findIndex((c) => c.id === id)
  if (at < 0) return
  const gone = characters.value[at]
  const wasActive = activeCharId.value === id
  // 与 activeCharId 同一处理:留着一个已不在的角色 id,对话页会指着一段没人认领的历史
  const wasChatting = chatCharId.value === id
  characters.value = characters.value.filter((c) => c.id !== id)
  /* 这一条不能等窗口结束:当前套用的角色是个 id 引用,
     留着一个已经不在列表里的 id,下一次生成会莫名多出一段角色描述 */
  if (wasActive) detachCharacter()
  if (wasChatting) chatCharId.value = ''

  scheduleUndo({
    label: 'Character deleted',
    undo: () => {
      // 放回原来的位置:列表顺序有意义(最近建的在前)
      characters.value.splice(Math.min(at, characters.value.length), 0, gone)
      // 恢复「当前套用的角色」—— 它当初是被这次删除夺走的,现在物归原主
      if (wasActive) activeCharId.value = id
      if (wasChatting) chatCharId.value = id
      /* 撤销要立刻落盘:窗口里别的操作可能已经把"它不在"写进去了。
         图是整批按归属清理的,所以这一步同时保住它的主图与设定图 */
      saveCharacters(characters.value)
    },
    purge: () => {
      /* 到这里才真正落盘删除,同时把图从内存里放掉 ——
         卡片的 object URL 由弱引用表带出,不收就等于把一个已删角色的
         六张图一直留在内存里(见 idb.ts 与 api.ts 的 releaseSrc) */
      for (const v of charViews.value[id] || []) releaseSrc(v.data)
      releaseSrc(gone.ref)
      /* 底图是**另一个** Blob:正脸生成成功时 ref 会被换成正脸,那时两者就不再
         指向同一个实例了 —— 只收 ref 会把底图那张的地址留在弱引用表里 */
      releaseSrc(gone.sourceRef)
      /* 克隆用的那段录音也跟着走。它与图不同 —— 那是**用户的录音**,
         角色没了还把它留在库里,既没人认领也不该留。同样放这一步:
         撤销回来时它还得在 */
      if (gone.voice?.sampleId) void deleteVoiceSample(gone.voice.sampleId)
      const rest = { ...charViews.value }
      delete rest[id]
      charViews.value = rest
      // 别的标签页若缓存着这个角色的设定图或对话,也要把它们放掉
      announce('charViews', id)
      announce('chat', id)
      /* 对话跟着角色一起走:人没了,跟他聊的那一段留着也没有对象了。
         放在这一步(真正落盘)而不是点删除那一刻 —— 撤销回来时对话还得在。
         **附图不在这里数**:deleteChatOf 会按 charId 把该角色的消息整批读出来,
         把 imageId 与 photoId 一并收掉。从前这里只遍历内存里那一档(最近 200 条)
         且只认 imageId —— 更早的附件与角色发的每一张图都成了孤儿 */
      chatControllers.get(id)?.abort()
      chatControllers.delete(id)
      const chatRest = { ...chatMessages.value }
      delete chatRest[id]
      chatMessages.value = chatRest
      const moreRest = { ...chatHasMore.value }
      delete moreRest[id]
      chatHasMore.value = moreRest
      /* 在途的压缩也要作废 —— 它会往一份已经没人认领的记忆里写。
         deleteChatOf 连记忆一起清,所以这里不用再单独删一次库里的那份 */
      bumpChatSeq(id)
      const sumRest = { ...chatSummary.value }
      delete sumRest[id]
      chatSummary.value = sumRest
      /* 心情同理:人没了,它此刻恼不恼也没有承载者了(库里那条由 deleteChatOf 收) */
      dropChatMood(id)
      dropChatLast(id)
      void deleteChatOf(id)
      /* 背景图也一起走:它属于这个角色这一场戏,角色没了就没有"这一场"了 */
      void deleteChatBackdrop(id)
      const bgRest = { ...backdrops.value }
      delete bgRest[id]
      backdrops.value = bgRest
      saveCharacters(characters.value)
    }
  })
}

/** Blob 的切片:拿到一个指向同一批字节、但**实例是新的** Blob。
 *  复制角色时必须换实例 —— 两个角色共用同一个 Blob 会共用同一个 object URL,
 *  一边撤销(见 deleteChar 的 purge / releaseSrc)另一边正在显示的图就裂了。
 *  slice 不复制底层字节,只多一个引用 */
async function duplicateChar(id: string) {
  const at = characters.value.findIndex((c) => c.id === id)
  if (at < 0) return
  const src = characters.value[at]
  const copy: Character = {
    id: uid(),
    name: `${src.name} copy`,
    createdAt: Date.now(),
    ...(src.fields ? { fields: { ...src.fields } } : {}),
    ...(src.desc ? { desc: src.desc } : {}),
    /* 置顶**刻意不拷**:它是"我常找的就是这一个",而不是这个角色的一部分 ——
       复制出来的是另一个人,不该也占着最前面那一格 */
    /* 人格与嗓音一起拷。它们与设定同属"这个人是谁"——
       复制一个角色的意思本来就是"同一副皮囊、同一个性格,拿去改点别的",
       不拷这两样的话,复制出来的是个没性格也没嗓子的陌生人。
       (人格这一项在加嗓音之前一直漏着,一起补上) */
    ...(src.persona ? { persona: { ...src.persona } } : {}),
    /* 嗓音照拷,但**丢掉 sampleId** —— 那段录音属于原件。
       共用同一个 id 的话,删掉其中一个角色会把另一个的样本也清掉。
       留着 vendorVoice 就够合成用了,副本只是不能再"重新克隆"那一手 */
    ...(src.voice ? { voice: { ...src.voice, sampleId: undefined, sampleName: undefined } } : {}),
    ...(src.ref ? { ref: reBlob(src.ref) } : {}),
    ...(src.sourceRef ? { sourceRef: reBlob(src.sourceRef) } : {}),
    ...(src.refKind ? { refKind: src.refKind } : {})
  }
  const known = new Set<string>(CHARACTER_VIEWS.map((v) => v.kind))
  /* 先写图、再 saveCharacters:后者顺带按 key 归属清理,顺序反了会把刚写进去的
     设定图当成"已经不在的角色名下的"删掉(见 idb.ts 的 putCharRefs) */
  try {
    for (const r of await getCharViews(id)) {
      if (known.has(r.kind)) {
        await putCharView(copy.id, r.kind, reBlob(r.data))
        announce('charViews', copy.id)
      }
    }
    characters.value = [
      ...characters.value.slice(0, at + 1),
      copy,
      ...characters.value.slice(at + 1)
    ]
    await saveCharacters(characters.value)
    notice.value = `Duplicated as “${copy.name}”.`
  } catch {
    notice.value = 'Could not duplicate this character.'
  }
}

/* 导出一个角色为 zip(带图)。设定图是懒加载的,所以先确保取过 ——
   不取的话导出包里会少掉那五张,而这正是这个功能的意义所在 */
async function exportChar(id: string) {
  const c = characters.value.find((x) => x.id === id)
  if (!c) return
  try {
    if (!charViews.value[id]) await loadCharViews(id)
    const chat = await readChatForExport(id)
    const images = await exportCharacter(c, charViews.value[id] || [], chat)
    const msgCount = chat.messages.length
    /* 回执要把两样都说到:一个只有设定没有图的角色,与一个连对话都带走的角色,
       导出来的东西差别很大,让用户知道包里到底装了什么 */
    const parts: string[] = []
    if (images) parts.push(`${images} image${images === 1 ? '' : 's'}`)
    if (msgCount) parts.push(`${msgCount} message${msgCount === 1 ? '' : 's'}`)
    notice.value = parts.length
      ? `Exported “${c.name}” with ${parts.join(' and ')}.`
      : `Exported “${c.name}” — it has no images or conversation yet, so the zip is settings only.`
  } catch (e: any) {
    notice.value = e?.message || 'Could not export this character'
  }
}

/** 备好一个角色的对话,交给导出。
 *
 *  记忆**从库里读**:界面里那份是按角色懒加载的,没打开过的角色在内存里根本没有。
 *  消息只取最近一档(CHAT_EXPORT_MSGS)—— 分享时真正要传的是"它记得什么",
 *  消息只是那份记忆的来处,而且对话可以无限长,全带出去包里会塞进几 MB 纯文本。 */
/* 角色包的大小上限:一个角色是 1 张主图 + 5 张设定图,正常不过几 MB。
   不拦的话整个文件会先被读进内存再解压 —— 一个上百 MB 的 zip 就能把标签页顶掉,
   而它显然不会是角色包 */
const MAX_CHAR_ZIP = 64 * 1024 * 1024

/* 导入角色 zip。文件里的 id 一律换新 —— 与现有的撞上会让列表里出现两条同 id,
   渲染和删除都会错乱(与配置的导入同一条理由) */
async function importCharFile(file: File) {
  if (file.size > MAX_CHAR_ZIP) {
    notice.value = 'That file is too large to be a character export.'
    return
  }
  let list: ImportedCharacter[]
  try {
    list = await readCharacterZip(file)
  } catch (e: any) {
    notice.value = e?.message || 'Could not read that file'
    return
  }
  if (!list.length) {
    notice.value = 'That zip has no usable characters in it.'
    return
  }

  const added: Character[] = []
  let msgs = 0
  try {
    for (const imp of list) {
      const c: Character = {
        id: uid(),
        name: imp.name,
        createdAt: imp.createdAt,
        ...(imp.fields ? { fields: { ...imp.fields } } : {}),
        ...(imp.desc ? { desc: imp.desc } : {}),
        ...(imp.persona ? { persona: { ...imp.persona } } : {}),
        ...(imp.ref ? { ref: imp.ref } : {}),
        ...(imp.sourceRef ? { sourceRef: imp.sourceRef } : {}),
        ...(imp.refKind ? { refKind: imp.refKind } : {})
      }
      // 与 duplicateChar 同一条顺序要求:图先写,再交给 saveCharacters 落盘
      for (const v of imp.views) await putCharView(c.id, v.kind, v.data)
      if (imp.views.length) announce('charViews', c.id)
      /* 对话跟着角色一起落库。顺序也是要紧的:先得有这个角色 id,
         而记忆的游标要指着已经写进去的最后一条消息 */
      if (imp.chat) {
        await writeImportedChat(c.id, imp.chat)
        msgs += imp.chat.messages.length
        /* 包里的附图跟着落库。**id 原样用** —— 消息里引用的就是它,
           与"消息 id 一律换新"不同:那个是本地身份,这个只是一根引用的键 */
        for (const img of imp.chat.images || []) {
          await putChatImage({ id: img.id, blob: img.blob, createdAt: Date.now() })
        }
      }
      added.push(c)
    }
    characters.value = [...added, ...characters.value]
    await saveCharacters(characters.value)
    /* 补一趟左栏那行摘要:导入的对话已经在库里,而 chatLast 只在启动时读过一次 ——
       不补的话,这些明明带着历史的角色在左栏会显示 "No messages yet" */
    if (msgs) void loadChatLast()
    const base =
      added.length === 1 ? `Imported “${added[0].name}”.` : `Imported ${added.length} characters.`
    notice.value = msgs
      ? `${base} Includes ${msgs} message${msgs === 1 ? '' : 's'} of conversation.`
      : base
  } catch {
    notice.value = 'Could not save the imported characters.'
  }
}

/* 每个角色被用了几次、最后一次是什么时候。数据全在历史里 ——
   记录带着 characterId(见 types.ts),这里只做一次聚合,不新增存储。
   角色页靠它把"清单"说成"资产":一个没人用过的角色和一个出过上百张的,
   在列表里应该长得不一样 */
/* —— 设定图 ——
   五张视图,正脸是锚:其余四张都以正脸为参考图生成 —— 这是"同一张脸"的唯一保证。
   结果只进角色自己的 views,不进历史 —— 它们是中转用的参考料,不是作品 */
/* —— 角色身上的图 ——
   角色有两处图:ref(卡面与头像)与 5 张设定图。它们和 record.ref 的用处不同 ——
   后者只是"当时用了哪张参考图"的复现凭据,只喂给模型,压到最长边 512 就够
   (见 refThumbOf);而角色这两处是要给人看的:角色卡封面、详情页头像、
   以及全屏查看器里能铺到 600px 宽 —— 2× 屏就是 1200px。
   512 一到那个尺寸一眼就糊,所以这条路按显示级编:最长边 1280、JPEG q0.88。
   1280 是照着全屏查看器定的(600 CSS px × 2),再大对观感没有增益,
   只是让一套 6 张图多占几 MB */
/**
 * 生成一张设定图。
 * 正脸:角色有主参考图(上传的 / 从作品提升的 / 上一版正脸)就以它为参考图,
 * 没有就是纯文生图 —— 三种输入因此走同一条流水线;
 * 其余四张一律以正脸为参考图。
 * 返回是否成功,好让"补齐"那一步知道该停下还是继续。
 */
async function genCharView(charId: string, kind: CharacterViewKind): Promise<boolean> {
  const view = CHARACTER_VIEWS.find((v) => v.kind === kind)
  const c = characters.value.find((x) => x.id === charId)
  /* 同一张重复点没有意义:第二次请求只会把第一次的结果盖掉。
     别的张在跑不影响这一张 —— 它们之间没有依赖(正脸未生成时那几格本来就是锁的) */
  if (!view || !c || charViewBusy.value[charId]?.includes(kind)) return false
  const cfg = config.value
  /* 这里几个报错都走 notice 而不是 fail:这条流水线只有站在角色页才会触发,
     而 fail 写的是 home 那条 .err —— 在角色页触发时它不渲染,等于没提示 */
  if (!cfg.model) {
    notice.value = 'Set an image model in API settings first.'
    return false
  }
  /* —— 这一张拿哪几张图当参考 ——
     正脸:用第一步上传的那张底图,它就是"这个人原本的样子"。
     没传过就是纯文生图。回退 ref 是留给老数据的路 ——
     那批角色的 ref 里存的就是图本身,没有单独一份底图
     其余四张:正脸与底图一起送。正脸定"这张脸长什么样",
     底图补上一张正面头像交代不了的东西(发型轮廓、体态、服装轮廓) */
  const front = viewOf(c.id, 'front')?.data
  const source = c.sourceRef ?? (kind === 'front' ? c.ref : undefined)
  let refBlobs: Blob[]
  if (kind === 'front') {
    refBlobs = source ? [source] : []
  } else {
    // 没有正脸就没有锚,跑出来的只是"另一个长得有点像的人"
    if (!front) {
      notice.value = 'Generate the front view first — the other views are built from it.'
      return false
    }
    /* 不认多图的模型只送正脸:宁可少一张,也不能为了多送一张把整个请求弄失败 ——
       正脸是不可少的那个,四张之间靠它才串成同一个人 */
    const caps = getProvider(vendorOf(cfg), cfg.model)
    refBlobs = caps.multiImage === 'no' || !source ? [front] : [front, source]
  }
  charViewBusy.value = {
    ...charViewBusy.value,
    [charId]: [...(charViewBusy.value[charId] || []), kind]
  }
  error.value = ''
  const ctl = new AbortController()
  charViewControllers.set(charViewKey(charId, kind), ctl)
  let ok = false
  try {
    /* 提示词由 api.ts 那份 `characterViewPrompt` 拼:设定 + 这一格的取景
       (+ 有参考图时那句"参考图只管脸、别抄它的姿态")。
       从前是在这里手拼 `[characterDesc(c), view.suffix]` —— 于是"参考图只管脸"
       那一句根本不存在,而底图是侧脸时生成的正脸也就跟着是侧脸(用户 2026-10-05 报) */
    const images: string[] = []
    for (const b of refBlobs) images.push(await blobToDataURL(b))
    const prompt = characterViewPrompt(c, kind, images.length > 0)
    const res = await generate(
      {
        prompt,
        size: viewSize(view.framing),
        n: 1,
        ...(images.length ? { images } : {})
      },
      cfg,
      ctl.signal
    )
    const blob = await resultRefBlob(res[0])
    if (!blob) throw new Error('Upstream returned no usable image')
    /* 换掉的那张旧图不再有任何界面引用它,连同它的 object URL 一起放掉 ——
       反复重跑同一格,否则每次都在内存里留一张全尺寸图 */
    releaseSrc(viewOf(c.id, kind)?.data)
    await putCharView(c.id, kind, blob)
    // 另一页若正开着这个角色的详情/向导,它该看到这张新图
    announce('charViews', c.id)
    const rest = (charViews.value[c.id] || []).filter((v) => v.kind !== kind)
    charViews.value = { ...charViews.value, [c.id]: [...rest, { kind, data: blob }] }
    /* 正脸同时是这张角色的封面与头像,生成成功后就写回 ref ——
       否则卡片上停留的还是那张上传的底图,跟刚生成的脸对不上。
       底图不会被这一下顶掉:它另存了一份(sourceRef),
       其余四张设定图还要拿它和正脸一起当参考 */
    if (kind === 'front') {
      const stale = c.ref
      c.ref = blob
      await saveCharacters(characters.value)
      // 界面已经换成新图,旧封面那张不再被任何地方引用
      if (stale && stale !== blob) releaseSrc(stale)
    }
    /* 重跑正脸之后,其余四张就是照上一张正脸出的了。提醒一句,但不替用户删 ——
       删是不可逆的,而"要不要重跑"只有他自己知道 */
    if (kind === 'front' && rest.length) {
      notice.value =
        'Other views were built from the previous front view — regenerate them if the face changed.'
    }
    ok = true
  } catch (e: any) {
    /* 用户主动停的不算失败 —— 按报错抛出来会让人以为出了故障 */
    notice.value = ctl.signal.aborted
      ? 'Generation stopped.'
      : e?.message || 'Could not generate this view'
  } finally {
    // 只有还是自己那一个才摘掉:同一张连跑时后一次已经换了新的手柄
    const key = charViewKey(charId, kind)
    if (charViewControllers.get(key) === ctl) charViewControllers.delete(key)
    /* 只摘掉这一张 —— 同一角色可能还有别的张在跑,
       别的角色的记录更是不能碰(它们与这一次请求无关) */
    const rest = (charViewBusy.value[charId] || []).filter((k) => k !== kind)
    const next = { ...charViewBusy.value }
    if (rest.length) next[charId] = rest
    else delete next[charId]
    charViewBusy.value = next
  }
  return ok
}

/** 停掉正在重跑的那一张设定图,只停它 —— 别张还在跑的自己跑完。
 *  已经落库的那张不受影响:只有成功写入的那一刻才作数,半路掐断不会留下坏图 */
/** 一次补齐五张。串行跑:每张都以前一张为参考图,并行只会互相抢带宽;
 *  中途失败(多半是配置或配额)就直接停下,免得连错四次 */
async function genRemainingViews(charId: string) {
  for (const v of CHARACTER_VIEWS) {
    if (viewOf(charId, v.kind)) continue
    // 已经自己在跑的那张跳过:这个循环只把"还缺的"补上,不重发一遍
    if (charViewBusy.value[charId]?.includes(v.kind)) continue
    if (!(await genCharView(charId, v.kind))) return
  }
}

// 在创作区选中某个角色时顺手取一次;角色页那边由 @open 触发
watch(activeCharId, (id) => loadCharViews(id))

/* 对话这一域的**流式那一轮**收在 composables/useChatFlow.ts —— 它要动出图配置、
   角色参考图与请求中断,状态仍留在主界面,由 deps 传进去(与 useChat 同一套做法)。
   下面把它交出来的几个入口按原名解构出来,模板与其余代码照旧用 */
const {
  openChat,
  sendChat,
  stopChat,
  regenerateChat,
  retryChatPhoto,
  deleteChatMessageFromPage,
  openCharacterDetail,
  openChatConfigSettings,
  saveChatWork
} = useChatFlow({
  characters,
  activeCharId,
  charPageRef,
  chatConfig,
  chatConfigs,
  visionConfig,
  cfgSeed,
  cfgView,
  newConfig,
  editConfig,
  chatCharId,
  chatMessages,
  chatMood,
  chatSummary,
  chatLast,
  chatLastReady,
  chatBusy,
  chatControllers,
  chatSeqOf,
  setChatLast,
  setChatMood,
  dropChatLast,
  loadChatLast,
  maybeSummarize,
  notice,
  scheduleUndo,
  generateChatPhoto,
  recordFor,
  persist,
  page,
  openPanel,
  chatPhotoBusy,
  announce
})

/* 打开预览。index 是"这条记录里的第几张" —— 历史页的图块与搜索结果是
   按张摊平的,点第 3 张就该看到第 3 张(不是永远从第一张开始)。
   默认 0 兼容"从记录进来"的那些入口(角色页作品) */
function openPreview(entry: HistoryEntry, index = 0) {
  previewIndex.value = index
  previewEntry.value = entry
}
function closePreview() {
  previewEntry.value = null
}
// 预览菜单:删除该条历史。与历史页那条走同一个出口,撤销窗口也共用
function removeHistoryItem() {
  const cur = previewEntry.value
  if (!cur) return
  removeHistoryEntry(cur)
  closePreview()
}
/* 预览里那两个入口:它们要动的是"正在预览的那一条",而预览状态在主界面 ——
   所以这里只做转发,业务仍归 useHistory(见 assignCollectionTo / createAndAssign) */
function assignCollection(collectionId: string) {
  if (!previewEntry.value) return
  assignCollectionTo(previewEntry.value, collectionId)
}
function createAssignCollection(title: string) {
  createAndAssign(previewEntry.value, title)
}

</script>

<template>
  <div
    class="shell"
    :class="{ 'shell-wide': page === 'chat', 'shell-immersive': immersiveOn }"
  >
    <!-- 品牌 + 视图切换 + 全局操作 -->
    <!-- 顶部横条:字标、导航与主题开关都在最顶层,每一页都在,
         切页时相对位置不动。
         字标是"Kairo + 一截手写体",那截就是当前页名 ——
         名字取自导航那份清单(lib/nav.ts) -->
    <!-- 沉浸态藏起顶栏。**必须用 v-show,不能用 v-if** ——
         下面那条 ResizeObserver 观察的正是这个元素:`display: none` 时它的
         offsetHeight 是 0,--mast-h 于是自动变成 0px,而 .chat 的高度算式
         一个字都不用改。换成 v-if 卸载它,观察就断了,--mast-h 会僵在 72px,
         症状是"沉浸页底下平白矮一截"—— 功能全对,所以很难被发现 -->
    <header v-show="!immersiveOn" ref="mastEl" class="masthead" :class="{ scrolled }">
      <div class="wordmark">
        <span class="title">
          Kairo
          <span class="title-script">{{ wordmarkSuffix }}</span>
        </span>
      </div>

      <!-- 居中的视图切换:滑块位置即当前打开的面板。
           轨道 40px / 内边距 5px,滑块因此留在 30px:
           原来 36/3 时白底只比黑色选中底高 3px,两者看起来一样高 -->
      <NavSegment v-model="navView" :warn="!configured()" />

      <nav class="mast-actions">
        <button
          class="icob tip-below"
          @click="toggleTheme"
          :data-tip="theme === 'dark' ? 'Switch to light' : 'Switch to dark'"
          :aria-label="theme === 'dark' ? 'Switch to light' : 'Switch to dark'"
        >
          <PhSun v-if="theme === 'dark'" aria-hidden="true" />
          <PhMoon v-else aria-hidden="true" />
        </button>
      </nav>
    </header>

    <!-- 视图切换:平级视图同时只挂载一个 -->
    <main class="frame">
      <!-- 外面这层 Transition 让新旧两页交叉过渡 ——
           原来只做了"新页淡入",旧页瞬间消失,那一下硬切就是生硬的来源 -->
      <Transition name="page">

      <!-- 角色。它是这条链的头一个分支,所以是 v-if(其余各页接着 v-else-if) -->
      <CharacterPage
        v-if="page === 'chars'"
        ref="charPageRef"
        :characters="characters"
        :views="charViews"
        :stats="charStats"
        :works="charWorks"
        :busy="charViewBusy"
        :text-config="textConfig || undefined"
        :vision-config="visionConfig || undefined"
        :tts-config="ttsConfig || undefined"
        @save="saveCharFromPage"
        @remove="deleteChar"
        @duplicate="duplicateChar"
        @pin="togglePinChar"
        @export="exportChar"
        @import="importCharFile"
        @open="loadCharViews"
        @generate="genCharView"
        @generate-all="genRemainingViews"
        @stop-view="stopCharView"
        @preview="openPreview"
        @chat="openChat"
      />

      <!-- 角色对话。与角色页是同一个对象的两个面:一个造它,一个跟它说话 -->
      <ChatPage
        v-else-if="page === 'chat'"
        :characters="characters"
        :messages="chatMessages"
        :last-msg="chatLast"
        :busy="chatBusy"
        :redrawing="chatPhotoBusy"
        :active="chatCharId"
        :has-more="!!chatHasMore[chatCharId]"
        :summary="chatSummary[chatCharId]"
        :chat-config="chatConfig || undefined"
        :chat-borrowed="chatBorrowed"
        :vision-config="visionConfig || undefined"
        :tts-config="ttsConfig || undefined"
        :immersive="immersiveOn"
        :backdrop="backdropSrc"
        :backdrop-busy="!!backdropBusy[chatCharId]"
        @toggle-immersive="toggleImmersive"
        @new-backdrop="drawBackdrop(chatCharId)"
        @select="chatCharId = $event"
        @send="sendChat"
        @stop="stopChat"
        @regenerate="regenerateChat"
        @retry-photo="retryChatPhoto"
        @delete-message="deleteChatMessageFromPage"
        @pin="togglePinChar"
        @edit-summary="editChatSummary"
        @forget-summary="forgetChatSummary"
        @notice="notice = $event"
        @clear="clearChat"
        @load-earlier="loadEarlierChat"
        @goto-chars="page = 'chars'"
        @open-character="openCharacterDetail"
        @configure-chat-model="openChatConfigSettings"
      />

      <!-- 历史记录 -->
      <HistoryPage
        v-else-if="page === 'history'"
        :items="history"
        :collections="collections"
        :char-names="charNames"
        @open="openPreview"
        @remove="removeHistoryEntry"
        @mark="toggleMark"
        @create-collection="createCollection"
        @delete-collection="deleteCollection"
      />

      <!-- 接口设置 -->
      <SettingsPage
        v-else-if="page === 'settings'"
        :configs="configs"
        :active-id="activeId"
        :active-text-id="activeTextId"
        :active-chat-id="activeChatId"
        :active-vision-id="activeVisionId"
        :active-tts-id="activeTtsId"
        :mode="cfgView"
        :seed="cfgSeed"
        :capability-note="capabilityNote"
        @activate="activateConfig"
        @activate-text="activateTextConfig"
        @activate-chat="activateChatConfig"
        @activate-vision="activateVisionConfig"
        @activate-tts="activateTtsConfig"
        @edit="editConfig"
        @duplicate="duplicateConfig"
        @remove="removeConfig"
        @create="newConfig"
        @cancel="cancelConfig"
        @save="saveSettings"
        @import="importConfigs"
      />
      </Transition>
    </main>

    <!-- 历史图片预览 -->
    <ImagePreview
      :visible="!!previewEntry"
      :entry="previewEntry"
      :start-index="previewIndex"
      :items="history"
      :collections="collections"
      :characters="characters"
      @close="closePreview"
      @navigate="openPreview"
      @remove="removeHistoryItem"
      @mark="toggleMark"
      @assign-collection="assignCollection"
      @create-collection="createAssignCollection"
    />

    <!-- 中性提示(存好了、空间快满、覆盖未保存):以前只在生图工作台里铺一块,
         切到别的页面就看不见了,所以提到全局浮层。
         几秒后自己收起(见 clearNotice),指针停上去时不计时;
         想提前关掉也留了个叉 -->
    <div
      v-if="notice"
      class="note"
      role="status"
      @pointerenter="holdNotice"
      @pointerleave="releaseNotice"
    >
      <span class="note-msg">{{ notice }}</span>
      <button class="note-close" @click="clearNotice" aria-label="Got it">
        <PhX aria-hidden="true" />
      </button>
    </div>

    <Transition name="undo-in">
      <UndoToast
        v-if="pendingUndo"
        :key="pendingUndo.token"
        :label="pendingUndo.label"
        :duration="UNDO_MS"
        :class="{ 'over-compose': page === 'chat' }"
        @undo="runUndo"
        @expire="commitUndo"
      />
    </Transition>
  </div>
</template>

<style scoped>
.shell {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 clamp(16px, 4vw, 40px) 64px;
}
/* 对话页例外:它是"一块要一直待着的面板",不是一栏内容 ——
   1080px 的居中栏留给别的页面(那些页是"读一段、做一件事"),
   而这里左右各空出一大片、对话挤在中间,看着就像没铺满。
   仍然留一个上限:超宽屏上把消息挤在两千多像素中间的空白里同样不好看 ——
   两侧说话的人离得太远,一句话要横跨半个屏幕才接得上。

   左右内边距**另给一档**,和下面那道缝取同一个数。
   别的页面那个 clamp(16px, 4vw, 40px) 是给"读一段就走"的排版留的呼吸,
   而这一页要的是"贴边铺开" —— 面板四周该是同一圈留白,
   三边 16px、一边 40px 看着就是没对齐。
   下面那 16px 不在 padding 里,它挪进了 .chat 的高度算式(见那边的注释),
   所以这三个数是一对:改这里要连着改那两处。
   只覆盖左右:上下各有各的账,用 padding 简写会把它们一起冲掉。

   底下那 64px 也归零:那是按"读完一段就走"的页面留的,
   对一块要占满视口的面板来说,它只是在底下空出一条。
   底部那点余量改由下面 height 里留出的 16px(--sp-4)承担 ——
   与 ChatPage 里那条高度算式是一对,改一个要改另一个。

   **锁死一屏**:这一页整页不该出现滚动。
   它的高度算式里有一项是 JS 量出来的顶栏高度(offsetHeight,取整到像素),
   末位对不上就会多出不到 1px;而 html 上挂着 scroll-behavior: smooth、
   滚动条又被全局隐藏(见 style.css),那点溢出既看不见滚动条、又能用触控板滑出来,
   手感正是"整页在滑"。与其去追那不到 1px,不如把这一页钉住:
   height 钉到视口,多出来的直接裁掉。
   注意 height 走 border-box,已含内边距,所以内容正好差 16px 落在那条余量上 */
.shell-wide {
  /* 1760 而不是 1600:1600 在 16 寸 Mac(1728)这类屏上已经开始居中留边,
     而那部分留白和 padding 叠在一起,看着就是"又白了一条"。
     1760 撑住这一档常见的宽屏;再往上的超宽屏仍然收在中间,
     否则两侧气泡会离得太远 */
  max-width: 1760px;
  /* 与 .chat 算式里那道底部余量同一个数(--sp-4)——
     面板四周是同一圈留白。下面那处不在这里,别忘了改的时候连它一起改 */
  padding-left: var(--sp-4);
  padding-right: var(--sp-4);
  padding-bottom: 0;
  height: 100vh;
  height: 100dvh;
  /* 用 clip 而不是 hidden:hidden 会把 .shell 变成滚动容器,
     而聚焦底部那个输入框时浏览器可能把它滚一下 —— 整页跟着挪,
     就又成了"滑一下"。clip 只裁切、不产生滚动容器,也就不可能被滚。
     老浏览器不认 clip 时退回 hidden */
  overflow: hidden;
  overflow: clip;
}
/* 屏确实太矮时(与 .chat 的 min-height: 420px 同一条理由):
   宁可让整页滚,也不要压成一条缝。这时把上面那把锁解开 */
@media (max-height: 520px) {
  .shell-wide {
    height: auto;
    overflow: visible;
  }
}

.masthead {
  /* 三段式:品牌靠左、视图切换居中、主题按钮紧贴滑块右侧。
     两侧都是 1fr、中间 auto,中列才会真正居中于容器;
     主题按钮靠第 3 列的起始边,所以不会把滑块推离中心。
     列间距取 8px:只有"滑块 ↔ 主题按钮"这一处会真实呈现间距,
     与参数栏图标簇的 8px 对齐 */
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-4) 0;
  position: sticky;
  top: 0;
  /* 高于全部页面内容;抽屉与图片预览的浮层刻意压在其上 ——
     否则蒙层盖不住导航,打开抽屉时导航会浮在蒙层之上,看着像坏了 */
  z-index: 10;
}
/* 页面顶部时完全透明,融入背景图;滚动后浮出一层通栏毛玻璃,
   与主页面内容拉开层次,不再糊在一起 */
.masthead::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 100vw;
  transform: translateX(-50%);
  /* translate 会让伪元素按 z-index:0 参与绘制,压住未定位的品牌区,
     所以显式沉到负层:在导航自身内容之下、主页面内容之上 */
  z-index: -1;
  pointer-events: none;
  opacity: 0;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  transition: opacity var(--dur) var(--ease);
}
.masthead.scrolled::before {
  opacity: 1;
}
.wordmark {
  display: flex;
  align-items: center;
  /* 中间那枚导航的居中靠的是两侧 1fr 等宽,而 1fr 轨道的最小尺寸默认是内容宽度:
     页面名一长("Prompt Library")文字就会把导航顶偏。放开这一条才压得下去,
     压不下时也只会裁掉字标尾巴,不会动到导航与主题键 */
  min-width: 0;
  overflow: hidden;
  /* 裁切是按盒子算的,而手写体的字形比同号的几何体高得多:
     Pacifico 的字面(升部+降部)是 1.756em,24px 就是 42px,
     比它自己那份 1.2 倍的行盒多出一截 —— 手写体的尾巴就是这么被裁掉的。
     行高已在 .title-script 上提到装得下字形的 1.8,
     这里再补 4px 内边距做余量(裁切按内边距盒子算)。
     同时用 -6px 外边距把那点占位收回来,让它的外框不超过导航那 40px ——
     横条高度因此仍停在 72px,不因为一个字母的尾巴长高 */
  padding-block: 4px;
  margin-block: -6px;
}
.title {
  /* 品牌锁形:几何粗体主打 + 手写体后缀。
     两截字上下居中,而不是按基线对齐 —— 两者的字面盒差得太远
     (Poppins 1.4em、Pacifico 1.756em),按基线对起来手写体整个往上冒 */
  font-family: var(--font-wordmark);
  font-size: 21px; /* 品牌锁形的一部分,随字标字体一起定,不进正文字阶 */
  font-weight: 700;
  letter-spacing: -0.01em;
  /* 行盒正好等于 Poppins 的字面高度:半个行距为 0,字形盒因此与行盒重合,
     居中才是真的居中(否则居中的是一个带上下留白的盒子,不是字本身) */
  line-height: 1.4;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
.title-script {
  font-family: var(--font-script);
  /* 手写体字面小、上下留白多,要放大一档才和左边的字重们等高 */
  font-size: 24px; /* 同上:手写体后缀,品牌锁形的一部分,不进正文字阶 */
  font-weight: 400;
  /* 行高要装得下这个字体本身:Pacifico 的字面有 1.756em(见其 hhea 表),
     24px 就是 42px;跟着 .title 那份给几何体定的 1.2 走,行盒只有 28.8px,
     超出的那截会落到盒外 —— 字标外层是 overflow: hidden,落到外面就被切掉。
     1.8 够它了(43.2px),这才是有余量的写法,不是拿内边距去凑 */
  line-height: 1.8;
}
.mast-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 靠第 3 列的起始边,于是紧挨着中间的滑块;
     若改成 end 会退回右端,中间的滑块也就不再居中 */
  justify-self: start;
}
/* 居中的视图切换。justify-self 兜住 grid 的默认 stretch,避免被拉伸。
   图标尺寸与齿轮标红那两条跟着组件走了(见 NavSegment)——
   槽位里的图标是在那个组件的作用域里编译的,写在这里会匹配不上 */
.nav-seg {
  justify-self: center;
}
.icob {
  position: relative;
  /* 40px 对齐同一行的 .nav-seg(轨道加高后的实际外高),整条导航读作一个高度;
     底色和描边压成半透明:导航浮在背景图上,不透明的胶囊在这里
     比坐在纯色页面里的参数栏重得多 */
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--line) 80%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  color: var(--text-2);
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.icob:hover {
  color: var(--text);
  background: var(--bg-elev);
  border-color: var(--line-strong);
}
.icob svg {
  width: 19px;
  height: 19px;
}

.frame {
  margin-top: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-7);
  /* 离场的那一页会脱离文档流(见 .page-leave-active),这里得是它的定位基准 */
  position: relative;
}

/* 撤销条从底部升起来。它比页面切换更"贴身",所以更快一点 */
.undo-in-enter-active,
.undo-in-leave-active {
  transition: opacity 180ms var(--ease), transform 180ms var(--ease);
}
.undo-in-enter-from,
.undo-in-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

/* ===== 页面切换 =====
   旧页原地淡出并微微上移,新页从下方浮起来接住它 —— 两页在同一段时间里交叉,
   不是"旧页消失、新页另起一段"。离场期间旧页脱离文档流,高度交给新页,
   所以滚动条不会在中途缩一下又弹回来 */
.page-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  /* 离场只是让位,所以比入场短:两段叠起来刚好是一次呼吸的长度 */
  transition: opacity 150ms ease-out, transform 150ms ease-out;
}
.page-leave-to {
  opacity: 0;
  /* 往上走一点,与入场的方向对上:读起来像两页纸交错滑过 */
  transform: translateY(-6px);
}
.page-enter-active {
  transition: opacity 320ms var(--ease), transform 320ms var(--ease);
}
.page-enter-from {
  opacity: 0;
  transform: translateY(14px);
}
/* 位移对前庭敏感的人不友好,那种情况下只留淡入淡出 */
@media (prefers-reduced-motion: reduce) {
  .page-enter-active,
  .page-leave-active {
    transition-duration: 160ms;
  }
  .page-enter-from,
  .page-leave-to {
    transform: none;
  }
}

.panel {
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: var(--sp-6);
  box-shadow: var(--sh-md);
}
.panel-head h2 {
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: var(--fs-2xl);
}
.lede {
  margin-top: 4px;
  color: var(--text-2);
  font-size: var(--fs-base);
}
.composer textarea {
  width: 100%;
  padding: 11px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: var(--fs-base);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.composer textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 6px 22px -8px color-mix(in oklch, var(--accent) 40%, transparent);
}
.panel-foot {
  margin-top: var(--sp-6);
  display: flex;
  justify-content: flex-end;
}
.workbench {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.hero {
  position: relative;
  text-align: center;
  /* 顶部留白收窄,让标题与输入框整体上移,首屏更快进入内容。
     上一行加了微标签之后又收了一档:标签本身占掉一行的高度,
     不补回来的话标题与输入框会被推低,首屏就挤了 */
  padding: clamp(16px, 3vw, 34px) var(--sp-4) var(--sp-5);
  overflow: hidden;
}
/* 分类微标签:先说"这是什么",再说"它有多好"。
   全大写 + 拉开字距,和下面的大标题是两种读音,不会被当成同一句话的头 */
.hero-eyebrow {
  margin-bottom: var(--sp-3);
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-weight: 500;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  position: relative;
  z-index: 1;
}
.hero-title {
  font-family: var(--font-sans);
  font-weight: 700;
  /* 英文行更长,字号上限与下限都比中文版收一档,避免窄屏被裁切 */
  font-size: clamp(var(--fs-3xl), 5.2vw, 56px);
  letter-spacing: var(--ls-hero);
  line-height: 1.08;
  position: relative;
  z-index: 1;
}
.hero-sub {
  margin-top: var(--sp-4);
  color: var(--text-3);
  font-size: var(--fs-md);
  letter-spacing: var(--ls-wide);
  position: relative;
  z-index: 1;
}
.composer {
  max-width: 840px;
  width: 100%;
  margin: 0 auto;
}
.prompt-box {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg); /* Prompt Composer: Large 24px */
  padding: 16px;
  box-shadow: var(--sh-float);
  display: flex;
  flex-direction: column;
  /* 光晕用更长的时长淡入淡出,避免收放时显得突兀。
     边框不参与过渡:这两态里它始终是那条 --line */
  transition: box-shadow 340ms var(--ease);
}
/* 聚焦只亮光晕,不给边框上色:这一圈由内向外渗出的柔光已经说清了
   "焦点在这儿",再把边框描深一道只是把同一件事说了两遍,
   而且描深之后框里那层"可以随便写字"的感觉会收紧。
   于是边框自始至终就是那一条 --line */
.prompt-box:focus-within {
  box-shadow:
    var(--sh-float),
    /* 漫反射:由内向外 4 层递减柔光,越往外越淡,层间无可见边界 */
    0 0 8px -3px color-mix(in oklch, var(--accent) 16%, transparent),
    0 0 18px -5px color-mix(in oklch, var(--accent) 20%, transparent),
    0 0 34px -10px color-mix(in oklch, var(--accent) 24%, transparent),
    0 0 58px -18px color-mix(in oklch, var(--accent) 26%, transparent),
    /* 向下的柔和投影,把输入框轻轻托起来 */
    0 14px 36px -22px color-mix(in oklch, var(--accent) 34%, transparent),
    /* 内侧沿边框晕染的一层薄雾,像光从边缘渗进来 */
    inset 0 0 14px -10px color-mix(in oklch, var(--accent) 26%, transparent);
}
/* 一、输入区(横线上方) */
.compose-zone {
  display: flex;
  flex-direction: column;
}
.prompt-box textarea {
  /* 高度由 fitPrompt() 按内容算(6 行封顶后转内部滚动),
     所以既不要拖拽角,也不能让浏览器自己先冒出滚动条 */
  resize: none;
  overflow-y: hidden;
  line-height: 1.6;
  font-size: var(--fs-lg);
  /* 一行(16px × 1.6 + 上下内边距 = 39.6)的兜底高度,JS 接管前先撑住;
     同时是 JS 算高度时的下限 */
  min-height: 40px;
  padding: 6px 2px 8px;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  transition: opacity 220ms var(--ease);
}
.prompt-box textarea:focus,
.prompt-box textarea:focus-visible {
  border: none;
  box-shadow: none;
  outline: none;
}
/* 改写中的那几行旧字正被整段换掉:压暗它,一来明说"这会儿先别读这段",
   二来给"换完了"一个可见的落点 —— 结果写回时它跟着亮回去。
   只压暗不隐藏:输入框还是那个输入框,不该看成被禁用了 */
.prompt-box.halo-breathe textarea {
  opacity: 0.45;
}
/* AI 在写的时候那圈金光是主角。点改写键会把焦点留在框里,
   于是聚焦那套墨色漫反射也亮着 —— 墨色垫在金底下会把它拖脏,
   所以这段时间让它歇着,只留投影(边框照旧不动) */
.prompt-box.halo-breathe:focus-within {
  box-shadow: var(--sh-float);
}
/* 二、参数 icon 行(横线下方) */
.param-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 12px 2px 0;
  border-top: 1px solid var(--line);
}
/* 纯图标按钮:名称与当前值都放进 title,鼠标悬停才显示 */
.param-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  color: var(--text-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.param-btn svg {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
}
/* 角色有头像时胶囊里放头像:一张脸比一个通用的人形图标好认得多 */
.param-avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
/* 角色胶囊外面这层只为给"移除"角标当定位基准 ——
   角标要探出胶囊一点,不包一层就只能被胶囊自己的圆角框住 */
.param-char {
  position: relative;
  display: inline-flex;
}
/* 已选中角色的胶囊:悬停时右上角冒出移除钮。
   这里刻意不做悬停看正脸 —— 那张卡片是"挑人"时用的(见 .char-peek),
   选完之后要回答的是另一个问题:怎么把它摘下来 */
.param-char .char-drop {
  position: absolute;
  top: -4px;
  right: -4px;
  /* 压住:角标与胶囊有一小块重叠,得在上面才点得到 */
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  color: var(--cta-text);
  background: var(--cta);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.28);
  opacity: 0;
  /* 收起时不挡点击:它压在胶囊角上,否则那一个角就点不开面板了 */
  pointer-events: none;
  transform: scale(0.6);
  transition: opacity 140ms var(--ease), transform 160ms var(--ease);
}
/* 悬停胶囊(或鼠标已经移到角标上)与键盘聚焦时出现。
   键盘这条路要走 :has(:focus-visible):角标自己拿到焦点时也要留着 */
.param-char:hover .char-drop,
.param-char:has(:focus-visible) .char-drop {
  opacity: 1;
  pointer-events: auto;
  transform: scale(1);
  /* 稍等一拍:鼠标扫过参数行时不该一路闪出摘除钮 */
  transition-delay: 60ms;
}
.param-char .char-drop:hover {
  background: var(--accent-strong);
}
.param-char .char-drop svg {
  width: 11px;
  height: 11px;
}
/* 头像悬停时展开的那张正脸 —— 只在角色面板里那排头像上用(见 showCharPeek)。
   它 fixed 挂到最外层,坐标由 JS 按被悬停的头像现算(见 showCharPeek):
   角色面板自己会滚、也会裁掉溢出,卡片放在头像里面只能看到一半。
   节点常驻、只切 .on,收起时保留上一次的内容,收起动画才接得上 */
.char-peek {
  position: fixed;
  z-index: 30;
  width: 168px;
  opacity: 0;
  pointer-events: none;
  /* 收起态:缩小一点、向下错开,像从这颗头像上"长"出来 */
  transform: translateX(-50%) translateY(6px) scale(0.92);
  transform-origin: 50% 0;
  transition: opacity 160ms var(--ease), transform 260ms var(--ease);
}
.char-peek.on {
  opacity: 1;
  transform: translateX(-50%) translateY(0) scale(1);
  /* 稍等一下再出现:鼠标横扫过一排头像时不该一张张弹出来 */
  transition-delay: 120ms;
}
/* 下面放不下时翻到头像上方(见 showCharPeek 的 up):原点与入场方向一起翻过来 */
.char-peek.up {
  transform: translateX(-50%) translateY(-6px) scale(0.92);
  transform-origin: 50% 100%;
}
.char-peek.up.on {
  transform: translateX(-50%) translateY(0) scale(1);
}
.char-peek-frame {
  position: relative;
  display: block;
  border-radius: 14px;
  overflow: hidden;
  background: var(--bg-elev);
  box-shadow: var(--sh-md);
}
.char-peek img {
  display: block;
  width: 100%;
  /* 与角色卡片同一个 3:4 海报比例,同一张脸在两处裁切一致 */
  aspect-ratio: 3 / 4;
  object-fit: cover;
  /* 出场时轻轻收一下:像从远处推近到眼前,而不是整块贴上来 */
  transform: scale(1.06);
  transition: transform 460ms var(--ease);
}
.char-peek.on img {
  transform: scale(1);
  transition-delay: 120ms;
}
/* 名字压在图上:一层自下而上的暗幕把它托住(与角色卡片同一套做法) */
.char-peek b {
  position: absolute;
  inset: auto 0 0 0;
  padding: 18px 10px 8px;
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 1.3;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  background: linear-gradient(
    to top,
    rgba(24, 24, 22, 0.6) 0%,
    rgba(24, 24, 22, 0.28) 60%,
    transparent 100%
  );
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.param-btn:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
/* 展开态与"已改过"态都走中性灰:胶囊在这页只是参数的状态显示,
   用紫色会跟页面里唯一该抢注意力的生成键争视线。
   两者靠底色区分 —— 展开有底,仅改过只加重描边 */
.param-btn.on {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
/* 多模型对比时张数入口被停用(每个模型只出一张)。停用不是"出错",
   所以压暗但保留可读,悬停仍能拿到 tooltip 说明为什么不能改 */
.param-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.param-btn:disabled:hover {
  color: var(--text-2);
  border-color: var(--line);
}
.param-btn.filled {
  border-color: var(--line-strong);
  color: var(--text);
}
/* 带数值的参数(尺寸/张数):图标右侧直接露出当前值,宽度随内容撑开 */
.param-btn.has-val {
  width: auto;
  gap: 6px;
  padding: 0 12px 0 10px;
}
.param-val {
  font-size: var(--fs-sm);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
/* 配置名可能很长,限宽后省略;行高继承自 body(1.6),不会切掉字的下缘 */
.param-val-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 两个模型名之间的细竖线:少了它,两个名字会连读成一条 */
.param-sep {
  flex: none;
  width: 1px;
  height: 11px;
  margin: 0 1px;
  background: var(--line-strong);
}
/* 改写用的文本模型退一档:出图是主流程,它只在按 Enhance 时才起作用。
   胶囊处于高亮/已填态时会被上面那条 color: inherit 接管,统一成一个颜色 */
.param-val-sub {
  color: var(--text-3);
}
.param-btn.on .param-val,
.param-btn.filled .param-val {
  color: inherit;
}

/* 折叠容器:高度用 grid-template-rows 0fr→1fr 连续过渡,
   不靠 display 切换,避免"先淡出、再瞬间合拢"的两段跳变 */
.fold {
  display: grid;
  grid-template-rows: 0fr;
  min-height: 0;
  transition: grid-template-rows var(--dur) var(--ease);
}
.fold.open {
  grid-template-rows: 1fr;
}
.fold-inner {
  min-height: 0;
  overflow: hidden;
}
.param-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
  padding: 12px;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
  /* 「更多」面板要一次容下尺寸/画质/背景/参考图四组,190px 会把它切成两屏;
     用 vh 兜住矮视口,宁可在面板内滚动也不把整个输入区顶下去 */
  max-height: min(46vh, 340px);
  overflow-y: auto;
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.fold.open .param-panel {
  opacity: 1;
  transform: none;
}
.pp-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pp-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
/* 参数名是每组选项的锚点:比选项更沉一点,扫读时才找得到自己要看的那一组。
   但仍然小于选项本身 —— 它是标签,不是内容 */
.pp-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-2);
  margin-right: 2px;
}
/* 图标与文字同色同重,不再额外减淡 —— 一弱就白加了 */
.pp-label-ico {
  flex: none;
  width: 14px;
  height: 14px;
}
.pp-thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}
.pp-note {
  font-size: var(--fs-sm);
  color: var(--text-2);
}
/* 面板里的紧凑数字输入(自定义张数) */
.num-input {
  width: 76px;
  padding: 6px 10px;
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  text-align: center;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  /* 去掉数字框自带的上下箭头,和面板里的胶囊按钮保持同一套造型 */
  appearance: textfield;
  -moz-appearance: textfield;
}
.num-input::-webkit-outer-spin-button,
.num-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.num-input:focus {
  border-color: var(--accent);
  box-shadow: 0 6px 18px -10px color-mix(in oklch, var(--accent) 60%, transparent);
}
/* 自定义尺寸:比纯数字输入更宽,容纳 1024x1024 这类字符串,左对齐便于对位读数 */
.size-input {
  width: 124px;
  text-align: left;
  padding-left: 12px;
}
/* 种子:比默认的 76px 宽,容得下 2147483647 这种十位数 */
.seed-input {
  width: 118px;
}
/* 面板里的文字动作用中性灰:它是个胶囊形状,和上面那排选项同处一个面板,
   一个紫胶囊夹在灰胶囊中间会显得没做完 */
.pp-action {
  font-size: var(--fs-sm);
  color: var(--text);
  padding: 5px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  transition: background var(--dur) var(--ease);
}
.pp-action:hover {
  background: var(--surface-hover);
}

.preset {
  padding: 6px 12px;
  font-size: var(--fs-sm);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  background: var(--surface);
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
/* 面板里的选项胶囊同样去紫:它和外层胶囊是一组,外层转灰后里面还紫着会脱节 */
.preset:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
/* 选中态用墨色实心药丸:这是全站"当前项"的语言(生成键、导航滑块同一套)。
   灰底那版压得太轻,一排白胶囊里几乎看不出选的是哪个。
   借 --cta 而不是写死黑色:它在暗色主题会自动反相成白底黑字 */
.preset.on {
  background: var(--cta);
  border-color: var(--cta);
  color: var(--cta-text);
}
.preset.on:hover {
  background: var(--cta-hover);
  border-color: var(--cta-hover);
  color: var(--cta-text);
}
/* 对比选满之后,没入选的芯片不能再加进来。置灰而不是静默忽略:
   点了没反应会被当成坏了 */
.preset:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.preset:disabled:hover {
  border-color: var(--line);
  color: var(--text-2);
  background: var(--surface);
}
/* 参考图选择 */
.ref-pick {
  padding: 8px 14px;
  font-size: var(--fs-sm);
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-sm);
  color: var(--text-2);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.ref-pick:hover {
  border-color: var(--line-strong);
  color: var(--text);
}

/* —— 角色 ——
   选谁在参数行的角色胶囊里(与模型并排),列表在它展开的面板里 */
/* 角色选择:一圈一个头像,名字在 title 里。选中态用全站"当前项"那套墨色描边
   (导航滑块、选中胶囊同一套语言),不是给头像换底色 —— 头像的底色是它自己。
   这里是"选谁",不是"看谁":完整档案卡在角色页,不在这条参数行里 */
.char-pick {
  flex: none;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 2px solid var(--line);
  border-radius: 50%;
  background: var(--bg-elev);
  color: var(--text-3);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.char-pick:hover {
  border-color: var(--line-strong);
  transform: translateY(-1px);
}
.char-pick.on {
  border-color: var(--cta);
}
.char-pick-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.char-pick-ph {
  width: 18px;
  height: 18px;
}
.pp-action:disabled {
  opacity: 0.5;
  cursor: default;
}

.err {
  margin-top: var(--sp-2);
  color: var(--danger);
  font-size: var(--fs-sm);
  padding: 8px 12px;
  background: color-mix(in oklch, var(--danger) 10%, transparent);
  border-radius: var(--r-sm);
}
/* 存储清理提示:提醒而非错误,用中性色,不与报错抢注意力。
   现在挂在全局层(所有页面共用),所以做成居中浮条而非流内一方块:
   触发点和当前页面无关,固定在最底部才保证任何页面都能看见 */
.note {
  position: fixed;
  left: 50%;
  /* 抬高到撤销浮条(底部 28px)之上,两者几乎不会同屏,但一旦撞上不至于盖住操作 */
  bottom: 76px;
  transform: translateX(-50%);
  z-index: 40;
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  max-width: min(520px, calc(100vw - 32px));
  padding: 8px 12px;
  font-size: var(--fs-sm);
  /* 与撤销浮条同一套墨底白字。它浮在什么画面上都有可能(画布页整屏都是图),
     浅底浅字压上去就糊了 —— 深底才是在任何背景上都读得清的那一种。
     深色模式下 --cta 自己会翻成浅色,这套不用跟着写第二遍 */
  color: var(--cta-text);
  background: var(--cta);
  /* 这里原本写的是 --shadow-sm,那个变量根本不存在(全站只有 --sh-sm / --sh-md),
     等于没有阴影 —— 浮条和底下的画糊成一片,这也是"看不清"的一半原因 */
  box-shadow: var(--sh-md);
  border-radius: var(--r-sm);
}
.note-msg {
  flex: 1;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.note-close {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 叉比正文轻一档:它是个出口,不是内容 */
  color: color-mix(in srgb, var(--cta-text) 58%, transparent);
  border-radius: 999px;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.note-close svg {
  width: 13px;
  height: 13px;
}
.note-close:hover {
  color: var(--cta-text);
  background: color-mix(in srgb, var(--cta-text) 14%, transparent);
}

/* 长报错默认一行截断:上游原文动辄上百字,整段铺开会把输入区顶得很高 */
.err-msg {
  line-height: 1.6;
  overflow-wrap: anywhere;
  /* 上游原文里的换行是它自己的格式,留着;对比出图全军覆没时,
     这里也是一行一家的错误 */
  white-space: pre-wrap;
}
.err-msg.clipped {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.err-ops {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}
.err-btn {
  padding: 3px 10px;
  font-size: var(--fs-xs);
  color: var(--danger);
  border: 1px solid color-mix(in oklch, var(--danger) 32%, transparent);
  border-radius: 999px;
  transition: background var(--dur) var(--ease);
}
.err-btn:hover {
  background: color-mix(in oklch, var(--danger) 12%, transparent);
}

/* 输入框图标簇:清除(次级) + 发送(主按钮),同尺寸、同造型、留白节奏一致 */
.prompt-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: auto;
  padding-left: 4px;
}
.clear-icon,
.gen-icon {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease), transform 120ms var(--ease);
}
.clear-icon svg,
.gen-icon svg {
  width: 16px;
  height: 16px;
}
.clear-icon {
  color: var(--text-3);
  background: transparent;
}
.clear-icon:hover {
  color: var(--danger);
  border-color: color-mix(in oklch, var(--danger) 45%, var(--line));
  background: color-mix(in oklch, var(--danger) 8%, transparent);
}
.gen-icon {
  border-color: var(--cta);
  background: var(--cta);
  color: var(--cta-text);
  box-shadow: 0 2px 8px color-mix(in oklch, var(--cta) 30%, transparent);
}
.gen-icon:hover:not(:disabled) {
  background: var(--cta-hover);
  border-color: var(--cta-hover);
  box-shadow: 0 4px 12px color-mix(in oklch, var(--cta) 42%, transparent);
}
.clear-icon:active,
.gen-icon:active:not(:disabled) {
  transform: scale(0.94);
}
.gen-icon:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
}
/* 提示词改写:与参数按钮同尺寸、同描边语言。
   描边由外层 .enhance-split 提供 —— 按钮和档位切换要读成一个控件。
   底色透明、高 34px:和旁边的清除键、生成键完全同规格,
   否则这一排里会出现三个填色不同、差 2px 高的控件 */
.enhance-split {
  display: inline-flex;
  align-items: stretch;
  flex-shrink: 0;
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  overflow: hidden;
  transition: border-color var(--dur) var(--ease);
}
.enhance-split:hover {
  border-color: var(--line-strong);
}
/* 档位切换:竖线把它和改写按钮分开,复用它右边两个图标键的分隔语言 */
.enhance-mode {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0 9px 0 7px;
  border: none;
  border-left: 1px solid var(--line);
  background: none;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.enhance-mode:hover:not(:disabled) {
  color: var(--text);
  background: var(--bg-elev);
}
.enhance-mode svg {
  width: 13px;
  height: 13px;
}
.enhance-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  /* 高度交给外层:自己再定 34px 会把带描边的外层撑到 36px */
  padding: 0 12px;
  border: none;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
/* 16px 与清除键、生成键的图标同档 */
.enhance-btn svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.enhance-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--bg-elev);
}
.enhance-btn:disabled,
.enhance-mode:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 撤销态:同一个按钮,压轻一档表示"这是往回走"而不是再改写一次 */
.enhance-btn.undo {
  color: var(--text-3);
}

/* ===== 历史图墙(输入框下方的最近生成) ===== */
.feed-zone {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}
.sec-title {
  font-family: var(--font-sans);
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}
/* 加载态复用 sec-title 的字族与配色,只有动词的字重是组件内写死的 500,
   这里抬到 600,免得标题槽位在两种状态间来回变粗细 */
.sec-title :deep(.lattice-loader__label) {
  font-weight: 600;
}
.sec-tools {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}
.sec-more,
.sec-fold {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-sm);
  color: var(--text-3);
  padding: 6px 10px;
  border-radius: 999px;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.sec-more:hover,
.sec-fold:hover {
  color: var(--text);
  background: var(--bg-elev);
}
/* 全部停下:与 View all / Collapse 同一排,沿同一套文字按钮语言 */
.sec-stop {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  font-size: var(--fs-sm);
  color: var(--text-3);
  border-radius: 999px;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.sec-stop svg {
  width: 11px;
  height: 11px;
}
.sec-stop:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.sec-more svg,
.sec-fold svg {
  width: 14px;
  height: 14px;
  transition: transform var(--dur) var(--ease);
}
.sec-more:hover svg {
  transform: translateX(2px);
}
/* 展开时箭头翻上去,收起时朝下 */
.sec-fold svg.up {
  transform: rotate(180deg);
}

/* 图墙:多列瀑布流,图片按原始比例高低错落 */
.feed-grid {
  /* 定宽多列,和历史图墙同一套:列数只由容器宽度决定,不随图片数量变。
     之前列数是 min(4, 图数 + 生成中张数) 算出来的,后果有两个 ——
     第一次生成时只有 1 列,占位块会铺满整行(约 1000px 的正方块);
     而且每多生成一张就换一次列数,已有的图全部重排、尺寸跟着变 */
  column-width: 240px;
  column-gap: var(--sp-3);
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.fold.open .feed-grid {
  opacity: 1;
}
.tile {
  position: relative;
  display: block;
  width: 100%;
  margin: 0 0 var(--sp-3);
  padding: 0;
  border: none;
  border-radius: var(--r);
  overflow: hidden;
  background: var(--image-bg);
  break-inside: avoid;
  cursor: zoom-in;
  animation: rise 400ms var(--ease) both;
  transition: box-shadow var(--dur) var(--ease);
}
.tile:hover {
  box-shadow: var(--sh-md);
}
.tile img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  transition: transform 600ms var(--ease);
}
.tile:hover img {
  transform: scale(1.04);
}
/* 生成中的占位块:宽高比由当前尺寸决定,与出图尺寸一致 */
.tile-skel {
  cursor: default;
  animation: none;
}
/* 角标:默认隐去,悬停/聚焦时浮出短标题与元信息。
   不放完整提示词 —— 两行文字会把缩略图挡掉大半,读提示词交给预览卡 */
.tile-veil {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 18px 12px 10px;
  text-align: left;
  color: #fff;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.62), transparent);
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.tile:hover .tile-veil,
.tile:focus-visible .tile-veil {
  opacity: 1;
}
/* 标题比元信息重一档:图砖先被"叫什么"抓住,时间尺寸是补注 */
.tile-name {
  font-size: var(--fs-base);
  font-weight: 500;
  letter-spacing: var(--ls-tight);
  /* 只留一行。提示词长短不一,不裁的话长的会把图盖掉一半 —— 
     这跟"不放完整提示词"是同一条理由 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tile-meta {
  font-size: var(--fs-micro);
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}

/* 停止键:每格一个,只停它自己。
   常驻而不是悬停才浮出 —— 触屏没有悬停,一个"看不见的停止键"等于没有;
   这是用户唯一的停止入口(生成键不再兼任),更不该藏 */
.skel-stop {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 2;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  /* 墨底白图标:骨架本身是浅灰的一整块,浅色按钮压上去看不出边界在哪 */
  background: var(--cta);
  color: var(--cta-text);
  box-shadow: var(--sh-sm);
  cursor: pointer;
  transition: transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.skel-stop svg {
  width: 13px;
  height: 13px;
}
.skel-stop:hover {
  transform: scale(1.06);
  box-shadow: var(--sh-md);
}
/* 模型名:对比出图时几格长得一模一样,不写清哪格是哪家就只能靠猜。
   右边界给停止键让位,不然长名字会钻到按钮底下 */
.skel-label {
  position: absolute;
  left: 10px;
  right: 52px;
  bottom: 13px;
  z-index: 2;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.skel-shimmer {
  width: 100%;
  height: 100%;
  background: linear-gradient(
    100deg,
    transparent 30%,
    color-mix(in oklch, var(--line) 60%, transparent) 50%,
    transparent 70%
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}
@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 窄屏不用再专门收窄列数了:定宽多列会自己退成一列 */
@media (max-width: 640px) {
  /* 手机上把这一排的触控目标抬到 40px —— 站内对触屏的底线
     (见 App.vue 里 .param-btn / .clear-icon 那几条)。桌面维持原尺寸:
     那边有鼠标,把它撑大只会让版面变松 */
  .enhance-btn,
  .enhance-mode {
    height: 40px;
  }
  /* 提示条上那枚 ×:22px 是桌面尺寸,手指按不准 ——
     它就是这条提示唯一的出口,点不中就只剩等它自己消失 */
  .note-close {
    width: 40px;
    height: 40px;
    margin: -9px -9px -9px 0;
  }
  .note-close svg {
    width: 15px;
    height: 15px;
  }

  .feed-grid {
    column-gap: var(--sp-2);
  }
  .tile {
    margin-bottom: var(--sp-2);
  }
  .prompt-box {
    border-radius: var(--r);
  }
  /* 导航改两行:第一行品牌与主题按钮分居两端,第二行视图切换占满整行居中。
     三栏(1fr auto 1fr)在 375px 下左右各只剩约 60px,品牌字标会被挤坏 */
  .masthead {
    grid-template-columns: 1fr auto;
    padding: var(--sp-3) 0;
  }
  .wordmark {
    grid-row: 1;
    grid-column: 1;
    justify-self: start;
  }
  .mast-actions {
    grid-row: 1;
    grid-column: 2;
    justify-self: end;
  }
  .nav-seg {
    grid-row: 2;
    grid-column: 1 / -1;
    justify-self: center;
  }
  /* 触控目标放大到 40px:34px 在手机上容易点错,40px 兼顾参数栏不至于过高 */
  .param-btn {
    width: 40px;
    height: 40px;
  }
  .param-btn svg {
    width: 18px;
    height: 18px;
  }
  /* 桌面 19px,窄屏跟着胶囊一起再提一档,图标与圆底的比例才不会显得变空。
     .icob 本体不再单列:桌面已是 40px,这里再写一遍是死规则 */
  .icob svg {
    width: 20px;
    height: 20px;
  }
  /* iOS Safari 聚焦字号 <16px 的输入框会放大整页,面板内的数字/尺寸输入提到 16px */
  .num-input {
    font-size: var(--fs-lg);
  }
  /* 底部三个动作键跟着参数胶囊一起升到 40px:触控目标要一致,
     只升一半的话它们会比左边那排小一圈,手指点起来也明显更难点中 */
  .enhance-split {
    height: 40px;
  }
  .clear-icon,
  .gen-icon {
    width: 40px;
    height: 40px;
  }
  .clear-icon svg,
  .gen-icon svg,
  .enhance-btn svg {
    width: 18px;
    height: 18px;
  }
  /* 档位开关也得够宽:桌面靠左右内边距到约 29px,手指点不准。
     改成定宽居中,图标仍比主键小一档 —— 它是这个控件里的次级动作 */
  .enhance-mode {
    justify-content: center;
    min-width: 40px;
    padding: 0;
  }
}
</style>
