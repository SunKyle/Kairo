#!/usr/bin/env node
/* ===== 后端每个端点的冒烟 ==============================================
   与 probe:chat-photo 的分工:那条验的是**某一条路的业务正确性**;
   这条只问一句话 —— **打完这些请求之后,进程还活着吗**。

   为什么值得单独问这一句:模块化之后,一个漏掉的 import 会让整个 Node
   进程退出,而从那之后**所有**端点都变成 ECONNREFUSED。只看单个请求的
   返回码是不够的:它给你一个 500,你以为是那条路自己坏了,其实是服务没了
   (2026-10-06 的语音那次就是:崩在 tts.js 一行上,表现却是"语音不能用")。

   两条纪律:
   1. **不碰真上游**。出图/对话/语音那几条的 baseUrl 一律写成 127.0.0.1:9
      (丢弃端口),断言的是"拿到了一个响应",不是"请求成功"。
   2. **429 记为失败**。端点有限流(30 次/分钟/IP),被挡掉的那几条等于
      根本没进处理器 —— 那是最危险的一种"绿"。

   需要后端已经在跑(npm run dev)。默认 http://127.0.0.1:3000,用 --base 改。
   用法:npm run smoke:api
   -------------------------------------------------------------------- */

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const BASE = arg('base', 'http://127.0.0.1:3000').replace(/\/$/, '')
/* 丢弃端口:连接必然失败,于是请求走完整条前置逻辑也出不了网。
   9 在 undici 的禁用端口表里,连 TCP 都不会真的发出去 */
const DEAD = 'http://127.0.0.1:9/'
const TIMEOUT_MS = 20_000

/* 每条都尽量往里走:能过校验的过校验,过不去的给一个能过校验的最小体,
   目的是让**处理器那一整段**都真的执行一遍 */
const cases = [
  { name: 'GET  /api/health', method: 'GET', path: '/api/health' },
  { name: 'POST /api/chat', method: 'POST', path: '/api/chat', body: {} },
  { name: 'POST /api/generate', method: 'POST', path: '/api/generate', body: {} },
  { name: 'POST /api/enhance', method: 'POST', path: '/api/enhance', body: {} },
  { name: 'POST /api/test', method: 'POST', path: '/api/test', body: {} },
  {
    name: 'POST /api/tts',
    method: 'POST',
    path: '/api/tts',
    body: { text: 'hi', baseUrl: DEAD, apiKey: 'x', voice: { source: 'builtin', vendorVoice: 'v' } }
  },
  {
    /* describe 那一档走的是另一条上游端点,还会用到 volcHeaders / randomUUID ——
       两条都打一次,免得只有一条被覆盖 */
    name: 'POST /api/tts (describe)',
    method: 'POST',
    path: '/api/tts',
    body: { text: 'hi', baseUrl: DEAD, apiKey: 'x', voice: { source: 'describe', describe: 'warm' } }
  },
  {
    name: 'POST /api/voice/clone',
    method: 'POST',
    path: '/api/voice/clone',
    body: { baseUrl: DEAD, apiKey: 'x' }
  }
]

async function hit(c) {
  const init = { method: c.method, signal: AbortSignal.timeout(TIMEOUT_MS) }
  if (c.method === 'POST') {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(c.body ?? {})
  }
  try {
    const res = await fetch(BASE + c.path, init)
    const text = (await res.text()).slice(0, 90).replace(/\s+/g, ' ')
    return { status: res.status, text }
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? '超时' : String(e?.cause?.code || e?.message || e) }
  }
}

const health = async () => {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) })
    return await r.text()
  } catch {
    return '(无响应)'
  }
}

console.log(`对 ${BASE} 逐端点冒烟（全部不碰真上游）\n`)

const before = await health()
if (before !== '{"ok":true}') {
  console.log(`✗ 打之前后端就不健康:${before}`)
  console.log('  先起后端(npm run dev)再来,或用 --base 指到别处')
  process.exit(1)
}

let failed = 0
for (const c of cases) {
  const r = await hit(c)
  if (r.error) {
    console.log(`  ✗ ${c.name.padEnd(26)} 连接失败:${r.error}`)
    failed++
  } else if (r.status === 429) {
    console.log(`  ✗ ${c.name.padEnd(26)} HTTP 429 —— 被限流,没进处理器(等一分钟再跑)`)
    failed++
  } else if (r.status >= 500) {
    /* 5xx 不一定是错:上游不可达本来就会回 502。这里只记出来给人看 */
    console.log(`  ~ ${c.name.padEnd(26)} HTTP ${r.status}  ${r.text}`)
  } else {
    console.log(`  ✓ ${c.name.padEnd(26)} HTTP ${r.status}  ${r.text}`)
  }
}

console.log('\n最要紧的一条 —— 打完之后进程还在吗:')
const after = await health()
if (after === '{"ok":true}') {
  console.log('  ✅ /api/health 仍是 {"ok":true}')
} else {
  console.log(`  ❌ /api/health → ${after} —— 有请求把进程打死了`)
  failed++
}

console.log(failed ? `\n${failed} 条失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
