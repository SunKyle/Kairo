import type { ApiConfig } from '../types'

/* ===== 厂商能力表 =====================================================
   各家的扩展参数、尺寸取值、图生图端点都不一样,集中在这里声明,
   界面按它决定显示什么、代理按它决定打哪个端点。
   要支持新厂商,或某家改了规则,只改这一处。
   -------------------------------------------------------------------- */
export type Cap = 'yes' | 'no' | 'unknown'

/* 出图走哪套协议。不是"厂商"的另一种说法 —— 同一家中转上,
   OpenAI 系模型打 /images/generations,Gemini 系模型得打原生的
   :generateContent,两条路的请求体和响应体都不一样 */
export type Protocol = 'openai' | 'gemini'

export interface Provider {
  id: string
  label: string
  baseUrl: string
  model: string
  quality: Cap
  background: Cap
  /** 允许的尺寸;'free' 表示由接口自行决定 */
  sizes: string[] | 'free'
  /* 上游有没有"尺寸由它自己定"这一档,**以及怎么表达**。
     'literal' = 直接发 size:"auto" 就是那个意思(OpenAI、Gemini 那套);
     'omit'    = 有,但表达方式是**不发这个字段**。豆包是这一家:它的 size 只认
                 分辨率档位(1K/1.5K/2K)或像素值,字面量 "auto" 是图层分解那个
                 场景才有的取值;而不发 size 时走它的默认档(5.0 pro/flash 是 2K),
                 比例由提示词里怎么描述决定 —— 于是"让模型自己定"在这里
                 就等于把字段摘掉(见 sizeFieldFor);
     'no'      = 没有这一档,候选列表里不能出现 auto,
                 否则界面在骗人,发出去的请求跟没选一样 */
  autoSize: 'literal' | 'omit' | 'no'
  /** 图生图打哪个端点 */
  edit: 'generations' | 'edits'
  protocol: Protocol
  /* 接口认不认 `response_format`(图是"给链接"还是"给 base64")。
     不是可有可无的一项:**默认值是 url**,而那张链接是给浏览器之外的地方下载的 ——
     前端拿到它还得再跨域拉一次,被挡或过期就只剩一句"图不可用"(实测豆包就是这样)。
     认这一项的厂商要显式要 `b64_json`,图跟着响应一起回来,没有第二跳。
     OpenAI 的 gpt-image-1 标 'no':它本来就只回 b64_json,而这个参数它不收
     (发了会被拒),和 quality/background 一样属于"另一套 API 才有的字段" */
  responseFormat: Cap
  /* 接口认不认 seed。OpenAI 的 Images API 没有这个参数,标 'no' ——
     界面就不会给出一个填了也白发、甚至被 400 拒掉的输入框。
     未知的按 'unknown' 处理:填了就照发,由上游自己决定收不收 */
  seed: Cap
  /* 认不认多张参考图。标 'no' 的只送一张 ——
     设定图那条流水线会退化成"只拿正脸当参考"(见 App 的 genCharView),
     而不是发两张过去把整个请求弄失败。
     未知的按"能发就发"处理,与上面几项一致:这里只拦明确知道的单图模型 */
  multiImage: Cap
  /* 接口认不认 `watermark` 这一项 —— 也就是"这枚水印我盖不盖"的开关。
     它和上面几项有个要命的差别:**上游的默认值是"盖"**。Ark(豆包 Seedream)
     不回 watermark 就在图角留下一枚"AI生成",而提示词里写多少句
     no watermark 都管不着它 —— 那句是给画画的模型看的,管不了上游在出图
     之后自己盖上去的那一层。

     取值只标求证过的:'yes' = 有这一项、且默认开着(必须显式传 false 才不盖);
     'no' = 求证过没有(OpenAI 的 Images API 与 Gemini 原生协议都没有这个字段,
     发了会被拒);'unknown' = 不知道。

     **只有 'yes' 才发** —— 这一项的取舍与 quality/background 正好相反:
     那两个值是用户自己填的,未知厂商按"填了就发"如实转发;而 watermark 是
     **我们**主动塞进去的,平白给一家未必认它的中转多塞一个字段,会把本来
     能用的配置打成 400(服务端对 unknown parameter 的那句解释就是为此) */
  watermark: Cap
  /* 接口认不认 `n`(一次要几张)。Ark 的图片 API 里没有这个字段 ——
     它的多图是 sequential_image_generation,所以标 'no' 的那一家只能摘掉,
     暂时一次只出一张(要真接上,得按模型分档:4.0/4.5/5.0-lite 支持 sequential,
     5.0 pro/flash 连它也不支持)。

     注意这里问的是"要不要把 n 交给这一条路",不是"上游 schema 里有没有 n":
     Gemini 的原生请求体里同样没有 n,但它由服务端翻成 candidateCount,
     所以那一栏是 'yes' —— 摘掉了就等于把"要几张"整个丢掉 */
  n: Cap
  /* 参考图怎么交给上游。'multipart' = 表单里的文件字段(OpenAI 的 /images/edits
     只认这个);'json' = 请求体里的 image 字段,收 data URL 或公网 URL
     (Ark 的 image 就是 string|string[])。
     这是**如实上报厂商的规矩**,由代理按它决定拼哪种请求体 —— 与 protocol 同理 */
  refs: 'json' | 'multipart'
}

// 兜底项:baseUrl 认不出来时的归宿
const CUSTOM: Provider = {
  id: 'custom',
  label: 'Custom / OpenAI-compatible',
  baseUrl: '',
  model: '',
  // 未知厂商一律按"不确定"处理:照常展示参数,但不静默丢弃
  quality: 'unknown',
  background: 'unknown',
  seed: 'unknown',
  /* 认不出来的地址不猜:万一是家中转,多塞一个它不认的字段就整条 400,
     而它默认盖不盖水印我们并不知道。真想关,把厂商那一栏选成 Ark */
  watermark: 'unknown',
  /* 认不出来的地址不猜:见 watermark 那段 —— 未知厂商不塞我们没验证过的字段 */
  responseFormat: 'unknown',
  /* 认不出的地址按 OpenAI 兼容那套(它本来就是这里的兜底对象) */
  n: 'unknown',
  refs: 'multipart',
  /* 未知厂商按"发"处理:中转站背后多数是能收多张的 OpenAI / Gemini 系,
     真发错了上游会报错说清楚,而静默退回单图是用户看不见的信息损失 */
  multiImage: 'unknown',
  sizes: 'free',
  /* 未知厂商按"认 auto"处理:这里的兜底对象就是 OpenAI 兼容代理,
     如实转发比静默降级好 —— 真发错了会报错提示,而静默丢掉参数只会让人
     以为模型没按 prompt 定比例 */
  autoSize: 'literal',
  edit: 'generations',
  protocol: 'openai'
}

/* Gemini 出图:走原生 :generateContent,不是 OpenAI 的 /images/generations。
   实测(2026-09,对一家中转):原生路径同步返回,出图在
   candidates[].content.parts[].inlineData.data,宽高比走
   generationConfig.imageConfig.aspectRatio —— 传 2:3 拿到 848×1264。
   注意不要用它的 OpenAI 兼容层:那条路上中转会回
   "Images API is not supported for this platform" */
const GEMINI: Provider = {
  id: 'gemini',
  label: 'Google Gemini',
  /* 主机根地址,不带版本号:原生路径由代理拼成
     {baseUrl}/v1beta/models/{model}:generateContent。
     中转站也按同一套拼(前提是把中转地址填成它的根,如 https://xxx.com),
     所以同一条预设同时服务"Google 直连"和"中转"两种填法 */
  baseUrl: 'https://generativelanguage.googleapis.com',
  model: 'gemini-2.5-flash-image',
  /* 原生请求体里根本没有 quality / background 这两个字段,多给一个未知字段
     会被 Google 拒掉。标成不支持,界面就不会给出按不动的开关 */
  quality: 'no',
  background: 'no',
  /* 原生的 generationConfig 里有 seed 字段,但图像模型认不认没有实测过,
     所以标 unknown(填了就发),不假装支持也不假装不支持 */
  seed: 'unknown',
  // 原生请求体的 parts 里可以并列多段 inlineData,多张参考图是它本来就认的形态
  multiImage: 'yes',
  // 原生协议里没有"水印开关"这个字段,它是另一套(OpenAI 形状)请求体的事
  watermark: 'no',
  // 原生协议回的是 inlineData,没有 response_format 这一项
  responseFormat: 'no',
  /* 原生请求体里没有 n,但服务端会把它翻成 generationConfig.candidateCount,
     所以这一栏要的是"把张数交上去" */
  n: 'yes',
  // 参考图在原生协议里是 parts 里的 inlineData,不走表单文件字段
  refs: 'json',
  /* 给的都是能干净约分成 Gemini 认的宽高比的档位(见 server 的 GEMINI_RATIOS):
     1024x1024→1:1、1536x1024→3:2、1024x1536→2:3、1536x864→16:9、864x1536→9:16。
     约不出来的值不发这个参数,不做隐式近似。

     这里原来是 1792x1024 与 1024x1792,标注说它们是 16:9 与 9:16 ——
     实际约分是 **7:4 与 4:7**,两者都不在表里,于是"选了宽幅"的结果是
     这个参数根本不发,Gemini 退回它自己的 16:9 默认值。换掉它们。 */
  sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '1536x864', '864x1536'],
  /* 实测:不发宽高比时它自己给 16:9,所以 auto 是实打实的"模型自决",不是空话 */
  autoSize: 'literal',
  /* 这个字段只对 OpenAI 那条路有意义(决定打 /images/edits 还是 /images/generations)。
     Gemini 的图生图不是换端点,而是在同一个 :generateContent 的 parts 里多给一段
     inlineData,由代理按协议分支处理,所以这里填什么都用不上 */
  edit: 'generations',
  protocol: 'gemini'
}

export const PROVIDERS: Provider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    quality: 'yes',
    background: 'yes',
    // Images API 没有 seed 参数(那是 ChatGPT 界面里的东西),发了只会被拒
    seed: 'no',
    // /images/edits 的 image[] 本来就收多张;dall-e-2 时代只收一张,但那条路已经不用了
    multiImage: 'yes',
    // gpt-image 的请求体里没有 watermark 这一项(它的水印是走 C2PA 元数据另说的)
    watermark: 'no',
  // gpt-image-1 只回 b64_json,且不收 response_format(发了会被拒)
  responseFormat: 'no',
    // Images API 收 n(gpt-image-1 实际上只出 1 张,但字段本身在)
    n: 'yes',
    // /images/edits 的参考图必须是表单里的文件字段,data URL 会被拒
    refs: 'multipart',
    sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
    autoSize: 'literal',
    edit: 'edits',
    protocol: 'openai'
  },
  {
    id: 'ark',
    label: 'Doubao Seedream (Volcengine Ark)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-3-0-t2i',
    quality: 'no',
    background: 'no',
    // Ark 认不认 seed 没有实测过:按"填了就发"处理,真被拒了上游会报错
    seed: 'unknown',
    // Seedream 的图像编辑只收一张参考图
    multiImage: 'no',
    /* Ark 的图片生成请求体里有 watermark,**默认 true** —— 不显式传 false,
       出图右下角就一定挂着一枚"AI生成"。这是上游盖的,与提示词无关 */
    watermark: 'yes',
  /* 默认就回链接(url),而那张链接前端还得再跨域拉一次 —— 要显式换成 base64 */
  responseFormat: 'yes',
    /* Ark 的请求体里**没有 n**:多图走 sequential_image_generation
       (且只有 4.0/4.5/5.0-lite 支持)。发 n 过去就是无效参数,整条 400 ——
       摘掉之后这一家一次只出一张,"张数"那一栏对它暂时无效 */
    n: 'no',
    /* 参考图走请求体里的 image 字段:官方写的是 string|string[],
       内容是 data:image/...;base64,... 或公网 URL。
       **它不收表单文件字段** —— 从前的 multipart 那条路对它是打不通的 */
    refs: 'json',
    sizes: 'free',
    /* Ark **认**"尺寸由它自己定"这一档,但表达方式是**不发 size**:官方请求体里
       size 是可选的,不发就走默认档(5.0 pro/flash 是 2K,4.0 是 2048x2048),
       比例由提示词里怎么描述决定。字面量 "auto" 只属于图层分解那个场景,
       发到普通出图上不是被忽略就是报错 —— 所以这里是 'omit' 不是 'literal' */
    autoSize: 'omit',
    edit: 'generations',
    protocol: 'openai'
  },
  {
    id: 'dashscope',
    label: 'Tongyi Wanxiang (Bailian)',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'wanx2.1-t2i-turbo',
    quality: 'no',
    background: 'no',
    // 同 Ark:没有实测过,按"填了就发"处理
    seed: 'unknown',
    // 万相的图像编辑同样是单图
    multiImage: 'no',
    /* 万相也有 watermark,但它**默认就是 false** —— 没有要去掉的东西,
       也就不必发;没实测过它的字段名,标成 unknown 正好不发 */
    watermark: 'unknown',
  // 万相那边同样没实测过,不塞未知字段
  responseFormat: 'unknown',
    // 万相收 n(1~4 张)
    n: 'yes',
    // 参考图交法与 OpenAI 那套一致(表单文件字段),暂不改动
    refs: 'multipart',
    sizes: 'free',
    // 万相的 size 同样是枚举,没有 auto 档
    autoSize: 'no',
    edit: 'generations',
    protocol: 'openai'
  },
  GEMINI,
  CUSTOM
]

/* Gemini 系图像模型的模型名:各家中转给它们起的别名五花八门(banana2-4k、
   nano-banana-pro…),但都绕不开这几个词根 */
const GEMINI_IMAGE_RE = /^(gemini|imagen|banana|nano-?banana)/i

/* 能力表按 (厂商, 模型) 解析,不只是厂商 ——
   中转站自己就是看模型名决定后端的,我们必须跟它一致:同一个地址上,
   OpenAI 系模型走 /images/generations,Gemini 系模型走原生 :generateContent,
   判错就会打到对方不实现的那条路上(实测会回
   "Images API is not supported for this platform")。
   model 参数可选,不传时退回按厂商判断 */
export function getProvider(id: string | undefined, model = ''): Provider {
  const p = PROVIDERS.find((x) => x.id === id)
  if (!p) return CUSTOM
  if (p.id === 'custom' && GEMINI_IMAGE_RE.test(model)) return GEMINI
  return p
}

/** 老配置没有 vendor 字段时按域名猜,省得用户重配一遍 */
export function inferVendor(baseUrl: string): string {
  const h = (baseUrl || '').toLowerCase()
  /* gemini 必须排在 openai 前面:Gemini 的 OpenAI 兼容层地址是
     .../v1beta/openai,含 "openai" 这个词,顺序反了就会把它当成 OpenAI,
     于是尺寸候选、quality/background 门控、出图协议全都按错的那家来。
     只认 generativelanguage(AI Studio 的 Gemini API 主机),故意不认
     aiplatform.googleapis.com —— 那是 Vertex,鉴权要 GCP access token、
     模型名还带 google/ 前缀,和这里不是一套,硬认出来只会误导 */
  if (h.includes('generativelanguage')) return 'gemini'
  if (h.includes('openai')) return 'openai'
  if (h.includes('deepseek')) return 'deepseek'
  if (h.includes('volces') || h.includes('ark.cn')) return 'ark'
  if (h.includes('dashscope') || h.includes('aliyun')) return 'dashscope'
  return 'custom'
}

/** OpenAI 两代模型认的尺寸不同,这里再细分一层;其余厂商不限 */
export function allowedSizes(vendorId: string | undefined, model: string): string[] | 'free' {
  if (vendorId === 'openai') {
    return /dall-e-3/i.test(model || '')
      ? ['1024x1024', '1792x1024', '1024x1792']
      : ['auto', '1024x1024', '1536x1024', '1024x1536']
  }
  return getProvider(vendorId).sizes
}

/* ===== 尺寸与扩展参数：按能力决定「能不能」与「发什么」 ==================
   这些判断原来散在主界面里(尺寸候选、默认档、手填尺寸归一、种子、扩展参数、
   对比出图时逐个厂商校验、角色设定图的取景尺寸),而它们全都是"看厂商能力表
   说话",与界面无关。收在这里还有一层实际好处:**能直接单测** —— 以前这些
   分支要开一个浏览器、再配一条对应厂商的接口才碰得到。
   -------------------------------------------------------------------- */

/** 配置的厂商 id。老配置没有这个字段时按域名回填(见 inferVendor) */
export function vendorOf(cfg: ApiConfig): string {
  return cfg.vendor || inferVendor(cfg.baseUrl)
}

/* 厂商不限尺寸时给的一组常用值。
   顺序即优先级:不认 auto 的厂商会把 auto 摘掉,剩下的第一项就成了默认尺寸,
   所以按"最常用"排而不是按尺寸递增 —— 1024x1024 是这类接口的通用默认值,
   排在 512x512 前面,免得摘掉 auto 之后默认掉到 512 去 */
export const FREE_SIZES = ['auto', '1024x1024', '1024x1792', '1792x1024', '512x512', '2560x1440']

/** 把手填的尺寸归一成 `1024x1536`:容忍 × ✕ * 与空格;认不出来返回 null
 *  (不做隐式猜测 —— 猜错等于替用户改了画幅) */
export function normalizeSize(raw: string): string | null {
  if (/^auto$/i.test(raw)) return 'auto'
  const m = raw
    .replace(/[×✕*]/g, 'x')
    .replace(/\s+/g, '')
    .match(/^(\d{1,5})x(\d{1,5})$/i)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  return w > 0 && h > 0 ? `${w}x${h}` : null
}

/** 这家厂商在这个模型下到底认哪些尺寸。
 *  不认 auto 的厂商要把它摘掉:留着它,界面会显示"自动",而请求里根本带不了
 *  这个参数(带了就 400),于是每次都拿上游的默认尺寸 —— 看起来像"模型没按
 *  prompt 定比例",其实是我们自己把这一档抹掉了 */
export function sizeOptionsFor(vendorId: string | undefined, model: string): string[] {
  const list = allowedSizes(vendorId, model)
  const base = Array.isArray(list) ? list : FREE_SIZES
  const mode = getProvider(vendorId, model).autoSize
  if (mode === 'no') return base.filter((s) => s !== 'auto')
  /* 'omit' 那种厂商把 auto 摆在**末位**:它在豆包那儿的意思不是"随手上游"，
     而是"我一个字段都不发,按上游默认出图" —— 而那个默认是 2K。出图按像素
     计费,2K 差不多是 1024×1024 的**四倍**。排头会被当成兜底档(候选对不上时
     界面取第一档),那就成了"用户什么都没选,却按最贵的那档出图" */
  if (mode === 'omit') {
    return base.includes('auto') ? [...base.filter((s) => s !== 'auto'), 'auto'] : [...base]
  }
  return base
}

/** 尺寸是否由上游自定(= 界面上开放手填)。固定候选的厂商不开放手填:
 *  列表里的值已经是全部合法值 */
export function sizeIsFree(vendorId: string | undefined, model: string): boolean {
  return allowedSizes(vendorId, model) === 'free'
}

/**
 * 套用某个尺寸(从提示词库取用、或复现某条记录时):能用就返回归一后的值,
 * 不能用返回 null —— 由界面保留当前值。宁可不改,也不塞一个发出去会被拒的档位。
 *
 * 两个坑都在这里堵住:
 * - `auto` 不在尺寸列表里,它是"让上游自己定"这一档**能力**:
 *   dall-e-3 与豆包都不认它(豆包收到枚举外的值直接 400)
 * - 不限尺寸的厂商要的是像素值,而历史里存着的可能是 `1536 × 1024` 这种写法
 */
export function acceptableSize(cfg: ApiConfig, want: string | undefined): string | null {
  if (!want) return null
  const vendor = vendorOf(cfg)
  const options = sizeOptionsFor(vendor, cfg.model)
  /* auto 的可用与否只看**档位列表**里有没有它,不看厂商级那个 autoSize 标志:
     openai 的 autoSize 是 true(那是给 gpt-image-1 的),而 dall-e-3 的档位列表
     里根本没有 auto —— 这两处要是各判各的,就会放行一个发出去必被拒的值 */
  if (want === 'auto') return options.includes('auto') ? 'auto' : null
  if (sizeIsFree(vendor, cfg.model)) return normalizeSize(want)
  return options.includes(want) ? want : null
}

/** 默认尺寸:有 auto 档就用 auto,否则用第一档。
 *  基线不能用字面量 'auto' —— dall-e-3 不开放 auto,初始化会被换成它的第一档,
 *  拿 'auto' 当基线会让这家厂商一进页面参数行就亮着。
 *
 *  `omit` 那种厂商例外(豆包):它的 auto 是"不发 size、按上游默认出图",而那个
 *  默认是 2K —— 出图按像素计费,差不多是 1024×1024 的四倍。用户没选过就不该
 *  替他选最贵的那档,所以退到第一档**显式**尺寸。 */
export function defaultSizeFor(
  options: string[],
  autoMode: Provider['autoSize'] = 'literal'
): string {
  if (autoMode === 'omit') return options.find((s) => s !== 'auto') || options[0] || 'auto'
  return options.includes('auto') ? 'auto' : options[0] || 'auto'
}

/**
 * 交给上游的 size 值。
 *
 * 界面上的 `'auto'` 是"尺寸让上游自己定"这一档**能力**,而各家表达它的方式不一样:
 * 'literal' 的厂商就发字面量 "auto";'omit' 的厂商(豆包)要的是**把字段摘掉** ——
 * 发空串,代理见到空值就不往请求体里放 size(见 server 的 `...(size ? {size} : {})`)。
 * 把 "auto" 原样发过去是错的:那个字面量只属于它的图层分解场景。
 */
export function sizeFieldFor(cfg: ApiConfig, size: string): string {
  const caps = getProvider(vendorOf(cfg), cfg.model)
  return size === 'auto' && caps.autoSize === 'omit' ? '' : size
}

/**
 * 在候选里挑比例最接近 wantRatio 的那一档。
 *
 * 比的是比例的**对数距离**:1:1 偏到 2:1 和偏到 1:2 该算同样的偏差,
 * 而直接减差值做不到这一点(0.5 比 2 更靠近 1,于是方图会被判给竖幅)。
 * 认不出的候选(如 'auto')跳过;一个都挑不出来时返回 ''。
 */
export function sizeClosestTo(candidates: string[], wantRatio: number): string {
  if (!(wantRatio > 0)) return ''
  let best = ''
  let gap = Infinity
  for (const s of candidates) {
    const m = String(s).match(/^(\d{1,5})x(\d{1,5})$/i)
    if (!m) continue
    const w = Number(m[1])
    const h = Number(m[2])
    if (!(w > 0 && h > 0)) continue
    /* 差距量化到 1e-9 再比:对数距离在"横竖对称"的两个候选上只差最后一位
       (实测 log(1.75) 与 |log(1/1.75)| 差 1.1e-16),不量化的话平手由浮点
       末位决定 —— 同一组候选换个顺序就换一个结果,而两者本来同样远 */
    const d = Math.round(Math.abs(Math.log(w / h / wantRatio)) * 1e9) / 1e9
    if (d < gap) {
      gap = d
      best = s
    }
  }
  return best
}

/**
 * 某个厂商要用的尺寸:不限尺寸就原样用 want;固定候选的厂商则退回它的第一档
 * (对比出图时逐个模型校验用 —— 各模型支持的尺寸本来就不完全重合)。
 * 注意它与 allowedSizeFor 的差别:那个是按比例挑最接近的一档(编辑用,
 * 因为"保持原画幅"比"必须等于某个值"重要),这里是"不在列表里就退回默认"。
 */
export function sizeForVendor(cfg: ApiConfig, want: string): string {
  const allowed = allowedSizes(vendorOf(cfg), cfg.model)
  if (allowed === 'free') return want
  return allowed.includes(want) ? want : allowed[0] || 'auto'
}

/** 种子:留空、认不出、或厂商明确不支持时返回 undefined(= 交给上游随机)。
 *  范围按 32 位有符号整数收 —— 各家都在这条线以内,更大的值上游只当非法 */
export function seedFor(cfg: ApiConfig, raw: string): number | undefined {
  const t = String(raw ?? '').trim()
  if (!t) return undefined
  const v = Math.round(Number(t))
  if (!Number.isFinite(v) || Math.abs(v) > 2147483647) return undefined
  return getProvider(vendorOf(cfg), cfg.model).seed === 'no' ? undefined : v
}

/** 按厂商能力决定携带哪些扩展参数:已知不支持的一律不发。
 *  默认按当前生效配置算;对比出图时逐个传入 —— 同一次对比里各模型的可用参数
 *  并不一样(OpenAI 认 quality,豆包不认),不能拿一家的能力套所有家 */
export function extraParamsFor(
  cfg: ApiConfig,
  quality: string,
  background: string
): Record<string, string> {
  const caps = getProvider(vendorOf(cfg), cfg.model)
  const out: Record<string, string> = {}
  if (caps.quality !== 'no' && quality !== 'auto') out.quality = quality
  if (caps.background !== 'no' && background !== 'auto') out.background = background
  return out
}

/**
 * **对话出图那两条路**(角色发的那张照片 + 沉浸页那张背景图)要带哪些扩展参数。
 *
 * —— 这个函数存在的全部理由,是**它的签名里没有 background** ——
 *
 * 那两条路原先和创作区共用同一个调用:`extraParamsFor(cfg, 'high', background.value)`。
 * 那个 `background.value` 是**创作区面板上的一项**(见 useGeneration 里那个 ref,
 * 默认 'auto' 表示不发)。于是用户在创作区把它设成非 auto 之后,对话里的图也会
 * 跟着带上 —— 与当初那个 quality 的毛病是同一类(对话出图不该继承创作区的参数),
 * 只是这一次**不会报错**:一张"背景透明"的人物照只是看着不对。
 *
 * 参数从签名里拿掉之后,那条路就再也漏不进来了 —— 这比在调用处写一句注释
 * "记得传 auto" 可靠。画质那一项仍然照旧走能力表(豆包/万相不认这个字段,
 * 一个字节都不发),所以它不能直接写死进请求体。
 */
export function chatExtraParams(cfg: ApiConfig): Record<string, string> {
  return extraParamsFor(cfg, CHAT_PHOTO_QUALITY, 'auto')
}

/** 对话出图固定用的画质档。与创作区那一档同名同值,不引入新枚举;
 *  它不跟创作区的选择走 —— 对话这条路没有让用户选过画质 */
export const CHAT_PHOTO_QUALITY = 'high'

/**
 * 上游自己盖在图角上的那枚水印,要不要请它别盖。
 *
 * 只有明确知道"有这一项、且默认开着"的厂商才发(见能力表的 watermark):
 * Ark(豆包 Seedream)是这一类,不回它就在右下角挂一枚"AI生成"。
 * 其余厂商一律不发 —— 我们不知道那个字段存不存在,而为一个开关把整条请求
 * 打成 400 不划算(这与 quality/background 的取舍相反:那两个是用户填的值,
 * 未知厂商如实转发)。
 *
 * 返回的是要并进请求体的那几项,形状与 extraParamsFor 一致,便于在
 * generate 一处摊开。
 */
export function watermarkParamFor(cfg: ApiConfig): Record<string, boolean> {
  const caps = getProvider(vendorOf(cfg), cfg.model)
  return caps.watermark === 'yes' ? { watermark: false } : {}
}

/**
 * 请求体里那几项"要按厂商决定带不带"的字段。
 *
 * 与 `extraParamsFor` 的取舍不同:quality/background 是**用户填的**扩展项,
 * 不填就不发;而这里几项是**每次请求都会带上去**的固定字段 —— 上游不认,
 * 整条请求就是 400。所以判据必须硬:只有确认对方有这个字段才发。
 * (Ark 的图片 API 里既没有 `quality` 也没有 `n`,这两样都栽过。)
 *
 * @param n 一次要几张。各家表达方式不一样:OpenAI/百炼收 `n`,
 *          Ark 用 `sequential_image_generation`(目前没接),
 *          Gemini 由服务端翻成 candidateCount —— 所以它要的仍是这个数。
 */
export function providerBodyFields(cfg: ApiConfig, n: number): Record<string, unknown> {
  const caps = getProvider(vendorOf(cfg), cfg.model)
  return {
    /* 没有这个字段的那一家就摘掉,而不是留一个它不认的键把请求打坏。
       代价写在能力表的 n 上:Ark 那边"张数"暂时只会出一张 */
    ...(caps.n === 'no' ? {} : { n }),
    /* 要 base64,不要链接。上游默认回的是**图片链接**(豆包就是 url),
       那张链接前端还得再跨域拉一次 —— 被挡或过期就只剩一句"图不可用"。
       显式要 b64_json 就没有第二跳了(见能力表的 responseFormat) */
    ...(caps.responseFormat === 'yes' ? { responseFormat: 'b64_json' } : {}),
    ...watermarkParamFor(cfg)
  }
}

/* ===== 对话模型预设(提示词增强 + 角色对话) ==========================
   服务于表单里「用途 = text / chat」时的预设行。与出图的 PROVIDERS 分开:
   两者要填的模型不是一回事(出图填图像模型,这里填对话模型),
   共用一份预设会互相误导。
   改写与对话共用同一份,是因为**它们要的就是同一种东西** ——
   一个能走 /chat/completions 的对话模型,地址也同源;分成两张一样的表
   只会让同一条地址抄两遍,改一处漏一处。
   地址与出图厂商同源,但百炼要单独列一条 —— 它的 /api/v1 是原生协议,
   对话得走 /compatible-mode/v1,填错会直接 404。
   -------------------------------------------------------------------- */
export interface TextProvider {
  id: string
  label: string
  baseUrl: string
  /* 推荐模型。留空表示这家没有能安全写死的默认值:模型名多带日期版本号,
     写死很快过期,不如留空让用户自己填 */
  model?: string
}

export const TEXT_PROVIDERS: TextProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  {
    /* DeepSeek 没有出图模型,所以它只在这一份预设里,不进 PROVIDERS ——
       出图那行给出一个画不了图的选项等于骗人。
       deepseek-flash 是 V4.1-Flash,文本与图片输入共用同一个模型名;
       旧的 deepseek-chat / deepseek-reasoner 已退役,只是名字还被兼容路由 */
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash'
  },
  {
    id: 'dashscope-compat',
    label: 'Bailian (compatible mode)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus'
  },
  {
    id: 'ark',
    label: 'Volcengine Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3'
  }
]

/* ===== 识图(把参考图读成角色设定)的模型预设 ==========================
   与上面两表又不同:这里要的是"能看图的对话模型"。
   识图与改写、对话走同一条路(/chat/completions + 一条 user 消息),差别只在
   消息的 content 里多带一张图 —— 所以地址格式与 TEXT_PROVIDERS 完全一致,
   百炼同样要列 compatible-mode 那条(原生 /api/v1 是另一套协议)。
   出图那侧的图像模型帮不上忙:能画图的未必能看图。
   -------------------------------------------------------------------- */
export const VISION_PROVIDERS: TextProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  {
    id: 'dashscope-compat',
    label: 'Bailian (compatible mode)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max'
  },
  {
    /* Ark 的模型名常常是推理接入点 id(ep-…),写死一个公开模型名只是给个起点 */
    id: 'ark',
    label: 'Volcengine Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-1.5-vision-pro'
  },
  {
    /* 2026-09-10 起 deepseek-flash(V4.1-Flash)原生支持图片输入;
       上一代的 deepseek-v4-flash-vision-exp 已下线,兼容路由到它。
       同厂的 deepseek-v4-pro 明确不支持视觉,所以别写它 */
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash'
  }
]

/* ===== 扩展参数的取值与界面文案 =====================================
   放在这里是为了让主界面和历史预览共用同一份文案,避免两处各写一套
   后出现「面板显示低、预览显示 low」这类不一致。
   ------------------------------------------------------------------ */
export const QUALITY_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]
export const BACKGROUND_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'transparent', label: 'Transparent' },
  { value: 'opaque', label: 'Opaque' }
]

/** 取值 → 界面文案;认不出来的值原样返回,不至于显示空白 */
export function optionLabel(list: Array<{ value: string; label: string }>, v?: string) {
  if (!v) return ''
  return list.find((o) => o.value === v)?.label || v
}
