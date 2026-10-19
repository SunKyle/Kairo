import { beforeEach, describe, expect, it } from 'vitest'
import { clearAllDrafts, clearDraft, getDraft, saveDraft } from './chatDraft'

/* 这一层守的是"草稿跟着角色走,不跟着输入框走"几条不变量,
   与 chatSplit / moodDisplay 的测法同一套路:直接摆数据断结果。 */

beforeEach(() => {
  // 模块级 Map 是活状态,组与组之间必须归零,不然上一条用例漏的键会污染下一条
  clearAllDrafts()
})

describe('saveDraft / getDraft · 存取', () => {
  it('存进去能取回来,原样(空格、换行都不动)', () => {
    saveDraft('a', '今天想跟你说\n  两句 ')
    expect(getDraft('a')).toBe('今天想跟你说\n  两句 ')
  })

  it('没存过的角色 → 空串(输入框据此显示空的)', () => {
    expect(getDraft('nobody')).toBe('')
  })

  it('各角色各存各的,互不串门', () => {
    saveDraft('a', '给 A 的半句')
    saveDraft('b', '给 B 的半句')
    expect(getDraft('a')).toBe('给 A 的半句')
    expect(getDraft('b')).toBe('给 B 的半句')
  })

  it('后写的覆盖先写的(同一角色只留最新那份)', () => {
    saveDraft('a', '第一稿')
    saveDraft('a', '第二稿')
    expect(getDraft('a')).toBe('第二稿')
  })
})

describe('saveDraft · 空即删键', () => {
  it('空串与纯空白都算没有 —— 且把旧草稿顺手撤掉', () => {
    saveDraft('a', '写了一半')
    saveDraft('a', '')
    expect(getDraft('a')).toBe('')
    saveDraft('a', '又写了一半')
    saveDraft('a', '   \n  ')
    expect(getDraft('a')).toBe('')
  })

  it('空 id 拒收 —— 还没挑中角色时没有"这一格"可写', () => {
    saveDraft('', '不该出现在任何地方')
    expect(getDraft('')).toBe('')
    // 也不该污染别的格子
    expect(getDraft('a')).toBe('')
  })
})

describe('clearDraft / clearAllDrafts · 回收', () => {
  it('clearDraft 只撤指定那一格,别人的还在', () => {
    saveDraft('a', '给 A')
    saveDraft('b', '给 B')
    clearDraft('a')
    expect(getDraft('a')).toBe('')
    expect(getDraft('b')).toBe('给 B')
  })

  it('clearAllDrafts 一次收干净(角色被删光时用)', () => {
    saveDraft('a', '给 A')
    saveDraft('b', '给 B')
    clearAllDrafts()
    expect(getDraft('a')).toBe('')
    expect(getDraft('b')).toBe('')
  })

  it('撤不存在的格子不报错(幂等)', () => {
    expect(() => clearDraft('ghost')).not.toThrow()
  })
})
