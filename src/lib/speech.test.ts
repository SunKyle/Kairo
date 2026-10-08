import { describe, expect, it } from 'vitest'
import { langTagOf, toneWithMood } from './speech'

/* 角色设的"说哪种语言"要折成系统音色表认的那个 lang 前缀。
   这一栏是自由文本,所以认法有好几层 —— 而每层都有一种真实的写法会踩空:
   语言代码、写成哪种文字、常见语言名。测的就是这三层各自的边角。
   (挑错了嗓子不会报错,只会"我明明设了日语,它却用英语念" ——
   所以这几条只能靠测试盯着) */
describe('langTagOf · 角色设的语言 → 音色表认的 lang', () => {
  it('语言代码原样认,带地区后缀也只取前两位', () => {
    expect(langTagOf('en')).toBe('en')
    expect(langTagOf('en-US')).toBe('en')
    expect(langTagOf('zh_CN')).toBe('zh')
    expect(langTagOf('JA-jp')).toBe('ja')
  })

  it('常见语言名认得出', () => {
    expect(langTagOf('English')).toBe('en')
    expect(langTagOf('japanese')).toBe('ja')
    expect(langTagOf('Brazilian Portuguese')).toBe('pt')
  })

  it('写成哪种文字就是哪种语言,而且假名要先于汉字判', () => {
    // 「日本語」里有汉字,先判汉字就会认成中文 —— 这条就是防这个的
    expect(langTagOf('日本語')).toBe('ja')
    expect(langTagOf('中文')).toBe('zh')
    expect(langTagOf('简体中文')).toBe('zh')
    expect(langTagOf('한국어')).toBe('ko')
  })

  it('认不出来就返回空串,退回按文本猜', () => {
    // 三字母的代码不认:它会撞上 the / you 这类英文常用词
    expect(langTagOf('the')).toBe('')
    expect(langTagOf('Klingon')).toBe('')
    expect(langTagOf('')).toBe('')
    expect(langTagOf('   ')).toBe('')
  })
})

/* 情绪 → 语调。这张表**注定覆盖不全**(情绪词是模型自由写的),所以
   这一组测的重点不是"覆盖了多少",而是两件事:
   ① 认不出时一个字都不动(不猜);② 认得出时也只动一点点。 */
describe('toneWithMood · 情绪叠到语速与音高上', () => {
  const BASE = { rate: 1, pitch: 1 }

  it('认得出的情绪:方向和幅度都对', () => {
    const tired = toneWithMood(BASE.rate, BASE.pitch, 'tired')
    expect(tired.rate).toBeLessThan(BASE.rate)
    expect(tired.pitch).toBeLessThan(BASE.pitch)

    const amused = toneWithMood(BASE.rate, BASE.pitch, 'amused')
    expect(amused.rate).toBeGreaterThan(BASE.rate)
    expect(amused.pitch).toBeGreaterThan(BASE.pitch)
  })

  it('幅度小 —— 是同一把嗓子换了个心情,不是换了一个人', () => {
    /* 容差不是随手加的:`1 + 0.06 - 1` 在浮点下是 0.06000000000000005,
       拿 0.06 当上界会红。断言的是"这一档有多小",不是精确的二进制相等 */
    for (const mood of ['tired', 'amused', 'angry', 'warm', 'arrogant']) {
      const t = toneWithMood(1, 1, mood)
      expect(Math.abs(t.rate - 1)).toBeLessThan(0.061)
      expect(Math.abs(t.pitch - 1)).toBeLessThan(0.081)
    }
  })

  it('认不出就不动 —— 情绪词是自由写的,覆盖不到时绝不猜', () => {
    for (const mood of ['', '  ', 'wistful', 'hangry', '喵', undefined, null]) {
      expect(toneWithMood(1, 1, mood as never)).toEqual(BASE)
    }
    // 大小写与空白要容忍:模型写 Mood:Tired 也认
    expect(toneWithMood(1, 1, ' TIRED ')).not.toEqual(BASE)
  })

  it('整词匹配,不做子串 —— unamused 与 amused 正好相反', () => {
    expect(toneWithMood(1, 1, 'unamused')).toEqual(BASE)
    expect(toneWithMood(1, 1, 'amused')).not.toEqual(BASE)
  })

  it('用户自己配过极端值时叠完要夹回安全区', () => {
    const high = toneWithMood(1.48, 1.48, 'delighted')
    expect(high.rate).toBeLessThanOrEqual(1.5)
    expect(high.pitch).toBeLessThanOrEqual(1.5)
    const low = toneWithMood(0.52, 0.52, 'tired')
    expect(low.rate).toBeGreaterThanOrEqual(0.5)
    expect(low.pitch).toBeGreaterThanOrEqual(0.5)
  })
})
