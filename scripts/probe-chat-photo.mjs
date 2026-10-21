/* ===== 对话出图整条链的端到端探针（不花钱，也不联网）=====================
 *
 *  起一个假上游，把 Kairo 自己的服务端跑起来，然后打它三个端点：
 *  `/api/chat`（流式）→ `/api/enhance`（photo 档）→ `/api/generate`。
 *
 *  —— 为什么需要它 ——
 *
 *  单测只能证明"纯函数算得对"。这一条链上真正会出事的地方全在接缝上，
 *  而它们的表现都是**静默**的：
 *  - 工具调用的 arguments 被流式劈开 → 拼不回去时心情和图一起消失，正文却一字不差；
 *  - 正文被元数据拖住 → 话先攒着、流末才一次性冒出来，看着像"卡住了"；
 *  - 模型压根没调工具 → 没有提示的话，用户只会觉得"它今天怎么没情绪"；
 *  - 上游不支持 tools → 被当成普通报错，用户不知道该换模型。
 *  四种都不会报错，只会"不太对味"。
 *
 *  用法：node scripts/probe-chat-photo.mjs
 *  退出码 0 = 全过。
 * ==================================================================== */

import { spawn } from 'node:child_process'
import http from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM_PORT = 18431
const APP_PORT = 18432

/* ===== 假上游 ========================================================= */

/** 一次 `/api/chat` 要吐出来的正文。由每个用例自己设 */
let chatReply = ''
/** 这一轮要发的工具调用：{ name, args }。null = 模型什么工具都没调 */
let chatTool = null
/** 让假上游在出图那一步回 401（用来验失败原因有没有传到浏览器） */
let FAIL_GENERATE = false
/** 让假上游像"不支持 tools 的模型"那样拒绝整条请求 */
let FAIL_CHAT_TOOLS = false
/** 每个用例要断言的请求：上游收到什么，探针就看什么 */
const seen = { chat: null, enhance: null, generate: null }

/** 把一段文本切成**很小**的增量 —— 工具参数的 bug 只在增量的边界上出现，
 *  一次吐一大块是测不出来的（那正是它会在生产里翻车的原因）。
 *  按 UTF-16 码元切，连 emoji 的代理对都会被劈进两帧。 */
function tinyChunks(s, size = 3) {
  const out = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

/** 一个上游 SSE 帧 */
function frame(delta, extra = {}) {
  return `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}\n\n`
}

function contentFrames(text, size = 3) {
  return tinyChunks(text, size).map((p) => frame({ content: p }))
}

/**
 * 正文 + 可选的工具调用。**故意把工具调用夹在正文中间**：
 * 两件事在协议里是同一帧里的两个字段，服务端不该因为开始收工具参数
 * 就把正文停下来，也不该把 arguments 当成正文吐出去。
 */
function sseChat(res, text, tool) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  const parts = tinyChunks(text, 3)
  const mid = Math.floor(parts.length / 2)
  const frames = []
  for (const p of parts.slice(0, mid)) frames.push(frame({ content: p }))

  if (tool) {
    /* 第一片带 id / type / name，后面**只带 arguments 的一段字符串** ——
       这就是 OpenAI 兼容协议的流式形状。参数故意切到 4 个字符一片，
       一个 JSON 的引号、逗号、括号都会被劈开 */
    const pieces = tinyChunks(String(tool.args ?? ''), 4)
    frames.push(
      frame({
        tool_calls: [
          {
            index: 0,
            id: 'call_meta_1',
            type: 'function',
            function: { name: tool.name, arguments: pieces.shift() ?? '' }
          }
        ]
      })
    )
    for (const p of pieces) {
      frames.push(frame({ tool_calls: [{ index: 0, function: { arguments: p } }] }))
    }
  }

  for (const p of parts.slice(mid)) frames.push(frame({ content: p }))
  frames.push(frame({}, { finish_reason: tool ? 'tool_calls' : 'stop' }), 'data: [DONE]\n\n')
  res.end(frames.join(''))
}

const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let json = {}
    try {
      json = JSON.parse(body)
    } catch {
      /* 空体也算合法（例如只读请求） */
    }
    if (req.url.endsWith('/chat/completions')) {
      /* 同一个地址上三种用途，靠请求体的形状区分：
         摄影指导那一条的 system 里带着 "You are the photographer" */
      const isDirector = (json.messages || []).some(
        (m) => typeof m.content === 'string' && m.content.includes('You are the photographer')
      )
      if (isDirector) {
        seen.enhance = json
        const out = [
          'Camera: held at arm\u2019s length, slightly above eye level',
          'Lens: shallow focus, the wall soft behind the shoulders',
          'Light: a cool streetlight just off frame to the right, catching the wet rail',
          'Environment: the harbour below, masts and lamps receding into haze'
        ].join('\n')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ choices: [{ message: { content: out } }] }))
      }
      seen.chat = json
      /* "这个模型不支持 tools" —— 假上游按上游的样子回一个 400 +
         一句人话。服务端得把它翻成"换一个支持 function calling 的模型"，
         而不是一句笼统的 400 */
      if (FAIL_CHAT_TOOLS) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(
          JSON.stringify({ error: { message: 'tools is not supported by this model' } })
        )
      }
      return sseChat(res, chatReply, chatTool)
    }
    if (req.url.includes('images/generations') || req.url.includes('image')) {
      seen.generate = json
      /* 出图失败那条路:让假上游按真上游的样子回一个 401 加一句人话。
         这一条是"图片生成失败没提示"那次报错的回归 —— 服务端得把
         `error` 与 `detail` 原样带给浏览器,前端才有东西可显示 */
      if (FAIL_GENERATE) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        return res.end(
          JSON.stringify({
            error: 'Upstream returned an error (401)',
            detail: 'invalid api key'
          })
        )
      }
      /* 一张 1×1 的 PNG。出图那条路只要求"拿得到一个可转成 Blob 的 src" */
      const px =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ b64_json: px }] }))
    }
    res.writeHead(404).end('{}')
  })
})

/* ===== 断言 =========================================================== */

let failed = 0
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

async function post(port, url, body) {
  return fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/** 读服务端吐回来的流。
 *
 *  **不是 SSE** —— 它在这一层已经从上游的 `data: {...}` 转成了 NDJSON:
 *  一行一个 JSON 对象,`{"delta":"…"}` 与收尾那一帧 `{"done":true,…,metaIssue,…}`。
 *  解析方式与客户端 chatStream 逐行处理的那一套必须一致(见 src/api.ts),
 *  否则这里过了、浏览器里不过。 */
async function readChat(res) {
  const deltas = []
  let done = null
  let error = ''
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done: end } = await reader.read()
    if (end) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const text = line.trim()
      if (!text) continue
      let evt
      try {
        evt = JSON.parse(text)
      } catch {
        continue
      }
      if (typeof evt.delta === 'string') deltas.push(evt.delta)
      if (typeof evt.error === 'string') error = evt.error
      if (evt.done) done = evt
    }
  }
  return { deltas, text: deltas.join(''), done, error }
}

/* ===== 用例 =========================================================== */

const SCENE_FULL =
  'me leaning on the balcony rail at dusk, the rain just stopped, ' +
  'streetlights coming on below, hair still wet from the shower, ' +
  'the harbour lights doubled in the puddles on the deck'

/** 把工具参数写成 JSON 字符串（真实上游也是字符串，不是对象） */
function metaArgs(obj) {
  return JSON.stringify(obj)
}

async function main() {
  console.log('对话出图端到端探针\n')

  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r))

  const app = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    /* 探针在一分钟里会打三十多次，超过默认的每分钟 30 次限制 ——
       不抬高的话，后面的用例会拿着 429 当成"服务端的行为"来断言 */
    env: { ...process.env, PORT: String(APP_PORT), KAIRO_RATE_MAX: '1000' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const appErr = []
  app.stderr.on('data', (d) => appErr.push(String(d)))
  /* 等它开始监听 */
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  const cfg = {
    textModel: 'fake',
    baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    apiKey: 'k',
    character: { name: 'Alice' }
  }
  const systemOf = () => String(seen.chat?.messages?.[0]?.content || '')

  try {
    /* —— 用例 1：请求形状与 System Prompt ——
       元数据协议换成了 tool calling。这一步看的是**发出去的东西**:
       工具有没有带上、schema 对不对、正文的规则里还在不在教旧标签。
       这几项任何一项错了，模型都会照着错的那份写。 */
    console.log('用例 1 · 请求形状与 System Prompt')
    chatReply = 'Rain again. I am so tired of it.'
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        mood: 'tired',
        photo: {
          scene: 'me on the balcony at dusk, streetlights coming on below',
          shot: 'selfie',
          frame: 'close'
        }
      })
    }
    let r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    let out = await readChat(r)
    const reqTools = seen.chat?.tools || []
    ok('请求里带了一个工具', reqTools.length === 1, JSON.stringify(reqTools).slice(0, 120))
    ok('工具名是 emit_message_meta', reqTools[0]?.function?.name === 'emit_message_meta')
    ok('tool_choice 是 auto（思考模式不接受 required / 点名工具）', seen.chat?.tool_choice === 'auto')
    ok(
      'schema 里 mood 必填，photo 是可选项',
      Array.isArray(reqTools[0]?.function?.parameters?.required) &&
        reqTools[0].function.parameters.required.includes('mood') &&
        !!reqTools[0]?.function?.parameters?.properties?.photo,
      JSON.stringify(reqTools[0]?.function?.parameters?.required)
    )
    ok(
      'schema 里有 attachment，必填 kind/title（url 可缺：音乐是纯分享卡）',
      reqTools[0]?.function?.parameters?.properties?.attachment?.required?.join(',') === 'kind,title',
      JSON.stringify(reqTools[0]?.function?.parameters?.properties?.attachment?.required)
    )
    ok(
      'attachment 的 kind 枚举认 link 与 music',
      reqTools[0]?.function?.parameters?.properties?.attachment?.properties?.kind?.enum?.join(',') ===
        'link,music',
      JSON.stringify(reqTools[0]?.function?.parameters?.properties?.attachment?.properties?.kind)
    )
    ok(
      'photo 的子字段是 scene/shot/frame，scene 必填',
      reqTools[0]?.function?.parameters?.properties?.photo?.required?.join(',') === 'scene',
      JSON.stringify(reqTools[0]?.function?.parameters?.properties?.photo)
    )
    ok('system 里点名了工具', systemOf().includes('emit_message_meta'))
    ok(
      'system 里要求回复写完后调用一次，且不许写进正文',
      systemOf().includes('After you finish writing the reply, call the emit_message_meta tool exactly once') &&
        systemOf().includes('never write the metadata')
    )
    ok('system 里带着发图那一段', systemOf().includes('Sending a picture:'))
    ok(
      'system 里带着分享那一段（且不随 canDraw 消失）',
      systemOf().includes('Sharing something with a message:') &&
        systemOf().includes('Only share a URL that already appears somewhere in this conversation') &&
        systemOf().includes('A song needs no link to be shared')
    )
    /* 转写旁白的清理是两道的:**入口**把旧消息正文里那行括号摘掉,
       **出口**再从模型回复里清一次。提示词里另有一句兜底。
       模型见过这行旁白就会照抄（实测）,所以结构上先不给它看到。 */
    ok(
      'system 里点名括号旁白不是它的话、不许自己写进正文',
      systemOf().includes('are transcript notes, never your words') &&
        systemOf().includes('never type one into a reply') &&
        systemOf().includes('Never write a parenthetical like "(a song was shared — …)"')
    )
    ok(
      'system 里没有旧标签 / 哨兵 / 任何文本协议残留',
      !systemOf().includes('[photo:') && !systemOf().includes('[mood:') && !systemOf().includes('%%KAIRO_META%%'),
      JSON.stringify(
        systemOf()
          .split('\n')
          .filter((l) => l.includes('[photo:') || l.includes('[mood:') || l.includes('KAIRO_META'))
      )
    )

    /* —— 用例 1a：正文与工具调用互不污染 ——
       arguments 在假上游里被切成 4 个字符一片，一个 JSON 的引号和括号
       都会被劈开。服务端必须按 index 攒回来，而且一个字都不能漏进正文。 */
    console.log('\n用例 1a · 正文 + 工具调用（arguments 被切碎）')
    ok('正文完整、没有被工具参数污染', out.text === chatReply, JSON.stringify(out.text))
    ok('正文里没有 JSON 残渣', !/emit_message_meta|\{"mood"/.test(out.text), JSON.stringify(out.text))
    ok('正文是分多帧流出来的', out.deltas.length > 6, String(out.deltas.length))
    ok('photo 拼回来了', out.done?.photo === 'me on the balcony at dusk, streetlights coming on below', String(out.done?.photo))
    ok('photoSelf = true', out.done?.photoSelf === true)
    ok('photoShot = selfie', out.done?.photoShot === 'selfie', String(out.done?.photoShot))
    ok('photoFrame = close', out.done?.photoFrame === 'close', String(out.done?.photoFrame))
    ok('mood = tired', out.done?.mood === 'tired', String(out.done?.mood))
    ok('这一轮没有 metaIssue', out.done?.metaIssue === undefined, String(out.done?.metaIssue))

    /* —— 用例 1b：中文 + emoji 的参数被劈开 ——
       参数是 JSON 字符串里的内容，而假上游按 UTF-16 码元切。emoji 的代理对、
       ZWJ 组合、变体选择符都会被劈进两帧 —— 这里盯的是"劈开之后还能不能
       原样拼回去"。cleanScene 会压空白，但不会动字符本身。 */
    console.log('\n用例 1b · 中文与 emoji 的参数原样拼回')
    chatReply = '嗯，听着就冷。'
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        mood: 'warm',
        photo: { scene: '我靠在阳台栏杆上，雨刚停😮\u200d💨 灯✨\uFE0F 亮着', shot: 'selfie' }
      })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('正文原样', out.text === '嗯，听着就冷。', JSON.stringify(out.text))
    ok(
      '中文与 emoji 一字不差',
      out.done?.photo === '我靠在阳台栏杆上，雨刚停😮\u200d💨 灯✨\uFE0F 亮着',
      JSON.stringify(out.done?.photo)
    )
    ok('mood 也在', out.done?.mood === 'warm', String(out.done?.mood))

    /* —— 用例 1c：正文里的 emoji 与分行 ——
       正文这条信道同样按码元切。emoji 被劈开、JSON 来回转义之后，
       客户端收到的必须与模型"说"的一字不差。 */
    console.log('\n用例 1c · 正文里的 emoji 与分行')
    chatReply = '累死了😮\u200d💨\n不过还行✨\uFE0F'
    chatTool = { name: 'emit_message_meta', args: metaArgs({ mood: 'tired' }) }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok(
      'emoji（ZWJ 组合 + 变体选择符）一字不差',
      out.text === '累死了😮\u200d💨\n不过还行✨\uFE0F',
      JSON.stringify(out.text)
    )
    ok('中间的分行留着', out.text.includes('\n'))

    /* 末尾的换行不属于它要说的话 —— 哪怕没有标签也要收掉 */
    chatReply = 'Sure.\n'
    chatTool = { name: 'emit_message_meta', args: metaArgs({ mood: 'calm' }) }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('末尾的换行不流到气泡里', out.text === 'Sure.', JSON.stringify(out.text))

    /* —— 用例 1d：分享一个链接 ——
       attachment 与正文走同一条工具调用，收尾时应原样归一化后带出来。
       单独占一个用例，是因为它是"消息不止文字"的第一个非图片形态：
       地址校验、标题兜底、与 photo 互不干扰，三件都在这里过一遍。 */
    console.log('\n用例 1d · 分享一个链接')
    chatReply = 'This is the one I meant.'
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        mood: 'warm',
        attachment: {
          kind: 'link',
          title: '  The quiet part of the internet ',
          url: 'https://example.com/a-post',
          subtitle: 'you would like this one'
        }
      })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('正文照常送达', out.text === chatReply, JSON.stringify(out.text))
    ok(
      '卡片带出来了（标题压成一行、副标题也在）',
      out.done?.attachment?.title === 'The quiet part of the internet' &&
        out.done?.attachment?.subtitle === 'you would like this one',
      JSON.stringify(out.done?.attachment)
    )
    ok('地址是 http(s) 且完整', out.done?.attachment?.url === 'https://example.com/a-post')
    ok('这一轮没有 metaIssue', out.done?.metaIssue === undefined, String(out.done?.metaIssue))

    /* 一个字都不说、只转一张卡片：这不是空回复。若按"没正文"判空，
       这条消息会在前端被当成空气泡摘掉 —— 卡片也跟着消失。 */
    chatReply = ''
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        attachment: { kind: 'link', title: 'Look at this', url: 'https://example.com/b' }
      })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('只带卡片、一个字不说也算一轮（不报"没话说"）', !out.error && !!out.done, out.error)
    ok('卡片还在', out.done?.attachment?.url === 'https://example.com/b', JSON.stringify(out.done?.attachment))
    ok('mood 缺省是空串', out.done?.mood === '', String(out.done?.mood))

    /* 不安全的地址：整块丢掉。丢掉之后既没有正文也没有卡片，
       这一轮就该按空回复报出来，而不是挂一张点不开的卡 */
    chatReply = ''
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        attachment: { kind: 'link', title: 'dev server', url: 'http://192.168.1.10/x' }
      })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('内网地址的卡片被丢掉', out.done?.attachment == null, JSON.stringify(out.done?.attachment))
    ok(
      '丢掉之后如实报"没话说"',
      out.error.includes('nothing to say'),
      JSON.stringify({ error: out.error, done: out.done })
    )

    /* 预览端点：它才是真的去访问外网的那一层，所以本机地址必须在门口就被拒 */
    r = await post(APP_PORT, '/api/link-preview', { url: 'http://127.0.0.1:18431/' })
    ok('预览接口拒绝本机地址', r.status === 400, String(r.status))
    r = await post(APP_PORT, '/api/link-preview', {})
    ok('预览接口拒绝空地址', r.status === 400, String(r.status))

    /* —— 用例 1e：分享一首歌（音乐可以没有链接） ——
       music 与 link 唯一分叉的是"要不要地址"。这里钉三件事：
       纯分享卡（无 url）能成立；坏地址只丢地址、留住卡；空正文只递一张卡也算一轮。 */
    console.log('\n用例 1e · 分享一首歌')
    chatReply = 'Putting this on for you.'
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        mood: 'warm',
        attachment: { kind: 'music', title: ' Night Changes ', subtitle: '  Harry Styles ' }
      })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('正文照常送达', out.text === chatReply, JSON.stringify(out.text))
    ok(
      '纯分享卡：kind=music、曲名与歌手都收、没有 url 也成立',
      out.done?.attachment?.kind === 'music' &&
        out.done?.attachment?.title === 'Night Changes' &&
        out.done?.attachment?.subtitle === 'Harry Styles' &&
        out.done?.attachment?.url === undefined,
      JSON.stringify(out.done?.attachment)
    )
    ok('这一轮没有 metaIssue', out.done?.metaIssue === undefined, String(out.done?.metaIssue))

    /* 音乐带了个坏地址（本机）：只丢地址，卡片留下 —— 它本来就是能独立成立的分享卡 */
    chatReply = ''
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        attachment: { kind: 'music', title: 'Real Home', url: 'http://127.0.0.1:9/x' }
      })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok(
      '音乐里的坏地址只丢地址、留住这张卡（与链接整块丢不同）',
      out.done?.attachment?.kind === 'music' &&
        out.done?.attachment?.title === 'Real Home' &&
        out.done?.attachment?.url === undefined,
      JSON.stringify(out.done?.attachment)
    )

    /* 一个字都不说、只递一张音乐卡：与链接同一条理由，这不是空回复 */
    chatReply = ''
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({ attachment: { kind: 'music', title: 'A Song', subtitle: 'Someone' } })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('只递一张音乐卡、一个字不说也算一轮（不报"没话说"）', !out.error && !!out.done, out.error)
    ok('音乐卡还在', out.done?.attachment?.kind === 'music', JSON.stringify(out.done?.attachment))

    // 还给后面的用例留一个带正文的默认值
    chatReply = 'Sure.'
    chatTool = { name: 'emit_message_meta', args: metaArgs({ mood: 'calm' }) }

    /* —— 用例 1f：历史里的转写旁白不能回放给模型 ——
       旧版前端把 "(a song was shared — …)" 补在助手正文里，模型看到就照抄
       （实测：它宁可写这行括号，也不去调工具）。入口必须先摘掉。 */
    console.log('\n用例 1f · 历史里的括号旁白要先清掉')
    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      messages: [
        { role: 'user', content: '放首歌吧' },
        { role: 'assistant', content: '这首给你。\n(a song was shared — "道山靓仔" by 五条人)' },
        { role: 'user', content: '好' }
      ]
    })
    out = await readChat(r)
    /* 跳过 system:提示词里本来就写着这条规则的名字,它不算"发出去的历史" */
    const sentHistory = (seen.chat?.messages || []).slice(1).map((m) => String(m.content || ''))
    ok(
      '助手历史里的旁白没有发出去',
      !sentHistory.some((c) => c.includes('(a song was shared')),
      JSON.stringify(sentHistory)
    )
    ok('那句话本身还在', sentHistory.some((c) => c.includes('这首给你。')))
    ok('用户的话一个字不动', sentHistory.includes('放首歌吧') && sentHistory.includes('好'))

    /* —— 用例 1g：发过的卡改走 system 简报 ——
       卡本身不重发（与图同一条理由），但模型得知道自己放过什么。
       简报要说人话：不出现 "(a song was shared — …)" 这种可模仿的括号模板。 */
    console.log('\n用例 1g · 历史卡进 system 简报')
    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      messages: [{ role: 'user', content: '刚才那首叫什么' }],
      shares: [
        { role: 'assistant', attachment: { kind: 'music', title: '道山靓仔', subtitle: '五条人' } },
        { role: 'assistant', attachment: { kind: 'link', title: 'A post', url: 'https://example.com/x' } }
      ]
    })
    out = await readChat(r)
    ok('system 里有"发过的卡"那一段', systemOf().includes('Cards already sent in this conversation'))
    ok('歌的曲名与歌手交代了', systemOf().includes('You put on a song: "道山靓仔" by 五条人'))
    ok(
      '链接的标题与地址交代了',
      systemOf().includes('You shared a link: "A post" — https://example.com/x')
    )
    ok(
      '简报里没有可模仿的括号旁白',
      (() => {
        /* 只看简报这一段:system 末尾的规则本身会提到这行括号,那是另一回事 */
        const brief = (systemOf().split('Cards already sent in this conversation')[1] || '').split('\n\n')[0]
        return !!brief && !brief.includes('(a song was shared') && !brief.includes('(a link was shared')
      })()
    )

    /* —— 用例 1h：模型自己写出旁白时，出口要清掉 ——
       旧对话里它已经见过这行，可能还会照抄；不能让用户看到，也不能当成正文存下来。
       只写一行旁白、没有正文也没有卡：清完就是"没话说"，不能回空气泡。 */
    console.log('\n用例 1h · 模型照抄旁白时出口清掉')
    chatReply = '这首给你。\n(a song was shared — "道山靓仔" by 五条人)'
    chatTool = { name: 'emit_message_meta', args: metaArgs({ mood: 'warm' }) }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('正文里没有括号旁白', !out.text.includes('(a song was shared'), JSON.stringify(out.text))
    ok('正文本身还在', out.text.includes('这首给你。'), JSON.stringify(out.text))
    ok('这一轮正常收尾', !!out.done && !out.error, out.error)

    chatReply = '(a song was shared — "道山靓仔" by 五条人)'
    chatTool = { name: 'emit_message_meta', args: metaArgs({ mood: 'warm' }) }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok(
      '只剩旁白的轮次按"没话说"收场（空气泡会被前端自己移除）',
      !!out.error && !out.done,
      JSON.stringify({ error: out.error, done: out.done })
    )

    // 恢复默认值，后面的用例还要用
    chatReply = 'Sure.'
    chatTool = { name: 'emit_message_meta', args: metaArgs({ mood: 'calm' }) }

    /* —— 用例 2：接近上限的长场景 ——
       arguments 越大，被切成越多片；同时正文必须在参数收完之前就流出去 ——
       否则等于"工具调用把整条回复停到了流末"。 */
    console.log('\n用例 2 · 长场景（' + SCENE_FULL.length + ' 字）')
    chatReply = 'Look at this.'
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        mood: 'warm',
        photo: { scene: SCENE_FULL, shot: 'selfie' }
      })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('长场景整段保住', out.done?.photo === SCENE_FULL, `len=${out.done?.photo?.length} 期望 ${SCENE_FULL.length}`)
    ok('photoSelf = true', out.done?.photoSelf === true)
    ok('正文本身完整', out.text === 'Look at this.', JSON.stringify(out.text))
    ok('正文是分多帧流出来的（没有等参数收完）', out.deltas.length > 3, String(out.deltas.length))

    /* —— 用例 3：场景照 / 视角 / 景别 ——
       这三样在服务端只做一件事：把工具参数原样（归一化后）带出来。
       漏掉任何一位的表现都是静默的：图照样出得来，只是又变回一张臂展自拍。 */
    console.log('\n用例 3 · 场景照、视角与景别')
    chatReply = 'It is coming down hard.'
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({ mood: 'uneasy', photo: { scene: 'rain on the window at dawn' } })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('photo 带出来了', out.done?.photo === 'rain on the window at dawn')
    ok('照片里没有人', out.done?.photoSelf === false)
    ok('相机那一项自然是空的', out.done?.photoShot === '', String(out.done?.photoShot))
    ok('没有景别时是空串（不是替它猜一个）', out.done?.photoFrame === '', String(out.done?.photoFrame))

    chatReply = 'One second, mirror is fogged.'
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        mood: 'amused',
        photo: { scene: 'me in the bathroom mirror, hair wet', shot: 'selfie' }
      })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('photoShot = selfie', out.done?.photoShot === 'selfie', String(out.done?.photoShot))
    ok('自拍说明它在画面里', out.done?.photoSelf === true)

    chatReply = 'Caught me off guard.'
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        mood: 'wary',
        photo: { scene: 'me on stage, taken from the crowd', shot: 'third', frame: 'full' }
      })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('photoShot = third', out.done?.photoShot === 'third', String(out.done?.photoShot))
    ok('他拍时它照样在画面里', out.done?.photoSelf === true)
    ok('photoFrame = full', out.done?.photoFrame === 'full', String(out.done?.photoFrame))

    /* 人不在画面里也照样有景别 —— 这正是"拍个特写给我看"最常见的形状 */
    chatReply = 'Here.'
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        mood: 'calm',
        photo: { scene: 'rain running down the window pane', frame: 'close' }
      })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('空镜也有景别', out.done?.photoFrame === 'close', String(out.done?.photoFrame))
    ok('空镜仍然没有人', out.done?.photoSelf === false)
    ok('空镜的相机项仍然是空的', out.done?.photoShot === '', String(out.done?.photoShot))

    /* —— 用例 3b：旧前缀被写进了 scene ——
       新协议不再要求前缀，但模型可能顺手沿用旧写法。parsePhotoIntent 会把它
       从描述里剪掉，否则 "selfie:close:me …" 整句会被喂给出图模型。 */
    console.log('\n用例 3b · scene 里残留的旧前缀会被剪掉')
    chatReply = 'Sure.'
    chatTool = {
      name: 'emit_message_meta',
      args: metaArgs({
        mood: 'warm',
        photo: { scene: 'selfie:close:me in the bathroom mirror, hair wet' }
      })
    }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('前缀不进场景描述', out.done?.photo === 'me in the bathroom mirror, hair wet', String(out.done?.photo))
    ok('视角从前缀里认出来了', out.done?.photoShot === 'selfie', String(out.done?.photoShot))
    ok('景别从前缀里认出来了', out.done?.photoFrame === 'close', String(out.done?.photoFrame))
    ok('它本人在画面里', out.done?.photoSelf === true)

    /* —— 用例 4：模型没调工具 ——
       正文照常送达；收尾帧带 metaIssue，前端据此提示"换个支持 tool calling
       的模型"。**不静默降级**去正文里找旧标签 —— 那会把"模型不支持"藏起来。 */
    console.log('\n用例 4 · 模型没调工具')
    chatReply = 'Just words, nothing else.'
    chatTool = null
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('正文照常送达', out.text === chatReply, JSON.stringify(out.text))
    ok('metaIssue = not_called', out.done?.metaIssue === 'not_called', String(out.done?.metaIssue))
    ok('既然没调工具，photo 就是空的', out.done?.photo === '')
    ok('mood 也是空的', out.done?.mood === '')

    /* —— 用例 4b：调了别的工具 —— */
    console.log('\n用例 4b · 调了别的工具')
    chatReply = 'Let me look that up.'
    chatTool = { name: 'search_web', args: metaArgs({ q: 'weather in Lisbon' }) }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('metaIssue = unknown_tool', out.done?.metaIssue === 'unknown_tool', String(out.done?.metaIssue))
    ok('正文照常送达', out.text === chatReply, JSON.stringify(out.text))

    /* —— 用例 4c：参数不是合法 JSON —— */
    console.log('\n用例 4c · 参数写坏了')
    chatReply = 'Fine.'
    chatTool = { name: 'emit_message_meta', args: '{"mood":"tired"' }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('metaIssue = invalid_arguments', out.done?.metaIssue === 'invalid_arguments', String(out.done?.metaIssue))
    ok('正文照常送达', out.text === chatReply, JSON.stringify(out.text))

    /* —— 用例 4d：参数合法但两项都空 —— */
    console.log('\n用例 4d · 调了但什么都没填')
    chatReply = 'Hm.'
    chatTool = { name: 'emit_message_meta', args: '{}' }
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('metaIssue = empty_metadata', out.done?.metaIssue === 'empty_metadata', String(out.done?.metaIssue))

    /* —— 用例 5：老标签只清理、不取意图 ——
       历史消息里可能还留着旧标签；正文流出去之前仍要把它们摘干净，
       但它们**不再能顶替 tool call**。否则"模型没调工具"这件事会被
       一段文本悄悄补上，协议就又有两条路了。 */
    console.log('\n用例 5 · 老标签只清理，不当作这一轮的意图')
    chatReply = 'Rain again.\n[photo:self:me on the balcony]\n[mood:tired]'
    chatTool = null
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('正文里的旧标签被摘干净', out.text === 'Rain again.', JSON.stringify(out.text))
    ok('旧 photo 标签不再产生 photo', out.done?.photo === '', String(out.done?.photo))
    ok('旧 mood 标签不产生 mood', out.done?.mood === '', String(out.done?.mood))
    ok('仍然如实报告 not_called', out.done?.metaIssue === 'not_called', String(out.done?.metaIssue))

    chatReply = 'One sec.\n\n[photo:selfie:close:my hands wrapped around the mug]\n\nOkay.'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok(
      '中段那枚旧标签也不露给用户',
      !/\[\s*(photo|mood)/i.test(out.text),
      JSON.stringify(out.text)
    )
    ok('中段那枚同样不产生意图', out.done?.photo === '', String(out.done?.photo))

    /* —— 用例 6：上游明确拒绝 tools ——
       "这个模型用不了这一版的新协议"必须说清楚，让用户去换模型；
       不能退回到"读正文标签"那条老路（那等于把问题藏起来）。 */
    console.log('\n用例 6 · 上游不支持 tools')
    chatReply = 'never sent'
    chatTool = null
    FAIL_CHAT_TOOLS = true
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    const reject = await r.json().catch(() => ({}))
    ok('HTTP 400', r.status === 400, String(r.status))
    ok(
      '错误说清是 tool calling 不支持',
      reject.error === 'This model does not support tool calling',
      JSON.stringify(reject)
    )
    ok(
      'detail 里带着上游原话与可操作的下一步',
      String(reject.detail || '').includes('tools is not supported') &&
        String(reject.detail || '').includes('deepseek-flash'),
      JSON.stringify(reject.detail)
    )
    FAIL_CHAT_TOOLS = false

    /* —— 用例 7：canDraw=false ——
       配不出图的角色，工具 schema 里连 photo 字段都不该出现，
       system 里也不该提"发图"这件事 —— 教了就会写，写了也画不出来。 */
    console.log('\n用例 7 · 配不出图时')
    chatReply = 'Just talking.'
    chatTool = { name: 'emit_message_meta', args: metaArgs({ mood: 'bored' }) }
    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      canDraw: false,
      messages: [{ role: 'user', content: 'hi' }]
    })
    out = await readChat(r)
    const noDrawProps = seen.chat?.tools?.[0]?.function?.parameters?.properties || {}
    ok('工具 schema 里没有 photo', noDrawProps.photo === undefined, Object.keys(noDrawProps).join(','))
    ok('attachment 不受出图配置影响，仍然在', !!noDrawProps.attachment, Object.keys(noDrawProps).join(','))
    ok('mood 仍然必填', seen.chat?.tools?.[0]?.function?.parameters?.required?.join(',') === 'mood')
    ok('system 里不再提发图', !systemOf().includes('Sending a picture:'))
    ok('system 里分享那一段照旧在', systemOf().includes('Sharing something with a message:'))
    ok('mood 这一路照常工作', out.done?.mood === 'bored', String(out.done?.mood))
    ok('没有 photo 字段时 photo 为空', out.done?.photo === '')

    /* —— 用例 8：photo 档确实按四行回 —— */
    console.log('\n用例 8 · /api/enhance 的 photo 档')
    r = await post(APP_PORT, '/api/enhance', {
      prompt: 'scene: me on the balcony',
      mode: 'photo',
      textModel: 'fake',
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      apiKey: 'k'
    })
    const enh = await r.json()
    ok('HTTP 200', r.status === 200, JSON.stringify(enh))
    ok('回了四行', String(enh.prompt || '').trim().split('\n').length === 4, JSON.stringify(enh.prompt))
    ok(
      '不再要它判视角 —— 这一行是"老出他拍"的来源，它已经不写了',
      !/^\s*Shot\s*:/m.test(String(enh.prompt)),
      JSON.stringify(enh.prompt)
    )
    ok('四行标签齐全', ['Camera', 'Lens', 'Light', 'Environment'].every((k) => String(enh.prompt).includes(`${k}:`)))
    ok(
      '系统提示里用的是 photo 档（不是 quick）',
      (seen.enhance?.messages || [])[0]?.content?.includes('You are the photographer'),
      JSON.stringify((seen.enhance?.messages || [])[0]?.content?.slice(0, 60))
    )
    ok(
      '没把 REF_NOTE / 目标模型偏好塞进 photo 档',
      !String((seen.enhance?.messages || [])[0]?.content || '').includes('This is an image-to-image edit')
    )
    ok('温度是 0.6', seen.enhance?.temperature === 0.6, String(seen.enhance?.temperature))

    /* —— 用例 9：/api/generate 收到的是什么 —— */
    console.log('\n用例 9 · /api/generate 收到的载荷')
    r = await post(APP_PORT, '/api/generate', {
      prompt: 'photographic, shot on a phone front camera, me on the balcony, selfie at arm\u2019s length',
      size: '1024x1536',
      n: 1,
      quality: 'high',
      model: 'fake-img',
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      apiKey: 'k',
      vendor: 'openai'
    })
    ok('HTTP 200', r.status === 200, String(r.status))
    ok('提示词原样透传（服务端不二次加工）', String(seen.generate?.prompt || '').startsWith('photographic'))
    ok('quality 带上了', seen.generate?.quality === 'high')
    ok('size 是竖幅', seen.generate?.size === '1024x1536', String(seen.generate?.size))

    /* —— 用例 10：出图失败时，原因必须传到浏览器 ——
       这一条是"图片生成失败根本没有详细提示"那次报错的回归。
       浏览器那边只显示 `photoFailureText(e.message)`，所以**服务端把原话
       传没传出来**就是这条链的全部 —— 传丢了，界面上就只剩"生成失败"。 */
    console.log('\n用例 10 · 出图失败时原因要传到浏览器')
    FAIL_GENERATE = true
    r = await post(APP_PORT, '/api/generate', {
      prompt: 'a rooftop at dawn',
      size: '1024x1536',
      n: 1,
      model: 'fake-img',
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      apiKey: 'wrong',
      vendor: 'openai'
    })
    const failBody = await r.json().catch(() => ({}))
    ok('上游 401 映射成非 200', r.status !== 200, String(r.status))
    ok(
      '错误里带上上游的原话（不是一句笼统的"失败"）',
      String(failBody.error || '').includes('401'),
      JSON.stringify(failBody).slice(0, 160)
    )
    ok(
      'detail 也带上了（invalid api key）',
      String(failBody.detail || '').includes('invalid api key'),
      JSON.stringify(failBody.detail)
    )
    FAIL_GENERATE = false

    /* —— 用例 11：时间那一块 ——
       "现在几点 / 上次说话"由前端算好、服务端拼进 system（见 server/chatTime.js）。
       这一条链上会静默出错的正是**接缝**：前端没把字段发出来、服务端没接住、
       或者接住了却插错位置 —— 三种都不会报错，角色只是变得不知道时间，
       而"它不知道时间"这件事在产品上完全看不出来（它照聊不误）。 */
    console.log('\n用例 11 · 时间那一块')
    chatReply = 'Sure.'
    chatTool = { name: 'emit_message_meta', args: metaArgs({ mood: 'calm' }) }
    const STAMP = '2026-10-05T23:41:07+08:00'
    const STAMP_MS = Date.parse(STAMP)

    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      nowLocal: STAMP,
      lastAt: STAMP_MS - 3 * 24 * 60 * 60 * 1000,
      memory: 'They met in Lisbon.',
      messages: [{ role: 'user', content: 'hi' }]
    })
    await readChat(r)
    ok('当前时间进去了（含星期几）', systemOf().includes('Right now: 2026-10-05 23:41, Monday'), JSON.stringify(systemOf().slice(0, 120)))
    ok('没有秒（秒是机器的时间）', !systemOf().includes('23:41:07'))
    ok('上次说话的间隔进去了', /^You two last spoke 3 days ago\.$/m.test(systemOf()))
    ok('角色资料还在（没把别的块挤掉）', systemOf().includes('Name: Alice'))
    ok(
      '时间排在记忆之前 —— 记忆是一段成篇的叙述，夹在两块短事实中间会被切碎',
      systemOf().indexOf('Right now: 2026') < systemOf().indexOf('What you remember')
    )
    ok('规则里带着"别每句都报时"', systemOf().includes('it is a clock'))
    /* 2026-10-08：两个钟必须分开 —— 现实时钟不推进剧情。
       用户报的是"已经过去的事又被说成等会要做"，这两条规则是其中一半的答案
       （另一半在摘要那边：剧情时间按对话的说法写、待办单收一句） */
    ok(
      '时间那一行标明了它只是现实世界的钟',
      systemOf().includes('real world only') && systemOf().includes('the story may be at another time')
    )
    ok(
      '规则里点明"现实钟不推进剧情"',
      systemOf().includes('Never advance the story just because the clock did')
    )
    ok(
      '规则里点明"已经发生过的就不再是待办"',
      systemOf().includes('Whatever has already happened in this conversation has happened')
    )
    /* 2026-10-06:放开 emoji。原先没有任何一条提到它,而"只写说出口的话"
       与"别用 markdown"那两条的口气是压着它的,于是模型基本不用。
       这里断言的同样只是"它进了 system" —— 模型用不用、用得像不像人,
       属于提示词类改动,只能手测(与上面两条软规则同一条纪律) */
    ok('规则里放开了 emoji', systemOf().includes('Emoji are fine'), 'system 里没有这一句')
    /* 这两条是 T6.5 加的软规则。这里断言的只是"它们确实进了 system" ——
       模型照不照做是另一回事(那是提示词类改动,只能手测),别把这条
       当成"接话题行为已验证"。
       "照片别滥用"那一句是 2026-10-05 补的:原来那句"照片之间要连贯"
       里举了个"上一句在阳台、这一句在雪山"的例子 —— 例子本身就在示范
       "每句都发图",加上它挤占了规则块的篇幅,模型于是真就每句都发。
       现在改成"大多数消息里没有图,这是正常的",连贯性收成描述规则末尾
       的一个从句(断言跟着改成新措辞) */
    ok(
      '规则里点明"回复写完后调用一次元数据工具"',
      systemOf().includes('call the emit_message_meta tool exactly once') &&
        systemOf().includes('never write the metadata')
    )
    ok(
      '规则里带着"接话题"与"照片别滥用"',
      systemOf().includes('it is on you to carry it') &&
        systemOf().includes('Most of your messages have no picture in them') &&
        systemOf().includes('same place, at the same hour'),
      JSON.stringify(systemOf().split('\n').filter((l) => l.includes('carry it') || l.includes('picture')))
    )
    /* 2026-10-06：教它怎么写景别。**这一条只断言"它在 system 里"** ——
       模型用不用、用得像不像人，属于提示词类改动，只能手测。
       但少了这一句，close 就永远不会进 photo.frame，特写还是变自拍 */
    ok(
      '规则里教了 frame 的三个档位，并且点明"拿着的东西的特写不是自拍"',
      systemOf().includes('"frame" is optional') &&
        systemOf().includes('is not a selfie') &&
        systemOf().includes("not a picture of your face held out at arm's length"),
      JSON.stringify(systemOf().split('\n').filter((l) => l.includes('frame')))
    )

    /* 没给时间（老前端、手搓请求、时钟坏掉）→ 整块不出现，且**不影响这一轮**。
       判据用行首锚定的正则、**不是 includes('Right now')** ——
       规则里本来就有"the time"这类字眼，拿子串判会误判成通过（第一版就踩了） */
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    await readChat(r)
    ok('不给时间时整块消失', !/^Right now: /m.test(systemOf()))
    ok('也不留 "last spoke" 的空壳', !/^You two last spoke /m.test(systemOf()))

    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      nowLocal: 'today',
      lastAt: STAMP_MS,
      messages: [{ role: 'user', content: 'hi' }]
    })
    await readChat(r)
    ok('时间给坏了也只是没有这一块（不报错、不挡话）', !/^Right now: /m.test(systemOf()))

    /* —— 用例 12：心情那一块 ——
       与时间同一条理由：这条链上会静默出错的正是**接缝** ——
       前端没把状态发出来、服务端没接住、或者接住了却插错位置。
       三种都不报错，角色只是变成"每一轮从零决定心情"，
       而这在界面上**完全看不出来**（它照聊不误，药丸也照常显示）。
       行首锚定的正则，不拿 includes('wary') 判 —— 场景里本来就可能出现那个词 */
    console.log('\n用例 12 · 心情那一块')
    chatReply = 'Fine.'
    chatTool = { name: 'emit_message_meta', args: metaArgs({ mood: 'calm' }) }
    const hoursAgo = (h) => Date.now() - h * 3600_000
    const moodLine = () => /^You are feeling (\S+) right now\.$/m.test(systemOf())

    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      nowLocal: STAMP,
      lastAt: STAMP_MS - 3 * 24 * 60 * 60 * 1000,
      memory: 'They met in Lisbon.',
      mood: { word: 'wary', at: hoursAgo(1) },
      messages: [{ role: 'user', content: 'hi' }]
    })
    await readChat(r)
    ok('新鲜的词进去了', moodLine(), JSON.stringify(systemOf().split('\n').filter((l) => l.includes('feeling'))))
    ok(
      '带着"可以转向"的出口 —— 否则它会一轮一轮地恼下去',
      /carry it into your reply, or let what they just said turn it/.test(systemOf())
    )
    ok(
      '排在时间之后 —— 两者都是"此刻的事实"，属同一层',
      systemOf().indexOf('Right now: 2026') < systemOf().indexOf('You are feeling')
    )
    ok(
      '排在记忆之前 —— 记忆是成篇的叙述，夹在两块短事实中间会被切碎',
      systemOf().indexOf('You are feeling') < systemOf().indexOf('What you remember')
    )

    /* 隔夜就散了：三天的隔阂之后它还端着你上次惹的火，那是惩罚不是拟人。
       （"很久没见"由时间那一块自己演，不需要心情再演一遍） */
    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      nowLocal: STAMP,
      mood: { word: 'angry', at: hoursAgo(24) },
      messages: [{ role: 'user', content: 'hi' }]
    })
    await readChat(r)
    ok('隔夜的心情不再带着', !moodLine())
    ok('而且不留空壳', !systemOf().includes('You already felt that way'))

    /* 词不合法：它是模型自由写的，而这个值绕了一圈从前端库里回来。
       认不出就什么都不做 —— 而一个坏词直接进 system 是一段伪造的提示词结构 */
    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      nowLocal: STAMP,
      mood: { word: '喵', at: hoursAgo(1) },
      messages: [{ role: 'user', content: 'hi' }]
    })
    await readChat(r)
    ok('词不合法时整块不出现（不猜）', !moodLine())

    /* 压根不给：老前端、手搓请求、新角色还没聊过 —— 三种情况走同一条退路 */
    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      nowLocal: STAMP,
      messages: [{ role: 'user', content: 'hi' }]
    })
    await readChat(r)
    ok('不给这一项时整块消失', !moodLine())
    ok('也不影响这一轮（时间那一块照旧在）', /^Right now: /m.test(systemOf()))

    /* —— 用例 13：说话样本那一栏（2026-10-08）——
       它与规则不是一类：规则是"要求"，样本是"照着抄口吻的例子"。所以断言两件事：
       它进了 system，而且带着那句**读法**（跟着语气、不要跟着话题）——
       少了那句读法，模型会把样例里的**场景**当成当下的事实搬进这一轮。 */
    console.log('\n用例 13 · 说话样本')
    const SAMPLES = "User: how was your day / You: long. don't ask. | User: im outside / You: door's open"
    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      character: { name: 'Alice', persona: { samples: SAMPLES } },
      messages: [{ role: 'user', content: 'hi' }]
    })
    await readChat(r)
    ok('样本进了 system', systemOf().includes("long. don't ask."), JSON.stringify(systemOf().slice(0, 200)))
    ok('带着那句读法（跟着语气，不要跟着话题）', systemOf().includes('copy this voice, not the topic'))

    /* 不填这一栏就整块不出现 —— 与其余几栏同一条规矩，不留空壳 */
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    await readChat(r)
    ok('不给这一栏时整块消失', !systemOf().includes('How you actually type'))
  } finally {
    app.kill()
    upstream.close()
    /* **先看它是不是已经退了**:`once` 等的是"将来"那次 exit ——
       子进程要是早就崩了,这一个 await 永远不 resolve,而那时事件循环里
       已经一个句柄都不剩,Node 于是**静静地退出**,退出码还是 0:
       探针只打了一行标题就没了,连 stderr 都来不及打。
       (这个坑是排查"服务端起不来"时踩的,花了比修 bug 更久的时间) */
    if (app.exitCode === null) await once(app, 'exit').catch(() => {})
    if (appErr.length) console.log('\n[服务端 stderr]\n' + appErr.join('').slice(0, 2000))
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条没过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
