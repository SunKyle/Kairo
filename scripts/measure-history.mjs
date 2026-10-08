#!/usr/bin/env node
/* ===== 历史页性能测量 ==================================================
   用无头 Chrome + DevTools 协议量三件事,给出"改动前后"能对比的数字:

   1. 启动:导航开始 → 首页图墙出现第一块(含 loadHistory 读库 + 渲染)
   2. 历史页:点导航 → 图块铺出来(这是 T3.1 要盯的那条)
   3. DOM 规模:节点总数与 <img> 数(全量渲染会随条数线性涨)

   为什么要真开一个浏览器:这些数字里没有一个能在 Node 里算出来 ——
   它们取决于真实布局、图片解码与 Vue 的挂载成本。

   用法(先起一个服务):
     npx vite preview --port 4173 &
     node scripts/measure-history.mjs --url http://localhost:4173/ --records 500

   只依赖 undici(项目已有依赖,它带 WebSocket),不引入 puppeteer。
   -------------------------------------------------------------------- */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'undici'

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const URL_ = arg('url', 'http://localhost:4173/')
const RECORDS = Number(arg('records', 500))
const IMAGES = Number(arg('images', 2))
const IMG_SIZE = Number(arg('img-size', 256))
/* 造不带缩略图的老数据:这样 backfillThumbs 才有活干(它只补缺的) */
const NO_THUMB = args.includes('--no-thumb')
/* 启动之后观察多久的长任务(毫秒) */
const SETTLE_MS = Number(arg('settle-ms', 4000))
/* 顺带量一下编码成本:画布那条路把位图编成 data URL 是不是真的卡主线程 */
const PROBE_ENCODE = args.includes('--probe-encode')
/* 探一下存储层的让位与重开:另一个连接要删库时,应用必须让开并且能重新开起来 */
const PROBE_REOPEN = args.includes('--probe-reopen')
/* 开第二个标签页,验证跨页同步真的把改动传过去了 */
const PROBE_TWO_TABS = args.includes('--probe-two-tabs')
/* 探画布的操作序列:上传一张图,旋转 → 撤销 → 重做 → 跳步,看步骤条对不对 */
const PROBE_CANVAS = args.includes('--probe-canvas')
/* 探接口配置那一域:设置页新增一条 → 回首页看参数行胶囊是不是它 */
const PROBE_CONFIG = args.includes('--probe-config')
/* 探历史那一域:删一条 → 撤销把它放回来;再建一个作品集 */
const PROBE_HISTORY = args.includes('--probe-history')
/* 探角色那一域:新建一个角色 → 卡片出现 → 拿它开画 */
const PROBE_CHARS = args.includes('--probe-chars')
/* 探对话那一域:播种一段对话与记忆 → 渲染 → 清空 */
const PROBE_CHAT = args.includes('--probe-chat')
/* 探出图参数那一层:尺寸档位、参考图上传与清除 */
const PROBE_PARAMS = args.includes('--probe-params')
/* 探出图编排层:没有可用接口时,那条失败路径也要走完 */
const PROBE_GEN = args.includes('--probe-gen')
/* 钉住主题(light / dark)。不钉的话跟随系统偏好 —— 而无头下拿到的往往是
   宿主机自己的偏好,同一份代码在两台机器上截出来的图不是一套配色。
   核对"浅色下的对比度"这类事情时必须能固定住某一套 */
const THEME = arg('theme', '')
if (THEME && THEME !== 'light' && THEME !== 'dark') {
  console.error(`--theme 只认 light / dark,收到的是 ${THEME}`)
  process.exit(1)
}
/* 调试端口每轮随机取一个:固定端口会与上一次没退干净的实例撞车,
   而那种撞车表现为"连上了,但连到的是别人",量出来的数看着正常其实全错 */
const PORT = Number(arg('cdp-port', 0)) || 9300 + Math.floor(Math.random() * 600)
/* Chrome 的位置按平台找:本地(macOS)与 CI(Linux)要都能跑起来。
   找不到就交给 PATH —— GitHub 的 runner 上 google-chrome 就在 PATH 里 */
function defaultChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]
  for (const p of candidates) if (existsSync(p)) return p
  return 'google-chrome'
}
const CHROME = arg('chrome', process.env.CHROME_PATH || defaultChrome())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 探画布时要塞一个真文件进 <input type=file>:CDP 只能注入磁盘上的路径,
   所以这里现造一张 PNG。
   **别用"背下来的 base64"** —— 我第一版就是这么干的,那张图是坏的:
   解码失败 → source 为 null → rebuild() 直接清空步骤,于是表现为
   "点了旋转但什么都没发生"。按规范拼一张(CRC 也算对)才是可靠的 */
const UPLOAD_PNG = join(tmpdir(), `kimage-probe-${process.pid}.png`)
writeFileSync(UPLOAD_PNG, makePng(64))

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** 一张 size×size 的 8 位 RGB PNG(渐变 + 每行不同,够画布做旋转/翻转) */
function makePng(size) {
  const stride = size * 3 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // 过滤器:None
    for (let x = 0; x < size; x++) {
      const i = y * stride + 1 + x * 3
      raw[i] = (x * 4) % 256
      raw[i + 1] = (y * 4) % 256
      raw[i + 2] = 128
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 颜色类型:真彩
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* —— 启动 Chrome —— */
const profile = mkdtempSync(join(tmpdir(), 'kimage-perf-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    /* 这几条是在受限环境(容器/沙箱)里跑起来的必要条件:
       Chrome 自己的沙箱初始化会被外层沙箱拒掉("sandbox initialization failed"),
       渲染与网络进程随即崩溃、CDP 连接被关(1006)。关掉它的沙箱并把
       crashpad 一并关掉,才能稳定跑完测量。仅用于本地测量,不是产品配置 */
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-crashpad',
    '--disable-crash-reporter',
    // Chrome 111+ 默认拒绝带 Origin 的调试连接
    '--remote-allow-origins=*',
    // 关掉节流:无头下 rAF/定时器会被压制,量出来的"渲染完成"会假慢
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    URL_
  ],
  { stdio: 'ignore', detached: false }
)

let ws
let msgId = 0
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP 超时: ${method}`))
    }, 60_000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`))
      else resolve(msg.result)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 在页面里跑一段脚本并等它的 promise 结果 */
async function evaluate(fn, ...fnArgs) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${fnArgs.map((a) => JSON.stringify(a)).join(', ')})`,
    awaitPromise: true,
    returnByValue: true
  })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || '页面脚本抛错')
  return result.value
}

/* —— 截图(可选,`--shot-dir` 才拍)——
   间距、对齐、留白这类东西**只能用眼睛判断**:它们没有可断言的判据,
   而恰恰是 UI 改动里最容易翻车的一类。固定视口再拍,是为了让前后两次
   (改动前 / 改动后)排布可比 —— 窗口大小不同的话截出来的图没法对着看 */
const SHOT_DIR = arg('shot-dir', '')
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })
async function shot(name, width = 1280, height = 900) {
  if (!SHOT_DIR) return
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    /* 窄屏那几张按手机算(dsf 2 + mobile):媒体查询、触控目标、
       safe-area 那一套只有在这种尺寸下才真的走到 */
    deviceScaleFactor: width <= 480 ? 2 : 1,
    mobile: width <= 480
  })
  // 视口一变会重排,等一拍再拍,免得拍到旧的布局
  await sleep(300)
  const res = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(SHOT_DIR, `${name}.png`)
  writeFileSync(file, Buffer.from(res.data, 'base64'))
  await send('Emulation.clearDeviceMetricsOverride')
  console.log(`   📷 ${file}`)
}

/* 再连一个页面 target(第二个标签页要单独一条通道) */
async function connectTarget(wsUrl) {
  const sock = new WebSocket(wsUrl)
  const pend = new Map()
  let n = 0
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    const f = m.id && pend.get(m.id)
    if (f) {
      pend.delete(m.id)
      f(m)
    }
  })
  await new Promise((r) => sock.addEventListener('open', r, { once: true }))
  const sendTo = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++n
      const timer = setTimeout(() => {
        pend.delete(id)
        rej(new Error(`CDP 超时(第二页): ${method}`))
      }, 30_000)
      pend.set(id, (m) => {
        clearTimeout(timer)
        if (m.error) rej(new Error(m.error.message))
        else res(m.result)
      })
      sock.send(JSON.stringify({ id, method, params }))
    })
  const runOn = async (fn, ...a) => {
    const { result, exceptionDetails } = await sendTo('Runtime.evaluate', {
      expression: `(${fn.toString()})(${a.map((x) => JSON.stringify(x)).join(', ')})`,
      awaitPromise: true,
      returnByValue: true
    })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || '第二页脚本抛错')
    return result.value
  }
  return { send: sendTo, evaluate: runOn, close: () => sock.close() }
}

/** 让另一个标签页切到历史页。
 *  用真实鼠标事件:分段控件是 @pointerdown 驱动的,合成 click 不生效 */
async function gotoHistory(client) {
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  // 应用挂载完才有导航按钮(新标签页要等它加载)
  for (let i = 0; i < 60; i++) {
    if (await client.evaluate(() => !!document.querySelector('button[aria-label="History"]')))
      break
    await sleep(250)
  }
  const box = await client.evaluate(() => {
    const b = document.querySelector('button[aria-label="History"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  if (!box) throw new Error('另一个标签页找不到导航按钮')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1
    })
  }
  // 等图块铺出来
  for (let i = 0; i < 80; i++) {
    const n = await client.evaluate(() => document.querySelectorAll('section.lib .tile').length)
    if (n > 0) return n
    await sleep(100)
  }
  return 0
}

/* 等某个 CDP 事件到达(只在需要时挂一次监听) */
function onceEvent(method, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg)
      reject(new Error(`等不到事件: ${method}`))
    }, timeoutMs)
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === method) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMsg)
        resolve(msg.params)
      }
    }
    ws.addEventListener('message', onMsg)
  })
}

/* 等页面里某个条件成立。比"等 load 事件"可靠:应用的落库是异步的 */
async function waitFor(label, checkFn, timeoutMs = 30_000) {
  const started = Date.now()
  let lastErr = null
  for (;;) {
    try {
      if (await evaluate(checkFn)) return Date.now() - started
    } catch (e) {
      // 文档正在切换时取数会抛(见上面那段)。这不是失败,下一轮再看
      lastErr = e
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等不到: ${label}${lastErr ? ` (最后一次: ${lastErr.message})` : ''}`)
    }
    await sleep(50)
  }
}

async function main() {
  // 等 CDP 端口就绪
  let version = null
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      version = await r.json()
      break
    } catch {
      await sleep(250)
    }
  }
  if (!version) {
    throw new Error(
      `Chrome 的调试端口没起来(用的是 ${CHROME})。本地可用 --chrome <路径> 指定,或设 CHROME_PATH`
    )
  }

  // 找到我们那个页面(启动时就带了 URL)
  let page = null
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && t.url.startsWith(URL_.split('?')[0]))
    if (page) break
    await sleep(250)
  }
  if (!page) throw new Error('找不到打开的页面')

  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const done = pending.get(msg.id)
      pending.delete(msg.id)
      done(msg)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  await send('Runtime.enable')
  await send('Page.enable')

  /* 先把文档"落定"。启动时带的那个 URL 在导航开始后 target.url 就变了,
     但文档可能还是旧的 about:blank —— 这时候 Runtime.evaluate 作用在旧文档上,
     indexedDB 会以 SecurityError 被拒(第一版就撞上过这个)。主动 reload 一次、
     等 load 事件,才能保证后面每一条脚本都跑在我们的页面上 */
  const firstLoad = onceEvent('Page.loadEventFired')
  await send('Page.reload', { ignoreCache: true })
  await firstLoad

  /* 主题要在应用读它之前写好(见 lib/theme.ts 的 savedTheme)——
     下面每次重载都会带上它 */
  if (THEME) await evaluate((t) => localStorage.setItem('kimage.theme', t), THEME)

  // 应用自己会建库(表结构都在它那儿),所以要等它先跑过一轮
  await waitFor('应用建好 IndexedDB', () =>
    indexedDB.databases().then((d) => d.some((x) => x.name === 'kimage.db'))
  )

  // —— 造数据。直接写 IndexedDB,绕开应用自己的清理逻辑 ——
  const seeded = await evaluate(
    async (n, images, size, noThumb) => {
      const c = document.createElement('canvas')
      c.width = c.height = size
      const ctx = c.getContext('2d')
      const g = ctx.createLinearGradient(0, 0, size, size)
      g.addColorStop(0, '#2b6cb0')
      g.addColorStop(1, '#f6ad55')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, size, size)
      // 撒点噪声,别让图片压成几百字节 —— 解码成本要接近真实
      const px = ctx.getImageData(0, 0, size, size)
      for (let i = 0; i < px.data.length; i += 4) px.data[i] = (px.data[i] + Math.random() * 60) % 255
      ctx.putImageData(px, 0, 0)
      const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.85))

      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('kimage.db')
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      const tx = db.transaction('history', 'readwrite')
      const store = tx.objectStore('history')
      const now = Date.now()
      for (let i = 0; i < n; i++) {
        store.put({
          id: `perf-${i}`,
          prompt: `performance probe record ${i}`,
          size: '1024x1024',
          model: 'perf-model',
          createdAt: now - i * 60_000,
          results: Array.from({ length: images }, () => ({ type: 'b64', data: blob })),
          // 老记录没有缩略图与尺寸 —— backfillThumbs 要补的正是这两项
          ...(noThumb ? {} : { thumb: blob, w: size, h: size })
        })
      }
      await new Promise((r) => (tx.oncomplete = r))
      db.close()
      return n
    },
    RECORDS,
    IMAGES,
    IMG_SIZE,
    NO_THUMB
  )

  /* 长任务观察器要在**页面脚本之前**装好,否则会漏掉启动那一段 ——
     而"启动之后还在跑的后台活儿"正是 backfillThumbs 那类问题的形状 */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__lt = [];
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration));
        }).observe({ entryTypes: ['longtask'] });
      } catch (e) { window.__ltError = String(e); }
    `
  })

  /* —— 启动路径:重载 → 新文档 load → 首页图墙出现第一块 ——
     必须等 loadEventFired:在此之前量到的 performance.now() 还是**旧文档**的,
     两个文档的 timeOrigin 不同,混在一起算出来的数没有意义 */
  const loaded = onceEvent('Page.loadEventFired')
  await send('Page.reload', { ignoreCache: true })
  await loaded
  // 此刻 performance.now() 已经是新文档里相对 navigationStart 的毫秒数
  await waitFor('首页图墙首块', () => document.querySelectorAll('.feed-grid .tile').length > 0)
  const startupMs = await evaluate(() => performance.now())
  const navTiming = await evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0]
    return n
      ? { domContentLoaded: Math.round(n.domContentLoadedEventEnd), loadEnd: Math.round(n.loadEventEnd) }
      : null
  })

  // —— 历史页:点导航 → 图块铺出来 ——
  /* 点导航必须走**真实输入**:分段控件是 @pointerdown 驱动的,
     合成一次 click() 不会切页(第一版就踩了这个坑,量到的一直是首页) */
  const btnBox = await evaluate(() => {
    const b = document.querySelector('button[aria-label="History"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    window.__t0 = performance.now()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  if (!btnBox) throw new Error('找不到 History 导航按钮')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: btnBox.x,
      y: btnBox.y,
      button: 'left',
      clickCount: 1
    })
  }

  const history = await evaluate(async () => {
    const nav = document.querySelector('button[aria-label="History"]')
    const t0 = window.__t0 || performance.now()
    const deadline = t0 + 30_000
    /* 两段等待缺一不可:
       1. 导航真的切过去(aria-checked)—— 首页那 12 块 .tile 在切换瞬间还在
          DOM 里,只等 .tile 出现会立刻"成功",量到的是上一页
       2. 图块数量稳定下来 —— 这才是"全部铺完"的那一刻,DOM 计数才有意义 */
    while (nav?.getAttribute('aria-checked') !== 'true' && performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(r))
    }
    const switched = nav?.getAttribute('aria-checked') === 'true'
    let last = -1
    let stable = 0
    while (performance.now() < deadline && stable < 3) {
      const n = document.querySelectorAll('section.lib .tile').length
      if (n === last) stable++
      else {
        stable = 0
        last = n
      }
      await new Promise((r) => requestAnimationFrame(r))
    }
    /* 只数这一页自己的子树:无头模式下离场页的过渡可能不结束,
       残留的上一页会混进文档级计数(第一版就把首页那 12 块算进来了) */
    const page = document.querySelector('section.lib')
    return {
      switched,
      msToStable: +(performance.now() - t0).toFixed(1),
      tiles: page ? page.querySelectorAll('.tile').length : 0,
      imgs: page ? page.querySelectorAll('img').length : 0,
      domNodes: page ? page.getElementsByTagName('*').length : 0,
      // 顺带报一下文档级:能看出残留页有多大
      docDomNodes: document.getElementsByTagName('*').length,
      pageCount: document.querySelectorAll('main.frame > section').length
    }
  })

  /* —— 启动之后的后台活儿 ——
     静置一段时间,看主线程被长任务占了多少(>50ms 的才算),
     以及多少条老记录被补上了缩略图 */
  await sleep(SETTLE_MS)
  const background = await evaluate(async (settleMs) => {
    const lt = window.__lt || []
    const stats = {
      settleMs,
      longTasks: lt.length,
      totalBlockingMs: lt.reduce((a, b) => a + b, 0),
      maxTaskMs: lt.length ? Math.max(...lt) : 0
    }
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('kimage.db')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const all = await new Promise((res, rej) => {
      const r = db.transaction('history', 'readonly').objectStore('history').getAll()
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    db.close()
    stats.records = all.length
    stats.withThumb = all.filter((r) => r.thumb && r.w && r.h).length
    return stats
  }, SETTLE_MS)

  /* —— 编码探针 ——
     画布那条路要交的是 data URL,而 toDataURL 是**全同步**的:
     大图那一下会把主线程按住(原地编辑的"点了没反应"多半来自这里)。
     同尺寸下再量一遍 toBlob + FileReader 那条异步路做对照。 */
  const encode = PROBE_ENCODE
    ? await evaluate(async (size) => {
        const c = document.createElement('canvas')
        c.width = size
        c.height = Math.round((size * 9) / 16)
        const ctx = c.getContext('2d')
        const g = ctx.createLinearGradient(0, 0, c.width, c.height)
        g.addColorStop(0, '#2b6cb0')
        g.addColorStop(1, '#f6ad55')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, c.width, c.height)
        // 撒噪声:纯色图 PNG 只要几十 KB,量不出真实编码成本
        const px = ctx.getImageData(0, 0, c.width, c.height)
        for (let i = 0; i < px.data.length; i += 4) px.data[i] = (px.data[i] + Math.random() * 60) % 255
        ctx.putImageData(px, 0, 0)

        const time = (fn) => {
          const t = performance.now()
          const v = fn()
          return { ms: +(performance.now() - t).toFixed(1), v }
        }
        const jpeg = time(() => c.toDataURL('image/jpeg', 0.92))
        const png = time(() => c.toDataURL('image/png'))
        const blobStart = performance.now()
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92))
        const blobMs = +(performance.now() - blobStart).toFixed(1)
        const readStart = performance.now()
        const url = await new Promise((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(String(fr.result))
          fr.onerror = () => reject(fr.error)
          fr.readAsDataURL(blob)
        })
        const readMs = +(performance.now() - readStart).toFixed(1)
        return {
          size: `${c.width}x${c.height}`,
          // 同步:这两下期间主线程什么都干不了
          jpegDataUrlSyncMs: jpeg.ms,
          pngDataUrlSyncMs: png.ms,
          jpegDataUrlMB: +(jpeg.v.length / 1048576).toFixed(2),
          pngDataUrlMB: +(png.v.length / 1048576).toFixed(2),
          // 异步:编码交给浏览器,主线程只在回调时被占用
          toBlobMs: blobMs,
          blobToDataUrlMs: readMs,
          asyncTotalMs: +(blobMs + readMs).toFixed(1),
          sameBytes: url.length === jpeg.v.length
        }
      }, Number(arg('probe-size', 2560)))
    : null

  /* —— 让位与重开探针 ——
     缓存了连接之后,"别人要删库/升级"这条路上必须做两件事:
     ① 让开(否则对方的 deleteDatabase 会一直卡在 blocked)
     ② 之后还能重新开起来并写入(否则缓存就永久指向一个死连接)
     单测覆盖不到这一段(要真的 IndexedDB),所以在真浏览器里走一遍:
     标记一张图触发一次写 → 从页面里删库 → 再标记一次触发写 → 读回来确认 */
  const reopen = PROBE_REOPEN
    ? await evaluate(async () => {
        const out = { steps: [] }
        const open = () =>
          new Promise((res, rej) => {
            const r = indexedDB.open('kimage.db')
            r.onsuccess = () => res(r.result)
            r.onerror = () => rej(r.error)
          })
        const readCount = async () => {
          const db = await open()
          const all = await new Promise((res, rej) => {
            const r = db.transaction('history', 'readonly').objectStore('history').getAll()
            r.onsuccess = () => res(r.result)
            r.onerror = () => rej(r.error)
          })
          db.close()
          return all
        }
        const clickMark = () => {
          const b = [...document.querySelectorAll('button')].find(
            (x) => (x.getAttribute('aria-label') || '').startsWith('Mark image')
          )
          if (!b) return false
          b.click()
          return true
        }
        const settle = () => new Promise((r) => setTimeout(r, 400))

        // ① 先写一次(标记一张图),确认正常
        out.steps.push(['click first mark', clickMark()])
        await settle()
        const afterFirst = await readCount()
        out.markedAfterFirst = afterFirst.filter((r) => r.results?.some((x) => x.marked)).length

        // ② 从页面里删库:应用的连接必须让开,否则这里会一直 blocked
        const delStart = performance.now()
        out.deleteResult = await new Promise((res) => {
          const req = indexedDB.deleteDatabase('kimage.db')
          req.onsuccess = () => res('success')
          req.onerror = () => res('error')
          req.onblocked = () => res('blocked')
          setTimeout(() => res('timeout'), 5000)
        })
        out.deleteMs = +(performance.now() - delStart).toFixed(1)

        // ③ 再写一次:应用应当重新开库(顺带重建表结构)并写进去
        await settle()
        out.steps.push(['click mark after delete', clickMark()])
        await settle()
        try {
          const afterSecond = await readCount()
          out.recordsAfterReopen = afterSecond.length
        } catch (e) {
          out.reopenError = String(e)
        }
        return out
      })
    : null

  /* —— 跨标签页同步探针 ——
     同一个 Chrome profile 下的两个标签页共享 IndexedDB 与 BroadcastChannel。
     在 A 页标记一张图,看 B 页(已经开着历史页)会不会跟着亮出标记角标。
     这是 A2 唯一的真实验证方式:纯函数单测只能证明"合并逻辑对",
     证明不了"广播真的送到了、而且对面真的重读了"。 */
  let twoTabs = null
  if (PROBE_TWO_TABS) {
    twoTabs = { steps: [] }
    const created = await fetch(
      `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`,
      { method: 'PUT' }
    ).then((r) => (r.ok ? r.json() : null))
    if (!created?.webSocketDebuggerUrl) {
      twoTabs.error = '开不了第二个标签页'
    } else {
      const other = await connectTarget(created.webSocketDebuggerUrl)
      try {
        twoTabs.tilesInB = await gotoHistory(other)
        const countMarked = () =>
          other.evaluate(() => document.querySelectorAll('section.lib .tile-mark').length)
        twoTabs.markedInB_before = await countMarked()

        // 在 A 页标记第一张(点的是真实按钮,走的是应用自己的落库与广播)
        twoTabs.clickedInA = await evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) =>
            (x.getAttribute('aria-label') || '').startsWith('Mark image')
          )
          if (!b) return false
          b.click()
          return true
        })
        // 等广播(收拢窗口 250ms)+ 对面重读
        await sleep(2000)
        twoTabs.markedInB_after = await countMarked()
        /* 顺带把"提示条"也验了:同步之后 B 页应当弹一句"从另一个标签页更新"。
           这条通道(useFeedback)平时没有自动化覆盖,而它每一块业务域都要用 */
        twoTabs.noticeInB = await other.evaluate(
          () => document.querySelector('.note')?.textContent?.trim().slice(0, 48) || ''
        )
        twoTabs.passed =
          twoTabs.markedInB_after > twoTabs.markedInB_before &&
          /another tab/i.test(twoTabs.noticeInB)
      } catch (e) {
        twoTabs.error = String(e.message || e)
      } finally {
        /* 收尾必须**关掉那个标签页并回到前台**:留着它的话,后面探针发给
           主标签页的鼠标事件会不再生效(连跑时表现成"点了新建角色却什么都没有",
           单独跑却一路通过 —— 就是被这个坑掉的)。 */
        try {
          await other.send('Page.close')
        } catch {
          /* 关不掉也不该让测量整体失败 */
        }
        try {
          await send('Page.bringToFront')
        } catch {
          /* 同上 */
        }
        other.close()
        await sleep(400)
      }
    }
  }

  /* —— 画布操作序列探针 ——
     撤销/重做/跳步这套栈逻辑刚被搬进 lib/canvasOps.ts,那里有单测;
     但"组件真的接上了没有"只有真点一遍才知道。步骤条上的 .step 与
     aria-current 正好把"现在停在第几步、一共有几步"暴露在 DOM 上。 */
  let canvas = null
  if (PROBE_CANVAS) {
    canvas = { steps: [] }
    const readSteps = () =>
      evaluate(() => {
        const all = [...document.querySelectorAll('.step')]
        const btn = (l) => document.querySelector(`button[aria-label="${l}"]`)
        /* 按钮不在 DOM 里(比如左栏那组折叠着)时要报出来,而不是被
           `!undefined` 算成"可用" —— 那种假绿比红更糟 */
        return {
          total: all.length,
          current: all.findIndex((el) => el.getAttribute('aria-current') === 'true'),
          hasButtons: !!btn('Undo') && !!btn('Rotate right'),
          canUndo: btn('Undo') ? !btn('Undo').disabled : null,
          canRedo: btn('Redo') ? !btn('Redo').disabled : null
        }
      })
    /* 点击结果要记下来:找不到按钮、或按钮是 disabled(那时 click 是空操作),
       这两种"没点动"最容易被当成"点了但功能坏了" */
    const click = (label) =>
      evaluate((l) => {
        const b = document.querySelector(`button[aria-label="${l}"]`)
        if (!b) return 'missing'
        if (b.disabled) return 'disabled'
        b.click()
        return 'clicked'
      }, label)
    const settle = () => sleep(300)

    try {
      // 进画布页(与历史页同一套:分段控件是 pointerdown 驱动的)
      const box = await evaluate(() => {
        const b = document.querySelector('button[aria-label="Canvas"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
      if (!box) throw new Error('找不到画布导航')
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1
        })
      }
      await sleep(600)

      /* 左栏那几组低频工具默认是折着的(showMore=false),Rotate / Flip 都在里面。
         不展开的话按钮根本不在 DOM 里,而"点不到"会被静默当成"点了没用" */
      const expanded = await evaluate(() => {
        const b = document.querySelector('button[aria-label="More tools"]')
        if (!b) return false
        b.click()
        return true
      })
      canvas.steps.push(['expanded more tools', expanded])
      await sleep(400)

      // 把一张真图塞进那个隐藏的 input(用 CDP 的文件注入,不是合成事件)
      const { root } = await send('DOM.getDocument', { depth: -1 })
      const { nodeId } = await send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'input.cv-file'
      })
      if (!nodeId) throw new Error('找不到上传用的 input')
      await send('DOM.setFileInputFiles', { nodeId, files: [UPLOAD_PNG] })
      await sleep(1200)
      canvas.steps.push(['after upload', await readSteps()])

      // 旋转两次、翻转一次
      canvas.steps.push(['click Rotate right', await click('Rotate right')])
      await settle()
      canvas.steps.push(['after rotate', await readSteps()])
      await click('Rotate right')
      await settle()
      await click('Flip horizontal')
      await settle()
      canvas.steps.push(['after 3 ops', await readSteps()])

      // 撤销两步
      canvas.steps.push(['click Undo', await click('Undo')])
      await settle()
      await click('Undo')
      await settle()
      canvas.steps.push(['after undo x2', await readSteps()])

      // 重做一步
      canvas.steps.push(['click Redo', await click('Redo')])
      await settle()
      canvas.steps.push(['after redo', await readSteps()])

      // 跳回第 1 步(点步骤条上第一张缩略图)
      canvas.jumped = await evaluate(() => {
        const target = document.querySelectorAll('.step')[1]
        if (!target) return 'missing'
        target.click()
        return 'clicked'
      })
      await settle()
      canvas.steps.push(['after jump to step 1', await readSteps()])

      // 复位到底
      canvas.steps.push(['click Back to the original', await click('Back to the original')])
      await settle()
      canvas.steps.push(['after reset', await readSteps()])

      const at = (name) => canvas.steps.find(([n]) => n === name)[1]
      canvas.passed =
        canvas.jumped === 'clicked' &&
        // 原图 + 3 步 = 4 格
        at('after 3 ops').total === 4 &&
        at('after 3 ops').current === 3 &&
        at('after undo x2').current === 1 &&
        at('after undo x2').canRedo === true &&
        at('after redo').current === 2 &&
        at('after jump to step 1').current === 1 &&
        // 复位回到原图,而走过的三步仍留在重做栈里(所以还能点回来)
        at('after reset').current === 0 &&
        at('after reset').canRedo === true
    } catch (e) {
      canvas.error = String(e.message || e)
    }
  }

  /* —— 接口配置域探针 ——
     新增一条配置走的是「预设 → 表单 → 保存 → 设为当前」这条链,
     它横跨 useConfigs 的 saveSettings / 四类挑选 / 主界面参数行胶囊。
     纯函数单测覆盖不到"点了一遍到底成没成",所以在真页面里走一遍。 */
  let configProbe = null
  if (PROBE_CONFIG) {
    configProbe = { steps: [] }
    const clickNav = async (label) => {
      const box = await evaluate((l) => {
        const b = document.querySelector(`button[aria-label="${l}"]`)
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      }, label)
      if (!box) return false
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1
        })
      }
      return true
    }
    try {
      configProbe.openedSettings = await clickNav('Settings')
      await sleep(700)
      /* 空态给的是"四条能一键预填的入口"(.quick-item),点它会直接进表单并带好
         地址与模型;已经有配置时才是列表页。两种都认,免得探针只在一种状态下有效 */
      configProbe.clickedPreset = await evaluate(() => {
        const quick = document.querySelector('.quick .quick-item')
        if (quick) {
          quick.click()
          return 'quick:' + quick.textContent.trim().slice(0, 20)
        }
        const preset = document.querySelector('.presets button.preset')
        if (preset) {
          preset.click()
          return 'preset:' + preset.textContent.trim().slice(0, 20)
        }
        // 列表页:点"新增"进表单
        const add = [...document.querySelectorAll('button')].find((b) =>
          /new config|add/i.test(b.textContent.trim())
        )
        if (add) {
          add.click()
          return 'add'
        }
        return 'missing'
      })
      await sleep(400)
      configProbe.formShown = await evaluate(() => !!document.querySelector('input[type="url"], input#base-url, form input'))
      // 填表:v-model 认 input 事件,所以赋值之后要派发一次
      configProbe.filled = await evaluate(() => {
        const set = (el, v) => {
          if (!el) return false
          el.value = v
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }
        /* 这些 input 没有 id,只能按 placeholder 认 —— 表单里还有用途单选框,
           所以"第 0 个 input"根本不是 Name 那一格(踩过) */
        const inputs = [...document.querySelectorAll('form input')]
        const name = inputs.find((i) => /e\.g\. Doubao/.test(i.placeholder || ''))
        const url = inputs.find((i) => /^https:\/\/example\.com/.test(i.placeholder || ''))
        const key = inputs.find((i) => i.type === 'password')
        const okName = set(name, 'Probe config')
        const okUrl = set(url, 'https://example.com/v1')
        const okKey = set(key, 'sk-probe')
        return { okName, okUrl, okKey, count: inputs.length, radios: inputs.filter((i) => i.type === 'radio').length }
      })
      await sleep(300)
      configProbe.saved = await evaluate(() => {
        const btn = [...document.querySelectorAll('form button')].find((b) =>
          /^save$/i.test(b.textContent.trim())
        )
        if (!btn) return 'missing'
        btn.click()
        return 'clicked'
      })
      await sleep(600)
      configProbe.listedAfterSave = await evaluate(() =>
        /Probe config/.test(document.body.textContent || '')
      )
      // 回首页:参数行那个胶囊应当显示刚存的这条(说明"设为当前"这一步生效了)
      configProbe.backHome = await clickNav('Studio')
      await sleep(700)
      configProbe.pillText = await evaluate(() => {
        const pill = document.querySelector('.param-btn .param-val-name')
        return pill ? pill.textContent.trim() : ''
      })
      configProbe.passed =
        configProbe.openedSettings === true &&
        configProbe.saved === 'clicked' &&
        configProbe.listedAfterSave === true &&
        configProbe.pillText === 'Probe config'
    } catch (e) {
      configProbe.error = String(e.message || e)
    }
  }

  /* —— 历史域探针 ——
     删除走的是"立刻生效 + 撤销窗口 + 窗口结束才落盘"这一套(见 useFeedback),
     单测只能证明 scheduleUndo 自己没错,证明不了"界面上的删除真的接上了它"。 */
  let historyProbe = null
  if (PROBE_HISTORY) {
    historyProbe = { steps: [] }
    const settle = () => sleep(350)
    const tileCount = () => evaluate(() => document.querySelectorAll('section.lib .tile').length)
    /* 页面自己报的总数(标题那行 "N records · M images")。
       **必须用它而不是渲染出来的图块数**:图墙只渲染前 120 块,
       `--records 500` 时删掉一条,窗口立刻补上下一块 —— 张数纹丝不动,
       "删完应该少 1"那条断言就永远不成立(这条探针从前就是这么红的)。
       图块数仍然量着,只当规模参考,不进判决 */
    const libTotals = () =>
      evaluate(() => {
        const t = document.querySelector('section.lib .lib-sub')?.textContent || ''
        const rec = /(\d+)\s+records?/.exec(t)
        const img = /(\d+)\s+images?/.exec(t)
        return { records: rec ? Number(rec[1]) : -1, images: img ? Number(img[1]) : -1 }
      })
    try {
      /* 先自己切到历史页再动手。别的探针会把页面切走(canvas / settings),
         而离场页在无头下可能仍留在 DOM 里 —— "section.lib 有图块"并不等于
         "用户正看着这一页"(连跑时踩过:删除点了却什么都没发生) */
      const navBox = await evaluate(() => {
        const b = document.querySelector('button[aria-label="History"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
      if (navBox) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', {
            type,
            x: navBox.x,
            y: navBox.y,
            button: 'left',
            clickCount: 1
          })
        }
        await sleep(700)
      }
      historyProbe.tilesBefore = await tileCount()
      historyProbe.totalsBefore = await libTotals()
      // 点第一块砖上的删除(操作排在 DOM 里,悬停才显形,但 .click() 照常触发)
      historyProbe.clickedDelete = await evaluate(() => {
        const b = [...document.querySelectorAll('section.lib button')].find((x) =>
          (x.getAttribute('aria-label') || '').startsWith('Delete:')
        )
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      historyProbe.tilesAfterDelete = await tileCount()
      historyProbe.totalsAfterDelete = await libTotals()
      // 撤销条:把这条放回来
      historyProbe.undoToast = await evaluate(() => !!document.querySelector('.undo .undo-btn'))
      historyProbe.clickedUndo = await evaluate(() => {
        const b = document.querySelector('.undo .undo-btn')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      historyProbe.tilesAfterUndo = await tileCount()
      historyProbe.totalsAfterUndo = await libTotals()

      /* 新建作品集要从**预览卡**里进:历史页那一行筛选在"一个集都没有"时
         是有意不渲染的(免得空页面多一行噪声),所以空态下它没有入口 ——
         第一版探针就在这里扑了空 */
      historyProbe.openedPreview = await evaluate(() => {
        const b = document.querySelector('section.lib .tile .tile-open')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await sleep(500)
      historyProbe.clickedNewCollection = await evaluate(() => {
        const b = [...document.querySelectorAll('button[aria-label="New collection"]')].pop()
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      historyProbe.typedTitle = await evaluate(() => {
        const input = [...document.querySelectorAll('input.coll-input')].pop()
        if (!input) return 'missing'
        input.value = 'Probe set'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return 'typed'
      })
      /* 确认键要**下一拍**再点:它的 disabled 绑的是 v-model,
         而 Vue 更新 DOM 是异步的 —— 刚派发完 input 的那一刻它还是灰的,
         点上去等于没点(这个坑在探针里踩过两次了) */
      await settle()
      historyProbe.clickedConfirm = await evaluate(() => {
        const b = [...document.querySelectorAll('button.coll-confirm')].pop()
        if (!b) return 'missing'
        if (b.disabled) return 'disabled'
        b.click()
        return 'clicked'
      })
      await settle()
      // 关掉预览,回历史页看那一行筛选是否出现了新集
      await evaluate(() => {
        document.querySelector('button[aria-label="Close"]')?.click()
      })
      await settle()
      historyProbe.chipAppeared = await evaluate(() =>
        [...document.querySelectorAll('.coll-chip')].some((c) =>
          /Probe set/.test(c.textContent || '')
        )
      )

      /* —— 搜索:命中记录照旧铺图墙,命中的图片在另一条里单独列出 ——
         搜 "record 7" 是有意的:它只命中播种数据里的一小撮
         (record 7 / 70-79…),于是"图墙真的被筛过"这件事能看出来,
         而搜一个必然存在的词又保证不是空态 */
      historyProbe.searchTyped = await evaluate(() => {
        const el = document.querySelector('section.lib input.search-input')
        if (!el) return 'missing'
        el.value = 'record 7'
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return 'typed'
      })
      await settle()
      historyProbe.search = await evaluate(() => {
        const note = document.querySelector('section.lib .lib-note')?.textContent?.trim() || ''
        const rec = /(\d+)\s+records?/.exec(note)
        const img = /(\d+)\s+images?/.exec(note)
        return {
          /* 渲染出来的图块数**不能**当"命中多少"用:它是 120 封顶的窗口,
             命中 190 张时照样只挂 120 块(与删除那条断言同一个坑)。
             命中数看页面自己报的那行字 */
          tiles: document.querySelectorAll('section.lib .wall .tile').length,
          matchedRecords: rec ? Number(rec[1]) : -1,
          matchedImages: img ? Number(img[1]) : -1,
          note,
          strip: !!document.querySelector('section.lib .strip'),
          stripCards: document.querySelectorAll('section.lib .strip .scard').length,
          stripTitle: document.querySelector('section.lib .strip-title')?.textContent?.trim() || '',
          stripCapped: !!document.querySelector('section.lib .strip-more')
        }
      })

      /* 搜一个必然搜不到的词:图墙该空、图片条该收起来、空态要说清找不到 */
      historyProbe.searchMiss = await evaluate(() => {
        const el = document.querySelector('section.lib input.search-input')
        if (!el) return 'missing'
        el.value = 'zzz-no-such-thing'
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return 'typed'
      })
      await settle()
      historyProbe.searchMissState = await evaluate(() => ({
        tiles: document.querySelectorAll('section.lib .wall .tile').length,
        strip: !!document.querySelector('section.lib .strip'),
        noneTitle: document.querySelector('section.lib .none-title')?.textContent?.trim() || ''
      }))

      // 清掉关键词:图墙该回到原样(切筛子要把渲染窗口收回,这里一并验)
      historyProbe.clearedSearch = await evaluate(() => {
        const b = document.querySelector('section.lib button.search-x')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      historyProbe.tilesAfterClear = await evaluate(
        () => document.querySelectorAll('section.lib .wall .tile').length
      )

      historyProbe.passed =
        historyProbe.clickedDelete === 'clicked' &&
        historyProbe.totalsBefore?.records > 0 &&
        historyProbe.totalsAfterDelete?.records === historyProbe.totalsBefore.records - 1 &&
        historyProbe.undoToast === true &&
        historyProbe.clickedUndo === 'clicked' &&
        historyProbe.totalsAfterUndo?.records === historyProbe.totalsBefore.records &&
        historyProbe.clickedNewCollection === 'clicked' &&
        historyProbe.clickedConfirm === 'clicked' &&
        historyProbe.chipAppeared === true &&
        historyProbe.searchTyped === 'typed' &&
        historyProbe.search?.strip === true &&
        historyProbe.search?.stripCards > 0 &&
        historyProbe.search?.stripCards <= 36 &&
        /* 封顶提示只在"命中数超过那一条装得下的数量"时才该出现 ——
           拿小数据跑时命中寥寥无几,要求它出现就是一条**依赖数据规模**的断言
           (这条一开始只在 --records 500 下跑过,换小数据立刻假红) */
        (historyProbe.search?.matchedImages <= 36 || historyProbe.search?.stripCapped === true) &&
        historyProbe.search?.matchedRecords > 0 &&
        historyProbe.search?.matchedRecords < historyProbe.totalsBefore.records &&
        historyProbe.search?.matchedImages > 0 &&
        historyProbe.search?.matchedImages < historyProbe.totalsBefore.images &&
        /match/.test(historyProbe.search?.note || '') &&
        historyProbe.searchMiss === 'typed' &&
        historyProbe.searchMissState?.tiles === 0 &&
        historyProbe.searchMissState?.strip === false &&
        /Nothing matches/.test(historyProbe.searchMissState?.noneTitle || '') &&
        historyProbe.clearedSearch === 'clicked' &&
        historyProbe.tilesAfterClear === historyProbe.tilesBefore
    } catch (e) {
      historyProbe.error = String(e.message || e)
    }
  }

  /* —— 角色域探针 ——
     新建角色 → 卡片出现 → 拿它开画。这条链穿过 useCharacters 的状态与派生
     （characters / charStats / activeCharacter / activeCharSrc）,
     以及留在主界面的写入侧（saveCharFromPage）。 */
  let charsProbe = null
  if (PROBE_CHARS) {
    charsProbe = {}
    const settle = () => sleep(350)
    const clickNav = async (label) => {
      const box = await evaluate((l) => {
        const b = document.querySelector(`button[aria-label="${l}"]`)
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      }, label)
      if (!box) return false
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1
        })
      }
      return true
    }
    try {
      charsProbe.nav = await clickNav('Characters')
      await sleep(700)
      // 诊断:此刻到底停在哪一页、有哪些页面的根节点还在 DOM 里
      charsProbe.state = await evaluate(() => {
        const checked = [...document.querySelectorAll('.rs-item')].find(
          (b) => b.getAttribute('aria-checked') === 'true'
        )
        return {
          navLabel: checked ? checked.getAttribute('aria-label') : '',
          pages: [...document.querySelectorAll('main.frame > section')].map((s) => s.className),
          hasCharsNew: !!document.querySelector('button.chars-new'),
          hasWizard: !!document.querySelector('.wizard')
        }
      })
      /* 注意:aria-label="New character" 在**向导对话框**上,不在触发键上;
         触发键是 .chars-new 那个按钮(文本 "New character")。按 aria-label 找
         会找到 section —— 于是"找到了却不是按钮"(第一版就扑了空) */
      charsProbe.clickedNew = await evaluate(() => {
        const b = document.querySelector('button.chars-new')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      charsProbe.filledName = await evaluate(() => {
        const input = document.querySelector('input[placeholder="Name this character"]')
        if (!input) return 'missing'
        input.value = 'Probe captain'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return 'filled'
      })
      /* 性别是必填(Save 的 disabled 同时看名字与性别)。
         这一栏现在是**原生下拉**(见 CharacterPage 里 .wz-select 那段:一整排胶囊
         占掉一条 46px 的横档,而这一页其余每行只是"一个灰标签 + 一行字"),
         所以按 label 文本找到那一栏、设值、再补一次 change ——
         光改 .value 不会发事件,Vue 那边收不到,Save 会一直是 disabled。
         按 label 找而不是按 .wz-basics 里的序号:序号会随表单增删错位 */
      charsProbe.pickedGender = await evaluate(() => {
        const field = [...document.querySelectorAll('.wz-basics .wz-field')].find((f) =>
          /^Gender/.test((f.querySelector('.wz-label')?.textContent || '').trim())
        )
        const sel = field && field.querySelector('select')
        if (!sel) return 'missing'
        sel.value = 'female'
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return 'clicked'
      })
      /* 第 1 步这张表单的样子(两栏下拉收成一行之后,行高与基线只能看图)——
         只在传了 --shot-dir 时才拍 */
      await settle()
      await shot('char-wizard-basics')
      /* 又是那个坑:Save 的 disabled 绑在 v-model 上,要等下一拍再点 */
      await settle()
      /* 风格那一栏(与性别同一套下拉)。它存的是**值**不是文案:
         选 "Anime" 之后,库里那条角色的 fields.style 必须是 'anime'。
         同样按 label 文本找那一栏 */
      charsProbe.styleOptions = await evaluate(() => {
        const field = [...document.querySelectorAll('.wz-basics .wz-field')].find((f) =>
          /^Style/.test((f.querySelector('.wz-label')?.textContent || '').trim())
        )
        const sel = field && field.querySelector('select')
        if (!sel) return 'missing'
        return [...sel.options].map((o) => o.textContent.trim())
      })
      charsProbe.pickedStyle = await evaluate(() => {
        const field = [...document.querySelectorAll('.wz-basics .wz-field')].find((f) =>
          /^Style/.test((f.querySelector('.wz-label')?.textContent || '').trim())
        )
        const sel = field && field.querySelector('select')
        const opt = sel && [...sel.options].find((o) => o.textContent.trim() === 'Anime')
        if (!opt) return 'missing'
        sel.value = opt.value
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return 'clicked'
      })
      await settle()
      charsProbe.saved = await evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          /^Save & continue$/.test(x.textContent.trim())
        )
        if (!b) return 'missing'
        if (b.disabled) return 'disabled'
        b.click()
        return 'clicked'
      })
      await sleep(900)
      /* 存进去的到底是哪个值:界面显示的是 'Anime',而提示词要的是 'anime' ——
         中间要是有谁做了个大小写转换,这一条会当场抓到 */
      charsProbe.savedStyle = await evaluate(() => {
        try {
          const list = JSON.parse(localStorage.getItem('kimage.characters') || '[]')
          const c = list.find((x) => x.name === 'Probe captain')
          return c && c.fields ? c.fields.style : ''
        } catch {
          return 'unreadable'
        }
      })
      /* —— 向导第 2 步就是 Voice(第 1 步存完自动落在这儿)——
             这一段验的是从 CharacterPage 搬进 composables/useCharacterVoice.ts
             的那块逻辑:引擎/来源切换、提示语随来源变、以及各来源自己的输入框。
             挑 `.voice-block` 里的 `.voice-note`,不按全局序号 —— 页面上不止一处说明行 */
      charsProbe.voiceStep = await evaluate(() => {
        const t = document.querySelector('.wz-group-title')
        return t ? t.textContent.trim() : ''
      })
      charsProbe.pickedEngine = await evaluate(() => {
        const seg = document.querySelector('[aria-label="Voice engine"]')
        const btn = seg && [...seg.querySelectorAll('button')].find((b) => /Custom voice/.test(b.textContent))
        if (!btn) return 'missing'
        btn.click()
        return 'clicked'
      })
      await settle()
      charsProbe.sourceState = await evaluate(() => {
        const seg = document.querySelector('[aria-label="Voice source"]')
        if (!seg) return null
        const block = seg.closest('.voice-block')
        return {
          labels: [...seg.querySelectorAll('button')].map((b) => b.textContent.trim()),
          note: (block && block.querySelector('.voice-note')?.textContent.trim()) || ''
        }
      })
      charsProbe.pickedDescribe = await evaluate(() => {
        const seg = document.querySelector('[aria-label="Voice source"]')
        const btn = seg && [...seg.querySelectorAll('button')].find((b) => /Describe/.test(b.textContent))
        if (!btn) return 'missing'
        btn.click()
        return 'clicked'
      })
      await settle()
      charsProbe.describeState = await evaluate(() => {
        const seg = document.querySelector('[aria-label="Voice source"]')
        const block = seg && seg.closest('.voice-block')
        return {
          note: (block && block.querySelector('.voice-note')?.textContent.trim()) || '',
          hasTextarea: !!document.querySelector('.voice-panel textarea')
        }
      })
      charsProbe.pickedClone = await evaluate(() => {
        const seg = document.querySelector('[aria-label="Voice source"]')
        const btn = seg && [...seg.querySelectorAll('button')].find((b) => /Clone/.test(b.textContent))
        if (!btn) return 'missing'
        btn.click()
        return 'clicked'
      })
      await settle()
      charsProbe.cloneState = await evaluate(() => ({
        hasUpload: !!document.querySelector('.voice-panel input[type="file"]')
      }))
      /* 收拾干净:切回默认引擎。不然后面关向导会把这一份"配了一半的自定义音色"
         存进这个角色(saveFromVoiceStep 就是这么设计的) */
      charsProbe.backToBrowser = await evaluate(() => {
        const seg = document.querySelector('[aria-label="Voice engine"]')
        const btn = seg && [...seg.querySelectorAll('button')].find((b) => /Browser voice/.test(b.textContent))
        if (!btn) return 'missing'
        btn.click()
        return 'clicked'
      })
      await settle()
      /* **只看网格里的卡片名**,不看整页 textContent ——
         向导右栏在名字敲进去那一刻就显示 "Probe captain" 了,
         照整页匹配的话"保存成功"这条断言等于没验(实测:把 submit 打断,
         它照样是 true) */
      charsProbe.cardAppeared = await evaluate(() =>
        [...document.querySelectorAll('.ctile .ctile-name')].some((n) =>
          /Probe captain/.test(n.textContent || '')
        )
      )
      // 关掉向导回列表
      charsProbe.closed = await evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          /^(Close|Cancel)$/.test(x.textContent.trim())
        )
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      /* —— 卡片右上角那个 ⋮ 菜单 ——
            开合、点外收起、以及动作转发(这里点"置顶",它落在角色自己身上,
            卡上会多一枚图钉角标 —— 一眼看得见,比看 localStorage 可靠) */
      charsProbe.openedCardMenu = await evaluate(() => {
        const b = document.querySelector('.ctile .ctile-dots')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      charsProbe.cardMenu = await evaluate(() => {
        const menu = document.querySelector('.ctile-menu .menu')
        if (!menu) return null
        return [...menu.querySelectorAll('button')].map((b) => b.textContent.trim())
      })
      charsProbe.clickedPin = await evaluate(() => {
        const b = [...document.querySelectorAll('.ctile-menu .menu button')].find((x) =>
          /^Pin$/.test(x.textContent.trim())
        )
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      charsProbe.pinnedBadge = await evaluate(() => !!document.querySelector('.ctile-pin'))
      /* 点别处收起:菜单是低频动作,不该逼用户再点一次 ⋮ 才能走 */
      charsProbe.menuOpenedAgain = await evaluate(() => {
        const b = document.querySelector('.ctile .ctile-dots')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      charsProbe.clickedOutside = await evaluate(() => {
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        return 'dispatched'
      })
      await settle()
      charsProbe.menuClosed = await evaluate(() => !document.querySelector('.ctile-menu .menu'))

      /* —— 详情页与全屏查看器 ——
            这两块没有别的探针碰得到(角色探针原来到"卡片出现 → Create"就结束了)。
            先给它播一张正脸设定图:key 是 `${charId}:front`(见 idb.ts 的 putCharRefs),
            列表进详情时会按 @open 去读库,所以播完直接点进去就能看见 */
      charsProbe.seededView = await evaluate(async () => {
        const chars = JSON.parse(localStorage.getItem('kimage.characters') || '[]')
        const c = chars.find((x) => /Probe captain/.test(x.name || ''))
        if (!c) return 'no-char'
        const blob = await new Promise((res) => {
          const cv = document.createElement('canvas')
          cv.width = 48
          cv.height = 64
          const g = cv.getContext('2d')
          g.fillStyle = '#7c5cff'
          g.fillRect(0, 0, 48, 64)
          cv.toBlob((b) => res(b), 'image/png')
        })
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('kimage.db')
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error)
        })
        const ok = await new Promise((res, rej) => {
          const tx = db.transaction('chars', 'readwrite')
          tx.objectStore('chars').put({ id: c.id + ':front', data: blob })
          tx.oncomplete = () => res('seeded')
          tx.onerror = () => rej(tx.error)
        })
        db.close()
        return ok
      })
      /* **重载一次再进详情**。charViews 是"读一次就缓存"的(见 loadCharViews 的早退),
         而更早的步骤已经把它缓存成空数组了 —— 不重载的话,刚播进去的那张正脸
         永远不会被读到,这一整段就都在验一个空网格 */
      const reloadForDetail = onceEvent('Page.loadEventFired')
      await send('Page.reload', { ignoreCache: true })
      await reloadForDetail
      await sleep(800)
      charsProbe.backToChars = await clickNav('Characters')
      await sleep(600)

      // 进详情:卡片上那层铺满的命中区就是入口
      charsProbe.openedDetail = await evaluate(() => {
        const b = document.querySelector('.ctile .ctile-open')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await sleep(900)
      charsProbe.detail = await evaluate(() => ({
        name: document.querySelector('.hero-name')?.textContent?.trim() || '',
        meta: document.querySelector('.hero-meta')?.textContent?.trim() || '',
        cells: document.querySelectorAll('.sheet .cell').length,
        /* 每格都有一个 .cell-img 按钮(空格是"生成"、有图是"看大图"),
           所以数它没有意义 —— 有图的那一档带 .has-img */
        filled: document.querySelectorAll('.sheet .cell-img.has-img').length,
        specRows: document.querySelectorAll('.spec-row, .det-row, .row').length,
        voiceRows: (document.body.textContent || '').includes('Browser voice')
      }))
      /* —— 改嗓音那条入口 ——
             向导第 2 步的解锁条件是 wizardId,而它只在新建流程里第 1 步存完才有,
             所以详情页那枚 Edit 进不去嗓音那一步。这一段的全部意义就是钉住
             "改这条已有角色的嗓子"这条路真的通:点得到、落在第 2 步、存得进库。
             它只能用探针验:向导那块 composable 里 startEdit 会碰 document,
             没有 DOM 环境的单测跑不起来(仓里也没装 jsdom) */
      charsProbe.openedVoiceEdit = await evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(
          (x) => (x.textContent || '').trim() === 'Change voice'
        )
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      charsProbe.voiceEditStep = await evaluate(() => ({
        title: document.querySelector('.wz-edit-title')?.textContent?.trim() || '',
        // 落在第 2 步:引擎那一排在场,而设定表单不在
        onVoiceStep: !!document.querySelector('[aria-label="Voice engine"]'),
        sawSpecForm: !!document.querySelector('.wz-basics')
      }))
      charsProbe.switchedEngine = await evaluate(() => {
        const seg = document.querySelector('[aria-label="Voice engine"]')
        const btn = seg && [...seg.querySelectorAll('button')].find((b) => /Custom voice/.test(b.textContent))
        if (!btn) return 'missing'
        btn.click()
        return 'clicked'
      })
      await settle()
      charsProbe.savedVoice = await evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(
          (x) => (x.textContent || '').trim() === 'Save'
        )
        if (!b) return 'missing'
        if (b.disabled) return 'disabled'
        b.click()
        return 'clicked'
      })
      await sleep(900)
      charsProbe.voiceEditResult = await evaluate(() => {
        let engine = ''
        try {
          const list = JSON.parse(localStorage.getItem('kimage.characters') || '[]')
          const c = list.find((x) => x.name === 'Probe captain')
          engine = (c && c.voice && c.voice.engine) || ''
        } catch {
          engine = 'unreadable'
        }
        return {
          engine,
          // 存完该回到详情页,而不是被带去出图那一步
          backOnDetail: !!document.querySelector('.hero-name') && !document.querySelector('.wizard'),
          /* 详情页那一块读的是刚存下的那份,所以它得跟着变:
             改之前那里写的是 "Browser voice",改完该是 "Custom voice"
             (那一块的标签是 Engine / Source,别按向导里的 aria-label 找) */
          detailShowsCustom: (document.body.textContent || '').includes('Custom voice')
        }
      })
      /* 详细页那块 Voice 的样子(两枚动作 / 改完之后的摘要)——
         面板在折叠线以下,所以先把它滚进视野再拍 */
      await evaluate(() => {
        const t = [...document.querySelectorAll('.panel-title')].find(
          (x) => (x.textContent || '').trim() === 'Voice'
        )
        const p = t && t.closest('.panel')
        if (p) p.scrollIntoView({ block: 'center' })
      })
      await sleep(400)
      await shot('char-detail-voice')

      /* 全屏查看器:点那张已经填了的格子。Esc 逐层退里的第一层就是它 */
      charsProbe.openedViewer = await evaluate(() => {
        const btn = document.querySelector('.sheet .cell-img.has-img')
        if (!btn) return 'missing'
        btn.click()
        return 'clicked'
      })
      await sleep(500)
      charsProbe.viewer = await evaluate(() => ({
        open: !!document.querySelector('.viewer'),
        label: document.querySelector('.viewer-label')?.textContent?.trim() || '',
        hasImg: !!document.querySelector('.viewer img')
      }))
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27
      })
      await settle()
      charsProbe.viewerClosed = await evaluate(() => !document.querySelector('.viewer'))
      // 回到列表,后面的步骤(拿它开画)照旧
      charsProbe.backedOut = await evaluate(() => {
        const b = document.querySelector('button.back')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()

      // 拿这个角色开画
      charsProbe.usedForCreate = await evaluate(() => {
        const btn = [...document.querySelectorAll('.ctile button')].find((b) =>
          /Create/.test(b.textContent || '')
        )
        if (!btn) return 'missing'
        btn.click()
        return 'clicked'
      })
      await sleep(700)
      charsProbe.pillTip = await evaluate(() => {
        const b = document.querySelector('.param-char button')
        return (b && (b.getAttribute('data-tip') || '')) || ''
      })
      charsProbe.passed =
        charsProbe.clickedNew === 'clicked' &&
        charsProbe.filledName === 'filled' &&
        charsProbe.pickedGender === 'clicked' &&
        /* 风格那一栏:下拉里六项都在、选得中,而且**存下去的是值不是文案** */
        charsProbe.styleOptions?.length === 6 &&
        charsProbe.pickedStyle === 'clicked' &&
        charsProbe.savedStyle === 'anime' &&
        charsProbe.saved === 'clicked' &&
        /* 嗓音那一块(从页面搬进 composable 的那部分) */
        charsProbe.voiceStep === 'Voice' &&
        charsProbe.pickedEngine === 'clicked' &&
        charsProbe.sourceState?.labels?.length === 3 &&
        /A stock voice from your provider/.test(charsProbe.sourceState?.note || '') &&
        charsProbe.pickedDescribe === 'clicked' &&
        charsProbe.describeState?.hasTextarea === true &&
        /No ID and no recording/.test(charsProbe.describeState?.note || '') &&
        charsProbe.pickedClone === 'clicked' &&
        charsProbe.cloneState?.hasUpload === true &&
        charsProbe.backToBrowser === 'clicked' &&
        /* 改嗓音那条入口:点得到 → 落在第 2 步 → 存得进库 → 回详情 */
        charsProbe.openedVoiceEdit === 'clicked' &&
        charsProbe.voiceEditStep?.title === 'Edit Probe captain' &&
        charsProbe.voiceEditStep?.onVoiceStep === true &&
        charsProbe.voiceEditStep?.sawSpecForm === false &&
        charsProbe.switchedEngine === 'clicked' &&
        charsProbe.savedVoice === 'clicked' &&
        charsProbe.voiceEditResult?.engine === 'tts' &&
        charsProbe.voiceEditResult?.backOnDetail === true &&
        charsProbe.voiceEditResult?.detailShowsCustom === true &&
        /* 卡片 ⋮ 菜单(切片 4 搬走的那一块) */
        charsProbe.openedCardMenu === 'clicked' &&
        charsProbe.cardMenu?.length === 5 &&
        /Pin/.test(charsProbe.cardMenu?.join(' ') || '') &&
        /Delete/.test(charsProbe.cardMenu?.join(' ') || '') &&
        charsProbe.clickedPin === 'clicked' &&
        charsProbe.pinnedBadge === true &&
        charsProbe.menuOpenedAgain === 'clicked' &&
        charsProbe.clickedOutside === 'dispatched' &&
        charsProbe.menuClosed === true &&
        /* 详情页与全屏查看器(切片 3 搬走的那一块) */
        charsProbe.seededView === 'seeded' &&
        charsProbe.openedDetail === 'clicked' &&
        charsProbe.detail?.name === 'Probe captain' &&
        charsProbe.detail?.cells === 5 &&
        charsProbe.detail?.filled === 1 &&
        charsProbe.backToChars === true &&
        /Created/.test(charsProbe.detail?.meta || '') &&
        charsProbe.detail?.voiceRows === true &&
        charsProbe.openedViewer === 'clicked' &&
        charsProbe.viewer?.open === true &&
        charsProbe.viewer?.hasImg === true &&
        charsProbe.viewerClosed === true &&
        charsProbe.backedOut === 'clicked' &&
        charsProbe.cardAppeared === true &&
        charsProbe.usedForCreate === 'clicked' &&
        /Probe captain/.test(charsProbe.pillTip)
    } catch (e) {
      charsProbe.error = String(e.message || e)
    }
  }

  /* —— 出图编排层探针 ——
     真正出一张图要能用的接口,这里没有;但**失败路径**照样穿过刚搬走的那套
     编排:doGenerate 建槽 → runBatch 并发调度 → runSlot 发请求 → 出错收尾。
     接口故意指向一个不存在的地址,看这条链是不是走完了、状态有没有收干净。 */
  let genProbe = null
  if (PROBE_GEN) {
    genProbe = {}
    try {
      // 配一个指向死地址的出图配置(走设置页空态那条快路)
      const navBox = await evaluate(() => {
        const b = document.querySelector('button[aria-label="Settings"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
      if (navBox) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', {
            type,
            x: navBox.x,
            y: navBox.y,
            button: 'left',
            clickCount: 1
          })
        }
        await sleep(700)
      }
      /* 空态才有 .quick-item;已经配过一条时设置页是列表页 ——
         连跑时配置探针先建过一条,这里必须能退回"新增"(踩过) */
      genProbe.openedForm = await evaluate(() => {
        const quick = document.querySelector('.quick .quick-item')
        if (quick) {
          quick.click()
          return 'quick'
        }
        const add = [...document.querySelectorAll('button')].find((b) =>
          /new config|^add$/i.test(b.textContent.trim())
        )
        if (add) {
          add.click()
          return 'add'
        }
        return 'missing'
      })
      await sleep(500)
      genProbe.filled = await evaluate(() => {
        const set = (el, v) => {
          if (!el) return false
          el.value = v
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }
        const inputs = [...document.querySelectorAll('form input')]
        const url = inputs.find((i) => /^https:\/\/example\.com/.test(i.placeholder || ''))
        const key = inputs.find((i) => i.type === 'password')
        return {
          url: set(url, 'http://10.255.255.1/v1'),
          key: set(key, 'sk-probe')
        }
      })
      await sleep(300)
      genProbe.saved = await evaluate(() => {
        const b = [...document.querySelectorAll('form button')].find((x) =>
          /^save$/i.test(x.textContent.trim())
        )
        if (!b || b.disabled) return 'missing'
        b.click()
        return 'clicked'
      })
      await sleep(600)

      // 回创作区,写一句提示词,按生成
      const studio = await evaluate(() => {
        const b = document.querySelector('button[aria-label="Studio"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
      if (studio) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', {
            type,
            x: studio.x,
            y: studio.y,
            button: 'left',
            clickCount: 1
          })
        }
        await sleep(700)
      }
      await evaluate(() => {
        const ta = document.querySelector('textarea')
        if (!ta) return 'missing'
        ta.value = 'probe'
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return 'typed'
      })
      await sleep(300)
      genProbe.clicked = await evaluate(() => {
        const b = document.querySelector('button[aria-label="Generate"]')
        if (!b) return 'missing'
        if (b.disabled) return 'disabled'
        b.click()
        return 'clicked'
      })
      /* 地址选黑洞(10.255.255.1)而不是 127.0.0.1:9:
         后者是立刻拒连,骨架一闪而过,取样必然扑空 —— 这也说明它确实在跑,
         只是跑完了。黑洞地址会挂住,给"正在生成"留出可观测的窗口 */
      await sleep(1500)
      genProbe.midFlight = await evaluate(() => ({
        skel: document.querySelectorAll('.tile-skel').length,
        // 停止键是**每格一个**(.skel-stop),单槽时没有全局停止键
        stops: document.querySelectorAll('.skel-stop').length
      }))
      // 顺手把"停止"也走一遍(这是刚搬过来的 stopSlot/stopAllSlots)
      genProbe.clickedStop = await evaluate(() => {
        const b = document.querySelector('.skel-stop')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await sleep(1200)
      genProbe.settled = await evaluate(() => ({
        skel: document.querySelectorAll('.tile-skel').length,
        stops: document.querySelectorAll('.skel-stop').length
      }))

      genProbe.passed =
        genProbe.openedForm !== 'missing' &&
        genProbe.saved === 'clicked' &&
        genProbe.clicked === 'clicked' &&
        genProbe.midFlight?.skel >= 1 &&
        genProbe.midFlight?.stops >= 1 &&
        genProbe.clickedStop === 'clicked' &&
        genProbe.settled?.skel === 0 &&
        genProbe.settled?.skel === 0
    } catch (e) {
      genProbe.error = String(e.message || e)
    }
  }

  /* —— 出图参数层探针 ——
     这一层(尺寸 / 张数 / 画质 / 种子 / 参考图)每一格都受能力表约束,
     而能力表是配置域算出来的 —— 单测覆盖不到"点下去界面认不认"。 */
  let paramsProbe = null
  if (PROBE_PARAMS) {
    paramsProbe = {}
    const settle = () => sleep(400)
    try {
      // 回创作区
      const navBox = await evaluate(() => {
        const b = document.querySelector('button[aria-label="Studio"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
      if (navBox) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', {
            type,
            x: navBox.x,
            y: navBox.y,
            button: 'left',
            clickCount: 1
          })
        }
        await sleep(700)
      }

      // ① 打开「更多参数」
      paramsProbe.openedMore = await evaluate(() => {
        const b = document.querySelector('button[aria-label="More parameters"]')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      paramsProbe.panels = await evaluate(() => ({
        bodies: document.querySelectorAll('.pp-body').length,
        sizeChips: [...document.querySelectorAll('.pp-body .preset')].filter((b) =>
          /^(Auto|\d+×\d+)$/.test(b.textContent.trim())
        ).length
      }))

      // ② 点一个具体尺寸档(不是 auto 的那一个)
      paramsProbe.clickedSize = await evaluate(() => {
        const chip = [...document.querySelectorAll('.pp-body .preset')].find((b) =>
          /^\d+×\d+$/.test(b.textContent.trim())
        )
        if (!chip) return 'missing'
        chip.click()
        return chip.textContent.trim()
      })
      await settle()
      /* 别去"找那个带着 on 的":张数那几个胶囊也是 .preset,第一版就抓成了
         "1 image"。按文本精确对上刚点的那一档才算数 */
      paramsProbe.sizeOn = await evaluate((want) => {
        const chip = [...document.querySelectorAll('.pp-body .preset')].find(
          (b) => b.textContent.trim() === want
        )
        if (!chip) return 'missing'
        return chip.className.includes('on')
      }, paramsProbe.clickedSize)

      // ③ 参考图:塞一张真图进隐藏 input,再点 Remove
      await evaluate(() => {
        const input = document.querySelector('#ref-file')
        return !!input
      })
      await send('DOM.enable')
      const doc = await send('DOM.getDocument', { depth: -1 })
      const node = await send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: '#ref-file'
      })
      if (node.nodeId) {
        await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [UPLOAD_PNG] })
      }
      await sleep(900)
      paramsProbe.refThumb = await evaluate(() => !!document.querySelector('img.pp-thumb'))
      paramsProbe.removed = await evaluate(() => {
        const b = [...document.querySelectorAll('.pp-action')].find((x) =>
          /^Remove$/.test(x.textContent.trim())
        )
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      paramsProbe.refThumbAfterRemove = await evaluate(() => !!document.querySelector('img.pp-thumb'))

      paramsProbe.passed =
        paramsProbe.panels?.sizeChips >= 2 &&
        /×/.test(paramsProbe.clickedSize || '') &&
        paramsProbe.sizeOn === true &&
        paramsProbe.refThumb === true &&
        paramsProbe.removed === 'clicked' &&
        paramsProbe.refThumbAfterRemove === false
    } catch (e) {
      paramsProbe.error = String(e.message || e)
    }
  }

  /* —— 对话域探针 ——
     真聊一句需要能用的文本模型(要联网、要密钥),这里做不到;但搬走的那一半
     (读取 / 记忆 / 清空)完全可以验证:把一段对话与一条记忆直接播进库,
     再看页面认不认、清空能不能撤销。 */
  let chatProbe = null
  if (PROBE_CHAT) {
    chatProbe = {}
    const settle = () => sleep(350)
    /* 切页要走**真实鼠标事件**:分段控件是 @pointerdown 驱动的,
       `element.click()` 在它身上什么都不会发生(第一版探针就栽在这儿 ——
       重载之后用 click 切页,结果一直停在上一个页面,后面满盘皆输) */
    const gotoPage = async (label) => {
      const box = await evaluate((l) => {
        const b = document.querySelector(`button[aria-label="${l}"]`)
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      }, label)
      if (!box) return false
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1
        })
      }
      await sleep(900)
      return true
    }
    try {
      // ① 播种:一个角色(localStorage 目录) + 一段对话 + 一条记忆(IndexedDB)
      chatProbe.seeded = await evaluate(async () => {
        const charId = 'probe-chat-char'
        const now = Date.now()
        /* 这段对话是 3 天前的。取这个数不是为了仿真,是为了让
           "Last spoke 3 days ago" 那一行有确定的、可断言的文本 */
        const CHAT_AGO = 3 * 24 * 60 * 60 * 1000
        /* 沉浸偏好开着。重载后应用落在**首页** —— 那时顶栏必须照常显示,
           "偏好留着、但不在对话页就回普通"正是下面要断言的语义之一 */
        localStorage.setItem('kimage.immersive', '1')
        /* 一条**出图**配置(地址指向一个死端口)。⑦c 要把"正在重画"那一档按住看,
           而重画在没有出图配置时**根本走不到发请求那一步**(见 imageConfigGap):
           忙态会立刻被收掉,量不到、也截不到图。给一条配置之后它才会真的去发,
           而我们再把它桩住不落地 */
        localStorage.setItem(
          'kimage.apiConfigs',
          JSON.stringify([
            {
              id: 'probe-image',
              name: 'Probe image',
              baseUrl: 'http://127.0.0.1:9/v1',
              apiKey: 'probe-key',
              model: 'probe-image-model',
              kind: 'image',
              vendor: 'openai'
            }
          ])
        )
        localStorage.setItem('kimage.apiActive', 'probe-image')
        localStorage.setItem(
          'kimage.characters',
          JSON.stringify([
            {
              id: charId,
              name: 'Probe talker',
              createdAt: now,
              /* identity 用一个**只属于它**的短语(与角色名不重叠) ——
                 下面要断言"这行身份描述不再出现在头部",而名字里若含同样的词,
                 那条断言就永远过得去(判别性会丢) */
              fields: { gender: 'female', identity: 'probe spec line', outfit: '', marks: '' },
              persona: { traits: 'dry', voice: 'short', address: 'you', boundaries: 'none' }
            },
            /* 第二个角色:**置顶、没有一句对话、而且比上面那个建得晚** ——
               三样都指向"按最近活跃排的话它该在最后",所以左栏里它排第一
               这件事只可能来自置顶(排序是派生的,不是数组顺序) */
            {
              id: 'probe-chat-pinned',
              name: 'Probe pinned',
              createdAt: now + 1000,
              pinned: true,
              fields: { gender: 'male', identity: 'pinned probe', outfit: '', marks: '' },
              persona: { traits: 'calm', voice: 'even', address: 'you', boundaries: 'none' }
            }
          ])
        )
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('kimage.db')
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error)
        })
        /* 一张"剧照":夜色里的窗。**它现在会被铺成沉浸页的背景** ——
           所以不能再用纯色:纯色铺满屏幕还是纯色,截图里分不出
           "背景是这张图"还是"背景没画出来"(这个坑刚踩过一次) */
        const still = await (async () => {
          const c = document.createElement('canvas')
          /* 720 而不是 640:**与正脸那张刻意不同宽** —— 这样"背景画的是剧照
             还是退回去的正脸"才有一条决定性判据(比 naturalWidth) */
          c.width = 720
          c.height = 960
          const g = c.getContext('2d')
          const night = g.createLinearGradient(0, 0, 0, 960)
          night.addColorStop(0, '#0d1522')
          night.addColorStop(1, '#1b2430')
          g.fillStyle = night
          g.fillRect(0, 0, 640, 960)
          // 远处几盏灯
          for (let i = 0; i < 90; i++) {
            const x = (i * 97) % 720
            const y = 120 + ((i * 53) % 700)
            g.fillStyle = i % 4 ? 'rgba(255,214,150,.75)' : 'rgba(190,220,255,.6)'
            g.fillRect(x, y, 4, 4)
          }
          // 窗框与窗台
          g.fillStyle = '#2a2f38'
          g.fillRect(0, 0, 720, 120)
          g.fillRect(540, 0, 180, 960)
          g.fillRect(0, 840, 720, 120)
          return await new Promise((res) => c.toBlob((b) => res(b), 'image/png'))
        })()

        // 一张真图(用 canvas 现造,不靠网络)
        const png = await new Promise((res) => {
          const c = document.createElement('canvas')
          c.width = c.height = 32
          const g = c.getContext('2d')
          g.fillStyle = '#4a5568'
          g.fillRect(0, 0, 32, 32)
          c.toBlob((b) => res(b), 'image/png')
        })
        /* 用户附的那张:64×32 的横图。**刻意不是方的** ——
           方形看不出"有没有按自己的比例排",而附图右对齐这件事
           正好在"宽度不是 100%"时才看得出来 */
        const mk = (w, h, fill) =>
          new Promise((res) => {
            const c = document.createElement('canvas')
            c.width = w
            c.height = h
            const g = c.getContext('2d')
            g.fillStyle = fill
            g.fillRect(0, 0, w, h)
            c.toBlob((b) => res(b), 'image/png')
          })
        /* 一张**像人脸**的图当角色正脸,而不是纯色方块 ——
           沉浸页那层压暗到底盖掉了多少,拿纯色是看不出来的
           (纯色被盖掉一半还是纯色,看不出"照片还在不在") */
        const face = await (async () => {
          const c = document.createElement('canvas')
          c.width = 640
          c.height = 960
          const g = c.getContext('2d')
          const sky = g.createLinearGradient(0, 0, 0, 960)
          sky.addColorStop(0, '#cfe3f5')
          sky.addColorStop(1, '#f6e3d0')
          g.fillStyle = sky
          g.fillRect(0, 0, 640, 960)
          g.fillStyle = '#3a2a24'
          g.beginPath()
          g.ellipse(320, 400, 190, 250, 0, 0, Math.PI * 2)
          g.fill()
          g.fillStyle = '#e8b48c'
          g.beginPath()
          g.ellipse(320, 430, 150, 195, 0, 0, Math.PI * 2)
          g.fill()
          g.fillStyle = '#2b2118'
          g.beginPath()
          g.ellipse(265, 415, 18, 11, 0, 0, Math.PI * 2)
          g.fill()
          g.beginPath()
          g.ellipse(375, 415, 18, 11, 0, 0, Math.PI * 2)
          g.fill()
          g.strokeStyle = '#9c5f4a'
          g.lineWidth = 7
          g.beginPath()
          g.arc(320, 480, 55, 0.35, Math.PI - 0.35)
          g.stroke()
          g.fillStyle = '#586b7a'
          g.beginPath()
          g.ellipse(320, 950, 300, 200, 0, 0, Math.PI * 2)
          g.fill()
          return await new Promise((res) => c.toBlob((b) => res(b), 'image/png'))
        })()

        const tall = await mk(180, 320, '#3f7d5a')
        const banner = await mk(800, 200, '#8a5a3f')
        const wide = await new Promise((res) => {
          const c = document.createElement('canvas')
          c.width = 64
          c.height = 32
          const g = c.getContext('2d')
          g.fillStyle = '#c9a227'
          g.fillRect(0, 0, 64, 32)
          c.toBlob((b) => res(b), 'image/png')
        })
        const msgs = [
          { role: 'user', content: 'Are you awake?', dt: 3 },
          { role: 'assistant', content: 'Barely. It is early.', dt: 2 },
          /* 用户附的图。铺这条是因为它在界面上与本侧的气泡**同一边** ——
             附图排在气泡上面,右边那道对齐得看得出来才算对 */
          {
            role: 'user',
            content: 'Same here.',
            dt: 1,
            imageId: 'probe-user-img'
          },
          { role: 'user', content: '', dt: 0.9, imageId: 'probe-user-img2' },
          { role: 'user', content: 'And a wide one.', dt: 0.8, imageId: 'probe-user-img3' },
          // 已经画好的那张:photoId 指向 chat_images 里的字节
          {
            role: 'assistant',
            content: 'Here is the window.',
            dt: 0.5,
            photo: 'a grey window at dawn',
            photoId: 'probe-photo-1'
          },
          // 没画完的那张:只有场景描述、没有 photoId。出图只活在内存里,
          // 所以这条从库里读回来就只可能是"没画出来" → 提示 + 重试键,不是骨架
          /* 末尾带一个换行的回复。复刻的是**已经存在库里的老数据** ——
             "标签前面那个换行先一步流出去"留下的尾巴。气泡是 pre-wrap,
             结尾的 \n 会被如实渲染成一行空行(ChatPage 的 shownText 负责收掉它) */
          { role: 'assistant', content: 'One line only.\n', dt: 0.35 },
          { role: 'assistant', content: 'One second.', dt: 0.2, photo: 'still drawing' }
        ].map((m, i) => ({
          id: `probe-msg-${i}`,
          charId,
          role: m.role,
          content: m.content,
          /* 整段对话挪到 3 天前:探针要能看见"离开多久了"那一行,
             而它是按"最新一条距今多久"算的。相对次序(dt)一个没动 */
          createdAt: now - CHAT_AGO - m.dt * 60000,
          ...(m.photo ? { photo: m.photo } : {}),
          ...(m.photoId ? { photoId: m.photoId } : {}),
          ...(m.imageId ? { imageId: m.imageId } : {})
        }))
        await new Promise((res, rej) => {
          const tx = db.transaction(
            ['chat_messages', 'chat_summaries', 'chat_images', 'chars'],
            'readwrite'
          )
          /* 角色的正脸(卡面/头像/沉浸页背景都用它)。
             **画一张像人脸的图,而不是一个纯色方块** —— 沉浸页背景那层压暗
             到底盖掉了多少,拿纯色是看不出来的(纯色被盖掉一半还是纯色)。
             没有它的时候背景层会退化成"只剩压暗色",那条也一并量 */
          /* **只播底图,不播正脸** —— 这一条正好测新增的那条退路:
             角色只有上传的那张图、还没生成过正脸时,背景层仍然有东西可画。
             正脸那条路(coverSrc(c.ref))本来就是头像与角色卡一直在走的那条 */
          tx.objectStore('chars').put({ id: charId + ':source', data: face })
          const store = tx.objectStore('chat_messages')
          for (const m of msgs) store.put(m)
          tx.objectStore('chat_images').put({
            id: 'probe-photo-1',
            blob: still,
            createdAt: now
          })
          // 用户附的那张是另一张图(横的),这样"谁发的"一眼分得出来
          tx.objectStore('chat_images').put({
            id: 'probe-user-img',
            blob: wide,
            createdAt: now
          })
          tx.objectStore('chat_images').put({ id: 'probe-user-img2', blob: tall, createdAt: now })
          tx.objectStore('chat_images').put({ id: 'probe-user-img3', blob: banner, createdAt: now })
          tx.objectStore('chat_summaries').put({
            charId,
            text: 'They met on a cold morning and agreed to keep it short.',
            upToId: 'probe-msg-1',
            upToAt: now - CHAT_AGO - 2 * 60000,
            covered: 2,
            updatedAt: now - CHAT_AGO
          })
          tx.oncomplete = res
          tx.onerror = () => rej(tx.error)
        })
        db.close()
        return msgs.length
      })

      // ② 重载,让应用从库里读这份播种数据
      const loaded = onceEvent('Page.loadEventFired')
      await send('Page.reload', { ignoreCache: true })
      await loaded
      await sleep(600)

      /* ③ 沉浸态:偏好开着,而此刻在**首页** —— 顶栏必须照常显示。
         这一条是"偏好"与"这一页长什么样"两件事的分界(见 App 的 immersiveOn):
         顶栏是全站唯一去别的页的入口,只要不在对话页,chrome 就得回来 */
      chatProbe.homeChrome = await evaluate(() => ({
        mastVisible: (document.querySelector('.masthead')?.offsetHeight || 0) > 0,
        pref: localStorage.getItem('kimage.immersive')
      }))

      // ④ 进对话页
      chatProbe.navToChat = await gotoPage('Chat')
      /* 播种时偏好是开着的 ⇒ 一进来就是沉浸态。**先退出来**再量:
         下面那一段量的是**气泡骨架**那一套(左右对齐、附图、失败提示…),
         它们是普通页的判据;沉浸页那套(剧本排版、场景行、剧照当底图)
         由 ⑤ 之后那一段单独量。两套判据各在自己的骨架下量,才不会互相污染 */
      await evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
      await settle()
      /* —— 进页面时落在哪一段 ——
         这是左栏那条排序规则的**同一个规则**(见 lib/chatOrder):落点必须是
         左栏第一行。夹具里置顶那个没有一句对话,所以这里落到的就是它 ——
         这不是缺陷,是"置顶排在前面"的必然结果,而这一条断言把它钉住。
         下面紧接着**显式选中"要测的那一段"**:这一份探针后面所有关于消息、
         附图、记忆的断言讲的都是 Probe talker 那一段对话,不该被排序规则牵连。 */
      chatProbe.landing = await evaluate(() => {
        const first = document.querySelector('.chat-rail .rail-item')?.textContent || ''
        const head = document.querySelector('.chat-head .head-name')?.textContent || ''
        return { railFirst: /Probe pinned/.test(first), landedOn: head.trim(), pick: head.trim() }
      })
      await evaluate(() => {
        const row = [...document.querySelectorAll('.chat-rail .rail-item')].find((r) =>
          /Probe talker/.test(r.textContent || '')
        )
        row?.querySelector('button')?.click()
      })
      await settle()
      chatProbe.rendered = await evaluate(() => {
        const bubbles = document.querySelectorAll('.bubble, .msg, .chat-msg').length
        /* 配图必须**在文字之后**(垫在下面):比的是两者在气泡里的位置。
           这是它与用户附图的分界 —— 那张压在文字上面 */
        /* 图现在**在气泡外面**(要求:文字与图不要挤在一个框里),
           所以比的是 .msg 这一层里"气泡"与"图"的先后,并确认图不在气泡里 */
        const withPhoto = [...document.querySelectorAll('.msg')].find((m) =>
          m.querySelector('img.msg-photo')
        )
        const order = withPhoto
          ? (() => {
              /* 图外面包了一层按钮(为了键盘也能点开),所以不能只看直接子节点的类名,
                 要看"哪一个子节点里装着那张图" */
              const nodes = [...withPhoto.children]
              const textAt = nodes.findIndex((n) => n.classList?.contains('bubble'))
              const imgAt = nodes.findIndex((n) => !!n.querySelector?.('img.msg-photo'))
              const inBubble = !!withPhoto.querySelector('.bubble')?.querySelector('.msg-photo')
              return { textAt, imgAt, inBubble }
            })()
          : null
        return {
          bubbles,
          /* 记忆的"在不在"现在看头部那枚入口(它从前是消息流顶上的一块)。
             两者都量:块不该再出现在消息流里,入口该在 */
          hasMemory: !!document.querySelector('.mem-chip'),
          oldMemoryBlock: !!document.querySelector('.chat-stream .memory'),
          charInRail: /Probe talker/.test(document.body.textContent || ''),
          /* 末尾那行"离开多久了"。整段对话是 3 天前的,所以它该说 3 天 ——
             文本要精确匹配:写死一句 "Last spoke recently" 之类也算没接上 */
          awayLine: document.querySelector('.chat-stream .sep.away')?.textContent || '',
          /* 末尾带空白的气泡有几个(应当为 0)。库里那条 'One line only.\n'
             就是为这条断言播的:显示层不收尾,它就会渲染成一行空行 */
          trailingWsBubbles: [...document.querySelectorAll('.bubble')].filter((b) =>
            /\s$/.test(b.textContent || '')
          ).length,
          trailPadBubble: (() => {
            const b = [...document.querySelectorAll('.bubble')].find((x) =>
              (x.textContent || '').includes('One line only.')
            )
            return b ? JSON.stringify(b.textContent) : '(没找到)'
          })(),
          photoRendered: !!document.querySelector('img.msg-photo'),
          /* 头部第二行**不再写角色的身份描述**(2026-10-06,用户:"角色描述不要")。
             判据用那句身份原文,而不是"有没有 .head-sub 这个类":
             类名可以改名,而"这行字还在不在"才是用户看到的东西。
             判别性:把那一行加回模板,这条立刻红 */
          headShowsSpec: (
            document.querySelector('.chat-head')?.textContent || ''
          ).includes('probe spec line'),
          photoBelowText: !!order && order.imgAt > order.textAt && order.textAt >= 0,
          /* 库里那条只带场景、没有 photoId 的消息,读回来时**不再顶着骨架**:
             出图只活在内存里,而一次读取发生在页面刚打开(或往前翻)的时候,
             没有任何出图在跑 —— 所以它只可能是没画出来(见 useChat 的 settlePhoto)。
             从前这里断言的是骨架,那是"读取也当成正在画"的年代留下的。
             两个都量:失败提示该在,骨架不该在 */
          photoFailed: !!document.querySelector('.photo-fail'),
          photoRetry: !!document.querySelector('.photo-retry'),
          /* "再摇一张"那一枚(2026-10-06)。**只挂在已经画好的图上** ——
             判据落在"它在不在那张图的容器里"与它的 aria-label,
             不落在图标上:换一个图标不该让这条断言变红。
             没画出来的那条只该有 .photo-retry,不该有这一枚 */
          photoRedraw: (() => {
            const b = document.querySelector('.photo-redraw')
            if (!b) return null
            return {
              label: b.getAttribute('aria-label') || '',
              onDrawnPhoto: !!b.closest('.msg-photo-wrap')?.querySelector('img.msg-photo'),
              onFailedPhoto: !!b.closest('.photo-fail')
            }
          })(),
          pendingSkeleton: !!document.querySelector('.msg-photo-skel'),
          photoOutsideBubble: !!order && order.inBubble === false,
          /* 实测反馈:"聊天记录里图片太大"。钉住它是个缩略图而不是一面墙 */
          photoWidth: Math.round(
            document.querySelector('img.msg-photo')?.getBoundingClientRect().width || 0
          ),
          /* 最后一条是助手消息,但这里**没有配文本模型**(探针只播了角色目录)——
             重生成此时发不出去,而它要先删旧回复,所以这枚入口根本不该出现。
             从前它会照常出现,点一下就永久删掉那条回复(没有撤销窗口)。 */
          regenWithoutModel: !!document.querySelector('.regen'),
          /* 左栏第一行是谁。置顶那个没有一句对话、建得也比另一个晚 ——
             "最近活跃在前"会把它排到最后,所以它排第一只可能是置顶起了作用 */
          railFirst:
            document.querySelector('.chat-rail .rail-item .rail-name')?.textContent?.trim() || '',
          /* 置顶那一行右端的图钉。**看 aria-pressed,不看有没有图标** ——
             它现在是一枚真按钮(可以直接在左栏置顶/取消) */
          railPinPressed:
            document
              .querySelector('.chat-rail .rail-item .rail-pin')
              ?.getAttribute('aria-pressed') || '',
          /* 用户附的图必须贴住**自己那一列的右缘**。
             这里量的是 **img 自己**的右缘:从前量的是外面那个按钮 ——
             按钮确实靠右,而图在按钮里靠左,于是漏掉了"图没右对齐"这个 bug */
          userImagesAligned: (() => {
            const msgs = [...document.querySelectorAll('.chat-inner .msg.user')].filter((m) =>
              m.querySelector('img.msg-img')
            )
            if (!msgs.length) return null
            return msgs.every(
              (m) =>
                Math.abs(
                  m.querySelector('img.msg-img').getBoundingClientRect().right -
                    m.getBoundingClientRect().right
                ) <= 1
            )
          })(),
          userImageCount: document.querySelectorAll('.chat-inner .msg.user img.msg-img').length,
          /* 角色发的那张必须贴**左**缘。对称的那一条 —— 两个方向共用过一个
             CSS 类,把"靠右"写在公共类上时,这一侧的图会被推到右边去 */
          assistantPhotoLeftAligned: (() => {
            const m = [...document.querySelectorAll('.chat-inner .msg.assistant')].find((x) =>
              x.querySelector('img.msg-photo')
            )
            if (!m) return null
            return (
              Math.abs(
                m.querySelector('img.msg-photo').getBoundingClientRect().left -
                  m.getBoundingClientRect().left
              ) <= 1
            )
          })(),
          /* 只有图没有字的那条不该挂出一个空气泡(那种小壳看着像坏了) */
          noStubBubble: ![...document.querySelectorAll('.chat-inner .msg')].some((m) => {
            if (!m.querySelector('img.msg-img')) return false
            const b = m.querySelector('.bubble')
            if (!b) return false
            const own = [...b.childNodes]
              .filter((n) => n.nodeType === 3)
              .map((n) => n.textContent)
              .join('')
            return !own.trim()
          })
        }
      })

      /* ④ 沉浸骨架。偏好开着 + 已经在对话页 ⇒ 这一页该是第二种骨架。
       *
       * **先固定一个桌面视口**:探针默认那个无头窗口只有 ~756×356,窄屏媒体查询
       * 本来就会把左栏藏起来、而 min-height:420px 又盖过了一切高度差 ——
       * 在那种尺寸上"左栏不在布局里""高度变高了"全是恒真的,等于没测。
       * 用完立刻 clearDeviceMetricsOverride 撤掉,免得扰动同一个 run 里
       * 后面那些历史页的测量 */
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      })
      await settle()

      /* 量一次"普通骨架"当基线:两条轨道、顶栏有高度、面板矮一截 */
      await evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
      await settle()
      chatProbe.normal = await evaluate(() => {
        const chat = document.querySelector('.chat')
        return {
          /* 普通骨架下不该有背景层(v-if="immersive"),消息也不收窄 */
          bgImg: !!document.querySelector('.chat-bg'),
          colW: Math.round(document.querySelector('.chat-inner')?.getBoundingClientRect().width || 0),
          cols: getComputedStyle(chat).gridTemplateColumns,
          railW: Math.round(document.querySelector('.chat-rail')?.getBoundingClientRect().width || 0),
          mastH: document.querySelector('.masthead')?.offsetHeight || 0,
          varMast: getComputedStyle(document.documentElement).getPropertyValue('--mast-h').trim(),
          chatH: Math.round(chat.getBoundingClientRect().height),
          viewH: window.innerHeight
        }
      })

      /* 用头部那枚按钮再进一次 —— 入口本身要能走通(不只靠存下来的偏好) */
      chatProbe.reImmerse = await evaluate(() => {
        const b = document.querySelector('[aria-label="Immersive mode"]')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      chatProbe.immersive = await evaluate(() => {
        const chat = document.querySelector('.chat')
        const main = document.querySelector('.chat-main')
        const menu = document.querySelector('.chat-menu-wrap')
        const solo = document.querySelector('.head-solo')
        return {
          immersiveClass: chat.classList.contains('is-immersive'),
          /* 背景层:用的是同一张正脸的 object URL,不额外发请求 */
          bgImg: !!document.querySelector('.chat-bg img'),
          bgBlob: (document.querySelector('.chat-bg img')?.getAttribute('src') || '').startsWith(
            'blob:'
          ),
          /* 收窄成一列(普通骨架下是整块面板的宽) */
          colW: Math.round(document.querySelector('.chat-inner')?.getBoundingClientRect().width || 0),
          /* 工具层收走、身份留下、出口留着 */
          /* ⋮ **在沉浸态必须还在**:参考图右上角那枚就是它,而且
             "重画这一场的背景"只住在这里面(第一版把它一起藏了,
             用户报"没有换背景的按钮啊") */
          menuShown: !!menu && getComputedStyle(menu).display !== 'none',
          /* **它发过的图必须在流里**,沉浸态也一样 —— 那是这段对话的一部分。
             曾经有过一条"最新那张已经铺在背景上,所以流里不再重复"的例外,
             那是"背景图借的就是这张剧照"那会儿留下的;现在背景图是单独生成的
             另一张,那条例外就没了理由(用户报"最后一张图在聊天记录里不显示") */
          stillInFlow: document.querySelectorAll('.chat-inner img.msg-photo').length > 0,
          /* 背景画的**必须是那张剧照**(它 720 宽),不是退回去的头像(640)。
             两条路画出来的都是图,只有宽度分得开 */
          bgW: document.querySelector('.chat-bg img')?.naturalWidth || 0,
          soloShown: !!solo && getComputedStyle(solo).display !== 'none',
          pickHidden: getComputedStyle(document.querySelector('.head-pick')).display === 'none',
          exitBtn: !!document.querySelector('[aria-label="Leave immersive mode"]'),
          pref: localStorage.getItem('kimage.immersive'),
          mastH: document.querySelector('.masthead')?.offsetHeight || 0,
          varMast: getComputedStyle(document.documentElement).getPropertyValue('--mast-h').trim(),
          railW: Math.round(document.querySelector('.chat-rail')?.getBoundingClientRect().width || 0),
          cols: getComputedStyle(chat).gridTemplateColumns,
          chatW: Math.round(chat.getBoundingClientRect().width),
          mainW: Math.round(main.getBoundingClientRect().width),
          chatH: Math.round(chat.getBoundingClientRect().height),
          viewH: window.innerHeight
        }
      })

      /* 拍一张:背景压得够不够暗、一列收得对不对、头部还剩什么 ——
         这些**只能用眼睛判断**(间距、对齐、留白没有可断言的判据),
         而它们恰恰是 UI 改动里最容易翻车的一类 */
      await shot('chat-immersive')
      if (SHOT_DIR) {
        /* 顺手再拍一张浅色的。设计稿把"对比度"列成硬约束,却又如实记着
           "还没想好怎么自动量" —— 那么两种主题各看一眼就是它现在的替代:
           背景是图片,取不到"计算样式里的背景色",而压暗够不够只有眼睛知道。
           只改 data-theme 这一个属性(applyTheme 干的就是这件事),不动存盘的偏好 */
        const was = await evaluate(() => document.documentElement.getAttribute('data-theme'))
        await evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
        await shot('chat-immersive-light')
        await evaluate((v) => document.documentElement.setAttribute('data-theme', v), was)
      }
      /* 截图那一步收尾会 clearDeviceMetricsOverride,把视口还回默认那个窄窗 ——
         而下面"回到普通骨架是两列"的断言依赖桌面宽度,所以这里补回来。
         (这条坑只在带 --shot-dir 时才会踩到,CI 不带,所以它只会骗到顺手拍图的人) */
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      })
      await settle()

      /* 右上角那枚 ⋮ 里有没有"重画背景"。**它在沉浸态是唯一入口** ——
         藏了它就等于这个功能没有入口 */
      chatProbe.backdropMenu = await evaluate(() => {
        const b = document.querySelector('.chat-menu-wrap .icob')
        if (!b) return { opened: false }
        b.click()
        return { opened: true }
      })
      /* **等一拍再读**:菜单是 v-if 挂上去的,点完这一拍它还没进 DOM */
      await settle()
      chatProbe.backdropMenu.items = await evaluate(() =>
        [...document.querySelectorAll('.chat-menu button')].map((x) => (x.textContent || '').trim())
      )
      /* 换模型那一条**在菜单里、而且排第一**(2026-10-06)。
         它原来是头部的一枚常驻药丸,收进菜单之后头部那排不再有它 ——
         判据落在"菜单第一项是不是它、名字对不对",而不是"有没有 .menu-model" */
      chatProbe.backdropMenu.modelRow = await evaluate(() => {
        const first = document.querySelector('.chat-menu button')
        return {
          isModel: !!first?.classList.contains('menu-model'),
          text: (first?.textContent || '').trim(),
          /* 头部那枚药丸已经不在了 */
          chipGone: !document.querySelector('.chat-head .model-chip')
        }
      })
      /* 菜单开着的时候留一张:里面第一行是"换模型" */
      await shot('chat-menu', 1248, 900)
      /* 同上面那条坑:截图收尾会把视口还回默认的窄窗,而下面几条布局断言
         (shell 的 overflow、普通骨架是不是两列)依赖桌面宽度 —— 补回来。
         漏了这一下,失败会**长在别的断言上**,看着像 UI 坏了 */
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      })
      await settle()
      chatProbe.backdropMenu.hasNewBackground = chatProbe.backdropMenu.items.some((e) =>
        /New background/i.test(e)
      )
      await evaluate(() => {
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      })
      await settle()

      /* 破功清点(设计 §6 / §8)。这三条都是"安静地坏掉"的那一类 */
      chatProbe.layers = await evaluate(() => {
        const stream = document.querySelector('.chat-stream')
        /* 给消息流节点盖个戳:下面的模式切换如果把它整棵重造,
           这个属性就会跟着消失 —— 而重建 live region 会让读屏把整段重播一遍 */
        if (stream) stream.__probeStamp = 'kept'
        /* 往上滚一点,"回到最新"那枚就该浮出来。
           **顺手补一次 scroll 事件**:布局刚变过(进沉浸态那一下)时,
           `scrollTop = 0` 有可能本来就是 0 —— 那样不会触发 scroll,
           而"贴不贴底"是那一次事件里算出来的,补一次才判得准 */
        if (stream) {
          stream.scrollTop = 0
          stream.dispatchEvent(new Event('scroll'))
        }
        return {
          stamped: stream?.__probeStamp === 'kept',
          /* 整页钉死靠的是 clip:hidden 会让 .shell 变成滚动容器,
             聚焦底部输入框时浏览器可能把它滚一下(§10.7 踩过) */
          shellOverflow: getComputedStyle(document.querySelector('.shell')).overflow
        }
      })
      await sleep(200)
      chatProbe.layers.jump = await evaluate(() => {
        const j = document.querySelector('.jump')
        const stream = document.querySelector('.chat-stream')
        return {
          shown: !!j,
          inViewport: !!j && j.getBoundingClientRect().top >= 0,
          /* 这一页现在**可能根本没有可滚的东西**(剧本排版比气泡短得多,
             八条消息在 900 高的视口里放得下)。那样的话"回到最新"不该出现才对 ——
             所以判据是"离底够远 ⟺ 它出现",而不是"它必须出现"。
             **"够远"用的是那枚按钮自己的阈值**(FOLLOW_GAP = 80px):
             只溢出十几像素时,界面算的是"还贴着底",那枚按钮本来就不该冒出来 ——
             第一版拿"能不能滚"当判据,于是它红得莫名其妙 */
          farFromBottom: !!stream && stream.scrollHeight - stream.clientHeight > 80
        }
      })
      chatProbe.layers.stampKept = await evaluate(
        () => document.querySelector('.chat-stream')?.__probeStamp === 'kept'
      )

      /* ⑤ 一次 Esc 只退一层 ⇒ 回到普通骨架,而**偏好不变**(它记的是意愿) */
      await evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
      await settle()
      /* Esc 之后那个节点还该是同一个(它只是换了外层 class,没被重造) */
      chatProbe.layers.stampAfterEsc = await evaluate(
        () => document.querySelector('.chat-stream')?.__probeStamp === 'kept'
      )
      chatProbe.backToNormal = await evaluate(() => {
        const chat = document.querySelector('.chat')
        return {
          immersiveClass: chat.classList.contains('is-immersive'),
          mastVisible: (document.querySelector('.masthead')?.offsetHeight || 0) > 0,
          /* 顶栏回来之后 --mast-h 必须**跟着回来**。这一条盯的是
             "观察者还挂在旧节点上"那种坏法:元素重新挂载了,而变量停在 0,
             面板于是高出 72px —— 功能全对,只是layout错一截 */
          varMast: getComputedStyle(document.documentElement).getPropertyValue('--mast-h').trim(),
          cols: getComputedStyle(chat).gridTemplateColumns,
          pref: localStorage.getItem('kimage.immersive')
        }
      })
      /* 撤掉视口覆盖(后面那些测量要跑在原来的尺寸上) */
      await send('Emulation.clearDeviceMetricsOverride')
      await settle()

      await shot('chat-messages')

      /* 窄屏两张:这一页的断点(860/720/640)只有在这种宽度下才真的走到 ——
         左栏收起、角色头变成可点按钮、气泡 76% 太窄要放开、输入区贴 safe-area */
      await shot('chat-narrow', 390, 844)
      await evaluate(() => {
        document.querySelector('[aria-label="Immersive mode"]')?.click()
      })
      await settle()
      await shot('chat-narrow-immersive', 390, 844)
      await evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
      await settle()

      // ⑦ 点图开大图 → Esc 收起
      chatProbe.clickedPhoto = await evaluate(() => {
        const b = document.querySelector('button.msg-img-btn')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      chatProbe.zoom = await evaluate(() => {
        const z = document.querySelector('.zoom img')
        return { open: !!z, isBlob: (z?.getAttribute('src') || '').startsWith('blob:') }
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27
      })
      await settle()
      chatProbe.zoomClosed = await evaluate(() => !document.querySelector('.zoom'))

      /* ⑦b "再摇一张"(2026-10-06)。它只该挂在**已经画好**的那张图上 ——
             没画出来的那条走的是另一条路(.photo-fail 里的 .photo-retry):
             一条是"再来一次",一条是"摇到满意为止",两条不能混 */
      chatProbe.photoRedraw = await evaluate(() => {
        const b = document.querySelector('.photo-redraw')
        if (!b) return { clicked: false }
        /* 点之前先看一眼那条中性提示 —— 下面要用"它变了"来判"失败被说出来了",
           而不是"有一条提示在"(前面几步也可能留下过一条,那样判不出东西来) */
        const before = document.querySelector('.note-msg')?.textContent?.trim() || ''
        b.click()
        return { clicked: true, noticeBefore: before }
      })
      await sleep(600)
      /* 点完之后要看出三件事:
         ① 旧图**没被撤掉** —— 这一次必然失败(预览服务上没有 /api/generate),
            而失败不该拿一行提示顶掉一张已经画好的图;
         ② 那一枚键回到可点 —— 忙态漏收一处,它就永远转下去(忙时它让位给暗幕,
            所以判据是"它回来了",不是"它 disabled 了");
         ③ **失败被说出来了**。重画失败时那张好图还在,于是界面上唯一能说出
            "这次没成"的地方就是那条中性提示 —— 少了它,用户点完什么都看不见。
            判据是"提示变了",不是"有提示"(见上面 noticeBefore) */
      chatProbe.afterRedraw = await evaluate(() => {
        return {
          photoStillThere: !!document.querySelector('img.msg-photo'),
          buttonBack: !!document.querySelector('.photo-redraw'),
          notice: document.querySelector('.note-msg')?.textContent?.trim() || ''
        }
      })
      await settle()

      /* ⑦c 正在重画时长什么样(2026-10-06)。用户报的是"看不出是不是在重绘",
             所以这一档得**按住**了看:把 /api/generate 桩成一个永不落地的
             promise,忙态就停在那儿,量得到、也截得到图。
             量的重点是那层暗幕要**正好等于图的大小** —— 它挂在一个
             "宽度由内容决定"的容器里(见 .msg-photo-wrap),而竖图的宽度比
             那个上限窄:容器若是撑到上限,暗幕就盖到图外面的空白上了 */
      await evaluate(() => {
        const real = window.fetch.bind(window)
        window.fetch = (url, init) =>
          String(url).includes('/api/generate')
            ? new Promise(() => {}) /* 永不落地 = 一直"正在重画" */
            : real(url, init)
      })
      await evaluate(() => document.querySelector('.photo-redraw')?.click())
      await sleep(400)
      chatProbe.busyBox = await evaluate(() => {
        const img = document.querySelector('img.msg-photo')
        const busy = document.querySelector('.photo-busy')
        const wrap = document.querySelector('.msg-photo-wrap')
        if (!img || !busy || !wrap) return null
        const r = (el) => el.getBoundingClientRect()
        return {
          img: { w: Math.round(r(img).width), h: Math.round(r(img).height) },
          busy: { w: Math.round(r(busy).width), h: Math.round(r(busy).height) },
          wrapW: Math.round(r(wrap).width),
          /* 忙的时候那一枚重画键让位给暗幕(不该同时出现两个说法) */
          redrawHidden: !document.querySelector('.photo-redraw'),
          ring: !!document.querySelector('.photo-busy-ring')
        }
      })
      /* 把这一张贴进视口再截图:它在这一屏下面(消息流不短),
         不滚过去的话截到的是一屏别的消息 */
      await evaluate(() =>
        document.querySelector('.photo-busy')?.scrollIntoView({ block: 'center' })
      )
      await sleep(300)
      await shot('chat-photo-redrawing', 1248, 900)
      /* **量的时候必须站在截图那个视口上** —— shot() 会临时把视口改成 1248×900
         再清掉,而布局跟着视口变:在别的宽度上量出来的尺寸与那张图对不上,
         会得出一个"看着对、其实对不上"的结论(这一步就是这么踩出来的)。
         所以这里把同一个视口再按一次,量完再放开 */
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1248,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      })
      await sleep(400)
      chatProbe.boxesAtShotViewport = await evaluate(() =>
        [...document.querySelectorAll('img.msg-photo')].map((img) => {
          const wrap = img.closest('.msg-photo-wrap')
          const busy = wrap?.querySelector('.photo-busy')
          const size = (el) => {
            const b = el.getBoundingClientRect()
            return [Math.round(b.width), Math.round(b.height)]
          }
          return {
            natural: [img.naturalWidth, img.naturalHeight],
            img: size(img),
            wrap: wrap ? size(wrap) : null,
            busy: busy ? size(busy) : null,
            /* 暗幕与图**逐边相等**才算对(留 1px 给亚像素)。
               这一条只在**这个确定的视口**上判 —— 上面那个 busyBox 量的是
               探针窗口当前的宽度,而窗口宽度随机器变:暗幕跑偏那个 bug
               正是在宽视口下才显形的(容器撑到 76% 上限、图只有它自己那么宽) */
            covers: (() => {
              if (!busy) return false
              const a = img.getBoundingClientRect()
              const b = busy.getBoundingClientRect()
              return (
                Math.abs(a.left - b.left) <= 1 &&
                Math.abs(a.top - b.top) <= 1 &&
                Math.abs(a.width - b.width) <= 1 &&
                Math.abs(a.height - b.height) <= 1
              )
            })()
          }
        })
      )
      await send('Emulation.clearDeviceMetricsOverride')

      await settle()

      /* ⑤ 记忆:入口在头部,点开是一张悬浮卡片(从前它是消息流最上面那一块,
            聊得越久越够不着) */
      chatProbe.openedMemory = await evaluate(() => {
        const b = document.querySelector('.mem-chip')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      chatProbe.memoryCard = await evaluate(() => {
        const card = document.querySelector('.mem-card')
        return {
          open: !!card,
          text: card?.querySelector('.mem-text')?.textContent?.trim() || '',
          /* 卡片得挂在头部下方、并且真的在视口里 —— 绝对定位最容易出的两种错:
             跑到屏幕外,或被消息流的滚动容器裁掉 */
          inViewport: (() => {
            if (!card) return false
            const r = card.getBoundingClientRect()
            return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 1
          })(),
          /* 它必须**不在**消息流里(那是这次要改掉的位置) */
          insideStream: !!document.querySelector('.chat-stream .mem-card')
        }
      })
      await shot('chat-memory-card')

      // Esc 收卡片(逐层退里的那一层)
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27
      })
      await settle()
      chatProbe.memoryClosed = await evaluate(() => !document.querySelector('.mem-card'))

      /* ⑥ 删单条消息:悬停那一排动作里的一枚。删完气泡少一个、撤销条出现,
            点撤销又回来 */
      chatProbe.bubblesBeforeDelete = await evaluate(
        () => document.querySelectorAll('.chat-inner .msg').length
      )
      chatProbe.clickedDeleteMsg = await evaluate(() => {
        const b = document.querySelector('.chat-inner .del-btn')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      chatProbe.afterDeleteMsg = await evaluate(() => ({
        messages: document.querySelectorAll('.chat-inner .msg').length,
        undoToast: !!document.querySelector('.undo .undo-btn')
      }))
      /* 撤销条与输入区都在底部居中 —— 这两条会不会打架,量一次。
         设计稿把这条列成"要现场看一眼再定",这里给出数:*测量*而已,
         重叠与否**不断言**(它在普通骨架下大概也是这样,是既有行为,
         要改就是一次全局改动,得单独决定) */
      /* 先在桌面视口下量:默认那个无头窗口只有 ~356 高,而 .chat 有
         min-height:420px —— 面板会被 clip 掉一截,量出来的重叠恒为 0,
         等于没测(这一条我第一次就踩了) */
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      })
      await settle()
      chatProbe.toastVsCompose = await evaluate(() => {
        const t = document.querySelector('.undo')
        const box = document.querySelector('.compose-box') || document.querySelector('.compose-off')
        if (!t || !box) return null
        const a = t.getBoundingClientRect()
        const b = box.getBoundingClientRect()
        const overlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
        return {
          toast: { top: Math.round(a.top), bottom: Math.round(a.bottom) },
          compose: { top: Math.round(b.top), bottom: Math.round(b.bottom) },
          overlap: Math.round(overlap)
        }
      })
      await send('Emulation.clearDeviceMetricsOverride')
      await settle()

      chatProbe.clickedUndoMsg = await evaluate(() => {
        const b = document.querySelector('.undo .undo-btn')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      chatProbe.messagesAfterUndo = await evaluate(
        () => document.querySelectorAll('.chat-inner .msg').length
      )

      /* ⑦ 在左栏直接置顶:点**第二行**的图钉,那一行应当立刻排到第一。
            第一行本来就是置顶的,所以这次点的是"未置顶"的那一个 ——
            它建得更晚、也没有对话,能排到前面只可能是因为刚刚被置顶 */
      chatProbe.clickedRailPin = await evaluate(() => {
        const rows = [...document.querySelectorAll('.chat-rail .rail-item')]
        const btn = rows[1]?.querySelector('.rail-pin')
        if (!btn) return 'missing'
        btn.click()
        return 'clicked'
      })
      await settle()
      chatProbe.afterRailPin = await evaluate(() => ({
        first:
          document.querySelector('.chat-rail .rail-item .rail-name')?.textContent?.trim() || '',
        pressed:
          document.querySelector('.chat-rail .rail-item .rail-pin')?.getAttribute('aria-pressed') ||
          '',
        pinnedRows: document.querySelectorAll('.chat-rail .rail-pin[aria-pressed="true"]').length
      }))

      /* ⑧ 空正文不进上下文。
            这一步需要一条**文本配置**(没有它 runChat 第一行就返回),
            而整轮开头刻意没播它 —— 上面那条"没配模型就不给 Regenerate"
            的断言要靠"没配置"这个前提。所以在这里才写进去,并重载一次让应用读到。 */
      chatProbe.seededConfig = await evaluate(() => {
        localStorage.setItem(
          'kimage.apiConfigs',
          JSON.stringify([
            {
              id: 'probe-text',
              name: 'Probe text',
              baseUrl: 'http://127.0.0.1:9/v1',
              apiKey: 'probe-key',
              model: 'probe-model',
              kind: 'text',
              vendor: 'openai'
            }
          ])
        )
        localStorage.setItem('kimage.apiActiveText', 'probe-text')
        return 'written'
      })
      const reload2 = onceEvent('Page.loadEventFired')
      await send('Page.reload', { ignoreCache: true })
      await reload2
      await sleep(900)
      await gotoPage('Chat')
      /* 历史里有一条"只有图、一个字没打"的用户消息(probe-user-img2):
         这里真发一轮、把 fetch 桩掉抓请求体 —— 那条消息必须是 (sent a photo),
         而不是空串(空串会被上游按"内容为空"拒掉整轮) */
      chatProbe.stubbedSend = await evaluate(() => {
        window.__probeSent = ''
        const real = window.fetch.bind(window)
        window.fetch = (url, init) => {
          if (String(url).includes('/api/chat')) {
            window.__probeSent = init && init.body ? String(init.body) : ''
            return Promise.reject(new Error('probe: captured, stop here'))
          }
          return real(url, init)
        }
        const ta = document.querySelector('.compose-box textarea')
        if (!ta) return 'no-input'
        ta.value = 'and one from me'
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return 'ready'
      })
      await settle()
      chatProbe.clickedSend = await evaluate(() => {
        const b = document.querySelector('.send-btn')
        if (!b) return 'missing'
        if (b.disabled) return 'disabled'
        b.click()
        return 'clicked'
      })
      await sleep(800)
      chatProbe.sentContext = await evaluate(() => {
        const raw = window.__probeSent || ''
        if (!raw) return null
        try {
          const body = JSON.parse(raw)
          return {
            messages: (body.messages || []).map((m) => ({ role: m.role, content: m.content })),
            hasEmpty: (body.messages || []).some(
              (m) => typeof m.content === 'string' && !m.content.trim()
            ),
            photoPlaceholders: (body.messages || []).filter(
              (m) => m.content === '(sent a photo)'
            ).length
          }
        } catch {
          return 'unparsable'
        }
      })

      // ⑨ 清空对话(菜单里那一项)
      chatProbe.openedMenu = await evaluate(() => {
        const b = document.querySelector('button[aria-label="Conversation options"]')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      chatProbe.clickedClear = await evaluate(() => {
        const b = [...document.querySelectorAll('.chat-menu button')].find((x) =>
          /Clear conversation/.test(x.textContent || '')
        )
        if (!b) return 'missing'
        if (b.disabled) return 'disabled'
        b.click()
        return 'clicked'
      })
      await sleep(600)
      chatProbe.afterClear = await evaluate(() => ({
        bubbles: document.querySelectorAll('.bubble, .msg, .chat-msg').length,
        undoToast: !!document.querySelector('.undo .undo-btn'),
        memoryGone: !document.querySelector('.memory')
      }))

      /* ⑥ 撤销窗口结束后,库里那张附图应当也没了 ——
         这是本次修复的核心:photoId(角色发的图)从前从来没被回收过,
         而消息一删就再也问不出它指着哪张图了。判据必须是"库里的键还剩几个":
         按钮/骨架的显隐在消息删掉那一刻就已经变了,量不出字节有没有走。
         窗口是 4.5 秒(见 useFeedback 的 UNDO_MS),所以等过它。 */
      await sleep(5200)
      chatProbe.imagesAfterPurge = await evaluate(async () => {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('kimage.db')
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error)
        })
        const keys = await new Promise((res, rej) => {
          const r = db
            .transaction('chat_images', 'readonly')
            .objectStore('chat_images')
            .getAllKeys()
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error)
        })
        db.close()
        return keys.length
      })

      chatProbe.passed =
        chatProbe.seeded === 8 &&
        /* 偏好开着,但首页的 chrome 照常(顶栏在) */
        /* 落点 = 左栏第一行(与左栏共用同一条排序规则) */
        chatProbe.landing?.railFirst === true &&
        chatProbe.landing?.landedOn === 'Probe pinned' &&
        chatProbe.homeChrome?.mastVisible === true &&
        chatProbe.homeChrome?.pref === '1' &&
        /* 基线与沉浸态必须**真的不一样** —— 否则下面那几条断言全在恒真的地方打转 */
        chatProbe.normal?.varMast !== '0px' &&
        chatProbe.normal?.cols.split(' ').length === 2 &&
        chatProbe.normal?.railW > 0 &&
        /* 进了对话页才是第二种骨架 */
        chatProbe.reImmerse === 'clicked' &&
        chatProbe.immersive?.immersiveClass === true &&
        chatProbe.immersive?.pref === '1' &&
        /* 顶栏藏起来 ⇒ offsetHeight 归零 ⇒ --mast-h 自动 0px。
           **这条就是 v-show/v-if 那个坑的判据**:换成 v-if,这里会停在 72px */
        chatProbe.immersive?.mastH === 0 &&
        chatProbe.immersive?.varMast === '0px' &&
        chatProbe.immersive?.railW === 0 &&
        /* 单列:左栏隐藏了,但它那条 240px 的轨道若不显式改掉,内容会平白窄一截 */
        chatProbe.immersive?.cols.split(' ').length === 1 &&
        chatProbe.immersive?.mainW > chatProbe.immersive?.chatW - 40 &&
        /* 背景层:沉浸态才有,画的是那张正脸(blob URL,不额外发请求);
           普通骨架下它整个不该在 */
        chatProbe.normal?.bgImg === false &&
        chatProbe.immersive?.bgImg === true &&
        chatProbe.immersive?.bgBlob === true &&
        /* 收窄成一列:沉浸 760,普通是整块面板 */
        chatProbe.immersive?.colW > 0 &&
        chatProbe.immersive?.colW <= 760 &&
        chatProbe.immersive?.colW < chatProbe.normal?.colW &&
        /* 工具层收走、身份留下、出口留着 */
        chatProbe.immersive?.menuShown === true &&
        /* 点开它,里面得有"重画这一场的背景"那一条 */
        chatProbe.backdropMenu?.hasNewBackground === true &&
        /* **换模型那一条也在里面,而且排第一** —— 它原来在头部是一枚常驻药丸,
           窄屏上先被挤掉的是它,而沉浸态下头部那一排整个不显示(换模型得先退出)。
           判别性:把它挪回头部、或从菜单里删掉,这两条立刻红 */
        chatProbe.backdropMenu?.modelRow?.isModel === true &&
        /No model/.test(chatProbe.backdropMenu?.modelRow?.text || '') &&
        chatProbe.backdropMenu?.modelRow?.chipGone === true &&
        chatProbe.immersive?.soloShown === true &&
        chatProbe.immersive?.pickHidden === true &&
        chatProbe.immersive?.exitBtn === true &&
        /* 它发过的图在沉浸态**照样在流里**(背景是另一张,不是这张) */
        chatProbe.immersive?.stillInFlow === true &&
        /* 剧照优先那条路:背景得是那张 720 宽的戏,不是 640 宽的头像 */
        chatProbe.immersive?.bgW === 720 &&
        /* 且**真的把顶栏那份高度还给了面板** —— 比在视口高度上做文章稳:
           后者会被 .chat 的 min-height 盖过去 */
        chatProbe.immersive?.chatH >=
          chatProbe.normal?.chatH + chatProbe.normal?.mastH - 4 &&
        /* 一次 Esc 只退一层 ⇒ 回到普通骨架。
           偏好跟着**最后那次明确的选择**走:退出来就是 '0'(下次进对话页直接普通),
           而"偏好为 1 时在首页不该沉浸"那条由上面的 homeChrome 管 */
        chatProbe.backToNormal?.immersiveClass === false &&
        chatProbe.backToNormal?.mastVisible === true &&
        chatProbe.backToNormal?.cols.split(' ').length === 2 &&
        chatProbe.backToNormal?.varMast === chatProbe.normal?.varMast &&
        chatProbe.backToNormal?.pref === '0' &&
        /* 消息流是**同一棵 DOM**:切模式时它没被重造(否则 live region 会重播整段) */
        chatProbe.layers?.stamped === true &&
        chatProbe.layers?.stampKept === true &&
        chatProbe.layers?.stampAfterEsc === true &&
        chatProbe.layers?.shellOverflow === 'clip' &&
        /* "回到最新":有东西在下面时它浮得出来、落在视口内;没有时它就不该在 */
        chatProbe.layers?.jump?.shown === chatProbe.layers?.jump?.farFromBottom &&
        (chatProbe.layers?.jump?.shown === false || chatProbe.layers?.jump?.inViewport === true) &&
        /* 撤销条不许压住输入区。它是一条**会吃掉点击**的浮条:
           压住输入框中间时,点进去打字的那一下会触发"撤销"。
           这条是量出来才发现的(见 Wave C 的 T6.12) */
        chatProbe.toastVsCompose?.overlap === 0 &&
        chatProbe.rendered?.bubbles >= 3 &&
        chatProbe.rendered?.hasMemory === true &&
        chatProbe.rendered?.oldMemoryBlock === false &&
        chatProbe.rendered?.charInRail === true &&
        /* 头部第二行不再写角色的身份描述(用户:"角色描述不要") */
        chatProbe.rendered?.headShowsSpec === false &&
        /* 回来时知道自己离开了多久 —— 而且说的是**真实的那段间隔**(3 天)。
           判别性:核对的是精确文本,常量或错数都过不去 */
        chatProbe.rendered?.awayLine === 'Last spoke 3 days ago' &&
        /* 气泡底下不留空行:库里那条 'One line only.\n' 是给这条播的 ——
           pre-wrap 会把结尾的 \n 如实渲染成一行空行(判别性:去掉显示层那一下
           trimEnd,这条立刻变红) */
        chatProbe.rendered?.trailingWsBubbles === 0 &&
        chatProbe.rendered?.photoRendered === true &&
        chatProbe.rendered?.photoBelowText === true &&
        /* 没画出来的那一张:必须说出来、并且给一枚重试键(骨架不该再出现)。
           这一条兜的是 df9dffa 那次修复 —— 它当时只补了实现,探针还停在旧行为上 */
        chatProbe.rendered?.photoFailed === true &&
        chatProbe.rendered?.photoRetry === true &&
        /* "摇到满意为止"那一枚挂在已经画好的那张图上,而且带着读得出来的名字。
           判别性:把它挂到失败那条上(或漏掉 aria-label),这条立刻红 */
        chatProbe.rendered?.photoRedraw?.onDrawnPhoto === true &&
        chatProbe.rendered?.photoRedraw?.onFailedPhoto === false &&
        /photo again/i.test(chatProbe.rendered?.photoRedraw?.label || '') &&
        chatProbe.photoRedraw?.clicked === true &&
        /* 失败**不许顶掉那张好图**(这条是本次修复的核心),忙态必须收掉,
           而且这次没成要**说出来** —— 图还在的时候,那是唯一的说法 */
        chatProbe.afterRedraw?.photoStillThere === true &&
        chatProbe.afterRedraw?.buttonBack === true &&
        !!chatProbe.afterRedraw?.notice &&
        chatProbe.afterRedraw.notice !== chatProbe.photoRedraw?.noticeBefore &&
        /* 正在重画那一档:暗幕+圆环在,重画键让位,而且**暗幕正好盖住图**
           (逐边相等,在截图那个确定的 1248 视口上判 —— 见 boxesAtShotViewport)。
           判别性:把 `.msg-photo-wrap` 的 fit-content 去掉、或让按钮那条 76% 上限
           重新生效,这一条立刻红(暗幕会比图宽出一截,盖到图外面的空白上) */
        chatProbe.busyBox?.ring === true &&
        chatProbe.busyBox?.redrawHidden === true &&
        chatProbe.busyBox?.img?.w > 0 &&
        chatProbe.boxesAtShotViewport?.length === 1 &&
        chatProbe.boxesAtShotViewport[0].covers === true &&
        chatProbe.rendered?.pendingSkeleton === false &&
        chatProbe.rendered?.photoOutsideBubble === true &&
        chatProbe.rendered?.photoWidth > 0 &&
        /* 上限跟着 CSS 那一档走(min(320px, 76%))。它仍然在断言
           "这是一张缩略图,不是一面墙" —— 只是原来是拿 32px 的夹具
           对着 240 这个松数在量 */
        chatProbe.rendered?.photoWidth <= 320 &&
        chatProbe.rendered?.regenWithoutModel === false &&
        /* 置顶:左栏第一行是那个置顶的(它没有对话、建得也更晚) */
        /Probe pinned/.test(chatProbe.rendered?.railFirst || '') &&
        chatProbe.rendered?.railPinPressed === 'true' &&
        chatProbe.rendered?.userImageCount === 3 &&
        chatProbe.rendered?.userImagesAligned === true &&
        chatProbe.rendered?.assistantPhotoLeftAligned === true &&
        chatProbe.rendered?.noStubBubble === true &&
        chatProbe.memoryCard?.open === true &&
        /cold morning/.test(chatProbe.memoryCard?.text || '') &&
        chatProbe.memoryCard?.inViewport === true &&
        chatProbe.memoryCard?.insideStream === false &&
        chatProbe.memoryClosed === true &&
        chatProbe.clickedDeleteMsg === 'clicked' &&
        chatProbe.afterDeleteMsg?.messages === chatProbe.bubblesBeforeDelete - 1 &&
        chatProbe.afterDeleteMsg?.undoToast === true &&
        chatProbe.clickedUndoMsg === 'clicked' &&
        chatProbe.messagesAfterUndo === chatProbe.bubblesBeforeDelete &&
        chatProbe.clickedRailPin === 'clicked' &&
        chatProbe.seededConfig === 'written' &&
        chatProbe.navToChat === true &&
        chatProbe.stubbedSend === 'ready' &&
        chatProbe.clickedSend === 'clicked' &&
        chatProbe.sentContext?.hasEmpty === false &&
        chatProbe.sentContext?.photoPlaceholders === 1 &&
        /Probe talker/.test(chatProbe.afterRailPin?.first || '') &&
        chatProbe.afterRailPin?.pressed === 'true' &&
        chatProbe.afterRailPin?.pinnedRows === 2 &&
        chatProbe.clickedPhoto === 'clicked' &&
        chatProbe.zoom?.open === true &&
        chatProbe.zoom?.isBlob === true &&
        chatProbe.zoomClosed === true &&
        chatProbe.clickedClear === 'clicked' &&
        chatProbe.afterClear?.bubbles === 0 &&
        chatProbe.afterClear?.memoryGone === true &&
        chatProbe.afterClear?.undoToast === true &&
        chatProbe.imagesAfterPurge === 0
    } catch (e) {
      chatProbe.error = String(e.message || e)
    }
  }

  const heap = await evaluate(() => {
    const m = performance.memory
    return m ? { usedMB: +(m.usedJSHeapSize / 1048576).toFixed(1) } : null
  })

  const report = {
    url: URL_,
    chrome: version.Browser,
    seededRecords: seeded,
    imagesPerRecord: IMAGES,
    imgSizePx: IMG_SIZE,
    // 相对 navigationStart 的毫秒数,可直接对比改动前后
    startup: { msToFeedFirstTile: +startupMs.toFixed(1), navTiming },
    background,
    encode,
    reopen,
    twoTabs,
    canvas,
    config: configProbe,
    historyDomain: historyProbe,
    chars: charsProbe,
    chat: chatProbe,
    params: paramsProbe,
    gen: genProbe,
    history,
    heap
  }

  console.log(JSON.stringify(report, null, 2))

  /* —— 预算断言 ——
     让这个脚本能当回归门用:超阈值就以非零码退出(手跑也能接进别的流程)。
     阈值由调用方给,不写死 —— 它取决于造了多少条数据,写死必然误报 */
  const budgets = [
    ['max-dom-nodes', arg('max-dom-nodes', null), history.domNodes, '历史页 DOM 节点'],
    ['max-ms', arg('max-ms', null), history.msToStable, '历史页铺完耗时(ms)'],
    ['max-heap-mb', arg('max-heap-mb', null), heap?.usedMB ?? 0, 'JS 堆(MB)']
  ].filter(([, limit]) => limit !== null)

  if (canvas) {
    const ok = canvas.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 画布操作序列(上传→3 步→撤销 2 步→重做 1 步→跳步→复位)${
        canvas.error ? ` — ${canvas.error}` : ''
      }`
    )
    if (!ok) {
      console.log('   ', JSON.stringify(canvas.steps))
      process.exitCode = 1
    }
  }

  if (genProbe) {
    const ok = genProbe.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 出图编排层(死地址:建槽 → 调度 → 失败收尾)${
        ok ? '' : ` — ${JSON.stringify(genProbe)}`
      }`
    )
    if (!ok) process.exitCode = 1
  }

  if (paramsProbe) {
    const ok = paramsProbe.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 出图参数层(尺寸档位 → 参考图上传 → 清除)${
        ok ? '' : ` — ${JSON.stringify(paramsProbe)}`
      }`
    )
    if (!ok) process.exitCode = 1
  }

  if (chatProbe) {
    const ok = chatProbe.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 对话域(播种对话与记忆 → 渲染 → 清空)${
        ok ? '' : ` — ${JSON.stringify(chatProbe)}`
      }`
    )
    if (!ok) process.exitCode = 1
  }

  if (charsProbe) {
    const ok = charsProbe.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 角色域(新建 → 卡片出现 → 拿它开画)${
        ok ? '' : ` — ${JSON.stringify(charsProbe)}`
      }`
    )
    if (!ok) process.exitCode = 1
  }

  if (historyProbe) {
    const ok = historyProbe.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 历史域(删除 → 撤销放回 → 新建作品集)${
        ok ? '' : ` — ${JSON.stringify(historyProbe)}`
      }`
    )
    if (!ok) process.exitCode = 1
  }

  if (configProbe) {
    const ok = configProbe.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 接口配置域(设置页新增一条 → 回首页成为当前)${
        ok ? '' : ` — ${JSON.stringify(configProbe)}`
      }`
    )
    if (!ok) process.exitCode = 1
  }

  if (twoTabs) {
    const ok = twoTabs.passed === true
    console.log(`${ok ? '✅' : '❌'} 跨标签页同步:标记在另一页可见 (${twoTabs.markedInB_before} → ${twoTabs.markedInB_after})${twoTabs.error ? ` — ${twoTabs.error}` : ''}`)
    if (!ok) process.exitCode = 1
  }

  let breached = 0
  for (const [flag, limit, actual, label] of budgets) {
    const over = actual > Number(limit)
    if (over) breached++
    console.log(`${over ? '❌ 超预算' : '✅ 在预算内'} ${label}: ${actual} (--${flag} ${limit})`)
  }
  if (breached) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error('测量失败:', e.message)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    chrome.kill('SIGKILL')
    // 等 Chrome 真的退出再删 profile,否则会留下半截目录
    await sleep(500)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      rmSync(UPLOAD_PNG, { force: true })
    } catch {
      /* ignore */
    }
  })
