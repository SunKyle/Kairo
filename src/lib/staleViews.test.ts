import { describe, expect, it } from 'vitest'
import { sameStale, staleAfterGen, staleAfterSpecChange } from './staleViews'
import type { CharacterViewKind } from '../types'

describe('staleAfterGen · 重跑一张之后的待确认清单', () => {
  it('重跑正脸:其余每一张都过期,正脸自己不在清单里', () => {
    const existing: CharacterViewKind[] = ['front', 'full', 'side', 'outfit']
    expect(staleAfterGen('front', existing, [])).toEqual(['full', 'side', 'outfit'])
  })

  it('重跑正脸:只出过正脸时清单为空(没有"其余"可过期)', () => {
    expect(staleAfterGen('front', ['front'], [])).toEqual([])
  })

  it('重跑正脸:**永远不含 front** —— 界面靠这一点分辨"换脸"与"改设定"', () => {
    const existing: CharacterViewKind[] = ['front', 'full', 'body', 'detail']
    expect(staleAfterGen('front', existing, [])).not.toContain('front')
    // 之前正脸就在清单里(改过设定),重跑之后也该被摘掉
    expect(staleAfterGen('front', existing, ['front', 'full'])).not.toContain('front')
  })

  it('重跑别的张:只把它自己摘掉,其余不动', () => {
    expect(staleAfterGen('full', ['front', 'full', 'side'], ['full', 'side'])).toEqual(['side'])
  })

  it('重跑别的张:它本来就不在清单里时,清单原样不动', () => {
    expect(staleAfterGen('outfit', ['front', 'full'], ['full'])).toEqual(['full'])
  })

  it('重跑正脸会带上"当时没在清单里、但确实有图"的那几张', () => {
    // 上一轮只标了 full,而 side 后来也生成了 —— 换脸之后 side 同样过期
    expect(staleAfterGen('front', ['front', 'full', 'side'], ['full'])).toEqual([
      'full',
      'side'
    ])
  })

  it('去重:同一张被传了两次也只出现一次', () => {
    expect(staleAfterGen('front', ['front', 'full', 'full'], [])).toEqual(['full'])
    expect(staleAfterGen('side', ['front', 'side'], ['side', 'side'])).toEqual([])
  })
})

describe('staleAfterSpecChange · 改设定之后的待确认清单', () => {
  it('所有已出过的图都过期 —— **包括正脸**(它也是照旧设定生的)', () => {
    expect(staleAfterSpecChange(['front', 'full', 'side'])).toEqual(['front', 'full', 'side'])
  })

  it('一张图都没有时是空清单', () => {
    expect(staleAfterSpecChange([])).toEqual([])
  })

  it('与 staleAfterGen 的关键差别:正脸在清单里', () => {
    const existing: CharacterViewKind[] = ['front', 'full']
    expect(staleAfterSpecChange(existing)).toContain('front')
    expect(staleAfterGen('front', existing, [])).not.toContain('front')
  })

  it('不改动传入的数组(纯函数,不留副作用)', () => {
    const existing: CharacterViewKind[] = ['front', 'full']
    staleAfterSpecChange(existing)
    expect(existing).toEqual(['front', 'full'])
  })
})

describe('sameStale · 两份清单是不是同一批', () => {
  it('顺序不同算同一批', () => {
    expect(sameStale(['full', 'side'], ['side', 'full'])).toBe(true)
  })

  it('张数不同就不算', () => {
    expect(sameStale(['full'], ['full', 'side'])).toBe(false)
  })

  it('内容不同就不算', () => {
    expect(sameStale(['full'], ['side'])).toBe(false)
  })

  it('两个空清单算同一批(这是"没有过期的图"的常态)', () => {
    expect(sameStale([], [])).toBe(true)
  })
})
