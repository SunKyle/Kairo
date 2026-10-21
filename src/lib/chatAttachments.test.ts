import { describe, expect, it } from 'vitest'
import {
  attachmentHost,
  coerceAttachmentPreview,
  coerceChatAttachment,
  normalizeLinkUrl
} from './chatAttachments'

/* 附件是**外部内容**里唯一会变成 `<a href>` 的东西 ——
   一个坏 url 不是"少一张卡",而是一枚能骗人点下去的假链接。
   所以这里钉住两件事:什么地址能被收下,以及收下之后卡片上还剩什么。 */

describe('normalizeLinkUrl · 什么地址能交给 <a href>', () => {
  it('http / https 收下,并归一化成 URL 的规范形状', () => {
    expect(normalizeLinkUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeLinkUrl('  http://example.com/a?b=1  ')).toBe('http://example.com/a?b=1')
  })

  it('别的协议一律不收', () => {
    expect(normalizeLinkUrl('javascript:alert(1)')).toBe('')
    expect(normalizeLinkUrl('data:text/html,hi')).toBe('')
    expect(normalizeLinkUrl('file:///etc/passwd')).toBe('')
    expect(normalizeLinkUrl('ftp://example.com/x')).toBe('')
  })

  it('带账号密码的地址不收', () => {
    expect(normalizeLinkUrl('https://user:pass@example.com/x')).toBe('')
    expect(normalizeLinkUrl('https://user@example.com/x')).toBe('')
  })

  it('本机与内网字面量不收', () => {
    expect(normalizeLinkUrl('http://localhost:3101/x')).toBe('')
    expect(normalizeLinkUrl('http://foo.local/x')).toBe('')
    expect(normalizeLinkUrl('http://192.168.1.2/x')).toBe('')
    expect(normalizeLinkUrl('http://10.0.0.1/x')).toBe('')
    expect(normalizeLinkUrl('http://127.0.0.1/x')).toBe('')
    expect(normalizeLinkUrl('http://[::1]/x')).toBe('')
    // 公网地址照收 —— 这张表是精确的,不是"看着像数字就拒"
    expect(normalizeLinkUrl('http://8.8.8.8/x')).toBe('http://8.8.8.8/x')
  })

  it('空值、非 http(s) 形状、超长地址都回空串', () => {
    expect(normalizeLinkUrl('')).toBe('')
    expect(normalizeLinkUrl(null)).toBe('')
    expect(normalizeLinkUrl('example.com/x')).toBe('')
    expect(normalizeLinkUrl(`https://example.com/${'x'.repeat(2050)}`)).toBe('')
  })
})

describe('coerceChatAttachment · 落库/渲染前的那一枚', () => {
  it('合法附件收成固定形状,标题与副标题压成一行', () => {
    expect(
      coerceChatAttachment({
        kind: 'link',
        title: '  A   quiet  place ',
        url: 'https://example.com/x',
        subtitle: ' you  would like this '
      })
    ).toEqual({
      kind: 'link',
      title: 'A quiet place',
      url: 'https://example.com/x',
      subtitle: 'you would like this'
    })
  })

  it('没有标题时用域名兜底;却连地址都没有/不合法就整块丢掉', () => {
    expect(coerceChatAttachment({ kind: 'link', url: 'https://www.example.com/x' })?.title).toBe(
      'example.com'
    )
    expect(coerceChatAttachment({ kind: 'link', title: 'x', url: 'http://localhost/x' })).toBeUndefined()
    expect(coerceChatAttachment({ kind: 'link', title: 'x' })).toBeUndefined()
  })

  it('kind 认 link 与 music,其余一律丢', () => {
    expect(coerceChatAttachment({ kind: 'video', title: 'x', url: 'https://example.com' })).toBeUndefined()
    expect(coerceChatAttachment({ kind: 'LINK', title: 'x', url: 'https://example.com' })?.kind).toBe('link')
    expect(coerceChatAttachment({ kind: 'Music', title: 'x' })?.kind).toBe('music')
    expect(coerceChatAttachment({ title: 'x', url: 'https://example.com' })).toBeUndefined()
  })

  describe('music：曲名是本体,地址可缺', () => {
    it('纯分享卡（没有 url）照样收', () => {
      expect(coerceChatAttachment({ kind: 'music', title: ' Night Changes ', subtitle: ' Harry Styles ' })).toEqual(
        { kind: 'music', title: 'Night Changes', subtitle: 'Harry Styles' }
      )
    })

    it('有合法地址就带上（卡片可点）', () => {
      expect(
        coerceChatAttachment({ kind: 'music', title: 'x', url: 'https://example.com/song' })
      ).toEqual({ kind: 'music', title: 'x', url: 'https://example.com/song' })
    })

    it('坏地址只丢地址、留住这张卡 —— 与链接整块丢不同', () => {
      expect(coerceChatAttachment({ kind: 'music', title: 'x', url: 'http://localhost/x' })).toEqual({
        kind: 'music',
        title: 'x'
      })
    })

    it('缺曲名才整块丢（没有名字就无从分享）', () => {
      expect(coerceChatAttachment({ kind: 'music', url: 'https://example.com/song' })).toBeUndefined()
      expect(coerceChatAttachment({ kind: 'music', title: '   ' })).toBeUndefined()
    })
  })

  it('非对象、数组、null 都丢', () => {
    expect(coerceChatAttachment(null)).toBeUndefined()
    expect(coerceChatAttachment([])).toBeUndefined()
    expect(coerceChatAttachment('https://example.com')).toBeUndefined()
  })

  it('预览跟着一起收;它是可缺的,且空的那几项不占位', () => {
    const got = coerceChatAttachment({
      kind: 'link',
      title: 'x',
      url: 'https://example.com/x',
      preview: { description: '  the  gist ', siteName: 'Example' }
    })
    expect(got?.preview).toEqual({ description: 'the gist', siteName: 'Example' })
    const bare = coerceChatAttachment({
      kind: 'link',
      title: 'x',
      url: 'https://example.com/x',
      preview: { description: '   ' }
    })
    expect(bare?.preview).toBeUndefined()
  })
})

describe('coerceAttachmentPreview · 服务端预览那一行', () => {
  it('三项都空时不返回一个空壳', () => {
    expect(coerceAttachmentPreview({})).toBeUndefined()
    expect(coerceAttachmentPreview({ title: '  ', description: '\n' })).toBeUndefined()
    expect(coerceAttachmentPreview(null)).toBeUndefined()
  })

  it('描述按 240 字截断,站点名按 80 字截断', () => {
    const got = coerceAttachmentPreview({
      description: 'x'.repeat(500),
      siteName: 'y'.repeat(120)
    })
    expect(got?.description?.length).toBe(240)
    expect(got?.siteName?.length).toBe(80)
  })
})

describe('attachmentHost', () => {
  it('域名去掉 www.,坏地址回空串', () => {
    expect(attachmentHost('https://www.example.com/x')).toBe('example.com')
    expect(attachmentHost('not a url')).toBe('')
  })
})
