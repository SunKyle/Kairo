<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch, defineAsyncComponent } from 'vue'
import { PhSun, PhMoon, PhX } from '@phosphor-icons/vue'
import ImagePreview from './components/ImagePreview.vue'
import HomePage from './components/HomePage.vue'
import CharacterPage from './components/CharacterPage.vue'
import SettingsPage from './components/SettingsPage.vue'
import AppearancePanel from './components/AppearancePanel.vue'
import InteractionSettingsPanel from './components/InteractionSettingsPanel.vue'
import PhotoSettingsPanel from './components/PhotoSettingsPanel.vue'
import MemoryPrivacyPanel from './components/MemoryPrivacyPanel.vue'
import NavSegment from './components/NavSegment.vue'
import UndoToast from './components/UndoToast.vue'
import {
  generate,
  uid,
  loadConfigs,
  /* 设定图的提示词由 api.ts 那份纯函数拼(设定 + 取景 + 参考图那句)——
     它是那五格提示词的唯一出处,单测直接断言 */
  characterViewPrompt,
  /* "这条出图配置缺什么、还画不画得出"的唯一判法(见 api.ts)——
     主界面这两处早先各写了一句近似的话,缺模型名时说法还不一样 */
  imageConfigGap,
  loadCharacters,
  saveCharacters,
  /* 来源表空不空(见 types 的 FieldOriginMap):空表不写进记录,
     老角色与手填出来的角色保持同一种形状 */
  hasOrigin,
  exportCharacter,
  readCharacterZip,
  getProvider,
  vendorOf,
  coverSrc,
  releaseSrc,
  CHARACTER_VIEWS,
  /* 默认五类(主视图/全身/侧面/服装/肢体)。**"一次补齐"只跑这一组** ——
     退役的 detail / closeups 归在详情页的「其他设定图」,是"想加就加"的,
     自动补齐带上它们会让每一次新建都多花两次出图调用 */
  defaultViews
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
import { abortCharImages } from './lib/imageJobs'
/* 未发送的草稿按角色存在内存(见 lib/chatDraft)—— 角色被真正删除时那格也要收走 */
import { clearDraft } from './lib/chatDraft'
import { migrateSummariesOnce } from './lib/memoryMigrate'
import { NAV_ITEMS, type Page } from './lib/nav'
import { DEFAULT_SETTINGS_SECTION, type SettingsSection } from './lib/settingsNav'
import { formatHash, parseHash } from './lib/router'
import { useFeedback } from './composables/useFeedback'
import { useConfigs } from './composables/useConfigs'
import { useHistory } from './composables/useHistory'
import { useCharacters } from './composables/useCharacters'
import { useChat } from './composables/useChat'
import { useMemories } from './composables/useMemories'
import { useRelationship } from './composables/useRelationship'
import { useChatFlow } from './composables/useChatFlow'
import { useGeneration } from './composables/useGeneration'
/* 外壳的两枚纯装饰开关(主题 / 顶栏滚动态)收在 composables/useAppShell.ts ——
   它们与那上千行业务编排毫无关系,搬出去只是把"壳"和"编排"分开摆 */
import { useAppShell } from './composables/useAppShell'
/* 角色页交过来的那份载荷形状 —— 它是**产出**它的那一处(见 useCharacterDraft),
   主界面这里只按它落库,不再自己抄一份 */
import type { CharacterSavePayload } from './composables/useCharacterDraft'
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
import { sameStale, staleAfterGen, staleAfterSpecChange } from './lib/staleViews'
/* 界面偏好(不是数据)。与主题同一类:不跨标签页同步,丢了不影响任何东西 */
import {
  loadSceneModes,
  saveImmersive,
  saveSceneMode,
  saveShowAct,
  saveShowThink,
  savedImmersive,
  savedShowAct,
  savedShowThink
} from './lib/prefs'
/* 对话背景图:沉浸页铺满屏幕的那一张。**单独一张表**(见 idb.ts 的 BACKDROP_STORE) */
import {
  deleteChatBackdrop,
  getChatBackdrop,
  putChatBackdrop,
  type ChatBackdrop
} from './lib/idb'
import type { HistoryEntry, Character, CharacterViewKind, ChatMessage, ImportedCharacter } from './types'
/* 页面切换的"标题先行、内容跟上"镜头用 GSAP timeline 编排(见下面 onPageEnter/onPageLeave)。
   只用核心,不引插件——CSS 交叉淡入做不到多元素分步,这正是它补的那块;
   其余微交互与循环动画仍归 CSS/motion-v,不动。 */
import { gsap } from 'gsap'

/* —— 路由级代码分割（P1-1）——
   这几个页面都是「靠 v-if 条件挂载、且不是首屏」的重页,把它们改成异步组件:
   动态 import 会让 Vite 把它们各自拆成独立 chunk,不再挤进初始包。
   反过来,CharacterPage(被 charPageRef 命令式调用,异步会让 ref 在 chunk 到位前为 null)、
   ImagePreview(常驻挂载,异步无收益还会打断退出过渡)、HomePage(落地首屏)都保持同步。 */
const ChatPage = defineAsyncComponent(() => import('./components/ChatPage.vue'))
const HistoryPage = defineAsyncComponent(() => import('./components/HistoryPage.vue'))
const MemoryPage = defineAsyncComponent(() => import('./components/MemoryPage.vue'))
const ApiSettingsPanel = defineAsyncComponent(() => import('./components/ApiSettingsPanel.vue'))

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
  imageReady,
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
  /* 从参数面板进设置页:切页与收起面板都归主界面。
     落点必须是**接口那一区** —— 用户是从某个模型的参数面板点过来的,
     把他丢在"外观"上等于让他自己再找一次(见 settingsSection 的说明) */
  enterSettings: () => {
    settingsSection.value = 'api'
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

/* 压完记忆顺手"抽记忆条目 + 判一次关系"这两件事的接线口(见 useChat 的 onSummarized、
   useMemories 的 autoExtract、useRelationship 的 autoEvaluate)。useChat 先创建、
   这两个 composable 后创建,而三者互不认识 —— 于是先摆两个"还没接上"的空实现,下面接上。
   它们只在**调用时**被读,所以顺序不影响正确性。
   同一刻驱动两件事,是因为"一段滑出窗口的对话被压成纪要"正是这两件后台整理共同的、
   有意义的时间单位 —— 关系因此受"聊了什么"影响,而不是被"又发了一条"堆出来 */
let autoExtractMemories: (charId: string, batch: ChatMessage[]) => Promise<void> = async () => {}
let autoEvaluateRelationship: (charId: string, batch: ChatMessage[]) => Promise<void> = async () => {}

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
  chatSeqOf,
  loadChatLast,
  setChatLast,
  setChatMood,
  dropChatLast,
  loadChatMessages,
  loadAllChatSummaries,
  loadEarlierChat,
  maybeSummarize,
  editChatSummary,
  forgetChatSummary,
  readChatForExport,
  writeImportedChat,
  clearChat
} = useChat({
  characters,
  chatConfig,
  notice,
  announce,
  scheduleUndo,
  /* 压完一段记忆,顺手跑两件后台整理:抽记忆条目(见 useMemories)与判一次关系
     (见 useRelationship)。两个 composable 都不认识 useChat,由主界面牵这两根线:
     先摆两个可替换的入口,下面各自创建出来之后再接上。它们都是**调用时才读**这两个变量,
     所以先后顺序不影响 */
  onSummarized: (charId, batch) => {
    /* 抽事实这一路**整批递进去**:摘掉"想"那一层、给空正文补占位、按字符预算截,
       现在都在 useMemories.runExtract 里统一做(自动与手动两条路共用一个口)。
       关系评估这一路**照旧看整批** —— 想的那一层恰恰透露亲疏,
       它是第三根杆,不受"不进长期记忆"这条限制。 */
    void autoExtractMemories(charId, batch)
    void autoEvaluateRelationship(charId, batch)
  }
})

/* 记忆条目这一域(PRD §3.2-E / F):一条条独立的事实(可编辑/删除/标记/授权),
   以及记忆中心那一页要用的读写。与 useChat 的 chatSummary 是平行的两条线 */
const {
  memories,
  extracting,
  loadMemories,
  addMemory,
  editMemory,
  setImportant,
  setShared,
  removeMemory,
  extractNow,
  autoExtract
} = useMemories({ characters, chatConfig, notice, announce, scheduleUndo })
// 接上上面那根线(见 useChat 的 onSummarized)
autoExtractMemories = (charId, batch) => autoExtract(charId, batch)

/* 关系这一域(PRD §3.2-C):读一段对话 → 判三轴这几条上的变化量 → 落到角色身上。
   与 useMemories 平行、刻意不互引(抽的是事实,判的是亲疏)。它只写整份角色目录,
   所以只需要 characters + chatConfig 两样,不需要 notice —— 自动那条路是静默后台整理 */
const { autoEvaluate } = useRelationship({
  characters,
  chatConfig
})
// 接上上面那根线(见 useChat 的 onSummarized)
autoEvaluateRelationship = (charId, batch) => autoEvaluate(charId, batch)

/* 记忆中心那枚"整理一下"。抽到 0 条**也要说一声** ——
   什么都不说的话,用户分不清"这轮没找到值得记的"和"按钮坏了",
   而这一步要打一次模型,静默失败是最难查的那种。
   (自动抽取那条路反过来:它是后台整理,不打断用户 —— 见 useMemories 的说明) */
async function extractMemoriesFromPage(id: string) {
  const n = await extractNow(id)
  notice.value = n
    ? `Remembered ${n} new ${n === 1 ? 'thing' : 'things'}.`
    : 'Nothing new worth remembering in that conversation.'
}

/* 整理要用对话那条模型配置(与压记忆同一条:它该和回话用同一个脑子)。
   配不齐时按钮给出理由,而不是点了没反应 */
const canExtractMemories = computed(
  () => !!chatConfig.value?.model.trim() && !!chatConfig.value?.baseUrl.trim()
)

/* —— 页面落在哪一页:由 hash 说了算(见 lib/router.ts) ——
   页面与对话对象都进地址栏,于是刷新不再回到首页,某段对话也能直接把链接发给别人。
   两个方向各管一头:这里读进来,下面的 watch 写回去;用户手改地址或按前进后退
   则由 onHashChange 接住 */
const initialRoute = parseHash(typeof window !== 'undefined' ? window.location.hash : '')
const page = ref<Page>(initialRoute.page)
if (initialRoute.id && initialRoute.page === 'chat') {
  chatCharId.value = initialRoute.id
}
/* 记忆中心要看**所有角色**的简报,而简报平时是按角色懒加载的 ——
   不补这一趟,冷启动直接进 #/memory 会看到满页"没有记忆",
   连用户改过的那份都看不见。immediate 管深链那一次,watch 管从导航进来 */
watch(
  page,
  (p) => {
    if (p === 'memory') void loadAllChatSummaries()
  },
  { immediate: true }
)
/* 历史页的「只看这个角色」(T12)。与 chatCharId 同一层:它是**地址栏里的一份状态**,
   而不是历史页自己的 ref —— 那样才谈得上刷新不丢、能把链接发给人。
   历史页收到它只当个普通 prop(它不认识路由) */
const historyChar = ref(initialRoute.page === 'history' ? initialRoute.byChar || '' : '')

/* 设置页内部的分区(PRD §11.12)。**不进地址栏** ——
   地址栏里放的是"哪一页、在看哪个对象"(见上面那段);设置页的分区是
   一页之内的分类浏览,刷新回到第一区是可以接受的,而把它塞进 hash 要动
   那条已经绕开好几个坑的 parse/format 往返。
   常来配接口的人也不会因此多走一步:那些引导入口直接把这一格设成 'api'
   (见下面的 openChatConfig)。
   等哪天真需要"把某个分区发给别人",再加也来得及 —— 那时改的是
   lib/router 的 VALID_PAGES 那一层,不是这里 */
const settingsSection = ref<SettingsSection>(DEFAULT_SETTINGS_SECTION)

/* 引导入口("先配一个模型"那一类)要落到**接口那一区**。
   useChatFlow 只知道"去设置页"(它不认识设置页内部的分区),
   所以由这里补上那一步 —— 两件事写在一处,免得以后有人只改了其中一半 */
function openChatConfig() {
  settingsSection.value = 'api'
  openChatConfigSettings()
}

/* —— 非对话页的深链:那个 id 从前**解析出来就被丢了**(S-21),
   于是 #/chars/:id 打不开某个角色的详情、#/history/:id 定位不到某条记录。
   两处各自有现成的入口,这里只负责把 id 递过去:
   - 角色页 → 它暴露的 openDetail(与详情页那枚 Details、角色页卡片走同一条);
   - 历史页 → openPreview,先在已读到的历史里按 id 找那一条。
   找不到就当没这回事(老书签 / 那条已被删),界面退回列表 —— 不弹错。

   T12 又多了 `#/history/by/:charId`:那是"只看这个角色",不是"打开某一条",
   所以走的是 historyChar 而不是 openPreview。**两者的值长得一样**(都是 uid()),
   分得开全靠路由那一层把它们落在不同的字段上(见 lib/router) */
const pendingHistoryId = ref('')
function applyRouteId(p: Page, id: string | undefined, byChar: string | undefined) {
  if (p === 'history') {
    /* 按角色筛这一支要先处理:它和 id 是互斥的,而地址栏里手改成 `#/history`
       (两段都没有)时也要把筛子放掉 —— 否则界面停在筛过的样子,
       而地址栏已经不代表它了(与 chatCharId 那条同一条理由) */
    const next = byChar || ''
    if (historyChar.value !== next) historyChar.value = next
    if (!id) return
    const entry = history.value.find((h) => h.id === id)
    /* 刷新直接进深链时历史还没读完(它在启动后才 load)—— 记下来,读完再开 */
    if (entry) openPreview(entry)
    else pendingHistoryId.value = id
    return
  }
  if (!id) return
  if (p === 'chars') {
    /* 等这一帧渲染完再叫:角色页那时才挂得上(与 openCharacterDetail 同一处理) */
    nextTick(() => charPageRef.value?.openDetail(id))
  }
}
/* 首帧那一次:等挂载之后再用 id(角色页/历史页这时才在) */
onMounted(() => applyRouteId(initialRoute.page, initialRoute.id, initialRoute.byChar))
/* 深链等的是"历史读完了"这一件事:读到那一条就开,读完整份还没有就放弃 */
watch(history, (list) => {
  const id = pendingHistoryId.value
  if (!id) return
  const entry = list.find((h) => h.id === id)
  if (!entry) return
  pendingHistoryId.value = ''
  openPreview(entry)
})

/* 状态变了就写回地址栏。用 replaceState 而不是 pushState:这些变化
   (切页、换对话对象)每一步都进历史栈的话,用户按一次后退只退回上一个 tab,
   而返回上一页这个动作本身就被埋掉了 */
watch([page, chatCharId, historyChar], ([p, cid, hc]) => {
  if (typeof window === 'undefined') return
  const id = p === 'chat' && cid ? cid : undefined
  /* 「只看某角色」只在历史页上有意义。不在那一页时**不写进地址栏** ——
     留在里面会让别的页也顶着一个 `#/history/by/…` 式的尾巴,而它在那儿不指向任何东西 */
  const byChar = p === 'history' && hc ? hc : undefined
  const targetHash = formatHash(p, id, byChar)
  if (window.location.hash !== targetHash) {
    window.history.replaceState(null, '', targetHash)
  }
})

/* 反方向:用户手改地址、或按了前进后退。**只认 hash**,不碰别处状态 */
function onHashChange() {
  const { page: p, id, byChar } = parseHash(window.location.hash)
  if (page.value !== p) page.value = p
  if (p === 'chat') {
    if (id) {
      if (chatCharId.value !== id) chatCharId.value = id
    } else if (chatCharId.value) {
      /* hash 里的 id 段没了(用户手改回 #/chat)时也要把当前角色放掉 ——
         否则界面停在旧角色,而地址栏已经不代表它了 */
      chatCharId.value = ''
    }
    return
  }
  // 非对话页:把 id 交给对应的页(见 applyRouteId),不再丢掉
  applyRouteId(p, id, byChar)
}

/* —— 沉浸式对话页 ——
   它是**同一个对话页的第二种骨架**,不是第二个页面:状态、消息、输入、流式全复用,
   只换外层 chrome(见 doc/对话体验.md)。

   两个状态而不是一个,是因为它们回答的问题不同:
   - `immersive` 是**用户的偏好**(存盘,离开这一页也不变);
   - `immersiveOn` 是**此刻这一页长什么样** —— 顶栏是全站唯一去别的页的入口,
     所以只要不在对话页,chrome 就必须回到普通。偏好留着,下次进对话页直接生效。 */
const immersive = ref(savedImmersive())
const immersiveOn = computed(() => immersive.value && page.value === 'chat')
/* 设定某一档。与 setTheme 同一条:对话页顶上那枚按钮与设置页的外观分区
   共用这一个入口,落盘只发生在这里 */
function setImmersive(on: boolean) {
  if (immersive.value === on) return
  immersive.value = on
  saveImmersive(on)
}
function toggleImmersive() {
  setImmersive(!immersive.value)
}

/* —— 心理层次(说/想/做)的三枚开关 ——
   与主题/沉浸同一类:界面偏好,存 localStorage,**不跨标签页同步**,这里持一份响应式镜像。

   两根"展示杆"(showThink/showAct)是**全局**的:一个人想看/不想看心里话,是口味,
   不该每个角色再各设一遍。关掉只影响这一页给不给画 —— 事件还在库里、照样喂下一轮、
   该进记忆的还进(三根杆彼此独立,见 doc/对话体验.md §6.4)。

   那根"产出闸"(sceneMode)是**角色级**的:"此刻在不在场景里"是一段关系当前的处境,
   不是永久的界面口味,所以按 charId 分条(与互动偏好同一层)。这里只维护界面镜像;
   真正 gate 服务端产不产 `[act]` 的是发请求那一刻 useChatFlow 现读的 sceneModeFor ——
   两边落的是同一把键、同一套逻辑,不会各说各话。 */
const showThink = ref(savedShowThink())
const showAct = ref(savedShowAct())
const sceneModes = ref<Record<string, boolean>>(loadSceneModes())
const sceneMode = computed(() => sceneModes.value[chatCharId.value] === true)

function toggleShowThink() {
  showThink.value = !showThink.value
  saveShowThink(showThink.value)
}
function toggleShowAct() {
  showAct.value = !showAct.value
  saveShowAct(showAct.value)
}
function toggleScene() {
  const id = chatCharId.value
  if (!id) return
  const next = sceneModes.value[id] !== true
  // 换整份对象再赋值:直接改旧对象上的那一个键,Vue 不一定重算依赖它的 computed
  sceneModes.value = { ...sceneModes.value, [id]: next }
  saveSceneMode(id, next)
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
  /* 与所有出图入口同一个判法:缺地址与缺模型名是两件事,话也分开说 */
  const gap = imageConfigGap(config.value)
  if (gap) {
    notice.value = gap
    return
  }

  const had = backdrops.value[id]
  backdropBusy.value = { ...backdropBusy.value, [id]: true }
  try {
    const out = await generateChatBackdrop(id, scene)
    if (!out.blob) {
      notice.value = out.error || 'The background could not be drawn — nothing has changed.'
      return
    }
    /* 换掉旧的那张:它不再被界面引用,连同 objectURL 一起放掉 */
    const stale = had?.blob
    const rec: ChatBackdrop = { charId: id, scene, blob: out.blob, createdAt: Date.now() }
    backdrops.value = { ...backdrops.value, [id]: rec }
    try {
      await putChatBackdrop(rec)
    } catch (e) {
      /* 写不进去就只活在内存里这一场(下一次重画),但不能一声不响 ——
         用户看到过这张图,刷新没了却没人说过为什么 */
      console.error('[Kairo] could not save the backdrop', e)
      notice.value = 'This background will only show for this session — it could not be saved.'
    }
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

// —— 外壳:主题 + 顶栏滚动态 ——
/* 这两块纯装饰状态收在 composables/useAppShell.ts(主题档位/切换/跟随系统,
   与页面滚没滚)。它们与业务编排无关,搬出去后这里只留一句解构:
   theme/setTheme/toggleTheme 接回顶栏那枚按钮与设置页的外观分区,
   scrolled 接回顶栏的毛玻璃类。onMounted/onBeforeUnmount 里的挂载与收尾都在
   composable 内部完成,下面这三条 onBeforeUnmount 是**另外的**东西(跨标签页
   重载 / hashchange / 同步通道),不属于外壳,留在这儿各收各的。 */
const { theme, setTheme, toggleTheme, scrolled } = useAppShell()

onBeforeUnmount(() => window.removeEventListener('storage', onStorageSync))
onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange))
onBeforeUnmount(() => syncChannel?.close())

/* —— 页面切换镜头（GSAP，P1b）——
   原来是 <Transition name="page"> 的纯 CSS 交叉淡入(整块一起淡)。这里升级成
   受控的多元素镜头:新页的**顶栏先落、其余区块紧接着 stagger 跟上**,读起来像
   "这一页在铺陈",而不是"一整块浮现"。CSS transition 分不出这两组,GSAP timeline 天生就是干这个的。
   铁律照旧:只动 transform/opacity(autoAlpha/y),绝不碰 width/height/top/left;
   离场页脱离文档流那件事由原来的 .page-leave-active 搬进 onPageLeave 里做(见注释)。 */

/* 每次调用现读,不缓存:系统"减弱动效"是运行期可切的,原来靠 CSS @media 反应式生效,
   这里也得跟着即时降级(缓存成常量就漏掉用户中途改设置这一路)。 */
const prefersReduced = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

function onPageEnter(el: Element, done: () => void) {
  if (prefersReduced()) {
    done()
    return
  }
  /* 满屏工作台页(聊天)自带固定背景层 + 两个撑满视口的高面板,对它们做位移/缩放
     会把整块背景一起拽动、高面板缩放又硬弹,看着就"硬"。这类页**绝不碰 transform**。
     页面用 data-page-motion="fade" 声明自己走这条路。
     原先是整块 0.26s 淡入 —— 对一块几乎不透明的满屏面板,纯透明度切换和"瞬间跳过去"
     差别太小,读起来像"没动画"。这里改成对它的**可见直接子块**做错峰淡入:
     逐块浮现、彼此拉开一点时序,读起来像这一页在一点点点亮;而每一步只动 opacity,
     一个字节的几何都不挪,背景与高面板自然不会被拽动。 */
  if ((el as HTMLElement).dataset.pageMotion === 'fade') {
    /* 只挑当前可见的直接子块:v-show 收起的那一栏(如沉浸态的左栏)display 是 none,
       把它算进错峰会凭空多一拍空等。chat-bg / chat-rail / chat-main 任意两两组合
       都落在"≥2"这一档,退不空 */
    const kids = (Array.from(el.children) as HTMLElement[]).filter(
      (k) => getComputedStyle(k).display !== 'none'
    )
    if (kids.length >= 2) {
      gsap.from(kids, {
        autoAlpha: 0,
        duration: 0.42,
        ease: 'power1.out',
        stagger: 0.09,
        onComplete: done
      })
      return
    }
    // 只有一块(或全隐藏)时退回整块淡入,别硬拆
    gsap.from(el, { autoAlpha: 0, duration: 0.26, ease: 'power1.out', onComplete: done })
    return
  }
  const kids = Array.from(el.children) as HTMLElement[]
  const tl = gsap.timeline({ onComplete: done })
  if (kids.length >= 2) {
    // 页头先落地(位移更大、单独成拍),正文再逐块错峰跟上——两组在时间上拉开,
    // 才看得出"这一页在铺陈";之前压得太重叠、位移太小,肉眼几乎分辨不出。
    tl.from(kids[0], { autoAlpha: 0, y: 24, duration: 0.3, ease: 'power3.out' }).from(
      kids.slice(1),
      { autoAlpha: 0, y: 18, scale: 0.985, duration: 0.32, ease: 'power2.out', stagger: 0.07 },
      '-=0.1'
    )
  } else {
    // 只有一块(或空)时退回整块淡入,别硬拆
    tl.from(el, { autoAlpha: 0, y: 18, duration: 0.34, ease: 'power3.out' })
  }
}

function onPageLeave(el: Element, done: () => void) {
  if (prefersReduced()) {
    done()
    return
  }
  const e = el as HTMLElement
  /* 离场页脱离文档流、钉在 .frame(position:relative)顶部:
     高度让给入场页,滚动条不会中途缩一下又弹回来。这正是原 .page-leave-active 干的活。 */
  e.style.position = 'absolute'
  e.style.top = '0'
  e.style.left = '0'
  e.style.right = '0'
  // 满屏工作台页(聊天)离场也只淡出、不整体上移,和入场对称,免得高面板滑一下显得硬
  const fadeOnly = e.dataset.pageMotion === 'fade'
  gsap.to(e, {
    autoAlpha: 0,
    y: fadeOnly ? 0 : -6,
    duration: 0.15,
    ease: 'power1.in',
    onComplete: done
  })
}

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
    if (!NAV_ITEMS.some((i) => i.value === v)) return
    /* 从导航点进历史页 = 要看**全部**历史 —— 上一轮那个「只看某角色」的筛子
       不该跟着进来。它只是地址栏里的一份状态,而"点导航那一格"这个动作
       说的就是"去那一页",不是"接着筛"。
       放在这里而不是 watch(page) 里:用户在历史页上再点一次导航也该清掉,
       而那一次 page 没有变,watch 根本不会响 */
    if (v === 'history') historyChar.value = ''
    page.value = v as Page
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
  /* 记忆条目整份读进来。它不像消息那样按角色懒加载 ——
     记忆中心的筛子与计数都要看全量,而且条数是几十的量级(见 useMemories) */
  void loadMemories()
  /* 存量简报搬成记忆条目(见 lib/memoryMigrate)。它只在**第一次启动**时
     真做事 —— 升级前攒下的那些简报搬进来,老用户的记忆中心才不是空的。
     搬完要重读一次,否则这一页看不到刚搬进去的那几条;
     顺便广播一声让别的标签页也跟着重读:库是共享的,而地标是各读各的 */
  void migrateSummariesOnce().then((moved) => {
    if (!moved) return
    void loadMemories()
    announce('memories')
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
    labels.push('AI connections')
  }
  let loadFailed = false
  if (targets.includes('characters')) {
    loadCharacters()
      .then((list) => {
        characters.value = list.map(normalizeChar)
        // 目录变了,左栏那行"最后说了什么"也要跟着对齐
        void loadChatLast()
        labels.push('characters')
      })
      .catch((e) => {
        /* 读失败不能伪装成"同步成功" —— 那句 Updated from another tab
           会把一次没拿到的新数据说成已经拿到了。留痕,并且如实说 */
        console.error('[Kairo] reload characters failed', e)
        loadFailed = true
      })
  }
  if (targets.includes('collections')) {
    reloadCollectionsFromDb()
    labels.push('collections')
  }

  /* 说一声。不说的话用户只会觉得"我明明没动,列表却变了" ——
     这是同步本身带来的观感问题,不是噪音。
     但有一类必须分开说:重载本身失败了。那时数据没有更新,
     再说"已从另一个标签页更新"是在骗人 */
  notice.value = loadFailed
    ? 'Updated from another tab, but the character list could not be reloaded.'
    : labels.length
      ? `Updated from another tab — reloaded ${labels.join(' and ')}.`
      : ''
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

  /* 记忆条目:另一页改了一条(或抽了一批)就整份重读。
     它是几十条的量级,重读一次比按 id 增量合并更不容易出错 ——
     而"共享画像"改一次会牵动**所有**角色的可见范围,本来也没法只重读一条。
     这里不看 charId:广播里那个 charId 只说"是谁的那条变了",
     而本页手上这份是全量 */
  if (batch.some((m) => m.kind === 'memories')) {
    await loadMemories()
    labels.push('memory')
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
  /* 心情同理:另一页清空/删掉这段对话之后,本页内存里那份"它正恼着"
     也得跟着放掉 —— 留着的话,下一轮会把用户刚刚清掉的心情又喂回模型 */
  chatMood.value = drop(chatMood.value)
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
 *  名字必填 —— 没名字的卡没法认。
 *
 *  载荷的形状取自 useCharacterDraft 那一份 —— 它是**产出**这份载荷的地方。
 *  在这里再抄一遍的话,加一栏要同时改四处,而漏掉任何一处都不报错:
 *  那一栏只是静静地存不下去(origin 这一栏就是这么被发现的) */
async function saveCharFromPage(d: CharacterSavePayload) {
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
      /* 来源表跟着设定一起更新 —— 它就是"这份设定里哪几栏是模型填的"。
         空表**删掉这一项**而不是写一个 {}:老角色与"从没起过稿"的角色
         保持同一种形状(与 pinned 同一条理由) */
      if (hasOrigin(d.origin)) c.origin = { ...d.origin }
      else delete c.origin
      /* 换音色时旧的那段克隆样本要跟着清掉 —— 留着就是一段没人认领的录音。
         只在"换了另一个样本"时清:同一个 sampleId 再存一次当然不动它 */
      const prevSample = c.voice?.sampleId
      const nextSample = d.voice.sampleId
      c.voice = { ...d.voice }
      if (prevSample && prevSample !== nextSample) void deleteVoiceSample(prevSample)
      if (ref) c.sourceRef = ref
      /* 改的可能只是一个名字,也可能把脸改了。**设定动了 = 基准动了** ——
         已经出过的那几张(连正脸一起)都是照旧设定生的,全部标为待确认。
         正脸也在其中:它同样是旧设定的产物,重跑它才是跟上新设定的第一步。
         详情页那条持续提醒会点名它们,由用户决定重跑还是保留(见 lib/staleViews)。

         **只在设定图确实已经读进内存时才动这个标记** —— 没读到时我们并不知道
         这个人有几张图,照空的算会把一个已有的标记无声抹掉 */
      const viewsLoaded = charViews.value[c.id]
      const specChanged = before !== JSON.stringify({ ...d.fields, desc: c.desc })
      if (specChanged && viewsLoaded) {
        const next = staleAfterSpecChange(viewsLoaded.map((v) => v.kind))
        if (next.length) c.staleViews = next
        else delete c.staleViews
      }
      await saveCharacters(characters.value)
      /* 说一声,但不再自己决定"要不要重跑" —— 提醒条就落在这个人的详情页上,
         这一句只是把用户送过去看它。一张视图都没有时不必说:没有"旧的"可重跑 */
      notice.value =
        specChanged && viewsLoaded?.length
          ? 'Saved. The reference views no longer match this spec — see them on this page.'
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
      /* 设定里每一项是谁定的(见 types 的 FieldOriginMap)。空表不写 ——
         手填出来的角色没有"哪一栏是模型填的"这回事 */
      ...(hasOrigin(d.origin) ? { origin: { ...d.origin } } : {}),
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
  /* 在途的对话出图 / 背景图也掐掉(见 lib/imageJobs)。角色删掉之后它们再画完
     只有两个下场:照片被 drawChatPhoto 的存在性守卫挡下(字节白花),
     背景图连守卫都没有 —— 它会把这个已删角色的背景图重新写回库里 */
  abortCharImages(id)

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
      /* 那半句没发出去的草稿也一起收 —— 人没了,话不该留着。
         放在这一步而不是删除那一刻:撤销窗口内反悔了,它还在 */
      clearDraft(id)
      const rest = { ...charViews.value }
      delete rest[id]
      charViews.value = rest
      /* 背景图也一起走:它属于这个角色这一场戏,角色没了就没有"这一场"了 */
      const bgRest = { ...backdrops.value }
      delete bgRest[id]
      backdrops.value = bgRest
      /* **先落盘,再广播。** 顺序从前是反的:announce 一发,别的标签页立刻重读,
         而那时 deleteChatOf / putCharRefs 还没落地(都是未 await 的 void)——
         对面读到的是"没删干净"的那份,并且此后再没有一次广播来纠正,
         幽灵对话/设定图就留在了别的标签页里。purge 是同步回调,await 不了,
         于是把这一串收进一个 async 块:删完再通知,失败也有个说法 */
      void (async () => {
        try {
          await deleteChatOf(id)
          await deleteChatBackdrop(id)
          // 目录这一步同时按"属主前缀"把这个角色的图从库里收走(见 putCharRefs)
          await saveCharacters(characters.value)
        } catch (e) {
          console.error('[Kairo] delete character: saved data was not removed', e)
          notice.value = 'Could not fully remove this character — reopen to try again.'
        } finally {
          // 别的标签页若缓存着这个角色的设定图或对话,也要把它们放掉
          announce('charViews', id)
          announce('chat', id)
        }
      })()
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
    /* 背景图**从库里读**,不走内存那份:backdrops 是按角色懒加载的,
       没进过沉浸页的角色在内存里根本没有(见 loadBackdrop)。与 chat 一起交给
       导出 —— 缺了它,对方拿到的是一个进沉浸页只有主题色的角色(S-14) */
    const backdrop = await getChatBackdrop(id)
    const images = await exportCharacter(c, charViews.value[id] || [], chat, backdrop)
    const msgCount = chat.messages.length
    /* 回执要把三样都说到:一个只有设定没有图的角色、一个连对话都带走的角色、
       一个还带着背景的,导出来的东西差别很大,让用户知道包里到底装了什么 */
    const parts: string[] = []
    if (images) parts.push(`${images} image${images === 1 ? '' : 's'}`)
    if (msgCount) parts.push(`${msgCount} message${msgCount === 1 ? '' : 's'}`)
    if (backdrop) parts.push('a background')
    notice.value = parts.length
      ? `Exported “${c.name}” with ${parts.join(' and ')}.`
      : `Exported “${c.name}” — it has no images or conversation yet, so the zip is settings only.`
  } catch (e) {
    notice.value =
      e instanceof Error && e.message ? e.message : 'Could not export this character'
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
    notice.value = `That file is over ${MAX_CHAR_ZIP / 1024 / 1024} MB — too large for a character export.`
    return
  }
  let list: ImportedCharacter[]
  try {
    list = await readCharacterZip(file)
  } catch (e) {
    notice.value = e instanceof Error && e.message ? e.message : 'Could not read that file'
    return
  }
  if (!list.length) {
    notice.value = 'That zip has no usable characters in it.'
    return
  }

  const added: Character[] = []
  const failed: string[] = []
  let msgs = 0
  /* **逐个导入,逐个兜底。** 从前是一个 try 包住整个循环:第 N 个角色
     写盘失败时,前面已经落库的设定图/消息/图全成了无人认领的孤儿,
     而目录一条都没进 —— 用户看到的是"什么都没导进来"加一句
     Could not save。现在:坏的那一个跳过并如实计数,好的照进 */
  for (const imp of list) {
    const c: Character = {
      id: uid(),
      name: imp.name,
      createdAt: imp.createdAt,
      ...(imp.fields ? { fields: { ...imp.fields } } : {}),
      ...(imp.desc ? { desc: imp.desc } : {}),
      ...(imp.persona ? { persona: { ...imp.persona } } : {}),
      /* 来源表跟着包走(见 types 的 ImportedCharacter.origin)——
         包里的设定是**对方**那次起稿填的,丢掉它会让接收方看到每一栏
         都像是"他自己写的" */
      ...(hasOrigin(imp.origin) ? { origin: { ...imp.origin } } : {}),
      ...(imp.ref ? { ref: imp.ref } : {}),
      ...(imp.sourceRef ? { sourceRef: imp.sourceRef } : {}),
      ...(imp.refKind ? { refKind: imp.refKind } : {})
    }
    try {
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
      /* 背景图跟着角色落库(S-14)。它挂在新的 charId 上,与对话同一归属 ——
         一起失败时下面的兜底也该把它收掉。putChatBackdrop 自己不抛(写不进去
         只当没画过),所以这一步不会成为"角色导不进来"的新理由 */
      if (imp.backdrop) {
        await putChatBackdrop({
          charId: c.id,
          scene: imp.backdropScene || '',
          blob: imp.backdrop,
          createdAt: Date.now()
        })
      }
      added.push(c)
    } catch (e) {
      /* 这个 id 是刚生成的(不与任何现有角色冲突),所以兜底收掉
         可能已经写了一半的东西:消息/图/记忆由 deleteChatOf 一并清,
         背景图另属一张表、单独收,设定图则由随后那次 saveCharacters 按"属主前缀"裁剪 */
      console.error('[Kairo] import one character failed', c.name, e)
      failed.push(c.name)
      try {
        await deleteChatOf(c.id)
        await deleteChatBackdrop(c.id)
      } catch {
        /* 收不掉也只是多几个无人认领的键,不该再抛出来 */
      }
    }
  }
  if (!added.length) {
    notice.value = 'Could not import any of the characters in that file.'
    return
  }
  characters.value = [...added, ...characters.value]
  await saveCharacters(characters.value)
  /* 补一趟左栏那行摘要:导入的对话已经在库里,而 chatLast 只在启动时读过一次 ——
     不补的话,这些明明带着历史的角色在左栏会显示 "No messages yet" */
  if (msgs) void loadChatLast()
  const base =
    added.length === 1 ? `Imported “${added[0].name}”.` : `Imported ${added.length} characters.`
  notice.value = failed.length
    ? `${base} ${failed.length} failed (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}) — they were skipped.`
    : msgs
      ? `${base} Includes ${msgs} message${msgs === 1 ? '' : 's'} of conversation.`
      : base
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
 * 正脸:角色有主参考图(上传的 / 上一版正脸)就以它为参考图,
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
     而 fail 写的是 home 那条 .err —— 在角色页触发时它不渲染,等于没提示。
     判据与话都借 imageConfigGap:从前这里只看模型名,地址空着会一路撞到上游 */
  const gap = imageConfigGap(cfg)
  if (gap) {
    notice.value = gap
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
    /* —— 一致性标记:哪几张设定图跟当前的「基准」对不上了(见 lib/staleViews)——
       正脸是基准,重跑它 = 其余每一张都过期;重跑别的张 = 只有它自己跟上了新基准。
       只在**真的变了**时才落盘:每张图都重写一遍角色目录是白写,
       而它顺带还会写一次参考图的 IndexedDB、并让别的标签页重读一遍角色 */
    const nextStale = staleAfterGen(
      kind,
      (charViews.value[c.id] || []).map((v) => v.kind),
      c.staleViews || []
    )
    const staleChanged = !sameStale(nextStale, c.staleViews || [])
    if (staleChanged) {
      if (nextStale.length) c.staleViews = nextStale
      else delete c.staleViews
    }
    /* 正脸同时是这张角色的封面与头像,生成成功后就写回 ref ——
       否则卡片上停留的还是那张上传的底图,跟刚生成的脸对不上。
       底图不会被这一下顶掉:它另存了一份(sourceRef),
       其余四张设定图还要拿它和正脸一起当参考 */
    if (kind === 'front') {
      const oldCover = c.ref
      c.ref = blob
      await saveCharacters(characters.value)
      // 界面已经换成新图,旧封面那张不再被任何地方引用
      if (oldCover && oldCover !== blob) releaseSrc(oldCover)
    } else if (staleChanged) {
      await saveCharacters(characters.value)
    }
    /* 重跑正脸之后,其余那几张就是照上一张脸出的了。说一声就够 ——
       **不替用户删、也不当场重跑**(删不可逆、重跑要花钱),而"到底哪几张对不上"
       交给详情页上那条持续提醒点名,由用户决定(见 CharacterPage 的 .stale) */
    if (kind === 'front' && rest.length) {
      notice.value = 'Front view updated — the other views still show the previous face.'
    }
    ok = true
  } catch (e) {
    /* 用户主动停的不算失败 —— 按报错抛出来会让人以为出了故障 */
    notice.value = ctl.signal.aborted
      ? 'Generation stopped.'
      : e instanceof Error && e.message
        ? e.message
        : 'Could not generate this view'
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
/** 一次补齐**默认五类**。串行跑:每张都以前一张为参考图,并行只会互相抢带宽;
 *  中途失败(多半是配置或配额)就直接停下,免得连错四次。
 *
 *  **只遍历 defaultViews()**,不是 CHARACTER_VIEWS —— 后者含退役的
 *  detail / closeups,那两张是详情页「其他设定图」里的可选项。
 *  带上它们的话,每新建一个角色都会多花两次出图调用,而用户可能并不想要
 *  (见 api.ts 的 group) */
async function genRemainingViews(charId: string) {
  for (const v of defaultViews()) {
    if (viewOf(charId, v.kind)) continue
    // 已经自己在跑的那张跳过:这个循环只把"还缺的"补上,不重发一遍
    if (charViewBusy.value[charId]?.includes(v.kind)) continue
    if (!(await genCharView(charId, v.kind))) return
  }
}

/** 把「待确认」的那几张按顺序重跑一遍(详情页那条提醒上的主按钮)。
 *
 *  **正脸排在最前** —— 其余每一张都以它为参考图,先跑别的等于拿旧脸当基准,
 *  跑完还是对不上。CHARACTER_VIEWS 的顺序本来就是正脸打头,照它排即可。
 *
 *  串行 + 中途失败就停:与 genRemainingViews 同一条 —— 每张都以前一张为参考,
 *  并行只会互相抢带宽;而失败多半是配置或配额,连着错下去没意义。
 *  每跑完一张,genCharView 会把它自己从清单里摘掉,所以全跑完清单自然就空了;
 *  中途停下时剩下的还留在清单里,提醒条继续挂着 —— 那正是该有的样子 */
async function regenerateStaleViews(charId: string) {
  const c = characters.value.find((x) => x.id === charId)
  if (!c?.staleViews?.length) return
  // 先按基准顺序固定下来:循环里 genCharView 会一路改写 c.staleViews
  const order = CHARACTER_VIEWS.map((v) => v.kind).filter((k) => c.staleViews?.includes(k))
  for (const kind of order) {
    // 标记留着、图却不在(理论上不会):跳过,免得为一张界面上没有的图发请求
    if (!viewOf(charId, kind)) continue
    if (!(await genCharView(charId, kind))) return
  }
}

/** 用户决定保留现有那几张:撤掉「待确认」标记。
 *  **一张图都不动** —— 这条提醒的本意就是"由用户决定",点掉它也是一种决定 */
async function dismissStaleViews(charId: string) {
  const c = characters.value.find((x) => x.id === charId)
  if (!c?.staleViews?.length) return
  delete c.staleViews
  await saveCharacters(characters.value)
}

/** 角色详情页那行「N more in History」:去历史页,并只看这个角色(T12)。
 *  跳页与筛选**一次做完** —— 分成两步(先跳页、下一帧再筛)的话,
 *  中间那一帧会先把全部历史铺出来闪一下 */
function openCharWorks(charId: string) {
  historyChar.value = charId
  page.value = 'history'
}

/** 首页那颗「New character」:切到角色页、把向导开起来。
 *  与 openCharacterDetail 同一个形状 —— 先落页再 nextTick 叫页内那个入口,
 *  反过来的话那一帧页还没挂上,调用会落在 null 上(点了一下什么也没发生)。
 *  **不直接 startEdit**:editing 是角色页私有的状态,主界面碰不到 */
function createCharacter() {
  page.value = 'chars'
  nextTick(() => charPageRef.value?.startCreate())
}

/** 首页次区要的「某个角色最后一句」。读的是 chatLast 那一份(不是 chatMessages):
 *  消息按角色懒加载,没打开过的角色在 chatMessages 里没有键,而这一页开屏就要
 *  列全 —— 用 chatMessages 的话,没点开过的角色会被当成从没聊过。
 *  **传函数**:这一份随时会被整份换掉(见 useChat 的 setChatLast),捕获住旧的那
 *  一份,排出来的就是过期快照(与 lib/homeList 的 lastOf 同一条理由) */
const homeLastOf = (id: string) => chatLast.value[id]

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
  imageReady,
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
  /* 记忆条目那份清单:发这一轮时要按"这个角色看得到什么"筛一遍(见 useChatFlow) */
  memories,
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
      <!-- 外面这层 Transition 让新旧两页交叉过渡。:css="false" 把动画整个交给
           下面的 @enter/@leave(GSAP timeline):新页顶栏先落、内容块 stagger 跟上,
           旧页淡出并脱离文档流。不再是原来那种"整块一起淡"的 CSS 交叉淡入。 -->
      <Transition :css="false" @enter="onPageEnter" @leave="onPageLeave">

      <!-- 首页(T7)。它接手了 `#/` 这个落地址 —— 原来打开应用先看到的是对话页,
           而对话页要有个"当前角色"才有内容,一个角色都没有时那是一屏空态。
           首页的两个动作(Chat / Details)都只是发意图,跳转仍走下面这些入口 -->
      <HomePage
        v-if="page === 'home'"
        :characters="characters"
        :last-of="homeLastOf"
        @chat="openChat"
        @detail="openCharacterDetail"
        @create="createCharacter"
      />

      <!-- 角色。它是这条链的头一个分支,所以是 v-if(其余各页接着 v-else-if) -->
      <CharacterPage
        v-else-if="page === 'chars'"
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
        @regenerate-stale="regenerateStaleViews"
        @dismiss-stale="dismissStaleViews"
        @more-works="openCharWorks"
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
        :chat-config="chatConfig || undefined"
        :chat-borrowed="chatBorrowed"
        :vision-config="visionConfig || undefined"
        :tts-config="ttsConfig || undefined"
        :immersive="immersiveOn"
        :backdrop="backdropSrc"
        :backdrop-busy="!!backdropBusy[chatCharId]"
        :show-think="showThink"
        :show-act="showAct"
        :scene-mode="sceneMode"
        @toggle-immersive="toggleImmersive"
        @toggle-scene="toggleScene"
        @toggle-show-think="toggleShowThink"
        @toggle-show-act="toggleShowAct"
        @new-backdrop="drawBackdrop(chatCharId)"
        @select="chatCharId = $event"
        @send="sendChat"
        @stop="stopChat"
        @regenerate="regenerateChat"
        @retry-photo="retryChatPhoto"
        @delete-message="deleteChatMessageFromPage"
        @pin="togglePinChar"
        @notice="notice = $event"
        @clear="clearChat"
        @load-earlier="loadEarlierChat"
        @goto-chars="page = 'chars'"
        @open-character="openCharacterDetail"
        @configure-chat-model="openChatConfig"
      />

      <!-- 记忆中心(PRD §5.5)。唯一的记忆管理入口:一条条事实(MemoryItem)
           加上每个角色的对话简报(chat_summary)都在这一页查看/编辑/忘掉。
           整份 chatSummary 透传进去,各角色组认领自己那一份 -->
      <MemoryPage
        v-else-if="page === 'memory'"
        :memories="memories"
        :summaries="chatSummary"
        :characters="characters"
        :extracting="extracting"
        :can-extract="canExtractMemories"
        @add="addMemory"
        @edit="editMemory"
        @remove="removeMemory"
        @important="setImportant"
        @shared="setShared"
        @extract="extractMemoriesFromPage"
        @edit-summary="editChatSummary"
        @forget-summary="forgetChatSummary"
      />

      <!-- 历史记录 -->
      <HistoryPage
        v-else-if="page === 'history'"
        :items="history"
        :collections="collections"
        :char-names="charNames"
        :char-filter="historyChar"
        @open="openPreview"
        @remove="removeHistoryEntry"
        @mark="toggleMark"
        @create-collection="createCollection"
        @delete-collection="deleteCollection"
        @clear-char-filter="historyChar = ''"
      />

      <!-- 设置(PRD §5.6 / §11.12)。SettingsPage 只是骨架(左栏分区导航 + 插槽),
           当前哪一区渲染成什么由这里装配 —— 各分区的 props 一路是显式传的,
           没有 $attrs 那种"编译器看不见"的转手。
           下面那一组 configs / active-* / mode / seed 与那串 @activate-*
           全是**接口配置那一区自己的**事,别的地方不认识它们 -->
      <SettingsPage
        v-else-if="page === 'settings'"
        :section="settingsSection"
        @section="settingsSection = $event"
      >
        <AppearancePanel
          v-if="settingsSection === 'appearance'"
          :theme="theme"
          :immersive="immersive"
          @theme="setTheme"
          @immersive="setImmersive"
        />

        <InteractionSettingsPanel
          v-else-if="settingsSection === 'interaction'"
          :characters="characters"
        />

        <!-- 出图偏好是全局的(不按角色),所以面板自带存取,这里不给 props -->
        <PhotoSettingsPanel v-else-if="settingsSection === 'photos'" />

        <MemoryPrivacyPanel
          v-else-if="settingsSection === 'memory'"
          :memories="memories"
          :characters="characters"
          @open="page = 'memory'"
        />

        <!-- 接口配置那一整块(1823 行,2026-10-14 从 SettingsPage 整份搬出来的)。
             写成 v-else-if 而不是 v-else:注册表里加了分区、这里却没有分支时,
             页面会**空白**而不是静默变成接口配置页 —— 那是一个能被测出来的漏
             (见 lib/settingsNav.test.ts 那条读源码的防漂移断言) -->
        <ApiSettingsPanel
          v-else-if="settingsSection === 'api'"
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
      </SettingsPage>
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

/* 顶栏跟着 .shell-wide 摊宽,左对齐的"Kairo Chat"就跑到了近窗口左边,
   而别的页锁在 1080 阅读栏里 —— 只有 chat 的花名位置不一样。
   面板要铺满是故意的,只把顶栏这一条收回同一根栏:居中到 1080,
   内边距取其它页 .shell 那一档 clamp,左边缘在任何屏宽下都对得齐。
   全站 box-sizing: border-box,这圈内边距落在 1080 之内(见 style.css)。 */
.shell-wide .masthead {
  max-width: 1080px;
  margin-inline: auto;
  padding-inline: clamp(16px, 4vw, 40px);
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
  /* 离场的那一页会被 JS 设成脱离文档流(见 onPageLeave),这里得是它的定位基准 */
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
   原来这里是 .page-enter/leave 一套 CSS 交叉淡入。现已换成 <Transition :css="false">
   交给 GSAP(onPageEnter/onPageLeave)编排"顶栏先落、内容跟上",离场页脱离文档流也在
   JS 里做。CSS 类不再被添加,故整块删除。 */

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
