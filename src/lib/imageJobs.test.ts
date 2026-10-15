import { describe, expect, it } from 'vitest'
import { abortCharImages, registerImageJob, unregisterImageJob } from './imageJobs'

/* 登记表是模块级的单例,没有 reset —— 每个用例用互不相同的 charId 来互不干扰。
   断言的都是"外部可观察的行为":abort 到没到、会不会误伤、会不会抛 */
describe('imageJobs · 在途出图登记表', () => {
  it('abortCharImages 把这个角色的照片与背景图一起掐掉', () => {
    const photo = new AbortController()
    const backdrop = new AbortController()
    registerImageJob('ij-both', 'photo', photo)
    registerImageJob('ij-both', 'backdrop', backdrop)
    abortCharImages('ij-both')
    expect(photo.signal.aborted).toBe(true)
    expect(backdrop.signal.aborted).toBe(true)
  })

  it('abortCharImages 不碰别的角色', () => {
    const mine = new AbortController()
    const other = new AbortController()
    registerImageJob('ij-mine', 'photo', mine)
    registerImageJob('ij-other', 'photo', other)
    abortCharImages('ij-mine')
    expect(mine.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
  })

  it('没有在途请求时是空操作(不抛)', () => {
    expect(() => abortCharImages('ij-nobody')).not.toThrow()
    // 重复 abort 也安全:控制器 abort 是幂等的
    const c = new AbortController()
    registerImageJob('ij-twice', 'photo', c)
    abortCharImages('ij-twice')
    expect(() => abortCharImages('ij-twice')).not.toThrow()
  })

  /* 最关键的一条:同一格被新的一轮接管之后(重画),旧的那轮走完时调
     unregister —— 它只许摘自己。把新的那个一起摘掉,会让在途的请求
     失去被中断的可能 */
  it('重画接管后,旧一轮的 unregister 摘不掉新的那个', () => {
    const first = new AbortController()
    const second = new AbortController()
    registerImageJob('ij-takeover', 'photo', first)
    registerImageJob('ij-takeover', 'photo', second)
    unregisterImageJob('ij-takeover', 'photo', first)
    abortCharImages('ij-takeover')
    expect(first.signal.aborted).toBe(false)
    expect(second.signal.aborted).toBe(true)
  })

  it('unregister 只影响参数给的那一格', () => {
    const photo = new AbortController()
    const backdrop = new AbortController()
    registerImageJob('ij-slot', 'photo', photo)
    registerImageJob('ij-slot', 'backdrop', backdrop)
    unregisterImageJob('ij-slot', 'photo', photo)
    abortCharImages('ij-slot')
    // 照片那格已摘掉,background 那格不受影响
    expect(photo.signal.aborted).toBe(false)
    expect(backdrop.signal.aborted).toBe(true)
  })

  /* 两格都反登记之后表项就该消失(否则每清一次对话漏一个 Map 条目)。
     外部看不到 Map,但可以验:登记 → 反登记 → abort 一次不抛,
     且中途没有再把旧的 abort 出去(旧的那个此刻已无人认领) */
  it('全部反登记之后留下一个空表项安全出口', () => {
    const photo = new AbortController()
    registerImageJob('ij-clean', 'photo', photo)
    unregisterImageJob('ij-clean', 'photo', photo)
    expect(() => abortCharImages('ij-clean')).not.toThrow()
    expect(photo.signal.aborted).toBe(false)
  })
})
