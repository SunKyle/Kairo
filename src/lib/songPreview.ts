/* ===== 一张歌卡怎么变成"能出声的 30 秒" ==============================
 *
 *  歌卡上本来只有模型给的两个词:曲名与歌手。要真的放出声,还需要一个
 *  **音频地址** —— 这一层负责把它找回来,并且尽量只找一次。
 *
 *  走的是 Apple 的 iTunes Search API:
 *  - 不要 key、不要登录,浏览器可以直接请求(CORS 是 `*`);
 *  - 每条结果带一个 30 秒试听地址,地址本身就是公开 CDN 上的 AAC;
 *  - 不拉封面、不拉整首,打开对话时一个请求都不发 —— **只有用户点下播放
 *    的那一刻**才去搜(见下面 lookupSongPreview 的调用点)。
 *
 *  三个判断都不在界面里,放在这里是因为它们各有各的边角,而且能直接喂数据测:
 *
 *  1. **同一首歌的键**(songKey)。缓存按 "曲名|歌手" 归一化后存,
 *     大小写、全半角、多余空白的差异都该落到同一条上。
 *  2. **哪一条结果才是这首**(matchSong / bestSongMatch)。iTunes 会混进
 *     live、remix、翻唱,以及**繁体**的曲名与歌手名(搜「轨迹 周杰伦」回来的是
 *     「軌跡 周杰倫」)。只做字符串相等会把这些正确结果全部判死。
 *  3. **存下来的还算不算数**(usableSongPreview)。找到的地址保留 7 天;
 *     没找到的负结果只记 24 小时 —— 目录会更新,不该因为昨天没有就永远没有。
 *
 *  所有函数都不抛异常。搜不到、断网、超时都只是"这张卡没有试听",
 *  不该把点它的那个人一起弄坏。
 * ------------------------------------------------------------------ */
import {
  getSongPreview,
  putSongPreview,
  touchSongPreview,
  type SongPreviewRecord
} from './idb'

/** 一次搜索的结果。字段都可能缺 —— 这是从网上回来的 JSON,不是我们的类型 */
export interface SongCandidate {
  trackName?: unknown
  artistName?: unknown
  previewUrl?: unknown
  trackViewUrl?: unknown
}

/** 找到的那一首。previewUrl 是那段 30 秒;trackViewUrl 是 Apple Music 的整首 */
export interface SongPreview {
  previewUrl: string
  trackName: string
  artistName: string
  trackViewUrl?: string
}

/** 找到的地址保留多久。Apple 的预览地址很稳,但"很稳"不等于永远 */
export const SONG_HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 搜不到的负结果保留多久。比正结果短得多 —— 目录会补歌 */
export const SONG_MISS_TTL_MS = 24 * 60 * 60 * 1000
/** 搜索超时。超过这个时间就当作"这次没搜到",卡片落到不可用 */
const SEARCH_TIMEOUT_MS = 8000
/** 一次取几条候选。取 8 条足够在 live/remix 里挑出原版 */
const SEARCH_LIMIT = 8
/** 地区。HK 店的中文曲库比 CN 全(CN 店常常返回空),英文歌也在 */
const SEARCH_COUNTRY = 'HK'

/** 只留 http(s) 的地址。空串 = 不能用 */
function httpUrl(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return ''
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''
  } catch {
    return ''
  }
}

/**
 * 把一段文字收成"比较用"的形状:全半角统一、大小写拉平、空白收一。
 * **只用于比较,不用于显示** —— 卡片上仍画模型给的原字。
 */
export function normalizeMatchText(v: string): string {
  return String(v ?? '')
    .normalize('NFKC')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 曲名比较用的"主标题":去掉括号里的版本注记、去掉 " - Remastered 2011"
 * 这类尾巴。
 *
 *  为什么必须去:同一个曲名在目录里常带一串版本后缀
 *  ("Shape of You (Acoustic)"、"晴天 (Live)")。带着括号比,
 *  原版与这些版本会被判成两首不同的歌;去掉之后它们才回到同一个主标题,
 *  再由下面的版本惩罚决定谁排前面。
 *
 *  只影响比较与搜索词,不改卡片上的显示。
 */
export function baseTitle(v: string): string {
  let s = normalizeMatchText(v)
  // 括号可以是半角、全角、方头括号;内容非贪婪,多个括号各去各的
  s = s.replace(/\s*[([（【][^)\]）】]*[)\]）】]\s*/g, ' ')
  // " - Remastered 2011" / " - Live at ..." 这类尾部注记
  s = s.replace(
    /\s*[-–—]\s*(?:remaster(?:ed)?(?:\s+\d{4})?|live|acoustic|demo|radio edit|single version|album version|mono|stereo)\b.*$/i,
    ''
  )
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 只留拉丁字母与数字的键,并去掉重音、开头的 "the"。
 * "Beyoncé" 与 "Beyonce"、"The Beatles" 与 "Beatles" 都该是同一个。
 */
function latinKey(v: string): string {
  return normalizeMatchText(v)
    .replace(/^the\s+/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
}

const CJK_CHAR_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g

/** 这段文字里的汉字 / 假名 / 谚文字符 */
function cjkChars(v: string): string[] {
  return v.match(CJK_CHAR_RE) || []
}

/**
 * 两段 CJK 文字共用了多少字(交集 ÷ 较长那一段)。
 *
 *  这是**繁简与异体字的桥**:iTunes 的港台目录把「轨迹 / 周杰伦」写成
 *  「軌跡 / 周杰倫」,逐字相等会全部落空;而两段文字里总有几个字是共用的
 *  (軌跡↔轨迹 共用「跡」,周杰倫↔周杰伦 共用「周」)。按比例判,
 *  0.34 这条线足够挡住"同一位歌手的另一首歌",又放得过繁简差异。
 */
function cjkOverlap(a: string, b: string): number {
  const left = new Set(cjkChars(a))
  const right = new Set(cjkChars(b))
  if (!left.size || !right.size) return 0
  let hit = 0
  for (const c of left) if (right.has(c)) hit++
  return hit / Math.max(left.size, right.size)
}

/** 一段字符串是否"包含"另一段,但短的那段不能太短 ——
 *  一个字的包含关系("Live" 里的 "i")没有判断价值 */
function meaningfulContains(a: string, b: string): boolean {
  if (!a || !b) return false
  const short = a.length <= b.length ? a : b
  const long = short === a ? b : a
  const min = cjkChars(short).length ? 2 : 3
  return short.length >= min && long.includes(short)
}

const VERSION_WORD_RE =
  /\b(live|remix|karaoke|instrumental|acoustic|demo|cover|commentary|reprise)\b/i

/** 歌手这一段的相似度。0 = 不是同一个人,直接判死 */
function artistScoreOf(targetArtist: string, artistName: string): number {
  const wantArtist = normalizeMatchText(artistOf(targetArtist))
  if (!wantArtist) return 0
  const gotArtist = normalizeMatchText(artistName)
  if (wantArtist === gotArtist) return 1
  if (latinKey(wantArtist) && latinKey(wantArtist) === latinKey(gotArtist)) return 1
  if (meaningfulContains(wantArtist, gotArtist)) return 0.9
  if (
    cjkChars(wantArtist).length > 0 &&
    cjkChars(gotArtist).length > 0 &&
    cjkOverlap(wantArtist, gotArtist) >= 0.33
  ) {
    return 0.78
  }
  return 0
}

/**
 * "榜首可信"通道:iTunes 对"曲名 + 歌手"的相关度排序本身很有用,而**繁简**
 * 会让逐字比较彻底落空 ——「轨迹」与「軌跡」一个字都不共用,「周杰伦」与
 * 「周杰倫」只共用「周」。这类结果若卡在字符串比较上,正确的那首会被判死,
 * 卡片明明找得到却显示"没有试听"。
 *
 *  所以只对**搜索结果第一条**开一条窄门:两边都是 CJK、主标题字数相同、
 *  歌手高度重合(≥0.33)时,接受这一条。第二条起不再放行 ——
 *  翻唱、live、Kala 都在后面,信任 iTunes 的榜首已经够了。
 */
export function trustedCjkTopHit(
  targetTitle: string,
  targetArtist: string,
  trackName: string,
  artistName: string
): boolean {
  const wantTitle = baseTitle(targetTitle)
  const gotTitle = baseTitle(trackName)
  if (!wantTitle || !gotTitle) return false
  const wantChars = cjkChars(wantTitle)
  const gotChars = cjkChars(gotTitle)
  if (!wantChars.length || !gotChars.length) return false
  if (wantChars.length !== gotChars.length) return false
  /* baseTitle 把 "(Live)" 这类括号注记一并去掉了 —— 一首 live 版在这里
     看起来与原版一模一样。所以再回头看一眼**原始**曲名:目标没点名版本、
     结果却带版本词时,连榜首也不信。这条通道只为繁简差异开着,
     不该顺手把版本差异也吞掉 */
  if (VERSION_WORD_RE.test(trackName) && !VERSION_WORD_RE.test(targetTitle)) return false
  return artistScoreOf(targetArtist, artistName) >= 0.75
}

/**
 * 给一条搜索结果打分。0 = 不是这首;越高越像。
 *
 *  分三段:
 *  - 曲名(权重 0.66):完全相等 > 去掉版本注记后相等 > 拉丁键相等 >
 *    一方包含另一方 > 繁简/异体字高度重合;
 *  - 歌手(权重 0.34):完全相等 / 拉丁键相等 / 包含 / 繁简重合。
 *    **歌手对不上直接判 0** —— 宁可没有试听,也不要放一首别人翻唱的歌;
 *  - 版本惩罚:结果带 live/remix/karaoke 而目标没带,扣 0.22。
 *    只扣分不排除:用户想要的本身就是 live 版时,目标里也带这些词,不罚。
 *
 *  没给歌手时只按曲名判,权重压到 0.9 —— 这种卡本来就是"只有曲名"的分享。
 */
export function matchSong(
  targetTitle: string,
  targetArtist: string,
  trackName: string,
  artistName: string
): number {
  const wantTitle = normalizeMatchText(targetTitle)
  const gotTitle = normalizeMatchText(trackName)
  if (!wantTitle || !gotTitle) return 0

  const wantBase = baseTitle(wantTitle)
  const gotBase = baseTitle(gotTitle)
  let titleScore = 0
  if (wantTitle === gotTitle) titleScore = 1
  else if (wantBase && wantBase === gotBase) titleScore = 0.96
  else if (latinKey(wantTitle) && latinKey(wantTitle) === latinKey(gotBase)) titleScore = 0.94
  else if (meaningfulContains(wantTitle, gotBase)) titleScore = 0.86
  else if (
    cjkChars(wantBase).length > 0 &&
    cjkChars(gotBase).length > 0 &&
    Math.abs(cjkChars(wantBase).length - cjkChars(gotBase).length) <= 1 &&
    cjkOverlap(wantBase, gotBase) >= 0.4
  ) {
    titleScore = 0.76
  }
  if (!titleScore) return 0

  const wantArtist = normalizeMatchText(artistOf(targetArtist))
  if (!wantArtist) {
    /* 没有歌手可核对时只认**主标题相等**这一档:包含关系("Yellow" 对上
       "Yellow Submarine")在没有第二根柱子时太容易放错歌。宁可少一首可播,
       也不要替用户放错 */
    return titleScore >= 0.94 ? Math.min(1, titleScore * 0.9 + 0.1) : 0
  }

  const artistScore = artistScoreOf(wantArtist, artistName)
  if (!artistScore) return 0

  let score = titleScore * 0.66 + artistScore * 0.34
  if (VERSION_WORD_RE.test(gotTitle) && !VERSION_WORD_RE.test(wantTitle)) score -= 0.22
  return Math.max(0, score)
}

/** 从一组候选里挑最像的那首。找不到(或都差太远)返回 null。
 *
 *  同分时**排在前面的赢**(iTunes 的相关度排序本身有用),
 *  用一点点下标惩罚把这件事表达出来,不必另写一套稳定排序。
 */
export function bestSongMatch(
  results: readonly SongCandidate[],
  title: string,
  artist: string
): SongPreview | null {
  let best: SongPreview | null = null
  let bestScore = 0.55
  for (let i = 0; i < results.length; i++) {
    const raw = results[i]
    if (!raw || typeof raw !== 'object') continue
    const trackName = typeof raw.trackName === 'string' ? raw.trackName : ''
    const artistName = typeof raw.artistName === 'string' ? raw.artistName : ''
    const previewUrl = httpUrl(raw.previewUrl)
    if (!trackName || !artistName || !previewUrl) continue
    let score = matchSong(title, artist, trackName, artistName)
    /* 逐字对不上、但列在第一条且歌手高度重合:走"榜首可信"那条窄门(见上)。
       只给 0.68,比任何一条真正对上的结果都低 —— 有对得上的,对得上的赢 */
    if (!score && i === 0 && trustedCjkTopHit(title, artist, trackName, artistName)) {
      score = 0.68
    } else {
      score -= i * 0.003
    }
    if (score <= bestScore) continue
    bestScore = score
    const trackViewUrl = httpUrl(raw.trackViewUrl)
    best = {
      previewUrl,
      trackName,
      artistName,
      ...(trackViewUrl ? { trackViewUrl } : {})
    }
  }
  return best
}

/** 歌手那一行可能写成 "by 周杰伦" / "Artist: 周杰伦" —— 搜索与比较前先剥掉 */
export function artistOf(subtitle: string): string {
  return String(subtitle ?? '')
    .replace(/^\s*(?:by|artist)\s*[:：]?\s*/i, '')
    .trim()
}

/** 缓存键。只拉平大小写/全半角/空白,**保留括号里的版本注记** ——
 *  "Song" 与 "Song (Live)" 可以是两条不同的试听,缓存不该把它们并成一条。 */
export function songKey(title: string, artist: string): string {
  return `${normalizeMatchText(title)}|${normalizeMatchText(artistOf(artist))}`
}

/** 发给 iTunes 的搜索词。曲名去版本注记(避免搜出一堆 live),歌手剥前缀 */
export function songQuery(title: string, artist: string): string {
  const t = baseTitle(title).slice(0, 120)
  const a = normalizeMatchText(artistOf(artist)).slice(0, 80)
  return [t, a].filter(Boolean).join(' ').slice(0, 200)
}

/**
 * 存下来的那条还能不能用。
 *
 *  - 正结果:地址合法且未超过 7 天;
 *  - 负结果:未超过 24 小时;
 *  - createdAt 在未来(改过系统时间)当作刚写入 —— 不因为时钟歪了就当它过期。
 */
export function usableSongPreview(
  rec: SongPreviewRecord | undefined,
  now: number
): boolean {
  if (!rec || !Number.isFinite(rec.createdAt)) return false
  const age = now - rec.createdAt
  if (!Number.isFinite(age)) return false
  if (age < 0) return true
  if (rec.missing === true) return age <= SONG_MISS_TTL_MS
  return age <= SONG_HIT_TTL_MS && !!httpUrl(rec.previewUrl)
}

/** 同一个键同时只搜一次。连点两下、或两张同歌的卡一起点,共用同一个请求 */
const inflight = new Map<string, Promise<SongPreview | null>>()

/**
 * 找一首歌的 30 秒试听。找到返回地址;找不到 / 断网 / 超时都返回 null。
 *
 *  **只有用户点下播放才会走到这里** —— 打开对话不预热、不预取。
 *  这是本地优先那条规矩的一部分:没被要求时,不替用户把请求发出去。
 */
export async function lookupSongPreview(
  title: string,
  artist: string
): Promise<SongPreview | null> {
  const query = songQuery(title, artist)
  if (!query) return null
  const key = songKey(title, artist)

  const cached = await getSongPreview(key)
  if (usableSongPreview(cached, Date.now())) {
    if (cached?.missing) return null
    if (cached?.previewUrl) {
      // 命中就记一次"最近用过",淘汰时先留常听的那几首;不 await,不挡播放
      void touchSongPreview(key)
      return {
        previewUrl: cached.previewUrl,
        trackName: cached.trackName || title,
        artistName: cached.artistName || artist,
        ...(cached.trackViewUrl ? { trackViewUrl: cached.trackViewUrl } : {})
      }
    }
  }

  const flying = inflight.get(key)
  if (flying) return flying
  const task = searchPreview(key, title, artist, query).finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

/** 真正去问 Apple。网络失败与"确实没有"分开:
 *  只有后者才写负缓存 —— 断网时记一笔"没有",网络回来后 24 小时内都放不出来,
 *  那比不缓存更糟。 */
async function searchPreview(
  key: string,
  title: string,
  artist: string,
  query: string
): Promise<SongPreview | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), SEARCH_TIMEOUT_MS)
  try {
    const params = new URLSearchParams({
      term: query,
      media: 'music',
      entity: 'song',
      limit: String(SEARCH_LIMIT),
      country: SEARCH_COUNTRY
    })
    const resp = await fetch(`https://itunes.apple.com/search?${params.toString()}`, {
      signal: ctl.signal,
      headers: { Accept: 'application/json' }
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { results?: unknown } | null
    const list = Array.isArray(data?.results) ? (data.results as SongCandidate[]) : []
    const found = bestSongMatch(list, title, artist)
    if (!found) {
      /* 搜到了但都不像 = 确实没有。记 24 小时,免得反复问 */
      void putSongPreview({ key, missing: true, createdAt: Date.now() })
      return null
    }
    void putSongPreview({
      key,
      previewUrl: found.previewUrl,
      trackName: found.trackName,
      artistName: found.artistName,
      ...(found.trackViewUrl ? { trackViewUrl: found.trackViewUrl } : {}),
      createdAt: Date.now()
    })
    return found
  } catch {
    /* 断网 / 超时 / 上游挂了:这一次没有,但**不写负缓存** */
    return null
  } finally {
    clearTimeout(timer)
  }
}
