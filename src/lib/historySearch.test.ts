import { describe, expect, it } from 'vitest'
import { matchesHistoryQuery, normalizeQuery, type HistorySearchNames } from './historySearch'

/* 搜索是"找不找得到那张图"的唯一入口,而它的分支全在纯函数里 ——
   真到界面上试,要造几百条记录、试好几种输入才碰得到边界 */

const names: HistorySearchNames = {
  charNames: { c1: 'Alice', c2: '白塔' },
  collTitles: { k1: 'Night shift' }
}

const entry = (over: Partial<Parameters<typeof matchesHistoryQuery>[0]> = {}) => ({
  prompt: 'a cat by the window',
  ...over
})

describe('normalizeQuery · 关键词归一', () => {
  it('去首尾空白并转小写', () => {
    expect(normalizeQuery('  CAT ')).toBe('cat')
  })

  it('空串与全是空白的都归一成空串(= 不筛)', () => {
    expect(normalizeQuery('')).toBe('')
    expect(normalizeQuery('   ')).toBe('')
    expect(normalizeQuery(undefined as unknown as string)).toBe('')
  })
})

describe('matchesHistoryQuery · 命中判据', () => {
  it('空查询一律命中:不筛的时候每条都该在', () => {
    expect(matchesHistoryQuery(entry(), '', names)).toBe(true)
    expect(matchesHistoryQuery(entry(), '   ', names)).toBe(true)
  })

  it('提示词正文:子串命中,大小写不敏感', () => {
    expect(matchesHistoryQuery(entry(), 'window', names)).toBe(true)
    expect(matchesHistoryQuery(entry(), 'WINDOW', names)).toBe(true)
    expect(matchesHistoryQuery(entry(), 'dog', names)).toBe(false)
  })

  it('角色名:按 id 反查名字,搜"跟谁"找得到', () => {
    expect(matchesHistoryQuery(entry({ characterId: 'c1' }), 'alice', names)).toBe(true)
    // 这个名字只存在于反查表里,提示词里没有 —— 没有反查就漏
    expect(matchesHistoryQuery(entry({ characterId: 'c2' }), '白塔', names)).toBe(true)
    expect(matchesHistoryQuery(entry({ characterId: 'c9' }), 'alice', names)).toBe(false)
    expect(matchesHistoryQuery(entry(), 'alice', names)).toBe(false)
  })

  it('作品集名:搜"归在哪个集里"找得到', () => {
    expect(matchesHistoryQuery(entry({ collectionId: 'k1' }), 'night', names)).toBe(true)
    expect(matchesHistoryQuery(entry({ collectionId: 'k9' }), 'night', names)).toBe(false)
  })

  it('对话里那段场景:提示词里没有那个词,照样按场景搜得到', () => {
    /* 对话那两种图的 prompt 是整段摄影指令(见 lib/chatWork),
       用户记得的却是它当时说在哪儿 —— 场景漏了匹配就等于"这张找不到" */
    const e = entry({ prompt: 'photographic, selfie at arm’s length, front camera', scene: 'on the balcony' })
    expect(matchesHistoryQuery(e, 'balcony', names)).toBe(true)
    expect(matchesHistoryQuery(e, 'basement', names)).toBe(false)
  })

  it('多个词是 AND,而且可以来自不同字段', () => {
    const e = entry({ prompt: 'a cat by the window', characterId: 'c1' })
    expect(matchesHistoryQuery(e, 'alice cat', names)).toBe(true)
    expect(matchesHistoryQuery(e, 'cat window', names)).toBe(true)
    // 少一个词就不算命中
    expect(matchesHistoryQuery(e, 'alice dog', names)).toBe(false)
  })

  it('词序不影响结果', () => {
    const e = entry({ characterId: 'c1' })
    expect(matchesHistoryQuery(e, 'window alice', names)).toBe(
      matchesHistoryQuery(e, 'alice window', names)
    )
  })

  it('从没挂过角色 / 作品集的记录照样能按提示词搜到', () => {
    expect(matchesHistoryQuery(entry(), 'cat', names)).toBe(true)
  })

  it('提示词为空(理论上不该有)时不抛,只是不命中', () => {
    expect(matchesHistoryQuery({ prompt: '' }, 'cat', names)).toBe(false)
    expect(matchesHistoryQuery({ prompt: '' }, '', names)).toBe(true)
  })
})
