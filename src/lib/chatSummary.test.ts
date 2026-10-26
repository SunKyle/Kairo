import { describe, expect, it } from 'vitest'
import { hasBriefingText, mergeChatSummaries } from './chatSummary'
import type { ChatSummary } from '../types'

/* 两份来源会同时改同一份简报:对话页按角色懒加载、记忆中心一次读全量、
   另一个标签页也会写。合并只能按 updatedAt 取新的 ——
   拿盘上那份无脑覆盖,用户刚在记忆中心改的字就会被下一次读消息顶掉。 */

function rec(charId: string, updatedAt: number, text = `${charId}@${updatedAt}`): ChatSummary {
  return {
    charId,
    text,
    upToId: `id-${updatedAt}`,
    upToAt: updatedAt * 10,
    covered: updatedAt,
    updatedAt
  }
}

describe('mergeChatSummaries · 按更新时间取新的', () => {
  it('当前为空时,盘上的都收进来', () => {
    const rows = [rec('a', 1), rec('b', 2)]
    expect(mergeChatSummaries({}, rows)).toEqual({ a: rows[0], b: rows[1] })
  })

  it('盘上更旧:不顶掉内存里更新的那份', () => {
    const mine = rec('a', 20)
    const merged = mergeChatSummaries({ a: mine }, [rec('a', 10)])
    expect(merged.a).toBe(mine)
  })

  it('盘上更新:采纳盘上那份(冷启动后刚压完一轮就是这条路)', () => {
    const onDisk = rec('a', 30)
    const merged = mergeChatSummaries({ a: rec('a', 20) }, [onDisk])
    expect(merged.a).toBe(onDisk)
  })

  it('同一时刻的两份:保留已经在内存里的(不无谓地换引用)', () => {
    const mine = rec('a', 20, 'mine')
    const merged = mergeChatSummaries({ a: mine }, [rec('a', 20, 'disk')])
    expect(merged.a).toBe(mine)
  })

  it('新增、更新与保留可以混在同一批里', () => {
    const oldB = rec('b', 5)
    const newA = rec('a', 30)
    const merged = mergeChatSummaries({ a: rec('a', 10), b: oldB }, [newA, rec('b', 4), rec('c', 7)])
    expect(merged.a).toBe(newA)
    expect(merged.b).toBe(oldB)
    expect(merged.c).toEqual(rec('c', 7))
  })

  it('不改动传进来的对象', () => {
    const current = { a: rec('a', 10) }
    const before = { ...current }
    mergeChatSummaries(current, [rec('a', 20), rec('b', 3)])
    expect(current).toEqual(before)
  })
})

describe('hasBriefingText · "有没有简报"只看正文', () => {
  it('正常文字 → true', () => {
    expect(hasBriefingText(rec('a', 1, 'we talked about the rain'))).toBe(true)
  })

  it('空串、纯空白、缺省、null → false(忘掉过的那条就是空串)', () => {
    expect(hasBriefingText(rec('a', 1, ''))).toBe(false)
    expect(hasBriefingText(rec('a', 1, '   \n  '))).toBe(false)
    expect(hasBriefingText(undefined)).toBe(false)
    expect(hasBriefingText(null)).toBe(false)
  })

  it('有游标但正文为空 → false(忘掉之后记录还在,但不该再显示)', () => {
    const forgotten = { ...rec('a', 50, ''), upToId: 'last', upToAt: 999, covered: 40 }
    expect(hasBriefingText(forgotten)).toBe(false)
  })
})
