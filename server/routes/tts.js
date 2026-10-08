import { randomUUID } from 'node:crypto'
import {
  assertSafeTarget,
  CONNECT_HINTS,
  dispatchAttempts,
  htmlTitle,
  looksLikeHtml,
  PROD_LIKE,
  rateLimit,
  safeFetch,
  shortDetail,
  UPSTREAM_TIMEOUT_MS
} from '../core.js'

/* ===== 语音合成(火山引擎/豆包语音) =====================================
   与前面四条端点不是一类:那四条要么文本进文本出、要么文本进图出,
   这条是**文本进音频**。骨架仍沿用同一套(限流、目标校验、代理回退、静默超时),
   但有三处必须不同 —— 每一处都写在下面各自的位置上:

   1. 上游给的不是裸音频,而是一行行 JSON,音频在 data 字段里且是 base64;
   2. 一旦写了响应头就只能断流,所以"上游拒绝"这种最常见的失败必须
      在写头**之前**判出来 —— 它出现在正文的第一帧里,而不是 HTTP 状态码上;
   3. 这是唯一按字符计费的端点,所以整条路上一处重试都不能有:
      `dispatchAttempts` 那两次尝试里只有一次真正到达上游(见那边的说明),
      而上游一旦回了错误码就不再试。
   ------------------------------------------------------------------ */
const TTS_PROVIDERS = {
  /* 火山引擎的路径与 OpenAI 兼容那套完全不同(/api/v3/tts/... 而不是 /v1/chat/...),
     所以 baseUrl 由用户在配置里填好(默认给到 /api/v3),这里只往后接路径 */
  volc: {
    /* 一次性把文本发完、流式收音频。选 HTTP Chunked 而不是 WebSocket:
       这个代理是 HTTP 的,而"边生成边播"那点延迟优化对一到三句的回复不值当 */
    speech: '/tts/unidirectional',
    /* 音色描述走的是**音频生成**那条端点(不是"音色设计")。
       两者差一个前提:音色设计要从一个买过的底子音色出发,
       而音频生成的**纯文本模式什么都不用给** —— 一段描述就是全部输入。
       既然描述档的卖点就是"不用先准备任何东西",就不该绕那条要底子的路。
       (曾按"音色设计"实现过一版,那个端点要求 speaker_id 必填 —— 见 git 历史)
       代价:这个端点是"生成任意音频"的,环境音、音效、多人对话它都会做,
       所以提示词里必须把"只要这一个人说话"说死,见 ttsDesignPrompt */
    design: '/tts/create',
    clone: '/tts/voice_clone'
  }
}
/* 音频生成那条的必填模型名。目前只有这一个取值(见上游文档) */
const TTS_DESIGN_MODEL = 'seed-audio-1.0'
/* 复刻音色才认的"版本风味"。**只有这两个取值** —— 上游错误码文档里
   InvalidModel 那一条写得很死:model 仅对声音复刻 2.0 生效,枚举就这两个。
   填第三个值的后果是一句 [Invalid argument] InvalidModel,它既不说是哪个字段,
   也不说合法值是什么,所以这个白名单是唯一能自救的地方 */
const TTS_MODEL_VARIANTS = ['seed-tts-2.0-standard', 'seed-tts-2.0-expressive']

/**
 * 拼出真正的请求地址。**要容忍两种填法**。
 *
 * 别的端点没有这个问题:OpenAI 兼容那套有明确的"版本段"(`/api/v3`)可切,
 * 界面上的说明也一直写着"填到版本段为止"。而火山的三个端点路径长成这样:
 * `/api/v3/tts/{unidirectional,create,voice_clone}` ——
 * 用户从文档里复制 URL 时,整条路径会一起进来,于是无脑往后拼就得到
 * `/tts/create/tts/create` 这种 404(实测踩过)。
 *
 * 所以这里先把 base 收敛回"版本段",再统一往后接。三种填法都认:
 *   …/api/v3                                  → …/api/v3 + path
 *   …/api/v3/tts                              → 同上
 *   …/api/v3/tts/create                       → 同上
 *   …/api/v3/tts/voice_clone                  → 同上
 */
function ttsTarget(baseUrl, path) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/tts\/(unidirectional|create|voice_clone)$/, '')
    .replace(/\/tts$/, '')
  return base + path
}
/* 一次最多合成多少字符。火山那边没有明文上限,这里是费用闸 ——
    角色的回复只有一到三句,正常远够不到;超出的截断而不是报错,
    因为"少念最后一句"比"整个按钮点不动"好 */
const TTS_MAX_CHARS = 600
/* 音色描述本身的长度上限。上游给的是 3000 字符(那是 text_prompt 整个字段),
   但描述只是一句话的事 —— 收到 300 是给"有人往这里贴了一整篇小说"兜底 */
const TTS_DESCRIBE_CHARS = 300
/* 克隆样本的大小上限。上游限制单文件 10MB,而整个请求还要过
   express.json 的 15mb 闸 —— base64 会涨到约 1.34 倍,所以这里收到 8MB,
   留出余量给 JSON 外壳与其它字段 */
const MAX_VOICE_SAMPLE = 8 * 1024 * 1024

/** 火山的鉴权头。新版控制台只要 X-Api-Key;Resource-Id 决定模型版本,
 *  也决定计费商品,所以它由配置带过来(见 types.ts 的 ApiConfig.resourceId)。
 *
 *  key **先 trim**:密钥是从别处复制粘贴进来的,尾随一个空格或换行
 *  在上游看来就是一个"无效的 key"(401 Invalid X-Api-Key),
 *  而盯着那一串字符怎么看都看不出问题 */
function volcHeaders(apiKey, resourceId, withResource = true) {
  const h = {
    'Content-Type': 'application/json',
    'X-Api-Key': String(apiKey || '').trim(),
    // 上游建议每请求一个,用于链路追踪;少了它报错时很难定位
    'X-Api-Request-Id': randomUUID()
  }
  if (withResource && resourceId) h['X-Api-Resource-Id'] = resourceId
  return h
}

/**
 * 兜住 Resource-Id:上游只认 `seed-tts-* / seed-icl-*` 这种完整形态。
 *
 * 前端理应已经拼好了,但"发出去的是什么"这件事不该只靠对方的自觉 ——
 * 漏拼一次的表现是上游回一句 `[resource_id=2.0] requested resource not granted`,
 * 那句话读起来像"这个服务你没开通",于是人会跑去控制台翻开通管理,
 * 而真正的问题是我们把一个裸的代际当成 ID 发了出去(实测踩过)。
 *
 * 所以这里补一道:**不带 seed- 前缀的一律按"族 + 代际"补齐**。
 * 族由档位定(内置音色 → 语音合成,复刻音色 → 声音复刻),代际从原值里认。
 */
function normalizeResourceId(value, source) {
  const v = String(value || '').trim()
  if (v.startsWith('seed-')) return v
  const family = source === 'clone' ? 'seed-icl' : 'seed-tts'
  return `${family}-${v.includes('1.0') ? '1.0' : '2.0'}`
}

/**
 * 把上游那串"一行一个 JSON、音频在 data 里"的响应收成裸音频字节。
 *
 * **响应头推迟到第一帧音频才写**,这是这条端点最要紧的一处:
 * 上游拒绝请求(Resource-Id 不对、没有音色授权)时给的是一个
 * `{code, message}` 的 JSON 帧,而不是 HTTP 错误码 —— 头一旦先写了,
 * 这种最常见的失败就只能变成"前端拿到一段空音频、播不出来",
 * 而用户看不到任何原因。所以憋着不写,直到确认第一帧真的带音频。
 *
 * 返回 null 表示"音频已经全部转发完";返回错误对象表示"还没写头,可以回正常 JSON 错误"。
 */
async function pipeTtsAudio(upstream, res, armIdle) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let started = false
  let firstFrame = ''
  let code = 0
  let message = ''

  const flush = () => {
    if (started) return
    res.status(200)
    /* 一律按 mp3 报。火山也支持 pcm/ogg_opus,但那是给"边收边解"的客户端用的;
       这里整段收完再交给 <audio>,mp3 是兼容性最好的那个。
       注意音频生成那条的**默认输出是 wav**,所以请求里必须显式要 mp3 —— 见下面 */
    res.setHeader('Content-Type', 'audio/mpeg')
    /* 音频按字符计费,不该让中间层或浏览器把它缓存起来 ——
       要复用走前端自己的 tts_cache(见 idb.ts),那才认得音色指纹 */
    res.setHeader('Cache-Control', 'no-store')
    if (res.flushHeaders) res.flushHeaders()
    started = true
  }

  /* 收一帧。两条端点在这里合流,因为它们的差别只有"怎么切"和"音频叫什么":
     - 流式合成(unidirectional):一行一个 JSON,音频在 data 里,一行一块
     - 音频生成(create):**整个响应就一个 JSON**,音频在 audio 里,只在末尾出现一次
       而且末尾多半没有换行 —— 所以循环结束后还得把剩下的 buf 再喂一遍,
       漏掉它就是整段音频一个字节都发不出去 */
  const takeFrame = (line) => {
    if (!line) return
    if (!firstFrame) firstFrame = line.slice(0, 300)
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      // 半行或杂质:跳过。不为一行的毛病掐掉整段音频
      return
    }
    if (typeof frame.code === 'number' && frame.code !== 0) {
      code = frame.code
      message = typeof frame.message === 'string' ? frame.message : ''
      return
    }
    /* 帧里的音频字段名以 data 为准(streame 那条);audio 是音频生成那条的 */
    const b64 = typeof frame.data === 'string' ? frame.data : frame.audio
    if (typeof b64 !== 'string' || !b64) return
    const chunk = Buffer.from(b64, 'base64')
    if (!chunk.length) return
    if (!started) {
      /* 第一帧音频到了才写头。上面那个 code 判断因此有机会生效 */
      if (code) return
      flush()
    }
    res.write(chunk)
  }

  for (;;) {
    armIdle()
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const raw of lines) takeFrame(raw.trim())
  }
  // 末尾那一段(见 takeFrame 上面那段说明)
  takeFrame(buf.trim())

  if (!started) {
    /* 一个字节的音频都没有。把上游第一帧原样带上 —— 猜不出原因时,
       让用户看到他账号那边到底回了什么,比我们编一句解释有用 */
    return { code, message, firstFrame }
  }
  return null
}

/* 送合成之前把文本收一遍。
 *
 * 合成引擎是靠**标点**决定停顿与调型的,而这里要念的文本是模型写的 ——
 * 它写中文时常顺手用半角 , . ? !(键盘习惯),那套标点给到的停顿比全角短得多,
 * 连起来就是"气口不对、语调怪"。emoji 与 *~ 这类装饰则根本念不出来,
 * 强行念会变成一声怪响。两样都不是角色说的话,该在出声前去掉。
 *
 * 半角标点**只在中文字符紧邻时**才换:英文句子里的半角标点就是它该有的样子,
 * 一律换成全角会把英文念坏。 */
const CJK_NEIGHBOR = '\\u3400-\\u9fff\\u3040-\\u30ff'
function tidyForSpeech(text) {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}]/gu, '') // emoji 与各类符号
    .replace(/[*_~`|<>]+/g, '') // 强调、代码类装饰
    .replace(/\s*\n+\s*/g, ' ') // 换行按空格收 —— 不让它去决定停顿
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*,\\s*`, 'g'), '$1，')
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*;\\s*`, 'g'), '$1；')
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*:`, 'g'), '$1：')
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*[.。]\\s*(?=[${CJK_NEIGHBOR}]|$)`, 'g'), '$1。')
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*\\?`, 'g'), '$1？')
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*!`, 'g'), '$1！')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/** 拼"音频生成"那条的提示词。
 *
 *  这个端点是**生成任意音频**的:环境音、音效、多人对话、旁白它都会做 ——
 *  上游示例里一句提示词就写进了两个男人、鸟鸣、马林巴与刹车声。而我们要的只是
 *  "这一个人把这几句念出来",所以除了音色描述与台词,必须把"别加别的"说死。
 *  不说的话它很可能顺手配一段背景音,那在聊天里是灾难 */
function ttsDesignPrompt(describe, text) {
  return (
    `用这样的嗓音说话——${describe}。` +
    `只念下面这句台词,不要背景音、不要音效、不要音乐、不要旁白:\n${text}`
  )
}

/** 上游报错时,补一句"那接下来该动哪里"。
 *
 *  两类撞得最多:
 *  1) 401 "Invalid X-Api-Key" —— 多半是**拿错了控制台的东西**:火山新版控制台给的
 *     是一个 API Key(API Key 管理),旧版给的是 App ID + Access Token 两个值;
 *     而方舟(Ark)的 ark- 开头那把钥匙属于另一套网关,打这边必然被拒。
 *  2) 403 "requested resource not granted" —— key 是对的,但**那个服务没开通**。
 *     麻烦在于这条端点的报错只回一个资源号(如 volc.service_type.10074),
 *     不说那是哪个产品,也不说去哪儿开通。所以这里把号码翻成产品名。
 *
 *  这一句不替上游解释原因,只把"去哪儿拿什么"说明白 */
function ttsErrorHint(raw, detail) {
  /* 55000000 "resource ID is mismatched with speaker related resource":
     Resource-Id 决定"用哪一代模型 / 哪个计费商品",speaker 决定"哪把嗓子",
     两者必须**同代**。上游这句话只说"对不上",不说哪两样对不上 —— 补三条走法 */
  if (/mismatched with speaker/i.test(raw)) {
    return (
      `${detail} — The Resource ID and the voice ID must come from the same generation. ` +
      `Usual causes: the voice is a Speech 1.0 one while the Resource ID says seed-tts-2.0 ` +
      `(or the reverse); the voice is a cloned one (an S_… or custom ID) but sits in the ` +
      `Built-in slot — cloned voices need seed-icl-*, which the Clone source sets by itself; ` +
      `or that voice was never granted, has no permission, or a cloned one has expired.`
    )
  }
  if (/not granted|resource_id/i.test(raw)) {
    return (
      `${detail} — The key works, but this service is not enabled on your account. ` +
      `Enable it in the console's activation page (开通管理). Which one you need depends ` +
      `on the endpoint: speech synthesis is volc.service_type.10029 (also seed-tts-1.0/2.0), ` +
      `voice cloning is volc.megatts.default (also seed-icl-1.0/2.0), and audio generation — ` +
      `the endpoint behind the "describe" voice source — is volc.service_type.10074.`
    )
  }
  if (!/x-api-key|api[-_ ]?key|unauthor|forbidden|401/i.test(raw)) return detail
  return (
    `${detail} — Use an API Key created in the new Volcano console ` +
    `(API Key management). The App ID / Access Token pair from the old console ` +
    `is a different thing and will not work here. An Ark (ark-…) key belongs ` +
    `to a different gateway and is not accepted here either.`
  )
}

export function registerTtsRoutes(app) {
app.post('/api/tts', rateLimit, async (req, res) => {
  const { text, voice, baseUrl, apiKey, resourceId, model } = req.body || {}
  const say = typeof text === 'string' ? text.trim() : ''
  /* 密钥先 trim 再判空:粘贴带进来的空格/换行会让"非空"成立,
     却在上游看来是一个无效的 key(401)—— 那是最难自查的一类失败 */
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!say) return res.status(400).json({ error: 'Nothing to say' })
  if (!baseUrl) return res.status(400).json({ error: 'Configure your Base URL first' })
  if (!key) {
    return res.status(400).json({ error: 'Set the API key for your TTS config first' })
  }

  const v = voice && typeof voice === 'object' ? voice : {}
  const describe = v.source === 'describe' && typeof v.describe === 'string' ? v.describe.trim() : ''
  const speaker = typeof v.vendorVoice === 'string' ? v.vendorVoice.trim() : ''
  const speed = typeof v.speed === 'number' && Number.isFinite(v.speed) ? v.speed : 0
  /* req_params.model 那两层收(见 TTS_MODEL_VARIANTS):
       1. 内置音色一律不带 —— 文档写明它"仅当 speaker 为复刻音色时需指定";
       2. 复刻音色只在填了合法值时才带。老配置里可能存着"自由输入框"时代留下的
          脏值(最常见的是照 Resource ID 写成 seed-tts-2.0),那种值上游只会回
          InvalidModel —— 用户看不出这是自己两个月前填错的那一格,只能在这里挡掉 */
  const wantModel = typeof model === 'string' ? model.trim() : ''
  const variant = v.source === 'clone' && TTS_MODEL_VARIANTS.includes(wantModel) ? wantModel : ''

  /* 真正发出去的那个 Resource-Id。describe 那条不带它(见下),
     其余一律补成上游认的完整形态 —— 理由见 normalizeResourceId */
  const sentResourceId = describe ? '' : normalizeResourceId(resourceId, v.source)

  const provider = TTS_PROVIDERS.volc
  const path = describe ? provider.design : provider.speech
  /* 规整放在截断之后:规整只会变短,不会把内容顶出上限(见 tidyForSpeech) */
  const bodyText = tidyForSpeech(say.slice(0, TTS_MAX_CHARS))
  /* 全是 emoji / 装饰符号时会被规整成空 —— 那种请求发出去只会换回一句
     参数错,不如在这里就说清 */
  if (!bodyText) return res.status(400).json({ error: 'Nothing pronounceable in that message' })

  const target = ttsTarget(baseUrl, path)
  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const payload = describe
    ? JSON.stringify({
        model: TTS_DESIGN_MODEL,
        text_prompt: ttsDesignPrompt(describe.slice(0, TTS_DESCRIBE_CHARS), bodyText),
        audio_config: {
          /* 这条端点**默认吐 wav**,而下面一律按 mp3 播报 —— 不显式要 mp3,
             浏览器拿到的是 wav 字节却挂着 audio/mpeg 的头,能不能放全看运气 */
          format: 'mp3',
          sample_rate: 24000,
          ...(speed ? { speech_rate: Math.max(-50, Math.min(100, Math.round(speed))) } : {})
        }
        /* 刻意**不传 references**:那条的参数说明里,"纯文本生成"就是
           "不传参考资源,按 text_prompt 中的提示词生成音频" ——
           一段描述直接生成,不需要底子音色,也不需要先买音色槽位 */
      })
    : JSON.stringify({
        user: { uid: 'kimage' },
        req_params: {
          text: bodyText,
          /* 空音色在这里拦掉:上游会回一个难懂的参数错,而真正的原因是
             "这个角色还没挑过音色" */
          speaker,
          audio_params: {
            format: 'mp3',
            sample_rate: 24000,
            ...(speed ? { speech_rate: Math.max(-50, Math.min(100, Math.round(speed))) } : {})
          },
          // 只有复刻 2.0 认这个(见上面 variant 的说明)
          ...(variant ? { model: variant } : {})
        }
      })

  if (!describe && !speaker) {
    return res.status(400).json({ error: 'Pick a voice for this character first' })
  }

  const ac = new AbortController()
  let idleTimer = null
  let idleTimedOut = false
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      ac.abort()
    }, UPSTREAM_TIMEOUT_MS)
  }
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  let reachedUpstream = false
  let proxyJumpFailed = false

  try {
    let upstream = null
    let connectErr = null
    for (const dispatcher of dispatchAttempts(targetUrl)) {
      try {
        upstream = await safeFetch(targetUrl, {
          method: 'POST',
          /* 音频生成那条的文档里没有 X-Api-Resource-Id,所以走它时不带 ——
             一个用不上的头，最好的结果是被忽略，最坏的结果是被拒 */
          headers: volcHeaders(key, sentResourceId),
          body: payload,
          signal: ac.signal,
          dispatcher
        })
        reachedUpstream = true
        break
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        connectErr = e
        if (dispatcher) proxyJumpFailed = true
      }
    }
    if (!upstream) throw connectErr

    /* 上游给的是 HTTP 层的错(401 / 404 / 一整页 HTML):这时还没写头,
       照别的端点那样回一个正常的 JSON 错误 */
    if (!upstream.ok) {
      const raw = await upstream.text()
      /* 鉴权被拒时把"我们实际发出去的东西"也说明白(不含 key 本身)。
         这个 key 只存在用户浏览器里,不把长度与去向说出来,他就没有任何办法
         判断是"我们发错了"还是"key 不对" —— 而这两件事的下一步完全不同:
         前者等我改,后者他去控制台查 */
      const trace =
        upstream.status === 401
          ? ` Sent ${key.length} characters to ${PROD_LIKE ? targetUrl.host : target}.`
          : describe
            ? ''
            : ` Sent Resource ID "${sentResourceId || '(none)'}" with speaker "${speaker || '(none)'}".`
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail: ttsErrorHint(raw, shortDetail(raw)) + trace
      })
    }
    if (!upstream.body) throw new Error('Upstream returned no stream')

    const failed = await pipeTtsAudio(upstream, res, armIdle)
    if (failed) {
      /* 走到这里说明一个字都没写出去,所以还能回一个正常的错误。
         上游那句 message 直接端上来 —— "没有音色授权""Resource-Id 不对"
         这类话只有它说得准。

         再把**我们实际发出去的那两样**写上:这一大类拒绝(资源与音色对不上)
         全都发生在 "Resource-Id + speaker" 这一对上,不回显这两样,用户手里
         就只有一个"对不上",没有任何可以核对的凭据
         (与上面 401 那条回显 key 长度、目标 host 同一个理由) */
      const upstreamText = [failed.message, failed.firstFrame].filter(Boolean).join(' — ')
      const sent = describe
        ? ''
        : `Sent Resource ID "${sentResourceId || '(none)'}" with speaker "${speaker || '(none)'}".`
      const detail = ttsErrorHint(
        upstreamText,
        [sent, upstreamText].filter(Boolean).join(' ')
      ).slice(0, 400)
      return res.status(502).json({
        error: `The TTS service refused this request${failed.code ? ` (code ${failed.code})` : ''}`,
        detail: detail || 'It returned no audio and no explanation.'
      })
    }
    if (!res.writableEnded) res.end()
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    if (res.headersSent) {
      /* 已经在放音频了:只能收场,再回错误码没有意义(与 /api/chat 同一条界线) */
      if (!res.writableEnded) res.end()
      return
    }
    if (aborted && idleTimedOut) {
      return res.status(504).json({
        error: 'Upstream timed out. Try again.',
        detail: `No audio after ${UPSTREAM_TIMEOUT_MS / 1000} seconds.`
      })
    }
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    const hint =
      !reachedUpstream && proxyJumpFailed
        ? 'Tried both the configured UPSTREAM_PROXY and a direct connection — neither worked.'
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

/* 声音克隆:上传一段样本,换一个可以反复用的音色代号。
 *
 * 用的是**自定义音色代号**那条路(custom_speaker_id):代号由我们自己取名,
 * 所以这一步不需要从响应里读任何东西 —— 取好名、发出去、成了就记下来。
 * 样本走 base64 而不是 multipart:现有端点的 body 全是 JSON,而
 * dispatchAttempts 那两次尝试依赖 **body 字符串可复用**,multipart 发一次就消耗掉了。
 *
 * 计费提醒(这一条必须让用户知道):训练本身不贵,而**首次用这个音色合成时会
 * 收一次音色槽位费**。所以我们只建号,不在这里偷偷合成一次。 */
app.post('/api/voice/clone', rateLimit, async (req, res) => {
  const { sample, name, baseUrl, apiKey, customId, language } = req.body || {}
  // 与 /api/tts 同一条:先 trim 再判空(见那边的注释)
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (typeof sample !== 'string' || !sample.startsWith('data:audio/')) {
    return res.status(400).json({ error: 'Attach an audio file (wav, mp3, m4a or ogg)' })
  }
  if (!baseUrl) return res.status(400).json({ error: 'Configure your Base URL first' })
  if (!key) return res.status(400).json({ error: 'Set the API key for your TTS config first' })

  /* 代号有格式要求(上游会拦):8~256 字符、只能数字字母与 - _、
     必须以字母开头、结尾不能是 - 或 _,也不能撞官方前缀。
     "kimage_" 开头天然满足全部条件 */
  const id = typeof customId === 'string' && customId.trim() ? customId.trim() : ''
  if (!/^[A-Za-z][A-Za-z0-9_-]{7,255}$/.test(id) || /[-_]$/.test(id)) {
    return res.status(400).json({
      error: 'That voice id is not usable',
      detail: 'Use 8-256 letters, digits, dashes or underscores, starting with a letter.'
    })
  }

  const comma = sample.indexOf(',')
  const head = sample.slice(5, comma)
  const b64 = sample.slice(comma + 1)
  const format = head.split(';')[0].split('/')[1] || 'mp3'
  /* 大小按 base64 长度反推:解码一遍只为了量尺寸太浪费,
     而 base64 的长度与字节数是固定比例(4 字符 → 3 字节) */
  const bytes = Math.floor((b64.length * 3) / 4)
  if (bytes > MAX_VOICE_SAMPLE) {
    return res.status(400).json({
      error: `That sample is too large (max ${Math.round(MAX_VOICE_SAMPLE / 1024 / 1024)}MB)`
    })
  }

  const target = ttsTarget(baseUrl, TTS_PROVIDERS.volc.clone)
  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const payload = JSON.stringify({
    /* 自定义代号这条路要求 speaker_id 传这个固定值,真正的名字写在下面 */
    speaker_id: 'custom_speaker_id',
    custom_speaker_id: id,
    audio: { data: b64, format },
    ...(typeof language === 'number' ? { language } : {})
    /* 刻意**不带** extra_params.demo_text:上游可以借它顺便合一段试听,
       但那个 demo 音频在训练响应里的位置没有稳定文档 —— 带了就得解析它,
       解析不出来那一段就白费,而它还会拖长注册耗时(上游明说 demo 越长越慢)。
       试听改由前端那枚按钮走一次正常合成(界面会先讲清"这一步开始计费") */
  })

  try {
    let upstream = null
    let connectErr = null
    for (const dispatcher of dispatchAttempts(targetUrl)) {
      try {
        upstream = await safeFetch(targetUrl, {
          method: 'POST',
          headers: volcHeaders(key, ''),
          body: payload,
          dispatcher
        })
        break
      } catch (e) {
        connectErr = e
      }
    }
    if (!upstream) throw connectErr

    const raw = await upstream.text()
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail: ttsErrorHint(raw, shortDetail(raw))
      })
    }
    /* 上游的训练响应形状没有稳定文档,所以这里不解析它的内容 ——
       代号是我们自己取的(见上面),成没成由 HTTP 状态说明。
       但把原始响应留给前端放进回执里,出问题时用户手里有东西可查 */
    res.json({ vendorVoice: id, bytes, name: typeof name === 'string' ? name : '', raw: shortDetail(raw) })
  } catch (e) {
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    const where = PROD_LIKE ? targetUrl.host : target
    return res.status(502).json({
      error: 'Upstream request failed',
      detail: `${where} — ${reason}. ${CONNECT_HINTS[code] || ''}`
    })
  }
})


}
