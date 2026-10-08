import { describe, expect, it } from 'vitest'
import { chatWorkLabel, isChatWork, workText, workTitle } from './chatWork'

/* 这一层决定界面上那几处怎么说同一句话:图砖角标、预览正文、作品墙标记。
   判据全是字符串,所以直接断言 —— 到界面上试要造记录、点开预览才看得到 */

const chatPhoto = {
  prompt: 'photographic, a woman on a balcony, selfie at arm’s length, front camera',
  scene: 'me on the balcony at dusk'
}

describe('chatWorkLabel · 出处那句话', () => {
  it('两种对话来源各说各的一句', () => {
    expect(chatWorkLabel('chat-photo')).toBe('Sent in chat')
    expect(chatWorkLabel('chat-backdrop')).toBe('Chat background')
  })

  it('不是对话来的 = 没有出处可说(返回空串,而不是一句兜底话)', () => {
    expect(chatWorkLabel(undefined)).toBe('')
    expect(chatWorkLabel('')).toBe('')
  })

  it('认不出的来源当没有来源:宁可少一枚角标,也不要显示一个 undefined', () => {
    expect(chatWorkLabel('chat-sticker')).toBe('')
    expect(chatWorkLabel('__proto__')).toBe('')
  })
})

describe('isChatWork · 要不要画角标', () => {
  it('两种对话来源为真', () => {
    expect(isChatWork('chat-photo')).toBe(true)
    expect(isChatWork('chat-backdrop')).toBe(true)
  })

  it('缺省、空串与认不出的来源都为假', () => {
    expect(isChatWork(undefined)).toBe(false)
    expect(isChatWork('')).toBe(false)
    expect(isChatWork('workbench')).toBe(false)
  })
})

describe('workText · 读哪一句', () => {
  it('对话那两种读场景,不读那段摄影提示词', () => {
    expect(workText(chatPhoto)).toBe('me on the balcony at dusk')
  })

  it('没有场景的记录(工作台出的图)读提示词', () => {
    expect(workText({ prompt: 'a cat by the window' })).toBe('a cat by the window')
  })

  it('场景是空白 = 当作没有场景,退回提示词(而不是显示一片空白)', () => {
    expect(workText({ prompt: 'a cat', scene: '   ' })).toBe('a cat')
    expect(workText({ prompt: 'a cat', scene: '' })).toBe('a cat')
  })

  it('场景两侧的空白收掉:它是原样进提示词的那段,别把空格读进界面', () => {
    expect(workText({ prompt: 'x', scene: '  on the roof  ' })).toBe('on the roof')
  })
})

describe('workTitle · 短标题', () => {
  it('对话来源的标题由场景派生,而不是那段机位话', () => {
    expect(workTitle(chatPhoto)).toBe('Me on the balcony')
  })

  it('普通记录照旧由提示词派生', () => {
    expect(workTitle({ prompt: 'a cinematic portrait of a girl' })).toBe('Cinematic portrait')
  })

  it('两边都空时给一个占位,不返回空串', () => {
    expect(workTitle({ prompt: '', scene: '' })).toBe('Untitled')
  })
})
