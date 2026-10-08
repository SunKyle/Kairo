/* 让角色把话说出来。两条路:
 *
 *   browser  浏览器自带的 SpeechSynthesis。免费、离线、点下去立刻出声 ——
 *            嗓音是从系统音色表里按角色稳定挑的,能听出区别,但那不是它自己的声音。
 *   tts      第三方合成(见 api.ts 的 synthesizeSpeech)。有延迟、按字符计费,
 *            换来的是"这个角色自己的嗓子"(自带音色 / 描述 / 复刻)。
 *
 * 走哪条由角色自己的 CharacterVoice.engine 决定,没配过的一律走 browser。
 * **tts 失败一定退回 browser** —— 宁可声音不对,也不要那个按钮点了没反应;
 * 退回去这件事会如实告诉用户(见 speak 的返回值)。
 *
 * 与 theme.ts 同一条规矩:**所有函数都不抛异常**。朗读失败最多是没声音,
 * 不该把点它的那个人一起弄坏。这一条在接了第三方之后更紧了 ——
 * 现在这条路上有网络、有计费、有上游的各种拒绝。
 * ------------------------------------------------------------------ */
import { ref } from 'vue'
import { synthesizeSpeech, synthesizeSpeechStream, ttsCacheKey } from '../api'
import { getTtsClip, putTtsClip } from './idb'
import type { ApiConfig, CharacterVoice } from '../types'

/** 正在朗读哪一条(消息 id)。空 = 没在说。
 *  界面靠它把那枚按钮从"朗读"换成"停止",没有第二个状态源 */
export const speakingId = ref<string | null>(null)
/** 还在等音频、没出声。与 speakingId 指向同一条 —— 界面上它画成"生成中",
 *  而这两件事的区别用户看得见:一个是"在等",一个是"在响" */
export const speakingLoading = ref(false)

function setState(msgId: string | null, loading = false) {
  speakingId.value = msgId
  speakingLoading.value = loading
}

/* ===== 浏览器那条路 ===== */

/** 这台浏览器能不能说话。不支持的就不给那个入口 ——
 *  一个点了没反应的按钮比没有更糟 */
export function speechSupported(): boolean {
  try {
    return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
  } catch {
    return false
  }
}

/* 系统音色表是**异步填进来的**:第一次 getVoices() 常常返回空数组,
   要等 voiceschanged。所以缓存一份,拿到新的就换掉 */
let voices: SpeechSynthesisVoice[] = []
let ready = false

function refreshVoices() {
  try {
    const got = window.speechSynthesis.getVoices()
    if (got.length) voices = got
  } catch {
    /* 拿不到就当作没有音色表 —— 下面会退回只报语言 */
  }
}

function ensureReady() {
  if (ready || !speechSupported()) return
  ready = true
  refreshVoices()
  try {
    // 只有我们用它,直接赋值最省事,也兼容不支持 addEventListener 的老浏览器
    window.speechSynthesis.onvoiceschanged = refreshVoices
  } catch {
    /* ignore */
  }
}

/** 预热一次音色表。
 *
 *  它存在的理由是一个真实的瑕疵:第一次 speak 时音色表很可能还没到,
 *  那次朗读会用浏览器的默认音色 —— 于是"这个角色的声音"和它之后的声音不一样。
 *  进对话页时先问一次,等用户真去点朗读(至少要到一轮回复之后),表已经在了。
 *  不抛异常,重复调用也无害。 */
export function warmUpSpeech(): void {
  ensureReady()
}

/* 角色设了"说哪种语言"时,把它折成系统音色表认的那个 lang 前缀。
   这一栏是自由文本(用户会写 "English"、"简体中文"、"en-US"),
   所以三个来源依次认:语言代码 → 它用的文字 → 常见语言名。

   认不出来一律返回空串,**退回按文本猜** —— 拿一个乱猜的语言代码去音色表里挑,
   比不挑更糟:那是"我明明设了日语,它却用英语念"的另一种形式 */
const LANG_WORDS: Array<[string, string]> = [
  ['english', 'en'],
  ['chinese', 'zh'],
  ['mandarin', 'zh'],
  ['japanese', 'ja'],
  ['korean', 'ko'],
  ['spanish', 'es'],
  ['french', 'fr'],
  ['german', 'de'],
  ['italian', 'it'],
  ['portuguese', 'pt'],
  ['russian', 'ru'],
  ['arabic', 'ar'],
  ['hindi', 'hi'],
  ['thai', 'th'],
  ['vietnamese', 'vi'],
  ['turkish', 'tr'],
  ['dutch', 'nl'],
  ['polish', 'pl'],
  ['swedish', 'sv']
]
/* 只认两字母的代码(带可选地区后缀):三字母会撞上英文常用词("the"、"you"),
   而 yue / fil 这类三字母代码在这个场景里基本不会出现 */
const LANG_CODE_RE = /^([a-z]{2})(?:[-_][a-z]{2,4})?$/
/** 不带地区时补一个常用地区 —— 只报 "en" 时有些系统挑不出音色 */
const SPEECH_LOCALES: Record<string, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  it: 'it-IT',
  pt: 'pt-BR',
  ru: 'ru-RU',
  ar: 'ar-SA'
}

/* 用汉字 / 谚文写出来的**语言名**。它们必须排在"按文字判"之前:
   用户写「日本語」是在**指一门语言**,而不是在用日语写字 ——
   而这三个字全是汉字,按文字判会认成中文。
   (这是这套判断里唯一一处真正的坑,所以它单列一张表、写在前面) */
const CJK_LANG_NAMES: Array<[string, string]> = [
  ['日本語', 'ja'],
  ['日語', 'ja'],
  ['日语', 'ja'],
  ['日文', 'ja'],
  ['中文', 'zh'],
  ['汉语', 'zh'],
  ['漢語', 'zh'],
  ['国语', 'zh'],
  ['國語', 'zh'],
  ['粤语', 'zh'],
  ['粵語', 'zh'],
  ['한국어', 'ko'],
  ['한국말', 'ko']
]

/** 角色设的语言 → 系统音色表认的 lang 前缀。导出是为了测得了 ——
 *  里面"假名先于汉字"那条顺序是这套判断里唯一容易写反的一步 */
export function langTagOf(language: string): string {
  const v = (language || '').trim().toLowerCase()
  if (!v) return ''
  const code = LANG_CODE_RE.exec(v)
  if (code) return code[1]
  /* 语言名先于"按文字判":见上面那张表的说明 */
  const named = CJK_LANG_NAMES.find(([name]) => v.includes(name))
  if (named) return named[1]
  /* 退一步:写成哪种文字就是哪种语言。**假名要先于汉字判** ——
     日文里也有汉字,反过来判的话一段日语会被认成中文 */
  if (/[\u3040-\u30ff]/.test(v)) return 'ja'
  if (/[\uac00-\ud7af]/.test(v)) return 'ko'
  if (/[\u3400-\u9fff]/.test(v)) return 'zh'
  const hit = LANG_WORDS.find(([name]) => v.includes(name))
  return hit ? hit[1] : ''
}

/** 这段该按哪种语言念。
 *
 *  先看角色自己设的语言(见 CharacterPersona.language)——
 *  它是用户明确写下的答案,不再需要猜。
 *  没设才退回原来那条二分:提示词里没有语言这一条时,角色跟着用户走,
 *  所以中英混着来,只做一个够用的判断:有汉字/假名就按中文挑。
 *  (三分成 ja / ko 也只在这条兜底路上才谈得上,而那时手里只有文本) */
function langOf(text: string, language?: string): string {
  const set = langTagOf(language || '')
  if (set) return set
  return /[\u3400-\u9fff\u3040-\u30ff]/.test(text) ? 'zh' : 'en'
}

/** 稳定的哈希。同一个角色每次都该挑到同一把嗓子 ——
 *  用随机数的话,同一个人每句话换一个声音 */
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** 在 0.90~1.07 之间给这个角色取一个语速 / 音高。
 *  范围刻意收窄:再放开就开始像卡通配音或者机械音,
 *  而这里要的是"同一个人,略有不同",不是"不同的机器人" */
function nudge(charId: string, salt: string): number {
  return 0.9 + (hash(charId + salt) % 18) / 100
}

/* ===== 情绪落到语调上 ================================================
   情绪已经有自己的出口了(见 server/chatTags.js 的 `[mood:…]`),但**那是给眼睛的**。
   同一句话换个语调念出来,像不像那个人差别很大 —— 而这是全站唯一一处
   "情绪可以不花钱地影响表达"的地方(浏览器自带语音:零成本、离线)。

   三条纪律:
   1. **振幅要小**。rate 一档 ±0.06、pitch ±0.08 —— 再放大就开始像卡通配音,
      与上面那条 0.90~1.07 的边界同一条理由:它是"同一把嗓子换了个心情",
      不是换了一个人;
   2. **认不出就不动**。情绪词是模型自由写的(刻意没有枚举表,见 chatTags 的设计),
      所以这张表注定覆盖不全 —— 覆盖不到就保持原样,**绝不猜**。
      而且**用整词匹配、不做子串**:`unamused` 里含 `amused`,两者正好相反;
   3. **只作用于浏览器那条路**。第三方合成的音色是角色**身份**的一部分,
      跟着情绪改音高等于换了个人(见 speak())。 */
const MOOD_TONE: Record<string, { rate: number; pitch: number }> = {
  /* 低落、疲惫:慢一点、低一点 */
  tired: { rate: -0.06, pitch: -0.05 },
  sad: { rate: -0.06, pitch: -0.06 },
  bored: { rate: -0.05, pitch: -0.03 },
  cold: { rate: -0.03, pitch: -0.05 },
  flat: { rate: -0.04, pitch: -0.03 },
  /* 温和、亲近:略慢、略高 */
  warm: { rate: -0.02, pitch: 0.04 },
  soft: { rate: -0.03, pitch: 0.03 },
  fond: { rate: -0.02, pitch: 0.05 },
  gentle: { rate: -0.03, pitch: 0.04 },
  /* 高兴、兴奋:快一点、高一点 */
  amused: { rate: 0.05, pitch: 0.07 },
  delighted: { rate: 0.05, pitch: 0.08 },
  excited: { rate: 0.06, pitch: 0.08 },
  happy: { rate: 0.04, pitch: 0.06 },
  playful: { rate: 0.05, pitch: 0.06 },
  /* 绷着、提防:略快、略低 */
  angry: { rate: 0.05, pitch: -0.06 },
  annoyed: { rate: 0.04, pitch: -0.05 },
  wary: { rate: 0.03, pitch: -0.02 },
  uneasy: { rate: 0.03, pitch: -0.03 },
  tense: { rate: 0.04, pitch: -0.04 },
  /* 端着:慢一点、低一点 */
  proud: { rate: -0.02, pitch: -0.02 },
  arrogant: { rate: -0.03, pitch: -0.03 },
  smug: { rate: -0.02, pitch: -0.04 }
}

/** 语调的安全区。用户自己配过 rate/pitch 时叠加可能越界,夹回来 */
const TONE_MIN = 0.5
const TONE_MAX = 1.5
const clampTone = (n: number) => Math.min(TONE_MAX, Math.max(TONE_MIN, n))

/** 把情绪叠到既有的语速/音高上。认不出、或压根没给情绪,原样返回 */
export function toneWithMood(
  rate: number,
  pitch: number,
  mood?: string
): { rate: number; pitch: number } {
  const t = MOOD_TONE[String(mood || '').trim().toLowerCase()]
  if (!t) return { rate, pitch }
  return { rate: clampTone(rate + t.rate), pitch: clampTone(pitch + t.pitch) }
}

function pickVoice(
  charId: string,
  text: string,
  want?: string,
  language?: string
): SpeechSynthesisVoice | undefined {
  if (!voices.length) return undefined
  /* 用户点名要了哪一把就用哪一把 —— 这时不掺任何哈希,
     否则"我明明选了这个人"和听到的会对不上 */
  if (want) {
    const named = voices.find((v) => v.name === want)
    if (named) return named
  }
  const lang = langOf(text, language)
  /* 先在同语言的音色里挑;一个都没有就用全部 ——
     口音不对也总比一声不吭强 */
  const same = voices.filter((v) => (v.lang || '').toLowerCase().startsWith(lang))
  const pool = same.length ? same : voices
  return pool[hash(charId) % pool.length]
}

/** 浏览器那一条。返回一个 promise,念完(或被停)才 resolve */
function speakInBrowser(
  text: string,
  charId: string,
  msgId: string,
  voice?: CharacterVoice,
  language?: string,
  mood?: string
) {
  return new Promise<void>((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text)
      const v = pickVoice(charId, text, voice?.voiceName, language)
      if (v) {
        u.voice = v
        u.lang = v.lang
      } else {
        /* 音色表还没到(第一次朗读常常如此):至少把语言报对,
           让浏览器自己挑一个匹配的嗓子 */
        const tag = langOf(text, language)
        u.lang = SPEECH_LOCALES[tag] || tag
      }
      /* 语速与音高先取"这个角色的基线"(用户配过的优先,否则按 id 哈希),
         再叠一层这一条的情绪。叠完夹回安全区 —— 用户自己把 rate 调到 1.4
         的时候,一个 +0.08 的情绪不该把它推到浏览器不认的地方 */
      const tone = toneWithMood(
        typeof voice?.rate === 'number' ? voice.rate : nudge(charId, 'rate'),
        typeof voice?.pitch === 'number' ? voice.pitch : nudge(charId, 'pitch'),
        mood
      )
      u.rate = tone.rate
      u.pitch = tone.pitch
      /* 收尾要把状态收回来。onerror 也得收 ——
         浏览器在念不出来时(没有可用音色、被策略拦下)会直接报错,
         不收的话那枚按钮就永远停在"停止"上了 */
      const done = () => {
        if (speakingId.value === msgId) setState(null)
        resolve()
      }
      u.onend = done
      u.onerror = done
      setState(msgId)
      window.speechSynthesis.speak(u)
    } catch {
      setState(null)
      resolve()
    }
  })
}

/* ===== 第三方合成那条路 ===== */

/* 当前那次朗读的"代次"。停掉、或者又点了另一条,号就变了 ——
   一个还在飞的请求回来时据此判断"这次还算不算数"。
   没有它的话,按下停止之后音频照样会冒出来 */
let run = 0
let aborter: AbortController | null = null
let audioEl: HTMLAudioElement | null = null
let audioUrl = ''

/** 把一段音频放出来。返回的 promise 在放完(或被停)时 resolve */
function playBlob(blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    try {
      audioUrl = URL.createObjectURL(blob)
      const el = new Audio(audioUrl)
      audioEl = el
      const done = () => {
        releaseAudio()
        resolve()
      }
      el.onended = done
      el.onerror = done
      /* 自动播放策略:这里一定处在用户的手势里(点那枚喇叭),
         所以 play() 不会被拦。真被拦了就当作放完了,不弹错 */
      el.play().catch(done)
    } catch {
      releaseAudio()
      resolve()
    }
  })
}

function releaseAudio() {
  if (audioEl) {
    try {
      audioEl.pause()
      audioEl.src = ''
    } catch {
      /* ignore */
    }
    audioEl = null
  }
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl)
    audioUrl = ''
  }
}

/* ===== 边收边播 =====
 *
 * 服务端那条链路本来就是流式的(逐帧转发上游的音频块),但前端一直
 * `await resp.blob()` —— 等整段收完才交给 <audio>,等于把"流式"这件事白丢了:
 * 一句三秒的话要等满三秒才出声,而第一块音频其实几百毫秒就到了。
 *
 * 这里改用 MediaSource 边收边喂。两个前提:
 *   1. 只喂 mp3 —— 服务端统一按 audio/mpeg 报(见 server 的 pipeTtsAudio);
 *   2. 浏览器得支持 mp3 的 MSE。Chrome / Edge 支持,**Safari 不支持**,
 *      那边自动落回"整段收完再播"的老路(见 streamSupported)。
 *
 * 边喂边攒:收完仍然拿到一份完整的 Blob,缓存照旧写得进去 ——
 * 下一次点同一句就走缓存,不必再买第二次。
 * ------------------------------------------------------------------ */
function streamSupported(): boolean {
  try {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg')
  } catch {
    /* 有些浏览器把 MediaSource 放在 window 上但语义不同,取值就抛 —— 一律当不支持 */
    return false
  }
}

/** 把响应边收边播。返回攒下来的完整音频;中断、或播不出来时返回 null */
function playStream(resp: Response, isCurrent: () => boolean): Promise<Blob | null> {
  return new Promise((resolve) => {
    const body = resp.body
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    const parts: BlobPart[] = []
    let settled = false

    const settle = (out: Blob | null) => {
      if (settled) return
      settled = true
      try {
        void reader?.cancel()
      } catch {
        /* ignore */
      }
      releaseAudio()
      resolve(out)
    }

    if (!body || !isCurrent()) {
      settle(null)
      return
    }

    const ms = new MediaSource()
    const url = URL.createObjectURL(ms)
    const el = new Audio(url)
    audioEl = el
    audioUrl = url

    /* 喂块是一条**串行的链**:MSE 一次只接受一块,前一块没吃完就 append 会抛。
       用一条 promise 链把它们排好,而不是自己数 buffered 的区间 */
    let feed: Promise<void> = Promise.resolve()
    const append = (chunk: Uint8Array) => {
      feed = feed.then(
        () =>
          new Promise<void>((ok) => {
            const sb = ms.sourceBuffers[0]
            if (settled || !sb || ms.readyState !== 'open') {
              ok()
              return
            }
            try {
              sb.addEventListener('updateend', () => ok(), { once: true })
              // SourceBuffer 会一直持有这块内存,先拷一份再交出去
              sb.appendBuffer(chunk.slice())
            } catch {
              ok()
            }
          })
      )
    }

    ms.addEventListener('sourceopen', () => {
      try {
        ms.addSourceBuffer('audio/mpeg')
      } catch {
        settle(null)
        return
      }
      /* 先按下去:此刻一帧数据都还没有,但 play() 会等着 —— 第一块到达时自动出声,
         而不是等整段收完才播(那正是要修的那件事)。
         自动播放策略不会拦这里:我们一定处在用户点喇叭的那次手势里 */
      el.play().catch(() => settle(null))

      void (async () => {
        reader = body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (settled) return
            if (done) break
            if (!value || !value.length) continue
            // 拷一份再攒:reader 给的那块内存不保证一直有效(也顺手统一了类型)
            parts.push(new Uint8Array(value))
            append(value)
          }
          await feed
          if (!settled && ms.readyState === 'open') ms.endOfStream()
        } catch {
          /* 用户按了停止(请求被掐)或上游断流 —— 都当作"没播成",不弹错 */
          settle(null)
        }
      })()
    })

    el.addEventListener('ended', () => {
      settle(parts.length ? new Blob(parts, { type: 'audio/mpeg' }) : null)
    })
    el.addEventListener('error', () => settle(null))
  })
}

/* ===== 对外 ===== */

/** 念一段。**一次只说一句** —— 新的压掉旧的:连点两条消息时,
 *  不掐掉上一条就是两把嗓子一起说话 */
export interface SpeakTarget {
  charId: string
  /** 这个角色的嗓音。没有 = 走浏览器 */
  voice?: CharacterVoice
  /* 这个角色说哪种语言(见 CharacterPersona.language)。
     空/缺省 = 跟着文本猜,与加这一栏之前的行为一致。
     它只影响**浏览器那条路**挑哪把嗓子 —— 自带音色的第三方合成由音色本身决定 */
  language?: string
  /** 走 tts 时用的那条配置。engine 是 tts 而它缺了,就直接走浏览器 */
  cfg?: ApiConfig
  /* 这一条消息的情绪(见 chatTags 的 `[mood:…]`)。**只影响浏览器那条路**:
     第三方合成的音色是角色身份的一部分,跟着情绪改音高等于换了个人 */
  mood?: string
}

/**
 * 念一条消息。resolved 的字符串是"要告诉用户的一句话" ——
 * 空串表示没什么可说的(正常念完了)。
 *
 * 把这句话**返回**而不是在这里弹提示:lib 层没有通知通道,
 * 而"退回了浏览器声音"这件事必须让用户知道 ——
 * 否则他会以为自己的音色配置根本没生效。
 */
export async function speak(text: string, target: SpeakTarget, msgId: string): Promise<string> {
  const body = text.trim()
  if (!body) return ''
  const v = target.voice
  const wantsTts = v?.engine === 'tts'

  stopSpeaking()
  const mine = ++run

  if (!wantsTts || !target.cfg) {
    /* 没配 tts,或配了却没给它配置:走浏览器。
       这里**不提醒** —— 用户本来就没打算用第三方 */
    await speakInBrowser(body, target.charId, msgId, v, target.language, target.mood)
    return ''
  }

  setState(msgId, true)
  try {
    const cfg = target.cfg
    const key = ttsCacheKey(cfg, v, body)
    const cached = await getTtsClip(key)
    if (cached) {
      if (mine !== run) return ''
      setState(msgId)
      await playBlob(cached)
      return ''
    }

    aborter = new AbortController()
    /* 支持 MSE 的那一边(Chrome / Edge):边收边播 —— 第一块音频到了就出声。
       它同时把整段攒下来,所以缓存这条规矩不受影响 */
    if (streamSupported()) {
      const resp = await synthesizeSpeechStream(cfg, v, body, aborter.signal)
      if (mine !== run) return ''
      setState(msgId)
      const whole = await playStream(resp, () => mine === run)
      if (whole) void putTtsClip(key, whole)
      return ''
    }

    /* 不支持的那一边(Safari):整段收完再交给 <audio> —— 慢一截,但一定能出声 */
    const blob = await synthesizeSpeech(cfg, v, body, aborter.signal)
    if (mine !== run) return ''
    setState(msgId)
    /* 存下来。"再听一遍"是这个功能里最自然的动作,而它按字符计费 ——
       不缓存的话,同一句话会被反复买第二遍 */
    void putTtsClip(key, blob)
    await playBlob(blob)
    return ''
  } catch (e) {
    if (mine !== run) return ''
    /* 失败了就退回浏览器:**说错话也要比没声音强**。但必须说一句,
       否则用户会以为音色配置生效了,只是"听起来不对" */
    const why = e instanceof Error ? e.message : 'the request failed'
    setState(null)
    await speakInBrowser(body, target.charId, msgId, v, target.language)
    return `Using the browser voice — ${why}`
  } finally {
    aborter = null
  }
}

/** 住口。浏览器那条取消的是**整条队列**(队列里全是这里排进去的),
 *  第三方那条要掐两样:还在飞的请求,和已经在放的音频 ——
 *  用户按下停止的意思是"别念了",不管是哪种"还没念完" */
export function stopSpeaking(): void {
  run++
  if (speechSupported()) {
    try {
      window.speechSynthesis.cancel()
    } catch {
      /* ignore */
    }
  }
  if (aborter) {
    try {
      aborter.abort()
    } catch {
      /* ignore */
    }
    aborter = null
  }
  releaseAudio()
  setState(null)
}
