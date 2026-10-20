import { describe, expect, it } from 'vitest'
import {
  MEMORY_EXTRACT_MAX,
  categoryNeedsChar,
  freshExtracted,
  memoriesOf,
  memoryAudience,
  memoryLines,
  normalizeMemoryText,
  parseExtractedMemories,
  selectMemories,
  sortMemories
} from './memory'
import type { MemoryItem } from '../types'

/* 这一份测的是记忆的**边界**,不是它的样子:
   ① 谁看得到什么(PRD §3.2-F 的隐私边界);
   ② 推断的必须标出来(PRD 反目标"把 AI 推测当成用户说过的事实");
   ③ 模型吐回来的东西再脏也不许抛。

   最要紧的是 ① —— 它错了不会报错、不会有异常,只会让某个角色
   知道它不该知道的事。所以每一条隔离规则都得有正面断言。 */

function mem(p: Partial<MemoryItem> & { text: string }): MemoryItem {
  return {
    id: p.id ?? p.text,
    charId: p.charId === undefined ? 'a' : p.charId,
    category: p.category ?? 'character',
    text: p.text,
    origin: p.origin ?? 'user',
    important: p.important ?? false,
    ...(p.shared !== undefined ? { shared: p.shared } : {}),
    createdAt: p.createdAt ?? 1,
    updatedAt: p.updatedAt ?? 1
  }
}

describe('categoryNeedsChar · 哪一类可以不挂角色', () => {
  /* 只有共享画像可以不挂。这条规则界面(手写表单收不收"跟谁"那一格)
     与写入侧(addMemory 的收口)都要用 —— 所以它得是同一个函数,
     而不是两处各写一句 `category !== 'profile'` */
  it('画像不用挂角色,另外两类必须挂', () => {
    expect(categoryNeedsChar('profile')).toBe(false)
    expect(categoryNeedsChar('character')).toBe(true)
    expect(categoryNeedsChar('event')).toBe(true)
  })
})

describe('selectMemories · 谁看得到什么(隐私边界)', () => {
  const aPrivate = mem({ text: 'A 的私事', charId: 'a' })
  const bPrivate = mem({ text: 'B 的私事', charId: 'b' })
  const sharedProfile = mem({ text: '他上夜班', charId: null, category: 'profile', shared: true })
  const unsharedProfile = mem({ text: '他怕黑', charId: null, category: 'profile', shared: false })
  const plainProfile = mem({ text: '他养猫', charId: null, category: 'profile' })
  const aEvent = mem({ text: 'A 那边下周面试', charId: 'a', category: 'event' })
  const all = [aPrivate, bPrivate, sharedProfile, unsharedProfile, plainProfile, aEvent]

  it('角色专属记忆只给本人 —— 别的角色一条都读不到', () => {
    const forA = selectMemories(all, 'a').map((m) => m.text)
    expect(forA).toContain('A 的私事')
    expect(forA).not.toContain('B 的私事')
  })

  it('共享画像只在勾了共享时注入;没勾的、以及缺 shared 的都不给', () => {
    const forA = selectMemories(all, 'a').map((m) => m.text)
    expect(forA).toContain('他上夜班')
    expect(forA).not.toContain('他怕黑')
    expect(forA).not.toContain('他养猫')
  })

  it('事件与计划跟角色专属同一条规矩:只给本人', () => {
    expect(selectMemories(all, 'a').map((m) => m.text)).toContain('A 那边下周面试')
    expect(selectMemories(all, 'b').map((m) => m.text)).not.toContain('A 那边下周面试')
  })

  /* 冗余防御:shared 是共享字段,判断必须在读取这一侧收死 ——
     不能指望写数据的人永远记得"只给画像勾它" */
  it('角色专属记忆即便被写成 shared:true 也不会跨角色', () => {
    const leak = mem({ text: '本该私有', charId: 'a', category: 'character', shared: true })
    expect(selectMemories([leak], 'b')).toHaveLength(0)
  })

  it('共享画像若被写成挂在某个角色名下,一样不注入(它不是谁的)', () => {
    const odd = mem({ text: '挂错人的画像', charId: 'a', category: 'profile', shared: true })
    expect(selectMemories([odd], 'a')).toHaveLength(0)
  })

  it('memoriesOf 只数这个角色自己的,不含共享画像', () => {
    expect(memoriesOf(all, 'a').map((m) => m.text).sort()).toEqual(['A 的私事', 'A 那边下周面试'].sort())
  })
})

describe('memoryAudience · 谁知道它、它会被用在哪儿', () => {
  /* 这一行是"隐私边界"的界面侧表述,所以它必须与 selectMemories 同口径:
     对一条**永远私有**的角色专属记忆,绝不能说出"别的角色也能知道"这种话。
     同时它还要回答 PRD §3.2-E 的"说明记忆的用途" —— 只说"谁看得到"
     不够,用户还想知道"它什么时候会冒出来"。 */
  it('共享画像:勾了才说"每个角色都能用",没勾要说清"怎么才能用上"', () => {
    const on = memoryAudience(mem({ text: 'x', charId: null, category: 'profile', shared: true }), '')
    expect(on).toContain('Every character')
    const off = memoryAudience(mem({ text: 'x', charId: null, category: 'profile' }), '')
    expect(off).toContain('Not shared')
    /* 没勾的那一条不能出现"每个角色"这种承诺 —— 它谁都看不到 */
    expect(off).not.toContain('Every character')
  })

  it('角色专属:只提这个角色,并说清它什么时候会冒出来', () => {
    expect(memoryAudience(mem({ text: 'x', charId: 'a' }), 'Alice')).toBe(
      'Only Alice knows this — it comes up when you two talk.'
    )
  })

  it('事件与计划:同一个归属,但用途是"之后会跟进"', () => {
    expect(memoryAudience(mem({ text: 'x', charId: 'a', category: 'event' }), 'Alice')).toBe(
      'Only Alice knows this, and it will follow up on it when it fits.'
    )
  })

  /* 归属角色被删掉之后,ownerName 会是空串。那时不能渲染出
     "Only  knows this." 这种半截句子 —— 它比不显示更糟 */
  it('归属角色不在目录里时给一个完整说法,不留半截句子', () => {
    const out = memoryAudience(mem({ text: 'x', charId: 'gone' }), '')
    expect(out).toContain('Only the character it belongs to knows this')
    expect(out).not.toContain('Only  knows')
  })

  it('角色专属永远不说"每个角色都能知道" —— 即便被写成 shared:true', () => {
    const leak = mem({ text: 'x', charId: 'a', category: 'character', shared: true })
    expect(memoryAudience(leak, 'Alice')).not.toContain('Every character')
  })
})

describe('sortMemories · 重要的在前', () => {
  it('先按重要分组,组内按最近更新', () => {
    const list = [
      mem({ text: '旧', updatedAt: 10 }),
      mem({ text: '重要但旧', important: true, updatedAt: 5 }),
      mem({ text: '新', updatedAt: 30 }),
      mem({ text: '重要且新', important: true, updatedAt: 40 })
    ]
    expect(sortMemories(list).map((m) => m.text)).toEqual(['重要且新', '重要但旧', '新', '旧'])
  })

  it('不改动传入的数组', () => {
    const list = [mem({ text: 'x', updatedAt: 1 }), mem({ text: 'y', updatedAt: 2 })]
    sortMemories(list)
    expect(list.map((m) => m.text)).toEqual(['x', 'y'])
  })

  /* 这条锁的是**注入路径上的组合不变量**,不是 sortMemories 本身:
     服务端按收到的顺序只留前 12 行(chatMemory.js 的 slice(0,12)),而 selectMemories
     回的是入库序 —— 于是一条后来才被标为重要的旧事实会落在末尾,被一堆新琐事挤到
     第 13 名之后,模型永远看不到。useChatFlow 在 memoryLines 之前先过一层 sortMemories
     就是为了这个。这里把"排序 + 截断"当一条链验:不排直接截它被挤出去(=原 bug),
     排完再截它一定在 survivors 里。 */
  it('注入前排序,才能让重要的旧条目挤进服务端那 12 行', () => {
    const kept = (list: MemoryItem[]) => memoryLines(list).slice(0, 12)
    /* 15 条较新的闲聊,后面才追加一条"最近被标为重要"的旧事实(updatedAt 很小) */
    const manyNewer = Array.from({ length: 15 }, (_, i) => mem({ text: `新闲聊 ${i}`, updatedAt: 500 + i }))
    const lateImportant = mem({ text: '妈妈生日在下周', important: true, updatedAt: 2 })
    const store = [...manyNewer, lateImportant] // 入库序:重要那条落在尾巴

    /* 不排序直接截 —— 重要那条在第 16 位,被 slice(0,12) 砍掉 */
    expect(kept(store).some((l) => l.includes('妈妈生日在下周'))).toBe(false)
    /* 排序后截 —— important 顶到最前,稳在 survivors 里 */
    expect(kept(sortMemories(store))[0]).toContain('妈妈生日在下周')
  })
})

describe('memoryLines · 推断的必须标出来', () => {
  it('AI 推断带 (inferred),用户说的不带', () => {
    const lines = memoryLines([
      mem({ text: '他说他搬去杭州了', origin: 'user' }),
      mem({ text: '他大概不喜欢早起', origin: 'ai' })
    ])
    expect(lines[0]).toBe('- 他说他搬去杭州了')
    expect(lines[1]).toBe('- (inferred) 他大概不喜欢早起')
  })
})

describe('parseExtractedMemories · 模型吐回来的那几行', () => {
  it('读得回三类、两种来源', () => {
    const out = parseExtractedMemories(
      ['profile|user|他上夜班', 'character|ai|它觉得他最近很累', 'event|user|他下个月要搬家'].join('\n')
    )
    expect(out).toEqual([
      { category: 'profile', origin: 'user', text: '他上夜班' },
      { category: 'character', origin: 'ai', text: '它觉得他最近很累' },
      { category: 'event', origin: 'user', text: '他下个月要搬家' }
    ])
  })

  it('正文里含 | 不会把句子切断', () => {
    expect(parseExtractedMemories('profile|user|他喜欢 A|B 这种写法')[0].text).toBe('他喜欢 A|B 这种写法')
  })

  it('认不出的分类 / 来源、缺字段、空正文一律跳过,不抛', () => {
    const out = parseExtractedMemories(
      [
        'nonsense|user|这条分类不对',
        'profile|maybe|来源不对',
        'profile|user|',
        'profile|user',
        '   ',
        'profile|user|这条是对的'
      ].join('\n')
    )
    expect(out).toEqual([{ category: 'profile', origin: 'user', text: '这条是对的' }])
  })

  it('模型啰嗦地多写了几条时,只收上限内的', () => {
    const many = Array.from({ length: 20 }, (_, i) => `event|user|第 ${i} 条`).join('\n')
    expect(parseExtractedMemories(many)).toHaveLength(MEMORY_EXTRACT_MAX)
  })

  it('不是字符串(上游给坏了)时给空数组', () => {
    expect(parseExtractedMemories(undefined)).toEqual([])
    expect(parseExtractedMemories(null)).toEqual([])
    expect(parseExtractedMemories({ text: 'x' })).toEqual([])
  })

  it('大小写与空白宽容 —— 模型偶尔写 Profile|User', () => {
    expect(parseExtractedMemories('  Profile | User | 他上夜班  ')[0]).toEqual({
      category: 'profile',
      origin: 'user',
      text: '他上夜班'
    })
  })
})

describe('freshExtracted · 别把同一件事记两遍', () => {
  it('库里已有同一句话(忽略大小写/句末标点)就不再收', () => {
    const existing = [mem({ text: 'He works night shifts.', charId: 'a' })]
    const out = freshExtracted(
      [{ category: 'character', origin: 'user', text: 'he works night shifts' }],
      existing,
      'a'
    )
    expect(out).toEqual([])
  })

  it('别的角色记过的不算重复(那是两段关系里各自的记忆)', () => {
    const existing = [mem({ text: '他养猫', charId: 'b' })]
    const out = freshExtracted([{ category: 'character', origin: 'user', text: '他养猫' }], existing, 'a')
    expect(out).toHaveLength(1)
  })

  it('共享画像记过的不再重复记(否则每个角色各记一遍)', () => {
    const existing = [mem({ text: '他养猫', charId: null, category: 'profile', shared: true })]
    const out = freshExtracted([{ category: 'profile', origin: 'user', text: '他养猫' }], existing, 'a')
    expect(out).toEqual([])
  })

  it('同一批里自己重复的也只留一条', () => {
    const out = freshExtracted(
      [
        { category: 'event', origin: 'user', text: '他下月搬家' },
        { category: 'event', origin: 'user', text: '他下月搬家。' }
      ],
      [],
      'a'
    )
    expect(out).toHaveLength(1)
  })
})

describe('normalizeMemoryText', () => {
  it('大小写、空白、句末标点都不算差别', () => {
    expect(normalizeMemoryText('  He  Works Night Shifts!! ')).toBe(normalizeMemoryText('he works night shifts'))
  })
})
