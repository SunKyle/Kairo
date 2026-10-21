/* ===== 消息附件的前端收口 ============================================
   服务端已经在 chatAttachments.js 收过一次；这里再来一次，是因为同一条
   消息还可能从**另外两条路**进来：

   1. 导入的角色包 —— 外部文件，不能因为"导出时是干净的"就跳过校验；
   2. IndexedDB —— 老版本、手工改过的库、别处同步过来的行。

   两次收口的规则必须一致（尤其 url）。前端这一份只看**字面量**：
   域名解析到内网的风险由服务端的预览接口挡（它才是真的去访问的那个）。
   -------------------------------------------------------------------- */

import type { ChatAttachment, ChatAttachmentPreview } from '../types'

const TITLE_MAX = 120
const SUBTITLE_MAX = 160
const URL_MAX = 2048
const PREVIEW_DESCRIPTION_MAX = 240
const PREVIEW_SITE_MAX = 80

function oneLine(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** 字面量层面的本机/内网判断。与服务端 chatAttachments.js 同一张表 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
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
  const v4 = h.split('.').map(Number)
  if (v4.length === 4 && v4.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = v4
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && (b === 168 || b === 0)) return true
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true
    if (a === 203 && b === 0) return true
    return false
  }
  if (h.includes(':')) {
    if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7))
    if (h === '::' || h === '::1') return true
    if (h.startsWith('fc') || h.startsWith('fd')) return true
    if (/^fe[89ab]/.test(h)) return true
    if (h.startsWith('ff')) return true
    if (h.startsWith('2001:db8')) return true
  }
  return false
}

/** 能安全交给 `<a href>` 的 http(s) 地址；不合法回空串。 */
export function normalizeLinkUrl(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s || s.length > URL_MAX) return ''
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return ''
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
  if (u.username || u.password) return ''
  if (!u.hostname || isPrivateHost(u.hostname)) return ''
  return u.href
}

export function attachmentHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

/** 预览接口回来/包里带回来的那一行元信息。全是可缺的短文本 */
export function coerceAttachmentPreview(v: unknown): ChatAttachmentPreview | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const title = oneLine(o.title, TITLE_MAX)
  const description = oneLine(o.description, PREVIEW_DESCRIPTION_MAX)
  const siteName = oneLine(o.siteName, PREVIEW_SITE_MAX)
  if (!title && !description && !siteName) return undefined
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(siteName ? { siteName } : {})
  }
}

/**
 * 外部来源的 attachment → 能安全落库/渲染的那一枚。
 *
 * 返回 undefined = 整块丢掉（不是空对象）。旧版本、坏包、被改坏的库里
 * 都可能出现这种行；留一个空壳会让界面挂出一张没有标题也没有地址的卡片。
 *
 * 与服务端 chatAttachments.js 同一套规则：
 * - link：离不开一条合法 http(s) 地址，坏了/缺了就整块丢；标题缺了用域名兜底；
 * - music：曲名是本体，缺标题才整块丢；地址能过就带上、过不了只丢地址、留住卡。
 */
export function coerceChatAttachment(v: unknown): ChatAttachment | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const kind = oneLine(o.kind, 20).toLowerCase()
  if (kind !== 'link' && kind !== 'music') return undefined
  const url = normalizeLinkUrl(o.url)
  const rawTitle = oneLine(o.title, TITLE_MAX)
  const subtitle = oneLine(o.subtitle, SUBTITLE_MAX)
  const preview = coerceAttachmentPreview(o.preview)

  if (kind === 'link') {
    if (!url) return undefined
    const title = rawTitle || attachmentHost(url)
    if (!title) return undefined
    return {
      kind: 'link',
      title,
      url,
      ...(subtitle ? { subtitle } : {}),
      ...(preview ? { preview } : {})
    }
  }

  if (!rawTitle) return undefined
  return {
    kind: 'music',
    title: rawTitle,
    ...(url ? { url } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(preview ? { preview } : {})
  }
}
