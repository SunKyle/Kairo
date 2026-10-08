import { describe, expect, it } from 'vitest'
import { CHAT_MOOD_HOLD_MS, moodContext, moodWord } from '../../server/chatMood.js'

/* 这一层管两件事:那个词**能不能用**,以及那一块**该不该出现**。
   两件都是纯判断,而它们决定了 system 里到底长什么形状 —— 一个坏词塞进去
   就是一段伪造的提示词结构,所以判据全部放在这里直接断言。 */

const NOW = Date.UTC(2026, 9, 7, 21, 30)

describe('moodWord · 词的形状', () => {
  it('正常的小写词照收', () => {
    expect(moodWord('wary')).toBe('wary')
    expect(moodWord('tired')).toBe('tired')
  })

  it('连字符的词也收 —— chatTags 的 MOOD_RE 本来就认它', () => {
    expect(moodWord('quietly-amused')).toBe('quietly-amused')
  })

  it('大小写与空白容忍:模型写 Mood: Tired 也认', () => {
    expect(moodWord(' TIRED ')).toBe('tired')
    expect(moodWord('Wary')).toBe('wary')
  })

  it('认不出的返回空串,而且**不猜**', () => {
    for (const bad of ['', '   ', '喵', 'very tired', '1tired', '-sad', 'a', undefined, null, 42]) {
      expect(moodWord(bad as never)).toBe('')
    }
  })

  it('超长的截不住就整个丢掉 —— 它是内容,不是长度问题', () => {
    expect(moodWord('a'.repeat(21))).toBe('')
    expect(moodWord('a'.repeat(20))).toBe('a'.repeat(20))
  })
})

describe('moodContext · 那一块该不该出现', () => {
  const fresh = { word: 'wary', at: NOW - 60_000, now: NOW }

  it('窗口里:两行,含那个词', () => {
    const s = moodContext(fresh)
    expect(s).toContain('wary')
    expect(s.split('\n')).toHaveLength(2)
  })

  it('那一块必须留一个"可以转向"的出口', () => {
    /* 只写"你正在恼",模型会一轮一轮地恼下去 —— 惯性由模型演,
       但得给它一个改口的许可(见设计文档 §3.3) */
    expect(moodContext(fresh)).toMatch(/turn it|change it/i)
  })

  it('刚好 6 小时还算数,过了一毫秒就不算了', () => {
    expect(moodContext({ word: 'wary', at: NOW - CHAT_MOOD_HOLD_MS, now: NOW })).not.toBe('')
    expect(moodContext({ word: 'wary', at: NOW - CHAT_MOOD_HOLD_MS - 1, now: NOW })).toBe('')
  })

  it('隔夜就散了 —— 一天前的心情不该再带着', () => {
    expect(moodContext({ word: 'angry', at: NOW - 24 * 3600_000, now: NOW })).toBe('')
  })

  it('时钟错位(时间戳落在"未来")照旧当新鲜,不为一次对不齐把它丢掉', () => {
    expect(moodContext({ word: 'warm', at: NOW + 3600_000, now: NOW })).not.toBe('')
  })

  it('词不合法:整块不出现,不留空壳', () => {
    expect(moodContext({ word: '喵', at: NOW, now: NOW })).toBe('')
    expect(moodContext({ word: '', at: NOW, now: NOW })).toBe('')
  })

  it('没有时间戳:整块不出现 —— 判不出新旧的心情宁可不带', () => {
    expect(moodContext({ word: 'wary', now: NOW })).toBe('')
    expect(moodContext({ word: 'wary', at: Number.NaN, now: NOW })).toBe('')
    expect(moodContext({ word: 'wary', at: 0, now: NOW })).toBe('')
  })

  it('整个入参都不给:空串,不抛', () => {
    expect(moodContext()).toBe('')
    expect(moodContext(undefined)).toBe('')
  })

  it('输出的换行是**我们自己写的**那一处,不随词走', () => {
    /* 词已经过形状检查(不含空白),所以这块永远不会多出第三行 ——
       而换行数一多,就是给上一轮的输出一个伪造提示词结构的机会 */
    expect(moodContext({ word: 'a-b-c', at: NOW, now: NOW }).split('\n')).toHaveLength(2)
  })
})
