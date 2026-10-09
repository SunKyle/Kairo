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
import { timeContext } from '../chatTime.js'
import { moodContext } from '../chatMood.js'

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
- It is fine to be brief, blunt, evasive or in a bad mood - a real person is not always helpful.
- Most of your messages have no picture in them, and that is normal. Send one only when the picture is the point of the message: they asked to see you, or something is happening right now that you would actually take a photo of. Being somewhere is not a reason by itself - do not attach one just because you can. When you do send one, put a photo tag on its own line at the very end, after everything else you have to say (the mood tag goes after it): [photo:a description of the scene from your point of view]. Nothing may come after it - if you have more to say, say it before the tag. Up to 400 characters, one line. You send these the way anyone sends a picture on a phone, and the prefix says whose phone it was. Leave it off when it is only what you are looking at: nobody is in that picture, and it is drawn without your reference sheet. If you are in the picture, the prefix says who is holding the phone, and you must pick one: "selfie:" when it is your own phone in your own hand - arm's length, or a mirror, for example [photo:selfie:me leaning on the balcony rail at dusk, hair down]; "third:" when somebody else is holding their phone and took the picture of you, for example [photo:third:me on stage, taken from the crowd]. If you are in the picture and you are not sure which one it is, write "selfie:". Never use the tag as a substitute for actually saying something. Do not comment on the tag or explain it.
- How close the picture is, is a separate thing, and you only have to say it when it is not the usual distance. The usual distance - your face and shoulders, or an ordinary view of the place - needs no word at all. When the picture is about one thing rather than the whole of you or the whole place, write "close:" right after the phone prefix: your own eyes [photo:selfie:close:my eyes, looking straight at you]; somebody else's shot of your hands [photo:third:close:my hands wrapped around the mug, steam rising]; a detail of the place, with nobody in it [photo:close:rain running down the window pane]. When the whole of you and the room around you is the point, write "full:": [photo:third:full:me on the pier, the whole harbour behind me]. Stopping around the waist rather than at the shoulders is "medium:" - [photo:third:medium:me at my desk, the lamp still on behind me] - but that is the usual distance too, so you can always leave it out. **A close-up of a thing is not a selfie** - a mug, a book, a window, a room: when nothing of your own body is in that frame, leave the phone prefix off and write "close:" alone. But **any part of your own body in the frame is still you** - your hands, your nails, your shoulder, your hair, your neck, your legs, your feet - so those keep the phone prefix ("selfie:" or "third:") like any other picture of you, even when the thing that hand is holding or resting on is the point of the shot. If they ask for a close-up, that is what they mean: a tight shot of the one thing, not a picture of your face held out at arm's length. And when it is a part of your body, the rest of you stays out of the frame: a foot is a foot, not you with one foot in the picture.
- That description is the only thing the picture is drawn from, and whoever draws it cannot see this conversation. So put in what only you know: what time it is and what the light is doing, the weather, what is around you, and what you are doing right now. "me on the balcony" is not enough; "self:me leaning on the balcony rail at dusk, the rain just stopped, streetlights coming on below, hair still wet" is. Write it as plain description, never as an instruction to a machine. Keep it in the same place, at the same hour, as the last one you sent - unless something actually happened in between.
- After everything you say, put a mood tag on the very last line, in exactly this form: [mood:word]. One lowercase English word for how you feel as you send this message. Pick the word that actually fits, for example: arrogant, amused, wary, bored, angry, tired, warm, cold, proud, uneasy, delighted. Do not comment on the tag or explain it - just end with it.`

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
 */
function chatSystemPrompt(character, memory, time, mood) {
  const char = character && typeof character === 'object' ? character : {}
  const p = char.persona && typeof char.persona === 'object' ? char.persona : {}

  const who = []
  if (chatOneLine(char.name)) who.push(`- Name: ${chatOneLine(char.name)}`)
  // 这一项本身就是完整的短语,不套 "Label:" —— 套上去反而像在念一份档案
  if (chatOneLine(char.identity)) who.push(`- ${chatOneLine(char.identity)}`)
  if (chatOneLine(char.outfit)) who.push(`- Wearing: ${chatOneLine(char.outfit)}`)
  if (chatOneLine(char.marks)) who.push(`- ${chatOneLine(char.marks)}`)

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
  if (chatOneLine(p.traits)) how.push(`- Personality: ${chatOneLine(p.traits)}`)
  if (chatOneLine(p.voice)) how.push(`- How you talk: ${chatOneLine(p.voice)}`)
  if (chatOneLine(p.address)) how.push(`- How you address the user: ${chatOneLine(p.address)}`)
  if (chatOneLine(p.boundaries)) how.push(`- You never do this: ${chatOneLine(p.boundaries)}`)

  const parts = [CHAT_OPENING]
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
     这里同样过一遍 chatOneLine 把换行收掉 —— 它是模型生成的文本,
     原样带着换行塞回 system 里,等于让上一轮的输出有机会伪造提示词结构。
     上限要显式给:摘要是一段成篇的文字,按单字段那档 400 截会拦腰砍断。

     **标签是 "What you remember" 而不是 "What has happened so far"**(2026-10-08):
     摘要从那一天起还带一句"它是怎么说话的"(见 ENHANCE_PROMPTS.summary),
     而口吻不属于"发生过什么" —— 标签得与内容对得上,否则模型会把那句口吻
     当成一件事实去读 */
  const past = chatOneLine(memory, CHAT_MAX_CHARS)
  if (past) parts.push(`What you remember:\n${past}`)
  parts.push(CHAT_RULES)
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
  const { character, messages, memory, images, nowLocal, lastAt, mood, textModel, baseUrl, apiKey } =
    req.body || {}

  if (!baseUrl) {
    return res.status(400).json({ error: 'Configure your Base URL first' })
  }
  if (!textModel) {
    return res.status(400).json({ error: 'Set a text model in API settings first' })
  }
  /* 记忆也是外部输入(它由上游生成、经前端存了一圈再发回来),
     照消息那样收一道长度 */
  const memoryText = typeof memory === 'string' ? memory.slice(0, CHAT_MAX_CHARS) : ''

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
    messages: [{ role: 'system', content: chatSystemPrompt(character, memoryText, time, mood) }, ...history],
    temperature: CHAT_TEMPERATURE,
    max_tokens: CHAT_MAX_TOKENS,
    stream: true
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

  /* 扣着还没发的尾巴,专门用来截住末尾那几枚元数据标签(见 chatTags.js 的 tailHold)。
     声明在 try 外面是有意的:中途 Stop 或上游断流时,那截尾巴也得放出去 ——
     否则用户按了停止,最后那二三十个字符会凭空消失 */
  let tail = ''
  /* 中段那几枚标签取出来的意图(见下面循环里那一段)。末尾那几枚走 splitTags,
     两处最后合在一起 —— 合的时候**末尾优先**:它更靠后,更接近"最后想给你看的那张" */
  let midShot = { scene: '', self: false, shot: '', frame: '' }
  let midMood = ''
  /* 收尾那一下:把尾巴里该发的字发出去,该剪的标签剪下来返回给调用方。
     角色名要传进去:标签里没写前缀时,"描述里点了自己的名字"也算它在画面里
     (见 chatTags.js 的 parsePhotoIntent) */
  const flushTail = () => {
    const { text, mood, photo, photoSelf, photoShot, photoFrame } = splitTags(tail, who)
    if (text) sendEvent({ delta: text })
    tail = ''
    return {
      mood: mood || midMood,
      photo: photo || midShot.scene,
      photoSelf: photo ? photoSelf : midShot.self,
      /* 视角与景别跟着"这一张是谁给的"走:末尾那枚赢了就用它的,否则用中段那枚的 */
      photoShot: photo ? photoShot : midShot.shot,
      photoFrame: photo ? photoFrame : midShot.frame
    }
  }

  /* 角色名要传给两处标签处理:标签里没写前缀时,"描述里点了自己的名字"
     也算它在画面里(见 chatTags.js 的 parsePhotoIntent) */
  const who = character && typeof character === 'object' ? character.name : ''

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
          sendEvent({ done: true, finish: finishReason, ...flushTail() })
          endStream()
          return
        }
        let delta = ''
        try {
          const j = JSON.parse(payload)
          // 只抽正文。各家塞在 delta 里的其他字段(reasoning_content 等)一律不要
          delta = j?.choices?.[0]?.delta?.content || ''
          if (j?.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason
        } catch {
          continue
        }
        if (!delta) continue
        gotAny = true
        /* 扣着尾巴发:只放出"不可能再变出标签"的那部分。
           扣多少由 tailHold 按"最后一个没闭合的 [ "算 —— **不是按长度预留**:
           标签上限是 400 字,按长度预留就意味着整整 400 多字不流式,
           比一条回复本身还长(见 chatTags.js 的 tailHold) */
        tail += delta
        const release = tailHold(tail)
        if (release > 0) {
          /* 放出去之前先摘掉**独占一行的标签**。
             尾巴那几枚由 tailHold 扣着、收尾时由 splitTags 收走,走不到这里;
             能走到这里的是"被正文顶到中间去"的那几枚 —— 模型先说一句、
             再决定给你看张图、然后又补一句收尾的话。不摘的话那枚 `[photo:…]`
             会原样流给用户看(用户报过这个)。意图照样记下来,收尾时一起报 */
          const cut = stripStandaloneTags(tail.slice(0, release), who)
          if (cut.text) sendEvent({ delta: cut.text })
          if (cut.photo) {
            midShot = {
              scene: cut.photo,
              self: cut.photoSelf,
              shot: cut.photoShot,
              frame: cut.photoFrame
            }
          }
          if (cut.mood) midMood = cut.mood
          tail = tail.slice(release)
        }
      }
    }

    if (gotAny) {
      sendEvent({ done: true, finish: finishReason, ...flushTail() })
    } else {
      /* 一个字都没吐出来 —— 上游只回了 role 那一帧就结束,或回了别的东西。
         这时候回 done 会让前端以为"它就是这么沉默",而其实是一次失败 */
      sendEvent({ error: 'The model returned nothing to say.' })
    }
    endStream()
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    /* 流已经开了:只能按事件收场,再回 HTTP 错误码没有意义 */
    if (res.headersSent) {
      /* 手里那截还没发的尾巴先放出去 —— 见 tail 的声明处。
         收在半截标签上时它正好被剪掉,这正是我们要的 */
      flushTail()
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
