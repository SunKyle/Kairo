import dotenv from 'dotenv'
import net from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { ProxyAgent } from 'undici'

dotenv.config()

/* Node 的 fetch(undici)不读 macOS 的系统代理设置,只认显式配置。
   这里让被阻断的境外接口可选地走代理,国内接口仍直连(见 NO_PROXY),
   不配 UPSTREAM_PROXY 时全程直连,行为不变。 */
export const UPSTREAM_PROXY = process.env.UPSTREAM_PROXY || ''

export const NO_PROXY = (process.env.NO_PROXY || 'localhost,127.0.0.1,volces.com,bytedance.com,aliyuncs.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export const proxyAgent = UPSTREAM_PROXY ? new ProxyAgent(UPSTREAM_PROXY) : null
if (proxyAgent) {
  console.log(`[KImage] 上游代理: ${UPSTREAM_PROXY}(以下域名直连: ${NO_PROXY.join(', ')})`)
}

/** 命中的域名直连,其余走代理;没配代理则一律直连(返回 undefined 用默认调度器) */
export function dispatcherFor(target) {
  if (!proxyAgent) return undefined
  const host = new URL(target).hostname
  return NO_PROXY.some((s) => host === s || host.endsWith(`.${s}`)) ? undefined : proxyAgent
}

export function dispatchAttempts(target) {
  const proxy = dispatcherFor(target)
  return proxy ? [proxy, undefined] : [undefined]
}

export const ON_SERVERLESS = !!process.env.VERCEL
export const PROD_LIKE = ON_SERVERLESS || process.env.NODE_ENV === 'production'
export const ALLOW_PRIVATE_TARGETS = process.env.ALLOW_PRIVATE_TARGETS === '1' || !PROD_LIKE

/** 判断 IP 是否落在不该被代理访问的网段里 */
export function isBlockedAddress(ip) {
  const v4 = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && (b === 168 || b === 0)) return true
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true
    if (a === 203 && b === 0) return true
    return false
  }
  if (net.isIPv6(v4)) {
    const s = v4.toLowerCase()
    if (s === '::' || s === '::1') return true
    if (s.startsWith('fc') || s.startsWith('fd')) return true
    if (/^fe[89ab]/.test(s)) return true
    if (s.startsWith('ff')) return true
    if (s.startsWith('2001:db8')) return true
    return false
  }
  return true
}

/** 校验目标并返回解析后的 URL;不合法就抛错(调用方转成 400) */
export async function assertSafeTarget(target) {
  let url
  try {
    url = new URL(target)
  } catch {
    throw new Error('Enter a valid Base URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must start with http:// or https://')
  }
  if (ALLOW_PRIVATE_TARGETS) return url

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`Blocked: ${host} is a private or reserved address`)
    return url
  }
  let addrs = []
  try {
    addrs = await dnsLookup(host, { all: true })
  } catch {
    throw new Error(`Can't resolve host ${host} — check the address`)
  }
  const bad = addrs.find((a) => isBlockedAddress(a.address))
  if (bad) throw new Error(`Blocked: ${host} points to a private address`)
  return url
}

/**
 * 带 SSRF 重定向校验的 fetch:
 * 显式设置 redirect: 'manual' 阻止底层无条件跟进重定向;
 * 若上游返回 3xx,提取 Location 头并执行 assertSafeTarget 校验,
 * 仅当重定向目标为安全合法地址时才跟随(最多 2 跳),彻底阻断利用 30x 绕过 SSRF 检查。
 */
export async function safeFetch(target, init = {}) {
  let cur = target
  const maxHops = 2
  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetch(cur, { ...init, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      if (hop === maxHops) {
        throw new Error('Too many redirects from upstream')
      }
      const rawLoc = res.headers.get('location')
      if (!rawLoc) return res
      const nextUrl = new URL(rawLoc, cur).toString()
      await assertSafeTarget(nextUrl)
      cur = nextUrl
      if (init.dispatcher !== undefined) {
        init = { ...init, dispatcher: dispatcherFor(cur) }
      }
      continue
    }
    return res
  }
  return await fetch(cur, { ...init, redirect: 'manual' })
}

const RATE_WINDOW_MS = 60_000
const RATE_MAX = 30
const rateHits = new Map()

export function rateLimit(req, res, next) {
  const isTrustedProxy = Boolean(req.app?.get('trust proxy'))
  const forwarded = isTrustedProxy
    ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    : ''
  const ip = forwarded || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const hits = (rateHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS)
  if (hits.length >= RATE_MAX) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' })
  }
  hits.push(now)
  rateHits.set(ip, hits)
  if (rateHits.size > 500) {
    for (const [key, times] of rateHits) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) rateHits.delete(key)
    }
  }
  next()
}

export const UPSTREAM_TIMEOUT_MS = 120_000

export const CONNECT_HINTS = {
  ENOTFOUND: "Can't resolve the host. Check the Base URL spelling.",
  ECONNREFUSED: 'The host refused the connection. Check the address and port.',
  ETIMEDOUT: 'The connection timed out. The endpoint may be unreachable or blocked.',
  ECONNRESET:
    'The connection was reset in transit — the domain is likely blocked. ' +
    'Configure UPSTREAM_PROXY on the server, or use an endpoint reachable from your region.',
  EPIPE: 'The connection closed early, usually a proxy or firewall. Check the network path.',
  UND_ERR_CONNECT_TIMEOUT:
    'The connection timed out; overseas endpoints are often blocked on direct connections. ' +
    'Use a local endpoint or configure UPSTREAM_PROXY.',
  UND_ERR_SOCKET: 'The socket closed mid-stream, usually a proxy or firewall. Check the network path.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    'Node does not trust the TLS certificate, often from a local proxy tool. Add the root certificate to NODE_EXTRA_CA_CERTS.',
  SELF_SIGNED_CERT_IN_CHAIN:
    'The TLS chain includes a self-signed certificate, often from a local proxy tool. Add the root certificate to NODE_EXTRA_CA_CERTS.'
}

export function looksLikeHtml(body) {
  return /^\s*<(!doctype|html|\?xml)/i.test(body)
}

export function htmlTitle(html) {
  const t = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]
  return t ? t.trim().replace(/\s+/g, ' ').slice(0, 160) : ''
}

/** 上游原文里那句给人看的话:整页 HTML 只取标题,JSON 取 message,其余截断。
 *  三条代理路由(对话/出图/语音)都要把上游的报错转成人话,口径收在这一处 */
export /** 上游原文里那句给人看的话:整页 HTML 只取标题,JSON 取 message,其余截断 */
function shortDetail(text) {
  if (!text) return ''
  if (looksLikeHtml(text)) {
    const t = htmlTitle(text)
    return `The host answered with an HTML page${t ? `: ${t}` : ''}`
  }
  try {
    const j = JSON.parse(text)
    const m = j?.error?.message ?? j?.message
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 300)
  } catch {
    /* 不是 JSON 就原样截断 */
  }
  return text.slice(0, 300)
}
