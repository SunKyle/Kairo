import { describe, expect, it } from 'vitest'
import { EMPTY_WITHOUT_IMAGE, EMPTY_WITH_IMAGE, contextText } from './chatContext'

/* 这条规则挡的是"上游按内容为空拒掉整轮请求"(只发图没字的消息在历史里就是空串),
   顺带把"那些图历史里不重发"这件事告诉模型。 */

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
})

describe('contextText · 有正文就一个字不动', () => {
  it('原样返回,连首尾空白也不动 —— 那是用户自己打的', () => {
    expect(contextText({ content: '  hi  ', imageId: 'x' })).toBe('  hi  ')
  })

  it('带图的正常消息也一样', () => {
    expect(contextText({ content: 'look', imageId: 'x' })).toBe('look')
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
