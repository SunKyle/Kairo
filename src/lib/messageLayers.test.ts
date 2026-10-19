import { describe, expect, it } from 'vitest'

import {
  actAllowedForProduction,
  detectActEmitted,
  effectiveLayer,
  hasLayerMarkers,
  isAtmosphereAct,
  isVisibleForUI,
  keepInModelHistory,
  keepInSummary,
  nextSceneMode,
  normalizeMessageLayer,
  parseLayers,
} from './messageLayers'

/* ===== normalizeMessageLayer / effectiveLayer ===== */

describe('normalizeMessageLayer · 合法值原样、非法/缺省收 undefined', () => {
  it('三个合法值认得，大小写归一', () => {
    expect(normalizeMessageLayer('say')).toBe('say')
    expect(normalizeMessageLayer('think')).toBe('think')
    expect(normalizeMessageLayer('act')).toBe('act')
    expect(normalizeMessageLayer('Think')).toBe('think')
  })
  it('非法/非字符串/缺省一律 undefined（不硬塞）', () => {
    expect(normalizeMessageLayer('inner')).toBeUndefined()
    expect(normalizeMessageLayer('')).toBeUndefined()
    expect(normalizeMessageLayer(3)).toBeUndefined()
    expect(normalizeMessageLayer(undefined)).toBeUndefined()
    expect(normalizeMessageLayer(null)).toBeUndefined()
  })
})

describe('effectiveLayer · 缺省/非法一律按 say 兜底', () => {
  it('老消息没有 layer → say', () => {
    expect(effectiveLayer({})).toBe('say')
    expect(effectiveLayer({ layer: undefined })).toBe('say')
    expect(effectiveLayer({ layer: 'garbage' })).toBe('say')
  })
  it('合法 layer 原样生效', () => {
    expect(effectiveLayer({ layer: 'think' })).toBe('think')
    expect(effectiveLayer({ layer: 'act' })).toBe('act')
  })
})

/* ===== parseLayers · 扇出 ===== */

describe('parseLayers · 没有标记就是单条 say', () => {
  it('纯文本 → 一段 say，文字原样', () => {
    expect(parseLayers('今天路过那家店')).toEqual([{ layer: 'say', text: '今天路过那家店' }])
  })
  it('空串 / 非串 → 空数组', () => {
    expect(parseLayers('')).toEqual([])
    // @ts-expect-error 运行期也要挡住
    expect(parseLayers(undefined)).toEqual([])
  })
  it('保留段内换行（只剪首尾）', () => {
    expect(parseLayers('  第一行\n第二行  ')).toEqual([{ layer: 'say', text: '第一行\n第二行' }])
  })
})

describe('parseLayers · 成对区域标记把一轮切成有序多层', () => {
  it('think 居中：前 say、中 think、后 say', () => {
    const out = parseLayers('关店前拍了一张。[think]其实我停了好一会儿[/think]你要看吗')
    expect(out).toEqual([
      { layer: 'say', text: '关店前拍了一张。' },
      { layer: 'think', text: '其实我停了好一会儿' },
      { layer: 'say', text: '你要看吗' },
    ])
  })
  it('act 同理', () => {
    const out = parseLayers('[act]她把围巾绕紧[/act]走吧')
    expect(out).toEqual([
      { layer: 'act', text: '她把围巾绕紧' },
      { layer: 'say', text: '走吧' },
    ])
  })
  it('标记本身绝不外泄：任何一段都不含 [think] 字样', () => {
    const out = parseLayers('a[think]b[/think]c')
    expect(out.every((s) => !/\[(\/?)(think|act|say)\]/i.test(s.text))).toBe(true)
  })
  it('think/act 连着各来一段，顺序不乱', () => {
    const out = parseLayers('x[think]t[/think]y[act]z[/act]w')
    expect(out.map((s) => s.layer)).toEqual(['say', 'think', 'say', 'act', 'say'])
    expect(out.map((s) => s.text)).toEqual(['x', 't', 'y', 'z', 'w'])
  })
})

describe('parseLayers · 模型不守纪律时的宽容兜底', () => {
  it('未闭合的开标记 = 到轮尾都算那一层，标记不外泄', () => {
    const out = parseLayers('好，[think]其实我有点紧张，很久没这样约过了')
    expect(out).toEqual([
      { layer: 'say', text: '好，' },
      { layer: 'think', text: '其实我有点紧张，很久没这样约过了' },
    ])
  })
  it('孤立的闭合标记当无操作（拨回 say，不吞字）', () => {
    const out = parseLayers('[/think]照旧是说的话')
    expect(out).toEqual([{ layer: 'say', text: '照旧是说的话' }])
  })
  it('相邻同层合并（[say] 把闭合后与显式 say 两段并成一段）', () => {
    const out = parseLayers('[think]内心[/think]或者[say]就说说')
    expect(out).toEqual([
      { layer: 'think', text: '内心' },
      { layer: 'say', text: '或者\n就说说' },
    ])
  })
  it('标记大小写不敏感', () => {
    const out = parseLayers('a[Think]b[/Think]c')
    expect(out.map((s) => s.layer)).toEqual(['say', 'think', 'say'])
  })
  it('空段落被丢掉，不产出空消息', () => {
    const out = parseLayers('[think][/think]正文')
    expect(out).toEqual([{ layer: 'say', text: '正文' }])
  })
  it('正文里散落的方括号 [1] / [注] 不误伤（层名不匹配就当文字）', () => {
    const out = parseLayers('引用[1]和[注]都留下')
    expect(out).toEqual([{ layer: 'say', text: '引用[1]和[注]都留下' }])
  })
})

/* ===== hasLayerMarkers · 普通一轮的那道"一个字节都不动"闸 ===== */

describe('hasLayerMarkers', () => {
  it('没有标记 → false（普通回复走原样单条路，parseLayers 的 trim 不会碰到它）', () => {
    expect(hasLayerMarkers('今天路过那家店')).toBe(false)
    expect(hasLayerMarkers('引用[1]和[注]都留下')).toBe(false)
  })
  it('空与非串 → false', () => {
    expect(hasLayerMarkers('')).toBe(false)
    expect(hasLayerMarkers(undefined as unknown as string)).toBe(false)
  })
  it('think / act / say 任一标记都算数，大小写不敏感', () => {
    expect(hasLayerMarkers('前面[think]心里话[/think]后面')).toBe(true)
    expect(hasLayerMarkers('[act]她转身[/act]走吧')).toBe(true)
    expect(hasLayerMarkers('[say]只说了这句')).toBe(true)
    expect(hasLayerMarkers('[THINK]大写[/think]')).toBe(true)
  })
  it('连续两次调用不互相串位（/g 的 lastIndex 每次都归零）', () => {
    // 单靠 .test 而不重置 lastIndex，第二条会在第一条命中之后接着找 → 飘
    expect(hasLayerMarkers('[think]a')).toBe(true)
    expect(hasLayerMarkers('b')).toBe(false)
    expect(hasLayerMarkers('[act]c')).toBe(true)
  })
})

describe('detectActEmitted', () => {
  it('有 act 段就报进入场景', () => {
    expect(detectActEmitted(parseLayers('a[act]b[/act]'))).toBe(true)
  })
  it('只有 say/think 不算', () => {
    expect(detectActEmitted(parseLayers('a[think]b[/think]'))).toBe(false)
  })
})

/* ===== isVisibleForUI · 只认展示开关 ===== */

describe('isVisibleForUI', () => {
  const both = { showThink: true, showAct: true }
  const none = { showThink: false, showAct: false }
  it('say 恒可见，不受开关影响', () => {
    expect(isVisibleForUI({ layer: 'say' }, none)).toBe(true)
    expect(isVisibleForUI({}, none)).toBe(true) // 老消息=无 layer→say
  })
  it('think 只看 showThink', () => {
    expect(isVisibleForUI({ layer: 'think' }, both)).toBe(true)
    expect(isVisibleForUI({ layer: 'think' }, { showThink: false, showAct: true })).toBe(false)
  })
  it('act 只看 showAct', () => {
    expect(isVisibleForUI({ layer: 'act' }, both)).toBe(true)
    expect(isVisibleForUI({ layer: 'act' }, { showThink: true, showAct: false })).toBe(false)
  })
  it('非法 layer 兜底成 say → 恒可见（不因脏数据被隐藏）', () => {
    expect(isVisibleForUI({ layer: 'garbage' }, none)).toBe(true)
  })
})

/* ===== keepInModelHistory / keepInSummary · B 决策 ===== */

describe('keepInModelHistory · B 已定：三层都留短期', () => {
  it('say / think / act 都 true', () => {
    expect(keepInModelHistory({ layer: 'say' })).toBe(true)
    expect(keepInModelHistory({ layer: 'think' })).toBe(true)
    expect(keepInModelHistory({ layer: 'act' })).toBe(true)
  })
})

describe('keepInSummary · think 永不进、say/act 默认进', () => {
  it('think 是核心护栏：绝不固化成长期事实', () => {
    expect(keepInSummary({ layer: 'think' }, { text: '任何内心' })).toBe(false)
    expect(keepInSummary({ layer: 'think' }, { dropAtmosphereActs: true, text: 'x' })).toBe(false)
  })
  it('say / 老消息(say) 进', () => {
    expect(keepInSummary({ layer: 'say' })).toBe(true)
    expect(keepInSummary({})).toBe(true)
  })
  it('act 默认进（保守：拿不准算实质）', () => {
    expect(keepInSummary({ layer: 'act' }, { text: '她低头' })).toBe(true)
  })
  it('开了 dropAtmosphereActs 才滤纯氛围，实质动作仍进', () => {
    expect(keepInSummary({ layer: 'act' }, { dropAtmosphereActs: true, text: '她低头' })).toBe(false)
    expect(keepInSummary({ layer: 'act' }, { dropAtmosphereActs: true, text: '她把伞递给你' })).toBe(true)
  })
})

describe('isAtmosphereAct · 保守判纯氛围', () => {
  it('短、无对象、无互动动词 → 氛围', () => {
    expect(isAtmosphereAct('她低下头')).toBe(true)
    expect(isAtmosphereAct('风把头发吹乱')).toBe(true)
  })
  it('涉及"你/我"或传递/处置 → 实质（不丢）', () => {
    expect(isAtmosphereAct('她把伞递给你')).toBe(false)
    expect(isAtmosphereAct('ta 抱了你一下')).toBe(false)
    expect(isAtmosphereAct('我悄悄靠近')).toBe(false)
  })
  it('空的不是氛围（是无意义，交给上层丢空段）', () => {
    expect(isAtmosphereAct('   ')).toBe(false)
  })
})

/* ===== 场景模式迟滞 ===== */

describe('nextSceneMode · 进入靠 act、离开只认边界/用户', () => {
  it('act-emitted 进入并保持', () => {
    expect(nextSceneMode(false, 'act-emitted')).toBe(true)
    expect(nextSceneMode(true, 'act-emitted')).toBe(true)
  })
  it('没有 act 的一轮不把它关掉（防闪烁：无事件=不动）', () => {
    // 关键：轮次"没产出 act"根本不会发事件，所以此处根本不产生 turn-off 调用。
    // 即便误传一个保持类事件，也不该把 true 翻成 false。
    expect(nextSceneMode(true, 'act-emitted')).toBe(true)
    expect(nextSceneMode(true, 'user-on')).toBe(true)
  })
  it('scene-boundary / user-off 才离开', () => {
    expect(nextSceneMode(true, 'scene-boundary')).toBe(false)
    expect(nextSceneMode(true, 'user-off')).toBe(false)
    expect(nextSceneMode(false, 'user-off')).toBe(false)
  })
  it('user-on 强制进入', () => {
    expect(nextSceneMode(false, 'user-on')).toBe(true)
  })
})

describe('actAllowedForProduction', () => {
  it('只在场景模式放行 act 产出', () => {
    expect(actAllowedForProduction(true)).toBe(true)
    expect(actAllowedForProduction(false)).toBe(false)
  })
})
