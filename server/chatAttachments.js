/* ===== 消息附件（link 与 music） ====================================
   角色除了说话、发图，还可以**转一样东西**过来：一个链接，或一首歌。它和
   photo 一样是正文之外的东西，所以走同一个 `emit_message_meta` 工具调用，
   只是字段叫 `attachment`。一条消息最多带一件。

   这个文件只负责**收口**，不负责取回预览：
   - 模型给的是外部输入，其中 url 会变成一个真正可点的链接；
   - 所以 kind / title / url 逐项收窄，http(s) 以外的协议、带账号密码的
     URL、本机与内网地址一律丢掉；
   - 预览（标题、描述、站点名）是**另一条路**（见 server/linkPreview.js），
     只对 link 走，拿不到也不影响这条消息成立 —— 卡片会退回模型给的那句标题。

   link 与 music 的"合法"长得不一样，这是这一层唯一的分叉：
   - **link 离不开地址**：没有一条能点的 http(s) 地址，"链接"就无从谈起，整块丢掉；
   - **music 可以先只是一句"我在放这首歌"**：曲名是本体，地址是锦上添花。
     有合法 http(s) 就带上（卡片可点），没有、或地址坏了解析就**只丢地址、
     留住这张卡**。所以这一枚里 url 是可缺的。

   为什么不复用 chatPhoto.js：两者的"错"长得不一样。photo 坏了只是少一张
   图；attachment 的 url 坏了是一枚能骗人点下去的假链接。所以这里的校验
   独立成一层，测试也独立。
   -------------------------------------------------------------------- */

import net from 'node:net'

/** 认领的附件种类。加一项（video…）= 在这里追加 + 前端补一条渲染器 */
export const ATTACHMENT_KINDS = ['link', 'music']

export const ATTACHMENT_TITLE_CHARS = 120
export const ATTACHMENT_SUBTITLE_CHARS = 160
export const ATTACHMENT_URL_CHARS = 2048

const DEFAULT_TITLE_CHARS = 80

/** 换行与连续空白收成一个空格，再截到上限 */
function oneLine(v, max) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * 这个主机名是不是"不该从外部链接访问"的那一类。
 *
 * 只看**字面量**：域名解析出来是不是内网，要等 DNS（见 server/linkPreview.js
 * 的 assertPublicTarget）。这里挡住的是 `http://localhost:3101`、`http://192.168.1.1`
 * 这种一眼就该拒绝的，以及 `.local` / `.internal` 这类内网后缀。
 *
 * 规则与 core.js 的 isBlockedAddress 对齐，但**不 import 它**：那个模块一加载
 * 就会读 dotenv、建代理，而这一层是要被单测反复调用的纯函数。复制的是同一张
 * 地址表，不是另一套判断。
 */
export function isPrivateHost(host) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!h) return true
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === 'metadata.google.internal'
  ) {
    return true
  }
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && (b === 168 || b === 0)) return true
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true
    if (a === 203 && b === 0) return true
    return false
  }
  if (net.isIPv6(h)) {
    if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7))
    if (h === '::' || h === '::1') return true
    if (h.startsWith('fc') || h.startsWith('fd')) return true
    if (/^fe[89ab]/.test(h)) return true
    if (h.startsWith('ff')) return true
    if (h.startsWith('2001:db8')) return true
    return false
  }
  return false
}

/** 一个能安全交给 `<a href>` 的 http(s) 地址。不合法就回空串。 */
export function normalizeHttpUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s.length > ATTACHMENT_URL_CHARS) return ''
  let u
  try {
    u = new URL(s)
  } catch {
    return ''
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
  /* 带账号密码的 URL 会把凭据塞进地址栏与 referer，也会让"这到底是谁的站"
     变得说不清。模型没有任何理由生成这种链接，直接不收 */
  if (u.username || u.password) return ''
  if (!u.hostname || isPrivateHost(u.hostname)) return ''
  return u.href
}

/** 没有标题时拿主机名兜底 —— 卡片宁可少一句话，也不要只有一枚光秃秃的 URL */
function fallbackTitle(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').slice(0, DEFAULT_TITLE_CHARS)
  } catch {
    return ''
  }
}

/**
 * 把模型给的 attachment 收成消息上的那一枚。
 *
 * 返回 null = 这个附件整块不要。**不要回落成"只有 url 的裸链接"**：
 * 卡片没有标题就只剩一个地址，那与在正文里贴一串 URL 没有区别，还会
 * 让"这是一张卡片"的承诺落空。
 *
 * 两条 kind 各有一条"什么算整块不要"：
 * - link：url 不合法 / 缺 → 整块丢（它就不是一个链接了）；
 * - music：url 坏只丢 url、留卡（纯分享一首歌也成立），但缺标题才整块丢。
 */
export function normalizeAttachment(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const kind = oneLine(v.kind, 20).toLowerCase()
  if (!ATTACHMENT_KINDS.includes(kind)) return null
  const url = normalizeHttpUrl(v.url)
  const rawTitle = oneLine(v.title, ATTACHMENT_TITLE_CHARS)
  const subtitle = oneLine(v.subtitle, ATTACHMENT_SUBTITLE_CHARS)

  if (kind === 'link') {
    if (!url) return null
    const title = rawTitle || fallbackTitle(url)
    if (!title) return null
    return { kind: 'link', title, url, ...(subtitle ? { subtitle } : {}) }
  }

  /* music：曲名是本体。没有名字就无从分享，整块丢；
     地址能过就带上让卡片可点，过不了也只是退回一张不能点的分享卡 */
  if (!rawTitle) return null
  return { kind: 'music', title: rawTitle, ...(url ? { url } : {}), ...(subtitle ? { subtitle } : {}) }
}

/** 工具 schema 里的 attachment 对象。字段说明同时就是"该怎么填"的说明书 */
export function attachmentSchema() {
  return {
    type: 'object',
    description:
      'The one thing you pass along with this message: a link, or a song you are putting on. Omit it entirely when you are not sharing anything. Most messages share nothing, and a message carries at most one.',
    properties: {
      kind: {
        type: 'string',
        enum: ATTACHMENT_KINDS,
        description: 'What you are sharing: "link" for a web page, "music" for a song.'
      },
      title: {
        type: 'string',
        description:
          'What the thing is, in a few words, as you would name it to a friend — the page name for a link, the song title for music. Do not paste the URL here.'
      },
      url: {
        type: 'string',
        description:
          'For a link: the complete http:// or https:// address, copied exactly from something already in this conversation — never invent, shorten, or guess it. For a song: leave it out unless that exact address is already in front of you; a song needs no link to be shared. Never localhost or a private network address.'
      },
      subtitle: {
        type: 'string',
        description:
          'Optional one short line under the title: why you are sharing a link, or the artist of a song. Leave it out when the title says enough.'
      }
    },
    required: ['kind', 'title'],
    additionalProperties: false
  }
}
