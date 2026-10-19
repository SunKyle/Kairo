import { describe, expect, it } from 'vitest'
import { resolveMood } from './moodDisplay'

/* 情绪展示层最容易写反的两件事：
   1. 没配到的词被硬编了一个假中文（宁可回显原词，也不能错）；
   2. 空/空白被当成"有个中性情绪"，于是名字旁凭空多一枚灰胶囊。
   下面每条都冲着这两处判据去。 */

describe('resolveMood · 命中词表', () => {
  it('给一个常见词 → 中文 + 温度桶 + 表情', () => {
    expect(resolveMood('amused')).toEqual({ label: '被逗乐了', tone: 'warm', face: '😄' })
    expect(resolveMood('angry')).toMatchObject({ tone: 'hot' })
    expect(resolveMood('wary')).toMatchObject({ tone: 'cool' })
    expect(resolveMood('tired')).toMatchObject({ tone: 'low' })
  })

  it('大小写与首尾空白不影响命中（服务端虽已小写，这里再兜一道）', () => {
    expect(resolveMood('  Delighted ')).toMatchObject({ tone: 'warm', face: '🤩' })
    expect(resolveMood('WARy')).toMatchObject({ tone: 'cool' })
  })

  it('四个温度桶都真的被词表覆盖到（防止某桶被写空）', () => {
    const tones = new Set(['warm', 'hot', 'cool', 'low'])
    const seen = new Set<string>()
    for (const w of ['amused', 'angry', 'wary', 'tired']) {
      seen.add(resolveMood(w)!.tone)
    }
    expect([...seen].sort()).toEqual([...tones].sort())
  })
})

describe('resolveMood · 没配到的词', () => {
  it('原样回显英文、走中性灰、不给表情（绝不硬编假中文）', () => {
    expect(resolveMood('melancholyxyz')).toEqual({
      label: 'melancholyxyz',
      tone: 'neutral',
      face: ''
    })
  })

  it('回显的是规整后的小写词，不是带空白的原样', () => {
    expect(resolveMood('  Whimsical  ')).toMatchObject({ label: 'whimsical', tone: 'neutral' })
  })
})

describe('resolveMood · 没有情绪', () => {
  it('空串 / 全空白 / null / undefined → null（胶囊整枚不出现）', () => {
    expect(resolveMood('')).toBeNull()
    expect(resolveMood('   ')).toBeNull()
    expect(resolveMood(null)).toBeNull()
    expect(resolveMood(undefined)).toBeNull()
  })
})
