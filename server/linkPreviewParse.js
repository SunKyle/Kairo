/* ===== 链接预览的解析层（纯函数） ==================================
   从一段 HTML 里读标题、描述、站点名。**这里不碰网络、不碰配置** ——
   访问网页、跟重定向、挡内网那一层在 server/linkPreview.js。

   分开的理由与 chatTags/chatAttachments 一样：解析是最容易被各种
   真实网页喂坏的一步（没引号、单引号、实体、大小写、属性顺序），
   而它一旦和 dotenv / 代理装配混在同一个模块里，单测就得先把那套
   环境背起来。这里只认字符串。
   -------------------------------------------------------------------- */

function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    const b = body.toLowerCase()
    if (b === 'amp') return '&'
    if (b === 'lt') return '<'
    if (b === 'gt') return '>'
    if (b === 'quot') return '"'
    if (b === 'apos') return "'"
    if (b === 'nbsp') return ' '
    if (b[0] === '#') {
      const n = b[1] === 'x' ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole
    }
    return whole
  })
}

function oneLine(v, max) {
  return decodeEntities(v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** 把 `<meta ...>` 的属性摊成一张小写键的表。属性值可带引号也可不带 */
function attrsOf(tag) {
  const out = {}
  const body = tag.replace(/^<meta\b/i, '').replace(/\/?>$/, '')
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m
  while ((m = re.exec(body))) {
    const k = m[1].toLowerCase()
    if (!k || k === '/') continue
    out[k] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return out
}

/** 页面上所有 meta 键 → 值。同名只认第一枚（后面的常是主题色之类） */
function metaMap(html) {
  const map = new Map()
  const re = /<meta\b[^>]*>/gi
  let m
  while ((m = re.exec(html))) {
    const attrs = attrsOf(m[0])
    const key = (attrs.property || attrs.name || '').toLowerCase()
    const content = attrs.content ?? attrs.value ?? ''
    if (key && content && !map.has(key)) map.set(key, content)
  }
  return map
}

function firstMeta(map, keys) {
  for (const key of keys) {
    const v = map.get(key)
    if (v && v.trim()) return v
  }
  return ''
}

/**
 * 从 HTML 里读标题、描述、站点名。纯函数，单测直接喂字符串。
 * `url` 只用来在页面没给 site name 时兜一个主机名。
 */
export function parseLinkPreview(html, url) {
  const src = String(html || '')
  const map = metaMap(src)
  const title =
    firstMeta(map, ['og:title', 'twitter:title']) ||
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1] ?? '')
  const description = firstMeta(map, [
    'og:description',
    'twitter:description',
    'description'
  ])
  let host = ''
  try {
    host = new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    /* url 坏了就没有兜底，不抛 */
  }
  const siteName = firstMeta(map, ['og:site_name', 'application-name']) || host
  return {
    title: oneLine(title, 120),
    description: oneLine(description, 240),
    siteName: oneLine(siteName, 80)
  }
}
