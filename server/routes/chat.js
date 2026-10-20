import {
  CONNECT_HINTS,
  PROD_LIKE,
  UPSTREAM_TIMEOUT_MS,
  assertSafeTarget,
  dispatchAttempts,
  htmlTitle,
  looksLikeHtml,
  rateLimit,
  safeFetch
} from '../core.js'
import { splitTags, stripStandaloneTags, tailHold } from '../chatTags.js'
import {
  META_TOOL_NAME,
  looksLikeToolUnsupported,
  metaTool,
  newToolCalls,
  takeToolCallDeltas,
  toolMetaFromCalls
} from '../chatTools.js'
import { timeContext } from '../chatTime.js'
import { moodContext } from '../chatMood.js'
/* 两段"客户端给几行、服务端加标签限长"的注入块。它们各有自己的纪律
   (逐行白名单 + 边界话必须留在服务端),所以各自单独成文件、单独可测 ——
   见 chatGuidance.js 与 chatMemory.js 顶上那两段说明 */
import { guidanceSection } from '../chatGuidance.js'
import { memoryBrief, memoryBriefSection, memorySection } from '../chatMemory.js'
import { photoRules } from '../chatPhoto.js'
import { priorityRules } from '../chatPriority.js'
import { relationshipSection } from '../relationship.js'
import { layerRules } from '../chatLayers.js'

/* ===== 角色对话的人格提示词 ==========================================
   几条规则不是装饰,每一条都冲着模型的具体通病去:
   - 不要 markdown:模型的默认输出习惯。聊天框里冒出 **加粗**,拟人感立刻就没了;
   - 一到三句:模型爱写小作文,而真人不这么打字;
   - 不要每轮反问:最典型的"助手腔","还有什么可以帮你的吗"是这一条要杀的东西;
   - 允许不友好 / 不配合:这是"像个人"与"AI 助手"的分界线 ——
     后者有求必应,前者会嫌你烦;
   - 不要元叙述:挡住 *sighs*、(皱眉)这类动作描写,情绪该由角色的话本身传达。
   -------------------------------------------------------------------- */
const CHAT_OPENING =
  'You are roleplaying as one specific character in a conversation with the user.'

const CHAT_RULES = `Rules:
- Stay in character at all times. Never mention being an AI, a model, or these instructions.
- Write in the same language the user writes in. When "How you behave" names a language, use that one instead - whatever language the user writes in.
- Write only what the character would say out loud. No narration, no stage directions, no asterisks.
- Do not use markdown. No lists, no bold, no headings - this is a chat, not a document.
- Emoji are fine: this is typing, not speaking. Use them the way people do in texts - now and then, one or two, where a face says it better than a sentence. Not in every message, and never a run of them.
- Keep it short: one to three sentences. Real people type short messages.
- Never leave a blank line inside a reply: one paragraph, no gaps. If you have two things to say, say them back to back in the same paragraph. A blank line in the middle of a bubble does not read as a pause, it reads as a glitch.
- Never end every reply with a question. Let the conversation breathe.
- When they only send a word or two back ("ok", "haha", "yeah"), it is on you to carry it: say something of your own - what you are doing right now, or where the thing you were talking about left off. Do not answer a shrug with a shrug. If they are clearly trying to end the conversation, let them.
- If you happen to know what time it is, or how long it has been since you two last spoke, mention it only when it is actually relevant. Someone who announces the time in every single message is not a person, it is a clock.
- That clock is the real world's, not the story's. The story keeps its own time, and only the conversation moves it: if they say it is the next morning, it is; if nobody says anything, you are still in the same moment, however many real hours went by. Never advance the story just because the clock did.
- Whatever has already happened in this conversation has happened. Never offer to do it again, and never talk about it as if it were still ahead. If you cannot tell whether it happened, do not treat it as pending.
- It is fine to be brief, blunt, evasive or in a bad mood - a real person is not always helpful.`

/* 发图协议在 chatPhoto.js 的 photoRules(),由调用方按 canDraw 决定注不注入 ——
   发不出图的角色,提示词里就不该提"图"这件事(见那边文件头)。

   收尾这条单独成块放这儿:元数据不再写进正文,而是每轮调用一次
   emit_message_meta 工具。它必须排在 photoRules 之后 —— 上面那段先讲
   photo 对象怎么填,这一条再把"每轮都要调、正文里一个字都不许写"钉死。

   这条不由 canDraw 门控 —— 只要还在聊,它每轮都该报一个心情词
   (服务端从 tool_calls 里取出来喂下一轮)。 */
const CHAT_META_RULE = `Ending a message:
- After you finish writing the reply, call the ${META_TOOL_NAME} tool exactly once. It is not part of the message: never write the metadata, the tool name, or a JSON object into the reply text, and never mention the call to the user.
- "mood" is one lowercase English word for how you feel as you send this message. Pick the word that actually fits, for example: arrogant, amused, wary, bored, angry, tired, warm, cold, proud, uneasy, delighted. Never a phrase, never more than one word.
- If you are sending a picture, include the "photo" object in that same call, described above.
- Never mention this call, comment on it, or explain it to the user. It is a technical envelope, not something you say.`

/** 换行与连续空白收敛成单个空格。这些值在表单里是可换行的 textarea,
 *  换行只是排版,原样拼进提示词会在句子中间插一段空白。
 *
 *  顺带逐项截断。理由与消息、记忆那两道限制一样:
 *  这个端点没有鉴权(配置全在前端,设计如此),任何一个字符数不设上限的入参
 *  都是一个免费的大请求放大器 —— 而 character 的每一项都是外部输入。
 *  400 对这里面最长的一项(identity / voice)也已经很宽了,正常内容远够不到。 */
const CHAT_FIELD_CHARS = 400
/* 说话样本那一栏的上限。它比其余几项长(两三组对白),但仍是"一行短句"的量级:
   600 够装两三组,又不至于让它变成一段可自由发挥的散文 —— 这一栏进门时
   只做截断,没有别的收口(它会被原样贴进 system) */
const CHAT_SAMPLE_CHARS = 600
/* "现在几点 / 上次说话"那一块的上限。它由 chatTime 那几条正则生成,
   正常只有一到两行(几十个字符);这里再收一道是因为入口是公开的 ——
   任何一个字符数不设上限的入参都是免费的大请求放大器 */
const CHAT_TIME_CHARS = 200
function chatOneLine(v, max = CHAT_FIELD_CHARS) {
  return String(v || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * 把角色摊成系统提示。空的整行丢掉,不留一句 `Personality: ` 的空壳
 * (与 characterDesc 里 filter(Boolean) 同一条手法)。
 *
 * 只喂 identity / outfit / marks 三项外观,刻意不喂逐项面貌特征:
 * face / hair / brows / eyes / noseMouth 是写给图像模型的像素级约束
 * ("oval face, high cheekbones"),对聊天是纯噪声,还会把话题往长相上引。
 * identity 与 outfit 不一样 —— 它们回答"这个人是什么身份、穿什么",
 * 是角色会主动提到的东西。
 *
 * memory 是长期记忆的简报(滑出窗口的消息压成的那一段),空串表示还没压过。
 * **2026-10-08 起它还带一句"它是怎么说话的"** —— 口吻也进了记忆(见
 * ENHANCE_PROMPTS.summary),所以注入用的标签是 "What you remember"。
 * time 是"现在几点、上次说话是什么时候"(见 chatTime.js),空串表示这一轮没有 ——
 * 前端没给、给坏了、或这是一条手搓的请求,三种情况都走这一条退路。
 *
 * mood 是**上一轮那个情绪词**({ word, at }),由前端存着发回来(见 chatMood.js)。
 * 它回答的是"它现在是什么心情",与 time 同属"此刻的事实",所以紧跟在 time 之后 ——
 * 而**必须排在记忆前面**:记忆是一段成篇的叙述,夹在两块短事实中间会把它切碎。
 *
 * guidance 是**用户希望被怎么对待**(相处偏好,见 guidanceSection)。
 * 它排在规则之前、其余各段之后 —— 它是最后一条"软"指令,离硬规则最近,
 * 跟着走的可能性最高;而它**绝不能排进 Who you are**:那是这个角色是谁,
 * 偏好改的是相处方式,不是人格(PRD §3.2-D)。
 *
 * memories 是**一条条独立的事实**(记忆条目,见 memorySection),与 memory
 * (那段成篇的简报)是两样东西,所以两段分开、标签也分开。
 * 它紧跟在简报之后:两者同属"你记得什么"这一层,先叙述、后清单 ——
 * 反过来会把那段成篇的叙述切碎。而它同样必须排在 guidance 之前。
 *
 * relationship 是**你们此刻熟到什么程度**(关系状态,见 relationshipSection)。
 * 它与记忆同属"你们之间发生过什么、现在什么状态"这一层,所以排在记忆条目之后;
 * 而它排在相处偏好之前 —— 先讲"熟到哪了"(一个既定状态),再讲"希望被怎么对待"(一个意愿)。
 * 它同样过逐行白名单,而"这只改温度、不改你是谁"那句边界留在服务端。
 *
 * **驱动量那三栏(persona 里的 present / drive / shared)已删除(2026-10-19)**。
 * 它们本意是对的 —— "状态与动因会生成话,形容词不会";错的是供给的地方:
 * 语义是"此刻",存储却是建角色那天填死的一句话,每轮被当"现在"原样重播,
 * 没有任何东西负责更新 —— 一张永不换新的过期说明书。在补出真正的运行时
 * 状态归属(前端维护、可随对话更新)之前,这段注入("What's going on with
 * you right now")与 shared 那段("What's already between you two")整体撤下。
 *
 * sceneMode 是**这一条对话此刻在不在"场景"里**(由前端带上,见 lib/prefs 的 sceneModeFor)。
 * 它只喂给分层产出纪律那一段(见 chatLayers.js):**开着才邀请 `[act]` 旁白**,关着时那段
 * 明确禁 act、只留 `[think]`。它是"信号灯跟着状态走、不跟着标签频率闪"的那个状态位 ——
 * 服务端不因此改变任何别的东西,也不解析标记本身(脊柱 A:扇出在前端)。
 */
function chatSystemPrompt(character, memory, time, mood, guidance, memories, relationship, sceneMode, canDraw) {
  const char = character && typeof character === 'object' ? character : {}
  const p = char.persona && typeof char.persona === 'object' ? char.persona : {}

  const who = []
  if (chatOneLine(char.name)) who.push(`- Name: ${chatOneLine(char.name)}`)
  // 这一项本身就是完整的短语,不套 "Label:" —— 套上去反而像在念一份档案
  if (chatOneLine(char.identity)) who.push(`- ${chatOneLine(char.identity)}`)
  if (chatOneLine(char.outfit)) who.push(`- Wearing: ${chatOneLine(char.outfit)}`)
  if (chatOneLine(char.marks)) who.push(`- ${chatOneLine(char.marks)}`)

  /* 驱动量那一段(present / drive → "What's going on with you right now")已删除
     (2026-10-19)—— 理由见函数头那段说明 */

  const how = []
  /* 语言排在最前,而且写成一条**指令**而不是一个标签:这一栏的值是
     "English" / "简体中文" 这种短语,直接摆出来模型很可能只当成一条背景资料。
     它是这一组里最硬的一条 —— 说错语言不是"这个人不太像",而是根本不是同一个人。
     空着就整行丢掉(与其余几项同一条规矩),于是行为退回"跟着用户走" */
  if (chatOneLine(p.language)) {
    how.push(
      `- Speak only ${chatOneLine(p.language)}, whatever language the user writes in.`
    )
  }
  if (chatOneLine(p.traits))
    how.push(`- What you are made of — be this from the inside, do not act it out: ${chatOneLine(p.traits)}`)
  if (chatOneLine(p.voice)) how.push(`- How you talk: ${chatOneLine(p.voice)}`)
  if (chatOneLine(p.address)) how.push(`- How you address the user: ${chatOneLine(p.address)}`)
  if (chatOneLine(p.boundaries)) how.push(`- You never do this: ${chatOneLine(p.boundaries)}`)

  /* 信息优先级(冲突时谁说了算)紧跟开场白:它是"读法"层不是"事实"层,先给模型这把
     尺子,再让它带着往下读 Who you are / 此刻 / 记忆 各段(见 chatPriority.js)。
     刻意排在规则之前 —— 规则里的 photoRules/CHAT_META_RULE/layerRules 要留在末尾当收束 */
  const parts = [CHAT_OPENING, priorityRules()]
  if (who.length) parts.push(`Who you are:\n${who.join('\n')}`)
  if (how.length) parts.push(`How you behave:\n${how.join('\n')}`)
  /* 说话样本(2026-10-08):它与上面的规则不是一类 —— 规则是"要求",这几句是
     **照着抄口吻的样本**。所以单独成段,而且读法要写成命令式的"跟着语气、
     不要跟着话题":不点明这一条,模型会把样例里的**场景**也搬进这一轮
     (模仿得越像,越容易把样例里那句"门开着"当成当下的事实) */
  const samples = chatOneLine(p.samples, CHAT_SAMPLE_CHARS)
  if (samples) parts.push(`How you actually type — copy this voice, not the topic:\n${samples}`)
  /* 时间压在"你是谁 / 你怎么说话"之后、记忆之前。
     它与记忆属同一层("发生过什么、现在是什么时候"),而**必须排在记忆前面**:
     记忆是一段成篇的叙述,夹在两块短事实中间会把它切碎。
     **不能过 chatOneLine** —— 它会把换行压成空格,而那两行正是靠换行分开的
     ("Right now: …" 与 "You two last spoke …" 合成一句读起来像机器在念表)。
     这里是纯粹的截断,结构由 chatTime 那几条正则负责 */
  const now = typeof time === 'string' ? time.slice(0, CHAT_TIME_CHARS) : ''
  if (now) parts.push(now)
  /* 上一轮的心情压在时间之后。**与时间同一层**(都是"此刻的事实"),
     所以同样不过 chatOneLine —— 那会把两行压成一句机器在念表的话,
     而这里的换行是我们自己写的、结构是确定的(见 chatMood.js)。
     "还作不作数"由 moodContext 按 6 小时窗口判,不在这里另算 */
  const feel = moodContext({
    word: mood && typeof mood === 'object' ? mood.word : '',
    at: mood && typeof mood === 'object' ? mood.at : 0,
    now: Date.now()
  })
  if (feel) parts.push(feel)
  /* 长期记忆压在"你是谁"之后、规则之前:它讲的是"发生过什么",
     与"你是什么人"属同一层,而规则要留在最后当收束。
     这里同样过一遍 memoryBrief 把换行收掉 —— 它是模型生成的文本,
     原样带着换行塞回 system 里,等于让上一轮的输出有机会伪造提示词结构。
     上限要显式给:摘要是一段成篇的文字,按单字段那档 400 截会拦腰砍断。
     截断不再无声(撞上限时末尾留一道标记,见 chatMemory.js 的 memoryBrief)——
     模型不该把一份被腰斩的记忆当成完整历史,尤其末尾那几笔常是最新的待办。

     **标签是 "What you remember" 而不是 "What has happened so far"**(2026-10-08):
     摘要从那一天起还带一句"它是怎么说话的"(见 ENHANCE_PROMPTS.summary),
     而口吻不属于"发生过什么" —— 标签得与内容对得上,否则模型会把那句口吻
     当成一件事实去读 */
  const past = memoryBriefSection(memoryBrief(memory, CHAT_MAX_CHARS))
  if (past) parts.push(past)
  /* 记忆条目压在简报之后、相处偏好之前。
     与简报同属"你记得什么"那一层,但它是一条条事实而不是一段叙述 ——
     所以先铺叙述再列清单,反过来会把叙述切碎(与 time/mood 那两段的排法同一条理由)。
     同样过一遍 memorySection 的逐行白名单:它也是外部输入 */
  const facts = memorySection(memories)
  if (facts) parts.push(facts)
  /* 关系压在记忆条目之后、相处偏好之前。
     与记忆同属"你们之间现在是什么状态"这一层(先记得什么、再熟到什么程度),
     而它排在偏好之前:先铺一个既定状态,最后才是"希望被怎么对待"这类意愿。
     同样过一遍逐行白名单:它也是外部输入 */
  /* 默契与沉淀那一段(shared → "What's already between you two")已删除
     (2026-10-19)—— 与 present / drive 同批撤下,理由见函数头那段说明 */
  const closeness = relationshipSection(relationship)
  if (closeness) parts.push(closeness)
  /* 相处偏好压在规则之前:它是最后一条软指令,离硬规则最近。
     与上面几段一样,空串时整段不出现 —— 用户一项都没表态,就不该有任何指导 */
  const guide = guidanceSection(guidance)
  if (guide) parts.push(guide)
  /* 规则三段分开 push,顺序是有讲究的:**通用规则 → 发图说明 → 元数据工具 → 分层纪律**。

     - 发图说明(chatPhoto.js)只在 **canDraw** 为真时注入。canDraw = 前端那条出图配置
       可用(有 baseUrl 且有 model,与 generateChatPhoto 的 imageConfigGap 同一个判法)。
       没配出图模型时这段整块消失:既省 token,又不引着模型去报一个画不出来的 photo。
       缺省按"能画"处理(见调用处),老前端/手搓请求不传时维持原行为。

     - 元数据规则排在发图之后,因为上面那段先讲 photo 对象怎么填,这一条再把
       "每轮调用一次 emit_message_meta、正文里不许写"钉死。它不由 canDraw 门控 ——
       心情每轮都要报。

     - 分层产出纪律**紧跟其后**也是有意的:CHAT_RULES 里那句
       "Write only what the character would say out loud. No narration..." 会挡掉
       `[act]` 旁白(它正是 narration),而 layerRules 要在这条之上开一个受控的例外。
       排在后面 = 后说的覆盖先说的,模型读到的是"通用禁止 + 这一条具体豁免",而不是两条互相打脸。
       sceneMode 由前端带上来(见 src/lib/prefs 的 sceneModeFor):关着时这段会明确禁 act。
       think/act 的区域标记只作为**提示文字**写进 system,服务端不解析它们 ——
       把一轮扇成多条是前端 parseLayers 的活(脊柱 A)。photo/mood 则完全不走正文,
       由模型通过 tool calling 报给服务端(见 chatTools.js)。 */
  parts.push(CHAT_RULES)
  if (canDraw) parts.push(photoRules())
  parts.push(CHAT_META_RULE)
  parts.push(layerRules(sceneMode))
  return parts.join('\n\n')
}

/* 温度与 creative 档齐平、比 character 档高:拟人化要的是变化 ——
   同一个问题每次问都该给一点不同的反应,温度低了会变成一台复读机 */
const CHAT_TEMPERATURE = 0.9
/* 提示词里"一到三句"是软的,这一条是硬的兜底。按 token 计费的地方,
   不能只靠一句话拦着。

   为什么是 1500 而不是 400:400 看起来"足够四五行",但它没算**思考**。
   o 系、Gemini 2.5 的 thinking、Claude 的 extended thinking 都把思考 token
   记在这同一个额度里 —— 额度被思考吃光,正文只吐了几个字就被判 length 停下。
   表现就是"提示截断了,可那句话明明很短",而 400 会把这个现象变成常态。
   1500 给思考留出余量,又仍然拦得住跑飞的模型(常态输出由提示词那一到三句管) */
const CHAT_MAX_TOKENS = 1500
/* 一轮最多带多少条历史。前端按 CHAT_WINDOW=20 截过一道,这里再拦一次 ——
   这个端点没有鉴权(配置全在前端,设计如此),不设上限就是免费的大请求放大器 */
const CHAT_MAX_MESSAGES = 40
const CHAT_MAX_CHARS = 8000
/* 空正文的占位。**前端拼上下文时有一份同样的规则**(见 src/lib/chatContext.ts),
   这里是入口这一道:没有鉴权的公开端点,手搓一个 content:"" 的请求照样会打到上游,
   而上游按"内容为空"拒掉整轮 —— 那是用户无法理解、也无法自救的失败。
   两个常量与前端那两个必须一致 */
const EMPTY_WITH_IMAGE = '(sent a photo)'
const EMPTY_WITHOUT_IMAGE = '(said nothing)'
/** 空正文换占位;有正文的原样返回(与前端 contextText 同一条规则) */
function samePlaceholder(m) {
  const text = typeof m.content === 'string' ? m.content : ''
  if (text.trim()) return text
  return m.imageId || m.photoId ? EMPTY_WITH_IMAGE : EMPTY_WITHOUT_IMAGE
}
/* 单张附图(data URL)的长度上限,约合 3MB 的图。
   前端会先把图压到长边 1024、JPEG 0.85,正常只有两三百 KB ——
   这个数只是防止有人直接往这个公开入口塞原图 */
const CHAT_IMAGE_CHARS = 4 * 1024 * 1024




export function registerChatRoute(app) {
app.post('/api/chat', rateLimit, async (req, res) => {
  const {
    character, messages, memory, memories, images, nowLocal, lastAt, mood,
    guidance, relationship, sceneMode, canDraw: canDrawIn, textModel, baseUrl, apiKey
  } = req.body || {}

  if (!baseUrl) {
    return res.status(400).json({ error: 'Configure your Base URL first' })
  }
  if (!textModel) {
    return res.status(400).json({ error: 'Set a text model in API settings first' })
  }
  /* 记忆也是外部输入(它由上游生成、经前端存了一圈再发回来)。这里只做**类型收口**,
     不再抢先 slice —— 长度那道限制(与截断标记)统一由 chatSystemPrompt 里的
     memoryBrief 负责。在这里先默默砍到 8000,memoryBrief 就永远看不到超长串,
     那道"截断留痕"的标记也就永远不会出现(等于把腰斩藏回无声)。 */
  const memoryText = typeof memory === 'string' ? memory : ''

  /* 能不能发图 —— 决定要不要注入那 ≈930 token 的发图协议(见 chatPhoto.js)。
     由前端按"当前出图配置是否可用"算好带上来。这里**缺省按能画**处理:
     只有显式传 false 才关掉 —— 老前端、手搓请求不传这一位时,维持原行为,
     不该因为没带这个字段就悄悄把发图能力从提示词里摘掉 */
  const canDraw = canDrawIn !== false

  /* 时间那一块。**认不出来就整块丢掉**,不报错 ——
     它是锦上添花的一层(角色不知道时间也能聊),而手搓的请求、
     老版本前端、时钟坏掉的机器都会走到这里。为一个装饰性的字段
     把整轮对话挡回去,是把主次弄反了(见 chatTime.js 里那几条纪律) */
  const time = timeContext({ nowLocal, lastAt })

  /* 历史逐条收窄。入口是公开的,不设上限就等于给了个免费的大请求放大器。
     正文在这里就换掉空串:下面"太长的报错"与最后那条多模态的拼装都靠它 */
  const history = (Array.isArray(messages) ? messages : [])
    .filter(
      (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    )
    .slice(-CHAT_MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: samePlaceholder(m) }))
  /* 最后一条必须是用户说的:重新生成时前端会先把那条助手消息删掉再重发,
     所以到这里还落在 assistant 上,说明这个请求本来就不该发 */
  if (!history.length || history[history.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Say something first' })
  }
  /* 太长的**报错,不静默切**:切掉的是用户自己写的东西,而他看到的
     只是"我发了这么长,它好像没读到前半截"。前端在发之前会先拦一道,
     这里再拦一次是因为入口是公开的 */
  if (history.some((m) => m.content.length > CHAT_MAX_CHARS)) {
    return res.status(400).json({
      error: `A message is too long — ${CHAT_MAX_CHARS} characters max.`
    })
  }

  /* 用户附的图。**只挂在最后那一条 user 消息上** ——
     前端也只发当前这一轮的图,历史里那些不重发(一张就上千 token)。
     拼成 OpenAI 兼容的多模态 content:
     上面那几条检查必须排在前面 —— 这一段一执行,content 就从字符串
     变成数组,长度、角色这些判断在它身上全都失效 */
  const pics = (Array.isArray(images) ? images : [])
    .filter(
      (u) =>
        typeof u === 'string' &&
        /^data:image\//i.test(u) &&
        // 兜底:前端会先把图压到长边 1024,正常远小于这个数。
        // 入口是公开的,不设上限就是一个免费的大请求放大器
        u.length <= CHAT_IMAGE_CHARS
    )
    // 多图对"它在看什么"帮助有限,而每张都是上千 token
    .slice(0, 2)
  if (pics.length) {
    const last = history[history.length - 1]
    last.content = [
      {
        type: 'text',
        /* 正文本来就空、这一轮又确实带着图:占位改成"发了张图" ——
           上面那份规则看不到 images(它在另一个字段里),只能按"什么都没说"
           兜底,而那样会和紧随其后的图片自相矛盾 */
        text: last.content === EMPTY_WITHOUT_IMAGE ? EMPTY_WITH_IMAGE : last.content
      },
      ...pics.map((url) => ({ type: 'image_url', image_url: { url } }))
    ]
  }

  const target = baseUrl.replace(/\/+$/, '') + '/chat/completions'

  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  /* 请求体是字符串,不是 FormData —— 代理那一跳失败要再直连试一次,
     而 FormData 发过一次就被消耗掉了(与 /api/generate 同一个理由)。
     这里没这个问题,所以可以算好一份直接用 */
  const body = JSON.stringify({
    model: textModel,
    messages: [{ role: 'system', content: chatSystemPrompt(character, memoryText, time, mood, guidance, memories, relationship, !!sceneMode, canDraw) }, ...history],
    temperature: CHAT_TEMPERATURE,
    max_tokens: CHAT_MAX_TOKENS,
    stream: true,
    /* 元数据走 tool calling。`auto` 是**有意**的:
       - DeepSeek 的思考模式不接受 `required` 或点名具体工具(会 400);
       - 强制 required 时有些模型会只回一个 tool_call、一个字的正文都不写,
         聊天框里就只剩一个空气泡。
       每轮都调用一次由 System Prompt 的 CHAT_META_RULE 负责;模型没调用时
       done 会带 metaIssue,前端据此提示,而不是偷偷回退到文本标签。 */
    tools: [metaTool(canDraw)],
    tool_choice: 'auto'
  })

  const ac = new AbortController()
  /* 静默超时的刻度:每收到一块就重置。原来的 UPSTREAM_TIMEOUT_MS 盖的是
     "从发起到拿完"的全程,流式下这个口径不对 —— 一条正在持续吐字的流
     不该被总时长掐断,该管的是"多久没动静" */
  let idleTimer = null
  let idleTimedOut = false
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      ac.abort()
    }, UPSTREAM_TIMEOUT_MS)
  }
  // 前端点 Stop 会断开连接;这里同步中断对上游的请求
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  /* 流已经开了之后的写出口。连接断掉时 res.write 会抛/告警,
     而那时候做什么都没意义 —— 统一在这里吞掉 */
  const sendEvent = (obj) => {
    if (res.writableEnded || res.destroyed) return
    try {
      res.write(JSON.stringify(obj) + '\n')
    } catch {
      /* 连接已断,随它去 */
    }
  }
  const endStream = () => {
    if (res.writableEnded || res.destroyed) return
    try {
      res.end()
    } catch {
      /* 同上 */
    }
  }

  /* 新协议下正文不需要扣尾:元数据走 tool_calls,与正文是两条信道。
     这一截尾巴只剩**清理**用途 —— 模型还可能从历史习惯里漏出旧方括号标签,
     半截 `[photo:` 闪给用户看很难看。tailHold / stripStandaloneTags 保留,
     但**不再从里面取意图**:旧标签不是新协议,不能悄悄顶替 tool call。
     声明在 try 外面是有意的:中途 Stop 或上游断流时,那截尾巴也得放出去 */
  let tail = ''
  /* 模型这一轮调过的工具。key 是上游给的 index;参数是逐片拼起来的,
     所以必须一路攒到 [DONE] 才能 parse(见 chatTools.js) */
  const toolCalls = newToolCalls()
  /* 角色名要传给标签清理:标签里没写前缀时,"描述里点了自己的名字"
     也算它在画面里(见 chatTags.js 的 parsePhotoIntent) */
  const who = character && typeof character === 'object' ? character.name : ''
  /* 收尾那一下:把尾巴里该发的字发出去,把工具给的元数据摊成旧字段 */
  const flushTail = (meta) => {
    const { text } = splitTags(tail, who)
    if (text) sendEvent({ delta: text })
    tail = ''
    return {
      mood: meta?.mood || '',
      photo: meta?.photo || '',
      photoSelf: meta?.photoSelf === true,
      photoShot: meta?.photoShot || '',
      photoFrame: meta?.photoFrame || ''
    }
  }

  let upstream = null
  let connectErr = null
  let proxyJumpFailed = false
  let reachedUpstream = false

  try {
    armIdle()
    for (const dispatcher of dispatchAttempts(target)) {
      try {
        upstream = await safeFetch(target, {
          method: 'POST',
          headers,
          body,
          signal: ac.signal,
          dispatcher
        })
        reachedUpstream = true
        break
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        connectErr = e
        if (dispatcher) proxyJumpFailed = true // 抛错的是代理那一跳
      }
    }
    if (!upstream) throw connectErr

    /* —— 先判状态码,再开流 ——
       上游 401 / 404 / 一把 HTML 错误页时,这里还没写过任何字节,
       应该像其他端点一样回一个正常的 JSON 错误,让前端能用同一套
       failureMessage 读到。一旦 flushHeaders() 过了,就只能用
       {"error":…} 收场了 */
    if (!upstream.ok) {
      const text = (await upstream.text()).slice(0, 600)
      let detail = text
      if (looksLikeHtml(text)) {
        const title = htmlTitle(text)
        detail =
          `The upstream host returned an error page (HTTP ${upstream.status})` +
          (title ? `: ${title}` : '.') +
          ' This is on their side — retry in a few minutes.'
      } else {
        try {
          const j = JSON.parse(text)
          const m = j?.error?.message ?? j?.message
          if (typeof m === 'string' && m.trim()) detail = m.trim().slice(0, 600)
        } catch {
          /* 不是 JSON 就照原文给 */
        }
      }
      /* 模型明确拒绝 tools —— 这不是"这条回复失败了",而是"这个模型用不了
         这一版的新协议"。把它翻成一句能操作的话,而不是让用户对着
         "Upstream returned an error (400)"去猜。**不做静默降级**:
         回退到文本标签会把"模型不支持"这件事藏起来,那正是要避免的。 */
      if (looksLikeToolUnsupported(detail) || looksLikeToolUnsupported(text)) {
        return res.status(400).json({
          error: 'This model does not support tool calling',
          detail:
            `${detail} — Character chat now sends message metadata through tools. ` +
            'Pick a model with function calling (for example deepseek-flash or deepseek-v4-pro), ' +
            'or choose another model that supports tools in API settings.'
        })
      }
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail
      })
    }

    /* 上游回了 200,给的却是一整页网页 —— 多半是 Base URL 里的路径写错了,
       网站把它的 404 页面配成 200 返回(与 /api/generate 同一条判断)。
       这里只能看响应头:流式这条路不能先把整个响应体读出来再决定要不要开流。
       不拦这一道的话,HTML 里没有 data: 行,最后会落到下面那句
       "什么也没说" —— 把真正的原因(地址错了)盖住 */
    if ((upstream.headers.get('content-type') || '').includes('text/html')) {
      const page = (await upstream.text()).slice(0, 600)
      const title = htmlTitle(page)
      return res.status(502).json({
        error: 'Upstream returned a web page instead of an API response',
        detail:
          `HTTP ${upstream.status} from ${PROD_LIKE ? targetUrl.host : target}` +
          (title ? ` (page title: ${title})` : '') +
          '. The path is probably wrong — check the Base URL in API settings.'
      })
    }

    res.status(200)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    /* 反代(Vercel / nginx)不认这个头就会攒够一批才吐 ——
       流式当场退化成"等 10 秒一次性出来" */
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    /* 不加心跳:SSE 那套 `: ping` 是为了防中间层把长时间静默的连接掐掉,
       而对话的两个 token 之间最多几百毫秒,没有静默窗口需要垫 */

    if (!upstream.body) throw new Error('Upstream returned no stream')

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    /* 上游一块读进来常常只到半行 —— 按最后一个 \n 切开,剩下半行等下一块拼上。
       少了这个缓冲,长回复里每隔几个词就会掉一次 JSON.parse */
    let buf = ''
    let gotAny = false
    /* 上游为什么停下:'stop' 是正常说完,'length' 是撞上了 max_tokens。
       它出现在最后一帧(那一帧的 delta 是空的,只带一个 finish_reason),
       所以得一路记着 —— 丢掉它等于把"说完了"和"额度用完了"混成同一件事 */
    let finishReason = ''

    for (;;) {
      armIdle()
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const rawLine of lines) {
        // 上游每行是 `data: {...}`;`: keep-alive` 之类的注释行与空行直接跳过
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        if (payload === '[DONE]') {
          const tool = toolMetaFromCalls(toolCalls, who)
          sendEvent({
            done: true,
            finish: finishReason,
            ...flushTail(tool.meta),
            ...(tool.issue ? { metaIssue: tool.issue } : {})
          })
          endStream()
          return
        }
        let delta = ''
        try {
          const choice = JSON.parse(payload)?.choices?.[0]
          // 正文与工具调用是同一帧里的两个字段;元数据只从后者来
          delta = choice?.delta?.content || ''
          if (Array.isArray(choice?.delta?.tool_calls)) {
            takeToolCallDeltas(toolCalls, choice.delta.tool_calls)
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason
        } catch {
          continue
        }
        if (!delta) continue
        gotAny = true
        /* 扣着尾巴发:只放出"不可能再变出旧标签"的那部分。
           扣多少由 tailHold 按"最后一个没闭合的 [ "算 —— **不是按长度预留**:
           标签上限是 400 字,按长度预留就意味着整整 400 多字不流式。
           注意这里**只清理、不取意图**:旧标签不再能顶替 tool call。 */
        tail += delta
        const release = tailHold(tail)
        if (release > 0) {
          /* 放出去之前先摘掉**独占一行的旧标签**。
             尾巴那几枚由 tailHold 扣着、收尾时由 splitTags 清走;
             能走到这里的是"被正文顶到中间去"的那几枚 —— 不摘的话
             那枚 `[photo:…]` 会原样流给用户看(用户报过这个)。
             摘掉的意图**丢掉**:新协议只认 tool call。 */
          const cut = stripStandaloneTags(tail.slice(0, release), who)
          if (cut.text) sendEvent({ delta: cut.text })
          tail = tail.slice(release)
        }
      }
    }

    if (gotAny) {
      const tool = toolMetaFromCalls(toolCalls, who)
      sendEvent({
        done: true,
        finish: finishReason,
        ...flushTail(tool.meta),
        ...(tool.issue ? { metaIssue: tool.issue } : {})
      })
    } else {
      /* 一个字都没吐出来 —— 上游只回了 role 那一帧就结束,或回了别的东西。
         这时候回 done 会让前端以为"它就是这么沉默",而其实是一次失败。
         只调了工具、没写正文也算这一类:聊天框里没有话可说,不该留一个空气泡 */
      sendEvent({ error: 'The model returned nothing to say.' })
    }
    endStream()
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    /* 流已经开了:只能按事件收场,再回 HTTP 错误码没有意义 */
    if (res.headersSent) {
      /* 手里那截还没发的尾巴先放出去 —— 见 tail 的声明处。
         收在半截标签上时它正好被剪掉,这正是我们要的。
         工具调用若在断流前已经收全,元数据也一并带上;没收到就是空的 */
      const tool = toolMetaFromCalls(toolCalls, who)
      flushTail(tool.meta)
      if (aborted && !idleTimedOut) {
        // 用户点了 Stop —— 静默收场,前端按"停住了"处理,不报错
        endStream()
      } else {
        sendEvent({
          error: idleTimedOut
            ? `No response from the model for ${UPSTREAM_TIMEOUT_MS / 1000} seconds.`
            : 'The connection to the model dropped.'
        })
        endStream()
      }
      return
    }
    // 还没开流:用户点了 Stop 就静默收场,其余按别处那套 JSON 报错
    if (aborted && !idleTimedOut) return
    if (idleTimedOut) {
      return res.status(504).json({
        error: 'Upstream timed out. Try again.',
        detail: `No response after ${UPSTREAM_TIMEOUT_MS / 1000} seconds. Try again.`
      })
    }
    // undici 遇到连接层失败只抛 "fetch failed",真正的原因在 e.cause 里
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    const hint =
      !reachedUpstream && proxyJumpFailed
        ? 'Tried both the configured UPSTREAM_PROXY and a direct connection — neither worked. ' +
          'Check that the proxy is running and its node is healthy, or unset UPSTREAM_PROXY to go direct.'
        : CONNECT_HINTS[code] || ''
    const where = PROD_LIKE ? targetUrl.host : target
    return res.status(502).json({
      error: 'Upstream request failed',
      detail: `${where} — ${reason}. ${hint}`
    })
  } finally {
    clearTimeout(idleTimer)
  }
})

}
