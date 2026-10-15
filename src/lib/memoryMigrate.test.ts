import { describe, expect, it, vi } from 'vitest'
import { MIGRATED_KEY, migrateSummaries, migrateSummariesOnce, summariesToMemories, summaryToMemory } from './memoryMigrate'
import { MEMORY_TEXT_MAX } from './memory'
import type { ChatSummary, MemoryItem } from '../types'

/* 这一份只关心一件事:**搬过去的那些东西,搬对了吗、只搬一次吗**。
   它跑在"升级那一刻"这条路径上 —— 出错的代价是用户几周的相处被搬丢,
   或者反过来,删掉的东西自己长回来。 */

function summary(p: Partial<ChatSummary> & { charId: string; text: string }): ChatSummary {
  return {
    upToId: 'm1',
    upToAt: 1000,
    covered: 20,
    updatedAt: 5000,
    ...p
  }
}

function mem(p: Partial<MemoryItem> & { text: string }): MemoryItem {
  return {
    id: 'x',
    charId: 'a',
    category: 'character',
    origin: 'user',
    important: false,
    createdAt: 1,
    updatedAt: 1,
    ...p
  }
}

/** 一个最小的迁移环境。默认全是"空库、没搬过" */
function harness(over: Partial<Parameters<typeof migrateSummaries>[0]> = {}) {
  const saved: MemoryItem[][] = []
  let flag: string | null = null
  let marked = 0
  const deps = {
    summaries: async () => [summary({ charId: 'a', text: 'They work night shifts.' })],
    existing: async () => [],
    save: async (items: readonly MemoryItem[]) => void saved.push([...items]),
    flag: () => flag,
    mark: () => {
      marked++
      flag = '1'
    },
    now: () => 7777,
    ...over
  }
  return { deps, saved, marked: () => marked, setFlag: (v: string | null) => (flag = v) }
}

describe('summaryToMemory · 一条简报搬成一条记忆', () => {
  it('搬成角色专属、来源标 ai、并留下出处说明', () => {
    const m = summaryToMemory(summary({ charId: 'a', text: 'They work night shifts.' }), 7777)
    expect(m).toBeTruthy()
    expect(m!.charId).toBe('a')
    expect(m!.category).toBe('character')
    /* 这段正文是模型写的,不是用户的原话 —— 标 'user' 就是把 AI 的转述
       包装成"他明确说过的话"(PRD 反目标里点名的那一条) */
    expect(m!.origin).toBe('ai')
    expect(m!.important).toBe(false)
    expect(m!.note).toBeTruthy()
    expect(m!.text).toBe('They work night shifts.')
  })

  it('没正文的简报搬不出东西', () => {
    expect(summaryToMemory(summary({ charId: 'a', text: '' }), 1)).toBeNull()
    expect(summaryToMemory(summary({ charId: 'a', text: '   \n  ' }), 1)).toBeNull()
  })

  it('正文截到一句的长度 —— 记忆是"一句",不是"一段"', () => {
    const long = 'x'.repeat(MEMORY_TEXT_MAX + 200)
    const m = summaryToMemory(summary({ charId: 'a', text: long }), 1)
    expect(m!.text.length).toBe(MEMORY_TEXT_MAX)
  })

  it('时间分开两处:记录建于此刻,内容截止到简报最后被写的那一刻', () => {
    const m = summaryToMemory(summary({ charId: 'a', text: 'hi', updatedAt: 5000 }), 7777)
    expect(m!.createdAt).toBe(7777)
    /* 界面上显示的是 updatedAt。它该显示"这段话是什么时候的",
       而不是"这条记录是什么时候建的" —— 后者会让一条旧事看起来像刚发生的 */
    expect(m!.updatedAt).toBe(5000)
  })

  it('简报的时间戳坏掉时退回此刻,不留下一个 NaN 的时间', () => {
    const m = summaryToMemory(
      summary({ charId: 'a', text: 'hi', updatedAt: Number.NaN as unknown as number }),
      7777
    )
    expect(m!.updatedAt).toBe(7777)
  })
})

describe('summariesToMemories · 去重', () => {
  it('库里已有同文的跳过 —— 用户自己补过同样一句时不该多出一条', () => {
    const out = summariesToMemories(
      [summary({ charId: 'a', text: 'They work night shifts.' })],
      [mem({ text: 'they work night shifts' })],
      1
    )
    expect(out).toHaveLength(0)
  })

  it('同一批里撞车的也只留一条', () => {
    const out = summariesToMemories(
      [
        summary({ charId: 'a', text: 'They work night shifts.' }),
        summary({ charId: 'b', text: 'They work night shifts!' })
      ],
      [],
      1
    )
    expect(out).toHaveLength(1)
  })

  it('空简报不占位,也不影响别的条目', () => {
    const out = summariesToMemories(
      [summary({ charId: 'a', text: '' }), summary({ charId: 'b', text: 'Keeps a cat.' })],
      [],
      1
    )
    expect(out.map((m) => m.text)).toEqual(['Keeps a cat.'])
  })
})

describe('migrateSummaries · 只搬一次', () => {
  it('第一次搬完就写地标,第二次一条都不再搬', async () => {
    const h = harness()
    expect(await migrateSummaries(h.deps)).toBe(1)
    expect(h.saved).toHaveLength(1)
    expect(h.marked()).toBe(1)
    expect(await migrateSummaries(h.deps)).toBe(0)
    expect(h.saved).toHaveLength(1)
  })

  it('搬 0 条也写地标 —— "这台设备上没有存量简报"这件事不会自己变', async () => {
    const h = harness({ summaries: async () => [] })
    expect(await migrateSummaries(h.deps)).toBe(0)
    expect(h.marked()).toBe(1)
  })

  it('用户删光之后不会自己长回来', async () => {
    const h = harness()
    await migrateSummaries(h.deps)
    /* 简报还在库里(简报本来就不受删除记忆影响),但地标已经写下 ——
       这正是要的:删掉的东西不该在下次启动时复活 */
    expect(await migrateSummaries(h.deps)).toBe(0)
    expect(h.saved).toHaveLength(1)
  })

  it('落盘失败就不写地标,下次启动还能再试一遍', async () => {
    const h = harness({
      save: async () => {
        throw new Error('quota')
      }
    })
    expect(await migrateSummaries(h.deps)).toBe(0)
    expect(h.marked()).toBe(0)
  })

  it('读不出来时什么都不做,也不写地标', async () => {
    const h = harness({
      summaries: async () => {
        throw new Error('db closed')
      }
    })
    expect(await migrateSummaries(h.deps)).toBe(0)
    expect(h.marked()).toBe(0)
  })

  it('已经搬过时连库都不碰', async () => {
    const summaries = vi.fn(async () => [])
    const h = harness({ summaries, flag: () => '1' })
    expect(await migrateSummaries(h.deps)).toBe(0)
    expect(summaries).not.toHaveBeenCalled()
  })
})

describe('migrateSummariesOnce · 接上 localStorage 的那一层', () => {
  it('地标写在 MIGRATED_KEY 上,且搬过之后不再重复', async () => {
    const map = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k: string, v: string) => void map.set(k, v)
    })
    try {
      /* 走真实依赖:库是空的(测试环境没有 IndexedDB),于是"没东西可搬",
         但它仍然该把地标写下 —— 这条验的是地标真的落在那个键上 */
      await migrateSummariesOnce()
      expect(map.get(MIGRATED_KEY)).toBe('1')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('localStorage 被禁时不抛 —— 它在启动路径上', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    })
    try {
      await expect(migrateSummariesOnce()).resolves.toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
