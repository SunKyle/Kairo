import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveImmersive, savedImmersive } from './prefs'

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
