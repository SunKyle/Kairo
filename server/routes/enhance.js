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
import { ENHANCE_PROMPTS, ENHANCE_TEMPERATURE } from '../enhancePrompts.js'

/* 目标出图模型对提示词结构的偏好。改写是写给下游那个模型看的,
   同一段文字喂给 gpt-image 和喂给 SD 系模型,该有的样子完全不同:
   前者自己会再改写一遍,堆标签只会被削掉;后者恰恰靠标签密度吃饭。
   表里没有的厂商走 GENERIC —— 不硬套已知风格,宁可给一句中性的结构建议。 */
const NATURAL_STYLE = `Structure: natural-language sentences with dense, concrete detail. A narrative flow is welcome and multi-clause sentences are fine.`
const TARGET_STYLE = {
  // 服务端还会用 GPT 再改写一次,所以"少而清楚"比"多而杂"更容易被保留下来
  openai: `Structure: one flowing descriptive sentence. This model rewrites prompts on its own before generating, so stacked keyword tags and piled-up adjectives tend to get trimmed or conflict — say fewer things, more clearly.`,
  ark: NATURAL_STYLE,
  dashscope: NATURAL_STYLE
}
const GENERIC_STYLE = `Structure: a comma-separated series of short phrases rather than full sentences. Keyword density matters more than grammar.`

/* 图生图时的附加要求。改写模型看不到参考图,只能靠用户这句话判断,
   不点明这一点它会把整幅画面重新描述一遍 —— 参考图里已有的东西白写一次,
   还会和参考图打架;更糟的是它可能编出参考图里根本没有的元素。 */
const REF_NOTE = `\n\nThis is an image-to-image edit. The image model receives a reference image that you cannot see.
- Describe only what should change and what must be preserved. Do not re-describe the whole scene.
- Never assume or invent details about the reference image beyond what the prompt itself states.`

/** 把目标模型与其结构偏好拼成一段附加说明;认不出来就只说清目标是谁 */
function targetNote(vendor, model) {
  const style = TARGET_STYLE[vendor] || GENERIC_STYLE
  return `\n\nTarget image model: ${model || 'unspecified'}\n${style}`
}



export function registerEnhanceRoute(app) {
app.post('/api/enhance', rateLimit, async (req, res) => {
  const { prompt, textModel, baseUrl, apiKey, mode, targetVendor, targetModel, hasRef, image } =
    req.body || {}

  /* 识图那条的输入。图是 data URL —— 与生图、局部编辑两条路一致。
     认不出来的图按"没给"处理:那时它会退回文本那几档,而不是把一张空图发给上游 */
  const visionRef = typeof image === 'string' && image.startsWith('data:image') ? image : ''

  /* 只认这几档,其余(含老前端不传)一律按保守档处理。
     character 是"把一句话拆成角色设定",vision 是"把一张图读成角色设定",
     summary 是"把一批滑出窗口的消息压成一段长期记忆",
     photo 是"给一张对话里的图当摄影指导",
     四者都不是在改写出图提示词 */
  const enhanceMode =
    mode === 'creative'
      ? 'creative'
      : mode === 'character'
        ? 'character'
        : mode === 'vision' && visionRef
          ? 'vision'
          : mode === 'summary'
            ? 'summary'
            : mode === 'photo'
              ? 'photo'
              : 'quick'

  /* 拆角色、识图、压记忆、摄影指导这四档都不加图生图说明与目标模型偏好:
     前三条与"改写出图提示词"无关,加上只会让它们顺手把画面信息也写进去;
     摄影指导更相反 —— 它补的正是"怎么拍",而 REF_NOTE 那句
     "不要重新描述整个场景"与它的职责直接冲突 */
  const systemPrompt =
    enhanceMode === 'character' ||
    enhanceMode === 'vision' ||
    enhanceMode === 'summary' ||
    enhanceMode === 'photo'
      ? ENHANCE_PROMPTS[enhanceMode]
      : ENHANCE_PROMPTS[enhanceMode] +
        (hasRef ? REF_NOTE : '') +
        targetNote(targetVendor, targetModel)

  /* 识图可以没有文字输入 —— 图本身就是全部输入,所以只拦"两样都没有" */
  if (!prompt && !visionRef) {
    return res.status(400).json({ error: 'Enter a prompt first' })
  }
  if (!baseUrl) {
    return res.status(400).json({ error: 'Configure your Base URL first' })
  }
  // 模型名单独配:出图模型是图像模型,打不通 /chat/completions(识图同理,要的是能看图的对话模型)
  if (!textModel) {
    return res.status(400).json({
      error:
        enhanceMode === 'vision'
          ? 'Set a vision model in API settings first'
          : 'Set a text model in API settings first'
    })
  }

  const target = baseUrl.replace(/\/+$/, '') + '/chat/completions'

  // 目标校验:协议 + 网段(见 assertSafeTarget)。不通过就没必要再往下走
  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // 前端点"终止"会断开连接;这里同步中断对上游的请求,
  // 并借此判断连接是否还在,避免往已断开的响应里写数据。
  // 另外挂一个超时:上游长时间不返回时主动中断,别把连接一直占着
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, UPSTREAM_TIMEOUT_MS)
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  /* 识图那条走多模态:user 的 content 从字符串换成数组,文字在前、图在后
     (OpenAI 兼容的写法,豆包/百炼/OpenAI 都按这一套收 data URL)。
     图之外没有文字输入时补一句中性的指令 —— content 数组里必须有一段 text,
     这既是多数实现的要求,也避免上游对着空指令自由发挥 */
  const userContent = visionRef
    ? [
        { type: 'text', text: prompt || 'Describe the person in this image.' },
        { type: 'image_url', image_url: { url: visionRef } }
      ]
    : prompt

  const buildBody = () =>
    JSON.stringify({
      model: textModel,
      messages: [
        // 顺序有讲究:先两档的基本规则,再图生图的变更导向,最后目标模型的结构偏好
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: ENHANCE_TEMPERATURE[enhanceMode]
    })

  // 与 /api/generate 同一套:代理那一跳连不上时再直连试一次(见 dispatchAttempts)。
  // 同样必须留在 try 外面 —— catch 里要读它们(同 /api/generate 那段注释)
  let upstream = null
  let connectErr = null
  let proxyJumpFailed = false
  let reachedUpstream = false

  try {
    for (const dispatcher of dispatchAttempts(target)) {
      try {
        upstream = await safeFetch(target, {
          method: 'POST',
          headers,
          body: buildBody(),
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

    const text = await upstream.text()

    if (!upstream.ok) {
      // 上游报错可能很长(堆栈/回显整段提示词),截断后再回显
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail: text.slice(0, 600)
      })
    }

    // 取第一条回复的正文;解析失败或字段缺失都按"没拿到文本"处理
    let out = ''
    try {
      out = String(JSON.parse(text)?.choices?.[0]?.message?.content || '').trim()
    } catch {
      out = ''
    }
    if (!out) {
      return res.status(502).json({
        error: 'Upstream returned no text to use',
        detail: text.slice(0, 600)
      })
    }

    res.json({ prompt: out })
  } catch (e) {
    // 响应已经发出,无需也无法再回
    if (res.headersSent) return
    // 超时中断与"用户点了终止"都抛 AbortError,靠 timedOut 区分:
    // 前者要给出明确回执,后者静默收场
    if (e?.name === 'AbortError') {
      if (timedOut) {
        return res.status(504).json({
          error: 'Upstream timed out. Try again.',
          detail: `No response after ${UPSTREAM_TIMEOUT_MS / 1000} seconds. Try again.`
        })
      }
      return
    }
    // undici(Node fetch)遇到连接层失败时只抛 "fetch failed",
    // 真正的原因(DNS/TCP/TLS)藏在 e.cause 里,这里一并透出,否则无法排查
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    // 与 /api/generate 同一套措辞:两跳都试过了,就别再让人去"配置 UPSTREAM_PROXY"
    const hint =
      !reachedUpstream && proxyJumpFailed
        ? 'Tried both the configured UPSTREAM_PROXY and a direct connection — neither worked. ' +
          'Check that the proxy is running and its node is healthy, or unset UPSTREAM_PROXY to go direct.'
        : CONNECT_HINTS[code] || ''
    // 生产环境只回显目标主机名:完整地址会被当成内网探测器用
    const where = PROD_LIKE ? targetUrl.host : target
    return res.status(502).json({
      error: 'Upstream request failed',
      detail: `${where} — ${reason}. ${hint}`
    })
  } finally {
    clearTimeout(timer)
  }
})

/**
 * 角色对话代理。与 /api/enhance 同源(都打 /chat/completions),但它是**流式**的:
 * 上游回的是 SSE,这一层把它收窄成"每行一个 JSON",前端只认一种事件。
 *
 * 为什么要重新打包而不是原样透传:与 api.ts 的 imagesFrom 摊平两种响应形状
 * 是同一条理由 —— 中转站的字段名、reasoning_content 之类的额外字段、
 * [DONE] 的写法各家都可能不同,把这些挡在服务端这一处,
 * 前端就不用为每家中转各写一段解析。
 */

}
