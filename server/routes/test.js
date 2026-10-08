import {
  assertSafeTarget,
  CONNECT_HINTS,
  dispatchAttempts,
  dispatcherFor,
  htmlTitle,
  looksLikeHtml,
  PROD_LIKE,
  rateLimit,
  safeFetch,
  shortDetail,
  UPSTREAM_TIMEOUT_MS
} from '../core.js'

export function registerTestRoutes(app) {
app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

/** 从 GET /models 的响应里取模型 id。两条协议的回法不一样:
    OpenAI 是 { data: [{ id }] },Gemini 是 { models: [{ name: 'models/xxx' }] } */
function parseModelIds(text, protocol) {
  try {
    const j = JSON.parse(text)
    if (protocol === 'gemini') {
      return (j?.models || [])
        .map((m) => String(m?.name || '').replace(/^models\//, ''))
        .filter(Boolean)
    }
    return (j?.data || []).map((m) => String(m?.id || '')).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 连通性测试。两段,先问再探:
 *   ① GET /models —— 顺带回答"这个模型在不在它那儿";
 *   ② 没有 /models 的站(那是可选端点,不少中转不实现),退回缺参探测:
 *      发一个空 JSON 到真实端点,上游因缺参数回 400,而 400 恰好证明地址、
 *      路径前缀、密钥这条链是通的 —— 401/403 才是密钥的问题。
 * 两段都不真的生成图,所以点几次都不花钱。
 *
 * 判决发回前端,文案由前端拼 —— 与 /api/generate 同一套分工。
 */
app.post('/api/test', rateLimit, async (req, res) => {
  const { baseUrl, apiKey, model, protocol, kind } = req.body || {}
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) {
    return res.status(400).json({ error: 'Enter a valid Base URL' })
  }

  /* 打真实端点而不是固定的某个探活地址:测试要回答的是"这条配置能不能用",
     而能被用起来的前提正是这段路径前缀对得上 */
  const isGemini = protocol === 'gemini'
  const target = isGemini
    ? `${base}/v1beta/models/${encodeURIComponent(model || '')}:generateContent`
    : base + (kind === 'text' ? '/chat/completions' : '/images/generations')

  try {
    // 两个候选地址同主机,校验一次就够(它查的是协议与网段)
    await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const started = Date.now()
  const ac = new AbortController()
  // 两段共用一份预算:测试不该等两分钟(生图的超时是 120s),十五秒没动静就当不可达
  const timer = setTimeout(() => ac.abort(), 15_000)
  try {
    /* —— ① GET /models ——
       比缺参探测多说一件事:目标模型在不在它给的清单里。 */
    const listUrl = isGemini ? `${base}/v1beta/models` : `${base}/models`
    try {
      const listed = await safeFetch(listUrl, {
        method: 'GET',
        headers,
        signal: ac.signal,
        dispatcher: dispatcherFor(listUrl)
      })
      const text = await listed.text()
      if (listed.ok) {
        /* 回了 200 却是一整页 HTML:地址里少写了 /v1 这类前缀时最常见,
           网站把它的首页给了你。当成上游出错,别报"连上了" */
        if (looksLikeHtml(text)) {
          return res.json({
            ok: false,
            code: 'server',
            status: listed.status,
            ms: Date.now() - started,
            detail: shortDetail(text)
          })
        }
        const ids = parseModelIds(text, protocol)
        return res.json({
          ok: true,
          via: 'models',
          status: listed.status,
          ms: Date.now() - started,
          /* 清单为空(有些站回 200 + 空数组)或没填模型时,判断不了在不在 —— 交给前端少说一句 */
          modelListed:
            model && ids.length
              ? ids.some((id) => id.toLowerCase() === String(model).toLowerCase())
              : null
        })
      }
      // 密钥被拒就到此为止:这一层比探测那条路更干净(请求里连参数都没有)
      if (listed.status === 401 || listed.status === 403) {
        return res.json({
          ok: false,
          code: 'auth',
          status: listed.status,
          ms: Date.now() - started,
          detail: shortDetail(text)
        })
      }
      // 其余(404/405/400…)一律理解为"这家没有 /models",落到下面的探测
    } catch (e) {
      // 网络层的问题再试一次也是同样的结果,直接报
      const code = e?.cause?.code || e?.code || ''
      const timedOut = e?.name === 'AbortError'
      return res.json({
        ok: false,
        code: timedOut ? 'timeout' : 'network',
        status: null,
        ms: Date.now() - started,
        detail: timedOut
          ? 'No response within 15 seconds. The endpoint may be unreachable or blocked.'
          : CONNECT_HINTS[code] || e?.message || 'Request failed'
      })
    }

    /* —— ② 缺参探测 —— */
    const upstream = await safeFetch(target, {
      method: 'POST',
      headers,
      body: '{}',
      signal: ac.signal,
      dispatcher: dispatcherFor(target)
    })
    const text = await upstream.text()
    const ms = Date.now() - started
    const status = upstream.status

    // 200(不该发生)与"缺参数被拒"都算通:端点存在、密钥被接受了
    if (upstream.ok || status === 400 || status === 422) {
      return res.json({ ok: true, via: 'probe', status, ms })
    }
    // 限流也算通 —— 它同样要过了鉴权才会被限
    if (status === 429) return res.json({ ok: true, via: 'probe', status, ms })

    const code =
      status === 401 || status === 403
        ? 'auth'
        : status === 404 || status === 405
          ? 'endpoint'
          : 'server'
    return res.json({ ok: false, code, status, ms, detail: shortDetail(text) })
  } catch (e) {
    const code = e?.cause?.code || e?.code || ''
    const timedOut = e?.name === 'AbortError'
    return res.json({
      ok: false,
      code: timedOut ? 'timeout' : 'network',
      status: null,
      ms: Date.now() - started,
      detail: timedOut
        ? 'No response within 15 seconds. The endpoint may be unreachable or blocked.'
        : CONNECT_HINTS[code] || e?.message || 'Request failed'
    })
  } finally {
    clearTimeout(timer)
  }
})

/* ===== 请求体解析失败兜底 ============================================
   express.json 在请求体超限时抛 entity.too.large,而 Express 默认的错误处理
   会回一整页 HTML(开发模式下还带调用栈)。前端拿到非 JSON 只能显示一句
   "Request failed (413)" —— 用户根本不知道是"这张图太大",更不知道该做什么。
   这里翻成一句能照着做的话。
   放在所有路由之后、静态托管之前:这样 /api/* 的解析错误不会落进 SPA 兜底。
   -------------------------------------------------------------------- */

}
