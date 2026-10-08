import type { ApiConfig, GenParams, HistoryEntry, PromptItem, ResultItem, ReuseParams, Collection, Character, CharacterDraft, CharacterFields, CharacterPersona, CharacterView, CharacterViewKind, CharacterVoice, ChatMessage, ImportedCharacter, ImportedChat, ImportedChatMessage } from './types'
import type { PruneResult, CoverRecord, CharRefRecord } from './lib/idb'
import { titleFromPrompt } from './lib/text'
/* 角色设定那一份权威定义(键 / 顺序 / 标签 / 必填 / 枚举)住在服务端 ——
   那边拼起稿提示词用的就是它。前端在这里取用它的读法,
   于是"提示词里那几行"与"解析回填的那张表"不可能各走各的 */
import {
  CHAR_SPEC_LINES,
  charSpecKeys
} from '../server/charSpec.js'
/* "现在几点"也是服务端那套提示词的一部分,而它要的**本地时刻**只有前端给得出
   (见 server/chatTime.js)。这里只负责生成那个字符串,措辞全在那边 */
import { localStamp } from '../server/chatTime.js'
/* 对话里的场景串有多长,权威定义在服务端那一层(剪标签时就是按它截的)。
   导入校验这里从前另写了一个数 —— 2026-10-04 把上限从 120 提到 400 时漏改了
   这一处,于是**导进来的对话"重画这一张"会拿到一句被砍掉尾巴的场景**,
   而且不报错。上限只该有一个出处 */
import { PHOTO_SCENE_CHARS } from '../server/chatTags.js'
import {
  getAll,
  pruneHistory,
  putOne,
  deleteOne,
  urlToBlob,
  base64ToBlob,
  detectMimeFromDataUrl,
  getAllCovers,
  putCovers,
  getAllCharRefs,
  putCharRefs,
  charSourceKey,
  ensurePersisted
} from './lib/idb'

/* 厂商能力表与参数规格表搬去了 lib/providers.ts(见下面那处 export *)。
   `export *` 只负责转发,**不会**把名字带进本文件的词法作用域 ——
   而本文件后面几处仍然直接调用它们,所以还得显式引一份 */
import {
  getProvider,
  inferVendor,
  providerBodyFields,
  sizeFieldFor,
  vendorOf
} from './lib/providers'

export const CONFIG_KEY = 'kimage.apiConfigs'
export const CONFIG_ACTIVE_KEY = 'kimage.apiActive'
// 「当前生效的文本配置」记录的 id:文本类别也有自己的当前项,与出图那条各自独立
export const TEXT_ACTIVE_KEY = 'kimage.apiActiveText'
/* 「当前生效的对话配置」记录的 id。角色对话有自己的模型 —— 它和提示词改写
   要填的东西长得一样(都是一个对话模型),但**用途不同、该分开记**:
   改写的模型按"哪家出的图更好看"挑,对话的模型按"聊起来像不像个人"挑,
   把两者绑在一块等于让任一边的选择迁就另一边 */
export const CHAT_ACTIVE_KEY = 'kimage.apiActiveChat'
// 「当前生效的识图配置」记录的 id:识图同样是独立的一类
export const VISION_ACTIVE_KEY = 'kimage.apiActiveVision'
// 「当前生效的朗读配置」记录的 id:朗读也是独立的一类(它连协议都不是 OpenAI 兼容那套)
export const TTS_ACTIVE_KEY = 'kimage.apiActiveTts'

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/* ===== 厂商能力表与参数规格表 =====
   集中声明各厂商能力、协议、尺寸候选及扩展参数规范已抽离至 lib/providers.ts */
export * from './lib/providers'

// 读取全部接口配置列表
export function loadConfigs(): ApiConfig[] {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return (arr as ApiConfig[]).map(normalizeConfig)
    }
  } catch {
    /* ignore */
  }
  // 兼容旧的单份配置格式
  try {
    const LEGACY_KEY = 'kimage.apiConfig'
    const raw = localStorage.getItem(LEGACY_KEY)
    if (raw) {
      const c = JSON.parse(raw)
      const list: ApiConfig[] = [normalizeConfig({ id: uid(), name: 'Default config', ...c })]
      saveConfigs(list)
      /* 搬完就把旧键删掉:新键已经写好,它留着没有用,而里面带着 API Key ——
         "一份密钥在这个站点上存了两处"不该是长期状态。
         删除单独兜一层:它失败不该把这次迁移一起判死,否则好不容易读出来的配置会丢 */
      try {
        localStorage.removeItem(LEGACY_KEY)
      } catch {
        /* 读得到就删得掉,这里只是不把删除失败升级成"配置也读不出来" */
      }
      return list
    }
  } catch {
    /* ignore */
  }
  return []
}

/* 补齐加字段之前存下来的配置缺的字段:
   - vendor:没有就按域名猜;
   - kind:没有(或读到别的值)一律当 'image' —— 加这个字段之前存的都是出图配置,
     而且外部脏数据不该让这条配置错类或消失 */
function normalizeConfig(c: ApiConfig): ApiConfig {
  return {
    ...c,
    /* 三项技术值都剪掉首尾空白:它们在手机键盘上很容易被带上一截空格或换行,
       而肉眼看不出来 —— 表现只是"这个 key 明明是对的,却报 401"。
       读入口剪一次,已经存坏的那几条也会自己好 */
    baseUrl: (c.baseUrl || '').trim(),
    apiKey: (c.apiKey || '').trim(),
    model: (c.model || '').trim(),
    vendor: c.vendor || inferVendor(c.baseUrl),
    kind: asConfigKind(c.kind)
  }
}

export function saveConfigs(list: ApiConfig[]) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(list))
  } catch {
    /* 存储满或无痕模式受限时吞掉异常,避免阻塞主流程 */
  }
}

/* ===== 按用途挑「当前生效」的那条 ====================================
   五类用途(出图/改写/对话/识图/朗读)共用同一个配置列表,但各自记一个当前值。
   挑选规则只有一条,抽在这里是因为主界面有六处要用它:启动时挑一遍,
   删掉一条、改了用途、以及另一个标签页动了配置之后都要重挑 ——
   六处各写一份 find 迟早会写歪(事实上已经写歪过:出图那条用的是
   `kind !== 'text'`,于是"只配了一条朗读配置"时,朗读那条会被当成出图配置)。
   ------------------------------------------------------------------ */

/** 配置的用途。normalizeConfig 保证这个字段一定有值,缺省是 image */
export type ConfigKind = NonNullable<ApiConfig['kind']>

/* 认得出的用途。这张表就是白名单 —— 五种以外的一律按出图算
   (加 kind 之前存下来的都是出图配置,而外部文件里的脏数据不该让配置错类)。
   用途从四处长到五处之后,原来那串嵌套三元已经要数着缩进读,收成一处:
   读入口(normalizeConfig)与导入入口(importConfigs)走同一个判断 */
const KNOWN_KINDS = ['image', 'text', 'chat', 'vision', 'tts'] as const

export function asConfigKind(v: unknown): ConfigKind {
  return KNOWN_KINDS.includes(v as ConfigKind) ? (v as ConfigKind) : 'image'
}

export function configKindOf(c: ApiConfig): ConfigKind {
  return c.kind ?? 'image'
}

/**
 * 挑出某一类里「当前生效」的那条:
 * - 先认存着的 id,但要求它**用途仍然是这一类** —— 用户可能已经把它改成别的用途了;
 * - 对不上就退到这一类里的第一条(只有一条时这是显然的选择,比空着好);
 * - 这一类一条都没有则返回 undefined(调用方自行决定是清空还是提示"去配一条")。
 */
export function pickActiveByKind(
  list: ApiConfig[],
  kind: ConfigKind,
  savedId: string
): ApiConfig | undefined {
  return (
    list.find((c) => c.id === savedId && configKindOf(c) === kind) ??
    list.find((c) => configKindOf(c) === kind)
  )
}

export function loadActiveId(): string {
  try {
    return localStorage.getItem(CONFIG_ACTIVE_KEY) || ''
  } catch {
    return ''
  }
}

export function saveActiveId(id: string) {
  try {
    localStorage.setItem(CONFIG_ACTIVE_KEY, id)
  } catch {
    /* ignore */
  }
}

// 文本类别的当前生效配置 id:与出图那条互不影响,两条各存各的
export function loadActiveTextId(): string {
  try {
    return localStorage.getItem(TEXT_ACTIVE_KEY) || ''
  } catch {
    return ''
  }
}

export function saveActiveTextId(id: string) {
  try {
    localStorage.setItem(TEXT_ACTIVE_KEY, id)
  } catch {
    /* ignore */
  }
}

/* 对话类别的当前生效配置 id。**它可能一直是空串** —— 没有单独配一条对话模型时,
   角色对话会借用改写那条(见 composables/useConfigs.ts 的 chatConfig),
   所以空着不是"没配",只是"还没分开" */
export function loadActiveChatId(): string {
  try {
    return localStorage.getItem(CHAT_ACTIVE_KEY) || ''
  } catch {
    return ''
  }
}

export function saveActiveChatId(id: string) {
  try {
    localStorage.setItem(CHAT_ACTIVE_KEY, id)
  } catch {
    /* ignore */
  }
}

// 识图类别的当前生效配置 id:各记各的,配一条识图不该顶掉出图或改写
export function loadActiveVisionId(): string {
  try {
    return localStorage.getItem(VISION_ACTIVE_KEY) || ''
  } catch {
    return ''
  }
}

export function saveActiveVisionId(id: string) {
  try {
    localStorage.setItem(VISION_ACTIVE_KEY, id)
  } catch {
    /* ignore */
  }
}

// 朗读类别的当前生效配置 id:与上面三条互不影响
export function loadActiveTtsId(): string {
  try {
    return localStorage.getItem(TTS_ACTIVE_KEY) || ''
  } catch {
    return ''
  }
}

export function saveActiveTtsId(id: string) {
  try {
    localStorage.setItem(TTS_ACTIVE_KEY, id)
  } catch {
    /* ignore */
  }
}

/* ===== 朗读(语音合成) =================================================
   与前面几类不同:这条路上游给的**不是** JSON,而是音频字节。
   所以这一块只有两件事要办 —— 拼请求、把回来的字节包成 Blob。
   选哪条路(浏览器自带的还是这里)、缓存、播放全在 lib/speech.ts。
   ------------------------------------------------------------------ */

/* 火山的 Resource ID 其实是**两个维度**拧在一起的东西:
 *   代际  1.0 / 2.0          —— 音色列表按它分成两份,两边的音色不能互换
 *   商品  语音合成 / 声音复刻  —— 两个分开卖,而且各自要单独开通
 *
 * 关键在于:**商品这一维由档位就决定了**。内置音色必然走语音合成、复刻音色必然
 * 走声音复刻,没有第三种可能。所以真正需要用户选的只有代际。
 *
 * 于是配置里存的是代际("2.0" / "1.0"),完整的 X-Api-Resource-Id 在 resourceIdOf
 * 里拼出来。以前这里让用户直接挑商品,界面上摆着四个选项 —— 而 Clone 档根本不读它,
 * 于是同一格里塞了两件事,互相污染过两次(拿复刻商品去要一把内置音色)。
 * 老配置里存的是完整 ID,ttsGenerationOf 认得出来,不必迁移。 */
export const TTS_GENERATIONS = [
  { id: '2.0', label: '2.0 — seed-tts-2.0 / seed-icl-2.0' },
  { id: '1.0', label: '1.0 — seed-tts-1.0 / seed-icl-1.0' }
]

/** 把配置里那个值归一成代际。空 = 2.0(当下的默认);
 *  老配置留下的完整 ID(seed-tts-1.0、seed-icl-2.0 之类)也在这里一并认出来 */
export function ttsGenerationOf(rid?: string): string {
  const v = (rid || '').trim()
  return v.includes('1.0') ? '1.0' : '2.0'
}

/** 复刻音色的"版本风味"。**只有这两个取值**(见上游错误码文档里的 InvalidModel 一条):
 *  model 这个字段只对复刻 2.0 生效,而它的枚举就是这两个。
 *
 *  以前这里是一个自由输入框,于是"照 Resource ID 填成 seed-tts-2.0"这种写法
 *  完全可能 —— 上游只回一句 [Invalid argument] InvalidModel,既不说是哪个字段,
 *  也不说合法值是什么。干脆改成点选,空串 = 交给上游默认(standard) */
export const TTS_MODELS = [
  { id: '', label: 'Auto' },
  { id: 'seed-tts-2.0-standard', label: 'Standard' },
  { id: 'seed-tts-2.0-expressive', label: 'Expressive' }
]

/* 试听用的固定短句。**固定是有意的**:用户每改一次音色描述都会点一次试听,
   而试听走的是真请求。同一句话配同一个音色在缓存里必然命中,第二次起不花钱。
   中文那半句用全角标点:半角逗号/问号给到的停顿比全角短,试听句本身就不该
   带着这个毛病(合成前另有一道规整,见 server 的 tidyForSpeech) */
export const TTS_AUDITION_TEXT = 'Hey, it is me. 你好，能听见我说话吗？'

/** 合成请求里那个"音色"的形状。与 CharacterVoice 分开是因为
 *  服务端只认这几个字段,不该把 browser 档那些也发过去 */
function voicePayloadOf(v: CharacterVoice) {
  return {
    source: v.source || 'preset',
    vendorVoice: v.vendorVoice || '',
    describe: v.describe || '',
    speed: typeof v.speed === 'number' ? v.speed : 0
  }
}

/** 拼出真正的 X-Api-Resource-Id。
 *
 *  "哪个商品"由档位决定(内置 → 语音合成,复刻 → 声音复刻),
 *  "哪一代"由配置里那个代际决定 —— 两者一乘就是那个字符串。
 *  用户不必知道它的存在,更不必拿音色去和它对照 —— 之前两次
 *  "resource ID is mismatched with speaker" 都是这么来的。
 *
 *  **描述那一档不发它**:它走的是"音频生成"那条端点,文档里没有这个头 ——
 *  一个用不上的头,最好的结果是被忽略,最坏的结果是被拒 */
function resourceIdOf(cfg: ApiConfig, v: CharacterVoice): string {
  if (v.source === 'describe') return ''
  const family = v.source === 'clone' ? 'seed-icl' : 'seed-tts'
  /* 每角色那个覆盖值优先,但它同样得是**完整形态**。这里原来是
     `if (v.resourceId) return v.resourceId` —— 原样透出,于是配置里存成
     "2.0" 这种裸代际时会被整份发出去,上游回一句
     `[resource_id=2.0] requested resource not granted`,读起来像"没开通",
     实则只是我们发了个半成品(实测踩过)。现在统一下去:
     不带 seed- 前缀的一律按"族 + 代际"补齐。
     服务端另有一道一样的兜底(见 normalizeResourceId),两边都补。 */
  const rid = (v.resourceId || cfg.resourceId || '').trim()
  return rid.startsWith('seed-') ? rid : `${family}-${ttsGenerationOf(rid)}`
}

/** 合成请求的 body。两个入口共用 —— 它们只差"谁来读响应" */
function ttsRequestBody(cfg: ApiConfig, v: CharacterVoice, text: string): string {
  return JSON.stringify({
    text,
    voice: voicePayloadOf(v),
    // 复刻 2.0 认这个字段来选标准版/表现力版,其余型号带上会被忽略
    model: cfg.model || '',
    resourceId: resourceIdOf(cfg, v),
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey
  })
}

/** 把一句话合成成音频。返回的是可以直接喂给 <audio> 的 Blob */
export async function synthesizeSpeech(
  cfg: ApiConfig,
  v: CharacterVoice,
  text: string,
  signal?: AbortSignal
): Promise<Blob> {
  const resp = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: ttsRequestBody(cfg, v, text)
  })
  if (!resp.ok) throw new Error(await failureMessage(resp))
  const blob = await resp.blob()
  if (!blob.size) throw new Error('The TTS service returned no audio')
  return blob
}

/** 同一条请求,但**不读响应体** —— 交回去让调用方边收边播(见 speech.ts)。
 *
 *  分成两个函数而不是把 synthesizeSpeech 的返回类型改宽:缓存命中的那条路
 *  仍然只想要一个 Blob,不该被卷进流式那套里。
 *
 *  注意服务端的头是**推迟到第一帧音频才写**的(见 server 的 pipeTtsAudio),
 *  所以这个 fetch 会一直悬到上游真的吐出第一个音频块 ——
 *  失败(鉴权、未开通、资源不匹配)因此仍能当普通错误抛出来,不会变成"空音频" */
export async function synthesizeSpeechStream(
  cfg: ApiConfig,
  v: CharacterVoice,
  text: string,
  signal?: AbortSignal
): Promise<Response> {
  const resp = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: ttsRequestBody(cfg, v, text)
  })
  if (!resp.ok) throw new Error(await failureMessage(resp))
  if (!resp.body) throw new Error('The TTS service returned no audio')
  return resp
}

/** 缓存键。**必须同时含文本与音色指纹** —— 少了文本,同一角色的两句话会互相命中;
 *  少了指纹,改了描述之后还会拿到旧描述合成的音频,而用户以为改动没生效 */
export function ttsCacheKey(cfg: ApiConfig, v: CharacterVoice, text: string): string {
  const print = [
    cfg.baseUrl,
    cfg.model || '',
    resourceIdOf(cfg, v),
    v.source || 'preset',
    v.vendorVoice || '',
    v.describe || '',
    typeof v.speed === 'number' ? v.speed : 0
  ].join('\u0001')
  return `${print}\u0002${text}`
}

/** 上传一段样本换一个可反复用的音色代号。
 *  代号由我们取名(上游那条 custom_speaker_id 的路),所以返回值里那个 id
 *  是本地算出来的,不依赖上游的响应形状 */
export async function cloneVoice(
  cfg: ApiConfig,
  sampleDataUrl: string,
  customId: string,
  name: string
): Promise<{ vendorVoice: string; bytes: number }> {
  const resp = await fetch('/api/voice/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sample: sampleDataUrl,
      name,
      customId,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey
    })
  })
  if (!resp.ok) throw new Error(await failureMessage(resp))
  const data = (await resp.json()) as { vendorVoice?: string; bytes?: number }
  if (typeof data.vendorVoice !== 'string' || !data.vendorVoice) {
    throw new Error('The cloning service did not return a voice id')
  }
  return { vendorVoice: data.vendorVoice, bytes: typeof data.bytes === 'number' ? data.bytes : 0 }
}

/** 克隆代号的格式要求(上游会拦):8~256 字符、只能数字字母与 - _、
 *  必须以字母开头、结尾不能是 - 或 _,也不能撞官方前缀。
 *  前缀用 kimage_ 天然满足全部条件 —— 它不是两个字母加下划线,
 *  也不会撞上 S_ / ICL_ / BV / moon_ 那一串官方保留名 */
export function newVoiceId(): string {
  const tail = Math.random().toString(36).slice(2, 10)
  return `kimage_${tail}`
}

/** 空嗓音。新建角色、以及给老角色补一份时都用它 ——
 *  默认走浏览器自带的语音:免费、立刻出声,用户没要求之前不该先花钱 */
export function emptyCharVoice(): CharacterVoice {
  return { engine: 'browser' }
}

/** 从盘上读回来的嗓音。外部文件、老数据都可能形状不对,
 *  所以逐项收一遍 —— 认不出的字段丢掉,engine 认不出就退回 browser */
export function coerceCharVoice(raw: unknown): CharacterVoice | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined)
  const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : undefined)
  const source =
    o.source === 'describe' || o.source === 'clone' || o.source === 'preset' ? o.source : undefined
  const out: CharacterVoice = {
    engine: o.engine === 'tts' ? 'tts' : 'browser',
    ...(str('voiceName') ? { voiceName: str('voiceName') } : {}),
    ...(num('rate') !== undefined ? { rate: num('rate') } : {}),
    ...(num('pitch') !== undefined ? { pitch: num('pitch') } : {}),
    ...(str('configId') ? { configId: str('configId') } : {}),
    ...(source ? { source } : {}),
    ...(str('vendorVoice') ? { vendorVoice: str('vendorVoice') } : {}),
    ...(str('describe') ? { describe: str('describe') } : {}),
    ...(str('sampleId') ? { sampleId: str('sampleId') } : {}),
    ...(str('sampleName') ? { sampleName: str('sampleName') } : {}),
    ...(num('speed') !== undefined ? { speed: num('speed') } : {}),
    ...(str('resourceId') ? { resourceId: str('resourceId') } : {})
  }
  return out
}

/** 连通性测试的判决。判断在服务端做(只有它知道怎么打上游),文案在这里拼 */
export interface TestResult {
  ok: boolean
  /** auth=密钥被拒 endpoint=没有这个端点 server=上游自己出错 network/timeout=没连上 */
  code?: 'auth' | 'endpoint' | 'server' | 'network' | 'timeout'
  /** models=走的是 GET /models(顺带查了模型在不在)，probe=那家没有 /models，退回探测 */
  via?: 'models' | 'probe'
  /** 只在 via='models' 且有模型清单时有值：目标模型在不在清单里 */
  modelListed?: boolean | null
  status: number | null
  ms: number
  detail?: string
}

/* 测这条配置通不通。发的是真实端点上的一个空请求:上游会因缺参数回 400,
   而 400 恰好证明地址、路径与密钥这条链是通的(见 server 的 /api/test)。
   它不会真的生成图,所以点几次都不花钱 */
export async function testConnection(config: ApiConfig): Promise<TestResult> {
  try {
    const resp = await fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        protocol: getProvider(config.vendor || inferVendor(config.baseUrl), config.model).protocol,
        /* 探活要打真实端点:出图打 /images/generations,改写 / 对话 / 识图都是对话模型,
           探 /chat/completions(识图那类也走它,只是消息里多带一张图)。
           所以只有出图那一直走图像端点,其余一律按对话探 */
        kind: configKindOf(config) === 'image' ? 'image' : 'text'
      })
    })
    const data = await resp.json().catch(() => null)
    // 地址本身没通过校验这类情况,后端会以 400 + error 回,不是网络故障
    if (!resp.ok) {
      return {
        ok: false,
        code: 'network',
        status: resp.status,
        ms: 0,
        detail: data?.error || `Test failed (${resp.status})`
      }
    }
    return data as TestResult
  } catch (e) {
    return {
      ok: false,
      code: 'network',
      status: null,
      ms: 0,
      detail: e instanceof Error ? e.message : 'Request failed'
    }
  }
}

/**
 * 把非 2xx 响应摊成一句能读的报错。后端自己的错误一律是
 * { error, detail } 形状的 JSON,拿不到 JSON 就说明这段响应不是后端发的 ——
 * 开发环境里最常见的就是 vite 代理连不上 3000 端口上的后端
 * (这时它回一个空体的 500),原样的 "Request failed (500)" 只会让人
 * 往模型或上游那边找原因,所以这里补一句指路。
 */
async function failureMessage(resp: Response): Promise<string> {
  let msg = `Request failed (${resp.status})`
  /* 先整段读出来再判:响应不是 JSON 时下面还要看它像不像一页 HTML，
     而 body 只能读一次，所以用 clone 留一份 —— 调用方不会再读它，
     但留一份不花什么代价，将来有人在报错之后还想读 body 也不会踩空 */
  const raw = await resp.clone().text().catch(() => '')
  try {
    const body = JSON.parse(raw)
    if (body?.error) msg = body.error
    // 附带上游原始报错 detail，便于定位 503/4xx 原因
    if (body?.detail) msg = `${msg} — ${body.detail}`
    return msg
  } catch {
    /* 不是 JSON：要么是我们的服务端没答上来,要么是请求**压根没走到服务端** */
  }
  /* 401/403 且回的是一页 HTML —— 几乎只有一种情况:部署平台的访问保护
     (Vercel 的 Deployment Protection)。它把未登录的访客挡在门外,
     连静态页都进不去,API 更是碰都不碰。只说 "Request failed (401)",
     用户会一路去查 API key,而问题完全不在那儿 —— 桌面能出图、手机 401,
     最常见的就是这一条:桌面那个浏览器登录过 Vercel,手机没有 */
  if ((resp.status === 401 || resp.status === 403) && /<html|<!doctype/i.test(raw)) {
    return (
      `Request failed (${resp.status}) — the request never reached the app: ` +
      'the deployment is behind a login wall and answered with a web page. ' +
      'On Vercel this is Deployment Protection: turn it off, or set it to protect ' +
      'only preview deployments (Project → Settings → Deployment Protection), ' +
      'or open the site in a browser that is logged in to Vercel.'
    )
  }
  if (resp.status >= 500) {
    msg +=
      " — the API server did not answer. If you're running locally, check that the dev backend is still up (npm run dev)."
  }
  return msg
}

/**
 * 调用后端代理生图。
 * 返回标准化后的 ResultItem 列表(图片载荷统一是 Blob)。
 */
export async function generate(
  params: GenParams,
  config: ApiConfig,
  signal?: AbortSignal
): Promise<ResultItem[]> {
  const caps = getProvider(vendorOf(config), config.model)
  /* n 单独摘出来:不是每家都有这个字段,要不要发由能力表说了算(见
     providerBodyFields)。留在 params 里摊开的话,摘都摘不掉 ——
     Ark 收到一个它没有的 n 会整条 400 */
  const { n, ...rest } = params
  const resp = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...rest,
      /* size 也过一道:豆包那一档"让模型自己定"的表达方式是**不发这个字段**
         (见 sizeFieldFor),转成空串,由代理把它挡在请求体外面 */
      size: sizeFieldFor(config, rest.size),
      /* 水印与张数在这里统一定,而不是在各个调用点各写一遍:出图有创作区、
         角色设定图、对话里的照片与背景图好几条路,漏掉任何一条都会让人以为
         "同一套配置有时行有时不行"。认不认这些字段由厂商能力表说了算 */
      ...providerBodyFields(config, n),
      /* 参考图怎么交给上游也如实上报(表单文件字段 vs 请求体里的 image),
         由代理按它拼请求体。认错了的表现是上传的参考图被上游整条拒掉 */
      refUpload: caps.refs,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model || undefined,
      /* 两条都发:vendor 决定 OpenAI 那条路打 /images/generations 还是 /images/edits,
         protocol 决定整条请求走 OpenAI 形状还是 Gemini 原生形状。
         两者分开是因为中转站上"厂商"和"协议"并不一一对应 ——
         同一个 custom 地址,Gemini 系模型必须走原生协议 */
      vendor: config.vendor || inferVendor(config.baseUrl),
      protocol: caps.protocol
    }),
    signal
  })

  if (!resp.ok) throw new Error(await failureMessage(resp))

  return await imagesFrom(resp)
}

/* 把上游的响应摊成同一个形状的图列表。出图与局部编辑共用 ——
   两处各写一套解析,迟早有一边漏掉 Gemini 的 snake_case 变体。

   出图位置两家不一样,所以先摊平再看:
   - OpenAI:      data[].b64_json | data[].url
   - Gemini 原生: candidates[].content.parts[].inlineData.data
     字段名还有 camelCase(inlineData/mimeType)和 snake_case(inline_data/mime_type)
     两种 —— 我们实测那家中转的两种填法各回一套,都收 */
async function imagesFrom(resp: Response): Promise<ResultItem[]> {
  const data = (await resp.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string
          inlineData?: { data?: string; mimeType?: string }
          inline_data?: { data?: string; mime_type?: string }
        }>
      }
    }>
  }
  const found: Array<{ b64?: string; url?: string }> = []
  // 模型只回了文字、没出图时,这些句子是唯一能说明原因的线索
  const said: string[] = []
  for (const item of data.data || []) found.push({ b64: item.b64_json, url: item.url })
  for (const c of data.candidates || []) {
    for (const part of c.content?.parts || []) {
      const inline = part.inlineData || part.inline_data
      if (inline?.data) found.push({ b64: inline.data })
      else if (typeof part.text === 'string' && part.text.trim()) said.push(part.text.trim())
    }
  }
  if (!found.length) {
    /* Gemini 系的图像模型本质上是对话模型:它可能不谈出图,只回一句话
       (最常见的是"请先给参考图",其次是安全拒绝)。那句话是这里唯一有用的信息,
       丢掉它只会剩下一句"上游没返回图片",等于什么都没说 —— 直接把它当报错抛出来 */
    throw new Error(
      said.length ? said.join(' ').slice(0, 400) : 'No images returned by upstream'
    )
  }

  // 结果统一落成 Blob:base64 会膨胀 33% 且整段进 JS 堆,Blob 由浏览器放在堆外。
  // b64 按真实格式(JPEG/PNG/…)标注 MIME,避免硬编码 png 导致裂图。
  return await Promise.all(
    found.map(async (item): Promise<ResultItem> => {
      if (item.b64) {
        const mime = detectMimeFromDataUrl(item.b64)
        return { type: 'b64', data: base64ToBlob(item.b64, mime) }
      }
      if (item.url) {
        try {
          // URL 结果抓成本地 Blob,避免历史预览因外链过期失效
          return { type: 'b64', data: await urlToBlob(item.url) }
        } catch {
          return { type: 'url', data: item.url }
        }
      }
      return { type: 'url', data: '' }
    })
  )
}

/* 改写强度:quick 保守补细节,creative 允许重构构图与风格。
   档位差异全在服务端的系统提示里,前端只负责把它传下去。

   **界面上那枚改写键只切 quick / creative 两档**(见 useGeneration 的 enhanceMode);
   其余几档由各自的调用方传进来 —— character / vision 走角色起稿,
   summary 走长期记忆压缩,photo 走对话出图的摄影指导。
   收在同一个类型里是因为它们共用这一个端点与同一套上游超时;
   漏一档不会报错,只会静静地落到默认的 quick 档上 ——
   而那一档的输出格式与其余几档完全不同 */
export type EnhanceMode = 'quick' | 'creative' | 'character' | 'vision' | 'summary' | 'photo'
/** 界面上可切换的那两档 */
export type EnhanceToggleMode = 'quick' | 'creative'

// 改写请求里除提示词以外的输入。参数已经够多,收成一个对象免得调用点排成一长串
export interface EnhanceOpts {
  mode: EnhanceMode
  /* 这次改写最终要喂给谁(出图接口的厂商与模型):
     各家对提示词结构的偏好不一样,服务端据此调整输出的写法 */
  targetVendor: string
  targetModel: string
  /* 是否图生图。有参考图时提示词的角色完全不同 —— 是"改什么"而不是"画什么" */
  hasRef: boolean
}

/**
 * 调用后端代理改写提示词。
 * 走文本模型的 /chat/completions(图像模型只出图、改不了提示词),
 * 用的是「用途 = text」那条配置的地址、密钥与模型。返回扩写后的提示词。
 * 未配置时由调用方先拦下,这里不重复判断。
 */
export async function enhancePrompt(
  cfg: ApiConfig,
  prompt: string,
  opts: EnhanceOpts,
  signal?: AbortSignal
): Promise<string> {
  const resp = await fetch('/api/enhance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      prompt,
      mode: opts.mode,
      targetVendor: opts.targetVendor,
      targetModel: opts.targetModel,
      hasRef: opts.hasRef,
      // 后端 /api/enhance 收的字段名仍是 textModel,路由不用改
      textModel: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey
    })
  })

  if (!resp.ok) throw new Error(await failureMessage(resp))

  const data = (await resp.json()) as { prompt?: string }
  const out = typeof data.prompt === 'string' ? data.prompt.trim() : ''
  if (!out) throw new Error('Upstream returned no text to use')
  return out
}

/* ===== 对话出图失败时，给用户看哪句话 ==============================
   从前这里没有这一层：`generateChatPhoto` 把任何异常都吞成 `undefined`，
   界面于是只能说一句"生成失败"。而失败的原因彼此差得很远 ——
   配置没填完、密钥不对、上游 5xx、内容被安全策略拦、浏览器存储满了 ——
   每一种要用户做的事都不一样。

   这一层只做两件事，都是**判据**而不是文案：
   1. 用户自己按了停止不算失败（说成"生成失败"会让人以为模型坏了）；
   2. 一句空话不算原因 —— 总得给出点什么。

   文案本身沿用 `failureMessage` 的产出：它已经把上游的原话与
   "401 其实是部署登录墙"这类**特定成因**翻成了人话，比我们在这里另编一套准。

   **上限要容得下"原话"那一截**：服务端那句人话(约 280 字)后面接的是上游
   原始响应(它自己截到 600 字)。从前这里只留 300 字 —— 恰好在我们自己那句
   解释把额度用光的地方断掉，上游真正点名的那个字段("...the parameter `n`...")
   一个字也看不见。用户拿着半边错误来问，只能靠猜。
   900 = 我们那句 + 上游那句，两截都完整。
   -------------------------------------------------------------------- */
export const PHOTO_ERROR_CHARS = 900

export function photoFailureText(e: unknown): string {
  /* 中止：用户按了 Stop，或页面走了。这不是"失败"，别让用户去查配置 */
  if (e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError') {
    return 'Stopped before the image finished.'
  }
  const msg = e instanceof Error ? e.message : String(e ?? '')
  const clean = msg.replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, PHOTO_ERROR_CHARS) : 'Generation failed.'
}

/* ===== 图片载荷 → 可渲染的 src =====================================
   新记录是 Blob,渲染时现造 object URL;旧记录是 data URL 字符串,原样返回。
   object URL 用 WeakMap 缓存:同一个 Blob 会被图墙、抽屉、预览同时取用,
   所以不能"谁先卸载谁 revoke";但也不能一直留着 —— blob URL 会强引用 Blob,
   记录被删除/清理后图片字节就回收不了。结论:由主界面在记录真正离开界面时
   调用 releaseEntryMedia 显式释放。
   ------------------------------------------------------------------ */
const srcCache = new WeakMap<Blob, string>()
function objectUrlOf(blob: Blob): string {
  let url = srcCache.get(blob)
  if (!url) {
    url = URL.createObjectURL(blob)
    srcCache.set(blob, url)
  }
  return url
}
export function imageSrc(item: ResultItem): string {
  if (typeof item.data === 'string') {
    // 旧数据若是纯 base64,补一个 png 前缀(尽力兼容)
    const s = item.data
    if (!s || s.startsWith('data:') || s.startsWith('blob:')) return s
    return item.type === 'b64' ? `data:image/png;base64,${s}` : s
  }
  return objectUrlOf(item.data)
}

/* 提示词封面 → 可渲染的 src。与历史图共用同一份缓存(Object URL 由 Blob 键控),
   所以从库里删掉一条时,要连它的封面一起 releaseSrc 掉 */
export function coverSrc(cover: Blob | undefined): string {
  return cover ? objectUrlOf(cover) : ''
}

/** 释放一个载荷用过的 object URL:不撤销的话,blob URL 会一直强引用住 Blob */
export function releaseSrc(payload: ResultItem | Blob | undefined) {
  if (!payload) return
  const blob =
    payload instanceof Blob ? payload : typeof payload.data === 'string' ? undefined : payload.data
  if (!blob) return
  const url = srcCache.get(blob)
  if (!url) return
  URL.revokeObjectURL(url)
  srcCache.delete(blob)
}

/** 记录离开界面(删除/被清理)时,把它的原图与缩略图地址一起释放 */
export function releaseEntryMedia(entry: HistoryEntry) {
  for (const item of entry.results || []) releaseSrc(item)
  releaseSrc(entry.thumb)
}

/* ===== 列表缩略图 ===================================================
   抽屉列表把图缩到 48px 显示,但浏览器仍按原始分辨率解码:几十条一起
   挂载就是几十次全尺寸解码,而打开抽屉的同时还有弹簧动画和抽屉滑入在
   跑,主线程被压满,表现就是「只有 home → 历史 会卡」。
   入库时顺手做一张小图,列表只渲染它。老记录没有 thumb,退回原图。
   ------------------------------------------------------------------ */
const THUMB_EDGE = 128
/** 老记录补缩略图的上限:只补最近这些条,更早的沉在底部,不值得逐张全尺寸解码 */
/* 一次会话最多补多少条。原来是 60,而它和"每条固定等 300ms"叠在一起的结果是:
   500 条老记录要开九次页面才补得完 —— 实际上等于永远补不完。改成空闲驱动之后
   浏览器自己会挑"用户没在忙"的时机做,上限也就可以放宽 */
const BACKFILL_MAX = 400
/* 空闲回调里留给下一件事的最小余量。比这更少就不再开新的一条,
   免得把一帧用满 —— 用户滚动时那一帧就没有时间画了 */
const IDLE_MIN_SLICE_MS = 4

/**
 * 解码一张图,顺带量出真实像素尺寸,并尽量压一张列表缩略图。
 * 返回 undefined 表示拿不到这张图(item 缺失或解码失败);
 * 否则一定带回 w/h(图墙按真实比例排版要用),blob 会在图本来就很小、
 * 压缩无意义时缺省 —— 尺寸照量,缩略图不生成。
 */
export async function makeThumb(
  item: ResultItem | undefined
): Promise<{ blob?: Blob; w: number; h: number } | undefined> {
  if (!item) return undefined
  try {
    const src = imageSrc(item)
    if (!src) return undefined
    const bmp = await createImageBitmap(await (await fetch(src)).blob())
    const w = bmp.width
    const h = bmp.height
    const scale = Math.min(1, THUMB_EDGE / Math.max(bmp.width, bmp.height))
    if (scale >= 1) {
      // 本来就比缩略图还小,不值得多存一份;但尺寸仍要带回去给图墙用
      bmp.close()
      return { w, h }
    }
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * scale))
    c.height = Math.max(1, Math.round(bmp.height * scale))
    const ctx = c.getContext('2d')
    if (!ctx) {
      bmp.close()
      return { w, h }
    }
    ctx.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close()
    // webp 编码在个别环境下不可用,退回 png(透明图不能走 jpeg,会糊成黑底)
    const blob =
      (await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.8))) ??
      (await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'))) ??
      undefined
    return { blob, w, h }
  } catch {
    return undefined
  }
}

/** 列表用的地址:优先小缩略图,没有就退回原图 */
export function thumbSrc(e: HistoryEntry): string {
  const item: ResultItem | undefined = e.thumb ? { type: 'b64', data: e.thumb } : e.results?.[0]
  return item ? imageSrc(item) : ''
}

/**
 * 给加这个字段之前存下来的老记录补缩略图,顺带量出真实像素尺寸。
 * 每张之间留一段间隔,免得一上来就把主线程占满;补完落盘,只跑一次。
 * 任何一张失败都跳过,不影响使用。
 */
/**
 * 该给哪些记录补缩略图/尺寸。列表是从新到旧排的。
 *
 * 先筛后取(而不是"扫前 N 条、遇到不需要的就跳过"):后者在前 N 条都已补好时
 * 什么也不做,后面的照样缺 —— 而"缺"这件事与它排在第几位无关。
 */
export function thumbsToFill(list: HistoryEntry[], max = BACKFILL_MAX): HistoryEntry[] {
  return list.filter((e) => !(e.thumb && e.w && e.h)).slice(0, max)
}

/** 这一次空闲回调里还该不该再做一条。余量太少就留给这一帧 */
export function shouldProcessNow(
  timeRemaining: number,
  didTimeout: boolean,
  minSliceMs = IDLE_MIN_SLICE_MS
): boolean {
  // 被 timeout 叫起来的:不做就等于一直不做,所以照做
  if (didTimeout) return true
  return timeRemaining >= minSliceMs
}

/** 等下一次空闲。没有 requestIdleCallback 的环境(Safari 较老版本)退回定时器 */
function nextIdle(): Promise<IdleDeadline | { timeRemaining: () => number; didTimeout: boolean }> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback((d) => resolve(d), { timeout: 1000 })
      return
    }
    setTimeout(() => resolve({ timeRemaining: () => 8, didTimeout: true }), 120)
  })
}

/**
 * 给加缩略图字段之前存下来的老记录补上,顺带量出真实像素尺寸。
 *
 * 节奏交给浏览器,不用固定间隔:
 * - `requestIdleCallback` 只在"这一帧还有空"时回调 —— 用户一滚动、一点击就让位,
 *   不会跟正在看的东西抢主线程
 * - 固定 300ms 那条路的毛病不是卡(实测主线程连一个 >50ms 的长任务都没有),
 *   而是**慢得没有意义**:每条都白等 300ms,60 条就是 18 秒起步,
 *   于是"补缩略图"这件事在真实使用里几乎从不完成。空闲驱动则是有空就多做几条
 * - 一次会话的上限仍然留着,避免"开着页面就一直在后台干活"
 */
export async function backfillThumbs(list: HistoryEntry[]): Promise<void> {
  for (const entry of thumbsToFill(list)) {
    await nextIdle()
    const t = await makeThumb(entry.results?.[0])
    if (!t) continue
    if (t.blob) entry.thumb = t.blob
    entry.w = t.w
    entry.h = t.h
    try {
      await putOne(entry)
    } catch {
      /* 落盘失败就只留内存里这一份,下次打开还会再试 */
    }
  }
}

/* ===== 批量导出选中的图 =============================================
   把挑好的图打包带走 —— "做一套素材"这个任务的最后一步。
   粒度是"图"而不是"记录":一条记录里只挑了一张,就只导出那一张,
   与历史图墙把记录摊平成图块的口径一致(见 HistoryPage 的 tiles)。

   这里刻意不认识"标记":标记是一份长期收藏,而"这次要带走哪几张"往往
   只是一次性的挑选。所以由调用方给出清单,这一层只负责取字节与打包。
   -------------------------------------------------------------------- */
export interface ExportPick {
  /** 属于哪条提示词 —— 只用来起文件名 */
  prompt: string
  item: ResultItem
}

export interface ExportOutcome {
  /** 真正打进包里的张数 */
  exported: number
  /** 取不回字节因而被跳过的张数(远端图被 CORS 拦、载荷损坏) */
  skipped: number
}

/** 按载荷真实类型推扩展名:结果可能是 jpeg / webp,写死 png 名不对。
 *  单张下载与批量导出共用同一份,两处各写一套迟早改歪一边 */
export function extOf(item: ResultItem | undefined): string {
  const data = item?.data
  if (data instanceof Blob) {
    const t = data.type
    if (t.includes('jpeg')) return 'jpg'
    if (t.includes('webp')) return 'webp'
    if (t.includes('gif')) return 'gif'
    return 'png'
  }
  if (typeof data === 'string') {
    const mime = detectMimeFromDataUrl(data)
    return mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] || 'png'
  }
  return 'png'
}

/** 把一张图原样存下来(单张,不打包)。
 *
 *  与批量导出共用同一份扩展名判据(extOf),而"点一下存这张"的实现也只有
 *  这一处 —— 预览卡里那枚与历史页搜索结果里的"存这一张"都走它,
 *  两处各写一套迟早改歪一边(扩展名、远端降级都会不一致)。
 *
 *  远端图源跨域,download 属性会被浏览器忽略:那种情况新窗口打开,
 *  让用户自己另存 —— 如实降级,而不是静默存下一个打不开的文件 */
export function downloadImageUrl(url: string, item: ResultItem | undefined): void {
  if (!url) return
  const a = document.createElement('a')
  a.href = url
  if (/^https?:/.test(url)) {
    a.target = '_blank'
    a.rel = 'noopener'
  } else {
    a.download = `kairo-${Date.now()}.${extOf(item)}`
  }
  a.click()
}

/* 读出一张图的字节。统一借 imageSrc 把三种载荷(Blob / data URL / 远端 URL)
   变成可 fetch 的地址,不必在调用点各判一次。
   远端图可能被跨域拦下 —— 返回 undefined 让调用方跳过:导出不该因为一张
   取不回来的老图而整批失败 */
async function itemBlob(item: ResultItem): Promise<Blob | undefined> {
  const src = imageSrc(item)
  if (!src) return undefined
  try {
    return await urlToBlob(src)
  } catch {
    return undefined
  }
}

/** 文件名里不能出现的字符去掉;标题派生不出来时退回一个通用名 */
function safeBase(prompt: string): string {
  const cleaned = titleFromPrompt(prompt)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\.+$/, '')
    .trim()
  return cleaned || 'image'
}

/** 触发一次下载。object URL 用完即撤,否则这份 zip 会被一直强引用住 */
function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1500)
}

/** 包名带时间戳:同一天导两次不会互相覆盖 */
function zipName(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `kairo-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`
}

/**
 * 把给出的一批图打包成一个 zip 下载。
 *
 * 逐张串行读字节:并发读会一次性解码多张大图、把整批请求同时压在主线程上,
 * 而这是一次手动动作,慢一点无妨。
 * 图片本身已是压缩格式,所以用 level 0(只打包不再压),省掉白烧的 CPU。
 * zip 库用动态引入:导出是低频动作,不该让它进首屏那份包。
 */
export async function exportImages(
  picks: ExportPick[],
  onProgress?: (done: number, total: number) => void
): Promise<ExportOutcome> {
  const files: Record<string, Uint8Array> = {}
  // 同一句提示词出的多张图会撞名,所以按标题分别计数编号
  const counters = new Map<string, number>()
  let skipped = 0

  for (let i = 0; i < picks.length; i++) {
    onProgress?.(i, picks.length)
    const { prompt, item } = picks[i]
    const blob = await itemBlob(item)
    if (!blob) {
      skipped++
      continue
    }
    const base = safeBase(prompt)
    const n = (counters.get(base) || 0) + 1
    counters.set(base, n)
    files[`kairo-${base}-${n}.${extOf(item)}`] = new Uint8Array(await blob.arrayBuffer())
  }
  onProgress?.(picks.length, picks.length)

  const exported = Object.keys(files).length
  if (!exported) return { exported: 0, skipped }

  const { zip } = await import('fflate')
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
  /* fflate 的返回类型挂在 ArrayBufferLike 上(理论上可能是 SharedArrayBuffer),
     而 BlobPart 只收 ArrayBuffer 支撑的视图 —— 这里拿到的一定是普通 Uint8Array,
     转一下类型即可,不必白拷一份字节 */
  downloadBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), zipName())
  return { exported, skipped }
}

/* ===== 角色的导入导出 =====
   与提示词库那处不同:角色**必须**带图。设定图只在 IndexedDB 里存一份
   (不进历史,见 App 的 genCharView),所以只导设定的 JSON 得到的是一个没有脸的角色 ——
   对方还得重新生成五张,而重新生成出来的脸已经不是同一个了。所以走 zip。

   包里图片的路径写在 manifest 里,不靠命名约定:读的一方按 manifest 取文件,
   于是单角色包可以平铺在根目录(好看),将来的多角色包放各自子目录,
   两边都不用改读取逻辑 */

/** 导出包的 manifest。版本号先留着:以后改结构时可以据此分支,而不是猜 */
type CharacterManifest = {
  format: 'kimage-character'
  version: 1
  characters: Array<{
    name: string
    createdAt: number
    fields?: CharacterFields
    desc?: string
    /* 人格设定。纯 JSON,跟着 manifest 走即可 —— 不进这一步的话,
       导出的角色在对方那里会变成一个没有性格的角色,
       而人格恰恰是这个功能里最难重写的一份数据 */
    persona?: CharacterPersona
    refKind?: CharacterViewKind
    /* 置顶。纯 JSON 的一个布尔,跟着包走 —— 置顶是"我常找这个人",
       与人格、嗓音同属"这个角色是谁"的一部分,分享时该一起过去。
       缺省(老包 / 没置顶)一律当未置顶 */
    pinned?: boolean
    /** zip 内的相对路径。没有这一项就是没有那张图 */
    ref?: string
    /* 第一步上传的那张底图。它不属于五张设定图,所以单独一项 ——
       少了它,导入回来的角色在重跑其余四张时就只剩正脸一张参考图 */
    source?: string
    views?: Partial<Record<CharacterViewKind, string>>
    /* 对话与记忆。**单独一个文件,不内嵌进 manifest** ——
       几百条消息塞进 character.json 会让那份"给人看的清单"变成一坨机器数据。
       没有这一项 = 这个包没带对话(老包、或没聊过的角色) */
    chat?: string
  }>
}

/* 导出时最多带上多少条消息。设定图与对话都要跟着角色走,但两者性质不同:
   图是有限的几张,对话可以无限长 —— 一个聊了几千轮的角色,全带出去就是
   包里塞进几 MB 纯文本。而分享时真正要传的是**记忆**(它记得什么),
   消息只是让那份记忆有个能对照的来处,给最近一档就够了 */
export const CHAT_EXPORT_MSGS = 300

/** Blob → 扩展名。设定图统一是 JPEG,但参考图可能是用户上传的 PNG,
 *  所以照实判,不写死(与 extOf 同一份 MIME 表) */
function extOfBlob(blob: Blob): string {
  const t = (blob.type || '').toLowerCase()
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  if (t.includes('webp')) return 'webp'
  if (t.includes('gif')) return 'gif'
  return 'png'
}

/** 按魔数认图片类型,不认扩展名:参考图是以 data URL 送给上游的,
 *  前缀里的 MIME 就是这里定的 —— 写错会被上游拒掉。
 *  (data URL 那个版本见 lib/idb.ts 的 detectMimeFromDataUrl) */
function sniffMime(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'
  // WEBP 是 RIFF 容器:前 4 字节 "RIFF",第 8-11 字节 "WEBP"
  if (b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp'
  return 'image/jpeg'
}

/** 文件名里不能出现的字符去掉。名字可能很长,截一段够认出来就行 */
function safeFile(name: string, fallback: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '').replace(/\.+$/, '').trim().slice(0, 40)
  return cleaned || fallback
}

/** 包名带角色名,一堆下载里一眼认得出;同日导两次也不会互相覆盖 */
function characterZipName(name: string): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  return `kairo-character-${safeFile(name, 'character')}-${stamp}.zip`
}

/**
 * 导出一个角色:character.json + 主参考图 + 设定图 + 对话(chat.json),打成一个 zip。
 *
 * 与 exportImages 同一套:动态引入 fflate(导出是低频动作,不该进首屏那份包)、
 * level 0(图已是压缩格式,再压只是白烧 CPU)、串行读字节。
 * 返回包内实际写进去的图片张数,好在界面上如实回执 —— 一个只有设定的角色
 * 也能导出,那种包小得多,该让用户知道。
 *
 * chat 是那份对话(消息 + 记忆),由调用方从库里读好交进来:
 * 消息在界面里是按角色懒加载的,主界面才是碰 IndexedDB 的那一层。
 */
export async function exportCharacter(
  c: Character,
  views: CharacterView[],
  chat?: ImportedChat
): Promise<number> {
  const files: Record<string, Uint8Array> = {}
  const entry: CharacterManifest['characters'][number] = {
    name: c.name,
    createdAt: c.createdAt,
    ...(c.fields ? { fields: c.fields } : {}),
    ...(c.desc ? { desc: c.desc } : {}),
    // 没写过的角色不往包里塞一份空壳:四项全空时这两边长得一样,少一项更干净
    ...(hasPersona(c.persona) ? { persona: c.persona } : {}),
    // 没置顶就不写这一项:老包与"从没置顶过"在读回来时是同一件事
    ...(c.pinned ? { pinned: true } : {}),
    ...(c.refKind ? { refKind: c.refKind } : {})
  }

  let images = 0
  if (c.ref) {
    const name = `ref.${extOfBlob(c.ref)}`
    files[name] = new Uint8Array(await c.ref.arrayBuffer())
    entry.ref = name
    images++
  }
  // 底图与封面图多数时候不是同一张(封面是生成出来的正脸),所以要分开写
  if (c.sourceRef) {
    const name = `source.${extOfBlob(c.sourceRef)}`
    files[name] = new Uint8Array(await c.sourceRef.arrayBuffer())
    entry.source = name
    images++
  }
  const map: Partial<Record<CharacterViewKind, string>> = {}
  for (const v of views) {
    const name = `${v.kind}.${extOfBlob(v.data)}`
    files[name] = new Uint8Array(await v.data.arrayBuffer())
    map[v.kind] = name
    images++
  }
  if (Object.keys(map).length) entry.views = map

  /* 对话单独一个文件。消息与记忆都为空时不写 —— 一个没聊过的角色,
     包里多一份空壳只会让"这个包带了对话"这句话变得不可信 */
  if (chat && (chat.messages.length || chat.memory)) {
    /* 只写消息与记忆 —— images 是 Blob,序列化进 JSON 会变成一堆空对象。
       它们另走文件(见下) */
    const meta: ImportedChat = { messages: chat.messages, memory: chat.memory }
    files['chat.json'] = new TextEncoder().encode(JSON.stringify(meta, null, 2))
    entry.chat = 'chat.json'
    /* 对话里附过的图一起带走。**缺了它们,对方拿到的是一串
       "不知道在说什么的回复"** —— 消息在,而消息指着的那张图不在。
       文件名就是 imageId,导入那边按消息里的引用去取 */
    for (const img of chat.images || []) {
      files[`chat/${img.id}.${extOfBlob(img.blob)}`] = new Uint8Array(await img.blob.arrayBuffer())
    }
  }

  const manifest: CharacterManifest = { format: 'kimage-character', version: 1, characters: [entry] }
  files['character.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2))

  const { zip } = await import('fflate')
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
  /* fflate 的返回类型挂在 ArrayBufferLike 上,而 BlobPart 只收 ArrayBuffer 支撑的视图 ——
     拿到的确实是普通 Uint8Array,转一下类型即可(与 exportImages 同一处理) */
  downloadBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), characterZipName(c.name))
  return images
}

/* 单个 zip 条目的解压上限。zip 炸弹是最省事的一类攻击:压缩包几十 KB,
   解开可以是几十 GB —— 而下面是一次性全部解开再建 Blob,不拦就是页面自己
   把自己撑爆。角色图最多几 MB,给到 32MB 已经很宽了 */
const MAX_CHAR_ENTRY = 32 * 1024 * 1024

/* 从角色包里读回的对话最多认多少条。与导出那边的 CHAT_EXPORT_MSGS 不是一个数:
   那边是"我们自己愿意带出去多少",这边是"愿意从外部文件里收下多少" ——
   后者得防着别人手写一个十万条消息的包。 */
const CHAT_IMPORT_MSGS = 2000

/** 从角色包里读回一段对话。包是外部文件,所以逐条过筛 ——
 *  认不出的角色、空正文、不认识的字键一律丢掉(与 fields / persona 同一处理)。
 *  记忆的游标**不在文件里**:那一份由导入方按收到的消息重新推平。 */
function coerceImportedChat(raw: unknown): ImportedChat | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as { messages?: unknown; memory?: unknown }
  const rows = Array.isArray(src.messages) ? src.messages.slice(0, CHAT_IMPORT_MSGS) : []
  /* 时间戳坏了就按次序补一个:整段对话的**相对次序**比绝对时刻要紧得多 ——
     界面上靠它排序,全一样或者全是 0 会让顺序彻底乱掉 */
  const t0 = Date.now() - rows.length * 1000
  const messages: ImportedChatMessage[] = []
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return
    const o = row as Record<string, unknown>
    const role = o.role === 'user' || o.role === 'assistant' ? o.role : null
    const content = typeof o.content === 'string' ? o.content.slice(0, CHAT_MAX_CHARS) : ''
    if (!role || !content.trim()) return
    messages.push({
      role,
      content,
      createdAt:
        typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) && o.createdAt > 0
          ? o.createdAt
          : t0 + i * 1000,
      ...(o.stopped === true ? { stopped: true } : {}),
      ...(o.truncated === true ? { truncated: true } : {}),
      ...(typeof o.mood === 'string' && o.mood ? { mood: o.mood.slice(0, 24) } : {}),
      /* 附图的那个引用键。**不查它指的那张图在不在包里** —— 那要等图读完
         才知道,而"消息留着、图没了"是一种可接受的降级(界面不画它,也不报错)。
         这里只收紧形状:它会变成文件名,放开就等于把路径交给外部文件 */
      ...(typeof o.imageId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.imageId)
        ? { imageId: o.imageId }
        : {}),
      /* 角色发的那张。**这三个字段从前在这里被丢掉了** ——
         包里有图、消息上的 photoId 却没了,于是导入回来的对话
         "它给你看过什么"整段是空的(见 types.ts 的 ImportedChatMessage) */
      ...(typeof o.photoId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.photoId)
        ? { photoId: o.photoId }
        : {}),
      /* 场景串。**按权威上限收口,不是另写一个数** —— 它是"重画这一张"的全部
         依据,截短了就会画出一张和原文对不上的图(见上面 import 那段说明) */
      ...(typeof o.photo === 'string' && o.photo.trim()
        ? { photo: o.photo.replace(/\s+/g, ' ').trim().slice(0, PHOTO_SCENE_CHARS) }
        : {}),
      ...(o.photoSelf === true ? { photoSelf: true } : {}),
      /* 这一张谁拿的相机。**只认那两个词** —— 它会流进提示词模板的选择
         (见 lib/chatPhoto),外部文件里写别的等于让它替出图那一层挑模板。
         缺省(老包)就是"没说",由客户端按场景判、再不行默认自拍 */
      ...(o.photoShot === 'selfie' || o.photoShot === 'third'
        ? { photoShot: o.photoShot }
        : {}),
      /* 这一张离得多近。同一条纪律:只认那三档,别的词不进提示词模板 */
      ...(o.photoFrame === 'close' || o.photoFrame === 'medium' || o.photoFrame === 'full'
        ? { photoFrame: o.photoFrame }
        : {}),
      /* 上一次失败的原因。**这是一句外部输入**(它最初来自上游的报错原文),
         会被直接渲染在界面上,所以按文案那一道收:去掉控制字符、限长。
         它不影响"有没有图"这个判断(那由 photoId 定),所以留着是无害的 ——
         反而让"导进来的这条为什么没有图"仍然说得清 */
      ...(typeof o.photoError === 'string' && o.photoError.trim()
        ? { photoError: o.photoError.replace(/\s+/g, ' ').trim().slice(0, 300) }
        : {})
    })
  })
  const memory = typeof src.memory === 'string' ? src.memory.trim().slice(0, CHAT_MAX_CHARS) : ''
  if (!messages.length && !memory) return undefined
  return { messages, memory }
}

/** 读一个角色 zip。返回的每条都换过 id ——
 *  不沿用文件里的 id:它可能与现有的撞上,而列表里两条同 id 会让渲染与删除都错乱
 *  (与配置的导入同一条理由)。内容来自外部文件,所以逐项规整,坏的就丢掉。 */
export async function readCharacterZip(file: File): Promise<ImportedCharacter[]> {
  const { unzip } = await import('fflate')
  // 先把字节读出来:unzip 的回调不是 async,不能在里面 await
  const zipBytes = new Uint8Array(await file.arrayBuffer())
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(
      zipBytes,
      {
        /* 解压前按清单里声明的大小过一遍,超限的条目直接跳过。
           manifest 永远放行 —— 它只有几百字节,而把它滤掉会让下面的报错
           变成"这不是角色包",把真正的原因盖住 */
        filter: (f) => f.name.split('/').pop() === 'character.json' || f.originalSize <= MAX_CHAR_ENTRY
      },
      (err, out) => (err ? reject(err) : resolve(out))
    )
  })

  /* manifest 不一定在根目录:用户很可能解压看一眼再重新打包,于是整包多套了一层
     文件夹(macOS 还会塞一个 __MACOSX)。按 basename 找它,并以它所在的目录为基准
     解析图路径 —— 否则一个明明看得见 character.json 的包会被判成"不是角色包" */
  const manifestKey = Object.keys(entries).find(
    (k) => !k.startsWith('__MACOSX/') && k.split('/').pop() === 'character.json'
  )
  if (!manifestKey) {
    throw new Error('That zip has no character.json — it is not a character export.')
  }
  const base = manifestKey.slice(0, manifestKey.length - 'character.json'.length)
  // 基准目录下有就用它,没有就退回原路径(兼容手写/其它工具生成的包)
  const fileAt = (path: string): Uint8Array | undefined => entries[base + path] || entries[path]

  let parsed: CharacterManifest
  try {
    parsed = JSON.parse(new TextDecoder().decode(entries[manifestKey]))
  } catch {
    throw new Error('character.json inside that zip is not valid JSON.')
  }
  if (!Array.isArray(parsed?.characters)) {
    throw new Error('character.json inside that zip has no characters.')
  }

  /* 包里的对话附图。它们都摊在 chat/ 一个目录下,按 imageId 索引 ——
     同一个包里可能有多个角色的对话,图放在一起,各自按消息里的引用去取 */
  const chatImgs = new Map<string, Blob>()
  for (const [path, bytes] of Object.entries(entries)) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (name === 'chat.json' || !path.startsWith(`${base}chat/`)) continue
    const id = name.replace(/\.[a-z0-9]+$/i, '')
    if (!id) continue
    /* 一律按 jpeg 报:导出时压过的就是 jpeg。万一包里是别的格式,
       浏览器也会按内容嗅探,不影响显示 */
    chatImgs.set(id, new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
  }

  const known = new Set<string>(CHARACTER_VIEWS.map((v) => v.kind))
  const out: ImportedCharacter[] = []
  for (const c of parsed.characters) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) continue

    const views: ImportedCharacter['views'] = []
    for (const [kind, path] of Object.entries(c.views || {})) {
      // 认不出的视图名丢掉:库里只认这五种(与 loadCharViews 同一条筛选)
      const bytes = typeof path === 'string' ? fileAt(path) : undefined
      if (!known.has(kind) || !bytes) continue
      views.push({
        kind: kind as CharacterViewKind,
        data: new Blob([bytes as BlobPart], { type: sniffMime(bytes) })
      })
    }

    const refBytes = typeof c.ref === 'string' ? fileAt(c.ref) : undefined
    // 老包(底图还是单独一项之前导的)没有 source,读到的就是空 —— 退化成单图参考
    const sourceBytes = typeof c.source === 'string' ? fileAt(c.source) : undefined
    /* 对话读不出来只丢对话:角色本身照常导入,与"某一张图丢了"同一处理。
       一个坏掉的 chat.json 不该让整份角色设定也跟着进不来 */
    let chat: ImportedChat | undefined
    const chatBytes = typeof c.chat === 'string' ? fileAt(c.chat) : undefined
    if (chatBytes) {
      try {
        chat = coerceImportedChat(JSON.parse(new TextDecoder().decode(chatBytes)))
      } catch {
        chat = undefined
      }
    }
    /* 把这段对话真正引用到的图挂上去。**只挂用到的那些** ——
       包里的图是全体角色共用的一个目录,每个角色都装一份会重复写库 */
    if (chat) {
      /* 用户附的(imageId)与角色发的(photoId)都算"用到了":
         只收前者的话,角色发过的图在导入后会变成空白 */
      const used = new Set(
        chat.messages
          .flatMap((m) => [m.imageId, m.photoId])
          .filter((x): x is string => !!x)
      )
      const imgs = [...used]
        .map((id) => ({ id, blob: chatImgs.get(id) }))
        .filter((x): x is { id: string; blob: Blob } => !!x.blob)
      if (imgs.length) chat.images = imgs
    }
    out.push({
      name: c.name.trim(),
      createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
      // 补齐缺的键并逐项收成字符串:文件里的设定可能是老版本写的,也可能是坏的
      ...(c.fields ? { fields: coerceCharFields(c.fields) } : {}),
      ...(typeof c.desc === 'string' && c.desc.trim() ? { desc: c.desc.trim() } : {}),
      // 与 fields 同一处理:包是外部文件,脏数据照样要防
      ...(hasPersona(coerceCharPersona(c.persona))
        ? { persona: coerceCharPersona(c.persona) }
        : {}),
      /* 置顶只认 true:文件里写 "false" / 1 / 别的什么都当没置顶 ——
         它是一个开关,不是一个能放任意值进去的槽 */
      ...(c.pinned === true ? { pinned: true } : {}),
      ...(refBytes
        ? { ref: new Blob([refBytes as BlobPart], { type: sniffMime(refBytes) }) }
        : {}),
      ...(sourceBytes
        ? { sourceRef: new Blob([sourceBytes as BlobPart], { type: sniffMime(sourceBytes) }) }
        : {}),
      // 主参考图取自哪张视图,只有在图确实带上了时才有意义
      ...(refBytes && typeof c.refKind === 'string' && known.has(c.refKind)
        ? { refKind: c.refKind as CharacterViewKind }
        : {}),
      views,
      ...(chat ? { chat } : {})
    })
  }
  return out
}

/* ===== 历史记录(IndexedDB,容量不受限、真正持久) ===== */
/** 把一条历史摊成可复现的完整配方,交给主界面按当前厂商的能力逐项套用。
 *  参考图不在返回值里 —— 记录里存的是 Blob,转 data URL 要异步,由调用方补上 */
export function reuseParamsOf(e: HistoryEntry): ReuseParams {
  return {
    prompt: e.prompt,
    size: e.size,
    // 实际拿到的张数,而不是当初请求的数值:上游少给了就以实际为准
    n: e.results.length,
    quality: e.quality,
    background: e.background,
    /* 配方里最容易漏掉的两项。不还原配置,重跑用的其实是"当前生效的那个模型",
       换了模型却以为是同一张图在微调,对比就失真了 */
    configId: e.configId,
    seed: e.seed,
    // 出处:主界面在落盘时把这条记录设为新生成的 parent,链就挂上了
    fromEntryId: e.id
  }
}
export async function loadHistory() {
  try {
    const list = await getAll<HistoryEntry>()
    return list.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

/**
 * 把「库里的历史」与「本页内存里的历史」合起来。用于另一个标签页改了历史之后的重读。
 *
 * 这里**不能整份替换**:本页可能正好有一条刚落盘、或落盘失败只剩内存的记录,
 * 替换会把它从界面上抹掉(而它其实还在)。也**不能把「内存有、库里没有」的一律留下** ——
 * 那恰恰是「另一个标签页删掉了它」的形状,留着就永远是一块点开是空图的幽灵。
 *
 * 所以用 `writing`(正在写盘的 id 集合)区分这两种情况:
 * - 库里没有、但正在写 → 保住内存那份(写入还没落地)
 * - 库里没有、也不在写 → 别处删了它,丢掉
 *
 * 库里有的以库为准(库是这一份数据的正本),最后按时间倒序 —— 与 loadHistory 一致。
 */
export function mergeHistory(
  fromDb: HistoryEntry[],
  memory: HistoryEntry[],
  writing: ReadonlySet<string>
): HistoryEntry[] {
  const inDb = new Set(fromDb.map((h) => h.id))
  const stillWriting = memory.filter((h) => !inDb.has(h.id) && writing.has(h.id))
  return [...stillWriting, ...fromDb].sort((a, b) => b.createdAt - a.createdAt)
}
/**
 * 写入一条历史,并在空间吃紧时清理最旧的一批。
 * 返回 PruneResult 表示"确实清了",交由界面告知用户;空间宽裕时返回 null。
 */
export async function addHistoryRecord(record: HistoryEntry): Promise<PruneResult | null> {
  // 第一次真正写入时顺带申请持久化存储(见 idb.ts 的 ensurePersisted)
  await ensurePersisted()
  await putOne(record)
  return await pruneHistory()
}
export async function removeHistoryRecord(id: string) {
  // 删除不可能超出保留量,无需再裁剪
  await deleteOne(id)
}
/** 覆盖写回一条历史。改的是结果项上的「标记」,条目本身没变,所以不必重跑裁剪 */
export async function saveHistoryRecord(entry: HistoryEntry) {
  await putOne(entry)
}

/* ===== 作品集(Collection)目录 ===========================================
   作品集只存"标题 + id"的目录 —— 每条几百字节,localStorage 足够。
   归属关系(哪条记录属于哪个作品集)挂在记录自己的 collectionId 上,
   和记录一起存在 IndexedDB,所以这里不需要接触 IDB。
   ------------------------------------------------------------------------ */
export const COLL_KEY = 'kimage.collections'

/** 读出作品集目录。目录是本地数据,但别信它一定干净:同步工具截断、手改时
    当数组直接用会让页面崩,滤一遍扔掉坏项 */
export function loadCollections(): Collection[] {
  try {
    const raw = localStorage.getItem(COLL_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (c): c is Collection =>
        !!c && typeof c === 'object' && typeof (c as Collection).title === 'string'
    )
  } catch {
    return []
  }
}

/** 整份覆盖写回。目录小,全量重写最省心 */
export function saveCollections(list: Collection[]): void {
  try {
    localStorage.setItem(COLL_KEY, JSON.stringify(list))
  } catch {
    /* ignore: 写不下就不写,下次改动再试 */
  }
}

/* ===== 角色 =====
   目录只有名字/设定/时间,每条几百字节,localStorage 足够;
   参考图是 Blob,按 id 存在 IndexedDB,读的时候贴回去(与提示词封面同一套做法) */
export const CHAR_KEY = 'kimage.characters'

/* —— 字段顺序与分组 ——

   **这些不再是手写的清单**:键、顺序、哪些只喂设定图,全部来自
   server/charSpec.js 那份行定义 —— 服务端拼提示词用的也是它。
   在这之前这里有四份平行的手写清单(面貌特征九项、只喂设定图两项、
   拼接顺序一份、人格四项),而服务端提示词里还有一份行清单与一份必填枚举。
   加一栏要同时改六处,漏掉任何一处都不报错 —— 只是那个字段静静地空着。

   顺序固定很重要 —— 顺序一变,上游拿到的条件就变了,一致性也就无从谈起 */
const CHAR_FIELD_ORDER = charSpecKeys('field') as Array<keyof CharacterFields>
/* 面貌特征:跨场景不该变的那几项。它们会并进每一张成品的提示词 ——
   只给头发和眼睛时,肤色、脸型、眉形全靠模型自己从零重编,换个场景就不是同一个人了。
   outfit / marks 不在其中(见 spec 里的 sheetOnly) */
const CHAR_FACE_FIELDS = CHAR_FIELD_ORDER.filter(
  (k) => !CHAR_SPEC_LINES.some((l) => l.key === k && l.sheetOnly)
)

/* 一份空设定:解析、新建表单、读入老数据都拿它当底。
   由 CHAR_FIELD_ORDER 生成而不是手写十遍 —— 加字段时只有一处要改 */
export function emptyCharFields(): CharacterFields {
  const out = {} as CharacterFields
  for (const k of CHAR_FIELD_ORDER) out[k] = ''
  return out
}

/* 把读进来的设定逐项收成字符串:
   - 补齐缺的键 —— 老角色的 fields 里没有后来加的 face / brows / noseMouth 等项;
   - 非字符串的值一律置空 —— 外部的 zip 与 localStorage 都可能被写坏
     (手改、同步工具截断,或一份人手拼的 character.json)。

   收口只做在这一处是有意的:界面上读这些值的地方写的是 `(v || '').trim()`,
   它们统一假定值一定是字符串 —— 一个数字或对象就够让角色页整个崩掉,
   而逐个读点去防等于把同一个判断抄十几遍 */
function coerceCharFields(raw: Partial<CharacterFields> | undefined): CharacterFields {
  const out = emptyCharFields()
  if (!raw) return out
  for (const k of CHAR_FIELD_ORDER) {
    const v = raw[k]
    out[k] = typeof v === 'string' ? v : ''
  }
  return out
}

/* 人格的字段顺序,取自 server/charSpec.js 那份行定义 ——
   拼提示词时顺序必须固定:顺序一变,同一个角色每轮拿到的条件就不一样,
   而聊天最忌讳的正是"同一个人今天一个样明天一个样" */
const CHAR_PERSONA_KEYS = charSpecKeys('persona') as Array<keyof CharacterPersona>

/** 一份空人格:新建角色、读入老角色、解析导入包都拿它当底。
 *  由 CHAR_PERSONA_KEYS 生成而不是手写五遍 —— 与 emptyCharFields 同一条理由 */
export function emptyCharPersona(): CharacterPersona {
  const out = {} as CharacterPersona
  for (const k of CHAR_PERSONA_KEYS) out[k] = ''
  return out
}

/** 人格里有没有写出内容。四项全空 = 这个角色还没设定过性格,
 *  界面上据此决定要不要给一句引导 */
export function hasPersona(p: CharacterPersona | undefined): boolean {
  if (!p) return false
  return CHAR_PERSONA_KEYS.some((k) => (p[k] || '').trim())
}

/* 与 coerceCharFields 同一条理由、同一个收口:老角色根本没有 persona 这个字段,
   而外部的 zip 与 localStorage 都可能被写坏(手改、同步工具截断)。
   界面上读它的地方一律当"值一定存在且一定是字符串"来写,
   一个数字或对象就够让对话页整个崩掉 —— 而逐个读点去防等于把同一个判断抄十遍 */
function coerceCharPersona(raw: Partial<CharacterPersona> | undefined): CharacterPersona {
  const out = emptyCharPersona()
  if (!raw) return out
  for (const k of CHAR_PERSONA_KEYS) {
    const v = raw[k]
    out[k] = typeof v === 'string' ? v : ''
  }
  return out
}

/* 字段值里的换行与连续空白收敛成单个空格。
   规格字段现在是可换行的 textarea(单行装不下 12 个词的字段值),
   换行只是排版,原样拼进提示词会在句子中间插一段空白 */
function inline(s: string | undefined): string {
  return (s || '').replace(/\s+/g, ' ').trim()
}

/* 角色描述文本:按固定顺序把结构化设定拼起来,再接上自由描述。
   加结构化字段之前存下来的角色只有 desc,那种情况整段返回,不做任何改写。
   这个"全量"版本只用在设定图自己的生成上(见 App 的 genCharView)—— */
export function characterDesc(c: Character): string {
  const f = c.fields
  const parts = f ? CHAR_FIELD_ORDER.map((k) => inline(f[k])).filter(Boolean) : []
  const free = inline(c.desc)
  if (free) parts.push(free)
  return parts.join(', ')
}

/* 并进普通创作提示词的只有面貌特征那些项(见 CHAR_FACE_FIELDS,即行定义里
   除 outfit / marks 之外的全部)。为什么会细分到眉毛和脸型:只给 hair 和 eyes 时,
   肤色、骨相、眉形全靠模型自己从零重编,场景一换就不是同一个人了。
   而 face marks 与 facialHair 之所以也在这里,是因为它们一旦只出现在设定图里、
   不进创作提示词,就会每张图丢一次。
   style 与 build 同样是"这个人本身"的一部分,所以也在这条路上 ——
   只有设定图是动漫、场景图是写实,或者全身图一个身高、场景图另一个身高,
   都叫不是同一个人。

   加结构化字段之前的老角色没有 fields,退回全量描述,总比什么都不送强 */
export function characterFaceDesc(c: Character): string {
  const f = c.fields
  if (!f) return characterDesc(c)
  return CHAR_FACE_FIELDS.map((k) => inline(f[k])).filter(Boolean).join(', ')
}

/* —— 角色的设定图 ——
   五张视图各自的修饰词与取景。顺序就是生成顺序:正脸是锚,其余四张都以它当参考图,
   才谈得上"同一张脸"。取景分方形与竖幅 —— 头像装得下方形,全身只有竖幅才放得开。

   顺序也按"它补上了什么"来排:脸定人 → 把这张脸转到别的方向看 →
   全身交代体型与服装轮廓 → 细部特写交代材质与零件 → 肢体交代手、臂、腿、脚。

   **这个顺序不只是列表顺序**(2026-10-06 更正):对话出图那条路有自己的排法
   (见 lib/chatPhoto 的 shotViewOrder),但**创作区那条路不传 order,取的就是
   这里的顺序,而且只取前 4 张**(见 useCharacters 的 MAX_CHAR_REFS)——
   所以排在最后一位的那张等于在那条路上自动出局。`body` 排最后正是这个原因:
   它只在"角色发一张自己身体的特写"时需要,其它几条路都用不上它。

   注意:修饰词里绝对不能出现 "character reference sheet" 这类词。
   它在图像模型那里是一个很强的排版概念(设定表 = 正面 + 侧面 + 背面并排 + 细节放大),
   写进去模型就真的给你画一张拼版,而不是一张干净的单人图。
   要的是"单个人物占画面主体",所以正面把 "single / one person" 说死。

   另外不写 "filling the frame":那是"把主体塞满画面"的意思,配上 headshot
   会让模型的头顶直接顶到画面上沿 —— 发型轮廓、头饰、帽子这些认人的线索
   第一个被切掉。改成"完整入画 + 头顶留白":要的是主体在框内,且框里有余量 */
/**
 * 参考图是"这个人是谁"的凭据,**不是"这一张怎么拍"的模板**。
 *
 * 用户 2026-10-05 报的那个毛病就是这个:上传的底图是**侧脸**,于是生成的正脸
 * 也是侧脸。根因不是"正面"这两个字没写 —— 那句一直在(见下面 front 的 suffix)——
 * 而是**参考图在图像编辑那条路上是最强的机位来源**:i2i 的默认行为就是保住输入
 * 的姿态,一句 "front-facing headshot" 拗不过它。这正是
 * [角色配图构图与光影设计.md](../doc/角色配图构图与光影设计.md) 决定五里写的
 * "参考图同时是同一张脸的唯一保证,又是最强的机位与光线污染源" ——
 * 而那一条当时**只落进了提示词改写那条路**(`REF_NOTE`),没落到设定图上。
 *
 * 所以这里明说三件事,顺序也就是它们的重要性:
 * 1. 参考图管什么(脸、特征、头发、体型);
 * 2. 参考图**不管**什么(姿态、机位、光);
 * 3. 它朝哪边,不许跟着抄。
 *
 * **写成复数是有意的**(2026-10-05):正脸那一格只送一张(底图),而其余四格
 * 送两张(正脸 + 底图,见 App 的 genCharView)。单数那句到了那四格就成了
 * 一句对不上号的指令。
 */
export const REF_IDENTITY_ONLY =
  'reference images are only about who this person is: their face, features, hair and build; ignore the pose, the camera angle and the lighting in them, and do not copy the direction the person is facing there'

export const CHARACTER_VIEWS: Array<{
  kind: CharacterViewKind
  label: string
  // 追加在角色设定之后的修饰词,写明取景与用途
  suffix: string
  framing: 'square' | 'portrait'
}> = [
  {
    kind: 'front',
    label: 'Front',
    /* 正面那一张是整条链的锚:其余四张都以它为参考图,它一歪全歪
       (侧脸的"正脸"会让后面每一张都把侧脸当基准)。

       所以"正面"不写成 front-facing 就完 —— 那个词对侧脸输入不够硬(见
       REF_IDENTITY_ONLY 那段)。这里把它拆成**可判定**的几个条件:
       两眼都可见且齐平、鼻尖朝向镜头、头不转不歪;末尾再补三个否定
       (profile / side view / three-quarter)。 */
    suffix:
      'single front-facing headshot of one person, head and shoulders fully in frame with headroom above the head, facing the camera directly with both eyes level and fully visible and the nose pointing at the camera, head not turned and not tilted, neutral expression, plain background, centered, not a profile, not a side view, not a three-quarter view, the face turned front-on even if the reference image shows the person from the side',
    framing: 'square'
  },
  {
    /* 头部转面:左右正侧 + 上下 45° 俯仰,拼成一张 2×2。
       正脸只管正面那一张脸,"换个方向才看得见"的东西它一个都交代不了:
       正侧交代鼻梁高度、下颌线、耳朵位置与发型的侧面走向;
       俯视交代颅顶与发顶;仰视交代下颌底与鼻底。
       模型拿到这四格,画侧脸、抬头、低头时才不至于把人的脸重新编一个。

       俯仰指的是相机高度(高角度俯拍 / 低角度仰拍),不是让人自己抬低头 ——
       要的是"同一张脸换个方向看",不是四种表情。

       它排在正脸之后:原来这个位置是 3/4,而 3/4 只是"同一个方向的另一张头像",
       与这里第一格的正侧几乎重复;换成转面之后,五格里"脸"这条线才算走完。

       注意 kind 仍叫 detail 而不是 angles:它是索引里的键。
       改名会让库里已经存下的那些 detail 图对不上(见 App 的 loadCharViews
       会按已知 kind 过滤),图还在、但画面上会凭空少一格 */
    kind: 'detail',
    label: 'Angles',
    suffix:
      'a 2x2 turnaround grid of head angles of the same person, head and shoulders in every panel, identical framing, lighting and plain background: left side profile, right side profile, high angle from 45 degrees above eye level, low angle from 45 degrees below eye level, neutral expression',
    framing: 'square'
  },
  {
    kind: 'full',
    label: 'Full body',
    suffix:
      'single full-body shot of one person standing, the whole figure head to toe in frame with a small margin above the head and below the feet, plain background, centered',
    framing: 'portrait'
  },
  {
    /* 四格细部特写:眼睛、皮肤与脸部标记、手、面料与配件。
       这些是前面几张交代不了的 —— 头像里眼睛只占几十个像素,
       机械臂上的纹样、皮衣的缝线更是看不见。模型要画特写时(比如提示词里写
       "close-up of the hands"),没有这几格就只能凭空编,而编出来的
       多半和参考图里不是同一双手。

       四格必须点明"同一人、同一打光、同一背景",否则模型会画成四个不同的人;
       末尾压一句 no text, no labels —— 拼图里最容易被顺手加上的就是标注文字 */
    kind: 'closeups',
    label: 'Details',
    suffix:
      'a 2x2 grid of close-up detail shots of the same person under identical lighting on the same plain background, one detail per panel: the eyes, the skin and any face marks, the hands, the fabric and the accessories described above, no text, no labels',
    framing: 'square'
  },
  {
    /* 四格肢体:手、臂、腿、脚。**它替掉的是原来那张表情 2×2**(2026-10-06)。

       为什么是肢体而不是表情:表情由场景文本决定,从来不是从参考图抄的 ——
       那张图生成出来之后**不进任何一张图**(它在每一条参考图顺序里都排第 5,
       而参考图上限是 4)。而肢体是这条链上唯一**既没有结构化字段、又最常被
       特写**的那一处:提示词只能靠锚点句(七项全是头部特征)和特写那层的一句
       性别兜着,画出来常常不是这个人的手 —— 用户先后报过两次,第二次是
       "明明是女生,生成的手却很粗糙"(见 lib/chatPhoto 的 partLine)。

       它与 closeups 的分工:那张管脸(眼睛、皮肤与脸上的标记、手、面料),
       这张管肢体(手、前臂、腿、脚)。两张都躲不开 2×2 网格那点拼贴先验,
       兜底在提示词的负面层(not a collage, not a contact sheet, no panels)。

       **躯干那一格让给了脚(2026-10-08)**:手与脚是两类最容易画坏、又最常被
       拍成特写的部位,而躯干两样都不是 —— 它不是肢体,也很少被拍成特写;
       体型与服装轮廓另有 full 那张单张全身兜着,build 那项还有文字。
       代价说清:躯干上的疤/纹身从此只剩文字(marks)那一条路,没有视觉依据。

       四格必须点明"同一人、同一打光、同一背景",否则模型会画成四个不同的人 ——
       与 closeups 同一条理由;末尾同样压一句 no text, no labels */
    kind: 'body',
    label: 'Body',
    suffix:
      'a 2x2 grid of close-up body shots of the same person under identical lighting on the same plain background, one part per panel: the hands with their fingers, the forearms, the legs, the bare feet and ankles, identical skin and build in every panel, no text, no labels',
    framing: 'square'
  }
]

/**
 * 一张设定图真正要发出去的提示词:角色设定 + 这一格的取景要求
 * (+ 有参考图时那句"参考图只管脸")。
 *
 * 抽成纯函数是为了能直接断言 —— 这一条的判据是**词**,不是画面:
 * "正面"必须写成可判定的几个条件、且带着那三个否定;有参考图时必须带上
 * "别抄它的姿态"。真正的出图要花钱、要联网,靠手测试不全
 * (用户报"上传的参考图是侧面,生成的正脸也是侧面"时,这两句一句都没有)。
 *
 * @param hasRef 这一次请求带不带参考图。带才说那句话 —— 纯文生图的路说了
 *               反而是噪声(模型会去找一张并不存在的图)
 */
export function characterViewPrompt(
  c: Character,
  kind: CharacterViewKind,
  hasRef = false
): string {
  const view = CHARACTER_VIEWS.find((v) => v.kind === kind)
  if (!view) return ''
  /* 顺序:设定 → 取景 → 参考图那句。
     参考图那句压在最末是有意的,与对话出图那条路的排版同源
     (见 lib/chatPhoto 的 negative 垫在最后):它是**怎么读上面那些话**的元指令,
     不是这一张的内容,排在内容后面才不会把"画什么"挤下去 */
  return [characterDesc(c), view.suffix, hasRef ? REF_IDENTITY_ONLY : '']
    .filter(Boolean)
    .join(', ')
}

/**
 * 用文本模型把一句话拆成角色的结构化设定。
 * 走 /api/enhance 那条路 —— 与提示词改写共用一套代理、鉴权与超时,只是档位不同。
 * 能拆多细取决于用户配的文本模型;返回的字段可能仍为空(模型没按格式回),
 * 那种情况由调用方决定怎么提示。
 *
 * 除结构化设定外还带一个名字:名字不进任何提示词(它是个标识,不是长相描述),
 * 但它是这张卡片的标题、也是"该叫什么"这件事的答案 —— 让模型顺手起一个,
 * 比让用户对着空输入框想一个更省事。起不来时调用方照旧可以手填
 */
export async function draftCharacterFields(
  cfg: ApiConfig,
  idea: string,
  signal?: AbortSignal
): Promise<CharacterDraft> {
  const resp = await fetch('/api/enhance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      prompt: idea,
      mode: 'character',
      textModel: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey
    })
  })
  if (!resp.ok) throw new Error(await failureMessage(resp))
  const data = (await resp.json()) as { prompt?: string }
  return parseCharacterDraft(data.prompt || '')
}

/**
 * 用识图模型把一张参考图读成角色的结构化设定 —— 上传底图之后的那一步。
 *
 * 与 draftCharacterFields 走同一个代理、同一套鉴权与超时,只是档位不同:
 * 这里发的是多模态消息(图 + 一句中性指令),回的是同一份行清单,
 * 所以解析也共用 parseCharacterDraft。
 * 用的是「用途 = 识图」那条配置:能画图的模型未必会看图,两者常常不是同一个服务商。
 */
export async function draftCharacterFromImage(
  cfg: ApiConfig,
  image: string,
  signal?: AbortSignal
): Promise<CharacterDraft> {
  const resp = await fetch('/api/enhance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      mode: 'vision',
      image,
      textModel: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey
    })
  })
  if (!resp.ok) throw new Error(await failureMessage(resp))
  const data = (await resp.json()) as { prompt?: string }
  return parseCharacterDraft(data.prompt || '')
}

/* 起稿模型常把"没有"写成 none / n/a 而不是留空,原样拼进提示词就是一段噪声。
   唯一的例外是 facialHair:那一项里"没有"是有意义的信息(无须),
   转成模型认得的 clean-shaven,其余一律清空 */
const NONE_ISH = /^(none|n\/?a|null|nothing|no|-|—|–)$/i

/* 风格那一栏的"没有"是 **auto** —— 模型可能写成 auto / automatic / default,
   也可能写成"跟着参考图"的整句。它不是一个画风,清空才是对的:
   空串在提示词里会被 filter(Boolean) 滤掉,于是那张图就由参考图说了算 */
const STYLE_AUTO_ISH =
  /^(auto|automatic|default|unspecified|match(es)?( the)? reference( image)?|follows?( the)? reference( image)?|as in the reference( image)?)$/i

/* 语言那一栏同理:它的默认是"跟着用户走",而模型会用好几种说法表达这件事。
   写成这些就等于没填 —— 留着"follow the user"这种话塞进提示词只会变成噪声 */
const LANGUAGE_FOLLOW_ISH =
  /^(auto|automatic|default|unspecified|same as (the )?user|the user'?s language|user'?s language|follows? (the )?user|matches? (the )?user)$/i

/* 表格只建一次:它由那份行定义生成,内容与请求无关 */
const DRAFT_FIELD_KEYS: Record<string, keyof CharacterFields> = {}
const DRAFT_PERSONA_KEYS: Record<string, keyof CharacterPersona> = {}
for (const l of CHAR_SPEC_LINES) {
  /* 查表前把标签里的非字母全部去掉,所以 "Nose & mouth" / "Facial hair" /
     "Face marks" 这类多词标签怎么写都能对上 —— 起稿提示词里用可读的多词标签,
     比为了迁就解析器写成 "NoseMouth" 好得多(人要能直接读懂回的是什么) */
  const k = l.label.toLowerCase().replace(/[^a-z]/g, '')
  if (l.group === 'field') DRAFT_FIELD_KEYS[k] = l.key as keyof CharacterFields
  else if (l.group === 'persona') DRAFT_PERSONA_KEYS[k] = l.key as keyof CharacterPersona
}

/**
 * 把模型回的那几行拆成「名字 + 结构化设定 + 人格」。
 * 它偶尔会加粗、加项目符号、包代码围栏或写中文冒号,所以先剥掉这些装饰再按前缀认;
 * 认不出来的行直接丢掉,不报错 —— 少一两个字段不该让整次起稿失败。
 * 名字那行不一定有(老版本提示词没有它),缺了就是空串,由调用方决定怎么办。
 */
export function parseCharacterDraft(text: string): CharacterDraft {
  const fields = emptyCharFields()
  const persona = emptyCharPersona()
  let name = ''
  /* 两张表的键不重合,所以可以各查各的 ——
     查不到长相那张就再查这张,不必合成一张大表 */
  const keys = DRAFT_FIELD_KEYS
  const personaKeys = DRAFT_PERSONA_KEYS
  for (const raw of text.split('\n')) {
    const line = raw
      // 加粗/斜体/行内代码,以及行首的项目符号与引号
      .replace(/[*`_"']/g, '')
      .replace(/^[\s>•·\-–—]+/, '')
      .trim()
    // 标签段允许空格与 & —— 不允许的话 "Nose & mouth:" 会因为 & 挡住冒号而整行作废
    const m = /^([A-Za-z][A-Za-z &]*?)\s*[:：]\s*(.+)$/.exec(line)
    if (!m) continue
    const label = m[1].toLowerCase().replace(/[^a-z]/g, '')
    const value = m[2].trim()
    if (label === 'name') {
      name = NONE_ISH.test(value) ? '' : value
      continue
    }
    const pkey = personaKeys[label]
    if (pkey) {
      /* 人格那几栏没有"none 要换个说法"的情况 —— 写 none 就是留空 */
      if (NONE_ISH.test(value)) persona[pkey] = ''
      else if (pkey === 'language' && LANGUAGE_FOLLOW_ISH.test(value)) persona[pkey] = ''
      else persona[pkey] = value
      continue
    }
    const key = keys[label]
    if (!key) continue
    if (NONE_ISH.test(value)) {
      fields[key] = key === 'facialHair' ? 'clean-shaven' : ''
    } else if (key === 'style' && STYLE_AUTO_ISH.test(value)) {
      fields[key] = ''
    } else {
      fields[key] = value
    }
  }
  return { name, fields, persona }
}

/** 读出角色列表,并把参考图从 IndexedDB 贴回条目上 */
export async function loadCharacters(): Promise<Character[]> {
  let list: Character[] = []
  try {
    const raw = localStorage.getItem(CHAR_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    // 与作品集同理:本地数据也可能被写坏,不滤一遍会让角色区整块崩掉
    if (!Array.isArray(parsed)) return []
    list = parsed.filter(
      (c): c is Character => !!c && typeof c === 'object' && typeof (c as Character).name === 'string'
    )
  } catch {
    return []
  }
  const refs = await getAllCharRefs()
  for (const c of list) {
    /* 老角色的 fields 里没有后来加的字段(face / brows / noseMouth ...)。
       在入口补齐空串并逐项收成字符串,后面所有读的地方就能当它们一定存在 ——
       不补的话 CharacterFields 这个类型就是在骗人,每读一处都得再防一次 undefined;
       而 localStorage 被同步工具截断或手改时,一个非字符串的值就够让角色页崩掉。
       desc 同理:它要过 inline() 的 replace,值不是字符串一样会抛 */
    if (c.fields) c.fields = coerceCharFields(c.fields)
    if (typeof c.desc !== 'string') delete c.desc
    /* 人格一律补齐(不加 if) —— 与 fields 不同,这里读它的地方(角色页表单与对话页)
       全都当它一定存在来写,补在入口最省事;四项空串也就几十字节 */
    c.persona = coerceCharPersona(c.persona)
    const ref = refs.get(c.id)
    if (ref) c.ref = ref
    // 底图另有 key,不是设定图之一(见 idb.ts 的 charSourceKey)
    const source = refs.get(charSourceKey(c.id))
    if (source) c.sourceRef = source
  }
  return list
}

/** 整份覆盖写回:目录小而全量重写最省心;参考图那边只补新增、删掉已经不在目录里的 */
export async function saveCharacters(list: Character[]): Promise<void> {
  try {
    /* Blob 进不了 JSON(会变成 {}),序列化前必须把两张图从条目上摘掉。
       底图也要摘 —— 漏掉它整条角色都写不进 localStorage,而且是不声不响地失败 */
    localStorage.setItem(
      CHAR_KEY,
      JSON.stringify(list.map(({ ref: _ref, sourceRef: _source, ...rest }) => rest))
    )
  } catch {
    /* ignore: 写不下就不写,下次改动再试 */
  }
  const refs: CharRefRecord[] = []
  for (const c of list) {
    if (c.ref instanceof Blob) refs.push({ id: c.id, data: c.ref })
    if (c.sourceRef instanceof Blob) refs.push({ id: charSourceKey(c.id), data: c.sourceRef })
  }
  await putCharRefs(refs)
}

/* ===== 角色对话 =====================================================
   与出图、改写都不同的一条路:它是流式的。请求从 /api/chat 出去,
   上游的 SSE 已由服务端收窄成"每行一个 JSON"(见 server 的 /api/chat),
   所以这里只需要按行读、逐行解析 —— 不必再解一层 SSE 的框架
   (data: 前缀、事件分隔、注释行,全都省掉了)。

   不能用 EventSource:它只支持 GET,既带不了请求体,也带不了 Authorization
   —— 密钥是每个用户自己配的,必须随请求发,所以这一段只能手写。
   -------------------------------------------------------------------- */

/** 一次对话要交给服务端的角色资料。只取提示词用得上的那几项 ——
 *  逐项面貌特征(face / hair / brows …)是写给图像模型的像素级约束,
 *  对聊天是噪声,还会把话题往长相上引(见 server 的 CHAT_PROMPTS) */
export interface ChatCharacterPayload {
  name: string
  identity: string
  outfit: string
  marks: string
  persona: CharacterPersona
}

/** 一轮最多带多少条历史。更早的不发、也不做摘要(记忆是二期的事)。
 *  取条数而不是字数:条数可预期,而字数要靠额外估算。
 *  20 条大约十轮来回,够撑起一段有来有回的对话 */
export const CHAT_WINDOW = 20

/* 单条消息的字符上限。与 server 的 CHAT_MAX_CHARS 是一对数,改一个要改另一个。
   放在这里是为了让界面在发之前就能拦下并说清楚 ——
   只由服务端切,用户看到的是"我发了一大段,它只回了前半截" */
export const CHAT_MAX_CHARS = 8000

/** 一轮对话收尾时的状态 */
export interface ChatStreamResult {
  /* 上游为什么停下:'stop' 是正常说完,'length' 是撞上了 max_tokens,
     其余按上游原话带回。空串表示上游没给这一项 —— 按正常处理 */
  finish: string
  /* 这一轮的情绪。模型写在回复最末尾的那枚 [mood:xxx],
     由服务端剪下来单独送来 —— 正文里读不到它。
     空串 = 这一轮没给(模型没写,或收在半截上被剪掉了) */
  mood: string
  /* 它这一轮想给你看的画面(场景描述),空串 = 不发图 */
  photo: string
  /* 这张画面里有没有**它本人**。由模型写在标签前缀里(见 server/chatTags.js)。
     true 才把角色设定与设定图发给出图模型 —— 一张风景照带上设定图会被带跑,
     而一张自拍不带设定图就会画成陌生人 */
  photoSelf: boolean
  /* 这一张**谁拿的相机**:'selfie' / 'third' / 空串(模型没说)。
     客户端按"它 → 场景文本 → 默认自拍"定下最终视角(见 lib/chatPhoto) */
  photoShot: string
  /* 这一张**离得多近**:'close' / 'medium' / 'full' / 空串(模型没说)。
     客户端按"它 → 场景文本 → 这一档视角的缺省"定下最终景别(见 lib/chatPhoto
     的 resolveFrame)。它与 photoShot 是同一性质的一位,所以同路送达 */
  photoFrame: string
}

/* ===== 长期记忆的节奏 =================================================
   滑出窗口的消息会被压成一段简报。三个数字决定它什么时候压、压多少。
   -------------------------------------------------------------------- */

/* 攒够多少条"没进摘要"的消息才压一次。取 20(正好一个窗口):
   压完之后未覆盖的剩一个窗口,再攒满一个窗口才压下一次 ——
   也就是大约每 20 条消息多花一次调用,而这一批刚好是一整轮新的对话 */
export const CHAT_SUMMARIZE_AFTER = 20

/* 单次压缩最多吃多少条。正常情况一次只压 20 条 ——
   这个上限是留给"老用户第一次打开记忆"的:他那几千条历史得分几轮才追平,
   一轮吃太多既费钱,压出来的摘要也会糊成一团 */
export const CHAT_SUMMARY_CAP = 300

/**
 * 把一批滑出窗口的消息压进记忆。
 *
 * 系统提示词在服务端(见 server 的 ENHANCE_PROMPTS.summary)—— 与改写、
 * 拆角色同一条分工:改措辞不该要求用户重装前端。这里只负责把
 * "旧记忆 + 这一批消息"摊成一份逐条记录交出去。
 */
export async function summarizeChat(
  cfg: ApiConfig,
  previous: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<string> {
  /* 逐条带上说话人。不带的话模型只看到一堆交错的话,
     分不清承诺是谁许的、又被谁拒绝了 —— 而那正是简报最该留下的东西 */
  const lines = messages.map(
    (m) => `${m.role === 'user' ? 'User' : 'Character'}: ${m.content}`
  )
  const prompt =
    (previous ? `What you already remember:\n${previous}\n\n` : '') +
    `What was said since:\n${lines.join('\n')}`

  const resp = await fetch('/api/enhance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      prompt,
      mode: 'summary',
      textModel: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey
    })
  })
  if (!resp.ok) throw new Error(await failureMessage(resp))
  const data = (await resp.json()) as { prompt?: string }
  const out = typeof data.prompt === 'string' ? data.prompt.trim() : ''
  if (!out) throw new Error('Upstream returned no memory to keep')
  return out
}

/** 把一个角色摊成对话要用的那份资料 */
export function chatPayloadOf(c: Character): ChatCharacterPayload {
  const f = c.fields
  return {
    name: c.name,
    identity: inline(f?.identity),
    outfit: inline(f?.outfit),
    marks: inline(f?.marks),
    persona: coerceCharPersona(c.persona)
  }
}

export interface ChatStreamOpts {
  character: ChatCharacterPayload
  /** 要发出去的历史,已按窗口截好 */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  /* 长期记忆的简报。空串 = 还没压过,服务端据此决定要不要那一段。
     它是"这一整段对话的状态",不属于角色资料,所以与 character 分开传 */
  memory: string
  /* 用户这一轮附的图(data URL)。**只发当前这一条** ——
     历史里那些图不重发:一张图要吃掉上千 token,而窗口有 20 条,
     全发一遍就是几万 token,换来的只是"它还记得你看过那张图" */
  images?: string[]
  /* 上一条消息的时间戳(epoch ms)。服务端据此说"你们上次说话是三天前";
     不给 = 第一次开口,那一句就不出现(见 server/chatTime.js)。
     "现在几点"不用调用方操心 —— 它是**这一刻的事实**,由下面现场取 */
  lastAt?: number
  /* **上一轮那个情绪词**,以及它是什么时候的。它是"它现在是什么心情"的输入 ——
     服务端据此在 system 里补一句,让它带着这个心情回话(见 server/chatMood.js)。
     与 nowLocal 不同,它**必须由调用方给**:服务端手上没有这个状态,只有前端存着
     (IndexedDB 的 char_moods)。
     不给 / 词不合法 / 超过 6 小时,那一段就整块不出现 —— 三种情况都走同一条退路 */
  mood?: { word: string; at: number }
  cfg: ApiConfig
  /** 每一块增量。调用方拿到就往气泡上追加 */
  onDelta: (delta: string) => void
  signal?: AbortSignal
}

/**
 * 发一轮对话。正常收完(或用户点了 Stop)就返回,真出错才抛出。
 *
 * 出错与"按了 Stop"都要由调用方保留已经收到的文本 ——
 * 这一层只如实抛出,绝不回头清理已经交给 onDelta 的内容。
 */
export async function chatStream(opts: ChatStreamOpts): Promise<ChatStreamResult> {
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      character: opts.character,
      messages: opts.messages,
      memory: opts.memory || undefined,
      images: opts.images?.length ? opts.images : undefined,
      /* 本地时刻随请求走。**不放在 ChatStreamOpts 里让调用方传**:
         它是"此刻"的事实,晚一拍都不对,而调用方没有任何理由关心它 */
      nowLocal: localStamp(),
      lastAt: opts.lastAt,
      mood: opts.mood,
      textModel: opts.cfg.model,
      baseUrl: opts.cfg.baseUrl,
      apiKey: opts.cfg.apiKey
    })
  })

  /* 流还没开就失败(没配模型、上游 401、一把 HTML 错误页…):
     服务端这时还没写过任何字节,回的是与其他端点同一形状的 JSON,
     所以这里能复用同一套报错摊平 */
  if (!resp.ok) throw new Error(await failureMessage(resp))

  const reader = resp.body?.getReader()
  if (!reader) throw new Error('This browser cannot read streamed responses')

  const decoder = new TextDecoder()
  /* 一块读进来常常只到半行 —— 按 \n 切开,最后那段不完整的留回缓冲,
     等下一块拼上再解。这个缓冲区比什么都重要:少了它,长回复里
     每隔几个词就会掉一次 JSON.parse */
  let buf = ''
  /* 上游为什么停下。它出现在最后一个数据帧里(finish_reason),
     紧跟 [DONE] 之前 —— 所以得一路记着,等收尾时再报上去。
     丢掉它等于把"正常说完"和"额度用完了"混成同一件事 */
  let finish = ''
  /* 这一轮的情绪。与 finish 同路:服务端在收尾那一帧一起给 ——
     正文里的标签已经被它剪掉了,这里是唯一的来源 */
  let mood = ''
  /* 这一轮它想给你看的画面(服务端从正文末尾剪下来的场景描述) */
  let photo = ''
  /* 这张里有没有它本人。与 photo 同路一起送来 */
  let photoSelf = false
  /* 这一张谁拿的相机(见 ChatStreamResult.photoShot)。与 photo 同路 */
  let photoShot = ''
  /* 这一张离得多近(见 ChatStreamResult.photoFrame)。与 photo 同路 */
  let photoFrame = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trim()
        if (!text) continue
        let evt: {
          delta?: string
          done?: boolean
          error?: string
          finish?: string
          mood?: string
          photo?: string
          photoSelf?: boolean
          photoShot?: string
          photoFrame?: string
        }
        try {
          evt = JSON.parse(text)
        } catch {
          // 半行,或上游塞进来的杂质:跳过就好,不该为一行解不开掐掉整轮回复
          continue
        }
        if (typeof evt.delta === 'string' && evt.delta) opts.onDelta(evt.delta)
        // 错误放在 delta 之后判:上游可能是"说了一半才断",那半句要留住
        if (evt.error) throw new Error(evt.error)
        if (evt.done) {
          return {
            finish: evt.finish || finish,
            mood: evt.mood || mood,
            photo: evt.photo || photo,
            photoSelf: evt.photoSelf === true || photoSelf,
            photoShot: evt.photoShot || photoShot,
            photoFrame: evt.photoFrame || photoFrame
          }
        }
        if (typeof evt.finish === 'string' && evt.finish) finish = evt.finish
        if (typeof evt.mood === 'string' && evt.mood) mood = evt.mood
        if (evt.photoSelf === true) photoSelf = true
        if (typeof evt.photoShot === 'string' && evt.photoShot) photoShot = evt.photoShot
        if (typeof evt.photoFrame === 'string' && evt.photoFrame) photoFrame = evt.photoFrame
      }
    }
  } finally {
    /* 用户按 Stop 时 fetch 会被 abort,而 reader 不会自己放开 ——
       不取消这条读流就悬着。已经读完时取消是空操作 */
    reader.cancel().catch(() => {})
  }
  return { finish, mood, photo, photoSelf, photoShot, photoFrame }
}

/* ===== 提示词库(收藏) ===== */
export const LIB_KEY = 'kimage.prompts'
/* 提示词库的读入规范化。老记录只有一个 category 字符串,新的是 tags 数组;
   两套字段的判断收口在这里,别散到各个组件里去分辨"这条是新的还是旧的"。
   'Uncategorized' 是当初的默认值,不是用户填的,转成标签只会多出一个噪声分类 */
export function normalizePrompt(p: PromptItem): PromptItem {
  const out: PromptItem = { ...p }
  if (!Array.isArray(out.tags)) {
    const legacy = (out.category || '').trim()
    out.tags = legacy && legacy !== 'Uncategorized' ? [legacy] : []
  }
  out.tags = [...new Set(out.tags.map((t) => String(t).trim()).filter(Boolean))]
  delete out.category
  return out
}

/* 读入库。封面不在 localStorage 里(那里只有约 5MB),而是按 id 存在 IndexedDB;
   所以这里要异步,并把封面贴回条目上。
   老数据(以及旧版导出文件)把封面写成条目里的 thumb —— data URL,而且是当年
   为了挤进 5MB 压到 320px 的缩略图。读到这里顺手转成 Blob 搬进 IDB,
   并从条目里摘掉,否则它一直占着那 5MB 不撒手。旧封面糊就糊了,没法凭空变清楚 */
export async function loadPrompts(): Promise<PromptItem[]> {
  let list: PromptItem[] = []
  try {
    const raw = localStorage.getItem(LIB_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    // 存的是本地数据,但别信它一定是好的:被写坏(同步工具截断、手改)时
    // 直接当数组用会让整个库页崩掉,这里滤一遍,坏项丢掉即可
    if (!Array.isArray(parsed)) return []
    list = parsed
      .filter(
        (p): p is PromptItem =>
          !!p && typeof p === 'object' && typeof (p as PromptItem).prompt === 'string'
      )
      .map(normalizePrompt)
  } catch {
    return []
  }

  const covers = await getAllCovers()
  let legacy = false
  for (const item of list) {
    const thumb = typeof item.thumb === 'string' ? item.thumb : ''
    if (thumb.startsWith('data:image/')) {
      legacy = true
      // 库里已经有这条封面(上次搬运成功过)就以库里那份为准
      if (!covers.has(item.id)) {
        try {
          covers.set(item.id, await urlToBlob(thumb))
        } catch {
          /* 转不出来:这条没封面,不影响其余 */
        }
      }
    }
    delete item.thumb
    const cover = covers.get(item.id)
    if (cover) item.cover = cover
  }
  if (legacy) {
    try {
      await putCovers([...covers].map(([id, data]) => ({ id, data })))
      /* 目录单独写,不走 savePrompts:那条路会按"条目里现存的封面"反向裁剪 IDB,
         而这里条目的封面还没摘(内存里要留着给界面用),一裁就把刚搬进去的全删了 */
      localStorage.setItem(LIB_KEY, JSON.stringify(slimList(list)))
    } catch {
      /* 搬不过去就先算了:下次加载会再试一遍,条目里那份还在,数据不会丢 */
    }
  }
  return list
}

/** 目录:localStorage 只存这个(没有封面,每条几百字节) */
function slimList(list: PromptItem[]): PromptItem[] {
  return list.map((item) => {
    const copy = { ...item }
    delete copy.cover
    delete copy.thumb
    return copy
  })
}

/** 封面:按 id 进 IndexedDB */
function coversOf(list: PromptItem[]): CoverRecord[] {
  return list
    .filter((i): i is PromptItem & { cover: Blob } => i.cover instanceof Blob)
    .map((i) => ({ id: i.id, data: i.cover }))
}

/* 存回库。封面与目录分开写:localStorage 只留目录(小),封面按 id 进 IndexedDB。
   以前两者都在 localStorage 里,装不下时只能整批丢封面 —— 去掉封面之后
   每条只剩几百字节,那一整套"逐级丢封面"的降级路径也就不需要了。
   返回 false 表示有东西没落盘,界面据此提示 */
export async function savePrompts(list: PromptItem[]): Promise<boolean> {
  const covers = coversOf(list)
  let ok = true
  try {
    await ensurePersisted()
    // 顺带清掉已经不在库里的封面:删掉一条提示词,它的封面不该永远留在这儿
    await putCovers(covers)
  } catch {
    ok = false
  }
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(slimList(list)))
  } catch {
    // 连目录都写不下(现实里到不了:去掉封面后每条只有几百字节),如实返回失败
    ok = false
  }
  return ok
}

