import { describe, expect, it } from 'vitest'
import { parseLinkPreview } from '../../server/linkPreviewParse.js'

/* 真实网页的 meta 标签什么写法都有:单引号、不带引号、属性换序、实体……
   卡片上的标题就是从这些字节里读出来的,所以这里按"喂一段 HTML、要三个字段"
   的方式钉住优先级与清洗。 */

describe('parseLinkPreview · 标题的优先级', () => {
  it('og:title 优先于 <title>', () => {
    const got = parseLinkPreview(
      `<head><title>Site — Some article</title>
       <meta property="og:title" content="The real title"></head>`,
      'https://example.com/x'
    )
    expect(got.title).toBe('The real title')
  })

  it('没有 og:title 时退 twitter:title,再退 <title>', () => {
    expect(
      parseLinkPreview(`<meta name="twitter:title" content="From twitter"><title>From tag</title>`, 'https://example.com')
        .title
    ).toBe('From twitter')
    expect(parseLinkPreview(`<title>  From   tag </title>`, 'https://example.com').title).toBe(
      'From tag'
    )
  })

  it('只剩 <title> 时也把里面的标签与实体洗干净', () => {
    const got = parseLinkPreview(
      `<title>A &amp; B &#x2014; <b>note</b>&nbsp;here</title>`,
      'https://example.com'
    )
    expect(got.title).toBe('A & B — note here')
  })

  it('标题按 120 字截断', () => {
    expect(parseLinkPreview(`<title>${'x'.repeat(300)}</title>`, 'https://example.com').title.length).toBe(
      120
    )
  })
})

describe('parseLinkPreview · 描述与站点名', () => {
  it('描述按 og → twitter → name=description 的顺序找', () => {
    const html = `
      <meta name="description" content="plain">
      <meta name="twitter:description" content="twitter">
      <meta property="og:description" content="og">
    `
    expect(parseLinkPreview(html, 'https://example.com').description).toBe('og')
    expect(
      parseLinkPreview(`<meta name="twitter:description" content="twitter">`, 'https://example.com')
        .description
    ).toBe('twitter')
    expect(parseLinkPreview(`<meta name="description" content="plain">`, 'https://example.com').description).toBe(
      'plain'
    )
  })

  it('没给 site name 时用域名兜底,并去掉 www.', () => {
    expect(parseLinkPreview('<title>x</title>', 'https://www.example.com/a').siteName).toBe(
      'example.com'
    )
    expect(
      parseLinkPreview(`<meta property="og:site_name" content="Example Press">`, 'https://example.com')
        .siteName
    ).toBe('Example Press')
  })

  it('描述按 240 字、站点名按 80 字截断', () => {
    const got = parseLinkPreview(
      `<meta property="og:description" content="${'d'.repeat(500)}">
       <meta property="og:site_name" content="${'s'.repeat(200)}">`,
      'https://example.com'
    )
    expect(got.description.length).toBe(240)
    expect(got.siteName.length).toBe(80)
  })
})

describe('parseLinkPreview · 真实网页里那些不规矩的写法', () => {
  it('单引号、不带引号、属性换序都认', () => {
    const html = `
      <META content='Single quoted' property='og:title'>
      <meta content=Unquoted name=description>
    `
    const got = parseLinkPreview(html, 'https://example.com')
    expect(got.title).toBe('Single quoted')
    expect(got.description).toBe('Unquoted')
  })

  it('同一个键出现多次时只认第一枚', () => {
    const html = `
      <meta property="og:title" content="first">
      <meta property="og:title" content="second">
    `
    expect(parseLinkPreview(html, 'https://example.com').title).toBe('first')
  })

  it('什么都没有时返回空串,不抛错', () => {
    expect(parseLinkPreview('', 'https://example.com')).toEqual({
      title: '',
      description: '',
      siteName: 'example.com'
    })
    expect(parseLinkPreview('', 'not a url')).toEqual({
      title: '',
      description: '',
      siteName: ''
    })
  })
})
