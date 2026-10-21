import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultInteractionPrefs,
  interactionGuidance,
  interactionGuidanceFor,
  isNeutralInteraction,
  loadInteractionPrefs,
  loadInteractionPrefsOf,
  saveInteractionPrefsOf,
  saveImmersive,
  savePhotoDirector,
  savePhotoFrequency,
  savedImmersive,
  savedPhotoDirector,
  savedPhotoFrequency
} from './prefs'
import type { ComfortMode } from '../types'

/* 这一份偏好只有一个职责:**记住用户上次是不是开着沉浸模式**。
   所以两件事必须成立:
   ① 没设过 = 关(存量用户不该被突然换一套骨架);
   ② 存取被禁时不许抛 —— 它在挂载路径上,抛出去整个应用就不渲染了
      (与 lib/theme.ts 同一条硬规矩)。 */

/** 一个最小的 localStorage 替身。只实现这一份代码用到的两个方法 */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map)
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('沉浸模式的偏好', () => {
  it('没设过时是关', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(savedImmersive()).toBe(false)
  })

  it('存下来之后读得回来', () => {
    const ls = fakeStorage()
    vi.stubGlobal('localStorage', ls)
    saveImmersive(true)
    expect(savedImmersive()).toBe(true)
    saveImmersive(false)
    expect(savedImmersive()).toBe(false)
  })

  it("只认 '1' —— 不把别的写法当成开", () => {
    vi.stubGlobal('localStorage', fakeStorage({ 'kimage.immersive': 'true' }))
    expect(savedImmersive()).toBe(false)
  })

  it('存取被禁时不抛:读回默认关,写只是没记住', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('SecurityError')
      },
      setItem() {
        throw new Error('SecurityError')
      }
    })
    expect(savedImmersive()).toBe(false)
    expect(() => saveImmersive(true)).not.toThrow()
  })

  it('连 localStorage 都没有(纯 Node 环境)也不抛', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(savedImmersive()).toBe(false)
    expect(() => saveImmersive(true)).not.toThrow()
  })
})

/* ===== 出图偏好(设置页 Photos) ======================================
   两条默认值都必须"等于没做这个设置之前的样子":
   指导是开着(每张图本来就会多跑一跳),频率是 normal(原来那句劝它少发的口吻)。
   否则升级本身就会替用户改行为 —— 而设置页上并没有人点过任何东西。 */
describe('出图偏好', () => {
  it('摄影指导没设过时是开;存过 0 之后才关', () => {
    const ls = fakeStorage()
    vi.stubGlobal('localStorage', ls)
    expect(savedPhotoDirector()).toBe(true)
    savePhotoDirector(false)
    expect(savedPhotoDirector()).toBe(false)
    expect(ls.dump()['kimage.photoDirector']).toBe('0')
    savePhotoDirector(true)
    expect(savedPhotoDirector()).toBe(true)
  })

  it('频率没设过时是 normal;三档存得回来', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(savedPhotoFrequency()).toBe('normal')
    savePhotoFrequency('rare')
    expect(savedPhotoFrequency()).toBe('rare')
    savePhotoFrequency('often')
    expect(savedPhotoFrequency()).toBe('often')
    savePhotoFrequency('normal')
    expect(savedPhotoFrequency()).toBe('normal')
  })

  it('盘上是别的值(旧版本 / 手改)时落回 normal,不猜', () => {
    vi.stubGlobal('localStorage', fakeStorage({ 'kimage.photoFrequency': 'always' }))
    expect(savedPhotoFrequency()).toBe('normal')
  })

  it('存取被禁 / 没有 localStorage 时回默认且不抛', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(savedPhotoDirector()).toBe(true)
    expect(savedPhotoFrequency()).toBe('normal')
    expect(() => savePhotoDirector(false)).not.toThrow()
    expect(() => savePhotoFrequency('often')).not.toThrow()
  })
})

/* ===== 相处偏好(PRD §3.2-D) ==========================================
   它是唯一一份**会被拼进对话提示词**的偏好,所以除了"存取不抛"那条老规矩,
   还多两条硬要求:
   ① 没表态的维度一个字都不许进提示词(否则等于替用户表态);
   ② 保存一个角色不许抹掉另一个角色的偏好(两个标签页各改各的是常态)。
   -------------------------------------------------------------------- */
describe('相处偏好 · 存取', () => {
  it('没配过时读回 undefined,摊出来的指导是空串', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(loadInteractionPrefsOf('a')).toBeUndefined()
    expect(interactionGuidanceFor('a')).toBe('')
  })

  it('存下来之后读得回来', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    saveInteractionPrefsOf('a', { ...defaultInteractionPrefs(), humor: 'high', comfort: 'listen' })
    const got = loadInteractionPrefsOf('a')
    expect(got?.humor).toBe('high')
    expect(got?.comfort).toBe('listen')
    // 没表态的那几项仍是中性
    expect(got?.directness).toBe('neutral')
  })

  it('全部拨回中性 = 删掉这一条,盘上不留空壳', () => {
    const ls = fakeStorage()
    vi.stubGlobal('localStorage', ls)
    saveInteractionPrefsOf('a', { ...defaultInteractionPrefs(), humor: 'high' })
    expect(loadInteractionPrefsOf('a')).toBeTruthy()
    saveInteractionPrefsOf('a', defaultInteractionPrefs())
    expect(loadInteractionPrefsOf('a')).toBeUndefined()
    expect(Object.keys(loadInteractionPrefs())).toEqual([])
  })

  /* 这条是防"改 A 抹掉 B"的:保存走的是"重读 + 合并单个角色",
     不是拿内存里那份整份覆盖 */
  it('保存一个角色不会抹掉另一个角色', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    saveInteractionPrefsOf('a', { ...defaultInteractionPrefs(), humor: 'high' })
    saveInteractionPrefsOf('b', { ...defaultInteractionPrefs(), pace: 'low' })
    expect(loadInteractionPrefsOf('a')?.humor).toBe('high')
    expect(loadInteractionPrefsOf('b')?.pace).toBe('low')
  })

  it('盘上是坏形状(未知档位 / 不是对象)时落回中性,且不抛', () => {
    vi.stubGlobal(
      'localStorage',
      fakeStorage({
        'kimage.interactionPrefs': JSON.stringify({
          a: { humor: 'very-funny', comfort: 42 },
          b: 'not-an-object',
          c: null
        })
      })
    )
    expect(loadInteractionPrefsOf('a')?.humor).toBe('neutral')
    expect(loadInteractionPrefsOf('a')?.comfort).toBe('neutral')
    expect(loadInteractionPrefsOf('b')?.pace).toBe('neutral')
    expect(loadInteractionPrefsOf('c')?.initiative).toBe('neutral')
  })

  it('存取被禁 / 没有 localStorage 时不抛', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadInteractionPrefsOf('a')).toBeUndefined()
    expect(() => saveInteractionPrefsOf('a', defaultInteractionPrefs())).not.toThrow()
    expect(interactionGuidanceFor('a')).toBe('')
  })
})

describe('相处偏好 · 摊成提示词', () => {
  it('全中性给空串 —— 一个字的指导都不该凭空出现', () => {
    expect(interactionGuidance(undefined)).toBe('')
    expect(interactionGuidance(defaultInteractionPrefs())).toBe('')
  })

  it('只把表过态的维度写进去,没表态的维度一个字都不提', () => {
    const text = interactionGuidance({ ...defaultInteractionPrefs(), humor: 'low' })
    expect(text).toContain('Skip the jokes')
    // 其余四项没表态,不该出现任何一句
    expect(text).not.toContain('Reach out')
    expect(text).not.toContain('plainly')
    expect(text.split('\n')).toHaveLength(1)
  })

  it('三个档位各自对应不同的说法(不是同一句换词)', () => {
    const hi = interactionGuidance({ ...defaultInteractionPrefs(), directness: 'high' })
    const lo = interactionGuidance({ ...defaultInteractionPrefs(), directness: 'low' })
    expect(hi).not.toBe(lo)
    expect(hi).toContain('plainly')
    expect(lo).toContain('gentle')
  })

  it('安慰方式三种做法各写各的', () => {
    const of = (c: ComfortMode) => interactionGuidance({ ...defaultInteractionPrefs(), comfort: c })
    expect(of('listen')).toContain('let them talk')
    expect(of('advise')).toContain('think it through')
    expect(of('distract')).toContain('take their mind off')
    expect(of('neutral')).toBe('')
  })

  it('isNeutralInteraction 认得"全中性"与 undefined', () => {
    expect(isNeutralInteraction(undefined)).toBe(true)
    expect(isNeutralInteraction(defaultInteractionPrefs())).toBe(true)
    expect(isNeutralInteraction({ ...defaultInteractionPrefs(), pace: 'high' })).toBe(false)
  })
})
