import { describe, expect, it } from 'vitest'
import { fitInputBudget } from './summaryInput'

/* 摘要与抽取都要把一整段对话塞进一次请求。没有预算时,300 条 × 8000 字符
   能到 240 万字符 —— 上游会按上下文超限拒掉,而这条链是后台静默的:
   记忆从此停在原地,用户看不到任何提示。这里守两件事:
   1. 摘要从**旧**的那头留 —— 游标只能落在真正送进去的那一段末尾;
   2. 抽取从**新**的那头留 —— 值得记的是最近发生的事。
   装不下就停在那条,不跳过它去拿后面的 —— 跨过一条会在游标上留出空档。 */

const OVERHEAD = 16

function m(content: string): { content: string } {
  return { content }
}
function cost(content: string): number {
  return content.length + OVERHEAD
}

describe('fitInputBudget · 基本形状', () => {
  it('空数组给空数组', () => {
    expect(fitInputBudget([], 100)).toEqual([])
  })

  it('预算不是正数时给空数组(调用方据此收手)', () => {
    expect(fitInputBudget([m('a')], 0)).toEqual([])
    expect(fitInputBudget([m('a')], -1)).toEqual([])
  })

  it('全都装得下就一条不少、顺序不变', () => {
    const list = [m('a'), m('b'), m('c')]
    expect(fitInputBudget(list, 1000)).toEqual(list)
  })

  it('空正文也占一行装得下的开销(不是零成本)', () => {
    const list = [m(''), m(''), m('')]
    // 每行 16,两条正好 32,三条 48 > 40
    expect(fitInputBudget(list, 40)).toEqual(list.slice(0, 2))
  })
})

describe('fitInputBudget · 从旧往新(摘要)', () => {
  it('装到装不下为止,保留的是前面那些', () => {
    const list = [m('a'.repeat(10)), m('b'.repeat(10)), m('c'.repeat(10))]
    // 每行 26,两条 52 ≤ 60,三条 78 > 60
    expect(fitInputBudget(list, 60, 'oldest')).toEqual(list.slice(0, 2))
  })

  it('中间有一条特别大:停在它前面,不绕过去', () => {
    const list = [m('a'), m('x'.repeat(100)), m('c')]
    // 第一条 17 ≤ 40;第二条 116 装不下 → 停。不能跳过它拿第三条,
    // 否则游标会落在第三条上,把中间那条永远留在摘要之外
    expect(fitInputBudget(list, 40, 'oldest')).toEqual([list[0]])
  })

  it('第一条就超预算也要留一条 —— 否则这条对话永远压不动', () => {
    const huge = m('x'.repeat(1000))
    expect(fitInputBudget([huge], 10, 'oldest')).toEqual([huge])
    expect(fitInputBudget([huge, m('a')], 10, 'oldest')).toEqual([huge])
  })
})

describe('fitInputBudget · 从新往旧(抽取)', () => {
  it('留下的是最近的,返回时仍按原来的先后', () => {
    const list = [m('a'.repeat(10)), m('b'.repeat(10)), m('c'.repeat(10))]
    // 每行 26,两条 52 ≤ 60 → 留 b、c
    expect(fitInputBudget(list, 60, 'newest')).toEqual(list.slice(1))
  })

  it('中间有一条特别大:停在它后面,不绕过去', () => {
    const list = [m('a'), m('x'.repeat(100)), m('c')]
    // 最后一条 17 ≤ 40;中间 116 装不下 → 停,不再往前拿 a
    expect(fitInputBudget(list, 40, 'newest')).toEqual([list[2]])
  })

  it('第一条(最新的那条)就超预算也要留一条', () => {
    const huge = m('x'.repeat(1000))
    expect(fitInputBudget([m('a'), huge], 10, 'newest')).toEqual([huge])
  })
})

describe('fitInputBudget · 用真实一点的数字', () => {
  it('预算按"正文 + 每行开销"算,不是只算正文', () => {
    const list = [m('x'.repeat(100)), m('y'.repeat(100))]
    const budget = 2 * cost('x'.repeat(100))
    expect(fitInputBudget(list, budget, 'oldest')).toHaveLength(2)
    expect(fitInputBudget(list, budget - 1, 'oldest')).toHaveLength(1)
  })
})
