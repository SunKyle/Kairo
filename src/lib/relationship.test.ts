import { describe, expect, it } from 'vitest'
import {
  applyEvaluation,
  coerceRelationship,
  defaultRelationship,
  DELTA_MAX,
  DELTA_MIN,
  hasCloseness,
  parseRelationshipDelta,
  REL_MAX,
  relationshipLines,
  relationshipStage
} from './relationship'
import type { RelationshipState } from '../types'

/* 这一层守的是 PRD §3.2-C 的几条**产品不变量**,而不是实现细节。
   它们必须能被构造数据直接断言(与 memory.test.ts / chatMemory.test.ts 同一套路):
   缺席不降、不跳级、亲近 ≤ 信任 ≤ 熟悉、聊得多不等于自动变亲密,以及对坏数据的收口。 */

const NOW = 1_000_000

function state(partial: Partial<RelationshipState> = {}): RelationshipState {
  return { familiarity: 0, trust: 0, affection: 0, updatedAt: 0, ...partial }
}

describe('relationship · coerce 收口', () => {
  it('非对象 / 缺字段一律落回默认,不抛', () => {
    expect(coerceRelationship(null)).toEqual(defaultRelationship())
    expect(coerceRelationship(undefined)).toEqual(defaultRelationship())
    expect(coerceRelationship('nope')).toEqual(defaultRelationship())
    expect(coerceRelationship({})).toEqual(defaultRelationship())
  })

  it('NaN / 负数 / 越界都夹进 0..REL_MAX', () => {
    const out = coerceRelationship({ familiarity: NaN, trust: -40, affection: 999, updatedAt: 5 })
    expect(out.familiarity).toBe(0)
    expect(out.trust).toBe(0)
    expect(out.affection).toBe(0)
    expect(out.updatedAt).toBe(5)
    expect(coerceRelationship({ familiarity: 999 }).familiarity).toBe(REL_MAX)
  })

  it('读进来就再夹一遍结构约束(亲近 ≤ 信任 ≤ 熟悉)——坏数据也挡得住', () => {
    const out = coerceRelationship({ familiarity: 10, trust: 90, affection: 90 })
    expect(out.trust).toBeLessThanOrEqual(out.familiarity)
    expect(out.affection).toBeLessThanOrEqual(out.trust)
    expect(out).toEqual({ familiarity: 10, trust: 10, affection: 10, updatedAt: 0 })
  })

  it('负/非有限的 updatedAt 当"从没评估过"(0)', () => {
    expect(coerceRelationship({ familiarity: 5, updatedAt: -1 }).updatedAt).toBe(0)
    expect(coerceRelationship({ familiarity: 5, updatedAt: NaN }).updatedAt).toBe(0)
  })
})

describe('relationship · 档位', () => {
  it('阈值边界:33→0 档、34→1 档、66→1 档、67→2 档', () => {
    expect(relationshipStage(33)).toBe(0)
    expect(relationshipStage(34)).toBe(1)
    expect(relationshipStage(66)).toBe(1)
    expect(relationshipStage(67)).toBe(2)
    expect(relationshipStage(-5)).toBe(0)
  })
})

describe('applyEvaluation · 缺席不降', () => {
  it('Δ 全缺省 → 分值原样不动(只刷 updatedAt)', () => {
    const prev = state({ familiarity: 50, trust: 40, affection: 30 })
    const next = applyEvaluation(prev, {}, NOW)
    expect(next.familiarity).toBe(50)
    expect(next.trust).toBe(40)
    expect(next.affection).toBe(30)
    expect(next.updatedAt).toBe(NOW)
  })

  it('根本没有"按时间衰减"的入口:隔多久评估一次都不会因此掉分', () => {
    // 唯一的降分来自模型明确写下的负 Δ;时间本身在签名里就不是一个衰减因子
    const prev = state({ familiarity: 20, trust: 20, affection: 0, updatedAt: NOW - 9_999_999_999 })
    const next = applyEvaluation(prev, { familiarity: 1 }, NOW)
    expect(next.familiarity).toBe(21) // 只 +1,没有任何"因为很久没动而变少"
  })
})

describe('applyEvaluation · Δ 封顶与结构约束', () => {
  it('单轴 Δ 被夹进 [DELTA_MIN, DELTA_MAX]', () => {
    const up = applyEvaluation(state({ familiarity: 0 }), { familiarity: 999 }, NOW)
    expect(up.familiarity).toBe(DELTA_MAX)
    const down = applyEvaluation(state({ familiarity: 50 }), { familiarity: -999 }, NOW)
    expect(down.familiarity).toBe(50 + DELTA_MIN)
  })

  it('亲近不能高过信任,信任不能高过熟悉(就算模型这么写)', () => {
    // 起点三轴同为 10(满足约束),只把 affection 猛拉
    const next = applyEvaluation(
      state({ familiarity: 10, trust: 10, affection: 10 }),
      { affection: DELTA_MAX },
      NOW
    )
    expect(next.affection).toBeLessThanOrEqual(next.trust)
    expect(next.trust).toBeLessThanOrEqual(next.familiarity)
    expect(next.affection).toBe(10) // 被信任封顶,那 +8 根本没地方放
  })

  it('纯熟悉度上涨不会自动带高亲近(要靠显式 Δ)', () => {
    const next = applyEvaluation(state({ familiarity: 20, trust: 0, affection: 0 }), { familiarity: DELTA_MAX }, NOW)
    expect(next.familiarity).toBe(28)
    expect(next.trust).toBe(0)
    expect(next.affection).toBe(0)
  })

  it('分值夹在 0..REL_MAX,不会溢出也不会变负', () => {
    expect(applyEvaluation(state({ familiarity: REL_MAX }), { familiarity: DELTA_MAX }, NOW).familiarity).toBe(REL_MAX)
    expect(applyEvaluation(state({ familiarity: 0 }), { familiarity: DELTA_MIN }, NOW).familiarity).toBe(0)
  })
})

describe('applyEvaluation · 一次不跨两档', () => {
  it('从 0 档起步,单次再大也只升到 1 档', () => {
    const next = applyEvaluation(state({ familiarity: 30 }), { familiarity: 1000 }, NOW)
    // Δ 先被 clamp 到 +DELTA_MAX(8 < 一档的跨度),所以一次绝跨不过两档;
    // 那道"档位天花板"是给日后调大 DELTA_MAX 留的保险(见 relationship.ts 规矩 2)
    expect(next.familiarity).toBe(30 + DELTA_MAX)
    expect(relationshipStage(next.familiarity) - 0).toBeLessThanOrEqual(1)
  })

  it('反复评估可以一格一格爬到 2 档,但每一步至多升一格', () => {
    let s = state({ familiarity: 0 })
    let prevStage = relationshipStage(s.familiarity)
    for (let i = 0; i < 40; i++) {
      const next = applyEvaluation(s, { familiarity: DELTA_MAX, trust: DELTA_MAX, affection: DELTA_MAX }, NOW + i)
      const stage = relationshipStage(next.familiarity)
      expect(stage - prevStage).toBeLessThanOrEqual(1)
      s = next
      prevStage = stage
    }
    // 攒够之后终归能到 2 档(封顶在 REL_MAX)
    expect(relationshipStage(s.familiarity)).toBe(2)
    expect(s.affection).toBeLessThanOrEqual(s.trust)
    expect(s.trust).toBeLessThanOrEqual(s.familiarity)
  })
})

describe('parseRelationshipDelta · 固定前缀行', () => {
  it('读出三行的符号整数', () => {
    expect(parseRelationshipDelta('familiarity|+2\ntrust|-1\naffection|0')).toEqual({
      familiarity: 2,
      trust: -1,
      affection: 0
    })
  })

  it('认不出的轴名 / 非数值 / 缺分隔符的行一律跳过,不抛', () => {
    expect(parseRelationshipDelta('vibe|+5\nfamiliarity|abc\ntrust')).toEqual({})
    expect(parseRelationshipDelta('FAMILIARITY|3')).toEqual({ familiarity: 3 }) // 轴名大小写不敏感
    expect(parseRelationshipDelta(null)).toEqual({})
    expect(parseRelationshipDelta('')).toEqual({})
    expect(parseRelationshipDelta('   \n  \n')).toEqual({})
  })

  it('同一根轴以先到为准(模型写两遍也不叠加)', () => {
    expect(parseRelationshipDelta('familiarity|+2\nfamiliarity|+8')).toEqual({ familiarity: 2 })
  })

  it('值里带空格也能读(轴名与数字各自 trim)', () => {
    expect(parseRelationshipDelta(' trust | -2 ')).toEqual({ trust: -2 })
  })
})

describe('relationshipLines · 摊成指令', () => {
  it('从没评估过 → 空串(老角色 / 刚建的角色都不该被当成"你们很熟")', () => {
    expect(relationshipLines(undefined)).toBe('')
    expect(relationshipLines(state({ updatedAt: 0, familiarity: 50 }))).toBe('')
    expect(relationshipLines(state())).toBe('')
  })

  it('评估过但三轴仍是 0 → 空串(还没攒出任何东西)', () => {
    expect(relationshipLines(state({ familiarity: 0, trust: 0, affection: 0, updatedAt: NOW }))).toBe('')
  })

  it('只有一点熟悉度 → 一行基调,不假装信任或亲昵', () => {
    const out = relationshipLines(state({ familiarity: 20, trust: 0, affection: 0, updatedAt: NOW }))
    expect(out.startsWith('- ')).toBe(true)
    const lines = out.split('\n')
    expect(lines).toHaveLength(1)
    expect(out).toContain('getting to know')
  })

  it('三轴都到 2 档 → 每轴一行,措辞是"长伴 / 深托 / 亲昵"', () => {
    const out = relationshipLines(state({ familiarity: 90, trust: 80, affection: 70, updatedAt: NOW }))
    const lines = out.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.every((l) => l.startsWith('- '))).toBe(true)
    expect(out).toContain('long-time companions')
    expect(out).toContain('trust you deeply')
    expect(out).toContain('close and affectionate')
  })

  it('坏输入也收得住:越界的分值先 coerce 再摊,不吐出 100 分以上的怪档位', () => {
    const out = relationshipLines(state({ familiarity: 500, trust: 500, affection: 500, updatedAt: NOW }))
    expect(out.split('\n')).toHaveLength(3)
  })
})

describe('hasCloseness · "攒出东西了没有"的唯一判据', () => {
  it('没有 / 三轴全 0 → false(哪怕评估过、盖了时间戳)', () => {
    expect(hasCloseness(undefined)).toBe(false)
    expect(hasCloseness(state())).toBe(false)
    expect(hasCloseness(state({ updatedAt: NOW }))).toBe(false) // 评估过但一点没攒下
  })

  it('信号落在熟悉度这根地基上(结构约束:亲近 ≤ 信任 ≤ 熟悉)', () => {
    expect(hasCloseness(state({ familiarity: 1 }))).toBe(true)
    expect(hasCloseness(state({ familiarity: 40, trust: 20, affection: 10 }))).toBe(true)
    // 脱离熟悉度的信任 / 亲近会被 coerce 夹回 0 —— 它不构成"走到了一步"
    expect(hasCloseness(state({ trust: 1 }))).toBe(false)
    expect(hasCloseness(state({ affection: 1 }))).toBe(false)
  })

  it('越界的坏值先 coerce 再判,不把"其实是 0"的坏数据当成有信号', () => {
    expect(hasCloseness(state({ familiarity: -5, trust: 0, affection: 0 }))).toBe(false)
    expect(hasCloseness(state({ familiarity: 200 }))).toBe(true) // 夹到 100 仍是 >0
  })

  it('与 relationshipLines 对齐:判为"没攒下"时,注入行必然是空串', () => {
    // 同一个"空"不能一处说有空、另一处又摊出指令
    expect(hasCloseness(state({ updatedAt: NOW }))).toBe(false)
    expect(relationshipLines(state({ updatedAt: NOW }))).toBe('')
    expect(hasCloseness(state({ familiarity: 20, updatedAt: NOW }))).toBe(true)
    expect(relationshipLines(state({ familiarity: 20, updatedAt: NOW }))).not.toBe('')
  })
})
