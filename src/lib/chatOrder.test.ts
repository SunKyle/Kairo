import { describe, expect, it } from 'vitest'
import { lastMessageLookup, orderConversations } from './chatOrder'
import type { Character, ChatMessage } from '../types'

/* 左栏的顺序与"进对话页替用户挑哪一个"是同一件事。这两处一旦不一致,
   用户看到的就是"刷新之后打开的对话不是第一行" —— 所以下面每一条都冲着一个
   可能被写反的判据去,而不是按函数分组 */

function char(id: string, createdAt: number, pinned = false): Character {
  return { id, name: id, createdAt, ...(pinned ? { pinned: true } : {}) }
}

function line(charId: string, createdAt: number): ChatMessage {
  return { id: `${charId}:${createdAt}`, charId, role: 'user', content: 'hi', createdAt }
}

/** 从"角色 + 各自最后一句"造一个取法 */
function lookupFrom(last: Record<string, ChatMessage>) {
  return (id: string): ChatMessage | undefined => last[id]
}

const ids = (list: Character[]) => list.map((c) => c.id)

describe('orderConversations · 左栏顺序', () => {
  it('最近聊的在前 —— 与"最近建的在前"是两回事', () => {
    // b 建得最晚却没人聊过;a 建得最早,刚刚聊过
    const chars = [char('b', 300), char('a', 100)]
    const last = { a: line('a', 900) }
    expect(ids(orderConversations(chars, lookupFrom(last)))).toEqual(['a', 'b'])
  })

  it('置顶压过一切:它连"最近聊过"都排在后面', () => {
    const chars = [char('a', 100), char('b', 200, true), char('c', 300)]
    const last = { a: line('a', 900), b: line('b', 800) }
    expect(ids(orderConversations(chars, lookupFrom(last)))).toEqual(['b', 'a', 'c'])
  })

  it('都没聊过时按创建时间,最近建的在前', () => {
    const chars = [char('a', 100), char('b', 300), char('c', 200)]
    expect(ids(orderConversations(chars, lookupFrom({})))).toEqual(['b', 'c', 'a'])
  })

  it('同一时刻的两条消息不靠运气定序:再比创建时间', () => {
    const chars = [char('a', 100), char('b', 200)]
    const last = { a: line('a', 500), b: line('b', 500) }
    expect(ids(orderConversations(chars, lookupFrom(last)))).toEqual(['b', 'a'])
  })

  it('排的是副本 —— 传进来的那份顺序还给别人用', () => {
    const chars = [char('a', 100), char('b', 200)]
    orderConversations(chars, lookupFrom({}))
    expect(ids(chars)).toEqual(['a', 'b'])
  })

  it('空列表不炸', () => {
    expect(orderConversations([], lookupFrom({}))).toEqual([])
  })
})

describe('lastMessageLookup · 最后一句的取法', () => {
  it('内存里那份优先:刚说完的那句比库里读出来的新', () => {
    const inMemory = { a: [line('a', 100), line('a', 200)] }
    const fromDb = { a: line('a', 50) }
    const lastOf = lastMessageLookup(() => inMemory, () => fromDb)
    expect(lastOf('a')?.createdAt).toBe(200)
  })

  it('内存里没有这个角色时用库里那份 —— 懒加载的角色也读得到', () => {
    const lastOf = lastMessageLookup(() => ({}), () => ({ a: line('a', 50) }))
    expect(lastOf('a')?.createdAt).toBe(50)
  })

  it('内存里是个空数组也算没读到,退回库里那份', () => {
    const lastOf = lastMessageLookup(() => ({ a: [] }), () => ({ a: line('a', 50) }))
    expect(lastOf('a')?.createdAt).toBe(50)
  })

  it('两处都没有就是没有', () => {
    const lastOf = lastMessageLookup(() => ({}), () => ({}))
    expect(lastOf('a')).toBeUndefined()
  })

  it('来源是函数:两个来源被整份换掉之后取到的是新的那份', () => {
    let inMemory: Record<string, ChatMessage[]> = {}
    let fromDb: Record<string, ChatMessage> = { a: line('a', 50) }
    const lastOf = lastMessageLookup(() => inMemory, () => fromDb)
    expect(lastOf('a')?.createdAt).toBe(50)
    // 说了一句:内存那份换成了新对象
    inMemory = { a: [line('a', 900)] }
    expect(lastOf('a')?.createdAt).toBe(900)
    // 另一个标签页清空了对话:库里那份也换了
    fromDb = {}
    inMemory = {}
    expect(lastOf('a')).toBeUndefined()
  })
})
