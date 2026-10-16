import { describe, expect, it } from 'vitest'
import {
  RECENT_CAP,
  homeAgo,
  homeGrid,
  homeIdentity,
  homeSnippet,
  recentChats
} from './homeList'
import type { Character, CharacterFields, CharacterPersona, ChatMessage } from '../types'

/* 造角色的脚手架:只填这一层看得见的几栏。
   两份空白表按**类型**逐栏给全,不是 as Character 硬转 —— 那一转会把
   "这一层只看得见 identity" 这件事藏在断言背后,而类型真要加一栏时
   这里连编译错误都不会有(运行时也一样静默)。填全了,改一栏就要改一处 */
function blankFields(): CharacterFields {
  return {
    style: '',
    gender: '',
    identity: '',
    face: '',
    height: '',
    build: '',
    muscle: '',
    posture: '',
    hair: '',
    brows: '',
    eyes: '',
    noseMouth: '',
    facialHair: '',
    faceMarks: '',
    outfit: '',
    marks: ''
  }
}
function blankPersona(): CharacterPersona {
  return { language: '', traits: '', voice: '', address: '', boundaries: '', samples: '' }
}
function char(id: string, createdAt: number, pinned = false): Character {
  return {
    id,
    name: id.toUpperCase(),
    createdAt,
    ...(pinned ? { pinned: true } : {}),
    fields: { ...blankFields(), identity: `${id} identity` },
    persona: blankPersona()
  }
}
function msg(charId: string, createdAt: number, content = `hi from ${charId}`): ChatMessage {
  return { id: `${charId}-${createdAt}`, charId, role: 'assistant', content, createdAt }
}

describe('homeGrid · 主区顺序', () => {
  it('置顶的排在最前面,其余保持传入顺序', () => {
    const list = [char('a', 30), char('b', 20), char('c', 10, true)]
    // 稳定排序:未置顶那两个的相对次序一点没变
    expect(homeGrid(list).map((c) => c.id)).toEqual(['c', 'a', 'b'])
  })

  it('**排的是副本** —— 传进来的那份顺序还有别的含义(撤销删除要放回原位)', () => {
    const list = [char('a', 30), char('b', 20, true)]
    homeGrid(list)
    expect(list.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('空目录给空表', () => {
    expect(homeGrid([])).toEqual([])
  })
})

describe('recentChats · 次区顺序', () => {
  const lastOf = (table: Record<string, ChatMessage>) => (id: string) => table[id]

  it('按最后一条消息的时间排(最近聊的在前),与创建时间无关', () => {
    const a = char('a', 10)
    const b = char('b', 90) // 建得晚,但聊得早
    const out = recentChats([a, b], lastOf({ a: msg('a', 500), b: msg('b', 100) }))
    expect(out.map((r) => r.char.id)).toEqual(['a', 'b'])
  })

  it('**没聊过的不进这一列** —— "上次说到哪儿了"在它们那儿没有答案', () => {
    const a = char('a', 10)
    const b = char('b', 90)
    const out = recentChats([a, b], lastOf({ b: msg('b', 100) }))
    expect(out.map((r) => r.char.id)).toEqual(['b'])
  })

  it('一个都没聊过时是空列表(次区整块不出现)', () => {
    expect(recentChats([char('a', 1)], lastOf({}))).toEqual([])
  })

  it('置顶优先,其次才是最后一条消息的时间', () => {
    const a = char('a', 10, true)
    const b = char('b', 20)
    const out = recentChats([a, b], lastOf({ a: msg('a', 100), b: msg('b', 900) }))
    expect(out.map((r) => r.char.id)).toEqual(['a', 'b'])
  })

  it('封顶 cap 个,且**取的是排好之后的头部**', () => {
    const chars = ['a', 'b', 'c', 'd', 'e'].map((id, i) => char(id, 100 - i))
    const table = Object.fromEntries(chars.map((c, i) => [c.id, msg(c.id, 500 - i)]))
    const out = recentChats(chars, lastOf(table), RECENT_CAP)
    expect(out).toHaveLength(RECENT_CAP)
    expect(out.map((r) => r.char.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('每条都带着它自己的最后一句', () => {
    const out = recentChats([char('a', 1)], lastOf({ a: msg('a', 7, '记得带伞') }))
    expect(out[0].last.content).toBe('记得带伞')
  })
})

describe('homeIdentity · 卡片上那一行', () => {
  it('优先用 identity 那一栏', () => {
    const c = char('a', 1)
    c.fields!.identity = 'veteran space smuggler'
    c.desc = '用户自己写的备注'
    expect(homeIdentity(c)).toBe('veteran space smuggler')
  })

  it('identity 空时退回用户写的那段备注', () => {
    const c = char('a', 1)
    c.fields!.identity = '   '
    c.desc = ' 一个总在深夜出现的图书管理员 '
    expect(homeIdentity(c)).toBe('一个总在深夜出现的图书管理员')
  })

  it('两处都空时给一句中性的话 —— 空白行看起来像渲染出错', () => {
    const c = char('a', 1)
    c.fields!.identity = ''
    c.desc = ''
    expect(homeIdentity(c)).toBe('No description yet')
  })

  it('老角色可能连 fields 都没有(读盘收口之前的记录)', () => {
    const c = char('a', 1)
    c.fields = undefined as unknown as Character['fields']
    expect(homeIdentity(c)).toBe('No description yet')
  })
})

describe('homeAgo · 那一行"多久以前"', () => {
  const now = 1_700_000_000_000

  it('与对话页 / 系统提示词同一句口径(agoLabel 是唯一出处)', () => {
    expect(homeAgo(now - 3 * 60_000, now)).toBe('3 minutes ago')
    expect(homeAgo(now - 2 * 3_600_000, now)).toBe('2 hours ago')
    expect(homeAgo(now - 4 * 86_400_000, now)).toBe('4 days ago')
  })

  it('太近(agoLabel 认为"不该报")时退回 Just now', () => {
    expect(homeAgo(now - 500, now)).toBe('Just now')
  })

  it('坏时间戳也退回 Just now,不显示 NaN', () => {
    expect(homeAgo(Number.NaN, now)).toBe('Just now')
  })
})

describe('homeSnippet · 那一行摘要', () => {
  it('短句原样返回', () => {
    expect(homeSnippet(msg('a', 1, '今晚想吃面'))).toBe('今晚想吃面')
  })

  it('换行与连续空格压成一个(列表项只有一行)', () => {
    expect(homeSnippet(msg('a', 1, 'a\n\n  b   c'))).toBe('a b c')
  })

  it('超长时收一行并加省略号', () => {
    const long = 'x'.repeat(200)
    const out = homeSnippet(msg('a', 1, long), 90)
    expect(out.length).toBeLessThanOrEqual(91)
    expect(out.endsWith('…')).toBe(true)
  })

  it('空内容给空串(不显示一个省略号了事)', () => {
    expect(homeSnippet(msg('a', 1, ''))).toBe('')
  })
})
