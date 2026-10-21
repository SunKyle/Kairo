import { describe, expect, it } from 'vitest'
import { sharedCardsBrief } from '../../server/chatShare.js'

/* 历史里发过的卡改成 system 里一段**说人话**的简报。
   为什么不能写回助手正文:模型会把那行括号当自己写过的台词照抄(实测)。
   所以这里同时钉两件事:信息还在(曲名/歌手/地址),且**不出现可模仿的括号模板**。 */

describe('sharedCardsBrief · 历史里的卡,进 system 的简报', () => {
  it('一首歌:曲名 + 歌手;没有地址就不硬贴', () => {
    const s = sharedCardsBrief([
      { role: 'assistant', attachment: { kind: 'music', title: '道山靓仔', subtitle: '五条人' } }
    ])
    expect(s).toContain('You put on a song: "道山靓仔" by 五条人')
    expect(s).not.toContain('(a song was shared')
    expect(s).not.toContain('http')
  })

  it('链接:标题与地址', () => {
    const s = sharedCardsBrief([
      { role: 'assistant', attachment: { kind: 'link', title: 'A post', url: 'https://example.com/x' } }
    ])
    expect(s).toContain('You shared a link: "A post" — https://example.com/x')
    expect(s).not.toContain('(a link was shared')
  })

  it('用户发的那张说 The user', () => {
    const s = sharedCardsBrief([
      { role: 'user', attachment: { kind: 'link', title: 'A post', url: 'https://example.com/x' } }
    ])
    expect(s).toContain('The user shared a link')
  })

  it('坏的那条整条丢;一条都不剩就整段不出现', () => {
    expect(
      sharedCardsBrief([
        { role: 'assistant', attachment: { kind: 'link', title: 'x', url: 'http://127.0.0.1:9/x' } }
      ])
    ).toBe('')
    expect(sharedCardsBrief([{ role: 'assistant', attachment: { kind: 'nope', title: 'x' } }])).toBe('')
  })

  it('一首带坏地址的歌:只丢地址,歌还在', () => {
    const s = sharedCardsBrief([
      {
        role: 'assistant',
        attachment: { kind: 'music', title: 'Real Home', url: 'http://localhost/x' }
      }
    ])
    expect(s).toContain('"Real Home"')
    expect(s).not.toContain('localhost')
  })

  it('只交待最近 8 张', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      role: 'assistant',
      attachment: { kind: 'music', title: `Song ${i}` }
    }))
    const s = sharedCardsBrief(many)
    expect(s).not.toContain('Song 0')
    expect(s).toContain('Song 8')
    expect(s.split('\n').filter((l) => l.startsWith('- ')).length).toBe(8)
  })

  it('不是数组 / 空数组 → 空串,整段不出现', () => {
    expect(sharedCardsBrief(null)).toBe('')
    expect(sharedCardsBrief(undefined)).toBe('')
    expect(sharedCardsBrief([])).toBe('')
  })
})
