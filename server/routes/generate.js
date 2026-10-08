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

const GEMINI_RATIOS = new Set(['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])
export function geminiRatio(size) {
  if (!size || size === 'auto') return ''
  const m = String(size).match(/^(\d{1,5})x(\d{1,5})$/i)
  if (!m) return ''
  const w = Number(m[1])
  const h = Number(m[2])
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const d = gcd(w, h)
  const r = `${w / d}:${h / d}`
  return GEMINI_RATIOS.has(r) ? r : ''
}

export function registerGenerateRoute(app) {
app.post('/api/generate', rateLimit, async (req, res) => {
  const {
    prompt,
    size = '1024x1024',
    /* **不给 n 兜底值**:Ark 的图片 API 里没有这个字段,前端在那种厂商上根本
       不发它 —— 这里再补一个 1 就等于替用户把一个无效字段塞回去,整条 400。
       所以"没发"要能一路传递到请求体(见下面各分支的 Number.isFinite(n)) */
    n,
    model,
    baseUrl,
    apiKey,
    responseFormat,
    image,
    images,
    quality,
    background,
    seed,
    watermark,
    refUpload,
    vendor,
    protocol
  } = req.body || {}

  if (!prompt) {
    return res.status(400).json({ error: 'Enter a prompt first' })
  }
  // baseUrl 必须由用户显式提供;apiKey 允许为空(部分本地服务无需鉴权)
  if (!baseUrl) {
    return res.status(400).json({ error: 'Configure your Base URL first' })
  }

  /* 参考图:新前端发 images(数组)—— 角色的设定图就是"多张视图一起当参考";
     老前端仍发 image(单张)。两边都收,免得缓存里的旧包打过来时参考图被静默丢掉。
     上游收不收多张由它自己决定,我们只如实转发 */
  const refs = (Array.isArray(images) ? images : image ? [image] : []).filter(
    (s) => typeof s === 'string' && s.startsWith('data:image')
  )
  const isImageGen = refs.length > 0
  const isGemini = protocol === 'gemini'

  if (isGemini && !model) {
    return res.status(400).json({ error: 'Set an image model in API settings first' })
  }

  /* 两条协议的路径不一样。谁走哪条由前端按 (厂商, 模型) 判定 ——
     中转站自己也是按模型名分流,我们跟它不一致就会打到它不实现的那条路上
     (实测 Gemini 系模型打 /images/generations 会回
     "Images API is not supported for this platform") */
  const base = baseUrl.replace(/\/+$/, '')
  const target = isGemini
    ? `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`
    : // OpenAI 的图生图走 /images/edits,其余厂商仍在 /images/generations 上用 multipart 传参考图
      base + (isImageGen && vendor === 'openai' ? '/images/edits' : '/images/generations')

  // 目标校验:协议 + 网段(见 assertSafeTarget)。不通过就没必要再往下走
  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const headers = {}
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  /* quality / background 是 OpenAI 系的扩展参数,不少接口不认,所以只在显式选择时带上。
     Gemini 那条路一个都不带:原生请求体里没有这些字段,多给一个未知字段会被它拒掉
     (前端的厂商能力表已经把这两项标成不支持,正常也传不过来)
     seed 不同:它是用户自己填的"复现键",两条协议各有它的位置 ——
     OpenAI 系放请求体顶层(所以归在这批里),Gemini 放 generationConfig(见下面) */
  const extras = isGemini
    ? {}
    : {
        ...(responseFormat ? { response_format: responseFormat } : {}),
        ...(quality ? { quality } : {}),
        ...(background ? { background } : {}),
        ...(Number.isFinite(seed) ? { seed } : {}),
        /* 水印开关。只认真正的布尔值:老前端不发这一项,新前端在厂商认它时
           发 false。**这里不能按 truthy 判** —— 我们唯一会发的值就是 false,
           而它的意思正是"别盖",truthy 判断会把它整个丢掉(与上面几个
           "有值才带"的参数不是一个规矩,所以单独写一句) */
        ...(typeof watermark === 'boolean' ? { watermark } : {})
      }

  /* size 如实转发(OpenAI 那条路),包括字面量 'auto' —— 它是上游的一个真实取值
     (模型按 prompt 定比例),跟"不发这个参数"不是一回事:不发时上游用自己的默认尺寸,
     多数是 1:1。哪些厂商认 auto 由前端判断(厂商表在 src/api.ts,只有那里知道
     baseUrl 是谁),不认的厂商候选里不会出现 auto,所以这里不需要再拦一道。
     注意 quality / background 的 auto 不同:那两个是我们的"不传"哨兵值,
     上游没有对应的 'auto' 取值,所以仍然只在显式选择时才带上。
     Gemini 那条路是例外:它根本没有 size 参数,size 会被约分成宽高比(见 geminiRatio)。 */

  /* 两条路的请求体完全不同,各自成段。
     做成"每次调用现造一份"而不是算好一个变量:代理那一跳失败要再直连试一次,
     而 FormData / 字符串体发过一次就被消耗掉了,得能重来。 */
  let buildBody
  if (isGemini) {
    headers['Content-Type'] = 'application/json'
    const ratio = geminiRatio(size)
    // 多图靠 candidateCount,只有真要不止一张时才带,不给默认路径添风险
    const gen = {}
    if (ratio) gen.imageConfig = { aspectRatio: ratio }
    if (Number.isFinite(n) && n > 1) gen.candidateCount = n
    // 原生协议里 seed 在 generationConfig 下;图像模型认不认由上游决定(见厂商能力表)
    if (Number.isFinite(seed)) gen.seed = seed
    /* 图生图在原生协议里不是另一个端点,而是同一个端点多给一段 parts:
       文字在前、参考图在后。mime 必须从 data URL 里读,不能写死 ——
       参考图可能是历史里的 PNG/WebP(原样带过来),也可能是
       compressImage 压过的 JPEG */
    const parts = [{ text: prompt }]
    /* 原生协议天然能收多张:每张参考图各占一段 inlineData,
       所以角色的"正脸 + 全身 + 转面"可以一起送上去 */
    for (const ref of refs) {
      const [meta, b64] = ref.split(',')
      const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg'
      parts.push({ inlineData: { mimeType: mime, data: b64 } })
    }
    buildBody = () =>
      JSON.stringify({
        contents: [{ parts }],
        ...(Object.keys(gen).length ? { generationConfig: gen } : {})
      })
  } else if (isImageGen && refUpload === 'json') {
    /* 参考图走请求体里的 image 字段的厂商(豆包 Seedream 是这一家):
       它收的是 data URL 或公网 URL 的字符串,多张就给数组 ——
       官方字段类型就是 string|string[]。
       **它不收表单文件字段**,所以这条不能跟下面 multipart 那条合并:
       从前 Ark 也被塞进 multipart,上游只会回一个"参数不对" */
    headers['Content-Type'] = 'application/json'
    buildBody = () =>
      JSON.stringify({
        model: model || undefined,
        prompt,
        ...(Number.isFinite(n) ? { n } : {}),
        ...(size ? { size } : {}),
        // 单张给字符串、多张给数组:上游两种都认,而字符串是最省事的那种
        image: refs.length > 1 ? refs : refs[0],
        ...extras
      })
  } else if (isImageGen) {
    // OpenAI 系图生图:gpt-image 等模型不接受 JSON 里的 data-url base64,
    // 必须走 multipart 文件上传(或在个别服务下传公网 URL)
    buildBody = () => {
      const fd = new FormData()
      if (model) fd.append('model', model)
      fd.append('prompt', prompt)
      if (Number.isFinite(n)) fd.append('n', String(n))
      if (size) fd.append('size', size)
      for (const [k, v] of Object.entries(extras)) fd.append(k, String(v))
      /* 单张仍用 image —— 与一直以来的行为完全一致,不给最常见的那条路添风险;
         多张才改用 image[],那是 OpenAI 的 /images/edits 收多图时的字段名。
         字段名各家未必相同,上游拒绝时会原样透出来,照提示改即可 */
      const field = refs.length > 1 ? 'image[]' : 'image'
      refs.forEach((ref, i) => {
        const [meta, b64] = ref.split(',')
        const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg'
        const type = mime.includes('png') ? 'png' : 'jpeg'
        fd.append(
          field,
          new Blob([Buffer.from(b64, 'base64')], { type: mime }),
          `image-${i + 1}.${type}`
        )
      })
      return fd // fetch 自动设置 multipart boundary
    }
  } else {
    headers['Content-Type'] = 'application/json'
    buildBody = () =>
      JSON.stringify({
        model: model || undefined,
        prompt,
        ...(Number.isFinite(n) ? { n } : {}),
        ...(size ? { size } : {}),
        ...extras
      })
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

  /* 依次尝试 [代理, 直连](没配代理就只有直连一次,见 dispatchAttempts)。
     换下一跳只看 fetch 本身有没有抛错:上游回了错误码是"这条配置能不能用"的答案,
     重试没有意义;用户点终止与超时中断抛 AbortError,同样直接交出去。
     reachedUpstream 用来区分"压根没连上"与"连上了但读响应失败",
     前者才该提代理,后者该按原来的连接码给提示。

     这几个游标必须留在 try 外面:catch 里要看它们,而 catch 是 try 的兄弟块 ——
     写在 try 里的 let 它看不见。之前写在里面,于是每一次连接失败都抛
     ReferenceError("reachedUpstream is not defined"),异步处理器又没人接,
     整个进程被带崩,前端只看到一句 Request failed (500) */
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
      /* 上游报错可能很长(整页 HTML,或回显了整段提示词的 JSON),先截断再回显 ——
         与 /api/enhance 那条同一套规矩 */
      const raw = text.slice(0, 600)
      let detail = raw
      /* 上游挂掉时回的多是 Cloudflare / nginx 的整页 HTML。塞进错误框既读不了也刷屏,
         所以只留标题那句,再补一句这是谁的问题。
         这条必须排在最前:HTML 里可能同时命中下面那些关键词 */
      if (looksLikeHtml(text)) {
        const title = htmlTitle(text)
        detail =
          `The upstream host returned an error page (HTTP ${upstream.status})` +
          (title ? `: ${title}` : '.') +
          ' This is on their side — retry in a few minutes.'
      } else if (/Images API is not supported for this platform/i.test(text)) {
        detail =
          'This endpoint has no OpenAI-compatible Images API — it routes by model name, and Gemini-family image models (banana / nano-banana / gemini-*-image) need the native :generateContent path instead. Original error: ' +
          raw
      } else if (/base64_input_not_supported|b64传参|multipart/i.test(text)) {
        detail =
          "This endpoint doesn't accept the reference image as a file upload. It may need a public image URL or a specific file field name — check the image input spec of the endpoint behind your Base URL. Original error: " +
          raw
      } else if (/unknown (parameter|argument)|unrecognized|unexpected.*parameter|invalid.*(parameter|param)/i.test(text)) {
        /* 上游说"参数不对"。这里从前一律译成"多半是 quality / background,
           去把厂商选对"—— 那句话把人带偏过:Ark 的 InvalidParameter 也可能是
           它根本没有的**别的**字段(例如 n),或者尺寸越界。真正点名的是上游
           自己那一句,所以人话只说到"这是参数层面的拒绝",原话照旧附在后面 */
        detail =
          "The upstream rejected the request as a parameter error. The original message below says which one: " +
          "usually a field this API doesn't define (quality / background are OpenAI-only extensions, and Ark's " +
          'image API has no `n`), a size outside its range, or a model your account cannot use. ' +
          'Original error: ' +
          raw
      } else {
        /* 兜底:JSON 里的 message 才是给人看的那句,整个 JSON 塞过去只会让人先看到
           一堆括号。上游还常常把模型本人说的话放进 message(比如"请先上传参考图"),
           那更是这里唯一有用的信息,所以优先把它摆出来,错误码跟在后面当注脚 */
        try {
          const j = JSON.parse(text)
          const m = j?.error?.message ?? j?.message
          if (typeof m === 'string' && m.trim()) {
            // 数值型的 code(如 Google 的 400)是冗余的 —— HTTP 状态里已经有了
            const code = [j?.error?.code, j?.error?.type, j?.error?.status, j?.code].find(
              (c) => typeof c === 'string' && c
            )
            detail = code ? `${m.trim()} (${code})` : m.trim()
          }
        } catch {
          /* 不是 JSON 就保持原样 */
        }
      }
      /* 鉴权被拒时,把"我们实际发出去的东西"也说明白(不含 key 本身)。
         同一个 401 在桌面上和手机上长得一模一样,成因却常常是两件事:
         这台设备上**根本没配 key**(配置只存在各自浏览器的 localStorage 里,
         不跟账号走,也不会从桌面同步过去),或者 key 被手机键盘改过。
         不说出长度,用户没有任何办法分辨 —— 而这两者的下一步完全不同 */
      const authTrace =
        upstream.status === 401 || upstream.status === 403
          ? apiKey
            ? ` Sent ${String(apiKey).length} characters to ${PROD_LIKE ? targetUrl.host : target}. If the key on your other device differs in length, this one was typed or pasted wrong.`
            : ' No API key was sent: the active config in this browser has none. Configs are stored per browser and do not sync across devices — open Interface Settings on this device and add the key.'
          : ''
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail: detail + authTrace
      })
    }

    /* 上游回了 200,给的却是一整页 HTML —— 多半是 Base URL 里的路径写错了,
       网站把它的 404 页面配成 200 返回。照原样透传的话前端会炸出一句
       "Unexpected token '<'",对用户没有任何意义,所以这里就判成网关错误。
       两条协议都要求响应是 JSON,所以这个判断不会误伤正常结果 */
    if (looksLikeHtml(text)) {
      const title = htmlTitle(text)
      return res.status(502).json({
        error: 'Upstream returned a web page instead of an API response',
        detail:
          `HTTP ${upstream.status} from ${PROD_LIKE ? targetUrl.host : target}` +
          (title ? ` (page title: ${title})` : '') +
          '. The path is probably wrong — check the Base URL in API settings.'
      })
    }

    // 透传上游返回体
    res.setHeader('Content-Type', 'application/json')
    res.send(text)
  } catch (e) {
    // 响应已经发出,无需也无法再回
    if (res.headersSent) return
    // 超时中断与"用户点了终止"都抛 AbortError,靠 timedOut 区分:
    // 前者要给出明确回执,后者静默收场
    if (e?.name === 'AbortError') {
      if (timedOut) {
        return res.status(504).json({
          error: 'Upstream timed out. Try again or use fewer images.',
          detail: `No response after ${UPSTREAM_TIMEOUT_MS / 1000} seconds. Try again or use fewer images.`
        })
      }
      return
    }
    // undici(Node fetch)遇到连接层失败时只抛 "fetch failed",
    // 真正的原因(DNS/TCP/TLS)藏在 e.cause 里,这里一并透出,否则无法排查
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    /* 连不上且动过代理时,原样的提示会让人跑去"配置 UPSTREAM_PROXY" ——
       可它早就配好了,真正的毛病是那一跳不通。这时说清两跳都试过、问题在代理 */
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


}
