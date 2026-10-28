import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EN, ZH, currentLocale, locale, savedLocale, setLocale, t } from './i18n'

/* 这一份守三条硬不变量:
   ① **中英两份键逐一对齐** —— 漏了中文的键会回落成英文,界面看起来"没翻译完",
      而且没有任何报错。宁可测试红一次,也别让半生不熟的中文界面上线。
   ② t() 的回落链:当前语言 → 英文 → 键名本身(绝不返回 undefined 塌成空白)。
   ③ currentLocale 的优先级:手动存档 > 系统语言;没设过就跟随 navigator。 */

describe('i18n · 语言包一致', () => {
  it('中文包与英文包键集完全一致(没有只补了英文的漏网之鱼)', () => {
    const enKeys = Object.keys(EN).sort()
    const zhKeys = Object.keys(ZH).sort()
    expect(zhKeys).toEqual(enKeys)
  })

  it('每个键在两份里都有非空文案', () => {
    for (const k of Object.keys(EN)) {
      expect(EN[k].trim().length, `EN.${k} 不能为空`).toBeGreaterThan(0)
      expect(ZH[k].trim().length, `ZH.${k} 不能为空`).toBeGreaterThan(0)
    }
  })

  it('插值占位符在两份里一一对应(中文漏了 {n} 会显示错句)', () => {
    const ph = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',')
    for (const k of Object.keys(EN)) {
      expect(ph(ZH[k]), `ZH.${k} 的占位符应与 EN 一致`).toBe(ph(EN[k]))
    }
  })
})

describe('i18n · t() 回落与插值', () => {
  beforeEach(() => {
    locale.value = 'en'
  })

  it('缺词回落英文,再回落键名本身,绝不返回 undefined', () => {
    locale.value = 'zh'
    expect(t('nav.home')).toBe('首页')
    // 一个两份都没有的键:原样返回,界面不至于空白
    expect(t('nope.not.a.key')).toBe('nope.not.a.key')
  })

  it('{n} 一类占位按 params 替换,可重复出现', () => {
    locale.value = 'en'
    expect(t('home.countMany', { n: 3 })).toBe('3 characters')
    locale.value = 'zh'
    expect(t('home.countMany', { n: 3 })).toBe('3 个角色')
  })
})

describe('i18n · currentLocale 优先级', () => {
  /* 纯 Node 环境没有 localStorage / navigator,按仓库惯例用 vi.stubGlobal 造。
     与 prefs.test.ts 同一套路数:测的就是"存档 > 系统"这条优先级,以及没有全局时不抛 */
  let store: Map<string, string>

  function stub(opts: { seed?: Record<string, string>; lang: string }) {
    store = new Map(Object.entries(opts.seed || {}))
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    })
    vi.stubGlobal('navigator', { language: opts.lang })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    locale.value = 'en'
  })

  it('没设过 → 跟随系统:浏览器语言以 zh 开头就用中文', () => {
    stub({ lang: 'en-US' })
    expect(currentLocale()).toBe('en')
    stub({ lang: 'zh-CN' })
    expect(currentLocale()).toBe('zh')
  })

  it('手动设过 → 不再跟系统走', () => {
    stub({ lang: 'zh-CN' })
    // 先切到别的档再切回 en,确保真的落了一次盘(setLocale 同值会提前返回)
    setLocale('zh')
    setLocale('en')
    expect(savedLocale()).toBe('en')
    // 系统仍是中文,但存档说了算
    expect(currentLocale()).toBe('en')
  })

  it('存了个认得的值才作数,别的当没设过', () => {
    stub({ seed: { 'kimage.locale': 'fr' }, lang: 'zh-CN' })
    expect(savedLocale()).toBeNull()
  })

  it('连 localStorage 都没有(纯 Node)也不抛,回落系统再回落英文', () => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('navigator', undefined)
    expect(() => currentLocale()).not.toThrow()
    expect(currentLocale()).toBe('en')
  })
})
