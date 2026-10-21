import { describe, expect, it } from 'vitest'
import { noteHold, stripShareNotes, stripTranscriptNotes } from '../../server/chatNotes.js'

/* 这两道清理是"模型照抄历史旁白"那个 bug 的出口保险:
   - 入口只清**分享旁白**,占位要留着(它还承担"这一轮是什么"的信息);
   - 出口全清,模型不该产出其中任何一种;
   - noteHold 让旁白在流式里不要闪一下再消失。 */

describe('stripShareNotes · 入口只清分享旁白', () => {
  it('摘掉独占一行的链接/歌曲旁白,正文留着', () => {
    expect(
      stripShareNotes('这首给你。\n(a song was shared — "道山靓仔" by 五条人)')
    ).toBe('这首给你。')
    expect(
      stripShareNotes('看这个\n(a link was shared — "A post": https://example.com/x)\n好看吧')
    ).toBe('看这个\n好看吧')
  })

  it('三种占位不摘 —— 它们还要告诉模型这一轮不是空白', () => {
    expect(stripShareNotes('(sent a photo)')).toBe('(sent a photo)')
    expect(stripShareNotes('(sent a card)')).toBe('(sent a card)')
    expect(stripShareNotes('(said nothing)')).toBe('(said nothing)')
  })

  it('夹在句子中间的括号不碰 —— 那可能是角色真的在说这句话', () => {
    const line = 'I heard someone say (a song was shared — "X") at the bar.'
    expect(stripShareNotes(line)).toBe(line)
  })

  it('什么都没摘时一个字都不动', () => {
    expect(stripShareNotes('  两个空格开头\n结尾也有  ')).toBe('  两个空格开头\n结尾也有  ')
  })

  it('摘完把多余空行与末尾空白收掉', () => {
    expect(stripShareNotes('话\n\n(a song was shared — "X")\n')).toBe('话')
  })
})

describe('stripTranscriptNotes · 出口全清', () => {
  it('分享旁白与三种占位都清', () => {
    expect(stripTranscriptNotes('(a song was shared — "X")\n(sent a photo)\n(said nothing)\n(sent a card)')).toBe('')
    expect(stripTranscriptNotes('我说完了。\n(a link was shared — "X": https://example.com)')).toBe('我说完了。')
  })

  it('普通的括号正文不碰', () => {
    expect(stripTranscriptNotes('(laughs) fine.')).toBe('(laughs) fine.')
  })
})

describe('noteHold · 流式扣住可能长成旁白的末行', () => {
  it('以旁白前缀开头:扣到行首', () => {
    expect(noteHold('说完了\n(a song was shar')).toBe(4)
    expect(noteHold('(a li')).toBe(0)
    expect(noteHold('说完了\n(sent a pho')).toBe(4)
  })

  it('普通正文:全放出去,不多等一拍', () => {
    expect(noteHold('说完了\n(I remember that night')).toBe('说完了\n(I remember that night'.length)
    expect(noteHold('说完了\n')).toBe('说完了\n'.length)
  })

  it('形似但已经分岔:全放 (a song I heard 不是旁白', () => {
    expect(noteHold('(a song I heard')).toBe('(a song I heard'.length)
  })

  it('空缓冲:放零个', () => {
    expect(noteHold('')).toBe(0)
  })
})
