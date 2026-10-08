<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue'
import {
  PhArrowDown,
  PhArrowUp,
  PhArrowsInSimple,
  PhArrowsOutSimple,
  PhArrowsClockwise,
  PhBrain,
  PhChatCircleDots,
  PhDotsThree,
  PhEraser,
  PhImage,
  PhImageBroken,
  PhMaskHappy,
  PhPencilSimple,
  PhSlidersHorizontal,
  PhSmiley,
  PhSpeakerHigh,
  PhStopCircle,
  PhTrash,
  PhUser,
  PhX
} from '@phosphor-icons/vue'
import type { ApiConfig, Character, ChatMessage, ChatSummary } from '../types'
import { CHAT_MAX_CHARS, coverSrc, hasPersona } from '../api'
import { getChatImage } from '../lib/idb'
// 喂给模型的图长边上限(与首页、画布、角色识图共用同一个数)
import { REF_IMAGE_EDGE } from '../lib/payload'
// 浮层的公共行为(Tab 圈定 / 点外收起 / Esc 逐层退)
import { isInside, layerOnEscape, trapTab } from '../lib/ui'
import { growTextarea, vGrow } from '../lib/grow'
/* "多久以前"那句话与服务端拼给角色的那句**同源**(见那份文件的 agoLabel) */
import { agoLabel } from '../../server/chatTime.js'
/* 左栏的目录与搜索收在 ChatRail 里 —— 它与窄屏那个"换角色"浮层是同一个组件,
   两份内容一字不差的重复因此消掉。排序口径(lib/chatOrder)也随它一起走 */
import ChatRail from './ChatRail.vue'
/* 显示层也要摘一次中段标签:**库里已有的老消息还带着它**
   (那一版服务端还没这道工序)。同一个纯函数,两端同一个判据 */
import { parsePhotoIntent, stripStandaloneTags } from '../../server/chatTags.js'
import { speak, speechSupported, speakingId, speakingLoading, stopSpeaking, warmUpSpeech } from '../lib/speech'

/* 角色对话页。它是一个平级页面(见 lib/nav.ts),不是浮层 ——
   所以骨架是"左栏角色 + 右栏对话",与角色页/历史页同一套页面结构。

   这一页只做展示与编排:消息从哪来、请求怎么发、字节怎么写盘,
   全归主界面(它才碰 IndexedDB 与网络)。与 CharacterPage 是同一条分工 */
const props = defineProps<{
  characters: Character[]
  /** 已取到的消息,按角色 id 缓存。取出来的事归主界面 */
  messages: Record<string, ChatMessage[]>
  /* 每个角色的最后一条消息,只用来画左栏那一行摘要、并给左栏排序。
     消息按角色懒加载,没打开过的读不到 —— 少了这一份,
     它们在左栏一律显示 No messages yet 并排到最后(明明聊过,看着像没聊过) */
  lastMsg: Record<string, ChatMessage>
  /** 各角色正在生成中(没有该角色的键 = 空闲)。
   *  必须按角色分开 —— A 在说话时切到 B,B 的界面不该跟着显示"正在输入" */
  busy: Record<string, boolean>
  /** 正在**重画**的那几张图,按消息 id。
   *  只有"这一张本来就有图、现在在再摇一次"时才为真 —— 第一次就没画出来的那种
   *  不靠它(那时还没有 photoId,界面画的是骨架)。
   *  必须由主界面给:出图只活在主界面那一层,这里只负责把状态画出来 */
  redrawing: Record<string, boolean>
  /** 当前选中的角色 id。空 = 还没挑 */
  active: string
  /* 前面还有更早的消息没读。库里装的是这个角色**最近一档** ——
     没有这一项就分不清"这是第一句"和"只读到这里" */
  hasMore: boolean
  /* 长期记忆:滑出窗口的消息压成的那段简报。
     有它就得让用户看得见 —— 它是模型"记得什么"的全部依据,
     藏起来就没法解释"它为什么会突然提起那件很久以前的事" */
  summary?: ChatSummary
  /** 对话要用的模型配置(kind = 'chat',或没专配时借来的改写那条)。
   *  没配就走不了,但历史照常能看 */
  chatConfig?: ApiConfig
  /* 这条是不是从"提示词改写"借来的。**必须说清** —— 这一页头部那枚药丸显示的
     就是它,而"我到底在跟哪个模型说话"正是这次把对话配置独立出来的原因;
     含糊过去等于白改。true 时药丸上带一句来源,点一下直接去配一条专属的 */
  chatBorrowed?: boolean
  /* 发图那一轮改用它。**看图得有看图的模型** —— 对话模型多半不支持,
     而上游的拒绝只是一句参数错,用户看不出"该换个模型了"。
     配了识图那条就优先用它;没配就照旧用对话配置(会报错,但那是实情) */
  visionConfig?: ApiConfig
  /* 朗读要用的合成配置。没配就退回浏览器自带的语音(见 lib/speech)——
     它是"能用就行"与"这个角色自己的嗓子"之间的那条分界线 */
  ttsConfig?: ApiConfig
  /* 沉浸态:同一页的第二种骨架(见 doc/沉浸式对话页面设计.md)。
     **它是显示层的事,页面自己不改任何数据** —— 偏好存盘与外壳那一层归主界面 */
  immersive?: boolean
  /* 这一场戏的**背景图**(单独生成、单独存的那一张)的地址。
     空 = 还没画出来,退到剧照/首图。读库与出图编排都归主界面
     (见 App 的 loadBackdrop 与 drawBackdrop —— **只有用户点 New background 才画**) */
  backdrop?: string
  /** 正在画这一场的背景。界面据它说一句"正在画"(它是一次真调用,用户该知道) */
  backdropBusy?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', charId: string): void
  /* image 是用户这一轮附的图(已经压到长边 1024)。存库与转 data URL
     归主界面 —— 与"消息从哪来、字节怎么写盘"同一条分工(见文件头) */
  (e: 'send', charId: string, text: string, image?: Blob): void
  (e: 'stop', charId: string): void
  (e: 'regenerate', charId: string): void
  /* 重画这一条里的图。文字一条都不动 —— 它只是"这张图再来一次",
     不该顺带把角色说的话也重写一遍(与 regenerate 分开)。
     **第一次没画出来**时的"重试"与**画好了想再摇一张**时的"重画"走同一个出口:
     依据、路径完全一样,差别只在失败那一下(见主界面的 drawChatPhoto) */
  (e: 'retryPhoto', charId: string, messageId: string): void
  /* 删掉单独一条消息。**只交意图** —— 内存与 IndexedDB 两边怎么删、
     撤销窗口怎么给、附图什么时候收,全归主界面(与清空对话同一条分工) */
  (e: 'deleteMessage', charId: string, messageId: string): void
  /* 置顶 / 取消置顶。落在角色自己身上(Character.pinned),由主界面写盘 ——
     左栏与角色页两处都从这里出去,两个入口不该各写一套 */
  (e: 'pin', charId: string): void
  /* 用户把那段记忆改成了别的。只换正文,覆盖进度(upToAt/covered)不动 ——
     那些消息本来就已经进去过了,改了正文不等于要重压一遍 */
  (e: 'editSummary', charId: string, text: string): void
  /* 忘掉这段记忆。**消息一条都不动** —— "角色不再记得"与"这事发生过"
     是两回事(见 App 的 forgetChatSummary) */
  (e: 'forgetSummary', charId: string): void
  (e: 'clear', charId: string): void
  // 往前再读一档。只影响显示,库里一条都不会少
  (e: 'loadEarlier', charId: string): void
  /* 一句要给用户看的话。目前只有一处会用到:朗读退回了浏览器声音 ——
     那件事必须说出来,否则用户会以为音色配置生效了、只是"听起来不对" */
  (e: 'notice', text: string): void
  (e: 'gotoChars'): void
  /* 去这个角色的详情。**只交意图** —— 切页、选中、让角色页把详情打开,
     全归主界面(与 gotoChars 同一条分工)。对话里想改设定/看出图,
     从前只能自己切到角色页再从列表里找一遍 */
  (e: 'openCharacter', charId: string): void
  /* 去配那条对话模型。**只交意图**:是回列表还是直接开一张新表单,
     由主界面定(它才知道现在有没有专配的对话配置)—— 见 App 的 openChatConfigSettings */
  (e: 'configureChatModel'): void
  /* 切骨架(进/出沉浸)。**只交意图** —— 它是偏好,存盘归主界面
     (与主题切换同一条分工) */
  (e: 'toggleImmersive'): void
  /** 用户手动要一张新的背景图(这一场戏重画)。**只交意图** —— 生成与落盘归主界面 */
  (e: 'newBackdrop'): void
}>()

/* ===== 取用的那一份 =================================================
   这一页只认"当前这个角色",其余角色的消息留在 props 里不动 ——
   切回去时不必重读 IndexedDB */
const current = computed(() => props.characters.find((c) => c.id === props.active) || null)
const msgs = computed(() => props.messages[props.active] || [])
const streaming = computed(() => !!props.busy[props.active])

function avatarOf(c: Character): string {
  return coverSrc(c.ref)
}

/** 沉浸页头部第二行:`场景 · 时间`。
 *
 *  场景取自**最后一条带照片意图的消息**（`reply.photo` 就是它当时写的场景描述）——
 *  也就是说这行字是它自己说的，不是我们编的，零额外调用。
 *  一条都没发过图时只剩时间。
 *
 *  时间读的是**这台机器的钟**（与 T6.1 发出去的那份同一个口径：用户眼前的钟）。
 *  它是在渲染那一刻算的，页面开着不动一小时这句话会旧一小时 ——
 *  与"Last spoke"那行同一条取舍：它服务的是"刚回到这一页的那一眼"。 */
const sceneLine = computed(() => {
  /* 取**第一小句**:`reply.photo` 是那段出图提示词(可能很长),
     而这一行要的是"这一幕在哪" —— 参考图里写的是 `sitting by the window`,
     不是一整段。`parsePhotoIntent` 先把 `self:` 那类标记剪掉 */
  const raw = parsePhotoIntent(stillMsg.value?.photo || '', current.value?.name || '').scene
  const first = raw.split(/[,，。;；]/)[0].trim()
  const label = first.length > 22 ? `${first.slice(0, 20)}…` : first
  const t = clockNow()
  return label ? `${label} · ${t}` : t
})

/** 本机钟的 HH:MM。与 T6.1 发给服务端的那份同一个口径:用户眼前的钟。
 *  它在渲染那一刻算 —— 页面开着不动一小时这句话会旧一小时,
 *  与"Last spoke"那行同一条取舍:它服务的是"刚回到这一页的那一眼" */
function clockNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 沉浸页背景用的那张。与头像是**同一个** object URL(coverSrc 按 Blob 缓存),
 *  所以它不额外占内存、也不额外发请求。
 *
 *  刻意**不做降采样**:设计稿里写的是"正脸可能上千像素,先降到 1080 再 blur",
 *  而实际存下来的那张是 CHAR_IMAGE_MAX(1280)的 JPEG(见 useCharacters 的
 *  charImageBlob)—— 降到 1080 几乎是个空操作,不值得为它加一段 canvas 代码。
 *  真正要防的 GPU 开销用两件事对付:压暗蒙版把它盖住一半、窄屏把 blur 收小 */
/** 最新那张**已经画出来**的剧照属于哪一条。
 *
 *  它同时决定三件事:背景画哪张、流里**不**再重复画它、以及头部那行场景写什么。
 *  三件事必须是同一条消息 —— 否则会出现"背景是窗边、标题写的是别的"这种错位
 *  (头一行原来取的是"最后一条照片**意图**",而那条完全可能还没画出来) */
const stillMsg = computed(() => {
  const list = msgs.value
  for (let i = list.length - 1; i >= 0; i--) if (list[i].photoId) return list[i]
  return null
})
const stillId = computed(() => stillMsg.value?.photoId || '')

/** 这一屏的背景是哪一档。它决定**取景方式**:专用背景图与剧照按"人在右"构的图,
 *  而退回到人像时那张是居中的证件照式画面,得靠 CSS 把它推到右边去 */
const bgKind = computed(() => {
  if (props.backdrop) return 'backdrop'
  if (stillId.value && imgUrl(stillId.value)) return 'still'
  return 'face'
})

const bgSrc = computed(() => {
  const c = current.value
  if (!c) return ''
  /* **剧照优先**:这一页要的是"这一场戏",而生成的剧照正是它 ——
     它带着镜头、光与环境,是唯一撑得住"锐利铺满"的那种图。
     `imgUrl()` 与流里那张图共用同一份缓存(一条消息一个 objectURL),
     所以这里不额外读库、不额外占内存;还没读完的那一拍先落回首图。
     退路依次是:剧照 → 正脸 → 底图(`sourceRef`) → 主题色 */
  /* 顺序:这一场专门的背景图 → 最新那张剧照 → 正脸 → 底图 → 主题色。
     背景图排第一是因为它**就是为这件事画的**(横构图、主体靠右、左边留给字) */
  if (props.backdrop) return props.backdrop
  const still = stillId.value ? imgUrl(stillId.value) : ''
  return still || coverSrc(c.ref) || coverSrc(c.sourceRef)
})

/* 最近活跃在前的排序、搜索与那一行摘要,都随左栏收进了 ChatRail ——
   这里不再各存一份。 */

/* ===== 头部的模型药丸 ===============================================
   头像旁边那一枚回答的是"现在是谁在说话" —— 这一页原来答不上来:
   用的是哪条配置只在设置页(而且是混在别的用途里的)才看得到。
   名字优先、没起名字退回模型名,与设置页的 identLine、参数栏的胶囊同一套;
   借来的那一条还要带上来处,不然用户会以为它已经独立配过了 */
const chatModelName = computed(() => {
  const c = props.chatConfig
  if (!c) return 'No model'
  return c.name || c.model || 'Untitled config'
})
/* 这条配置**缺了哪一样**。有配置 ≠ 配全了:缺了它就是一条发不出请求的配置,
   而它在界面各处都像是配好了(药丸写着名字、设置页顶着「Current」)。
   两样分开说 —— 实测里缺模型名是常态(切换用途时被清掉过一次),但地址也可能是空的
   (手改过 localStorage、或从别处导进来),把后者说成"没有模型名"只会更糊涂 */
const chatMissing = computed(() => {
  const c = props.chatConfig
  if (!c) return ''
  if (!c.model.trim()) return 'model name'
  if (!c.baseUrl.trim()) return 'Base URL'
  return ''
})
/* 能不能真的开口。门控与措辞都从这一处来 —— 少写一处就会出现
   "按钮亮着、话发不出去"这种最费解的状态 */
const chatReady = computed(() => !!props.chatConfig && !chatMissing.value)
/* 借来的那枚药丸点开的是"配一条专属的",而不是"看列表" —— 它的问题本来就是
   还没有专属配置;已经有专属配置时点它才只是回列表切一条 */
const chatChipTip = computed(() =>
  !props.chatConfig
    ? 'No chat model yet — add one in API settings'
    : !chatReady.value
      ? `${chatModelName.value} is missing its ${chatMissing.value} — click to fix it in API settings`
      : props.chatBorrowed
        ? `Using the Prompt enhancing model (${chatModelName.value}) — click to add a dedicated one`
        : `${chatModelName.value} — click to change it in API settings`
)
/* ⋮ 菜单里那一行模型的补充说明。**同一时刻只说一句**,按"最要紧的那一件"排:
   缺东西(发不出请求)> 借来的(能用,但不是它自己的)。
   空白 = 都不用说。这两句原先挂在头部那枚药丸上(chip-note),
   药丸收进菜单时它们不能跟着丢 —— "缺模型名"那种状态在界面上本来就无声无息
   (药丸写着名字、设置页顶着 Current),少一句就再没人说了 */
const chatModelNote = computed(() =>
  !props.chatConfig
    ? ''
    : !chatReady.value
      ? `missing its ${chatMissing.value}`
      : props.chatBorrowed
        ? 'from enhancing'
        : ''
)

/* ===== 消息流的时间分隔 =============================================
   不逐条显示时间戳 —— 那是噪声。只在跨天、或两条之间隔得够久时插一条:
   它回答的是"这是一段旧对话还是接着刚才说的" */
const SEP_GAP = 30 * 60 * 1000

/* 时间一律钉死 en-US:全站界面是英文,而 toLocaleString 跟随系统 ——
   在中文机器上它会给出"10月2日",夹在一片英文里很跳。
   (ImagePreview 的时间戳也是这么钉的,同一套理由) */
function timeLabel(t: number): string {
  return new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}
function dayLabel(t: number): string {
  const d = new Date(t)
  const now = new Date()
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (sameDay(d, now)) return 'Today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

type Row =
  /* away: 末尾那一行"离开多久了"。它与别的时间分隔不是一回事 ——
     别的说"这条消息是什么时候发的",它说"这段对话放多久了" */
  | { kind: 'sep'; key: string; label: string; away?: boolean }
  /* first: 这是"新的一段"的第一条(换了人,或者上面刚插了一条时间分隔)。
     间距据此分两档 —— 见下面 rows 的说明与 .msg.group-first */
  | { kind: 'msg'; key: string; msg: ChatMessage; first: boolean }

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  let prev = 0
  /* 上一条是谁说的。换人(或前面插了一条时间分隔)就是"新的一段",
     间距要多让一档 —— 见 .msg.group-first */
  let prevRole = ''
  for (const m of msgs.value) {
    const newDay = !prev || new Date(prev).toDateString() !== new Date(m.createdAt).toDateString()
    const brokeByTime = !prev || newDay || m.createdAt - prev > SEP_GAP
    if (brokeByTime) {
      out.push({
        kind: 'sep',
        key: `sep-${m.id}`,
        // 跨天时报全"哪天 + 几点",同一天只报几点
        label: newDay ? `${dayLabel(m.createdAt)} · ${timeLabel(m.createdAt)}` : timeLabel(m.createdAt)
      })
    }
    out.push({
      kind: 'msg',
      key: m.id,
      msg: m,
      /* 连着同一个人的第二句起算"同一段":它还挨着上一句,读起来是一段话。
         注意分隔线也要算进来 —— 隔了半小时之后的第一句,哪怕还是同一个人说,
         视觉上也是新的一段 */
      first: brokeByTime || m.role !== prevRole
    })
    prev = m.createdAt
    prevRole = m.role
  }
  /* 末尾那一行"离开多久了"。
     回到一段放了很久的对话时,你的眼睛落在**最新那一条**上 ——
     而它的时间标记在**上面很远的地方**:分隔只插在"间隔之前",
     连着说的那几句后面没有标记。于是"这一整段是三天前的"这件事,
     在视口里一个字都没有,只有一串没有时间的句子。
     补在末尾而不是顶上,正是因为你会落在这里(顶上那些要往上翻才看得到)。

     阈值与分隔同一条(30 分钟):刚聊完就去别处转一圈回来,
     不该看见它。措辞与角色被告知的那句**同源**(见 server/chatTime.js) ——
     同一个事实在界面与提示词里说成两样,用户会以为它们在讲两件事 */
  const newest = msgs.value[msgs.value.length - 1]
  if (newest) {
    const gap = Date.now() - newest.createdAt
    if (gap > SEP_GAP) {
      const ago = agoLabel(gap, { long: true })
      if (ago) out.push({ kind: 'sep', key: 'sep-away', label: `Last spoke ${ago}`, away: true })
    }
  }
  return out
})

/** 气泡里显示的正文。
 *
 *  **三件事都只改"显示出来的样子"**,库里的正文一个字不动 ——
 *  正文是它说过的话,字节属于它;排版是我们的。
 *
 *  ① 摘掉中段那几枚独占一行的标签。修在服务端之前生成的消息还带着它。
 *  ② 收掉末尾的空白。它不是它说的话,而是"标签前面那个换行"的遗留:
 *     模型把 `[mood:…]` / `[photo:…]` 写在单独一行,那个换行有时会先一步
 *     流到界面上(修在 `chatTags.js` 的 `tailHold` 里了),而**已经存在库里的
 *     老消息也带着它**。气泡是 `white-space: pre-wrap`,结尾的 `\n` 会被
 *     如实渲染成一行空行 —— 短回复底下因此总像空了一格。
 *  ③ 把**中段的空行**收成单个换行。
 *
 *  ③ 的来历值得写下来:模型习惯用空行把一条回复分成"两拍"(先接住对方,
 *  再补一句自己的事 —— 见 chat 提示词里那条 carry it)。那是模型的排版习惯,
 *  不是它说的话;而在气泡里它渲染成一整行空白,看着像界面坏了。
 *  收成单个换行之后,那两拍仍然是两行,只是中间不再空一格。
 *  **只收空行,不动单换行**:它可能就是角色刻意的分行。
 *
 *  两个角色一视同仁 —— 自己打的字里出现空行同样不该显示。 */
function shownText(m: ChatMessage): string {
  return stripStandaloneTags(m.content)
    .text
    .replace(/\n[ \t]*\n(?:[ \t]*\n)*/g, '\n')
    .trimEnd()
}

/** 光标挂在正在说的那一条上。它同时说明"这会儿还在往下写" */
const cursorId = computed(() => {
  if (!streaming.value) return ''
  const last = msgs.value[msgs.value.length - 1]
  return last && last.role === 'assistant' ? last.id : ''
})

/* 重新生成:删掉最后那条助手消息、用同样的上文重发。
   用户那条不动。按过 Stop 的那条不提供 —— 它是"说到这儿够了",
   重发等于把用户的选择覆盖掉。
   **没配对话模型时不给这枚入口**:消息流不受输入区的门控,而这个动作
   要先删掉旧回复;发不出去的时候点它等于白丢一条(见主界面的 regenerateChat) */
const canRegenerate = computed(() => {
  if (streaming.value || !chatReady.value) return false
  const last = msgs.value[msgs.value.length - 1]
  return !!last && last.role === 'assistant' && !last.stopped
})

/* 重试:最后一条落在用户那句上,说明上一轮没答上来 ——
   runChat 失败时会把那条空壳摘掉(见主界面),消息流里因此只剩用户那句。
   与 Regenerate 共用同一个入口,只是文案不同 —— 同一次动作,
   在"想换个说法"和"刚才没发出去"两种情境下该叫不同的名字 */
const canRetry = computed(() => {
  if (streaming.value || !chatReady.value) return false
  const last = msgs.value[msgs.value.length - 1]
  return !!last && last.role === 'user'
})
const regenLabel = computed(() => (canRetry.value ? 'Try again' : 'Regenerate'))

/* 重新生成 / 重试也在气泡下角那一排里,排在"删"后面 ——
   它和"念 / 删"是同一类东西:这一条消息顺带能做的事。
   但它只对**末尾那一条**成立:这个动作就是"把最后一轮再来一次",
   挂到中间某条消息上,那句话就没有意思了 */
const tail = computed(() => msgs.value[msgs.value.length - 1])
function canRegenMsg(m: ChatMessage): boolean {
  return !!tail.value && tail.value.id === m.id && (canRegenerate.value || canRetry.value)
}
/* 末尾那条有没有气泡可挂。**只发了一张图、没有文字**的消息不渲染气泡
   (见模板里那一条 v-if),那种消息的下角无处可挂 ——
   这枚按钮退回消息流末尾(见 .regen),不然它就在这条消息上彻底消失了 */
const tailBubble = computed(() => {
  const m = tail.value
  return !!m && (!!m.content.trim() || !hasAttach(m))
})

/* ===== 每一条消息的悬停动作 ========================================
   念 / 删 / 重来。四条判据分开写,是因为它们各自有各自的理由,合成一个大
   布尔表达式之后"为什么这条没有那枚按钮"就读不出来了 */
/** 正在生成的那条不给朗读:半句话念出来只会更难听 */
function canSpeakMsg(m: ChatMessage): boolean {
  return canSpeak && m.role === 'assistant' && m.id !== cursorId.value
}
/** 正在生成的那条不给删:它还没落盘,删了会与收尾那一步打架(见主界面) */
function canDeleteMsg(m: ChatMessage): boolean {
  return !streaming.value && m.id !== cursorId.value
}
/** 整排动作有没有东西可放。一个都没有时连外层都不渲染 ——
   空着一排绝对定位的元素会平白多出一块能接收指针的区域 */
function hasMsgOps(m: ChatMessage): boolean {
  return canSpeakMsg(m) || canDeleteMsg(m) || canRegenMsg(m)
}
/** 这条消息挂着图没有(用户附的、或角色发的)。空气泡的判据要用它 */
function hasAttach(m: ChatMessage): boolean {
  return !!(m.imageId || m.photoId || m.photo)
}

const personaMissing = computed(() => !!current.value && !hasPersona(current.value.persona))

/* 此刻的情绪 = 最近那条回复带来的。**只看最后一条,不往前找** ——
   往前找会把一条很久以前的情绪一直挂在那儿,那就不是"此刻"了。
   流式期间那条占位消息还没有情绪,所以这枚药丸是在收尾那一刻才浮出来的 */
const mood = computed(() => {
  const last = msgs.value[msgs.value.length - 1]
  return last && last.role === 'assistant' ? last.mood || '' : ''
})

/* ===== 长期记忆 =====
   记忆以前是消息流最上面那一块,折起来的一块虚线框。那个位置有个死结:
   它代表"比这些消息更早的那些",顺序上确实该在最前面 —— 而一进来视口是
   贴在**底部**的,聊得越久它离得越远。想改一处措辞要先往上翻几百条。

   所以它改成两件事:
   - 一枚常驻在头部的入口(记忆非空时才出现),写着它多久没动过;
   - 一张悬浮卡片,点开就看、就能改 —— 位置固定,与对话多长无关。

   记忆是**有损**的,用户得能亲眼看到损掉了什么才谈得上信它;
   还得改得动 —— 否则唯一的办法是清空整段对话,而那把历史也一起扔了。 */
const memoryOpen = ref(false)
const memoryCard = ref<HTMLElement | null>(null)
const memoryChip = ref<HTMLElement | null>(null)

/** 相对时间。只到"天"这一档就够 —— 记忆本来就是隔一阵才更新一次的 */
function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
/* 有东西可看的记忆。看的是**正文非空**,不是记录在不在 ——
   忘掉之后库里会留一条正文为空的记录(那个"从哪之后不再记得"的游标
   总得有地方待),那种记录不该在界面上显出一枚空的入口。
   直接把记录本身交出去,模板里 v-if="memory" 一过就能接着取正文 */
const memory = computed(() => (props.summary?.text ? props.summary : undefined))
const memoryWhen = computed(() => (memory.value ? ago(memory.value.updatedAt) : ''))

/* 编辑态是"这张卡片临时在做什么",归组件自己管;写回库里的动作交给主界面 */
const memoryEditing = ref(false)
const memoryDraft = ref('')

/* 上限就用消息那一档:服务端对记忆收的正是 CHAT_MAX_CHARS,
   这里跟着同一个数,用户改到多少会被下游截断是可以预期的 */
const memoryTooLong = computed(() => memoryDraft.value.trim().length > CHAT_MAX_CHARS)

/** 开卡片。editing = 直接进编辑态(⋮ 菜单里那条"Edit memory"走它) */
async function openMemory(editing = false) {
  /* 菜单与卡片都从头部那一块展开,同时开着会叠在一起。
     开卡片就先把菜单收掉 —— 菜单那条 Edit memory 也是从这里进来的 */
  closeMenu()
  memoryDraft.value = editing ? props.summary?.text || '' : ''
  memoryEditing.value = editing
  memoryOpen.value = true
  /* 焦点收进卡片:Tab 从这里开始走,读屏也会念出它是什么。
     不这么做的话焦点还在背后那枚入口上,键盘用户 Tab 一路穿到消息流里 */
  await nextTick()
  memoryCard.value?.focus()
}
function closeMemory() {
  memoryOpen.value = false
  cancelEditMemory()
}
/** 头部那枚药丸:开着就收,关着就开。模板里直接写这个,不写三元表达式 */
function toggleMemoryCard() {
  if (memoryOpen.value) closeMemory()
  else void openMemory()
}
function startEditMemory() {
  memoryDraft.value = props.summary?.text || ''
  memoryEditing.value = true
}
function cancelEditMemory() {
  memoryEditing.value = false
  memoryDraft.value = ''
}
function saveMemory() {
  const t = memoryDraft.value.trim()
  /* 存空的没有意义:那等于"忘掉这段",而记忆与对话是绑在一起的 ——
     清空记忆该走"清空对话",不该在这里留下一个空壳 */
  if (!t || memoryTooLong.value) return
  emit('editSummary', props.active, t)
  /* 存完退回查看态而不是关掉卡片:让用户看见自己刚写的那版**已经生效**
     (主界面写回后 props 会跟着更新),比"啪一下收起来"可信 */
  memoryEditing.value = false
  memoryDraft.value = ''
}
/* 卡片里的 Tab 也要圈住 —— 与角色浮层、向导共用一份实现(见 lib/ui) */
function onMemoryKey(e: KeyboardEvent) {
  if (e.key === 'Tab') trapTab(memoryCard.value, e)
}
/* 换角色时把卡片收掉:那块记忆已经属于另一个人了,留着草稿会让人
   以为改的是当前这个。
   正念着的那句也一起停 —— 换了人就换了一段对话,上一个人的声音不该还在响 */
watch(
  () => props.active,
  () => {
    closeMemory()
    stopSpeaking()
  }
)

/* ===== 进 / 出沉浸 ==================================================
   一个动作配一次焦点搬运(与"打开浮层把焦点收进去、关掉再还回去"同一条规矩):
   - 进来把焦点交给输入框 —— 你切到沉浸就是为了说话,不该再点一下;
   - 出去还给那枚按钮 —— 焦点掉在文档开头是这家仓库一直在修的那类问题。

   顺带:进入时**不收菜单也不收记忆卡片**。它们是浮层,压在沉浸态之上;
   用户点开的那张卡片不该因为换了个骨架就自己合上。 */
const immBtnEl = ref<HTMLButtonElement | null>(null)
watch(
  () => props.immersive,
  async (on) => {
    await nextTick()
    if (on) inputEl.value?.focus()
    else immBtnEl.value?.focus()
  }
)

/* ===== 朗读 =========================================================
   用浏览器自带的语音(见 lib/speech)。**不支持就不给入口** ——
   一个点了没反应的按钮比没有更糟,所以这里先问一次 */
const canSpeak = speechSupported()

/** 念这一条。同一枚按钮管三件事:没在念就念,正在等就取消,正在响就停 ——
 *  再挂一枚"停止"在旁边,是在为一件只有两种状态的事多养一个按钮 */
async function toggleSpeak(msg: ChatMessage) {
  if (speakingId.value === msg.id) {
    stopSpeaking()
    return
  }
  const c = current.value
  if (!c) return
  /* 走哪条路由角色自己的嗓音决定(见 lib/speech):
     没配过的一律走浏览器,配了就走第三方 —— 失败会自己退回来,
     并把"退回来了"和原因一起交回来。
     language 也一样带上:设过语言的角色的朗读音色以它为准,
     不必再从回复文本里猜它说的是哪国话 */
  const said = await speak(
    msg.content,
    {
      charId: c.id,
      voice: c.voice,
      language: c.persona?.language,
      cfg: props.ttsConfig,
      /* 这一条的情绪一起给它:浏览器那条路据此调一点语速与音高
         (见 lib/speech 的 toneWithMood)。第三方那条路不认这个参数 ——
         那把嗓子是角色的身份,不该跟着情绪变 */
      mood: msg.mood
    },
    msg.id
  )
  if (said) emit('notice', said)
}

/* ===== 自动跟随 =====================================================
   只在"用户本来就贴着底"时才跟着新消息走。正在往上翻历史时被拽回底部,
   是聊天界面最烦人的一件事 */
const streamEl = ref<HTMLElement | null>(null)
const FOLLOW_GAP = 80

/* 贴着底没有。这是"自动跟随"的开关 —— 只在贴底时把视口带下去,
   用户往上翻的时候要让他安静地看。
   做成响应式(原来是普通变量)是因为界面还要据此决定要不要给"回到最新" */
const atBottom = ref(true)
/* 翻上去之后又来了几条。说的不是"未读" —— 用户可能刚看过,
   只是此刻不在底部,所以文案用"N new"而不是红点角标 */
const pendingNew = ref(0)
/* 正在做"回到最新"的平滑滚动。滚动过程会一路触发 scroll 事件、
   把 atBottom 反复算成 false,那枚按钮就会自己闪一下 —— 用一个旗子按住 */
let jumping = false

function onStreamScroll() {
  if (jumping) return
  const el = streamEl.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_GAP
  // 自己滚回底部就等于看过了
  if (atBottom.value) pendingNew.value = 0
}
function toEnd(smooth = false) {
  const el = streamEl.value
  if (!el) return
  if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  else el.scrollTop = el.scrollHeight
  atBottom.value = true
  pendingNew.value = 0
}
/* 那枚"回到最新"。只在真有内容、而且不贴底时出现 */
const showJump = computed(() => !atBottom.value && msgs.value.length > 0)
function jumpToLatest() {
  if (jumping) return
  jumping = true
  toEnd(true)
  window.setTimeout(() => {
    jumping = false
  }, 400)
}

/* 放在 onUpdated 而不是 watch(messages):流式时改的是**同一条消息的内容**,
   数组长度没变,watch 抓不到 */
onUpdated(() => {
  if (atBottom.value) toEnd()
})

/* 不贴底的时候底下又长了东西 ⇒ 记一笔,好在那枚按钮上说出来。
   往前读一档不算:那是用户自己点出来的,而且内容插在**上面** ——
   那种情况下该做的是稳住视口(见下面的 earlierFrom) */
watch(
  () => msgs.value.length,
  (n, prev) => {
    if (!prev || earlierFrom) return
    if (!atBottom.value && n > prev) pendingNew.value += n - prev
  }
)

watch(
  () => props.active,
  async () => {
    // 换角色 = 进到另一段对话,该落在最新那一句上
    atBottom.value = true
    pendingNew.value = 0
    closeMenu()
    pickerOpen.value = false
    await nextTick()
    toEnd()
  }
)
onMounted(async () => {
  await nextTick()
  toEnd()
})

/* ===== 往前读一档 ===================================================
   库里装的是最近 CHAT_PAGE 条,更早的还在库里没读。
   往上面插内容时浏览器不一定能自己稳住视口,所以读之前先记下高度,
   回来后按"长高了多少"把滚动条往下推同样的距离 */
let earlierFrom = 0

function loadEarlier() {
  if (!props.hasMore || streaming.value) return
  const el = streamEl.value
  earlierFrom = el ? el.scrollHeight : 0
  /* 先把"贴着底"关掉:消息一回来组件就会重渲染,
     这时若还贴着底,onUpdated 会把视口拽到底部去 —— 那是反方向 */
  atBottom.value = false
  emit('loadEarlier', props.active)
}

watch(
  () => msgs.value.length,
  () => {
    if (!earlierFrom) return
    const el = streamEl.value
    const grew = el ? el.scrollHeight - earlierFrom : 0
    earlierFrom = 0
    if (el && grew > 0) el.scrollTop += grew
  },
  // post:要在 DOM 更新**之后**量,否则量到的还是插进来之前的高度
  { flush: 'post' }
)

/* ===== 输入 ========================================================= */
const text = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)
/** 输入框最高长到六行,再多内部滚 —— 与角色向导的起稿块同一套 */
/* 长高那件事由 v-grow 指令负责(见 lib/grow.ts)。这里只在清空之后
   手动补一次 —— 清空会走到指令的 updated,但发送是同步的,
   补一次能让输入框在同一帧就收回去,不闪那一下 */
function grow() {
  const el = inputEl.value
  if (el) growTextarea(el)
}

/* 超长先拦在本地。服务端也会拒绝(它必须拒绝 —— 入口是公开的),
   但那时候用户手里那条已经被清空了,只能把一整段重打一遍。
   所以这里就挡住、原文留着、当场说清是哪一步过不去 */
const tooLong = computed(() => text.value.trim().length > CHAT_MAX_CHARS)

/* ===== 附图 =====
   用户可以把一张图发给角色看。上限与其余几处"喂给模型的图"共用同一个常量
   (见 lib/payload.ts 的 REF_IMAGE_EDGE):它要作为 data URL 随请求发出去,
   而一张 4000px 的原图光 base64 就有几 MB —— 模型看的是内容,不是分辨率。
   压过的这一份同时是"发出去的那份"和"存下来的那份",所以库里不会白白胖一圈。
   一次只挂一张:多图对"它在看什么"帮助有限,而每张都是上千 token。
   ------------------------------------------------------------------ */
const CHAT_IMAGE_MAX = REF_IMAGE_EDGE
const imgInput = ref<HTMLInputElement | null>(null)
const attach = ref<{ blob: Blob; url: string } | null>(null)

/* 点开的大图。**只存 url 不存 id**:URL 是 imgUrl() 那份缓存里的同一个,
   它本来就活到页面卸载为止,这里再建一次反而要多记一个要回收的东西 */
const zoom = ref<{ url: string; alt: string } | null>(null)
function openZoom(id: string, alt: string) {
  const url = imgUrl(id)
  if (url) zoom.value = { url, alt }
}

function clearAttach() {
  if (attach.value) URL.revokeObjectURL(attach.value.url)
  attach.value = null
}

async function shrinkForChat(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, CHAT_IMAGE_MAX / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(bmp.width * scale))
  c.height = Math.max(1, Math.round(bmp.height * scale))
  const ctx = c.getContext('2d')
  if (!ctx) {
    bmp.close()
    return file
  }
  ctx.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  /* 一律转 jpeg:png 截图动辄一两 MB,而聊天里这张图只用来"看",
     不需要无损。编码失败就退回原图,不因为这一步让人发不出去 */
  return (await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.85))) ?? file
}

async function onPickImage(e: Event) {
  const el = e.target as HTMLInputElement
  const file = el.files?.[0]
  // 清空 input:同一个文件选第二次也要能触发 change
  el.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    emit('notice', 'That file is not an image.')
    return
  }
  try {
    const blob = await shrinkForChat(file)
    clearAttach()
    attach.value = { blob, url: URL.createObjectURL(blob) }
  } catch {
    emit('notice', 'Could not read that image.')
  }
}

/* 已经发出去的那些图:按需从库里读回来,读完缓存在这一层 ——
   一条消息一个 objectURL。不缓存的话每次重渲染都要再开一次事务 */
const imgUrls = ref<Record<string, string>>({})
const imgPending = new Set<string>()

/** 取某张附图的显示地址。还没读回来时返回空串(那一帧先不画图) */
function imgUrl(id: string): string {
  const have = imgUrls.value[id]
  if (have) return have
  if (!imgPending.has(id)) {
    imgPending.add(id)
    void getChatImage(id).then((rec) => {
      imgPending.delete(id)
      if (!rec) return
      imgUrls.value = { ...imgUrls.value, [id]: URL.createObjectURL(rec.blob) }
    })
  }
  return ''
}

function send() {
  const t = text.value.trim()
  const id = props.active
  const pic = attach.value
  /* 只有图没有字也放行 —— "看看这个"本身就是一句话 */
  if ((!t && !pic) || !id || streaming.value || !chatReady.value || tooLong.value) return
  const blob = pic?.blob
  text.value = ''
  clearAttach()
  nextTick(grow)
  /* 自己开口了就跟下去。不这么做的话,往上翻着忽然发一句会留在原地,
     然后那枚按钮上会冒出 "1 new" —— 数的是自己刚说的那句,很怪 */
  toEnd()
  emit('send', id, t, blob)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey) return
  // 输入法组合中的回车是"确认候选词",不是发送 —— 中文输入法必然撞上
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  send()
}

function pick(id: string) {
  if (id !== props.active) emit('select', id)
  /* 从窄屏那个浮层里挑的:关掉它并把焦点交给输入框 ——
     刚选完跟谁说话,下一步就是开口 */
  if (pickerOpen.value) {
    pickerOpen.value = false
    void nextTick(() => inputEl.value?.focus())
  }
}

/* ===== 头部那枚 ⋮ 菜单 ==============================================
   里面只有一项,但清空是个不可逆动作,摆在人眼前等于给误触留门 */
/* —— 输入栏那枚 emoji 键 ——
   一格常用表,不做全量选择器:全量要么引一个大依赖,要么自己攒上千个码位,
   而聊天里真正会被用到的就那几十个。点了插在**光标处**,不是追加到末尾 ——
   用户多半是想在句子中间补一个表情 */
const EMOJI = [
  '😊','😄','😂','🥲','😉','😍',
  '🥰','😘','😳','😭','😤','😏',
  '🙄','😴','🤔','🫠','😅','😌',
  '👍','👏','🙏','🤝','💪','✌️',
  '🫶','👀','❤️','💔','✨','🎉',
  '🔥','☕','🌙','🥺','😮','💨'
]
const emojiOpen = ref(false)
const emojiWrap = ref<HTMLElement | null>(null)
const emojiBtn = ref<HTMLButtonElement | null>(null)

function closeEmoji(returnFocus = false) {
  if (!emojiOpen.value) return
  emojiOpen.value = false
  if (returnFocus) nextTick(() => emojiBtn.value?.focus())
}

/** 插在光标处,并把光标挪到插入的那个字符之后 ——
 *  连着点几个才不会每一个都跑到句子最前面 */
function insertEmoji(e: string) {
  const el = inputEl.value
  if (!el) {
    text.value += e
    return
  }
  const start = el.selectionStart ?? text.value.length
  const end = el.selectionEnd ?? start
  text.value = text.value.slice(0, start) + e + text.value.slice(end)
  nextTick(() => {
    el.focus()
    const at = start + e.length
    el.setSelectionRange(at, at)
  })
}

const menuOpen = ref(false)
const menuWrap = ref<HTMLElement | null>(null)
const pickerOpen = ref(false)
/* 浮层本身,以及打开它的那枚按钮。模态要求焦点收进来、关掉再还回去 ——
   缺了这两样,键盘与读屏用户打开浮层时焦点还留在背后的页面上,
   Tab 会一路穿到后面那些看不见的控件上 */
const pickerBox = ref<HTMLElement | null>(null)
const pickerTrigger = ref<HTMLElement | null>(null)

function closeMenu() {
  menuOpen.value = false
}

async function openPicker(e: MouseEvent) {
  pickerTrigger.value = (e.currentTarget as HTMLElement | null) ?? null
  pickerOpen.value = true
  await nextTick()
  // 焦点落在浮层本身而不是第一个条目:先让读屏念出"这是什么"
  pickerBox.value?.focus()
}

async function closePicker() {
  if (!pickerOpen.value) return
  pickerOpen.value = false
  await nextTick()
  // 物归原主。不收回去,焦点会掉在文档开头
  pickerTrigger.value?.focus()
  pickerTrigger.value = null
}

/** 选择器浮层里的 Tab 也要圈住。实现与角色向导、设定图查看器共用一份
 *  (见 lib/ui.ts 的 trapTab)—— 那三处原本各写了一遍,选择器已经开始不一致 */
function onPickerKey(e: KeyboardEvent) {
  if (e.key === 'Tab') trapTab(pickerBox.value, e)
}

function onDocPointerDown(e: PointerEvent) {
  /* 记忆卡片与菜单都是"点外面就收起"的浮层。两件事分开判:
     卡片里可能正写着草稿,不该因为顺手点掉了菜单把它一起带走 */
  if (
    memoryOpen.value &&
    !isInside(e.target, memoryCard.value) &&
    !isInside(e.target, memoryChip.value)
  ) {
    closeMemory()
  }
  /* emoji 面板在输入栏那一头,与菜单互不相干:各自判各自的 */
  if (emojiOpen.value && !isInside(e.target, emojiWrap.value)) closeEmoji()
  if (!menuOpen.value) return
  if (isInside(e.target, menuWrap.value)) return
  closeMenu()
}

/** Esc 是逐层退:先关角色浮层(并把焦点还回去),再关记忆卡片,最后关菜单 ——
 *  与角色页的查看器同一套规矩 */
function onKey(e: KeyboardEvent) {
  layerOnEscape(e.key, [
    // 大图压在最上面:它在时先收它,别让一次 Esc 把下面的菜单也带走
    { open: !!zoom.value, close: () => (zoom.value = null) },
    { open: pickerOpen.value, close: () => void closePicker() },
    { open: memoryOpen.value, close: closeMemory },
    { open: menuOpen.value, close: closeMenu },
    /* emoji 面板是这一页**最轻**的一层浮层:它压在最下面(输入栏),
       所以排在菜单后面 —— 上层的东西先收 */
    { open: emojiOpen.value, close: () => closeEmoji(true) },
    /* 沉浸是**最外面**那一层:一次 Esc 只退一层 —— 菜单开着时先关菜单,
       再按一次才退出沉浸。反过来(一次按两下)会让人以为"Esc 把我的菜单和
       整个模式一起弄没了" */
    { open: !!props.immersive, close: () => emit('toggleImmersive') }
  ])
}

/** 手动要一张新的背景图(见 App 的 drawBackdrop)。它同时把菜单收起来 ——
 *  菜单开着的时候点它,下一步想看的是画面,不是菜单。
 *
 *  **这是背景图唯一的出图入口**:进沉浸页与换戏都只把库里那张读回来铺上,
 *  不再自动生成(用户 2026-10-05 的要求)。
 *  这一页仍然只是发意图:配没配接口、场景够不够、画完存哪,全归主界面 */
function askBackdrop() {
  closeMenu()
  emit('newBackdrop')
}

/* ⋮ 菜单里那条 "Open in Characters"。它原来在头部是一枚常驻药丸,
   但那属于"离开这一段对话" —— 点击频次远低于模型/记忆那两枚,
   收进菜单之后头部只留"调这一段对话"的东西(见模板里那段说明) */
function openDetail() {
  closeMenu()
  if (props.active) emit('openCharacter', props.active)
}

/* ⋮ 菜单里那条"换模型"。它原来也是头部的一枚常驻药丸(见模板里那段说明)。
   **先收菜单再走** —— 这一步要去设置页,而菜单只有点到别处才收;
   不收的话它会在跳转后留在原地 */
function openChatModel() {
  closeMenu()
  emit('configureChatModel')
}

function clearChat() {
  closeMenu()
  /* 卡片一起收:这段对话(连同记忆)马上就没了,留着一张写着旧记忆的卡片
     会让人以为它还在。不收还有一处更隐蔽的后果 —— memoryOpen 仍是 true,
     而这个角色将来重新攒出记忆时,卡片会自己弹开 */
  closeMemory()
  if (props.active) emit('clear', props.active)
}

/* ⋮ 菜单里那条 "Edit memory":打开卡片并直接进编辑态。
   主入口是头部那枚常驻的 Memory 药丸(一眼看得见),菜单这条是给
   "手已经在菜单里了"的人留的近路 —— 两条路通向同一张卡片 */
function editMemoryFromMenu() {
  closeMenu()
  void openMemory(true)
}

/* 忘掉这段记忆。**一条消息都不删** —— 它只是"角色不再记得",
   而这段对话确实发生过,想回看随时能往上翻。
   真正的难处在主界面:不能只把正文清空,还得把游标推到最新,
   否则下一轮压缩会把刚忘掉的那段重新压回来(见 App 的 forgetChatSummary) */
function forgetMemory() {
  closeMenu()
  /* 卡片一起收掉:忘完之后头部那枚入口自己也会消失(记忆正文空了),
     留着一张写着旧内容的卡片会让人以为没忘成 */
  closeMemory()
  if (props.active) emit('forgetSummary', props.active)
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown)
  window.addEventListener('keydown', onKey)
  /* 进这一页就把音色表捞一次:它异步到达,而第一次朗读要用的就是它 */
  if (canSpeak) warmUpSpeech()
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  window.removeEventListener('keydown', onKey)
  /* 离开这一页就把嘴闭上:语音不属于"后台也该继续"的那类东西 */
  stopSpeaking()
  /* 附图的 objectURL 是这一层开的,就由这一层收回 —— 不收回的话
     它们会一直扣着那份 Blob,直到整页刷新 */
  clearAttach()
  for (const u of Object.values(imgUrls.value)) URL.revokeObjectURL(u)
})
</script>

<template>
  <div class="chat" :class="{ 'is-immersive': immersive }">
    <!-- 背景层:它所在的地方。**固定定位、铺满视口** —— 它不该被 .shell 的
         栏宽与内边距裁住,沉浸要的正是"整屏都是它那儿"。
         正脸的字节本来就为头像取过一次(coverSrc 按 Blob 缓存),这里不新增请求、
         不新增调用;没有正脸(手填的角色、或图丢了)就只剩那层压暗色,
         不报错、不留空壳 -->
    <div
      v-if="immersive && current"
      class="chat-bg"
      :class="`is-${bgKind}`"
      aria-hidden="true"
    >
      <img v-if="bgSrc" :src="bgSrc" alt="" />
    </div>

    <!-- —— 左栏:角色。与对话是同一个对象的两个面 ——
         目录与搜索都在 ChatRail 里(窄屏那个浮层用的是同一个组件) -->
    <aside v-show="!immersive" class="chat-rail" aria-label="Characters">
      <ChatRail
        :characters="characters"
        :active="active"
        :messages="messages"
        :last-msg="lastMsg"
        hide-scrollbar
        @select="pick"
        @pin="(id) => emit('pin', id)"
      />
    </aside>

    <!-- —— 右栏:这一段对话 —— -->
    <section class="chat-main">
      <!-- 没有角色:整页只有一句话和一个去处 -->
      <div v-if="!characters.length" class="chat-empty">
        <span class="empty-ava"><PhMaskHappy aria-hidden="true" /></span>
        <p class="empty-title">Create a character first</p>
        <p class="empty-sub">Characters are who you talk to here.</p>
        <button class="ed-btn primary" @click="emit('gotoChars')">Go to Characters</button>
      </div>

      <div v-else-if="!current" class="chat-empty">
        <span class="empty-ava"><PhChatCircleDots aria-hidden="true" /></span>
        <p class="empty-title">Pick someone to talk to</p>
        <p class="empty-sub">Any character on the left — each one keeps its own conversation.</p>
      </div>

      <template v-else>
        <header class="chat-head">
          <!-- 窄屏下左栏是收起的,这里那枚头像就是"换一个角色"的入口 -->
          <button
            class="head-pick"
            aria-label="Choose a character"
            @click="openPicker"
          >
            <span class="head-ava">
              <img v-if="avatarOf(current)" :src="avatarOf(current)" alt="" />
              <PhMaskHappy v-else aria-hidden="true" />
            </span>
            <span class="head-text">
              <span class="head-top">
                <span class="head-name">{{ current.name }}</span>
                <span v-if="mood" :key="mood" class="mood">{{ mood }}</span>
              </span>
            </span>
          </button>
          <span class="head-solo">
            <span class="head-ava">
              <img v-if="avatarOf(current)" :src="avatarOf(current)" alt="" />
              <PhMaskHappy v-else aria-hidden="true" />
            </span>
            <span class="head-text">
              <span class="head-top">
                <span class="head-name">{{ current.name }}</span>
                <span v-if="mood" :key="mood" class="mood">{{ mood }}</span>
              </span>
              <!-- 沉浸态的第二行是**场景 · 时间**,不是那串长相清单。
                   场景取自它自己最后一张照片意图里写的描述(reply.photo)——
                   等于它说"我在窗边",这一行就写"在窗边",不是我们编的。
                   **非沉浸态的第二行不再有东西**(2026-10-06)——
                   那里原本写着角色的 identity(那串"夜班护士"式的设定描述),
                   用户明确说不要:名字下面那行留给"此刻"的事,不留给档案 -->
              <span v-if="immersive && sceneLine" class="head-scene">{{ sceneLine }}</span>
            </span>
          </span>

          <!-- 头部右侧:记忆入口 + ⋮ 菜单。
               两者一起靠右收在 head-acts 里,窄屏把名字挤省略号时才不会错位。
               **两枚常驻药丸都收进了 ⋮ 菜单**:
               - `Open in Characters`(2026-10-06)——"离开这一段对话",
                 点击频次远低于"调这一段对话"的那几件;
               - **模型的入口**(同日更晚)——它曾经是这一排最宽的一枚
                 (名字长的中转别名能吃掉 18ch),也正是窄屏上先被挤掉的那枚;
                 更要紧的是**沉浸态**:那一排药丸在沉浸态一律不显示
                 (见 .chat.is-immersive .head-chip),想换模型得先退出沉浸 ——
                 收进菜单之后,那条路上它才够得着。
               于是头部只剩两枚常驻入口,一宽一窄都不会先坏掉 -->
          <div class="head-acts">
            <!-- 记忆的常驻入口。它在头部而不再在消息流顶上 ——
                 那是"它为什么还记得那件事"的解释,却要往上翻几百条才够得着。
                 只在真有记忆时出现:空着的一枚药丸点开是一片空。
                 药丸里**只留图标与 Memory**:"多久没动过"那句在卡片头里已经写过一遍,
                 同一个数不再在头部重复第二次(悬停短语里仍带着) -->
            <button
              v-if="memory"
              ref="memoryChip"
              class="head-chip mem-chip"
              :class="{ on: memoryOpen }"
              :title="`Long-term memory — updated ${memoryWhen}`"
              aria-haspopup="dialog"
              :aria-expanded="memoryOpen"
              @click="toggleMemoryCard"
            >
              <PhBrain aria-hidden="true" />
              <span class="chip-label">Memory</span>
            </button>

            <div ref="menuWrap" class="chat-menu-wrap">
              <button
                class="icob"
                aria-label="Conversation options"
                :aria-expanded="menuOpen"
                @click="menuOpen = !menuOpen"
              >
                <PhDotsThree aria-hidden="true" />
              </button>
              <div v-if="menuOpen" class="chat-menu">
                <!-- 现在用的是哪个模型 + 换一条。**头部那枚药丸收进了这里**
                     (2026-10-06)——它以前是头部最宽的一枚(名字长的中转别名能吃掉
                     18ch),窄屏上先被挤掉的正是它;而沉浸态下头部那一排药丸整个
                     不显示,想换模型得先退出沉浸(见 .chat.is-immersive .head-chip)。
                     点一下直达设置页:还没专配过就直接开一张对话配置的表单,
                     已经有专属配置时回列表切一条。
                     **顶上那一行仍要说清"现在用的是哪个、缺没缺东西"** ——
                     它原来靠药丸上的 name/note 说,收进菜单不能把那两句丢掉 -->
                <button class="menu-model" :title="chatChipTip" @click="openChatModel">
                  <PhSlidersHorizontal aria-hidden="true" />
                  <span class="mm-name">{{ chatModelName }}</span>
                  <span v-if="chatModelNote" class="mm-note">{{ chatModelNote }}</span>
                </button>
                <!-- 去它的详情:改设定、看那五张设定图、看拿它做过的图,都在那一页。
                     它原来在头部是一枚常驻药丸(Details),但那是"离开这一段对话" ——
                     收进这里之后,头部只剩"调这一段对话"的那两枚。
                     **不能塞进左边那个大按钮里** —— 按钮不能套按钮(见左栏那条注释) -->
                <button @click="openDetail">
                  <PhUser aria-hidden="true" />
                  Open in Characters
                </button>
                <!-- 没有记忆就没东西可改也没东西可忘 ——
                     点了打开的卡片是空的,不如不给。
                     忘记忆排在清空对话前面,三档是"忘一点 / 忘干净"的递进 -->
                <button v-if="memory" @click="editMemoryFromMenu">
                  <PhPencilSimple aria-hidden="true" />
                  Edit memory
                </button>
                <button v-if="memory" @click="forgetMemory">
                  <PhEraser aria-hidden="true" />
                  Forget memory
                </button>
                <!-- 这一场戏的背景图。**只在沉浸态给** —— 它服务的就是那一页 -->
                <button v-if="immersive" :disabled="backdropBusy" @click="askBackdrop">
                  <PhImage aria-hidden="true" />
                  {{ backdropBusy ? 'Drawing the background…' : 'New background' }}
                </button>
                <button :disabled="!msgs.length" @click="clearChat">
                  <PhTrash aria-hidden="true" />
                  Clear conversation
                </button>
              </div>
            </div>

            <!-- 进出沉浸。放在这一排的最后(与 ⋮ 相邻):两枚都是"这一页怎么用",
                   而它要去的地方与它自己同一排时,肌肉记忆是连续的 -->
            <button
              ref="immBtnEl"
              class="icob"
              :aria-label="immersive ? 'Leave immersive mode' : 'Immersive mode'"
              :aria-pressed="!!immersive"
              @click="emit('toggleImmersive')"
            >
              <PhArrowsInSimple v-if="immersive" aria-hidden="true" />
              <PhArrowsOutSimple v-else aria-hidden="true" />
            </button>
          </div>

          <!-- 记忆卡片。**悬浮在头部下方**,位置固定,与对话多长无关 ——
               它取代的正是"消息流最上面那一块":内容一样,只是在也够得着 -->
          <div
            v-if="memoryOpen && memory"
            ref="memoryCard"
            class="mem-card"
            role="dialog"
            aria-label="Long-term memory"
            tabindex="-1"
            @keydown="onMemoryKey"
          >
            <div class="mem-card-head">
              <PhBrain aria-hidden="true" />
              <span class="mem-card-title">Memory</span>
              <span class="mem-card-when">updated {{ memoryWhen }}</span>
              <button class="mem-x" aria-label="Close memory" @click="closeMemory">
                <PhX aria-hidden="true" />
              </button>
            </div>

            <!-- 改这里的字,不是改历史 —— 那段对话已经压成这几十个字了,
                 改它等于给模型换一份"我记得的版本"。改得动,这功能才谈得上可信 -->
            <template v-if="memoryEditing">
              <textarea
                v-model="memoryDraft"
                class="mem-input"
                rows="5"
                aria-label="Edit memory"
              ></textarea>
              <p v-if="memoryTooLong" class="mem-warn" role="alert">
                Over {{ CHAT_MAX_CHARS }} characters. Trim it before saving.
              </p>
              <div class="mem-actions">
                <button
                  class="save-btn"
                  :disabled="!memoryDraft.trim() || memoryTooLong"
                  @click="saveMemory"
                >
                  Save
                </button>
                <button class="quiet-btn" @click="cancelEditMemory">Cancel</button>
              </div>
            </template>

            <template v-else>
              <p class="mem-text">{{ memory.text }}</p>
              <p class="mem-note">
                Written by the model from the older part of this conversation — the messages above
                the last few. Edit it if it got something wrong; forget it to make
                {{ current.name }} start over from here.
              </p>
              <!-- 改是主操作,忘是次操作 —— 所以忘了的那枚悬停才染成危险色,
                   平时与"改一改"长得一样安静 -->
              <div class="mem-actions">
                <button class="quiet-btn" @click="startEditMemory">
                  <PhPencilSimple aria-hidden="true" />
                  Edit memory
                </button>
                <button class="quiet-btn danger" @click="forgetMemory">
                  <PhEraser aria-hidden="true" />
                  Forget memory
                </button>
              </div>
            </template>
          </div>
        </header>

        <!-- 消息流:整页唯一滚动的那一块。
             role="log" + aria-live 让读屏在**整条说完**时播报一次。
             光有 aria-live 不够:流式时内容逐块在变,读屏会把整段逐字念一遍,
             比不播报还糟 —— 所以生成期间挂上 aria-busy,把播报压到收尾那一刻
             (aria-busy 必须挂在 live region 自己身上才管用) -->
        <div
          ref="streamEl"
          class="chat-stream no-bar"
          role="log"
          aria-live="polite"
          :aria-busy="streaming ? 'true' : 'false'"
          @scroll="onStreamScroll"
        >
          <!-- 还没聊过:给一句实话 + 一个去处。这里**不编角色的话** ——
               那句话得由模型说,本地假装它开口是不诚实的 -->
          <div v-if="!msgs.length" class="chat-empty is-inside">
            <span class="empty-ava">
              <img v-if="avatarOf(current)" :src="avatarOf(current)" alt="" />
              <PhMaskHappy v-else aria-hidden="true" />
            </span>
            <p class="empty-title">Say something to {{ current.name }}</p>
            <p class="empty-sub">
              {{
                streaming
                  ? 'Starting…'
                  : `Every reply is written in ${current.name}’s own voice.`
              }}
            </p>
            <button
              v-if="personaMissing"
              class="ed-btn"
              @click="emit('gotoChars')"
            >
              Add a personality to {{ current.name }}
            </button>
          </div>

          <div v-else class="chat-inner">
            <!-- 记忆**不在这儿**了。它曾经是这上面的一块虚线框 ——
                 摆在这儿是讲顺序(它代表比这些消息更早的那些),代价是
                 一进来视口贴着底,聊得越久离它越远,想改一句要往上翻几百条。
                 现在它是头部那枚 Memory 药丸点开的悬浮卡片(见 chat-head 里那张 mem-card) -->
            <!-- 更早的还在库里,只是没读。这是一枚"往前翻"的入口,
                 不是"加载中" —— 所以措辞里不带任何等待或危险的意味 -->
            <div v-if="hasMore" class="earlier">
              <button class="earlier-btn" @click="loadEarlier">Load earlier messages</button>
            </div>

            <template v-for="r in rows" :key="r.key">
              <p v-if="r.kind === 'sep'" class="sep" :class="{ away: r.away }">{{ r.label }}</p>
              <div
                v-else
                class="msg"
                :class="[r.msg.role, { 'group-first': r.first, 'has-ops': hasMsgOps(r.msg) }]"
              >
                <!-- 用户附的图。**独立一块,不放进气泡**(文字有文字的框,图有图的位置)。
                     压在文字上面是因为它是那句话的前提:先看图,再读字 -->
                <button
                  v-if="r.msg.role === 'user' && r.msg.imageId && imgUrl(r.msg.imageId)"
                  type="button"
                  class="msg-img-btn"
                  aria-label="Open attached image"
                  @click="openZoom(r.msg.imageId, 'Attached image')"
                >
                  <img class="msg-img" :src="imgUrl(r.msg.imageId)" alt="Attached image" />
                </button>
                <!-- 气泡。**只有图没有字时不渲染它** —— 否则那句话下面会挂出
                     一个空的圆角小壳(发送时是允许"只发一张图"的),看着像坏了。
                     流式中的那条必须留着:光标挂在它身上 -->
                <div v-if="r.msg.content.trim() || r.msg.id === cursorId || !hasAttach(r.msg)" class="bubble">
                  <!-- 说了谁说的。左右对齐和底色是给眼睛的,
                       读屏读不出这两种区别,不补一句就只剩一堆光秃秃的句子 -->
                  <span class="sr-only">
                    {{ r.msg.role === 'user' ? 'You said: ' : `${current.name} said: ` }}
                  </span>
                  {{ shownText(r.msg) }}<span v-if="r.msg.id === cursorId" class="cursor" aria-hidden="true"></span>
                  <!-- 这一条顺带能做的事(念 / 删 / 重来)。整排贴着气泡外侧下角,
                       绝对定位 —— 它不该挤占气泡的宽度。放进流里(哪怕用
                       opacity 藏起来)会实打实地把每个气泡压窄 80px。
                       只在悬停时浮出来(触屏没有 hover,那时让它常驻,见样式)。
                       正在生成的那条一个都不给:半句话念出来只会更难听,
                       而删一条正在长的消息会与收尾落盘打架 -->
                  <span
                    v-if="hasMsgOps(r.msg)"
                    class="msg-ops"
                    :class="{ on: speakingId === r.msg.id }"
                  >
                    <button
                      v-if="canSpeakMsg(r.msg)"
                      class="speak-btn"
                      :class="{ busy: speakingId === r.msg.id && speakingLoading }"
                      :aria-label="
                        speakingId === r.msg.id
                          ? speakingLoading
                            ? 'Cancel reading'
                            : 'Stop reading this out loud'
                          : `Read ${current.name}’s reply out loud`
                      "
                      @click="toggleSpeak(r.msg)"
                    >
                      <PhStopCircle v-if="speakingId === r.msg.id" aria-hidden="true" />
                      <PhSpeakerHigh v-else aria-hidden="true" />
                    </button>
                    <button
                      v-if="canDeleteMsg(r.msg)"
                      class="del-btn"
                      :aria-label="
                        r.msg.role === 'user'
                          ? 'Delete your message'
                          : `Delete this reply from ${current.name}`
                      "
                      @click="emit('deleteMessage', current.id, r.msg.id)"
                    >
                      <PhTrash aria-hidden="true" />
                    </button>
                    <!-- 重新生成 / 重试:排在"删"后面。两者是同一件事的两种叫法,
                         只有末尾那一条有(见 canRegenMsg)。
                         **只有图标**,名字在这儿给读屏与悬停提示一份 -->
                    <button
                      v-if="canRegenMsg(r.msg)"
                      class="regen-btn"
                      :title="regenLabel"
                      :aria-label="regenLabel"
                      @click="emit('regenerate', current.id)"
                    >
                      <PhArrowsClockwise aria-hidden="true" />
                    </button>
                  </span>
                </div>
                <!-- 角色发来的图。**也在气泡外面**,垫在它说的话下面:
                     先读它说什么,再看它给你看什么。还没有 photoId = 正在画,
                     占一个同尺寸的方骨架位,免得图到了把整段对话顶下去。

                     **沉浸态也照常显示**。曾经有一条"最新那张已经在背景上了,
                     所以流里不再重复"的例外 —— 那是"背景图就借这张剧照"那会儿
                     留下的。现在背景图是**单独生成、单独存**的另一张(见
                     doc/沉浸式对话页面设计.md §4),那条例外就没有理由了:
                     它发过的图是**这段对话的一部分**,不该因为换了个骨架就消失。
                     (只有"还没有专用背景图、暂借这张剧照铺底"的那一档会看到
                     同一张图出现两次 —— 那是过渡状态,不是丢掉消息的理由) -->
                <div
                  v-if="r.msg.role === 'assistant' && r.msg.photoId && imgUrl(r.msg.photoId)"
                  class="msg-photo-wrap"
                >
                  <button
                    type="button"
                    class="msg-img-btn"
                    :aria-label="`Open the photo from ${current.name}`"
                    @click="openZoom(r.msg.photoId, 'Photo from the character')"
                  >
                    <img
                      class="msg-photo"
                      :src="imgUrl(r.msg.photoId)"
                      alt="Photo from the character"
                    />
                  </button>
                  <!-- 正在重画。**这一层压在图上,不是只让角落里那枚图标动** ——
                       只让图标动的时候,图本身毫无变化,点完跟没点一样
                       (用户原话:"不知道是不是在重绘")。
                       手法与设定图那一格是同一套(见 CharacterPage 的 .cell-busy):
                       一层暗幕压住旧图,中间一枚呼吸的圆环。
                       **旧图不撤** —— 重画失败时它照旧留在原位(见主界面的 markFailed)。
                       暗幕不吃点击:图还看得清,也就还点得开放大 -->
                  <span v-if="redrawing[r.msg.id]" class="photo-busy" aria-hidden="true">
                    <span class="photo-busy-ring"></span>
                  </span>
                  <!-- 再摇一张。**挂在图上,不挂在文字那枚药丸里** ——
                       两件理由:它作用的是这张图,而"整轮重来"已经用着同一个图标
                       (见 .regen-btn),两枚同形的键挨在一起谁也分不清谁;
                       而且"只发了一张图、没有文字"的消息根本没有气泡可挂。
                       平时不出现(悬停或键盘聚焦才浮出来,与消息那排动作同一规矩);
                       正在重画时它让位给上面那层暗幕 —— 那会儿该读的是进度,不是按钮 -->
                  <button
                    v-if="!redrawing[r.msg.id]"
                    type="button"
                    class="photo-redraw"
                    title="Draw this photo again"
                    :aria-label="`Draw ${current.name}’s photo again`"
                    @click="emit('retryPhoto', current.id, r.msg.id)"
                  >
                    <PhArrowsClockwise aria-hidden="true" />
                  </button>
                </div>
                <!-- 这一张没画出来。**必须说出来** —— 从前它只是把骨架悄悄撤掉,
                     于是"没收到图"和"本来就没打算发图"在界面上长得一模一样:
                     用户既不知道为什么没有图,也没有地方让它再来一次。
                     场景描述还在消息上,所以重试不必再问模型一遍 -->
                <div
                  v-else-if="r.msg.role === 'assistant' && r.msg.photo && r.msg.photoFailed"
                  class="photo-fail"
                  role="status"
                >
                  <PhImageBroken aria-hidden="true" />
                  <!-- **原因优先于那句笼统的说明**:用户要的是"下一步改什么",
                       而"生成失败"四个字给不出任何线索(见 ChatMessage.photoError)。
                       `title` 兜住被 CSS 截断的长原因 —— 上游的原话可能很长 -->
                  <span :title="r.msg.photoError || undefined">
                    {{ r.msg.photoError || 'Couldn’t generate that image.' }}
                  </span>
                  <button
                    type="button"
                    class="photo-retry"
                    :aria-label="`Try generating ${current.name}’s image again`"
                    @click="emit('retryPhoto', current.id, r.msg.id)"
                  >
                    <PhArrowsClockwise aria-hidden="true" />
                    Try again
                  </button>
                </div>
                <!-- 正在画的那张占一个骨架位(它还没有 photoId,只能落在这里) -->
                <span
                  v-else-if="r.msg.role === 'assistant' && r.msg.photo"
                  class="msg-photo msg-photo-skel"
                  aria-hidden="true"
                ></span>
                <!-- 上游撞上 max_tokens 停下。不标这一句的话,
                     它和"正常说完"在界面上长得一模一样 ——
                     用户会以为角色话说一半是它自己的风格 -->
                <p v-if="r.msg.truncated" class="cut">Cut off at the length limit</p>
              </div>
            </template>

            <!-- 重新生成 / 重试的**退路**:末尾那条没有气泡可挂时(只发了一张图、
                 没有文字 —— 那种消息不渲染气泡,下角那排也就没有落脚点)才出现在
                 这儿。正常情况下它在末尾那条的悬停动作里,排在"删"后面。
                 一样只有图标(名字在 title / aria-label 上)。
                 **它站在哪一边,跟着它要重来的那条消息**:canRetry 说明末尾是
                 用户那句(靠右),canRegenerate 说明是角色那条(靠左)——
                 站在对面的时候,它跟那张图之间隔着整个面板,谁也不会把两者连起来 -->
            <div
              v-if="(canRegenerate || canRetry) && !tailBubble"
              class="regen"
              :class="{ 'is-user': canRetry }"
            >
              <button
                class="regen-btn"
                :title="regenLabel"
                :aria-label="regenLabel"
                @click="emit('regenerate', current.id)"
              >
                <PhArrowsClockwise aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <!-- 输入区:固定在底部,不跟消息一起滚走 -->
        <div class="chat-compose">
          <!-- 回到最新。贴在输入区上沿(bottom: 100%)而不是写死一个像素值 ——
               输入区的高度会变(多一条超长警告、或没配模型时换成另一块),
               写死了就会在那些时候错位 -->
          <div v-if="showJump" class="jump">
            <button class="jump-btn" @click="jumpToLatest">
              <PhArrowDown aria-hidden="true" />
              {{ pendingNew ? `${pendingNew} new` : 'Latest' }}
            </button>
          </div>
          <!-- 开不了口时占住整块输入区。**分两种**,因为这是两件事:
               一条都没有("去配一条")、以及配了但没填模型名("去补上那一个")。
               合成一句"请检查设置"会把后者说成前者,而用户手里明明有一条标着
               Current 的配置 —— 那正是他上一次被那句服务端报错绕进去的地方 -->
          <div v-if="!chatReady" class="compose-off">
            <PhSlidersHorizontal aria-hidden="true" />
            <template v-if="!chatConfig">
              <span>Add a chat model in API settings to start talking.</span>
              <!-- 点它直接开一张"用途 = 对话"的表单,不是先落到一串别的用途里挑 ——
                   这句话说的就是"去配一条对话模型",那就该一步到位 -->
              <button class="ed-btn" @click="emit('configureChatModel')">Add a chat model</button>
            </template>
            <template v-else>
              <span>
                <b>{{ chatModelName }}</b> is missing its {{ chatMissing }} — set it in API
                settings to start talking.
              </span>
              <!-- 这一条就是"改那一份":主界面会把它的表单直接开出来,不用用户再去列表里找 -->
              <button class="ed-btn" @click="emit('configureChatModel')">
                Set the {{ chatMissing }}
              </button>
            </template>
          </div>
          <!-- 超长当场说清:文案里带上限,免得用户去猜是多少。
               包一层 template 是因为它和下面那张卡片是一组 v-if / v-else ——
               直接并排写会把上面那条 "没配模型" 的分支拆断 -->
          <template v-else>
            <!-- 待发的图。压在输入框**上面**而不是挤进框里:它只是这一句
                 要带的东西,不该把输入区挤窄;取消就按它右上角那一枚 -->
            <div v-if="attach" class="attach">
              <img :src="attach.url" alt="Attachment preview" />
              <button
                type="button"
                class="attach-x"
                aria-label="Remove the image"
                @click="clearAttach"
              >
                <PhX aria-hidden="true" />
              </button>
            </div>
            <p v-if="tooLong" class="compose-warn" role="alert">
              That message is over {{ CHAT_MAX_CHARS }} characters. Trim it before sending.
            </p>
            <div v-else class="compose-box">
              <textarea
                ref="inputEl"
                v-grow
                v-model="text"
                class="no-bar"
                rows="1"
                :placeholder="`Tell ${current.name} something…`"
                :aria-label="`Message ${current.name}`"
                @keydown="onKeydown"
              ></textarea>
              <!-- 附图 / 表情两枚键挪到**右端**,挨着发送键(2026-10-06 用户要求
                   "输入框 icon 都移到右边")。三枚同侧是有道理的:它们都是
                   "对这一句话做的事",不是"开始说一句话"的入口 —— 字从左边起,
                   工具收在右边,视线不用在两端来回跳。
                   **最右那一枚仍然永远留给"把这句话发出去"** -->
              <button
                type="button"
                class="img-btn"
                :disabled="streaming"
                aria-label="Attach an image"
                title="Attach an image"
                @click="imgInput?.click()"
              >
                <PhImage aria-hidden="true" />
              </button>
              <input ref="imgInput" type="file" accept="image/*" hidden @change="onPickImage" />
              <!-- 表情键与附图键同款(都是输入栏里的图标键)。面板**向上、且向左**开:
                   这一行贴着屏幕最底,往下开就出画面了;而锚点跟着键挪到了右端,
                   再按 left: 0 展开就会从输入区右缘伸出去(见 .emoji-pop 的 right: 0) -->
              <div ref="emojiWrap" class="emoji-wrap">
                <button
                  ref="emojiBtn"
                  type="button"
                  class="img-btn"
                  :class="{ on: emojiOpen }"
                  aria-label="Insert an emoji"
                  aria-haspopup="dialog"
                  :aria-expanded="emojiOpen"
                  title="Insert an emoji"
                  @click="emojiOpen = !emojiOpen"
                >
                  <PhSmiley aria-hidden="true" />
                </button>
                <div v-if="emojiOpen" class="emoji-pop" role="dialog" aria-label="Emoji">
                  <button
                    v-for="e in EMOJI"
                    :key="e"
                    type="button"
                    class="emoji-cell"
                    :aria-label="`Insert ${e}`"
                    @click="insertEmoji(e)"
                  >
                    {{ e }}
                  </button>
                </div>
              </div>
              <!-- 生成中把这一枚原地换成停止键 —— 不是并排多一个按钮 -->
              <button
                v-if="streaming"
                class="send-btn"
                aria-label="Stop"
                @click="emit('stop', current.id)"
              >
                <span class="stop-sq" aria-hidden="true"></span>
              </button>
              <button
                v-else
                class="send-btn"
                :disabled="(!text.trim() && !attach) || tooLong"
                aria-label="Send"
                @click="send"
              >
                <PhArrowUp aria-hidden="true" />
              </button>
            </div>
          </template>
        </div>
      </template>
    </section>

    <!-- 窄屏下换角色:左栏收起了,这一层顶上。
         遮罩取值与设定图查看器同一套(深色 + 模糊,与主题无关) -->
    <div v-if="pickerOpen" class="picker" @click="closePicker">
      <div
        ref="pickerBox"
        class="picker-box no-bar"
        role="dialog"
        aria-modal="true"
        aria-label="Choose a character"
        tabindex="-1"
        @click.stop
        @keydown="onPickerKey"
      >
        <!-- 与并排布局里那一栏是**同一个组件** —— 从前这两块各写一遍,
             改一处忘一处正是它们会走调的来源 -->
        <ChatRail
          :characters="characters"
          :active="active"
          :messages="messages"
          :last-msg="lastMsg"
          @select="pick"
          @pin="(id) => emit('pin', id)"
        />
      </div>
    </div>
  </div>

    <!-- 大图。点背景或 Esc 收起 —— 与历史页那个查看器同一个交互,
         但这里只有一张图,不值得为它拉起整套 ImagePreview(那条链绑的是记录) -->
    <div
      v-if="zoom"
      class="zoom"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      @click.self="zoom = null"
    >
      <img :src="zoom.url" :alt="zoom.alt" />
      <button class="zoom-x" type="button" aria-label="Close" @click="zoom = null">
        <PhX aria-hidden="true" />
      </button>
    </div>
</template>

<style scoped>
.chat {
  /* 页面高度 = 视口 − 顶栏 − frame 上边距 − 底部余量。
     --mast-h 由主界面量出来挂在根元素上(见 App 的 mastRO),顶栏换行变高时这里跟着变。
     用 dvh 而不是 vh:移动端地址栏收起时 vh 会让底部被切掉一截。
     最后那个 --sp-4 就是面板与视口底边之间那道缝 —— 它已经从
     .shell-wide 的 padding 挪进了这条算式(那边现在是 0),
     两边是一对,改一个要改另一个 */
  height: calc(100vh - var(--mast-h, 72px) - var(--sp-2) - var(--sp-4));
  height: calc(100dvh - var(--mast-h, 72px) - var(--sp-2) - var(--sp-4));
  /* 屏很矮时宁可让整页滚,也不要压成一条缝 */
  min-height: 420px;
  display: grid;
  /* 左栏 320(从 280 加上来)。那一栏里要放下头像 + 名字 + 最近一句 + 时刻,
     而**搜索框的宽度就是栏宽减去两侧内边距**,所以"搜索框太窄"这件事
     只能在栏宽上解 —— 把框自己的内缩改小会变成"贴着栏边",那条走过了。
     860px 以下这栏整个收起(见断点),所以加宽只影响真正并排的那些宽度:
     最窄的并排宽度 861 时,对话区还剩 861-32(shell)-320-16(间距) ≈ 493px */
  grid-template-columns: 320px minmax(0, 1fr);
  gap: var(--sp-4);
  min-width: 0;
}

/* ===== 左栏 ===== */
.chat-rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--sp-3) var(--sp-2);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}

/* ===== 右栏 ===== */
.chat-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  /* 圆角靠子元素自己的内边距让开,不靠裁切 ——
     裁切会把底下那张悬浮卡片的投影也一起切掉 */
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
.chat-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--line);
  /* 记忆卡片挂在它下面(top: 100%),所以它得是定位上下文 ——
     这样头部换行变高时卡片跟着下移,不会盖住第一条消息 */
  position: relative;
}
/* 头部右侧那一组:模型入口 + 记忆入口 + ⋮。靠右由这一层统一负责,
   几枚各自再写 margin-left:auto 会把间距算乱 */
.head-acts {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  margin-left: auto;
}
/* 头部那两枚安静的药丸(模型 / 记忆):与情绪那枚同一个语言(小字 + 圆角底色),
   但它们可点 —— 所以悬停、展开态都要有反馈。
   两者共用一套皮,只有内容不同:一个是"现在谁在说话",一个是"它记得什么" */
.head-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.head-chip > svg {
  font-size: 13px;
}
.head-chip:hover,
.head-chip.on {
  background: var(--accent-soft);
  color: var(--text-2);
}
/* —— 输入栏的表情面板 —— */
.emoji-wrap {
  position: relative;
  flex: none;
}
.emoji-wrap .img-btn.on {
  background: var(--accent-soft);
  color: var(--text);
}
.emoji-pop {
  position: absolute;
  bottom: calc(100% + 8px);
  /* **贴着键的右缘、往左展开**。这一排图标在输入区的右端,
     再按 left: 0 展开的话整块面板会从输入区右缘伸出去(窄屏上直接出屏) */
  right: 0;
  /* 与 .chat-menu 同一层:两者都是浮在内容上的小面板,且互斥(一个在头部、
     一个在输入栏),不需要再分层 */
  z-index: 20;
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  box-shadow: var(--sh-md);
}
.emoji-cell {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  font-size: 19px;
  line-height: 1;
  cursor: pointer;
}
.emoji-cell:hover {
  background: var(--accent-soft);
}
@media (max-width: 560px) {
  .mem-chip .chip-label {
    display: none;
  }
}
/* 宽屏用不可点的 head-solo,窄屏才换成可点的 head-pick ——
   宽屏下左栏就在旁边,再给一个"换角色"的入口是多余的 */
.head-solo {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.head-pick {
  display: none;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.head-ava {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-3);
}
.head-ava img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.head-ava svg {
  font-size: 16px;
}
.head-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
/* 名字与情绪同一行:情绪是"此刻的状态",贴着名字读最自然。
   下面那一行现在是**沉浸态的场景 · 时间**(见 head-scene),不再是角色的身份 ——
   "此刻"的东西都留在名字这一行,第二行只留给这一场戏 */
.head-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.head-name {
  overflow: hidden;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 这一轮的情绪。做成一枚小药丸而不是一行字 ——
   实心边界说明"这不是它说的话",它是关于这段话的元数据。
   刻意不上色:与站内克制的灰度一致,情绪由词本身表达 */
.mood {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: 600;
  /* key 绑在词上:词一变就换一个节点,这段入场动画于是重播一次 ——
     情绪变了该被看见,而不是悄无声息地换个字 */
  animation: mood-in 280ms var(--ease) both;
}
@keyframes mood-in {
  from {
    opacity: 0;
    transform: translateY(-3px) scale(0.92);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mood {
    animation: none;
  }
}
.chat-menu-wrap {
  position: relative;
  flex: none;
}
.icob {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.icob:hover {
  background: var(--surface-hover);
}
.icob svg {
  font-size: 18px;
}
.chat-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  min-width: 190px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  box-shadow: var(--sh-md);
}
.chat-menu button {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text);
  font-size: var(--fs-sm);
  text-align: left;
  cursor: pointer;
}
.chat-menu button:hover:not(:disabled) {
  background: var(--surface-hover);
}
.chat-menu button:disabled {
  color: var(--text-4);
  cursor: default;
}
/* 模型那一行:名字后面还要接一句"借来的 / 缺了哪一样",所以名字自己收口 ——
   名字可以是中转上自己写的别名,很长,而这一行是固定宽度的菜单 */
.chat-menu .mm-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 补充说明压暗一档并靠右:它是同一行里的次要信息,不该和名字争同样的分量 */
.chat-menu .mm-note {
  flex: none;
  margin-left: auto;
  color: var(--text-3);
  font-size: var(--fs-micro);
}

/* ===== 消息流 ===== */
.chat-stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-4) var(--sp-4) var(--sp-3);
  /* 纵向 flex 是为了让里面的空态能撑满整格并居中 ——
     空态用 flex:1,而块级父容器下 flex:1 是不起作用的 */
  display: flex;
  flex-direction: column;
}
.chat-inner {
  display: flex;
  flex-direction: column;
  /* 间距分两档(与 .msg.group-first 配合):
     - 同一个人的连续几条(正文 + 它接着发的话/图)挨紧一点,读起来是一段;
     - 换了人再让一档,合计 --sp-4(16px)。
     均匀的 8px 会让整屏发闷、谁在跟谁说也糊成一片 —— 这条链上最要紧的
     就是"换人"这件事,间距是它的第一个信号(第二个是气泡的方向与底色) */
  gap: var(--sp-2);
  /* 铺满整块面板:不再收在中间一列里。收窄是为了"读起来舒服",
     但这块面板本来就只有一个说话对象,两侧再空出两百多像素,
     看着就是没铺满 —— 宽度交给气泡自己的 76% 上限去控 */
  width: 100%;
  /* 父级是纵向 flex:不加这一条,内容短时也会被拉着撑高 */
  flex: none;
}
/* 换人(或跨过一条时间分隔)的那一条多让出 8px —— 与 gap 相加正好 16px。
   用 margin 而不是给每一段套一层容器:套容器会把图、气泡、小注拆到不同的
   层级里,而它们本来就该跟着消息一起排 */
.msg.group-first {
  margin-top: var(--sp-2);
}
.sep {
  align-self: center;
  /* 分隔线自己也要呼吸:上面留得更宽(它开启新的一段),下面留一档窄的 ——
     紧跟着的那条消息自己还会再带一个 group-first 的上边距 */
  margin: var(--sp-4) 0 var(--sp-1);
  font-size: var(--fs-micro);
  letter-spacing: 0.04em;
  /* **内容用 --text-3,不用 --text-4**。--text-4 是"禁用态"那一档:
     浅色主题里它在白底上只有 1.65:1、深色 2.01:1 —— 那意味着读不出来。
     从前背景几乎是一片纯色时它还勉强看得见,沉浸页把剧照铺上来之后
     就彻底不行了(这条规矩同一份文件里早写过一次,见 .mem-note)。
     真正的禁用态(菜单项、发送键)仍留在 --text-4 */
  color: var(--text-3);
}
/* 末尾那行"离开多久了"。它不在两条消息之间,而是**收在一段对话的后面** ——
   所以上面留足(与最后一条拉开),下面由输入区那边负责,别挤在一起。
   刻意不加边框、不加底色:它是这段对话的一个注脚,不是一条消息 */
.sep.away {
  margin: var(--sp-6) 0 var(--sp-2);
}
.msg {
  display: flex;
  /* 竖着排,好让"被截断"那行小注落在气泡下面。
     整条靠哪一边由 .msg.user 决定 */
  flex-direction: column;
  align-items: flex-start;
}
.msg.user {
  align-items: flex-end;
}
/* 念 / 删 / 重来这几枚键装在一枚**动作药丸**里,绝对定位 —— 它们不该占气泡的宽度。
   放进流里(哪怕用 opacity 藏起来)会实打实地把每个气泡压窄一排的宽度,
   而不悬停的时候谁也看不见它们,那份窄就成了一份没来由的窄。

   **药丸是它的底,不是装饰**(2026-10-06 改)。从前三枚是光着挂在气泡外侧的:
   没有底,三枚之间只隔 2px 而各自的框有 40px 宽 —— 图标之间因此空着近 30px,
   读起来是"三个谁也不挨着谁的点",而不是一条工具;到了沉浸页还直接躺在剧照上,
   而 --text-3 是照面板面调的一档灰,照片一亮就没了。给一个 --surface 的底
   (与 .chat-menu / 记忆卡片同一层语言),三枚才是一件事,对比度也不再靠运气。

   两侧的挂法不同:角色那条挂在气泡右边,自己那条挂在气泡左边 ——
   自己说的靠右排,右侧再挂东西就出面板了。所以两侧的气泡都要有个
   定位上下文(.bubble 上的 position: relative,见下面两条规则) */
.msg.assistant .bubble {
  position: relative;
}
.msg.user .bubble {
  position: relative;
}
/* 药丸的尺寸。三枚是上限(末尾那条同时有"念 / 删 / 重来"),
   下面几个变量同时喂给三处:药丸自己、气泡要让出的走道(--ops-lane),
   以及挂不下时气泡要让出的高度(--ops-rail)。
   鼠标那档 34px:三枚并排时比 40px 少 18px,排在一起才读得出是一组。
   触屏那档抬回 40px —— 站内对触控目标的底线(见 PRODUCT.md) */
.chat {
  --ops-btn: 34px;
  --ops-gap: 2px;
  --ops-pad: 3px;
  --ops-rail: calc(var(--ops-btn) + 2 * var(--ops-pad));
  /* 走道 = 药丸自己的宽 + 与气泡之间的缝 + 一点余量。少了最后那一点,
     气泡正好长到"药丸贴着滚动内沿"的位置 —— 差 1px 就又被裁 */
  --ops-lane: calc(
    3 * var(--ops-btn) + 2 * var(--ops-gap) + 2 * var(--ops-pad) + 2px + 2 * var(--sp-2)
  );
}
.msg-ops {
  position: absolute;
  /* 与气泡下沿齐平:图标在药丸里居中,药丸贴着气泡的底边,
     三枚的光学中线正好落在气泡最后一行字上(从前是 bottom: -2px,
     整排的下沿压到气泡外面,图标看着浮在气泡下角外头) */
  bottom: 0;
  display: flex;
  align-items: center;
  gap: var(--ops-gap);
  padding: var(--ops-pad);
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  box-shadow: var(--sh-sm);
  /* 每条消息都挂着一排按钮会把对话流弄得很吵,所以手指悬上来它才浮出来。
     触屏没有 hover,那种设备上让它常驻但压暗一档(见下面的媒体查询) */
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.msg.assistant .msg-ops {
  left: 100%;
  margin-left: var(--sp-2);
}
.msg.user .msg-ops {
  right: 100%;
  margin-right: var(--sp-2);
}
.msg:hover .msg-ops {
  opacity: 1;
}
/* 键盘走到这一排上时也要看得见。它们平时是 opacity: 0 的,
   而 Tab 是**不产生 hover** 的 —— 少了这一条,焦点落上去时
   屏幕上什么都不会变,等于在盲按(重新生成也在这一排里,见 .regen-btn) */
.msg:focus-within .msg-ops {
  opacity: 1;
}
/* 正在念的那条常驻显示:它是"怎么让它停下来"的唯一入口,
   不该等手指找上来才出现 */
.msg-ops.on {
  opacity: 1;
}
.msg-ops.on .speak-btn {
  color: var(--text-2);
}
/* 念 / 删 / 重来同形:圆点,无底无边,悬停才在药丸里浮出淡底。
   重新生成**只有图标**(2026-10-05 用户要求"只保留 icon"):同一个动作有
   两种叫法("Regenerate" / "Try again",见 regenLabel),而那行字放在这一排里
   会比其他两枚宽出一大截。
   名字留在 title 与 aria-label 上:看得见的是图标,读得到的是词 */
.speak-btn,
.del-btn,
.regen-btn {
  display: grid;
  place-items: center;
  width: var(--ops-btn);
  height: var(--ops-btn);
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.speak-btn svg,
.del-btn svg,
.regen-btn svg {
  font-size: 15px;
}
.speak-btn:hover,
.regen-btn:hover {
  background: var(--accent-soft);
  color: var(--text-2);
}
/* 删除只在悬停时染成危险色:静止时它与"念一下"同等分量,
   染红了就会把一次轻声的清理变成整页最抢眼的东西(与 Forget memory 同一分寸) */
.del-btn:hover {
  background: var(--accent-soft);
  color: var(--danger);
}
/* 还在等音频。这一档必须看得出来 —— 第三方合成要等几百毫秒到好几秒,
   而在它出声之前,"在等"和"已经念完了"长得一模一样:都是不出声。
   用呼吸动画说"我在干活"(与设定图生成中同一手法) */
.speak-btn.busy {
  animation: speak-wait 1.2s ease-in-out infinite;
}
@keyframes speak-wait {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
@media (prefers-reduced-motion: reduce) {
  .speak-btn.busy {
    animation: none;
  }
}
/* 触屏没有 hover:常驻,但压暗一档,免得名单看起来很吵。
   可点区域同时抬回 40px —— 那一档是手指在按,不是鼠标在指。
   **底色也一并收掉**:那层底是"悬停把它浮出来"这件事的一半,而对触屏来说
   它从来没有"浮出来"的那一刻,常驻的底就只剩"每条消息下面挂一块牌子"
   (一屏五块,见改动前的截图)。收掉之后回到一排安静的图标,散不散由间距承担。
   border 只把颜色收掉、宽度留着 —— 免得两种输入的图标位置差一个像素 */
@media (hover: none) {
  .chat {
    --ops-btn: 40px;
    --ops-gap: 4px;
    --ops-pad: 4px;
  }
  .msg-ops {
    opacity: 0.5;
    /* 底不是收干净,而是降到站内已有的"抬起来"那一档(--bg-elev,输入框、
       角色气泡都用它)。光秃秃的图标在触屏上会散成两枚飘着的字形 ——
       常驻的东西得看得出是一组 */
    border-color: transparent;
    background: var(--bg-elev);
    box-shadow: none;
  }
  /* 沉浸页是这条的唯一例外:那一页的底是一张照片,没有底就没有对比度
     (与上面 .bubble 的 text-shadow 是同一件事 —— 图标没有字可以描边) */
  .chat.is-immersive .msg-ops {
    border-color: var(--line);
    background: var(--surface);
    box-shadow: var(--sh-sm);
  }
}
.bubble {
  /* 76% 是阅读上限,而**外侧还得给那枚药丸让出一条走道** —— 两条一起算。
     从前只有 76%:气泡一放宽(窄屏那一档是 88%)药丸就没了立足之地,
     整排被 .chat-stream 的滚动容器裁掉,末尾那两枚点都点不到。
     走道按"三枚的最大档"算,所以鼠标与触屏两种尺寸都够(见 --ops-lane)。
     min() 只在真挤的时候才咬:1440 的桌面上 76% 本来就比走道宽,
     气泡宽度一个像素都不动 */
  max-width: min(76%, calc(100% - var(--ops-lane)));
  /* 保留换行:角色可能分句写,压成一行就不是它写的样子了 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 9px 13px;
  border-radius: var(--r);
  font-size: var(--fs-base);
  line-height: 1.55;
  color: var(--text);
}
/* 角色那一侧:坐在站内已有的"抬起来"的底色上(输入框、标签都是它),
   不额外造一个色。靠说话人那一侧的角收窄,气泡才有"从这个人嘴里出来"的方向感 */
.msg.assistant .bubble {
  /* 底与边一起给,缺一样都读不出这个块:
     - --bubble-bg 比面板再抬一档(见 style.css 那个 token 的说明);
     - 一圈极淡的边用站内既有的 --line —— 卡片、面板、分隔线本来就是这套
       "分界"语言,不新造颜色。它是**常驻**的(不像聚焦态那样一会儿加一会儿去),
       所以里面那行字不会挪 */
  background: var(--bubble-bg);
  border: 1px solid var(--line);
  border-bottom-left-radius: var(--r-sm);
}
/* 自己那一侧:用站内的主动色 —— 与发送键、Primary 按钮同一个 --cta。
   两侧都铺灰底是行不通的:这套调色板里几档灰差得太近,分不出谁是谁,
   而"谁说的"恰恰是对话里最不能含糊的一件事 */
.msg.user .bubble {
  background: var(--cta);
  color: var(--cta-text);
  border-bottom-right-radius: var(--r-sm);
}
/* 撞上长度上限的提示。压在气泡下面、跟气泡同一边 ——
   它说的是这一条消息,不是整段对话 */
.cut {
  margin: 3px 0 0;
  font-size: var(--fs-micro);
  color: var(--text-3);
}
/* ===== 记忆卡片 =====
   它是"关于这段对话"的一段派生文本,不是一条消息 —— 所以它不排在消息流里,
   而是从头部挂下来的一张卡片。位置固定,与对话多长无关 */
.mem-card {
  position: absolute;
  /* 挂在头部下沿。头部自己量高度,卡片跟着走 ——
     写死像素的话,窄屏名字换行时它会盖住第一条消息 */
  top: calc(100% + 6px);
  right: var(--sp-4);
  z-index: 30;
  width: min(420px, calc(100% - var(--sp-4) * 2));
  max-height: min(60vh, 460px);
  overflow-y: auto;
  padding: var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
  box-shadow: var(--sh-md);
  /* 入场很轻(6px + 淡入):它挂在一个点下去的位置上,动得太远会像弹窗;
     而完全不动又会让"卡片出现了"这件事被漏掉 */
  animation: mem-card-in 160ms var(--ease) both;
}
@keyframes mem-card-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mem-card {
    animation: none;
  }
}
.mem-card:focus {
  outline: none;
}
.mem-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: var(--sp-2);
  color: var(--text-3);
  font-size: var(--fs-micro);
}
.mem-card-head > svg {
  font-size: 14px;
}
.mem-card-title {
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
}
.mem-card-when {
  color: var(--text-3);
  text-transform: none;
  letter-spacing: 0;
}
.mem-x {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  margin-left: auto;
  margin-right: -6px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.mem-x:hover {
  background: var(--accent-soft);
  color: var(--text-2);
}
.mem-text {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* 这一句回答的是"这是什么、改了会怎样"。记忆是有损的,不写清来处,
   用户看到一段陌生的小传只会更困惑。
   用 --text-2 而不是更淡的那两档:它是**要读的一句话**,不是装饰 ——
   --text-4 在白底上只有约 1.9:1,那是禁用档 */
.mem-note {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-micro);
  line-height: 1.55;
  color: var(--text-2);
}
/* 编辑态:卡片里就地换成一只可写的框,不另起浮层 */
.mem-input {
  display: block;
  width: 100%;
  padding: 9px 11px;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm);
  line-height: 1.6;
  /* 只放纵向:横向拉伸会顶破这张卡片 */
  resize: vertical;
  transition: box-shadow var(--dur) var(--ease);
}
.mem-input:focus {
  outline: none;
  box-shadow: 0 0 0 1px var(--line-strong);
}
/* 超长只在按下保存的那一刻拦。就贴在按钮上方 ——
   眼睛从框里出来,先撞到的是它 */
.mem-warn {
  margin: 6px 0 0;
  font-size: var(--fs-xs);
  color: var(--danger);
}
/* 动作行。左右留 2px 是补出来的:里头那两枚键各自有 10px 内边距,
   2 + 10 正好让按钮上的字与上面的正文对齐在同一条竖线上 */
.mem-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1);
  margin-top: var(--sp-2);
  padding: 0 2px;
}
/* 保存是这段编辑里唯一的主操作,给它实心。高度与 quiet-btn 齐平,
   两枚并排时下沿在同一条线上 */
.save-btn {
  min-height: 40px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-xs);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.save-btn:hover:not(:disabled) {
  background: var(--cta-hover);
}
/* 与发送键同一条规矩:不可用时用同族淡底,不用半透明黑(叠色会发脏) */
.save-btn:disabled {
  background: var(--accent-soft);
  color: var(--text-4);
  cursor: default;
}
/* 往前翻的入口。同样做成一条细字:它是一次翻页,不是一个动作按钮 */
.earlier {
  display: flex;
  justify-content: center;
  margin-bottom: var(--sp-2);
}
.earlier-btn {
  min-height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-3);
  font-size: var(--fs-xs);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.earlier-btn:hover {
  background: var(--accent-soft);
  color: var(--text);
}
/* 流式光标:用 CSS 画,不用图片/GIF(与设定图生成中的停止符号同一手法) */
.cursor {
  display: inline-block;
  width: 7px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  border-radius: 2px;
  background: var(--text-3);
  animation: cursor-breathe 1.1s ease-in-out infinite;
}
@keyframes cursor-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cursor {
    animation: none;
  }
}
/* 重新生成是这一页最次要的动作 —— 它不该和对话争视线。
   平时它挂在末尾那条消息的悬停动作里(见 .regen-btn);只有末尾那条
   **没有气泡可挂**时才退回这里(自己站一行)。
   长相跟那一排一致:同一枚药丸,只是里面只有一枚按钮 —— 同一个动作
   在两处有两种长相,用户就得重新认一次 */
.regen {
  display: flex;
  /* 一步都不多占:它是这一行里唯一的东西 */
  align-self: flex-start;
  margin-top: var(--sp-1);
  padding: var(--ops-pad);
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  box-shadow: var(--sh-sm);
}
/* 要重来的那条是**用户**说的(靠右)——它也跟着靠右,落在那张图下面,
   而不是站在面板另一边 */
.regen.is-user {
  align-self: flex-end;
}
/* "最次要的动作"的统一长相:无底无边的一行细字,悬停才浮出淡底。
   "改记忆"用它 —— 它也是"这一页顺带能做的事",做成按钮会和对话本身抢视线。
   可点高度仍留 40px:眼睛不被打断,手指按得着。
   (重新生成原本也用它,2026-10-05 起改成与"念 / 删"同形的图标键,见 .regen-btn) */
.quiet-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 40px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-3);
  font-size: var(--fs-xs);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.quiet-btn:hover {
  background: var(--accent-soft);
  color: var(--text-2);
}
.quiet-btn svg {
  font-size: 13px;
}
/* 破坏性的那一枚:平时与别的次要动作长得一模一样,只有手指真的悬上去
   才染成危险色 —— 它不该在静止时和"改一改"争同等分量。
   底色用与 --danger 同族的淡底(见 .compose-warn),不用半透明红 */
.quiet-btn.danger:hover {
  background: color-mix(in oklch, var(--danger) 8%, transparent);
  color: var(--danger);
}

/* ===== 输入区 ===== */
.chat-compose {
  flex: none;
  /* 给下面那枚"回到最新"当定位参照 —— 它挂在 bottom: 100% 上,
     也就是正好压在输入区的上沿 */
  position: relative;
  /* 底部留得比别处多:输入框是一张浮起来的卡片,投影要有地方落下去 */
  padding: var(--sp-3) var(--sp-4) var(--sp-5);
  /* 这里刻意没有分隔线 —— 卡片的边界由它自己的投影给出,
     再加一条通栏的横线就是两套边界在打架 */
}
/* 回到最新。用户往上翻的时候,底下长出来的东西他看不见 ——
   自动跟随刻意不拽他(见 .chat-stream 的 onUpdated),
   那就得给一个回去的入口,否则只能自己一路滚到底 */
.jump {
  position: absolute;
  left: 0;
  right: 0;
  /* 100% = 输入区的上沿。输入区高矮会变(超长警告、没配模型那块),
     贴在这里就不必跟着改 */
  bottom: 100%;
  display: flex;
  justify-content: center;
  padding-bottom: 10px;
  /* 只让按钮自己接收点击:这一层横跨整宽,接着会把下面的消息挡住 */
  pointer-events: none;
  z-index: 3;
}
.jump-btn {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  /* 与输入框那张卡片同一套做法:淡底 + 一圈极淡的边 + 一层弥散影。
     影用 --sh-sm 而不是 --sh-md —— 后者是给大块悬浮组件的
     (20px 偏移 + 60px 模糊),套在一个 32px 的药丸上会糊成一团 */
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-elev);
  box-shadow: var(--sh-sm);
  color: var(--text-2);
  font: inherit;
  font-size: var(--fs-xs);
  font-weight: 600;
  cursor: pointer;
  transition: color 160ms var(--ease), background 160ms var(--ease);
}
.jump-btn svg {
  width: 14px;
  height: 14px;
}
.jump-btn:hover {
  color: var(--text-1);
  background: var(--surface-hover);
}
/* —— 附图 —— */
/* 待发的那张。压在输入框上面,宽度收到图片本身那么大 ——
   这么定是为了让右上角那枚取消键有地方可贴 */
.attach {
  position: relative;
  display: inline-block;
  margin-bottom: var(--sp-2);
}
.attach img {
  display: block;
  max-width: 132px;
  max-height: 132px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  object-fit: cover;
}
/* 取消。给一块深色玻璃底:图什么颜色都可能,只在图上描一圈边的话,
   压在浅色区域上就看不见了 */
.attach-x {
  position: absolute;
  top: 6px;
  right: 6px;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 50%;
  background: rgba(16, 16, 18, 0.72);
  color: #fff;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.attach-x:hover {
  background: rgba(16, 16, 18, 0.9);
}
.attach-x svg {
  width: 13px;
  height: 13px;
}
/* 附图键。与发送键同高同圆,但不涂实心 —— 同一个格子里它是次操作,
   涂黑的那一枚永远留给"把这句话发出去" */
.img-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.img-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--bg-elev);
}
.img-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.img-btn svg {
  width: 19px;
  height: 19px;
}
/* 气泡里的图。圆角比气泡小一档,压在文字上方 */
/* 消息里的图**不放进气泡**:文字有文字的框,图有图的位置。
   整条 .msg 本来就是竖排 flex(user 靠右 / assistant 靠左),
   所以图只要当兄弟节点,就自动落在正确的一边。
   宽度跟着 .bubble 的 76% 走,免得图比气泡还宽、把节奏拉开 */
/* 消息里的一张小图(用户附的那张、角色发来的那张),外面都包一层按钮:
   鼠标点得开、键盘也点得开 —— 那是可访问的写法。按钮只做容器,
   不留自己的框线,看起来仍是一张图。

   **尺寸约束一律挂在按钮这一层,不能挂在 img 上。**
   挂在 img 上的话,那个 76% 是相对包着它的按钮算的,而按钮的宽度又是由
   这张图的**自然宽度**撑出来的 —— 于是宽度变成"自然宽度的 76%"(既不是
   想要的尺寸,小图还会被压小),而且图贴在按钮左边:按钮整体靠右、图却偏左,
   看起来就是"上传的图片没有右对齐"。 */
.msg-img-btn {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  cursor: zoom-in;
}
/* 用户那一侧:靠右。高度那一档(max-height)生效时按钮会比图宽,
   这时把图推到按钮右缘,图与气泡就仍然贴同一条右边线 */
.msg.user .msg-img-btn {
  display: flex;
  justify-content: flex-end;
  /* 靠右不依赖父级的 align-items:自己的边自己定 */
  align-self: flex-end;
  max-width: 76%;
  /* 手型只给图本身(见 .msg-img):按钮可能比图宽出一截,
     那一截空白不该显示"可点开"的手型 */
  cursor: default;
}
/* 角色那一侧:宽度上限与它的气泡同一档(320px 封顶)。放在按钮上同样是
   为了避开上面那条"百分比对着自己算"的回路 —— 否则一张小图会被压到 76% */
.msg.assistant .msg-img-btn {
  max-width: min(320px, 76%);
}

/* 角色那张图外面多了一层:重画那一枚要有定位的锚,暗幕也要正好盖在图上。
   **这一层的宽度由内容决定**(fit-content)—— 不能只给一个上限:上限是 320,
   而竖图封顶后只有 240 宽,只给上限这一层就会宽出 80px,暗幕盖到图外面的空白上。

   而"内容"要真的是那张图:所以按钮上那条百分比上限**必须在这里被撤掉** ——
   它是对着包含块算的,留着它按钮就会撑到上限,这一层跟着撑到上限,
   图却还是它自己那么宽(实测:暗幕 240、图 182,差 58px)。
   撤掉之后两种情形都对得上:图比上限小 → 这一层收到图那么宽;
   图比上限大 → 两个都撞同一个上限。 */
.msg-photo-wrap {
  position: relative;
  width: fit-content;
  max-width: min(320px, 76%);
  /* 与气泡之间那道 8px 挪到这一层上。留图自己身上的话,它会落在这一层的**里面**
     (这一层是 flex 项,自成 BFC,外边距不折叠)—— 于是暗幕比图高 8px,
     上沿多压出 8px 的空白。挪出来之后这一层的盒子就等于图,逐边相等 */
  margin-top: 8px;
}
.msg.assistant .msg-photo-wrap .msg-img-btn {
  max-width: none;
}
.msg-photo-wrap .msg-photo {
  margin-top: 0;
}
/* 正在重画:一层暗幕压住旧图 + 中间一枚呼吸的圆环。
   与设定图那一格同一套语言(那一格也踩过同一个坑:"重跑一张已有的图时
   格子里毫无变化,看不出在跑")。圆环呼吸做在 box-shadow 上 ——
   按钮本身保持清晰,动的只是外圈 */
.photo-busy {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: rgba(24, 24, 22, 0.5);
  /* 不吃点击:暗幕底下那张图仍然点得开放大 */
  pointer-events: none;
}
.photo-busy-ring {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(252, 251, 249, 0.22);
  animation: photoBusy 1.6s var(--ease) infinite;
}
@keyframes photoBusy {
  50% {
    box-shadow: 0 0 0 7px rgba(252, 251, 249, 0.1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .photo-busy-ring {
    animation: none;
  }
}
/* 再摇一张。**平时不出现**(悬停或键盘聚焦才浮出来,与消息那排动作同一规矩),
   形状与底沿用那枚药丸的语言 —— 同一页里两种控件长相,用户就得重新认一次 */
.photo-redraw {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: grid;
  place-items: center;
  width: var(--ops-btn);
  height: var(--ops-btn);
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-3);
  box-shadow: var(--sh-sm);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.msg:hover .photo-redraw,
.msg:focus-within .photo-redraw {
  opacity: 1;
}
.photo-redraw:hover {
  background: var(--accent-soft);
  color: var(--text);
}
/* 触屏没有悬停:常驻一份淡的(与消息那排动作同一条),否则重画就没有入口 */
@media (hover: none) {
  .photo-redraw {
    opacity: 0.5;
  }
}
.msg-img,
.msg-photo {
  display: block;
  /* 宽度交给按钮:它已经被夹住了,这里只负责"填满它"与保住比例 */
  max-width: 100%;
  max-height: 320px;
  width: auto;
  height: auto;
}
.msg-img {
  margin-bottom: 8px;
  border-radius: 12px;
  object-fit: cover;
  cursor: zoom-in;
}

/* 角色发来的那张:占满气泡宽度、垫在文字下方。骨架用同一个方块比例 ——
   图是异步到的,比例写死才不会在它到达时把整段对话顶下去 */
.zoom {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4vmin;
  background: rgb(0 0 0 / 72%);
  backdrop-filter: blur(2px);
}
.zoom img {
  max-width: 100%;
  max-height: 100%;
  border-radius: 12px;
  box-shadow: 0 18px 60px rgb(0 0 0 / 45%);
  cursor: default;
}
.zoom-x {
  position: absolute;
  top: 18px;
  right: 18px;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 50%;
  color: #fff;
  background: rgb(255 255 255 / 14%);
  cursor: pointer;
}
.zoom-x:hover {
  background: rgb(255 255 255 / 24%);
}
/* 角色的那张:**比例跟着图自己走**。原来这里写死 1:1 再用 object-fit: cover
   裁,等于把一张横构图切成方的 —— 生成时明明是 auto(交给上游定),
   到显示这一步又被拽回正方形,白拿一个能用的比例。
   宽高的上限在按钮那一层(见 .msg.assistant .msg-img-btn),这里只管填满 */
.msg-photo {
  margin-top: 8px;
  border-radius: 12px;
}
.msg-photo-skel {
  /* 图还没回来时占个位。**比例只能猜一个中性的** —— 真正的比例要等图到了
     才知道(auto 的代价就是这个);4:3 比 1:1 更像模型常见的构图 */
  width: 224px;
  max-width: 76%;
  aspect-ratio: 4 / 3;
  background: linear-gradient(100deg, var(--skel-a, #e9e9ee) 30%, var(--skel-b, #f5f5f8) 50%, var(--skel-a, #e9e9ee) 70%);
  background-size: 200% 100%;
  animation: skel-shimmer 1.4s linear infinite;
}
@keyframes skel-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
/* 那一张没画出来。做成一行安静的小字 + 一枚细字重试键 ——
   它是"这一条消息的附注",不该和角色说的话争视线(与 .cut 同一分寸)。
   整排靠左:它说的是助手那条消息,与角色那一侧的气泡同一条边 */
.photo-fail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  /* 触控目标 ≥40px:这一行本身只是提示,撑高的是里面那枚键 */
  min-height: 40px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.photo-fail > svg {
  font-size: 14px;
}
/* 原因那一格。**必须能截断也能换行** —— 上游的原话可能很长
   (「Upstream returned an error (401): invalid api key」这种),
   而它旁边还挤着一枚重试键:
   `min-width: 0` 让它在窄屏上肯缩(柔性子项默认不肯缩到内容以下),
   两行截断兜住超长的,完整的那份在 `title` 里 */
.photo-fail > span {
  flex: 1 1 12ch;
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow-wrap: anywhere;
}
/* 重试是这一行里唯一可点的东西,给它一枚极淡的圆角底(与 .jump-btn 同一语言),
   免得一行小字里的按钮既看不出来也按不着 */
.photo-retry {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-2);
  font: inherit;
  font-size: var(--fs-xs);
  font-weight: 600;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.photo-retry:hover {
  border-color: var(--line-strong);
  color: var(--text);
  background: var(--surface-hover);
}
.photo-retry svg {
  font-size: 13px;
}

.compose-box {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
  width: 100%;
  /* 横向左右都是 12px:左边给文字留呼吸,右边给发送键留同样一档 ——
     两边不一样宽,一条铺满全宽的卡片会把那点偏差放大成"歪"。
     纵向 6px:卡里只有一行字,而发送键自己有 40px,
     再厚的上下留白只是把卡片撑高 */
  padding: 6px 12px;
  border: 0;
  /* 圆角用 --r(16px),不用 --r-lg(24px):后者是给 Studio 那个"有厚度的
     提示词编辑器"定的。这张卡片铺满整块面板又只有一行高,
     24px 会让两端看起来各是半个圆 —— 整块变成一根横贯全宽的胶囊。
     16px 与气泡同档,两者才像同一套东西 */
  border-radius: var(--r);
  background: var(--surface);
  /* 悬浮卡片:白底 + 一圈极淡的边 + 一层弥散影。
     边用 box-shadow 补而不是 border —— border 会让里面整行文字在切换时挪一下 */
  box-shadow: 0 0 0 1px var(--line), var(--sh-sm);
  transition: box-shadow var(--dur) var(--ease);
}
.compose-box:hover {
  box-shadow: 0 0 0 1px var(--line), var(--sh-md);
}
/* 聚焦时把卡片再抬高一档:焦点本来就该看得出来 */
.compose-box:focus-within,
.compose-box:focus-within:hover {
  box-shadow: 0 0 0 1px var(--line-strong), var(--sh-md);
}
.compose-box textarea {
  flex: 1;
  min-width: 0;
  max-height: 132px;
  /* 单行时的高度 = 22(行高) + 18(上下内边距) = 40,与发送键一模一样高,
     两者的中线才对得齐 */
  padding: 9px 0;
  border: 0;
  background: none;
  color: var(--text);
  font-family: inherit;
  /* 与气泡里的正文同号:自己打的字和它说的话一样大。
     16px 那一档留给窄屏 —— 见下面媒体查询里的说明 */
  font-size: var(--fs-base);
  line-height: 22px;
  resize: none;
  overflow-y: auto;
}
.compose-box textarea:focus {
  outline: none;
}
.compose-box textarea::placeholder {
  color: var(--text-3);
  transition: color var(--dur) var(--ease);
}
/* 一进来就把提示语提亮一档:它是"这里可以说话"的唯一提示 */
.compose-box:focus-within textarea::placeholder {
  color: var(--text-3);
}
.send-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  cursor: pointer;
  transition: background var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.send-btn:hover:not(:disabled) {
  background: var(--cta-hover);
}
/* 不可用时不给"半透明的黑":叠色之后会发脏,而且那一枚仍然像个实心按钮。
   换成与浅底同族的淡底 —— 它是"还没到能发的时候",不是"坏掉了" */
.send-btn:disabled {
  background: var(--accent-soft);
  color: var(--text-4);
  cursor: default;
}
.send-btn svg {
  font-size: 18px;
}
/* 停止符号也用 CSS 画(与光标同一条理由) */
.stop-sq {
  width: 11px;
  height: 11px;
  border-radius: 2px;
  background: currentColor;
}
/* 超长的提示。它顶掉的是输入卡片的位置,所以样式也做成"卡片那一格"
   —— 高度与卡片一致,底下的投影空间不动,切换时页面不跳 */
.compose-warn {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 52px;
  margin: 0;
  padding: 0 12px;
  border-radius: var(--r);
  background: color-mix(in oklch, var(--danger) 8%, transparent);
  color: var(--danger);
  font-size: var(--fs-sm);
}
.compose-off {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 6px;
  font-size: var(--fs-sm);
  color: var(--text-3);
}
.compose-off svg {
  font-size: 16px;
}

/* ===== 空态 ===== */
.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-6);
  text-align: center;
}
.chat-empty.is-inside {
  /* 父级(.chat-stream)是纵向 flex,flex:1 就能撑满整格并居中 */
  flex: 1;
}
.empty-ava {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  overflow: hidden;
  margin-bottom: var(--sp-2);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-3);
}
.empty-ava img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.empty-ava svg {
  font-size: 28px;
}
.empty-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text);
}
.empty-sub {
  margin: 0;
  max-width: 44ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-3);
}

.ed-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  margin-top: var(--sp-2);
  min-height: 40px;
  padding: 9px 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: 500;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.ed-btn:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
.ed-btn.primary {
  border-color: var(--cta);
  background: var(--cta);
  color: var(--cta-text);
}
.ed-btn.primary:hover {
  border-color: var(--cta-hover);
  background: var(--cta-hover);
}

/* ===== 窄屏的角色浮层 ===== */
.picker {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: var(--sp-4);
  /* 与设定图查看器同一套:固定深色 + 模糊,与主题无关 */
  background: rgba(16, 16, 18, 0.86);
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
}
.picker-box {
  width: min(420px, 100%);
  max-height: 70vh;
  overflow-y: auto;
  padding: var(--sp-3);
  border-radius: var(--r);
  background: var(--surface);
}
/* 浮层本身只是个容器(焦点先落在这里,好让读屏念出"这是什么"),
   围着它画一圈焦点框是噪声 —— 下一次 Tab 就进到条目上了 */
.picker-box:focus {
  outline: none;
}

/* ===== 窄屏 ===== */
@media (max-width: 860px) {
  /* 手机上把这一排的触控目标抬到 40px —— 站内对触屏的底线
     (见 App.vue 里 .param-btn / .clear-icon 那几条)。桌面维持原尺寸:
     那边有鼠标,把它撑大只会让版面变松 */
  .head-pick {
    min-height: 40px;
  }

  .chat {
    /* 左栏收起,只剩一列。高度算式与桌面同一条,不另写 ——
       多减一次反而会把面板压短,底下空出一条 */
    grid-template-columns: minmax(0, 1fr);
  }
  .chat-rail {
    display: none;
  }
  .head-solo {
    display: none;
  }
  .head-pick {
    display: inline-flex;
  }
  .chat-stream {
    padding: var(--sp-4) var(--sp-3) var(--sp-3);
  }
  .chat-compose {
    padding: var(--sp-3) var(--sp-3) var(--sp-5);
    /* iPhone 底部横条:不加这一段,输入框会被那条横条压住 */
    padding-bottom: calc(var(--sp-5) + env(safe-area-inset-bottom));
  }
  /* 窄屏下 76% 太窄,读起来一直在换行 */
  .bubble {
    max-width: 88%;
  }
  /* 88% 一放开,外侧只剩 12% —— 药丸挂不下了(三枚要 120px,那条缝只有 40px)。
     于是它改挂到气泡**下面**:横向不够就往下走,高度由气泡让出来。
     不压字、不出面板,也不会在悬停那一刻把下面的东西顶走(高度是常备的)。
     占高度而不占宽度是这两种代价里更小的一份:390 的屏上真要留出走道的话,
     气泡只剩 196px,比上面那句"76% 太窄"否掉的一档还窄 */
  .msg.has-ops .bubble {
    margin-bottom: calc(var(--ops-rail) + var(--sp-1));
  }
  .msg.assistant .msg-ops {
    left: auto;
    right: 0;
    top: 100%;
    bottom: auto;
    margin: var(--sp-1) 0 0;
  }
  .msg.user .msg-ops {
    left: 0;
    right: auto;
    top: 100%;
    bottom: auto;
    margin: var(--sp-1) 0 0;
  }
  /* 窄屏才把输入框字号提回 16px:低于这个值 iOS Safari 聚焦时会放大整页
     (站内硬约束,见 style.css 的 --fs-lg)。桌面没有这个问题,
     所以那一档只在需要它的地方出现。
     (左栏搜索框同样受这条约束 —— 它随左栏收进了 ChatRail,那一档在那边) */
  .compose-box textarea {
    font-size: var(--fs-lg);
  }
}
/* ===== 沉浸态的覆盖层 =====
   放在**整个样式表的最后**是有意的:这一层几乎全是"把上面某条规则改掉",
   而 CSS 里同等特异度比的是先后 —— 放在前面会被后面的基础规则反压回去
   (第一版就是这么错的:气泡的底色照旧从 `.msg.assistant .bubble` 漏了出来,
   屏幕上每句台词都还顶着一块浅灰方块) */
/* ===== 沉浸态 =====
   这一段的每一条都在做同一件事:**把工具那一层收走,把画面还给角色**
   (见 doc/沉浸式对话页面设计.md)。判据只有一条 —— 屏幕上每一样东西,
   是在服务这段话,还是在服务"这个软件的功能" */
.chat.is-immersive {
  /* 沉浸页的阅读列宽。**普通页刻意不收窄**(见 .chat-inner 那段注释),
     这里收窄是因为前提变了:那两侧不再是面板里的留白,而是角色的画面 */
  --immersive-col: 660px;
}
/* 面板的框去掉:对话该浮在场景上,而不是装在一个框里 */
.chat.is-immersive .chat-main {
  border: 0;
  background: none;
}
/* 输入区收在中间(参考图里那条胶囊就是居中的) */
.chat.is-immersive .chat-head,
.chat.is-immersive .chat-compose > * {
  width: 100%;
  max-width: var(--immersive-col);
  margin-inline: auto;
}
/* **正文靠左**,不居中:参考图里字在左、人在右 —— 那个不对称就是它的构图。
   居中一列会把画面切成两半,右边那一半的人就没了位置 */
.chat.is-immersive .chat-inner,
.chat.is-immersive .chat-empty.is-inside {
  width: 100%;
  max-width: var(--immersive-col);
  margin-inline: 0 auto;
  padding-left: clamp(16px, 7vw, 96px);
}
/* 工具层收走:模型/记忆药丸、可点的换人入口。
   **留着的两样**:
   - 进出沉浸那枚按钮 —— 它是出口,而藏起出口的全屏模式是把用户关在里面;
   - **⋮ 菜单** —— 参考图右上角那枚就是它,而且"重画这一场的背景"没有别处可去。
     (第一版把它一起藏了,于是那条入口永远点不到 —— 用户报"没有换背景的按钮啊") */
.chat.is-immersive .head-chip,
.chat.is-immersive .head-pick {
  display: none;
}
/* 身份照旧显示,变成不可点的那一份(head-solo 的 DOM 本来就在,宽屏用的就是它) */
.chat.is-immersive .head-solo {
  display: flex;
}
/* 头部那条分隔线也去掉:它属于"面板"那套边界 */
.chat.is-immersive .chat-head {
  border-bottom-color: transparent;
}

/* ===== 剧本那套:两个声音,没有气泡 =====
   参考的是"一页剧本压在剧照上"那种排法(见 doc/沉浸式对话页面设计.md §3.3):
   谁说的**不由左右和底色表达**,由**字体音区**表达 ——
   角色:大、亮、衬线;你:小、暗、同一个衬线族。
   两者都不是气泡:没有底色、没有圆角、没有内边距,直接躺在画面/背景上。 */
.chat.is-immersive .bubble {
  max-width: 100%;
  padding: 0;
  /* **底与边都要收**:上面 `.msg.assistant .bubble` 是"底 + 一圈极淡的边"一起给的,
     只收底色会留下一圈把每句台词框住的细线(也是靠截图才看出来的) */
  border: 0;
  border-radius: 0;
  background: none;
  font-family: var(--font-serif);
  /* 叠一层很轻的投影兜可读性:背景是一张照片,而照片的明暗不可控
     (与设计稿 §4 那条"对比度是硬约束"是同一件事,这是它在这里的落法) */
  text-shadow: 0 1px 12px color-mix(in srgb, var(--bg) 55%, transparent);
}
.chat.is-immersive .msg {
  align-items: flex-start;
}
/* 动作药丸在沉浸页**也不能挂在气泡外侧**:这一页的气泡放到了 100%(字是整列的),
   挂外侧就掉到字列右边、压在剧照上;自己那条更糟 —— right: 100% 会把它甩到
   字列左边,窄屏上直接出屏(点不到,也看不见)。
   所以这里与窄屏同一条规矩:挂到气泡下面,高度由气泡让出来。
   药丸自带的底兜住了对比度 —— 这一页的背景是一张明暗不可控的照片
   (与上面那条 text-shadow 是同一件事,只是图标没有字可以描边) */
.chat.is-immersive .msg.has-ops .bubble {
  margin-bottom: calc(var(--ops-rail) + var(--sp-1));
}
.chat.is-immersive .msg-ops {
  left: auto;
  right: 0;
  top: 100%;
  bottom: auto;
  margin: var(--sp-1) 0 0;
}
.chat.is-immersive .msg.assistant .bubble {
  font-size: var(--fs-xl);
  line-height: 1.5;
  color: var(--text);
}
.chat.is-immersive .msg.user .bubble {
  font-size: var(--fs-md);
  line-height: 1.45;
  color: var(--text-2);
}
/* 行距放开:这是一段话,不是一串消息 */
.chat.is-immersive .chat-inner {
  gap: var(--sp-3);
}
/* 逐条的时间分隔在沉浸态收掉 —— 头顶那行已经有"场景 · 时间"了。
   **只留末尾那条"离开多久了"**:它答的是"我们上次说话是多久以前",
   而那正是回到这一页时最需要的一句话(见 T6.3) */
.chat.is-immersive .chat-stream .sep:not(.away) {
  display: none;
}
/* 顶上渐隐:越旧越淡 —— 一页剧本不该有一条能滚到底的消息流。
   用 mask 而不是给每条算透明度:它不碰 DOM,滚动时也不重排 */
.chat.is-immersive .chat-stream {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 56px);
  mask-image: linear-gradient(to bottom, transparent 0, #000 56px);
}

/* ===== 头部:居中一行名字 + 一行场景 ===== */
.chat.is-immersive .chat-head {
  justify-content: center;
  padding-top: var(--sp-4);
}
/* 头像是多余的:那张脸就是整块背景 */
.chat.is-immersive .head-ava {
  display: none;
}
.chat.is-immersive .head-text {
  align-items: center;
  text-align: center;
}
.chat.is-immersive .head-name {
  font-size: var(--fs-lg);
  letter-spacing: 0.01em;
}
.chat.is-immersive .head-scene {
  max-width: min(52ch, 62vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
  font-size: var(--fs-xs);
}
/* 出口(收起)钉在右上角:参考图里那个位置放的是 ⋯,也就是"这一页怎么用" */
.chat.is-immersive .head-acts {
  position: absolute;
  top: var(--sp-3);
  right: var(--sp-2);
}
/* 沉浸态里的图**都收小**:正文是一页剧本,图是"它给你看过的东西",
   不该有一块比台词还大的色块横在那儿(参考图那一屏正文里根本没有图块)。
   上限给得克制:看一眼认得出来即可,想细看点开还是大图 */
.chat.is-immersive .msg-img-btn,
.chat.is-immersive .msg.assistant .msg-img-btn {
  max-width: min(150px, 24%);
}
.chat.is-immersive .msg-img,
.chat.is-immersive .msg-photo {
  max-height: 120px;
}
/* 输入区收成一条宽胶囊(参考图里就是一整条半透明胶囊)。
   圆角用 999 而不是 --r:这一条比别处的卡片更长更扁,
   16px 会让两端看起来还是"卡片",而这里要的是一根管 */
.chat.is-immersive .compose-box {
  border-radius: 999px;
  padding-left: var(--sp-4);
  padding-right: 6px;
}
.chat.is-immersive .compose-box textarea {
  font-family: var(--font-serif);
}

/* 背景层。z-index 0 + 上面那两层网格子项各自 z-index 1(见下),
   不用负 z-index:负值会跑到 body 背景之下,效果随浏览器的绘制顺序而变 */
.chat-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  /* 它只是背景:绝不能接走指针事件(消息流在它上面要能滚、能点) */
  pointer-events: none;
  /* —— 让位的力道收在**一个旋钮**上 ——
     这一层到今天已经调过四轮(见设计稿 §4),每一轮都在两条渐变里改六个数;
     而"白不白"与"字读不读得出来"本来就是同一个数的两端,拆成六个数只会
     每次都得重新配平。现在形状定死在下面,轻重只动这一个。
     用户 2026-10-05 的原话:"只是感觉蒙了一层白白的" */
  --veil: .78;
  /* 白压到哪为止:**跟着文本那一栏走,不跟着视口走**。
     视口百分比在宽屏上会把白糊到人身上,在 900px 那种窗口上又盖不住行尾 ——
     而"字占多宽"是算得出来的:shell 的内边距 + 栏宽(见 App.vue 的 .shell-wide
     与这里的 --immersive-col)。
     后半截那个 50vw 是给**超宽屏**留的:那里 shell 会居中,文本整体右移,
     而居中量恰好不超过半屏 —— 于是两者取大,一次覆盖两种情形。
     再往右留 150px 过渡,让人物那一侧干干净净地透出来 */
  --veil-w: max(calc(var(--sp-4, 16px) + var(--immersive-col, 660px)), 50vw);
}
.chat-bg img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* 裁切时偏向右边取景:这一页的构图是"字在左、人在右",
     而图比容器宽时(横图常见)取哪一块由它决定 */
  object-position: 68% center;
  transform: scale(1.02);
  /* **一点模糊都不加**(2026-10-05,用户报"很模糊")。
     那 2px 是第一版"大虚化"退下来的残余:当时基础是 blur(34px),留 2px
     是为了把"借来的剧照"垫软一点。而背景图现在是**为这一页专门生成的**,
     构图与景深都写在提示词里 —— 再垫一层只是把细节抹掉,可读性一点没多
     (让位归下面那层蒙版)。
     顺带说清"糊"的真正来源,免得下一次又怪到这一层:**是放大**。
     生成出来的是 1.5～2M 像素,而要铺满的是一块 2 倍屏(约 4M 设备像素),
     浏览器把它拉了 1.5～1.8 倍 —— 这个只有"向上游要更大的一档"能补,
     CSS 补不了(见 useGeneration 的 generateChatBackdrop) */
  filter: saturate(1.04);
  opacity: 1;
}
/* 退回到**人像**(首图/底图)时,那张是竖构图、人脸在正中的证件照式画面 ——
   铺满屏幕会是一张大脸怼在中间,而左边那道蒙版正好压在人身上。
   把它整张往右推、并放大一档(放大是为了不露出左边缘的空当)。
   专用背景图与剧照不走这一条:它们本来就按"人在右"构的图 */
.chat-bg.is-face img {
  transform: translateX(13%) scale(1.24);
  object-position: 50% center;
}
/* 让位的那一层。**对比度是硬约束,不是审美**(设计稿 §4):
   正文压在这上面也要满足小字可读 —— 所以它不能没有。
   但"不能没有"与"给得很重"是两件事:重了就是给整张图蒙一层白
   (用户 2026-10-05:"只是感觉蒙了一层白白的")。
   现在的做法是**把白约束在字所占的那一条上**,而不是整体减淡 */
.chat-bg::after {
  content: '';
  position: absolute;
  inset: 0;
  /* 整层的轻重由 --veil 一个数管(见 .chat-bg 那段) */
  opacity: var(--veil);
  /* 横向:**白只压在字那一条上**,到文本栏右边线就开始散,再 150px 之后
     一点都不剩 —— 人物在右三分之一,那里现在是干净的。
     从前那版是视口百分比(92/68/12/0),于是宽屏上人物的位置正好落在
     12～30% 那一档白里(用户:"蒙了一层白白的")。
     纵向:上、下各一道,只给顶部那行名字与底部输入区兜底,幅度比原来收了一半 ——
     它们横跨整幅,压得重就等于给整张图蒙一层白 */
  background:
    linear-gradient(
      90deg,
      var(--bg) 0,
      color-mix(in srgb, var(--bg) 84%, transparent) calc(var(--veil-w) * 0.5),
      color-mix(in srgb, var(--bg) 36%, transparent) var(--veil-w),
      transparent calc(var(--veil-w) + 150px)
    ),
    linear-gradient(
      to bottom,
      color-mix(in srgb, var(--bg) 44%, transparent) 0,
      transparent 13%,
      transparent 87%,
      color-mix(in srgb, var(--bg) 48%, transparent) 100%
    );
}
/* 窄屏那条 `blur(22px)` 已经删掉。它写于"基础就是 blur(34px)"那一版,
   本意是"窄屏收小一档";而基础降到 2px 之后,它变成了**放大 11 倍** ——
   于是任何 ≤720px 的窗口里背景都是糊的,而那条路正是手机上唯一的路。
   留着它还会让人以为"手机上的糊是故意的" */
/* 沉浸态里那两层网格子项要压在背景之上 */
.chat.is-immersive .chat-rail,
.chat.is-immersive .chat-main {
  position: relative;
  z-index: 1;
}

/* 沉浸态:**单列**。
   注意隐藏左栏本身**不会**让上面那条 `240px` 的轨道塌掉 —— 显式的轨道宽度
   还在,右边会平白少 240px 再加一道 gap,症状是"右边窄了一截",
   很容易被当成 padding 问题。所以这一条必须显式写 */
.chat.is-immersive {
  grid-template-columns: minmax(0, 1fr);
}

</style>
