import { ref, toRaw, watch } from 'vue'
import {
  CHAT_EXPORT_MSGS,
  CHAT_SUMMARIZE_AFTER,
  CHAT_SUMMARY_CAP,
  CHAT_WINDOW,
  summarizeChat,
  uid
} from '../api'
import {
  CHAT_PAGE,
  countChatMessages,
  deleteChatOf,
  getCharMood,
  getChatImage,
  getChatMessages,
  getChatMessagesToSummarize,
  getChatSummary,
  getLastChatLine,
  putCharMood,
  putChatMessage,
  putChatSummary
} from '../lib/idb'
import { stopSpeaking } from '../lib/speech'
import type {
  ApiConfig,
  Character,
  CharacterMood,
  ChatMessage,
  ChatSummary,
  ImportedChat
} from '../types'

/* ===== 角色对话：消息、长期记忆、以及读写 ==============================
   一期一个角色一条连续对话,所以状态都按 charId 索引(没有 sessionId)。
   这里搬的是**非流式**的那一半:读取与分页、记忆的压缩与编辑、清空、
   导入导出。真正的流式一轮(runChat / sendChat / regenerate / stop)
   留在主界面 —— 它要动出图配置、角色参考图与请求中断,归属还没定清。
   -------------------------------------------------------------------- */

export interface ChatDeps {
  characters: { value: Character[] }
  /* 当前生效的对话模型(kind = 'chat';没专配时是借来的改写那条)。
     压缩记忆要用它 —— 记忆是"这段对话的延续",它该和回话用同一个脑子:
     换个模型压出来的摘要,措辞与取舍都跟正文不是一路 */
  chatConfig: { value: ApiConfig | null }
  notice: { value: string }
  announce: (kind: 'chat', charId?: string) => void
  scheduleUndo: (item: { label: string; undo: () => void; purge: () => void }) => void
}

export function useChat(deps: ChatDeps) {
const chatCharId = ref('')
/* 已取到的消息,按角色 id 缓存。进对话页时才读,启动时不碰。
   注意这里装的是**最近一档**(见 idb.ts 的 CHAT_PAGE),不是全部历史 */
const chatMessages = ref<Record<string, ChatMessage[]>>({})
/* 前面还有更早的没读。界面据此决定要不要给"加载更早" ——
   没有它就分不清"这是第一句"和"只读到这里" */
const chatHasMore = ref<Record<string, boolean>>({})
/* 长期记忆:滑出窗口的消息压成的一段简报,按角色各一份。
   有没有这个键 = 这个角色压过没有 */
const chatSummary = ref<Record<string, ChatSummary>>({})
/* **此刻的心情**,按角色各一份(见 types.ts 的 CharacterMood)。
   它与记忆同层、同时被懒加载、同时被清,但**不进导出包** ——
   "你俩此刻"的状态带出去必然已经过期。
   它唯一的下游是**下一轮的请求**:服务端据此在 system 里补一句(见 chatMood.js)。
   界面不读它 —— 名字旁那枚药丸读的是"最后一条消息当时的情绪",那是另一个问题 */
const chatMood = ref<Record<string, CharacterMood>>({})
/* 每个角色的**最后一条**消息,只用来喂左栏(摘要那一行 + 最近活跃排序)。
   单独存一份是因为消息是按角色懒加载的:没打开过的角色 chatMessages 里没有键,
   左栏就会把它当成"从没聊过" —— 明明聊过,却显示 No messages yet 并排到最后。
   取法见 idb.ts 的 getLastChatLine,代价与消息条数无关 */
const chatLast = ref<Record<string, ChatMessage>>({})
/* 上面那份读到了没有。它比角色晚一步到,而左栏的排序与"进对话页挑哪一个"
   都要用它 —— 没到就挑,只能按创建时间排,挑中的不是左栏第一行。
   **失败也算问过了**(见下面的 finally):停在等待里的话,对话页会一直空着 */
const chatLastReady = ref(false)
/* 正在压记忆的角色。压缩是后台动作,但同一个角色不该叠两个 */
const chatSummarizing = new Set<string>()
/* "这段对话还作数吗"的代次。压缩是异步的,回来时得知道这期间它有没有被清掉 ——
   不查的话,一次后台整理会把用户刚清掉的记忆又写回去。
   与角色起稿的 draftSeq 是同一套做法:对不上就整份丢弃 */
const chatSeq = new Map<string, number>()
function bumpChatSeq(id: string) {
  chatSeq.set(id, (chatSeq.get(id) || 0) + 1)
}
/** 读这个角色此刻的代次。**只给"异步做完再回来写库"的那几条路用** ——
 *  进请求前记一份,落笔前比一次:对不上说明这期间对话被清掉过(或角色被删),
 *  这一笔就不该再写(与 maybeSummarize 同一套做法)。
 *
 *  **它与记忆共用同一个计数器**,所以比"只该在清空/删除时作废"更严一点:
 *  `forgetChatSummary` 也会 bump(那一次是为了作废在途的压缩)。于是
 *  "生成中点了忘掉记忆"会让这一轮的心情更新被丢掉 —— 代价是那一轮的状态
 *  没更新,下一轮照常,而它是自愈的;多养一个计数器换这点精度不划算。
 *  它**只加不减**:撤销"清空对话"时不会退回去,所以那一侧也有同样的极小代价 */
function chatSeqOf(id: string) {
  return chatSeq.get(id) || 0
}
/* 各角色正在生成中(没有该角色的键 = 空闲) */
const chatBusy = ref<Record<string, boolean>>({})
/* 一轮对话的中断手柄,按角色各存一个 —— 与 charViewControllers 同一个理由 */
const chatControllers = new Map<string, AbortController>()
/* 正在读取的角色。同一 id 可能被两处同时触发(选角色的 watch 与角色页的入口) */
const chatLoading = new Map<string, Promise<void>>()
// 七个平级页面:首页 / 角色 / 对话 / 画布 / 提示词库 / 历史记录 / 接口设置,同时只挂载一个
async function readChatForExport(id: string): Promise<ImportedChat> {
  const [sum, page] = await Promise.all([
    chatSummary.value[id] ? Promise.resolve(chatSummary.value[id]) : getChatSummary(id),
    getChatMessages(id, CHAT_EXPORT_MSGS)
  ])
  const messages = page.list.map((m) => ({
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    ...(m.stopped ? { stopped: true } : {}),
    ...(m.truncated ? { truncated: true } : {}),
    ...(m.mood ? { mood: m.mood } : {}),
    ...(m.imageId ? { imageId: m.imageId } : {}),
    /* 角色发的那张也要带走。**两条都要**:漏了 photo 这枚标记,
       导进来的记录会少一张图;漏了 photoId 就只剩一句"我给你看个东西"。
       **没有 photoId 就一条都不带** —— 那说明这一张还在画、或已经画失败
       (见 ChatMessage.photoFailed):包里带一个没有图的场景描述过去,
       对方读到的是一条永远转下去的骨架,而"失败"这个状态不在包的结构里 */
    ...(m.photoId
      ? {
          photoId: m.photoId,
          ...(m.photo ? { photo: m.photo } : {}),
          ...(m.photoSelf ? { photoSelf: true } : {}),
          /* 视角也一起带走:对方重画这一张时,依据该是同一个 ——
             少了它就退回"按场景判",而那正是当初画错视角的那条路 */
          ...(m.photoShot ? { photoShot: m.photoShot } : {}),
          /* 景别同上。**它比视角更容易被"按场景重判"改掉** ——
             场景串里有没有"特写"这两个字,是模型每次写都不一样的事 */
          ...(m.photoFrame ? { photoFrame: m.photoFrame } : {})
        }
      : {})
  }))
  /* 附图一起带走。**缺了它们,对方拿到的是一串"不知道在说什么的回复"** ——
     消息在,而消息指着的那张图不在。读不回来的那张跳过:
     少一张图不该让整份导出失败 */
  const ids = [
    ...new Set(
      messages
        .flatMap((m) => [m.imageId, m.photoId])
        .filter((x): x is string => !!x)
    )
  ]
  const images: Array<{ id: string; blob: Blob }> = []
  for (const imgId of ids) {
    const rec = await getChatImage(imgId)
    if (rec) images.push({ id: imgId, blob: rec.blob })
  }
  return {
    messages,
    // 忘掉过的角色导出的就是空串(库里那条正文为空),包里也就不带记忆
    memory: sum?.text || '',
    ...(images.length ? { images } : {})
  }
}

/** 把角色包里带回来的那段对话写进库。
 *
 *  消息 id 一律换新(与角色 id 同一条理由:不沿用文件里的标识)。
 *  记忆则按**收到的这些消息**重新对游标 —— 不能照抄包里那份:
 *  那些 id 与时间戳在本地已经不成立,照抄会让下一轮压缩要么把导入的这段
 *  整段重新压一遍,要么一条都不压。 */
async function writeImportedChat(charId: string, chat: ImportedChat) {
  const msgs: ChatMessage[] = chat.messages.map((m) => ({ id: uid(), charId, ...m }))
  for (const m of msgs) await putChatMessage(m)
  if (!chat.memory) return
  const last = msgs[msgs.length - 1]
  await putChatSummary({
    charId,
    text: chat.memory,
    upToId: last?.id || '',
    upToAt: last?.createdAt || 0,
    covered: msgs.length,
    /* 这份记忆是跟着包过来的,不是此刻压出来的。界面上那行"多久没动过"
       显示的是它落到这台机器上的时间 —— 除此之外没有更早的时刻可写 */
    updatedAt: Date.now()
  })
}

async function loadChatLast() {
  const ids = deps.characters.value.map((c) => c.id)
  try {
    if (!ids.length) return
    const got = await getLastChatLine(ids)
    if (!got.size) return
    const next = { ...chatLast.value }
    for (const [id, msg] of got) {
      const known = next[id]
      if (!known || known.createdAt < msg.createdAt) next[id] = msg
    }
    chatLast.value = next
  } finally {
    chatLastReady.value = true
  }
}

/* 说完一句就地把左栏那行更新掉,不必整批重读 */
function setChatLast(id: string, msg: ChatMessage) {
  chatLast.value = { ...chatLast.value, [id]: msg }
}
/* 清空/删除之后要把那行也撤掉,否则左栏还留着已经不存在的摘要 */
function dropChatLast(id: string) {
  if (!chatLast.value[id]) return
  const next = { ...chatLast.value }
  delete next[id]
  chatLast.value = next
}

/**
 * 这一轮说完,它此刻的心情就是这个词。
 *
 * **写的是"模型刚写下的那个词",不是从这一轮里再推一遍** —— 那个词本来就是它自己
 * 写的,而状态与消息必须是**同一个值**:药丸读消息、下一轮读状态,两者一旦能分叉,
 * "它说它恼、可下一句又好好的"就会变成常态。
 *
 * `at` 由调用方给(收尾那一刻),`seq` 也是 —— 见 chatSeqOf。
 * 落笔前比一次代次:生成是异步的,用户完全可能在它跑着的时候点"清空"或删角色,
 * 回来时若不检查,这一笔会把刚清掉的心情又写回去。
 */
async function setChatMood(id: string, word: string, at: number, seq: number) {
  if (chatSeqOf(id) !== seq) return
  const rec: CharacterMood = { charId: id, word, at }
  chatMood.value = { ...chatMood.value, [id]: rec }
  try {
    await putCharMood(rec)
  } catch {
    /* 写不进去就只在内存里留着(这一次会话照样带着它)。它是收尾时的附加动作,
       而正文早就落盘了 —— 为它弹一条错误只会让人莫名其妙(与记忆那处同一条) */
  }
}

/** 把这一条撤掉(清空、删角色用)。库里那一条由 deleteChatOf 一并收 —— 同一个事务 */
function dropChatMood(id: string) {
  if (!chatMood.value[id]) return
  const next = { ...chatMood.value }
  delete next[id]
  chatMood.value = next
}

/**
 * 从库里读回来的一条消息,要把"没画完的图"收成"画没画出来"。
 *
 * 库里那条带着 photo 却没有 photoId,只有两种可能 —— 还在画、或没画出来。
 * 而**还在画的那种不可能被读回来**:出图只活在当前这一份内存里,一次读取发生在
 * 页面刚打开(或往前翻)的时候,没有任何出图在跑。
 * 所以站在这条边界上它只可能是没画出来 —— 落成 photoFailed,界面据此给的
 * 那一行提示与重试键才对。不收的话它会顶着一个永远转下去的骨架:
 * 生成是随页面一起没的,库里那条再没人会去补全(见 App 的 drawChatPhoto)。
 *
 * 只在**读取**这一侧收:内存里那份不能碰 —— 那里面 photo 加 photoId 缺席
 * 也可能真的是"正在画",界面正靠它占着骨架位。
 */
function settlePhoto(m: ChatMessage): ChatMessage {
  if (!m.photo || m.photoId) return m
  /* 原因也要给上:库里那条可能从没记过原因(旧版本存下来的、或页面正好
     在画图途中被关掉),界面上不能只留一片空白。**已经有的不覆盖** ——
     那是上一次失败时记下的真实原因,比这句兜底有用得多 */
  return { ...m, photoFailed: true, photoError: m.photoError || 'Couldn’t generate that image.' }
}

/** 取某个角色的对话。与 loadCharViews 同一套懒加载 + 去重:
 *  同一个 id 可能被选角色的 watch 与角色页的入口同时触发 */
async function loadChatMessages(id: string) {
  if (!id || chatMessages.value[id]) return
  const inflight = chatLoading.get(id)
  if (inflight) return inflight
  const task = (async () => {
    try {
      /* 消息、记忆、心情一起取:它们是同一屏的三半,
         分趟只会让后两样晚一拍出现(而心情晚一拍 = 下一轮的话就少了那一句) */
      const [page, sum, mood] = await Promise.all([
        getChatMessages(id, CHAT_PAGE),
        getChatSummary(id),
        getCharMood(id)
      ])
      chatMessages.value = { ...chatMessages.value, [id]: page.list.map(settlePhoto) }
      chatHasMore.value = { ...chatHasMore.value, [id]: page.hasMore }
      if (sum) chatSummary.value = { ...chatSummary.value, [id]: sum }
      if (mood) chatMood.value = { ...chatMood.value, [id]: mood }
    } finally {
      chatLoading.delete(id)
    }
  })()
  chatLoading.set(id, task)
  return task
}
watch(chatCharId, (id) => {
  if (id) loadChatMessages(id)
})

/**
 * 往前再读一档。**这只是显示上限,库里一条都没少** ——
 * 和"清空"完全是两回事,所以它不该有任何破坏性的味道。
 *
 * 这里不走 loadChatMessages:它会把内存里那份整个换掉,
 * 而读的这段时间里可能刚说完一句 —— 用库里那份盖上去就把新句子抹了。
 * 所以按 id 并一遍:老的在前面,内存里那份新的接在后面。
 */
async function loadEarlierChat(id: string) {
  if (!chatHasMore.value[id] || chatLoading.has(id)) return
  const cur = chatMessages.value[id] || []
  const task = (async () => {
    try {
      const { list, hasMore } = await getChatMessages(id, cur.length + CHAT_PAGE)
      const seen = new Set(list.map((m) => m.id))
      /* 只在**这一档新读出来的**那些上收口:重叠的那几条留在内存里的那份更新
         (可能正有一张图在画),而库里那份照旧盖在上面,不受这一步影响 */
      const have = new Set(cur.map((m) => m.id))
      const fresh = list.map((m) => (have.has(m.id) ? m : settlePhoto(m)))
      chatMessages.value = {
        ...chatMessages.value,
        [id]: [...fresh, ...cur.filter((m) => !seen.has(m.id))].sort(
          (a, b) => a.createdAt - b.createdAt
        )
      }
      chatHasMore.value = { ...chatHasMore.value, [id]: hasMore }
    } finally {
      chatLoading.delete(id)
    }
  })()
  chatLoading.set(id, task)
  return task
}

/**
 * 看一眼要不要把滑出窗口的消息压进记忆 —— 每一轮说完之后顺手跑,不挡用户看回复。
 *
 * "该不该压"由三个数算出来:**总条数 − 窗口大小 − 已覆盖条数**。
 * 减掉窗口,是因为最近那些条本来就还在上下文里,压了也是白压;
 * 结果够 CHAT_SUMMARIZE_AFTER 才值得花一次调用。
 *
 * 全程静默:它是一次后台整理,失败就从这一轮退出,covered 不推进,
 * 下一轮再试 —— 不弹提示,也不会因此丢东西。
 */
async function maybeSummarize(id: string) {
  const cfg = deps.chatConfig.value
  if (!cfg || chatSummarizing.has(id)) return
  /* 模型名空着就整条路都发不出去 —— 提前收手,别拿一次注定失败的调用去撞。
     它本来也是静默的:失败不提示、下一轮再试,于是会变成每一轮白花一次请求 */
  if (!cfg.model.trim() || !cfg.baseUrl.trim()) return
  chatSummarizing.add(id)
  const seq = chatSeq.get(id) || 0
  try {
    const cur = chatSummary.value[id]
    const total = await countChatMessages(id)
    const want = total - CHAT_WINDOW - (cur?.covered || 0)
    if (want < CHAT_SUMMARIZE_AFTER) return

    /* 由旧往新收。收多少条正是上面那个 want(封顶 CHAT_SUMMARY_CAP),
       这样算出来的边界刚好落在"最近窗口"前面,窗口里的原话一句都不会被压掉 */
    const batch = await getChatMessagesToSummarize(
      id,
      cur?.upToAt || 0,
      Math.min(want, CHAT_SUMMARY_CAP)
    )
    if (!batch.length) return

    const text = await summarizeChat(cfg, cur?.text || '', batch)
    /* 这期间对话被清掉过(或角色被删)就别写了 ——
       否则一次后台整理会把用户刚清掉的记忆又请回来 */
    if ((chatSeq.get(id) || 0) !== seq) return

    /* 这期间用户亲手改过记忆:他写的那个版本,比这轮重回炉压出来的更算数。
       这一轮就丢掉 —— covered 没动,消息一条不少,下一轮连着他的新版本一起再压 */
    if ((chatSummary.value[id]?.text || '') !== (cur?.text || '')) return

    const last = batch[batch.length - 1]
    const next: ChatSummary = {
      charId: id,
      text,
      upToId: last.id,
      upToAt: last.createdAt,
      covered: (cur?.covered || 0) + batch.length,
      updatedAt: Date.now()
    }
    await putChatSummary(next)
    chatSummary.value = { ...chatSummary.value, [id]: next }
  } catch {
    /* 见上:后台整理失败不打扰用户 */
  } finally {
    chatSummarizing.delete(id)
  }
}

/** 用户亲手改那段记忆。
 *  只换正文:upToAt / covered 说的是"哪些消息已经进去过了",
 *  改几个字不改变这件事 —— 动了它们,下一轮会把老消息重新压一遍。
 *  updatedAt 跟着刷,因为界面拿它显示"多久没动过了":
 *  用户刚写完的这一版,就不该还挂着"3 天前" */
async function editChatSummary(id: string, text: string) {
  const cur = chatSummary.value[id]
  if (!cur) return
  const next: ChatSummary = { ...cur, text, updatedAt: Date.now() }
  chatSummary.value = { ...chatSummary.value, [id]: next }
  await putChatSummary(next)
  // 另一个标签页里的这个角色也该按新记忆说话
  deps.announce('chat', id)
}

/** 忘掉这段记忆。**消息一条都不删** —— "角色不再记得"和"这事发生过"是两回事,
 *  那份原文还在库里,想回看随时能往上翻。
 *
 *  关键在于**不能只把正文清空**。压缩是从 upToAt 之后接着取的:
 *  正文一空而游标没动,下一轮就会把刚忘掉的那段重新压回来 —— 等于没忘。
 *  所以连游标一起推到最后一条:忘掉的那一段从此不再进记忆,
 *  而**在这之后**说的新话照常重新积累起来。
 *  记录本身留着(正文为空),因为那个"从哪之后不再记得"的游标得有地方待;
 *  界面据此不再显示记忆块(见 ChatPage 的 hasMemory)。 */
async function forgetChatSummary(id: string) {
  const before = chatSummary.value[id]
  const list = chatMessages.value[id] || []
  const last = list[list.length - 1]
  if (!before || !last) return
  /* 在途的压缩要是正跑着,回来会把记忆写回来 —— 作废那一轮 */
  bumpChatSeq(id)
  const total = await countChatMessages(id)
  const next: ChatSummary = {
    charId: id,
    text: '',
    /* covered 与 upToAt 一起推平到"最后一条为止"。
       covered 宁可算多一点:多算了只是下一轮少压一次,
       算少了会把已经忘掉的那段重新捞回来 */
    upToId: last.id,
    upToAt: last.createdAt,
    covered: total,
    updatedAt: Date.now()
  }
  chatSummary.value = { ...chatSummary.value, [id]: next }
  /* 与"清空对话"不同,这一步**立刻落盘**:忘掉就该马上生效,
     而且只有一条记录,写它不心疼。撤销再把老的那版写回去 */
  await putChatSummary(next)
  // 另一页里的这个角色不该再提起刚被忘掉的那一段
  deps.announce('chat', id)
  deps.scheduleUndo({
    label: 'Memory forgotten',
    undo: () => {
      chatSummary.value = { ...chatSummary.value, [id]: before }
      void putChatSummary(before)
    },
    /* 上面已经落过笔了,窗口结束没有别的事要做 ——
       记忆是模型生成的,撤销窗口一过就真的找不回来了 */
    purge: () => {}
  })
}

/** 进对话页时挑一个角色:留着上次那个(还在的话),否则取列表第一个。
 *  一个角色都没有时保持空 —— 页面自己会给"先去建一个"的空态 */
function clearChat(id: string) {
  const list = chatMessages.value[id] || []
  const beforeSummary = chatSummary.value[id]
  const beforeLast = chatLast.value[id]
  const beforeMood = chatMood.value[id]
  if (!list.length && !beforeSummary) return
  // 正在说话的先掐掉,否则它会往上文里补一句刚落空的消息
  chatControllers.get(id)?.abort()
  /* 正在念的那句也一起停:它念的正是一条马上就不存在的消息 */
  stopSpeaking()
  /* 也让在途的压缩作废:它回来时这段对话已经不是原来那段了 */
  bumpChatSeq(id)
  const before = list.map((m) => ({ ...toRaw(m) }))
  // 清空之后前面当然没有更早的了,顺手把"加载更早"收掉
  const hadMore = !!chatHasMore.value[id]
  chatMessages.value = { ...chatMessages.value, [id]: [] }
  chatHasMore.value = { ...chatHasMore.value, [id]: false }
  /* 屏幕上是立刻空的,但库里要等撤销窗口结束才真清(见下面的 purge),
     所以广播放在 purge 里 —— 提前广播的话,另一页会在我们还能撤销时
     就把这段对话当成不存在了 */

  /* 记忆必须跟着一起清 —— 消息没了而记忆还留着,下一句开口就会提起
     一段用户刚刚清掉的旧事,那比失忆更糟 */
  const sumRest = { ...chatSummary.value }
  delete sumRest[id]
  chatSummary.value = sumRest
  /* 心情同理,而且是同一个毛病的另一张脸:**消息没了而它还在生气** ——
     清空之后下一句开口,它会端着一份用户刚刚清掉的火气。
     库里那一条由下面的 deleteChatOf 收(同一个事务) */
  dropChatMood(id)
  // 左栏那行也得跟着空掉,不然它还挂着一段已经不存在的对话
  dropChatLast(id)
  deps.scheduleUndo({
    label: 'Conversation cleared',
    undo: () => {
      chatMessages.value = { ...chatMessages.value, [id]: before }
      chatHasMore.value = { ...chatHasMore.value, [id]: hadMore }
      if (beforeSummary) chatSummary.value = { ...chatSummary.value, [id]: beforeSummary }
      if (beforeLast) setChatLast(id, beforeLast)
      /* 撤销要立刻落盘 —— 但**只能往库里加,不能先清一遍**。
         这里从前先调了一次 deleteChatOf 再写回消息,而它现在会连消息指着的
         附图一起收(见 idb.ts):那条路上消息一条条写回来了,**字节却已经跟着走了**,
         于是每一张图都成了空引用 —— 角色发的那张永远停在骨架上。
         顺带,清库还会带走比内存里这一档更早的那些消息(内存只装着最近一档,
         撤销本来就只放得回这一档),而这次删除压根还没落盘,一条都不该少 */
      void (async () => {
        for (const m of before) await putChatMessage(m)
        if (beforeSummary) await putChatSummary(beforeSummary)
        if (beforeMood) await putCharMood(beforeMood)
      })()
    },
    purge: () => {
      /* 消息、记忆、**以及它们指着的附图**都由 deleteChatOf 一并收掉。
         从前这里在界面上数 imageId,只数得到内存里那一档(最近 200 条),
         而 photoId(角色发的图)一张都没删过 —— 见 idb.ts 的说明。
         附图的回收必须留在 purge:撤销窗口里那些消息还要原样放回去 */
      void deleteChatOf(id)
      // 到这里这一整段对话才算真的没了 —— 撤销窗口里它还在,另一页不该先清掉
      deps.announce('chat', id)
    }
  })
}

  return {
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
  }
}
