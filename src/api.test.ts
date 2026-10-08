import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
  CHARACTER_VIEWS,
  CHAT_PHOTO_QUALITY,
  FREE_SIZES,
  REF_IDENTITY_ONLY,
  acceptableSize,
  asConfigKind,
  characterViewPrompt,
  chatExtraParams,
  configKindOf,
  defaultSizeFor,
  extraParamsFor,
  getProvider,
  mergeHistory,
  normalizeSize,
  PHOTO_ERROR_CHARS,
  photoFailureText,
  pickActiveByKind,
  providerBodyFields,
  readCharacterZip,
  seedFor,
  sizeClosestTo,
  sizeFieldFor,
  sizeForVendor,
  shouldProcessNow,
  sizeIsFree,
  sizeOptionsFor,
  thumbsToFill,
  watermarkParamFor
} from './api'
import type { ApiConfig, Character, HistoryEntry } from './types'
/* 上限的**权威定义**在服务端那一层(剪标签用的就是它)。
   这个测试要断的正是"读回来的长度等于那个权威值",所以直接引它 */
import { PHOTO_SCENE_CHARS } from '../server/chatTags.js'

/* 造一条配置。只有 id 与 kind 参与挑选,其余字段给最小值即可 */
function cfg(id: string, kind?: ApiConfig['kind']): ApiConfig {
  return { id, name: id, baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm', kind }
}

describe('configKindOf · 用途归一', () => {
  it('缺省(加 kind 之前存下来的老配置)按出图算', () => {
    expect(configKindOf(cfg('a'))).toBe('image')
  })

  it('五类原样返回', () => {
    for (const k of ['image', 'text', 'chat', 'vision', 'tts'] as const) {
      expect(configKindOf(cfg('a', k))).toBe(k)
    }
  })

  /* 用途从四处长到五处时,那串嵌套三元收成了这一张白名单 */
  it('认得出的原样返回,认不出的(脏数据 / 缺字段)一律出图', () => {
    for (const k of ['image', 'text', 'chat', 'vision', 'tts'] as const) {
      expect(asConfigKind(k)).toBe(k)
    }
    expect(asConfigKind(undefined)).toBe('image')
    expect(asConfigKind('')).toBe('image')
    // 外部文件里可能出现别的写法:不该让它错类,更不该让它消失
    expect(asConfigKind('Chat')).toBe('image')
    expect(asConfigKind('audio')).toBe('image')
  })
})

describe('pickActiveByKind · 按用途挑当前生效的那条', () => {
  it('存着的 id 命中且用途一致时,就用它', () => {
    const list = [cfg('a', 'image'), cfg('b', 'image')]
    expect(pickActiveByKind(list, 'image', 'b')?.id).toBe('b')
  })

  it('存着的 id 已不存在时,退到同类第一条', () => {
    const list = [cfg('a', 'image'), cfg('b', 'image')]
    expect(pickActiveByKind(list, 'image', 'gone')?.id).toBe('a')
  })

  it('存着的 id 被改成别的用途后不再命中,退到同类第一条', () => {
    // b 原来是出图配置,用户把它改成了朗读
    const list = [cfg('a', 'image'), cfg('b', 'tts')]
    expect(pickActiveByKind(list, 'image', 'b')?.id).toBe('a')
  })

  /* 这一组是本次修复的核心:原来的谓词写作 `kind !== 'text'`,
     于是只配了朗读配置时,朗读那条会被挑成"当前出图配置" */
  it('出图只认 kind === image,不会把 tts / vision / chat 配置挑进来', () => {
    expect(pickActiveByKind([cfg('a', 'tts')], 'image', 'a')).toBeUndefined()
    expect(pickActiveByKind([cfg('a', 'vision')], 'image', 'a')).toBeUndefined()
    expect(pickActiveByKind([cfg('a', 'text')], 'image', 'a')).toBeUndefined()
    // 对话配置尤其不能:它也是个对话模型,拿它出图必错(它排在列表里也最常见)
    expect(pickActiveByKind([cfg('a', 'chat')], 'image', 'a')).toBeUndefined()
    // 混在一起时挑到的是真正的出图那条,而不是排在前面那些
    const mixed = [cfg('t', 'tts'), cfg('c', 'chat'), cfg('v', 'vision'), cfg('i', 'image')]
    expect(pickActiveByKind(mixed, 'image', '')?.id).toBe('i')
  })

  it('老配置没有 kind 字段时按出图参与挑选', () => {
    const list = [cfg('legacy'), cfg('t', 'tts')]
    expect(pickActiveByKind(list, 'image', '')?.id).toBe('legacy')
  })

  it('每一类各自挑各自的,互不串台', () => {
    const list = [
      cfg('i', 'image'),
      cfg('x', 'text'),
      cfg('c', 'chat'),
      cfg('v', 'vision'),
      cfg('s', 'tts')
    ]
    expect(pickActiveByKind(list, 'image', '')?.id).toBe('i')
    expect(pickActiveByKind(list, 'text', '')?.id).toBe('x')
    /* 对话与改写都在列表里时,专配的对话那条要被认出来 ——
       "借用改写那条"是 useConfigs 里的兜底,不是这一层的退让:
       这里若挑错,借来的配置会把专配的那条顶掉 */
    expect(pickActiveByKind(list, 'chat', '')?.id).toBe('c')
    expect(pickActiveByKind(list, 'vision', '')?.id).toBe('v')
    expect(pickActiveByKind(list, 'tts', '')?.id).toBe('s')
  })

  it('没有对话配置时这一类挑不出来(借用由上层决定,不在这里假装有)', () => {
    const list = [cfg('i', 'image'), cfg('x', 'text')]
    expect(pickActiveByKind(list, 'chat', '')).toBeUndefined()
    // 存着的对话 id 指向一条已改成改写的配置时,同样挑不出来
    expect(pickActiveByKind([cfg('x', 'text')], 'chat', 'x')).toBeUndefined()
  })

  it('列表为空、或这一类一条都没有时返回 undefined', () => {
    expect(pickActiveByKind([], 'image', 'a')).toBeUndefined()
    expect(pickActiveByKind([cfg('x', 'text')], 'tts', 'x')).toBeUndefined()
  })
})

/* ===== T2.3 尺寸与扩展参数门控 =====
   这些判断原来散在主界面里，要开浏览器 + 配一条对应厂商的接口才碰得到 */

function imgCfg(over: Partial<ApiConfig> = {}): ApiConfig {
  return { id: 'i', name: 'i', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-image-1', ...over }
}

describe('normalizeSize · 手填尺寸归一', () => {
  it('容忍 × ✕ * 大写与空格', () => {
    expect(normalizeSize('1536×1024')).toBe('1536x1024')
    expect(normalizeSize('1536 ✕ 1024')).toBe('1536x1024')
    expect(normalizeSize(' 1536 * 1024 ')).toBe('1536x1024')
    expect(normalizeSize('1536X1024')).toBe('1536x1024')
  })

  it('auto 单独成档', () => {
    expect(normalizeSize('Auto')).toBe('auto')
    expect(normalizeSize('AUTO')).toBe('auto')
  })

  it('认不出来就返回 null —— 不隐式猜测(猜错等于替用户改了画幅)', () => {
    for (const bad of ['', 'abc', '1024', '1024x', 'x1024', '1024x0', '0x1024', '1024x1024x2']) {
      expect(normalizeSize(bad), bad).toBeNull()
    }
  })
})

describe('sizeOptionsFor · 这家厂商认哪些尺寸', () => {
  it('豆包也有"让模型自己定"这一档,只是表达方式是**不发** size(见 autoSize)', () => {
    expect(sizeOptionsFor('ark', 'doubao-seedream-5-0-flash-260915')).toContain('auto')
  })

  it('豆包那一档排在末位 —— 它的 auto 等于"按上游默认出图"(2K,按像素计费)', () => {
    // 排头就会被当成兜底档,于是"用户什么都没选"变成"按最贵的那档出图"
    const opts = sizeOptionsFor('ark', 'x')
    expect(opts[opts.length - 1]).toBe('auto')
    expect(opts[0]).toBe('1024x1024')
  })

  it('认 auto 的厂商保留它', () => {
    expect(sizeOptionsFor('openai', 'gpt-image-1')).toContain('auto')
    expect(sizeOptionsFor('gemini', 'gemini-2.5-flash-image')).toContain('auto')
  })

  it('OpenAI 两代模型给的档位不同(dall-e-3 没有 auto、也没有 1536 那几档)', () => {
    expect(sizeOptionsFor('openai', 'gpt-image-1')).toEqual([
      'auto',
      '1024x1024',
      '1536x1024',
      '1024x1536'
    ])
    expect(sizeOptionsFor('openai', 'dall-e-3')).toEqual(['1024x1024', '1792x1024', '1024x1792'])
  })

  it('不限尺寸的厂商拿到的是一组常用值(而不是空列表)', () => {
    // 未知厂商按"认 auto"处理,于是原样拿到整份
    expect(sizeOptionsFor('custom', 'x')).toEqual(FREE_SIZES)
    // 认不出的厂商(自定义中转)按字面量那套原样给
    expect(sizeOptionsFor(undefined, 'x')).toEqual(FREE_SIZES)
  })

  it('没有这一档的厂商被摘掉 auto(留着它会显示"自动"却带不了这个参数)', () => {
    expect(sizeOptionsFor('dashscope', 'wanx2.1-t2i-turbo')).not.toContain('auto')
  })

  it('Gemini 的档位都能干净约成它认的宽高比(约不出来的会被服务端丢掉比例)', () => {
    // 服务端只认这几个比例字符串(见 server 的 GEMINI_RATIOS)
    const ok = new Set(['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
    for (const s of sizeOptionsFor('gemini', 'gemini-2.5-flash-image')) {
      if (s === 'auto') continue
      const [w, h] = s.split('x').map(Number)
      const d = gcd(w, h)
      expect(ok.has(`${w / d}:${h / d}`), s).toBe(true)
    }
  })
})

describe('sizeIsFree / defaultSizeFor', () => {
  it('不限尺寸 ⇔ 界面开放手填', () => {
    expect(sizeIsFree('ark', 'x')).toBe(true)
    expect(sizeIsFree('custom', 'x')).toBe(true)
    expect(sizeIsFree('openai', 'gpt-image-1')).toBe(false)
    expect(sizeIsFree('gemini', 'x')).toBe(false)
  })

  it('默认档:有 auto 用 auto,没有就用第一档(不能拿字面量 auto 当基线)', () => {
    expect(defaultSizeFor(['auto', '1024x1024'])).toBe('auto')
    expect(defaultSizeFor(['1024x1024', '1792x1024'])).toBe('1024x1024')
    expect(defaultSizeFor([])).toBe('auto')
  })
})

describe('sizeClosestTo · 按比例挑最接近的一档', () => {
  it('命中同一比例时直接选它', () => {
    expect(sizeClosestTo(['1024x1024', '1536x1024', '1024x1536'], 3 / 2)).toBe('1536x1024')
    expect(sizeClosestTo(['1024x1024', '1536x1024', '1024x1536'], 2 / 3)).toBe('1024x1536')
  })

  /* 这条是"为什么用对数距离"的判别用例:
     对 1:1 的目标,2:1 与 1:2 应当算同样远 —— 于是平手,谁排在前面选谁。
     换成直接减差值就做不到:0.5 比 2 更靠近 1,横档永远输给竖档,
     于是一张方图会被判给竖幅 */
  it('方图目标下横档与竖档同样远(平手由顺序决定)', () => {
    const wide = '1792x1024'
    const tall = '1024x1792'
    expect(sizeClosestTo([wide, tall], 1)).toBe(wide)
    expect(sizeClosestTo([tall, wide], 1)).toBe(tall)
  })

  it('角色全身像(2:3)在不限尺寸的厂商那里选到竖档', () => {
    expect(sizeClosestTo(FREE_SIZES, 2 / 3)).toBe('1024x1792')
  })

  it('认不出的档位跳过;一个都挑不出来时返回空串', () => {
    expect(sizeClosestTo(['auto', 'weird'], 1)).toBe('')
    expect(sizeClosestTo([], 1)).toBe('')
    expect(sizeClosestTo(['auto'], 0)).toBe('')
  })
})

describe('sizeForVendor · 对比出图时逐个模型校验', () => {
  it('不限尺寸的厂商原样用', () => {
    expect(sizeForVendor(imgCfg({ vendor: 'ark', model: 'x' }), '999x111')).toBe('999x111')
  })

  it('在列表里就用它', () => {
    expect(sizeForVendor(imgCfg({ vendor: 'openai' }), '1536x1024')).toBe('1536x1024')
  })

  it('不在列表里退回它的第一档(而不是硬发一个它不认的值)', () => {
    expect(sizeForVendor(imgCfg({ vendor: 'openai' }), '999x999')).toBe('auto')
    expect(sizeForVendor(imgCfg({ vendor: 'openai', model: 'dall-e-3' }), 'auto')).toBe('1024x1024')
  })

  it('老配置没有 vendor 时按域名回填,判断跟着走', () => {
    expect(sizeForVendor(imgCfg({ vendor: undefined, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }), '2560x1440')).toBe('2560x1440')
  })
})

describe('seedFor · 种子发不发', () => {
  it('留空 / 认不出 / 超范围一律不发(= 交给上游随机)', () => {
    const cfg = imgCfg({ vendor: 'ark' })
    expect(seedFor(cfg, '')).toBeUndefined()
    expect(seedFor(cfg, '   ')).toBeUndefined()
    expect(seedFor(cfg, 'abc')).toBeUndefined()
    expect(seedFor(cfg, '99999999999')).toBeUndefined()
  })

  it('厂商明确不认 seed 时不发(OpenAI 的 Images API 没有这个参数)', () => {
    expect(seedFor(imgCfg({ vendor: 'openai' }), '42')).toBeUndefined()
  })

  it('标 unknown 的厂商填了就发(不假装支持、也不假装不支持)', () => {
    expect(seedFor(imgCfg({ vendor: 'ark' }), '42')).toBe(42)
    expect(seedFor(imgCfg({ vendor: 'gemini' }), ' 7 ')).toBe(7)
  })

  it('小数收敛成整数,负数原样接受(上游自己判合法性)', () => {
    expect(seedFor(imgCfg({ vendor: 'ark' }), '3.7')).toBe(4)
    expect(seedFor(imgCfg({ vendor: 'ark' }), '-12')).toBe(-12)
  })
})

describe('extraParamsFor · 按能力决定带哪些扩展参数', () => {
  it('不支持的厂商一项都不带', () => {
    expect(extraParamsFor(imgCfg({ vendor: 'ark' }), 'high', 'transparent')).toEqual({})
    expect(extraParamsFor(imgCfg({ vendor: 'gemini' }), 'high', 'transparent')).toEqual({})
  })

  it('支持的厂商带上非默认值', () => {
    expect(extraParamsFor(imgCfg({ vendor: 'openai' }), 'high', 'transparent')).toEqual({
      quality: 'high',
      background: 'transparent'
    })
  })

  it('默认档不发(发了等于把 auto 显式传给上游)', () => {
    expect(extraParamsFor(imgCfg({ vendor: 'openai' }), 'auto', 'auto')).toEqual({})
    expect(extraParamsFor(imgCfg({ vendor: 'openai' }), 'high', 'auto')).toEqual({ quality: 'high' })
  })

  it('老配置按域名回填后同样受能力表约束', () => {
    const legacy = imgCfg({ vendor: undefined, baseUrl: 'https://api.openai.com/v1' })
    expect(extraParamsFor(legacy, 'low', 'auto')).toEqual({ quality: 'low' })
  })
})

/* ===== 对话出图那两条路的扩展参数(2026-10-06) =====
   角色发的那张照片 + 沉浸页那张背景图。它们原先与创作区共用同一个调用 ——
   第三个参数传的是**创作区面板上那个 background**,于是用户在那儿把它设成
   transparent,对话里的图也跟着透明。与当初那个 quality 的毛病是同一类
   (对话出图不该继承创作区的参数),只是这次**不报错**,只是图不对。
   这里钉住的是"那两类图一个 background 都不带",而不是"记得传 auto" ——
   判据落在一个**签名里没有 background** 的函数上,改不回去。 */

describe('chatExtraParams · 对话出图不继承创作区那几项', () => {
  it('创作区那一项非默认时,那两条路照旧不带它', () => {
    expect(chatExtraParams(imgCfg({ vendor: 'openai' }))).toEqual({ quality: CHAT_PHOTO_QUALITY })
    /* 对照:创作区那一路**会**带上它 —— 那才是被隔离掉的东西 */
    expect(extraParamsFor(imgCfg({ vendor: 'openai' }), 'high', 'transparent')).toEqual({
      quality: 'high',
      background: 'transparent'
    })
  })

  it('画质那一档仍然照旧过能力表 —— 不认它的厂商一个字段都不发', () => {
    expect(chatExtraParams(imgCfg({ vendor: 'ark' }))).toEqual({})
    expect(chatExtraParams(imgCfg({ vendor: 'gemini' }))).toEqual({})
  })

  it('老配置按域名回填后同样受约束', () => {
    expect(chatExtraParams(imgCfg({ vendor: undefined, baseUrl: 'https://api.openai.com/v1' }))).toEqual({
      quality: CHAT_PHOTO_QUALITY
    })
  })
})

/* 水印这件事只有一条规矩要紧:**Ark 必须收到 false**。
   它的 watermark 默认是 true,不显式关掉,图角那枚"AI生成"就一直在,
   而提示词里写多少句 no watermark 都管不着上游事后盖上去的那一层。
   反过来说,别的厂商一项都不该收到:它们没有这个字段,
   多塞一个未知字段会把本来能用的配置打成 400 */
describe('watermarkParamFor · 只有认这一项的厂商才收到 false', () => {
  it('Ark 收到 false(它默认是 true,不发就等于一直带着水印)', () => {
    expect(watermarkParamFor(imgCfg({ vendor: 'ark', model: 'doubao-seedream-3-0-t2i' }))).toEqual({
      watermark: false
    })
  })

  it('老配置没写 vendor 时,按域名认出 Ark 也照样关', () => {
    const legacy = imgCfg({
      vendor: undefined,
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seedream-4-0-250828'
    })
    expect(watermarkParamFor(legacy)).toEqual({ watermark: false })
  })

  it('不认这一项的厂商一项都不带(凭空多一个字段会被拒)', () => {
    expect(watermarkParamFor(imgCfg({ vendor: 'openai' }))).toEqual({})
    expect(watermarkParamFor(imgCfg({ vendor: 'gemini' }))).toEqual({})
  })

  /* 认不出来的地址按 unknown 处理:我们并不知道那家有没有这个字段,
     而这是**我们**主动塞进去的值,赌错了会把整条请求打 400
     (与 quality / background 相反 —— 那两个是用户填的,未知厂商如实转发) */
  it('认不出的自定义中转不赌:宁可有水印,也别把能用的配置打坏', () => {
    expect(watermarkParamFor(imgCfg({ vendor: 'custom', model: 'some-relay-model' }))).toEqual({})
    expect(
      watermarkParamFor(imgCfg({ vendor: undefined, baseUrl: 'https://relay.example.com/v1' }))
    ).toEqual({})
  })
})

/* 豆包那 400 的第二个成因:**Ark 的图片 API 里没有 n**。
   它的请求体只有 model / prompt / image / size / seed / guidance_scale /
   watermark / response_format / sequential_image_generation…,多图靠
   sequential_image_generation 表达。照旧把 n 发过去就是无效参数,整条被拒 ——
   而且是**每一次**都被拒,不分文生图还是图生图。 */
describe('providerBodyFields · n 只发给认它的那几家', () => {
  it('Ark 不带 n(它没有这个字段),水印照关,并改成要 base64', () => {
    expect(
      providerBodyFields(imgCfg({ vendor: 'ark', model: 'doubao-seedream-5-0-flash-260915' }), 1)
    ).toEqual({ responseFormat: 'b64_json', watermark: false })
  })

  it('OpenAI / 百炼 / 认不出的中转照旧带 n', () => {
    expect(providerBodyFields(imgCfg({ vendor: 'openai' }), 4)).toEqual({ n: 4 })
    expect(providerBodyFields(imgCfg({ vendor: 'dashscope' }), 2)).toEqual({ n: 2 })
    expect(providerBodyFields(imgCfg({ vendor: 'custom' }), 3)).toEqual({ n: 3 })
  })

  /* Gemini 的原生请求体里同样没有 n,但它由服务端翻成 candidateCount ——
     所以这一栏要的是"把张数交上去",摘掉才是错的 */
  it('Gemini 仍要交出张数(服务端拿它当 candidateCount)', () => {
    expect(providerBodyFields(imgCfg({ vendor: 'gemini' }), 2)).toEqual({ n: 2 })
  })

  /* 默认回的是**图片链接**,而前端拿到链接还得再跨域拉一次 ——
     被挡或 24 小时过期就只剩一句"图不可用"(实测豆包就是这一条)。
     认 response_format 的厂商直接要 base64,省掉那一跳 */
  it('只有认 response_format 的厂商才被要 base64', () => {
    expect(providerBodyFields(imgCfg({ vendor: 'ark' }), 1).responseFormat).toBe('b64_json')
    expect(providerBodyFields(imgCfg({ vendor: 'openai' }), 1).responseFormat).toBeUndefined()
    expect(providerBodyFields(imgCfg({ vendor: 'gemini' }), 1).responseFormat).toBeUndefined()
    expect(providerBodyFields(imgCfg({ vendor: 'dashscope' }), 1).responseFormat).toBeUndefined()
    expect(providerBodyFields(imgCfg({ vendor: 'custom' }), 1).responseFormat).toBeUndefined()
  })

  it('两项可以同时成立:OpenAI 收 n、不收 watermark', () => {
    expect(providerBodyFields(imgCfg({ vendor: 'openai' }), 1)).toEqual({ n: 1 })
  })
})

/* 参考图的交法也不是全球统一的:OpenAI 的 /images/edits 只收表单文件字段,
   而 Ark 的 image 是请求体里的 string|string[](data URL)。
   交错了的表现是"带参考图就报参数错误" —— 纯文生图反而是好的。 */
describe('能力表 · 参考图走哪种请求体', () => {
  it('OpenAI 走表单文件字段', () => {
    expect(getProvider('openai').refs).toBe('multipart')
  })

  it('豆包走请求体里的 image(data URL),不是文件字段', () => {
    expect(getProvider('ark').refs).toBe('json')
  })

  it('认不出的中转保持原样(表单),不替它改道', () => {
    expect(getProvider('custom').refs).toBe('multipart')
    expect(getProvider(undefined).refs).toBe('multipart')
  })
})

describe('acceptableSize · 套用历史/库里的尺寸', () => {
  it('认枚举的厂商:列表里的能套,列表外的不套(保留当前值)', () => {
    const dallE = imgCfg({ vendor: 'openai', model: 'dall-e-3' })
    expect(acceptableSize(dallE, '1792x1024')).toBe('1792x1024')
    expect(acceptableSize(dallE, '1536x1024')).toBeNull() // 那是 gpt-image-1 的档
    expect(acceptableSize(dallE, '999x999')).toBeNull()
    expect(acceptableSize(dallE, undefined)).toBeNull()
  })

  /* 这一条是补的洞:auto 不在任何列表里,它是"让上游自己定"这一档能力。
     以前只查列表,于是存着 auto 的记录套到豆包那种认枚举尺寸的配置上,
     会把 auto 原样发出去 —— 而它收到枚举外的值直接 400 */
  it('没有这一档的厂商:套用 auto 要被拒(dall-e-3、百炼)', () => {
    expect(acceptableSize(imgCfg({ vendor: 'openai', model: 'dall-e-3' }), 'auto')).toBeNull()
    expect(acceptableSize(imgCfg({ vendor: 'dashscope', model: 'wanx2.1-t2i-turbo' }), 'auto')).toBeNull()
  })

  it('认 auto 的厂商照常接受', () => {
    expect(acceptableSize(imgCfg({ vendor: 'openai', model: 'gpt-image-1' }), 'auto')).toBe('auto')
    expect(acceptableSize(imgCfg({ vendor: 'gemini', model: 'x' }), 'auto')).toBe('auto')
    expect(acceptableSize(imgCfg({ vendor: 'custom', model: 'x' }), 'auto')).toBe('auto')
    /* 豆包也在这一档里 —— 它表达 auto 的方式是"不发 size",不是发字面量 */
    expect(
      acceptableSize(imgCfg({ vendor: 'ark', model: 'doubao-seedream-5-0-flash-260915' }), 'auto')
    ).toBe('auto')
  })

  it('不限尺寸的厂商:像素值照收,并顺手归一(历史里可能是 1536 × 1024)', () => {
    const ark = imgCfg({ vendor: 'ark', model: 'x' })
    expect(acceptableSize(ark, '1920x1080')).toBe('1920x1080')
    expect(acceptableSize(ark, '1536 × 1024')).toBe('1536x1024')
    expect(acceptableSize(ark, 'weird')).toBeNull()
  })
})

/* "让上游自己定尺寸"这一档能力,各家表达的方式不一样。
   豆包要的是**把 size 字段整个摘掉**(官方请求体里 size 是可选的,不发就走
   默认档 2K,比例由提示词决定);把字面量 "auto" 发过去是错的 —— 那个取值
   只属于它的图层分解场景。 */
describe('sizeFieldFor · "自动"这一档到底发什么', () => {
  it('豆包:auto 转成空串(代理见到空值就不往请求体里放 size)', () => {
    const ark = imgCfg({ vendor: 'ark', model: 'doubao-seedream-5-0-flash-260915' })
    expect(sizeFieldFor(ark, 'auto')).toBe('')
  })

  it('豆包:显式尺寸原样发', () => {
    const ark = imgCfg({ vendor: 'ark', model: 'doubao-seedream-5-0-flash-260915' })
    expect(sizeFieldFor(ark, '1024x1792')).toBe('1024x1792')
  })

  it('字面量那几家:auto 就是 auto', () => {
    expect(sizeFieldFor(imgCfg({ vendor: 'openai' }), 'auto')).toBe('auto')
    expect(sizeFieldFor(imgCfg({ vendor: 'gemini' }), 'auto')).toBe('auto')
    expect(sizeFieldFor(imgCfg({ vendor: 'custom' }), 'auto')).toBe('auto')
    expect(sizeFieldFor(imgCfg({ vendor: 'custom' }), '1536x1024')).toBe('1536x1024')
  })

  it('老配置没写 vendor 时,按域名认出豆包也走摘字段那条', () => {
    const legacy = imgCfg({
      vendor: undefined,
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seedream-4-0-250828'
    })
    expect(sizeFieldFor(legacy, 'auto')).toBe('')
  })
})

describe('defaultSizeFor · 没被选过时不该替用户挑最贵的那档', () => {
  it('豆包:退到第一档显式尺寸,而不是 auto(它的 auto = 上游默认 2K,按像素计费)', () => {
    const opts = sizeOptionsFor('ark', 'x')
    expect(defaultSizeFor(opts, 'omit')).toBe('1024x1024')
    expect(defaultSizeFor(opts, 'omit')).not.toBe('auto')
  })

  it('字面量那几家照旧:有 auto 就用 auto', () => {
    expect(defaultSizeFor(sizeOptionsFor('openai', 'gpt-image-1'), 'literal')).toBe('auto')
    expect(defaultSizeFor(sizeOptionsFor('openai', 'dall-e-3'), 'literal')).toBe('1024x1024')
  })

  it('没这一档的厂商退到第一档', () => {
    expect(defaultSizeFor(sizeOptionsFor('dashscope', 'wanx2.1-t2i-turbo'), 'no')).toBe('1024x1024')
  })

  it('不给模式时按旧口径(有 auto 就用 auto)', () => {
    expect(defaultSizeFor(['auto', '1024x1024'])).toBe('auto')
  })
})

describe('thumbsToFill · 该给哪些记录补缩略图', () => {
  function rec(id: string, hasThumb: boolean): HistoryEntry {
    return {
      id,
      prompt: id,
      size: '1024x1024',
      createdAt: 0,
      results: [],
      ...(hasThumb ? { thumb: new Blob(['x']), w: 10, h: 10 } : {})
    } as HistoryEntry
  }

  it('只挑缺缩略图或尺寸的,并保持原顺序(新→旧)', () => {
    const list = [rec('a', true), rec('b', false), rec('c', true), rec('d', false)]
    expect(thumbsToFill(list).map((e) => e.id)).toEqual(['b', 'd'])
  })

  /* 这条是行为修正:原来是"扫前 N 条、遇到不缺的就跳过",
     于是前 N 条都补好时什么也不做,后面的照样缺 */
  it('前面都已补好时,照样去补后面的(先筛后取,不是先取后筛)', () => {
    const list = [rec('a', true), rec('b', true), rec('c', true), rec('d', false)]
    expect(thumbsToFill(list, 2).map((e) => e.id)).toEqual(['d'])
  })

  it('上限只限制"要补的条数",不限制扫描范围', () => {
    const list = Array.from({ length: 10 }, (_, i) => rec(`e${i}`, false))
    expect(thumbsToFill(list, 3)).toHaveLength(3)
  })

  it('都补好了就返回空(不必再逐条解码)', () => {
    expect(thumbsToFill([rec('a', true)])).toEqual([])
  })

  it('尺寸缺一项也算缺(图墙按真实比例排版要用)', () => {
    const half = { ...rec('h', false), thumb: new Blob(['x']) } as HistoryEntry
    expect(thumbsToFill([half]).map((e) => e.id)).toEqual(['h'])
  })
})

describe('shouldProcessNow · 空闲回调的余量判断', () => {
  it('余量够就做', () => {
    expect(shouldProcessNow(12, false)).toBe(true)
    expect(shouldProcessNow(4, false)).toBe(true)
  })

  it('余量不够就让给这一帧(用户正在滚动时那一帧要拿去画)', () => {
    expect(shouldProcessNow(3.9, false)).toBe(false)
    expect(shouldProcessNow(0, false)).toBe(false)
  })

  it('被 timeout 叫起来的照做 —— 否则一直不做', () => {
    expect(shouldProcessNow(0, true)).toBe(true)
  })

  it('阈值可覆盖', () => {
    expect(shouldProcessNow(5, false, 8)).toBe(false)
    expect(shouldProcessNow(9, false, 8)).toBe(true)
  })
})

describe('mergeHistory · 另一页改了历史之后怎么合', () => {
  function rec(id: string, createdAt: number, over: Partial<HistoryEntry> = {}): HistoryEntry {
    return { id, prompt: id, size: '1024x1024', createdAt, results: [], ...over } as HistoryEntry
  }

  it('库里有的以库为准(库是正本)', () => {
    const db = [rec('a', 3, { prompt: 'from db' })]
    const mem = [rec('a', 3, { prompt: 'stale in memory' })]
    expect(mergeHistory(db, mem, new Set()).map((h) => h.prompt)).toEqual(['from db'])
  })

  /* 这条是"幽灵条目"的关卡:库里没有、也不在写 = 别的标签页删了它 */
  it('库里没有、也没在写的丢掉(别处删了它)', () => {
    const db = [rec('a', 3)]
    const mem = [rec('a', 3), rec('gone', 2)]
    expect(mergeHistory(db, mem, new Set()).map((h) => h.id)).toEqual(['a'])
  })

  /* 这条是"刚落盘还没落地"的关卡:整份替换会把界面上这一条抹掉 */
  it('库里没有、但正在写的保住', () => {
    const db = [rec('a', 3)]
    const mem = [rec('a', 3), rec('in-flight', 5)]
    const out = mergeHistory(db, mem, new Set(['in-flight']))
    expect(out.map((h) => h.id)).toEqual(['in-flight', 'a'])
  })

  it('结果按时间倒序 —— 与 loadHistory 的顺序一致', () => {
    const db = [rec('a', 1), rec('b', 9), rec('c', 5)]
    expect(mergeHistory(db, [], new Set()).map((h) => h.id)).toEqual(['b', 'c', 'a'])
  })

  it('两边都空就是空', () => {
    expect(mergeHistory([], [], new Set())).toEqual([])
  })

  it('不改动传入的数组', () => {
    const db = [rec('a', 1)]
    const mem = [rec('b', 2)]
    mergeHistory(db, mem, new Set(['b']))
    expect(db.map((h) => h.id)).toEqual(['a'])
    expect(mem.map((h) => h.id)).toEqual(['b'])
  })
})

/* ===== 出图失败时给用户看哪句话 ======================================
 *  从前 `generateChatPhoto` 把任何异常都吞成 `undefined`,界面只能说
 *  "生成失败"。而失败的原因彼此差得很远(配置没填完 / 密钥不对 / 上游 5xx /
 *  内容被安全策略拦 / 存储满了),每种要用户做的事都不一样。
 *
 *  这一层只判两件事,都是**判据**而不是文案:
 *  中止不算失败、空话不算原因。 */

describe('photoFailureText · 中止与空话都要有说法', () => {
  it('上游的原话原样透出 —— 那是最有用的一句', () => {
    expect(photoFailureText(new Error('Upstream returned an error (401)'))).toBe(
      'Upstream returned an error (401)'
    )
  })

  it('**用户按了停止不算失败** —— 说成"生成失败"会让人去查配置', () => {
    const abort = new Error('The operation was aborted.')
    abort.name = 'AbortError'
    expect(photoFailureText(abort)).toContain('Stopped')
    /* 不能带着"失败"的语气,否则用户会以为是模型坏了 */
    expect(photoFailureText(abort)).not.toContain('failed')
  })

  it('没有消息的异常不至于只显示一个空字符串', () => {
    expect(photoFailureText(new Error(''))).toBe('Generation failed.')
    expect(photoFailureText(undefined)).toBe('Generation failed.')
    expect(photoFailureText(null)).toBe('Generation failed.')
    expect(photoFailureText('   ')).toBe('Generation failed.')
  })

  it('不是 Error 的值也能说出一句(上游偶尔抛字符串)', () => {
    expect(photoFailureText('boom')).toBe('boom')
  })

  it('换行与连续空白压成一个空格 —— 它要渲染成一行', () => {
    expect(photoFailureText(new Error('line one\n\n  line two'))).toBe('line one line two')
  })

  it('超长截断 —— 上游的堆栈可能几千字', () => {
    expect(photoFailureText(new Error('x'.repeat(2000))).length).toBe(PHOTO_ERROR_CHARS)
  })
})

describe('characterViewPrompt · 设定图的提示词', () => {
  /* 用户 2026-10-05 报:"上传的参考图是侧面图,则生成的正面图也是侧面的"。
     根因不是"正面"没写(那句一直在),而是**参考图在 i2i 那条路上是最强的
     机位来源** —— 一句 front-facing 拗不过它。所以这一组钉两件事:
     正面要写成可判定的条件 + 三个否定;有参考图时必须说清"它只管脸"。 */
  const c: Character = {
    id: 'x',
    name: 'Nova',
    createdAt: 0,
    fields: {
      style: 'photographic',
      gender: 'female',
      identity: 'pilot',
      face: 'oval face',
      height: '',
      build: 'tall',
      muscle: '',
      posture: '',
      hair: 'dark bob',
      brows: '',
      eyes: 'dark eyes',
      noseMouth: '',
      facialHair: '',
      faceMarks: '',
      outfit: 'jacket',
      marks: ''
    }
  }

  it('正面把"朝向镜头"写死:两眼可见、鼻尖朝镜头、头不转不歪', () => {
    const p = characterViewPrompt(c, 'front', false)
    expect(p).toMatch(/facing the camera directly/i)
    expect(p).toMatch(/both eyes level and fully visible/i)
    expect(p).toMatch(/nose pointing at the camera/i)
    expect(p).toMatch(/head not turned and not tilted/i)
    expect(p).toContain(c.fields!.face)
  })

  it('正面带着那三个否定 —— 侧脸/侧视/四分之三都不许', () => {
    const p = characterViewPrompt(c, 'front', false)
    expect(p).toMatch(/not a profile/i)
    expect(p).toMatch(/not a side view/i)
    expect(p).toMatch(/not a three-quarter view/i)
  })

  it('**直接把那个失败场景写进提示词**:参考图是侧的就对了,这张仍然要正着画', () => {
    const p = characterViewPrompt(c, 'front', false)
    expect(p).toMatch(/even if the reference image shows the person from the side/i)
    expect(p).toMatch(/turned front-on/i)
  })

  it('带参考图时明说"它只管这个人是谁"', () => {
    const p = characterViewPrompt(c, 'front', true)
    expect(p).toContain(REF_IDENTITY_ONLY)
    expect(p).toMatch(/ignore the pose, the camera angle and the lighting in them/i)
    expect(p).toMatch(/do not copy the direction the person is facing/i)
  })

  it('那句写成复数 —— 其余四格送的是两张(正脸 + 底图),单数会指错', () => {
    /* 判据是"这话对一张、两张都成立":`images … them` 而不是 `image … it` */
    expect(REF_IDENTITY_ONLY).toMatch(/reference images are only about/i)
    expect(REF_IDENTITY_ONLY).toMatch(/in them/i)
    expect(REF_IDENTITY_ONLY).not.toMatch(/the attached image is/i)
  })

  it('不带参考图就不说那句 —— 纯文生图时它会去找一张并不存在的图', () => {
    expect(characterViewPrompt(c, 'front', false)).not.toContain(REF_IDENTITY_ONLY)
  })

  it('参考图那句垫在最后:它是"怎么读上面那些话"的元指令,不是这一张的内容', () => {
    const p = characterViewPrompt(c, 'front', true)
    expect(p.endsWith(REF_IDENTITY_ONLY)).toBe(true)
  })

  it('另外四格都带上了"参考图只管脸" —— 它们也送参考图', () => {
    for (const v of CHARACTER_VIEWS) {
      expect(characterViewPrompt(c, v.kind, true), v.kind).toContain(REF_IDENTITY_ONLY)
    }
  })

  it('转面那一格照旧要四个方向 —— "别抄姿态"不是"别换方向"', () => {
    const p = characterViewPrompt(c, 'detail', true)
    expect(p).toMatch(/left side profile/i)
    expect(p).toMatch(/high angle/i)
    expect(p).toMatch(/low angle/i)
  })

  it('认不出的 kind 给空串,不拼半条提示词出去', () => {
    expect(characterViewPrompt(c, 'nope' as never, true)).toBe('')
  })

  it('老角色(没有 fields)照旧退回 desc,不因为这一改就没了设定', () => {
    const legacy: Character = { id: 'y', name: 'Y', createdAt: 0, desc: 'a quiet stranger' }
    expect(characterViewPrompt(legacy, 'front', false)).toContain('a quiet stranger')
  })
})

/* ===== 角色包走一趟:对话里的场景串不许在路上被截短(2026-10-06) =====
   场景上限 2026-10-04 从 120 放宽到 400,而**导入这一处漏改了** ——
   它还在按 120 截。表现完全是静默的:图照旧显示(字节在包里),
   只有"重画这一张"会拿到一句被砍掉尾巴的场景,而尾巴正是
   时间/天气/光那些"只有聊天模型看得见"的信息。

   这里**真的打一个 zip 再读回来**,而不是直接调那个校验函数 ——
   被漏改的正是"打包 → 解包 → 逐条过筛"这条缝,只测其中一段就不是它了。 */

describe('readCharacterZip · 场景串完整读回来', () => {
  /** 打一个最小角色包:清单里挂一份 chat.json */
  function pkg(chat: unknown): File {
    const manifest = {
      format: 'kimage-character',
      version: 1,
      characters: [{ name: 'Alice', createdAt: 1, chat: 'chat.json' }]
    }
    const bytes = zipSync({
      'character.json': strToU8(JSON.stringify(manifest)),
      'chat.json': strToU8(JSON.stringify(chat))
    })
    return new File([bytes], 'alice.zip', { type: 'application/zip' })
  }

  /* 单倍空格、无首尾空白 —— 导入那一道会把连续空白压成一个空格,
     而真实场景串在剪标签时就已经压过了(见 server/chatTags 的 cleanScene) */
  const SCENE =
    'me leaning on the balcony rail at dusk, the rain just stopped, streetlights coming ' +
    'on below, hair still wet from the shower, the harbour lights doubled in the puddles ' +
    'on the deck'

  it('比 120 长的场景原样读回来', async () => {
    expect(SCENE.length).toBeGreaterThan(120)
    expect(SCENE.length).toBeLessThan(400)
    const rows = await readCharacterZip(
      pkg({ messages: [{ role: 'assistant', content: 'hi', createdAt: 1, photo: SCENE, photoId: 'p1' }] })
    )
    expect(rows[0].chat?.messages[0].photo).toBe(SCENE)
  })

  it('超过权威上限才截,而且截到那个上限', async () => {
    const long = 'x'.repeat(PHOTO_SCENE_CHARS + 250)
    const rows = await readCharacterZip(
      pkg({ messages: [{ role: 'assistant', content: 'hi', createdAt: 1, photo: long, photoId: 'p1' }] })
    )
    expect(rows[0].chat?.messages[0].photo?.length).toBe(PHOTO_SCENE_CHARS)
  })

  it('视角与景别一起走过这条缝 —— 少了任何一个,重画都会换个拍法', async () => {
    const rows = await readCharacterZip(
      pkg({
        messages: [
          {
            role: 'assistant',
            content: 'hi',
            createdAt: 1,
            photo: SCENE,
            photoId: 'p1',
            photoSelf: true,
            photoShot: 'third',
            photoFrame: 'close'
          }
        ]
      })
    )
    const m = rows[0].chat?.messages[0]
    expect(m?.photoSelf).toBe(true)
    expect(m?.photoShot).toBe('third')
    expect(m?.photoFrame).toBe('close')
  })

  it('认不出的景别词不进库(它会流进提示词模板的选择)', async () => {
    const rows = await readCharacterZip(
      pkg({
        messages: [
          { role: 'assistant', content: 'hi', createdAt: 1, photo: SCENE, photoId: 'p1', photoFrame: 'extreme' }
        ]
      })
    )
    expect(rows[0].chat?.messages[0].photoFrame).toBeUndefined()
  })
})
