import { nextTick, toRaw, watch, type Ref } from 'vue'
import {
  CHAT_WINDOW,
  chatPayloadOf,
  chatStream,
  /* 出图失败时收口成人话(中止不算失败、空话给兜底)——
     这条链上每一步的失败原因都靠它传出来 */
  photoFailureText,
  uid
} from '../api'
import {
  blobToDataURL,
  deleteChatImage,
  deleteChatMessage,
  getChatImage,
  putChatImage,
  putChatMessage
} from '../lib/idb'
import { stopSpeaking } from '../lib/speech'
import { contextText } from '../lib/chatContext'
/* 对话左栏的顺序:进对话页替用户挑一个时,与 ChatPage 铺左栏时用的是同一份规则 */
import { lastMessageLookup, orderConversations } from '../lib/chatOrder'
/* 打字节奏:上游吐字是匀速的,而匀速正是机器感最直接的来源(见那份文件的四条纪律) */
import { Pacer } from '../lib/typing'
import type { Page } from '../lib/nav'
import type { ApiConfig, ChatMessage, HistorySource } from '../types'
import type { useChat } from './useChat'
import type { useConfigs } from './useConfigs'
import type { useCharacters } from './useCharacters'
import type { useFeedback } from './useFeedback'
import type { useGeneration } from './useGeneration'
import type { useHistory } from './useHistory'

/* ===== 角色对话：流式那一轮 ==========================================
   这是「对话这一域」的另一半 —— 非流式的那一半(消息、长期记忆、清空、
   导入导出)收在 useChat.ts,这里管真正发出去的那一轮:进对话页挑人、
   发一句、重生成、停止,以及角色发图那条后台流水线(出图调度 / 落历史 /
   单条删除的撤销)。

   它要动出图配置、角色参考图与请求中断,所以状态仍留在主界面,由 deps 传进来 ——
   与 useChat 同一套做法:ref/computed 按原名解构到局部(它们本身是对象,
   解构不破坏响应性),搬过来的函数体一字未改。
   -------------------------------------------------------------------- */

type ChatApi = ReturnType<typeof useChat>
type ConfigsApi = ReturnType<typeof useConfigs>
type CharactersApi = ReturnType<typeof useCharacters>
type FeedbackApi = ReturnType<typeof useFeedback>
type GenerationApi = ReturnType<typeof useGeneration>
type HistoryApi = ReturnType<typeof useHistory>

export interface ChatFlowDeps {
  /* 角色目录与"选中/详情"三件套 —— 挑进对话页看谁、进详情、以及请求里那份设定 */
  characters: CharactersApi['characters']
  activeCharId: CharactersApi['activeCharId']
  charPageRef: CharactersApi['charPageRef']
  /* 接口配置:对话/识图那两条当前生效的,以及进设置页要用的三样 */
  chatConfig: ConfigsApi['chatConfig']
  chatConfigs: ConfigsApi['chatConfigs']
  visionConfig: ConfigsApi['visionConfig']
  cfgSeed: ConfigsApi['cfgSeed']
  cfgView: ConfigsApi['cfgView']
  newConfig: ConfigsApi['newConfig']
  editConfig: ConfigsApi['editConfig']
  /* useChat 交出来的那套对话状态:消息、记忆、心情、左栏那行、忙碌与中断手柄 */
  chatCharId: ChatApi['chatCharId']
  chatMessages: ChatApi['chatMessages']
  chatMood: ChatApi['chatMood']
  chatSummary: ChatApi['chatSummary']
  chatLast: ChatApi['chatLast']
  chatLastReady: ChatApi['chatLastReady']
  chatBusy: ChatApi['chatBusy']
  chatControllers: ChatApi['chatControllers']
  chatSeqOf: ChatApi['chatSeqOf']
  setChatLast: ChatApi['setChatLast']
  setChatMood: ChatApi['setChatMood']
  dropChatLast: ChatApi['dropChatLast']
  loadChatLast: ChatApi['loadChatLast']
  maybeSummarize: ChatApi['maybeSummarize']
  /* 反馈三通道里这一轮用到的两样(提示与撤销条) */
  notice: FeedbackApi['notice']
  scheduleUndo: FeedbackApi['scheduleUndo']
  /* 出图那条流水线交出来的两样:画一张、以及把结果包成历史记录 */
  generateChatPhoto: GenerationApi['generateChatPhoto']
  recordFor: GenerationApi['recordFor']
  persist: HistoryApi['persist']
  /* 由主界面直接持有的几样:页面与面板、跨标签页广播、"这张在重画" */
  page: Ref<Page>
  openPanel: { value: string }
  chatPhotoBusy: Ref<Record<string, boolean>>
  announce: (kind: 'chat', charId?: string) => void
}

export function useChatFlow(deps: ChatFlowDeps) {
const {
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
} = deps

/* ===== 角色对话 ======================================================
   与设定图那条流水线同一套分工:请求从这里发,状态也留在这里,
   对话页只负责把消息铺出来、把意图交出来(见 ChatPage.vue)。
   -------------------------------------------------------------------- */

/**
 * 把每个角色的最后一条消息读进 chatLast —— 左栏那一行摘要与"最近活跃"排序都靠它。
 *
 * 消息是按角色懒加载的,不补这一趟的话,没打开过的角色在左栏一律显示
 * "No messages yet" 并排到最后:明明聊过,看起来却像从没聊过。
 *
 * 每个角色只读一条(见 idb.ts 的 getLastChatLine),代价与消息条数无关,
 * 所以可以放心在角色列表变化时整批重读。**只往后合并,不整体替换** ——
 * 刚说完的那一句比库里读出来的新,不能被盖回去。
 */
/* 左栏第一行是谁,与 ChatPage 用的是同一份规则(见 lib/chatOrder)。
   从前这里取 characters[0] —— 那是**数组顺序**,也就是角色页那条"最近建的在前"。
   于是刷新之后进对话页,选中的是最近造的那个,而不是左栏顶上那个最近聊过的:
   明明第一行写着 A,打开的却是没人说过的 B */
const lastChatOf = lastMessageLookup(
  () => chatMessages.value,
  () => chatLast.value
)

// 进对话页时确保手上有一个角色
watch(page, (p) => {
  if (p === 'chat') ensureChatChar()
})

function ensureChatChar() {
  if (chatCharId.value && characters.value.some((c) => c.id === chatCharId.value)) return
  /* "最后一句"还没读到之前不挑:那时能用的只剩创建时间,排出来的第一行是假的。
     晚一步的 loadChatLast 到了会回头再挑一次(见下面的 watch) */
  if (!chatLastReady.value) return
  chatCharId.value = orderConversations(characters.value, lastChatOf)[0]?.id || ''
}

/* 上面那份数据到位时补挑一次。它在启动时总会被问一次(见 onMounted 的
   loadChatLast),所以这一挑不会落空 —— 只是比角色晚一拍 */
watch(chatLastReady, (ready) => {
  if (ready && page.value === 'chat') ensureChatChar()
})

/** 从别处进对话页:带上要看的那个人(角色详情页的入口走这里) */
function openChat(charId: string) {
  chatCharId.value = charId
  page.value = 'chat'
}

/** 把一条消息追加进内存里的那一份 */
function pushChatMessage(id: string, msg: ChatMessage) {
  chatMessages.value = { ...chatMessages.value, [id]: [...(chatMessages.value[id] || []), msg] }
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError'
}

/** 一条配置缺了哪一样(空串 = 配全了)。
 *
 *  这类配置**差一个字段就一个请求都发不出去**,而界面上它处处像是配好了 ——
 *  列表里顶着「Current」、药丸上写着名字。所以"缺哪一样"要能单独问出来:
 *  它既是"这一轮发不发得出去"的判据,也是那句话里必须点名的那一格
 *  (明明只是地址空着,却说成"没有模型名",只会让人更糊涂)。 */
function configGap(cfg: ApiConfig): string {
  if (!cfg.model.trim()) return 'model name'
  if (!cfg.baseUrl.trim()) return 'Base URL'
  return ''
}

/**
 * 发一轮,一边收一边长。
 *
 * 三条收尾路径 —— 说完 / 用户按 Stop / 上游出错 —— **都保留已经收到的字**:
 * 用户按 Stop 不是"这次失败了",是"说到这儿够了",
 * 把半句话删掉等于惩罚他按了那个按钮(与设定图"中断后保留旧图"同一条原则)。
 */
async function runChat(id: string) {
  const c = characters.value.find((x) => x.id === id)
  /* 对话模型:专配的那条优先,没配就是借来的改写那条(见 useConfigs 的 chatConfig)。
     两条都没有才是真的发不出去 —— 那句话里说的也是"配一条对话模型" */
  const cfg = chatConfig.value
  if (!c || chatBusy.value[id]) return
  if (!cfg) {
    notice.value = 'Add a chat model in API settings before chatting.'
    return
  }
  /* **有配置 ≠ 配全了**。少了模型名就是一条发不出请求的配置 ——
     而它在设置页里照样顶着「Current」,界面这边也一直是可用的样子。
     不拦的话请求会一路走到服务端,由它回一句 "Set a text model in API settings first":
     那句话既没说是哪条配置,也和用户看到的界面矛盾(他明明配了一条)。
     所以在这里就说清楚是**哪一条**、缺的是**哪一样**(与对话页那块提示同一件事) */
  const gap = configGap(cfg)
  if (gap) {
    notice.value = `"${cfg.name || 'The chat model'}" is missing its ${gap} — set it in API settings.`
    return
  }

  /* 上文现场从内存里取:最近 CHAT_WINDOW 条。
     被截掉的旧消息**不从库里删** —— 它们还在,只是这一轮不带。

     正文过一道 contextText:空正文的消息(典型是"只发了一张图、一个字没打")
     不能以空串发出去 —— 上游会按内容为空拒掉整轮,而这条消息在历史里
     就是一条普通消息(见 lib/chatContext 的说明) */
  const context = (chatMessages.value[id] || [])
    .slice(-CHAT_WINDOW)
    .map((m) => ({ role: m.role, content: contextText(m) }))
  // 最后一句必须是用户说的,否则这一轮本来就不该发
  if (!context.length || context[context.length - 1].role !== 'user') return

  /* "上次说话"取的是**这一轮之前**那一条的时间。
     用户刚打的那条就在末尾 —— 拿它当"上次",算出来永远是"刚刚",
     那句话也就永远不会出现(整个功能等于没做)。
     用完整列表而不是 context:窗口截掉的老消息照样是"上次" */
  const before = (chatMessages.value[id] || []).slice(0, -1)
  const lastAt = before.length ? before[before.length - 1].createdAt : undefined

  /* 用户这一轮带没带图。带了要另说两件事:
     1. 请求改用识图那条配置 —— **看图得有看图的模型**,对话模型多半不支持,
        而它回的那句参数错用户看不出"该换个模型了";没配识图就照旧用对话配置
        (会报错,但那是实情,如实转述给用户);
     2. 把那张图读回来转成 data URL 一起发 —— 库里存的是 Blob,
        发出去要的是字符。**只带当前这一条**:历史里的图不重发(一张上千 token)。 */
  const lastSent = (chatMessages.value[id] || []).slice(-1)[0]
  const picId = lastSent?.imageId || ''
  const useCfg = picId ? visionConfig.value || cfg : cfg
  /* 带了图 ⇒ 这一轮走的是识图那条配置,它同样可能缺字段 —— 而这一处更容易漏:
     用户多半是刚建好一条识图配置、还没填模型就先丢一张图进来试。
     上面那道闸只管对话那条,这里是第二条 */
  const visionGap = configGap(useCfg)
  if (visionGap) {
    notice.value = `The vision model "${useCfg.name || 'untitled'}" is missing its ${visionGap} — set it in API settings.`
    return
  }
  let images: string[] | undefined
  if (picId) {
    const rec = await getChatImage(picId)
    /* 读不回来就照常发文字 —— 整轮失败比"少一张图"更糟 */
    if (rec) images = [await blobToDataURL(rec.blob)]
  }

  const ctrl = new AbortController()
  chatControllers.set(id, ctrl)
  chatBusy.value = { ...chatBusy.value, [id]: true }

  /* 这一轮开始时"这段对话还作数吗"的代次。收尾那一步要拿它比一次 ——
     生成是异步的,用户完全可能在它跑着的时候点"清空"或删角色,
     回来时若不检查,这一轮的心情会被写进一段已经不存在的对话里
     (与 maybeSummarize 同一套做法,见 useChat 的 chatSeqOf) */
  const seq = chatSeqOf(id)

  /* 先摆一条空的助手消息占位,增量往它身上长。不这么做的话字会先攒在一个
     局部变量里、等说完才一次性冒出来,那就不叫流式了。
     注意:要从 chatMessages 里取回**响应式代理**再改 ——
     手里那个原始对象改得再勤也不会触发渲染 */
  pushChatMessage(id, {
    id: uid(),
    charId: id,
    role: 'assistant',
    content: '',
    createdAt: Date.now()
  })
  const replyList = chatMessages.value[id] || []
  const reply = replyList[replyList.length - 1]

  let stopped = false
  let failure = ''
  /* 上游为什么停下。'length' 表示它撞上了 max_tokens —— 见下面收尾那一段 */
  let finish = ''
  /* 这一轮的情绪,由服务端从正文末尾剪下来单独给 */
  let mood = ''
  /* 这一轮它想给你看的画面(场景描述)。空串 = 不发图 */
  let photo = ''
  /* 这张里有没有它本人(模型写在标签前缀里)。
     它决定出图时带不带设定图:场景照带上会被带跑,自拍不带会画成陌生人 */
  let photoSelf = false
  /* 这一张谁拿的相机:'selfie' / 'third' / 空串(它没说)。
     由模型在标签前缀里说(selfie: / third:,见 server/chatTags.js)——
     它是**唯一**知道"我在描述自己举着手机拍,还是别人给我拍"的那一层 */
  let photoShot = ''
  /* 这一张离得多近:'close' / 'medium' / 'full' / 空串(它没说)。
     与视角一样只由模型说得出 —— 而它是"让角色拍特写,却总变成臂展自拍"
     那件事的解药(见 lib/chatPhoto 的 FRAMING) */
  let photoFrame = ''
  /* 打字节奏。它只决定"什么时候放",不决定"放什么" ——
     所以这里最要紧的不是节奏好不好看,而是**一个字都不能丢**:
     收尾(马上要落盘)、按 Stop、页面被切走三处都必须把手里剩下的冲出来,
     漏一处就会存进一条少半句的回复(见 lib/typing.ts) */
  const pacer = new Pacer(reply?.id || id)
  let paceTimer: ReturnType<typeof setTimeout> | null = null
  /* 页面被切走之后就不再压了:没人在看的时候攒着毫无意义,
     而且回来时一次性冒出半屏字比慢一点更难看 */
  let unpaced = false
  const pump = () => {
    paceTimer = null
    if (!reply) return
    if (document.hidden) {
      reply.content += pacer.flush()
      unpaced = true
      return
    }
    const { text, wait } = pacer.take()
    if (text) reply.content += text
    /* wait > 0:到了标点,压一小段再问;wait === 0:这一批放完了 ——
       还有剩就下一拍接着放(上游一次给了好几段),否则等下一次 push */
    if (wait > 0) paceTimer = setTimeout(pump, wait)
    else if (pacer.pending > 0) paceTimer = setTimeout(pump, 0)
  }
  try {
    /* 首字节口径。**只进性能面板,不落盘、不上报** ——
       这个项目本地优先、无账号,不该为了一个内部数字把用户的行为发出去。
       流式只是"不会等 5 秒憋出一整段",真正决定观感的是首字节有多快;
       没有这个数就无从判断后面那些表现层的手脚值不值得做 */
    performance.mark('kimage-chat-send')
    let firstDelta = 0
    const out = await chatStream({
      character: chatPayloadOf(c),
      messages: context,
      /* 长期记忆随请求带上。它是"这一整段对话的状态",
         与角色资料分开传 —— 同一个角色换一段对话,记忆不该跟着走 */
      memory: chatSummary.value[id]?.text || '',
      /* **上一轮的心情随请求带上**,服务端据此在 system 里补一句(见 chatMood.js)。
         它是"它现在是什么心情",与记忆同一层:同一个角色换一段对话,
         记忆不跟着走,心情也不该 —— 所以两样都从这一份对话的状态里取。
         过没过期由服务端按 6 小时窗口判,这里只管原样送出去 */
      mood: chatMood.value[id],
      images,
      lastAt,
      cfg: useCfg,
      signal: ctrl.signal,
      onDelta: (delta) => {
        if (!firstDelta) {
          firstDelta = performance.now()
          performance.mark('kimage-chat-first-delta')
          if (import.meta.env.DEV) {
            try {
              const m = performance.measure(
                'kimage-chat-ttfb',
                'kimage-chat-send',
                'kimage-chat-first-delta'
              )
              console.debug(`[chat] first byte in ${Math.round(m.duration)}ms`)
            } catch {
              /* 标记被清掉或不可用:这只是个数字,不该影响这一轮 */
            }
          }
        }
        /* 切成不压之后**直接贴**,不能再走 pacer ——
           它手里已经没有东西了(切走那一刻冲干净了),但顺序必须保持 */
        if (!reply) return
        if (unpaced) reply.content += delta
        else {
          pacer.push(delta)
          /* 第一块立刻贴上去,不等到下一拍:首字节已经够贵了,
             不该再被节奏器加上一帧 */
          if (!paceTimer) pump()
        }
      }
    })
    finish = out.finish
    mood = out.mood
    photo = out.photo
    photoSelf = out.photoSelf
    photoShot = out.photoShot
    photoFrame = out.photoFrame
    /* 这一轮到底有没有"发图的意图",以及它想给你看什么。
     *
     * **不该靠猜**:标签在服务端就被剪掉了(那是对的,用户不该看见 `[photo:…]`),
     * 于是"它没打算发图"和"它打算发、但被剪掉了"在界面上长得一模一样 ——
     * 一旦出现"怎么每句都在发图"的疑问,这一层是唯一能一眼分辨的地方。
     * 走 console.debug(详细级别,控制台默认不显示),**不落盘、不上报**。
     * 只在**确实有意图**时打一行 —— 它就是为"太多了"这种问题准备的 */
    if (photo) console.debug('[chat] photo intent:', photo, { self: photoSelf, shot: photoShot, frame: photoFrame })
  } catch (e) {
    if (isAbort(e)) stopped = true
    else failure = e instanceof Error ? e.message : 'Request failed'
  } finally {
    chatControllers.delete(id)
    chatBusy.value = { ...chatBusy.value, [id]: false }
    /* **先冲节奏再收摊**:下面紧接着就要落盘,手里还扣着字就会存进半句。
       断流、按 Stop、没收到任何 delta 的轮次全都走这一条 */
    if (paceTimer) {
      clearTimeout(paceTimer)
      paceTimer = null
    }
    if (reply) reply.content += pacer.flush()
    /* 不清会一轮一轮攒在性能面板里(同名标记是叠加的,不是覆盖的)。
       放在 finally 里:断流、按 Stop、没收到任何 delta 的轮次也要收干净 */
    performance.clearMarks('kimage-chat-send')
    performance.clearMarks('kimage-chat-first-delta')
    performance.clearMeasures('kimage-chat-ttfb')
  }

  if (!reply) return
  if (stopped) reply.stopped = true
  /* 撞上 max_tokens —— 上游把话说到了额度上沿就停下。
     与 stopped 分开记:那个是人按的,这个是模型的额度用完了。
     不记的话前端看到的和"正常说完"一模一样,用户会以为角色话说一半是它自己的风格 */
  else if (finish === 'length') reply.truncated = true
  /* 情绪挂在这一条上。收在半截上时多半没有(标签本来就在末尾),
     没有就不写 —— 界面上那枚小药丸宁可不出,也不要显示一个错的 */
  if (mood) {
    reply.mood = mood
    /* 同一个词也是**它此刻的心情**,下一轮要带着它回话(见 chatMood.js)。
       状态与消息用的是**同一个值**:药丸读消息、下一轮读状态,两者一旦能分叉,
       "它说它恼、可下一句又好好的"就会变成常态。
       `seq` 是这一轮开始时记下的 —— 中途被清空过就别写(见上面那段)。
       不 await:它不该拖慢紧接着的那次出图,而写不进去也不影响这一轮 */
    void setChatMood(id, mood, Date.now(), seq)
  }
  /* 它想发一张图:**先挂上场景描述**(界面据此立刻占一个骨架位),
     再交给 drawChatPhoto 后台画。正文照旧 —— 图失败不该拖住它说的话 */
  if (photo && !stopped) {
    reply.photo = photo
    /* 意图一起落在这条消息上:导出这段对话时,对方若想重画这一张,
       依据该是同一个(在不在画面里、谁拿的相机) */
    if (photoSelf) reply.photoSelf = true
    if (photoShot === 'selfie' || photoShot === 'third') reply.photoShot = photoShot
    if (photoFrame === 'close' || photoFrame === 'medium' || photoFrame === 'full') {
      reply.photoFrame = photoFrame
    }
    drawChatPhoto(id, reply)
  }
  if (!reply.content.trim() && !stopped) {
    /* 一个字都没收到(上游出错,或它真的什么都没说):
       把这条空壳摘掉,免得消息流里留一个空气泡。
       摘掉之后最后一条又回到用户那句 —— 界面上因此会给出"重试",
       它走的就是 regenerateChat(见那边的注释) */
    chatMessages.value = {
      ...chatMessages.value,
      [id]: (chatMessages.value[id] || []).filter((m) => m.id !== reply.id)
    }
    // 左栏那行还停在上一次的回复上,说明这一轮没留下东西:让它退回去
    dropChatLast(id)
    void loadChatLast()
  } else {
    // 落盘要交原始对象:reactive 代理进不了 IndexedDB 的 structuredClone
    await putChatMessage({ ...toRaw(reply) })
    // 另一页的左栏与消息流都要跟上(它可能正开着这个角色)
    announce('chat', id)
    setChatLast(id, { ...toRaw(reply) })
  }
  if (stopped) notice.value = 'Stopped.'
  else if (failure) notice.value = failure
  /* 收尾之后顺手看一眼要不要压记忆。放在最末是有意的:
     它是后台整理,不该挡在用户看到回复之前,也不该挤进上面那两句提示 */
  void maybeSummarize(id)
}

/**
 * 对话里画出来的一张图 → 也存一条历史记录。
 *
 * **用户 2026-10-05 的要求**:对话过程中生成的所有图都要进历史,
 * 生成的那张对话背景图也算;并且要归到角色名下(见 `characterId`)。
 * 从前这条链是明确"不进历史"的(见 doc/角色配图设计.md)—— 图只活在对话里,
 * 于是关掉对话页之后它就再也翻不到了,而画它同样花了钱。
 *
 * 字节是**两处各留一份**,这是有意的:
 * - `chat_images` / `chat_backdrops` 那份是**对话自己在用**的 ——
 *   消息要显示它、清空对话要把它一并回收(见 idb.ts 的 deleteChatOf);
 * - `history` 这份是**作品** —— 历史页、角色作品墙、批量导出读的都是它。
 *
 * 两处生命周期不同,所以不做"互相引用":历史被存储清理淘汰时,对话里那张还在;
 * 清空对话时,历史里这张也还在。代价是同一张图占两份配额 ——
 * 换的是两边都不会因为对方的删除而裂掉(清空对话不该抹掉你的作品,
 * 清理旧记录也不该让聊天记录里那张图变成一个空框)。
 *
 * **绝不往外抛**:它跑在出图那条 `.then` 里,抛出去会被那个 catch
 * 当成"这张图画失败了" —— 而图其实已经拿到、已经在对话里了。
 * 历史那份没写成只是少一件作品,不该影响已经画好的这一张。
 */
async function saveChatWork(
  charId: string,
  out: {
    blob: Blob
    prompt: string
    size: string
    model: string
    configId: string
    elapsedMs: number
  },
  source: HistorySource,
  scene: string
) {
  try {
    /* 走 recordFor 而不是自己拼一条:缩略图与真实像素这些图墙要用的字段
       由它一并补齐,口径与工作台出的图一致 */
    const record = await recordFor([{ type: 'b64', data: out.blob }], {
      /* `prompt` 记**真正发出去的那一整段**(含机位、焦段、光、负面约束)——
         以后从历史里 Reuse 重跑,依据才与当时一致;人话那句(场景)
         记在 `scene` 上,界面读它当标题与正文(见 lib/chatWork) */
      prompt: out.prompt,
      scene,
      source,
      size: out.size,
      model: out.model || undefined,
      configId: out.configId,
      /* 归到角色名下 —— 角色页那面 "Made with this character" 作品墙
         与用量都是按这个字段聚合的(见 useCharacters 的 charWorks) */
      characterId: charId,
      elapsedMs: out.elapsedMs
    })
    await persist(record)
  } catch {
    /* recordFor 那一步(量缩略图)真抛出来时在这里收口。persist 自己不会抛:
       它内部把落盘失败变成了提示(见 useHistory)。这句只是让"作品墙里没有它"
       有个说法 —— 它不会盖掉出图本身已经给出的提示 */
    notice.value = 'The image is in the conversation, but was not saved to history.'
  }
}

/**
 * 画这条消息里"它想给你看的那张图",画完挂上 photoId。
 *
 *  **失败要留痕**:从前画不出来只是把 photo 清掉,于是"没收到图"和
 *  "本来就没打算发图"在界面上长得一模一样 —— 用户既不知道为什么没有图,
 *  也没有地方让它再来一次。现在失败改成在消息上记一个 photoFailed,
 *  场景描述**保留**(它是重试要用的全部依据),界面据此给一行说明 + 重试。
 *
 *  正文不受影响:一句"我画不出来"比什么都不说更打断对话
 *  (见 doc/角色配图设计.md 的"失败不阻断文字")。
 *
 *  —— 这一条也是"重画一张已经画好的图"的入口(2026-10-06)——
 *
 *  同一条路两处用:第一次没画出来时的**重试**,与"画出来了但不好看,再摇一次"的
 *  **重画**(用户原话:"角色生图支持重新生成")。两者唯一的差别在失败那一下 ——
 *  见 markFailed 里的分叉。
 */
function drawChatPhoto(id: string, reply: ChatMessage) {
  const scene = reply.photo || ''
  if (!scene) return
  // 重试时从失败态翻回"正在画":界面据此把提示换回骨架,并清掉上一次的原因
  reply.photoFailed = false
  reply.photoError = ''
  /* 这一张在画。旧图还留在界面上(photoId 不动),所以这一位是"正在重画"
     唯一的说法 —— 成功与失败两条路都要把它收掉,见下面 */
  chatPhotoBusy.value = { ...chatPhotoBusy.value, [reply.id]: true }
  const settleBusy = () => {
    const next = { ...chatPhotoBusy.value }
    delete next[reply.id]
    chatPhotoBusy.value = next
  }

  /** 这一张没画出来。**先看这条还在不在** —— 它可能已经被删了(清空对话、
   *  或单独删掉它),那就别再往上写:写回去等于把一条已经删掉的消息复活。
   *
   *  `why` 是失败的具体原因(见 generateChatPhoto 的返回类型)。从前这里
   *  连一个参数都没有 —— 界面只能说"生成失败",而真正的原因(没配出图模型 /
   *  密钥不对 / 上游回了个空数组)在下面那个 catch 里就被吃掉了。
   *
   *  **分叉:这一次是重画,还是第一次画**(2026-10-06)。
   *  `reply.photoId` 还在 = 这条消息本来就有一张画好的图(重画)。
   *  那时**绝不能**记 photoFailed —— 那会让界面上那枚失败提示顶掉一张好图,
   *  而用户要的只是"再摇一次,不行就算了"。失败照旧要说,只是换成那一句转瞬的
   *  提示(见 notice):图留着,原因也说得出 */
  async function markFailed(why: string) {
    if (!chatMessages.value[id]?.some((m) => m.id === reply.id)) return
    if (reply.photoId) {
      notice.value = why
      return
    }
    reply.photoFailed = true
    reply.photoError = why
    // 落盘:**刷新之后那行提示与重试键还在**,否则又变回一个永远转的骨架
    await putChatMessage(toRaw(reply)).catch(() => {})
  }

  void generateChatPhoto(
    id,
    scene,
    !!reply.photoSelf,
    reply.photoShot,
    reply.photoFrame,
    /* 心情也一起给:这张图上那副神情就是发这条消息时的那个词。
       它不比其余四位次要 —— 少了它,重画出来的是一张"同一张脸、别的表情"的图 */
    reply.mood || ''
  )
    .then(async (out) => {
      if (!chatMessages.value[id]?.some((m) => m.id === reply.id)) return
      if (!out.blob) return markFailed(out.error)
      const photoId = uid()
      try {
        await putChatImage({ id: photoId, blob: out.blob, createdAt: Date.now() })
      } catch {
        /* 画出来了**却存不下** —— 与"画不出来"是两回事:这一张其实已经拿到,
          只是浏览器配额满了。说清这一点,否则用户会以为模型又坏了 */
        return markFailed('The image was generated but could not be saved — storage may be full.')
      }
      reply.photoId = photoId
      reply.photoError = ''
      /* 落库只是把这条消息补全。失败也不回滚界面 —— 失败那一路见上,
         成功的这一路写不进去也不该把已经画好的图从界面上撤掉 */
      await putChatMessage(toRaw(reply)).catch(() => {})
      /* 再落一份进历史(见 saveChatWork)。**排在消息之后**是有意的:
         这一张图先要在对话里出现,历史是第二件事 —— 历史那份写不成
         不该让对话里这张也跟着没了。它自己不抛,所以下面那个 catch
         不会把一次成功误报成失败 */
      await saveChatWork(id, out, 'chat-photo', scene)
    })
    /* 兜一层。generateChatPhoto 约定"绝不 reject",但真抛出来了也必须落到
       同一个出口 —— 漏出去这条消息就一直停在骨架上,连那行提示都不会有 */
    .catch((e) => markFailed(photoFailureText(e)))
    /* **三条路都要收掉"正在重画"**(成功 / 失败 / 抛出来)。放 finally 而不是
       各写一遍:漏一处那一枚键就会一直转,而它正好是"能不能再点一次"的依据 */
    .finally(settleBusy)
}

/** 重画某一条消息里的图。与"重新生成"不同:文字一条都不动,
 *  也不重新问对话模型 —— 依据(场景描述 + 在不在画面里 + 谁拿的相机 + 多近 + 什么心情)
 *  本来就在消息上。
 *
 *  两处用它:那张图**没画出来**时的"重试",以及**画出来了但不好看**时的"重画"
 *  (2026-10-06 加的入口,用户原话:"角色生图支持重新生成")。
 *  后者是同一段代码:依据一样、走的路一样,差别只在失败那一下 ——
 *  已经有一张好图时不拿失败提示去顶掉它(见 drawChatPhoto 的 markFailed)。 */
function retryChatPhoto(id: string, msgId: string) {
  const msg = (chatMessages.value[id] || []).find((m) => m.id === msgId)
  if (!msg || !msg.photo) return
  drawChatPhoto(id, msg)
}

/** 发一句。先把用户那句落进去,再连同它一起发 ——
 *  不加这一步,模型看不到这次问的到底是什么 */
async function sendChat(id: string, body: string, image?: Blob) {
  if (chatBusy.value[id]) return
  /* 先把图落库,再把 id 挂到消息上。顺序不能反 ——
     反过来写的话,中途失败会留下一条指着不存在图片的消息 */
  let imageId = ''
  if (image) {
    imageId = uid()
    try {
      await putChatImage({ id: imageId, blob: image, createdAt: Date.now() })
    } catch {
      /* 存不下就别把 id 挂上去:那会是一条永远显示不出图的记录,
         用户还以为是图坏了 */
      imageId = ''
      notice.value = 'Could not save that image — sending the message without it.'
    }
  }
  const mine: ChatMessage = {
    id: uid(),
    charId: id,
    role: 'user',
    content: body,
    createdAt: Date.now(),
    ...(imageId ? { imageId } : {})
  }
  if (!mine.content.trim() && !mine.imageId) return
  pushChatMessage(id, mine)
  await putChatMessage(mine)
  announce('chat', id)
  // 左栏那行摘要跟着这一句走 —— 不必为此重读一遍库
  setChatLast(id, mine)
  await runChat(id)
}

/** 重新生成:删掉最后那条助手消息再发一次。**用户那句不动** ——
 *  要重来的是它的回答,不是让用户再说一遍 */
async function regenerateChat(id: string) {
  if (chatBusy.value[id]) return
  /* 先确认这一轮真的发得出去,**再**删旧回复。反过来的话,下面 runChat
     的每一条提前返回都变成一次静默的数据丢失:旧回复已经删了,新的又没发 ——
     最容易撞上的是"对话模型被删掉/换设备后还没配",那时界面上还留着
     Regenerate(消息流不受 compose 的门控),点一下就永久丢一条(没有撤销窗口) */
  const c = characters.value.find((x) => x.id === id)
  if (!c) return
  const cfg = chatConfig.value
  if (!cfg) {
    notice.value = 'Add a chat model in API settings before chatting.'
    return
  }
  /* 与 runChat 同一道闸:缺字段的配置发不出请求,而这条路上后果更重 ——
     旧回复已经被删了,补不回来(见上面那段的取舍) */
  const gap = configGap(cfg)
  if (gap) {
    notice.value = `"${cfg.name || 'The chat model'}" is missing its ${gap} — set it in API settings.`
    return
  }
  const list = chatMessages.value[id] || []
  const last = list[list.length - 1]
  if (!last) return
  /* 最后一条是助手消息 ⇒ 说了一半想重来,先把它删掉(用户那句留着)。
     是用户消息 ⇒ 上一轮压根没答上来(runChat 失败时会把空壳删掉),
     那就什么都不用删,直接重发。两种情况共用这一个入口,
     所以"报错之后重试"不需要另写一条链路 */
  if (last.role === 'assistant') {
    /* 删掉之后底下得有一条用户消息接着问 —— 没有的话这一轮本来就没得重发
       (runChat 也会直接返回),那就一条都别删。正常对话里走不到这里,
       但导入的包可以以助手消息开头 */
    if (list.length < 2 || list[list.length - 2].role !== 'user') return
    /* 这条正要被删掉,它可能还在念 —— 念着一条已经不存在的消息没有道理。
       (不在这里停也不算错:新的回复开始念时会掐掉它,但那中间有几秒) */
    stopSpeaking()
    await deleteChatMessage(last.id)
    chatMessages.value = { ...chatMessages.value, [id]: list.slice(0, -1) }
    /* 左栏那行摘要可能就是这一条,得跟着回退到上一条 */
    const prev = list[list.length - 2]
    if (prev) setChatLast(id, prev)
    else dropChatLast(id)
  }
  await runChat(id)
}

function stopChat(id: string) {
  chatControllers.get(id)?.abort()
}

/**
 * 从对话页那枚模型药丸(或开不了口时那块提示)进设置页。
 *
 * 三种情况,三种落点 —— **落点要对上用户此刻的问题**:
 * - **在用的一条没配全**(典型是缺模型名)→ 直接开**它**的编辑表单。
 *   这时"去看列表"只会让他再找一遍:他手里那条就顶着 Current,而问题就在那一格里;
 * - 已经有专配的对话配置 → 去看列表(点它多半是想换一条);
 * - 还没有(用药丸上那句 `from enhancing` 认出来)→ 直接开一张「用途 = 对话」的空表单。
 *   这才是这条路最常见的用法:用户点它的动机就是"配一条自己的"。
 *
 * 空表单给的是空白草稿而不是某家预设:填哪家只有用户知道,
 * 而用途那一步已经替他选好了(见设置页的 setPurpose)。
 */
/** 从对话页头部的 Details 去这个角色的详情。
 *
 *  三步的次序不能换:**先记下"选中他"、再切页、最后才让角色页打开详情**。
 *  反过来的话,角色页会先按旧的 activeCharId 渲染一帧、再跳过去 ——
 *  看起来就是"先闪了一下别的角色"。nextTick 是把"详情"这一句
 *  排在切页那次渲染之后(角色页这时才挂载得上) */
function openCharacterDetail(id: string) {
  activeCharId.value = id
  page.value = 'chars'
  nextTick(() => charPageRef.value?.openDetail(id))
}

function openChatConfigSettings() {
  const cfg = chatConfig.value
  if (cfg && (!cfg.model.trim() || !cfg.baseUrl.trim())) {
    editConfig(cfg)
  } else if (chatConfigs.value.length) {
    cfgSeed.value = null
    cfgView.value = 'list'
  } else {
    newConfig({ id: '', name: '', baseUrl: '', apiKey: '', model: '', vendor: 'custom', kind: 'chat' })
  }
  page.value = 'settings'
  openPanel.value = ''
}

/**
 * 删掉单独一条消息。
 *
 *  走撤销条 —— 与清空对话、删角色、清空历史同一套:一条消息也是这段对话的
 *  一部分,点错了却只能靠"重新生成"来补救是说不过去的。
 *
 *  **附图等到窗口结束才收**(purge):撤销要把这条消息原样放回去,
 *  字节先删了,恢复出来的就是一条指着空图的记录。
 *
 *  记忆的游标不用动:它按时间戳走(upToAt),而 covered 只是"已经压过多少条"。
 *  删掉一条已覆盖的消息之后 covered 会多数一条 —— 那只会让下一轮压缩晚一点
 *  触发,不会把删掉的东西捞回来(与 Forget 里"宁可算多一点"同一条取舍)。
 */
function deleteChatMessageFromPage(id: string, msgId: string) {
  /* 正在生成时不给删:那条占位的助手消息还没落盘,这一刻删它
     会与收尾那一步打架(界面上也把按钮收掉了,这里是第二道闸) */
  if (chatBusy.value[id]) return
  const list = chatMessages.value[id] || []
  const at = list.findIndex((m) => m.id === msgId)
  if (at < 0) return
  const gone = list[at]
  // 这条可能正在念:念着一条马上就不存在的消息没有道理
  stopSpeaking()
  chatMessages.value = { ...chatMessages.value, [id]: list.filter((m) => m.id !== msgId) }
  void deleteChatMessage(msgId)
  /* 左栏那行摘要可能就是这一条,得跟着回退到新的最后一条 */
  const rest = chatMessages.value[id] || []
  const last = rest[rest.length - 1]
  if (last) setChatLast(id, last)
  else dropChatLast(id)

  scheduleUndo({
    label: 'Message deleted',
    undo: () => {
      /* 放回**原来的位置**:对话的顺序就是它的意思,接到末尾等于改写了上下文。
         按 at 切,而不是按当前长度 —— 窗口里又说了几句的话,位置也不会错 */
      const cur = chatMessages.value[id] || []
      const next = [...cur.slice(0, at), gone, ...cur.slice(at)]
      chatMessages.value = { ...chatMessages.value, [id]: next }
      // 落盘要交原始对象:reactive 代理进不了 IndexedDB 的结构化克隆
      void putChatMessage(toRaw(gone))
      /* 左栏那行也回退:放回来的这条要是最后一句,它就该重新出现在左栏。
         重读一趟而不是自己算 —— 库里那份是权威,而这次恢复刚好也落盘了 */
      void loadChatLast()
    },
    purge: () => {
      /* 到这一步才真的把字节扔掉(理由见上面)。两个字段都要收:
         imageId 是用户附的,photoId 是角色发的 */
      if (gone.imageId) void deleteChatImage(gone.imageId)
      if (gone.photoId) void deleteChatImage(gone.photoId)
      // 别的一页也要知道这一条没了
      announce('chat', id)
    }
  })
}

/** 清空一个角色的对话。走撤销条 —— 与删除角色、清空历史同一套规矩:
 *  说没就没的东西得留一条退路 */
/* 角色是异步读进来的:进页面那一刻可能还没到,挑出来的是空。
   角色到位(或列表长度变了)时补挑一次 —— 否则明明有角色,
   对话页却一直停在"挑一个"的空态上 */
watch(
  () => characters.value.length,
  () => {
    if (page.value === 'chat') ensureChatChar()
  }
)
return {
  ensureChatChar,
  openChat,
  sendChat,
  stopChat,
  regenerateChat,
  retryChatPhoto,
  deleteChatMessageFromPage,
  openCharacterDetail,
  openChatConfigSettings,
  /* 对话背景图那条路(App 的 drawBackdrop)也要借它把图落进历史 */
  saveChatWork
}
}
