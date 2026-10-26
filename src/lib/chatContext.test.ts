import { describe, expect, it } from 'vitest'
import {
  EMPTY_WITHOUT_IMAGE,
  EMPTY_WITH_CARD,
  EMPTY_WITH_IMAGE,
  chatContextWindow,
  contextText
} from './chatContext'
import type { ChatMessage } from '../types'

/* 这条规则挡的是"上游按内容为空拒掉整轮请求"(只发图没字的消息在历史里就是空串),
   顺带把"那些图/卡历史里不重发"这件事告诉模型。

   注意这里**不再补附件细节**:`(a song was shared — …)` 那样的行是助手正文,
   模型会当台词照抄(实测)。发过哪几张卡改由 useChatFlow 的 shares 带给服务端,
   在 system 简报里交待。 */

describe('contextText · 空正文换成给模型看的占位', () => {
  it('只发图没字:换成"发了张图"', () => {
    expect(contextText({ content: '', imageId: 'img-1' })).toBe(EMPTY_WITH_IMAGE)
  })

  it('角色发的那张同样算', () => {
    expect(contextText({ content: '', photoId: 'p-1' })).toBe(EMPTY_WITH_IMAGE)
  })

  it('什么都没有的空消息:换成另一句,不猜成图片', () => {
    expect(contextText({ content: '' })).toBe(EMPTY_WITHOUT_IMAGE)
  })

  it('全是空白的也算空(用户按了几个空格就发出去)', () => {
    expect(contextText({ content: '   \n  ', imageId: 'x' })).toBe(EMPTY_WITH_IMAGE)
    expect(contextText({ content: '\t' })).toBe(EMPTY_WITHOUT_IMAGE)
  })

  it('只转了一个链接、一个字没写:只说"发过一张卡",不把细节写成可模仿的旁白', () => {
    expect(
      contextText({
        content: '',
        attachment: { kind: 'link', title: 'A post', url: 'https://example.com/x' }
      })
    ).toBe(EMPTY_WITH_CARD)
  })

  it('图与卡都有时两句都在,各占一行', () => {
    expect(
      contextText({
        content: '',
        photoId: 'p-1',
        attachment: { kind: 'link', title: 'A post', url: 'https://example.com/x' }
      })
    ).toBe(`${EMPTY_WITH_IMAGE}\n${EMPTY_WITH_CARD}`)
  })

  it('只分享一首歌、没写正文:同样只说"发过一张卡"', () => {
    expect(
      contextText({
        content: '',
        attachment: { kind: 'music', title: 'Night Changes', subtitle: 'Harry Styles' }
      })
    ).toBe(EMPTY_WITH_CARD)
  })

  it('歌带了地址也一样 —— 细节进 system 简报,不进正文', () => {
    expect(
      contextText({
        content: '',
        attachment: { kind: 'music', title: 'Solo', url: 'https://example.com/s' }
      })
    ).toBe(EMPTY_WITH_CARD)
  })
})

describe('contextText · 有正文就一个字不动', () => {
  it('原样返回,连首尾空白也不动 —— 那是用户自己打的', () => {
    expect(contextText({ content: '  hi  ', imageId: 'x' })).toBe('  hi  ')
  })

  it('带图的正常消息也一样', () => {
    expect(contextText({ content: 'look', imageId: 'x' })).toBe('look')
  })

  it('带卡片的正常消息:正文一个字不动,也**不补**任何旁白', () => {
    expect(
      contextText({
        content: '  you would like this  ',
        attachment: { kind: 'link', title: 'A post', url: 'https://example.com/x' }
      })
    ).toBe('  you would like this  ')
  })

  it('标题里那种全角/换行正文照旧', () => {
    expect(contextText({ content: '第一行\n第二行' })).toBe('第一行\n第二行')
  })
})

describe('contextText · 退化输入', () => {
  it('content 不是字符串时不抛', () => {
    expect(contextText({ content: undefined as unknown as string })).toBe(EMPTY_WITHOUT_IMAGE)
    expect(contextText({ content: 42 as unknown as string })).toBe('42')
  })
})

/* 摘要游标与"最近一窗"之间的那段空窗。只取 slice(-20) 时,游标之后、
   窗口之前的 1~19 条既不在摘要里,也没随请求发出去 —— 用户会觉得它刚忘事 */
function msg(n: number, at = n): ChatMessage {
  return {
    id: `m${n}`,
    charId: 'c1',
    role: n % 2 ? 'user' : 'assistant',
    content: `line ${n}`,
    createdAt: at
  }
}
function ids(list: ChatMessage[]): string[] {
  return list.map((m) => m.id)
}

describe('chatContextWindow · 没有摘要时只取最近一窗', () => {
  it('取最后 window 条,按原顺序', () => {
    const list = Array.from({ length: 30 }, (_, i) => msg(i + 1))
    expect(ids(chatContextWindow(list, null, 20, 40))).toEqual(
      Array.from({ length: 20 }, (_, i) => `m${i + 11}`)
    )
  })

  it('窗口本身也不能越过服务端的条数上限', () => {
    const list = Array.from({ length: 30 }, (_, i) => msg(i + 1))
    expect(ids(chatContextWindow(list, undefined, 50, 12))).toEqual(
      Array.from({ length: 12 }, (_, i) => `m${i + 19}`)
    )
  })

  it('upToAt 为 0(或缺省)等同于"还没压过",不补空窗', () => {
    const list = Array.from({ length: 30 }, (_, i) => msg(i + 1))
    expect(ids(chatContextWindow(list, { upToAt: 0 }, 20, 40))).toHaveLength(20)
  })
})

describe('chatContextWindow · 有摘要时补上"游标之后、窗口之前"', () => {
  it('游标之后的消息与最近一窗并集,顺序不变', () => {
    const list = Array.from({ length: 10 }, (_, i) => msg(i + 1))
    // 游标停在 m5,窗口只盖住 m9/m10 —— 空窗是 m6~m8
    expect(ids(chatContextWindow(list, { upToAt: 5 }, 2, 40))).toEqual([
      'm6',
      'm7',
      'm8',
      'm9',
      'm10'
    ])
  })

  it('游标那条自己不再发(它已经进了摘要)', () => {
    const list = Array.from({ length: 10 }, (_, i) => msg(i + 1))
    expect(ids(chatContextWindow(list, { upToAt: 8 }, 2, 40))).toEqual(['m9', 'm10'])
  })

  it('时间戳相同的那条也算已覆盖 —— 边界是开区间 (upToAt, …]', () => {
    const list = [msg(1), msg(2, 100), msg(3, 100), msg(4, 101)]
    expect(ids(chatContextWindow(list, { upToAt: 100 }, 1, 40))).toEqual(['m4'])
  })

  it('并集封顶时丢最旧的 —— 最新的一窗永远保留', () => {
    const list = Array.from({ length: 10 }, (_, i) => msg(i + 1))
    expect(ids(chatContextWindow(list, { upToAt: 1 }, 2, 5))).toEqual([
      'm6',
      'm7',
      'm8',
      'm9',
      'm10'
    ])
  })

  it('窗口为 0 时只发游标之后的(仍受上限封顶)', () => {
    const list = Array.from({ length: 10 }, (_, i) => msg(i + 1))
    expect(ids(chatContextWindow(list, { upToAt: 3 }, 0, 40))).toEqual([
      'm4',
      'm5',
      'm6',
      'm7',
      'm8',
      'm9',
      'm10'
    ])
  })

  it('同一个 id 只出现一次(窗口与"游标之后"重叠)', () => {
    const list = Array.from({ length: 10 }, (_, i) => msg(i + 1))
    // 窗口盖住 m6~m10,游标在 m1 —— "游标之后"也包含这五条,并集不能翻倍
    const out = chatContextWindow(list, { upToAt: 1 }, 5, 40)
    expect(ids(out)).toEqual(ids(list.slice(1)))
    expect(new Set(ids(out)).size).toBe(out.length)
  })

  it('不改动传进来的数组', () => {
    const list = Array.from({ length: 10 }, (_, i) => msg(i + 1))
    const before = ids(list)
    chatContextWindow(list, { upToAt: 3 }, 2, 4)
    expect(ids(list)).toEqual(before)
  })
})

describe('chatContextWindow · 退化输入', () => {
  it('空数组给空数组', () => {
    expect(chatContextWindow([], { upToAt: 3 })).toEqual([])
  })

  it('上限最小保底 1 条,不会因为传 0 变空', () => {
    const list = [msg(1), msg(2)]
    expect(ids(chatContextWindow(list, { upToAt: 1 }, 2, 0))).toEqual(['m2'])
  })
})
