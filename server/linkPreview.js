/* ===== 链接卡片背后的那一层：取一次网页，只读它的标题与摘要 =====
   角色分享的链接是模型从对话里原样转述的，title 通常已经够用；
   预览是**锦上添花**：把页面自己的标题、描述、站点名补到卡片上。

   但这一层要替用户去访问一个**外部地址**，而地址最初来自模型 ——
   所以它同时是一道 SSRF 边界：
   - 只认 http(s)，字面量上的本机/内网地址在 chatAttachments 就挡掉了；
   - 这里再按 DNS 解析结果挡一次（域名可以指向 127.0.0.1）；
   - 重定向手动跟，每一跳都重新校验；
   - 只读 HTML、只读前 256KB、8 秒超时；
   - 不转发任何用户的 cookie 或鉴权头。

   取不到不是错误路径上的灾难：卡片照样显示模型给的那句标题。
   -------------------------------------------------------------------- */

import net from 'node:net'
import { lookup } from 'node:dns/promises'
import { isBlockedAddress } from './core.js'
import { isPrivateHost, normalizeHttpUrl } from './chatAttachments.js'
/* 解析是纯函数、单独一层：这里只负责"把网页取回来" */
import { parseLinkPreview } from './linkPreviewParse.js'

const PREVIEW_TIMEOUT_MS = 8000
const MAX_HTML_BYTES = 256 * 1024
const MAX_REDIRECTS = 3
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 200

/** 主机名解析出来的每一个地址都得是公网 —— 只要有一个落在内网就整条拒绝 */
async function assertPublicTarget(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isPrivateHost(host)) throw new Error('That address is not a public web page')
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('That address is not a public web page')
    return
  }
  let addrs
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new Error('That host could not be found')
  }
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) {
    throw new Error('That address is not a public web page')
  }
}

function charsetOf(contentType) {
  const m = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType || '')
  return m ? m[1].toLowerCase() : 'utf-8'
}

/** 只读前 max 字节。**不 arrayBuffer() 一把梭** —— 那等于让对面决定我们占多少内存 */
async function readCapped(resp, max) {
  const reader = resp.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || !value.byteLength) continue
    if (total + value.byteLength > max) {
      chunks.push(value.subarray(0, max - total))
      total = max
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  const bytes = new Uint8Array(total)
  let off = 0
  for (const chunk of chunks) {
    bytes.set(chunk, off)
    off += chunk.byteLength
  }
  try {
    return new TextDecoder(charsetOf(resp.headers.get('content-type')), {
      fatal: false
    }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

/** 取一个公网网页的 HTML。重定向手动跟，每一跳重新做地址校验 */
async function fetchHtml(startUrl) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), PREVIEW_TIMEOUT_MS)
  try {
    let cur = new URL(startUrl)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicTarget(cur)
      const resp = await fetch(cur, {
        redirect: 'manual',
        signal: ac.signal,
        headers: {
          /* 不带 cookie、不带 referer、不带用户的任何东西 */
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'User-Agent': 'KairoLinkPreview/1.0'
        }
      })
      if (resp.status >= 300 && resp.status < 400) {
        if (hop === MAX_REDIRECTS) throw new Error('Too many redirects')
        const loc = resp.headers.get('location')
        if (!loc) throw new Error('The page redirected nowhere')
        const next = normalizeHttpUrl(new URL(loc, cur).toString())
        if (!next) throw new Error('The page redirected somewhere unsafe')
        cur = new URL(next)
        continue
      }
      if (!resp.ok) throw new Error(`The page returned HTTP ${resp.status}`)
      const type = resp.headers.get('content-type') || ''
      if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
        throw new Error('That link is not a web page')
      }
      const html = await readCapped(resp, MAX_HTML_BYTES)
      return { html, finalUrl: cur.toString() }
    }
  } finally {
    clearTimeout(timer)
  }
  throw new Error('Too many redirects')
}

const cache = new Map()

function cached(url) {
  const hit = cache.get(url)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(url)
    return null
  }
  return hit.data
}

function remember(url, data) {
  if (cache.size >= CACHE_MAX) {
    // Map 按插入顺序迭代：删最早那一枚就够，不必算 LRU
    cache.delete(cache.keys().next().value)
  }
  cache.set(url, { at: Date.now(), data })
}

/**
 * 取一个链接的预览。**只接受公网 http(s)**；调用方把错误翻成一句人话。
 * 同一地址 30 分钟内只真正取一次 —— 重载页面不该重复去打别人的站。
 */
export async function previewLink(rawUrl) {
  const url = normalizeHttpUrl(rawUrl)
  if (!url) throw new Error('Not a valid public http(s) link')
  const hit = cached(url)
  if (hit) return hit
  const { html, finalUrl } = await fetchHtml(url)
  const data = parseLinkPreview(html, finalUrl)
  remember(url, data)
  return data
}
