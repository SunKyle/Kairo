import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  isSettingsSection,
  normalizeSection
} from './settingsNav'

/* 这一份只关心一件事:**分区名收得住吗**。
   它是从地址栏 / 老书签里读回来的东西 —— 一个拼错的分区名
   不该让设置页开成空白(那看起来像坏了)。 */

describe('settingsNav · 分区清单', () => {
  it('默认分区在清单里 —— 否则落进设置页会是一个不存在的区', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.key)).toContain(DEFAULT_SETTINGS_SECTION)
  })

  it('分区名不重复', () => {
    const keys = SETTINGS_SECTIONS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('每一区都有标签与说明 —— 导航只显示标签,说明是悬停/读屏用的', () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(s.label).toBeTruthy()
      expect(s.hint).toBeTruthy()
    }
  })

  it('不含「主动联系与通知」—— T6 还没做,先不给一区点不动的控件', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.key)).not.toContain('proactive')
  })
})

describe('settingsNav · 收口', () => {
  it('认得的分区原样放行', () => {
    for (const s of SETTINGS_SECTIONS) expect(normalizeSection(s.key)).toBe(s.key)
  })

  it('认不出来的一律退回默认,不返回空', () => {
    expect(normalizeSection('nope')).toBe(DEFAULT_SETTINGS_SECTION)
    expect(normalizeSection('')).toBe(DEFAULT_SETTINGS_SECTION)
    expect(normalizeSection(undefined)).toBe(DEFAULT_SETTINGS_SECTION)
    expect(normalizeSection(null)).toBe(DEFAULT_SETTINGS_SECTION)
    expect(normalizeSection(7)).toBe(DEFAULT_SETTINGS_SECTION)
    /* 原型链上的键不该被当成合法分区 —— 'toString' 这种值会从 hasOwnProperty 的写法里漏过去 */
    expect(normalizeSection('toString')).toBe(DEFAULT_SETTINGS_SECTION)
  })

  it('isSettingsSection 与 normalizeSection 同一口径', () => {
    for (const v of ['appearance', 'api', 'nope', '', null, 0, {}]) {
      expect(isSettingsSection(v)).toBe(normalizeSection(v) === v)
    }
  })
})

/* —— 防漂移:注册表里加了分区,主界面得真有那一个分支 ——
   分区清单在这一层,而"渲染哪一块"在 App.vue 的装配里(SettingsPage 只是
   骨架,内容走插槽 —— 见那边的说明)。两处对不上时不会有任何报错:
   新分区点下去右侧会**空白**。所以读源码断言一次,与 lib/crossTab.test.ts
   那条同一套路数:宁可测试红一次,也不要一个点下去什么都不显示的导航项。 */
describe('settingsNav · 与主界面的装配保持一致', () => {
  const SOURCES = import.meta.glob('../App.vue', {
    query: '?raw',
    import: 'default',
    eager: true
  }) as Record<string, string>

  it('每个分区在 App.vue 里都有一个 settingsSection === 分支', () => {
    const code = Object.values(SOURCES)[0] || ''
    /* 至少该扫到东西,否则说明 glob 路径已经不对了(空串会让下面假装通过) */
    expect(code.length).toBeGreaterThan(1000)
    for (const s of SETTINGS_SECTIONS) {
      expect(
        code.includes(`settingsSection === '${s.key}'`),
        `分区 ${s.key} 在 App.vue 里没有对应的渲染分支`
      ).toBe(true)
    }
  })
})
