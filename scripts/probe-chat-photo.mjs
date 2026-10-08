/* ===== 对话出图整条链的端到端探针（不花钱，也不联网）=====================
 *
 *  起一个假上游，把 KImage 自己的服务端跑起来，然后打它三个端点：
 *  `/api/chat`（流式）→ `/api/enhance`（photo 档）→ `/api/generate`。
 *
 *  —— 为什么需要它 ——
 *
 *  单测只能证明"纯函数算得对"。这一条链上真正会出事的地方全在接缝上，
 *  而它们的表现都是**静默**的：
 *  - 扣尾算错 → 用户看见半截 `[pho` 闪出来，而正文内容一个字不差；
 *  - photo 档格式崩 → 摄影指导那一层悄悄降级回模板，出图照样成功；
 *  - 场景被截断 → 图能出来，只是和它说的话对不上。
 *  三种都不会报错，只会"图不太对味"。
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
/** 让假上游在出图那一步回 401（用来验失败原因有没有传到浏览器） */
let FAIL_GENERATE = false
/** 每个用例要断言的请求：上游收到什么，探针就看什么 */
const seen = { chat: null, enhance: null, generate: null }

/** 把一段文本切成**很小**的增量 —— 扣尾的 bug 只在增量的边界上出现，
 *  一次吐一大块是测不出来的（那正是它会在生产里翻车的原因） */
function tinyChunks(s, size = 3) {
  const out = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

function sse(res, pieces) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  /* **每个数据帧之间必须有换行** —— 少了它,所有帧会挤成一行,
     而服务端是逐行解析上游的。上一版这里用的是 '' 连接,
     结果服务端只认到第一帧,后面全当杂质丢了 ——
     表现是"客户端只收到第一个分片",看着像扣尾坏了,其实是假上游坏了 */
  const frames = pieces.map(
    (p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`
  )
  frames.push(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n'
  )
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
      /* 同一个地址上三种用途，靠 caller 记下来的顺序区分：
         第 1 次是 /api/chat，第 2 次是 /api/enhance（photo 档），
         它们的请求体长得很不一样，直接按形状分 */
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
      return sse(res, tinyChunks(chatReply))
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
      return res.end(
        JSON.stringify({ data: [{ b64_json: px }] })
      )
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
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return r
}

/** 读服务端吐回来的流。
 *
 *  **不是 SSE** —— 它在这一层已经从上游的 `data: {...}` 转成了 NDJSON:
 *  一行一个 JSON 对象,`{"delta":"…"}` 与收尾那一帧 `{"done":true,…,photo,…}`。
 *  解析方式与客户端 chatStream 逐行处理的那一套必须一致(见 src/api.ts),
 *  否则这里过了、浏览器里不过。 */
async function readChat(res) {
  const deltas = []
  let done = null
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
      if (evt.done) done = evt
    }
  }
  return { deltas, text: deltas.join(''), done }
}

/* ===== 用例 =========================================================== */

const SCENE_FULL =
  'self:me leaning on the balcony rail at dusk, the rain just stopped, ' +
  'streetlights coming on below, hair still wet from the shower, ' +
  'the harbour lights doubled in the puddles on the deck'

async function main() {
  console.log('对话出图端到端探针\n')

  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r))

  const app = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT) },
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

  try {
    /* —— 用例 1：短场景，末尾两枚标签 —— */
    console.log('用例 1 · 普通回复 + 两枚标签')
    chatReply = 'Rain again. I am so tired of it.\n[photo:self:me on the balcony]\n[mood:tired]'
    let r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    let out = await readChat(r)
    ok('正文里没有标签残留', !/\[(photo|mood)/.test(out.text), JSON.stringify(out.text))
    ok('正文完整（末句没被扣掉）', out.text.trim().endsWith('tired of it.'), JSON.stringify(out.text))
    ok('photo 剪出来了且 self 前缀被剪掉', out.done?.photo === 'me on the balcony', String(out.done?.photo))
    ok('photoSelf = true', out.done?.photoSelf === true)
    ok('self: 只说"它在画面里"，相机那一项留空给客户端判', out.done?.photoShot === '', String(out.done?.photoShot))
    ok('mood = tired', out.done?.mood === 'tired', String(out.done?.mood))
    ok(
      '流式期间没有任何一帧露出半截标签',
      out.deltas.every((d) => !/\[(p|ph|pho|m|mo|moo)/.test(d)),
      JSON.stringify(out.deltas.filter((d) => d.includes('[')))
    )
    /* 这一条量的是"扣尾有没有把正文也一起停住"。**不是**量分了多少帧 ——
       扣尾会让释放的批次变少(那是它的正常工作),所以只要求正文被分成了
       多帧、而不是等到流末才一次吐出来 */
    const proseFrames = out.deltas.filter((d) => !d.includes('[photo') && d.trim())
    ok('正文是分多帧流出来的(扣尾没有把正文停住)', proseFrames.length > 3, String(proseFrames.length))

    /* —— 用例 1b：正文末尾的那个换行不许流到界面上 ——
       模型把标签写在单独一行,而那个 `\n` **总是比标签先到**。按"标签起点"
       算出来的放行边界正好落在它后面,于是它被当成正文发出去;收尾那次
       splitTags 的 trimEnd 追不回来(字早发出去了)。气泡是 pre-wrap,
       结尾的 `\n` 会被如实渲染成一行空行 —— 用户看到的就是"短回复底下
       多了一行"。这条断言的是**流出来的正文精确等于那句话**,不带尾巴 */
    console.log('\n用例 1b · 正文末尾不带那个换行')
    chatReply = 'Sure.\n[mood:calm]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('流出来的正文精确等于那句话(末尾没有换行)', out.text === 'Sure.', JSON.stringify(out.text))
    ok('mood 照旧剪出来', out.done?.mood === 'calm', String(out.done?.mood))
    /* 空行只可能从末尾来;中间那个换行(如果模型真写了分行)必须留着 */
    chatReply = 'First line.\nSecond line.\n[photo:a window at dawn]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('正文中间的分行留着', out.text === 'First line.\nSecond line.', JSON.stringify(out.text))

    /* —— 用例 1d：正文里的 emoji 不许被弄坏 ——
       放开 emoji 之后,风险不在"模型写不写",而在**链路上有没有东西把它吃掉
       或截断**。假上游的 tinyChunks 是按 UTF-16 码元每 3 个切一刀,所以一个
       emoji(代理对 = 2 个码元)必然被劈进两帧,中间还要过 JSON、过扣尾的
       逐段回退再拼回来。这一条盯的就是"劈开之后还能不能拼回去"。
       用例里特意放了两个更脆的:😮‍💨 是 ZWJ 连接符拼起来的组合,
       ✨️ 后面跟着变体选择符 —— 它们比单个 emoji 更容易被按码元截断 */
    console.log('\n用例 1d · 正文里的 emoji 原样保留')
    chatReply = '累死了😮\u200d💨 不过还行✨\uFE0F\n[mood:tired]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok(
      'emoji(ZWJ 组合 + 变体选择符)一字不差',
      out.text === '累死了😮\u200d💨 不过还行✨\uFE0F',
      JSON.stringify(out.text)
    )
    ok('末尾的 mood 照旧剪掉', out.done?.mood === 'tired', String(out.done?.mood))

    /* —— 用例 1c：标签被正文顶到中间 ——
       模型先说一句、再决定给你看张图、然后又补一句收尾的话。splitTags 只认末尾
       (那是为了不误吃正文里的方括号),所以这一枚原来会**原样流给用户看** ——
       用户在聊天框里看见一行 `[photo:self:…]`。现在由 stripStandaloneTags 摘掉,
       意图照样报上来(图还是要发的) */
    console.log('\n用例 1c · 中段那枚标签不许露给用户')
    chatReply =
      '等下等下,这个状态你也想看呀?\n\n[photo:self:me in the car, tired but grinning]\n\n怎么样,值不值得等这么久诶?\n[mood:tired]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('正文里没有标签残留', !/\[\s*(photo|mood)/i.test(out.text), JSON.stringify(out.text))
    ok(
      '中段那个换行/空行也没留下一堆空行',
      out.text === '等下等下,这个状态你也想看呀?\n\n怎么样,值不值得等这么久诶?',
      JSON.stringify(out.text)
    )
    ok('意图照样报上来(图还是要发的)', out.done?.photo === 'me in the car, tired but grinning', String(out.done?.photo))
    ok('self: 也认出来了', out.done?.photoSelf === true)
    ok('中段那枚同样不带相机信息', out.done?.photoShot === '', String(out.done?.photoShot))
    ok('末尾那枚 mood 照旧', out.done?.mood === 'tired', String(out.done?.mood))

    /* —— 用例 2：接近上限的长场景 —— */
    console.log('\n用例 2 · 长场景（' + SCENE_FULL.length + ' 字）')
    chatReply = `Look at this.\n[photo:${SCENE_FULL}]\n[mood:warm]`
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    /* 场景原文里的 `self:` 是**标记不是内容**,服务端会连冒号一起剪掉 ——
       所以比对的是剪过的那一份。用显式的去前缀而不是数下标:
       标记的字符数一变,数下标就会静静地错一位 */
    const sceneText = SCENE_FULL.replace(/^self:/, '')
    ok('长场景整段保住', out.done?.photo === sceneText, `len=${out.done?.photo?.length} 期望 ${sceneText.length}`)
    ok('photoSelf = true（self: 前缀）', out.done?.photoSelf === true)
    ok('正文里没有标签残留', !/\[photo/.test(out.text))
    ok('正文本身完整', out.text.trim() === 'Look at this.', JSON.stringify(out.text))
    /* 关键：正文必须在场景那 400 字还没写完时就已经到了客户端。
       否则等于"扣尾把整条回复停到了流末" —— 那正是旧版按长度预留的毛病 */
    ok(
      '正文在场景写完之前就已经流出去了（扣尾没把整条回复停住）',
      out.text.trim() === 'Look at this.' && out.deltas.length > 3,
      JSON.stringify(out.deltas.slice(0, 5))
    )

    /* —— 用例 3：场景照（不写 self:）—— */
    console.log('\n用例 3 · 场景照')
    chatReply = 'It is coming down hard.\n[photo:rain on the window at dawn]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('photo 剪出来了', out.done?.photo === 'rain on the window at dawn')
    ok('photoSelf = false（不写前缀就是它看到的东西）', out.done?.photoSelf === false)
    ok('画面里没有人，相机那一项自然是空的', out.done?.photoShot === '', String(out.done?.photoShot))
    ok('没有 mood 时 mood 是空串', out.done?.mood === '')

    /* —— 用例 3b：自拍 / 他拍由标签说清（2026-10-05 新增） ——
       在这之前，视角交给一次只看得到场景的文本调用去猜，猜出来大多是他拍 ——
       用户的原话是"对于自拍的理解总是不好，老是会生成他拍视角的图片"。
       现在模型自己写 `selfie:` / `third:`，服务端原样带出来 */
    console.log('\n用例 3b · 谁拿的相机')
    chatReply = 'One second, mirror is fogged.\n[photo:selfie:me in the bathroom mirror, hair wet]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('photoShot = selfie', out.done?.photoShot === 'selfie', String(out.done?.photoShot))
    ok('selfie: 前缀也说明它在画面里', out.done?.photoSelf === true)
    ok('前缀不进场景描述', out.done?.photo === 'me in the bathroom mirror, hair wet', String(out.done?.photo))

    chatReply = 'Caught me off guard.\n[photo:third:me on stage, taken from the crowd]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('photoShot = third', out.done?.photoShot === 'third', String(out.done?.photoShot))
    ok('photoSelf 照样是 true（它在画面里，只是相机在别人手上）', out.done?.photoSelf === true)
    ok('前缀不进场景描述', out.done?.photo === 'me on stage, taken from the crowd', String(out.done?.photo))

    /* —— 用例 3c：这一张离得多近（2026-10-06 新增） ——
       用户报的是"让角色拍特写图，总是变成自拍"。景别在服务端只做一件事：
       把标签里那个词原样带出去 —— 而它**很容易在这一层被漏掉**（多一个字段、
       多一处解构、多一处 return），漏掉的表现是静默的：图照样出得来，
       只是又变回一张臂展自拍。所以这里两个形状都要盯：
       带相机前缀的、以及人根本不在画面里的那种"拍个特写给我看" */
    console.log('\n用例 3c · 这一张离得多近')
    chatReply = 'Look, up close.\n[photo:selfie:close:my eyes, looking straight at you]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('photoFrame = close', out.done?.photoFrame === 'close', String(out.done?.photoFrame))
    ok('photoShot 照旧', out.done?.photoShot === 'selfie', String(out.done?.photoShot))
    ok('两类前缀都不进场景描述', out.done?.photo === 'my eyes, looking straight at you', String(out.done?.photo))

    /* 人不在画面里也照样有景别 —— 这正是"拍个特写给我看"最常见的形状 */
    chatReply = 'Here.\n[photo:close:rain running down the window pane]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('空镜也有景别', out.done?.photoFrame === 'close', String(out.done?.photoFrame))
    ok('空镜仍然没有人', out.done?.photoSelf === false)
    ok('相机那一项仍然是空的', out.done?.photoShot === '', String(out.done?.photoShot))

    /* 没说就是空串 —— 客户端据此落回"按场景判、再不行这一档的缺省" */
    chatReply = 'Fine.\n[photo:selfie:me on the balcony]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('没说景别时是空串（不是替它猜一个）', out.done?.photoFrame === '', String(out.done?.photoFrame))

    /* 半身那一档是他拍那一档**唯一**能比"全身"更近的来路：它的缺省就是全身，
       而 scene 词表与标签前缀都得走通，那段覆盖才不是死代码 */
    chatReply = 'Sure, up close.\n[photo:third:medium:me at my desk, the lamp still on behind me]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('半身那一档也带得出来', out.done?.photoFrame === 'medium', String(out.done?.photoFrame))

    /* 中段那枚标签那条路也要带上它 —— 两条路的字段是分开解构的 */
    chatReply = 'One sec.\n\n[photo:third:close:my hands wrapped around the mug]\n\nOkay.'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('中段那枚也带景别', out.done?.photoFrame === 'close', String(out.done?.photoFrame))
    ok('中段那枚的视角也在', out.done?.photoShot === 'third', String(out.done?.photoShot))

    /* —— 用例 4：photo 档确实按五行回 —— */
    console.log('\n用例 4 · /api/enhance 的 photo 档')
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

    /* —— 用例 5：/api/generate 收到的是什么 —— */
    console.log('\n用例 5 · /api/generate 收到的载荷')
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

    /* —— 用例 6：出图失败时，原因必须传到浏览器 ——
       这一条是"图片生成失败根本没有详细提示"那次报错的回归。
       浏览器那边只显示 `photoFailureText(e.message)`，所以**服务端把原话
       传没传出来**就是这条链的全部 —— 传丢了，界面上就只剩"生成失败"。 */
    console.log('\n用例 6 · 出图失败时原因要传到浏览器')
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

    /* —— 用例 7：时间那一块 ——
       "现在几点 / 上次说话"由前端算好、服务端拼进 system（见 server/chatTime.js）。
       这一条链上会静默出错的正是**接缝**：前端没把字段发出来、服务端没接住、
       或者接住了却插错位置 —— 三种都不会报错，角色只是变得不知道时间，
       而"它不知道时间"这件事在产品上完全看不出来（它照聊不误）。 */
    console.log('\n用例 7 · 时间那一块')
    chatReply = 'Sure.'
    const STAMP = '2026-10-05T23:41:07+08:00'
    const STAMP_MS = Date.parse(STAMP)
    const systemOf = () => String(seen.chat?.messages?.[0]?.content || '')

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
      '规则里点明"标签必须在最后、后面不许再有话"',
      systemOf().includes('Nothing may come after it')
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
       但少了这一句，`close:` 就永远不会出现在标签里，特写还是变自拍 */
    ok(
      '规则里教了景别那个词，并且点明"拿着的东西的特写不是自拍"',
      systemOf().includes('[photo:selfie:close:') &&
        systemOf().includes('is not a selfie') &&
        systemOf().includes("not a picture of your face held out at arm's length"),
      JSON.stringify(systemOf().split('\n').filter((l) => l.includes('close:')))
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

    /* —— 用例 8：心情那一块 ——
       与时间同一条理由：这条链上会静默出错的正是**接缝** ——
       前端没把状态发出来、服务端没接住、或者接住了却插错位置。
       三种都不报错，角色只是变成"每一轮从零决定心情"，
       而这在界面上**完全看不出来**（它照聊不误，药丸也照常显示）。
       行首锚定的正则，不拿 includes('wary') 判 —— 场景里本来就可能出现那个词 */
    console.log('\n用例 8 · 心情那一块')
    chatReply = 'Fine.'
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

    /* —— 用例 9：说话样本那一栏（2026-10-08）——
       它与规则不是一类：规则是"要求"，样本是"照着抄口吻的例子"。所以断言两件事：
       它进了 system，而且带着那句**读法**（跟着语气、不要跟着话题）——
       少了那句读法，模型会把样例里的**场景**当成当下的事实搬进这一轮。 */
    console.log('\n用例 9 · 说话样本')
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
