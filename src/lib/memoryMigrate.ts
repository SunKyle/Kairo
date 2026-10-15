import { uid } from '../api'
import { getAllChatSummaries, getAllMemories, putMemories } from './idb'
import { MEMORY_TEXT_MAX, normalizeMemoryText } from './memory'
import type { ChatSummary, MemoryItem } from '../types'

/* ===== 存量简报 → 记忆条目(一次性迁移) ==============================
   升级前,"它记得什么"只有一样东西:每个角色一段压缩简报(chat_summaries)。
   记忆中心(PRD §5.5)是后加的,它读的是另一张表(memories)。于是老用户
   第一次打开记忆中心会看到**空的** —— 而他们已经聊了几周。
   "它说它什么都不记得"是这个新页面上最糟的第一印象,所以要把存量搬过去。

   —— 为什么是"搬"而不是"从此读简报" ——

   简报是**这一整段对话的压缩纪要**(带压缩游标、会被反复重写),记忆条目是
   **一条离散的事实**(各自独立地改/删/标记)。两者不是同一种东西,也不该合并
   (见 types.ts 的 MemoryItem 那段)。所以这里做的是**快照**:把简报此刻的
   正文抄成一条"角色专属"记忆,简报本身原封不动地继续工作。

   代价是那一段文字会在两处出现(简报仍随对话注入,这条记忆也进 system)。
   这是有意的取舍:两者在提示词里是两个不同的框("这段对话的来龙去脉" /
   "关于他们的一条事实"),重复的量有上限(每条 240 字),而收益是记忆中心
   对老用户不是空的。真要消掉重复,得先把简报的角色重新定义 —— 那是另一件事。

   —— 为什么记来源为 'ai' ——

   这段正文是模型写的,不是用户的原话。标成 'user' 就等于**把 AI 的转述
   包装成"他明确说过的话"**,而那正是 PRD 反目标里点名的那一条。
   收口原则见 lib/idb 的 memoryFromRow:宁可把一句他说过的话标成"推断",
   也不能把一句推断标成"他说的"。

   —— 为什么用一次性标记,而不是"看库里有没有" ——

   后者会在用户把迁移来的那几条**删光之后**,下次启动又原样搬回来:
   删掉的东西自己长回来,比压根不迁移更糟。所以用一个只写一次的地标。
   -------------------------------------------------------------------- */

/** 一次性地标。**只写一次、永不回退** —— 它答的是"这台设备搬过了没" */
export const MIGRATED_KEY = 'kimage.memoryMigrated'

/** 迁移出来的那条记忆的背景说明。界面在详情里显示它 ——
 *  用户看到"它猜的"三个字时会问"它凭什么猜",这一行就是答案 */
const MIGRATED_NOTE = 'Kept from the earlier part of your conversation.'

/**
 * 把一条简报摊成一条记忆。没什么可搬的(正文是空的)返回 null。
 *
 * 正文截到 MEMORY_TEXT_MAX:记忆是"一句",不是"一段"。简报可能比这长,
 * 截断会切掉尾巴 —— 可接受,因为这一条本来就是"它大致记得什么"的快照,
 * 而不是简报的完整副本(那份还在,而且还会继续更新)。
 */
export function summaryToMemory(s: ChatSummary, now: number): MemoryItem | null {
  const text = (s.text || '').trim().slice(0, MEMORY_TEXT_MAX).trim()
  if (!text) return null
  return {
    id: uid(),
    charId: s.charId,
    /* 角色专属:这段纪要是"与这个角色的谈话"里长出来的,不是关于用户的稳定画像 */
    category: 'character',
    text,
    origin: 'ai',
    important: false,
    note: MIGRATED_NOTE,
    /* createdAt 是**这一条记忆**诞生的时刻(就是现在),
       updatedAt 是**它记的那些事**截止到什么时候 —— 简报最后被写的那一刻。
       两者不同是有意的:界面上显示的是 updatedAt("3d ago"),
       而它该显示的是"这段话是什么时候的",不是"这条记录是什么时候建的" */
    createdAt: now,
    updatedAt: typeof s.updatedAt === 'number' && s.updatedAt > 0 ? s.updatedAt : now
  }
}

/**
 * 一批简报该变成哪些记忆。**已经在库里的同文跳过** ——
 *  这既是"用户自己补过同样一句"的去重,也是标记写不进去时(隐私模式 /
 *  localStorage 被禁)的兜底:那种情况下每次启动都会重跑一遍,而这一层
 *  保证它不会每次多攒一份。
 */
export function summariesToMemories(
  summaries: readonly ChatSummary[],
  existing: readonly MemoryItem[],
  now: number
): MemoryItem[] {
  const seen = new Set(existing.map((m) => normalizeMemoryText(m.text)))
  const out: MemoryItem[] = []
  for (const s of summaries) {
    const m = summaryToMemory(s, now)
    if (!m) continue
    const key = normalizeMemoryText(m.text)
    /* 同一次里也要去重:两个角色压出来的正文偶尔会撞在一起 */
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

/** 迁移要碰的四样外部东西。抽成参数是为了让上面那两条纯逻辑能被单测直接跑 */
export interface MigrateDeps {
  summaries: () => Promise<ChatSummary[]>
  /** 库里现有的全部记忆。只用来去重 */
  existing: () => Promise<MemoryItem[]>
  save: (items: readonly MemoryItem[]) => Promise<void>
  /** 读那个一次性地标 */
  flag: () => string | null
  /** 写下那个一次性地标 */
  mark: () => void
  now?: () => number
}

/**
 * 搬一次。返回这次真搬了几条(0 = 已经搬过 / 没东西可搬)。
 *
 * 顺序上有一处是刻意的:**落盘成功之后才写地标**。反过来(先写地标再搬)
 * 会在搬的过程中崩溃时留下一个"搬过了"的谎 —— 那几段简报从此再也搬不进来,
 * 而且不会有任何提示。宁可让它在标记写不进去时多跑几次(去重兜着),
 * 也不要一次失败变成永久丢失。
 */
export async function migrateSummaries(deps: MigrateDeps): Promise<number> {
  if (deps.flag()) return 0
  let items: MemoryItem[]
  try {
    items = summariesToMemories(await deps.summaries(), await deps.existing(), (deps.now || Date.now)())
  } catch (e) {
    /* 读不出来(库没打开 / 盘坏了)就什么都不做,也不写地标 —— 下次再试 */
    console.error('[Kairo] memory migration: could not read', e)
    return 0
  }
  if (items.length) {
    try {
      await deps.save(items)
    } catch (e) {
      console.error('[Kairo] memory migration: could not save', e)
      return 0
    }
  }
  /* 搬 0 条也写地标:那说明"这台设备上没有存量简报",而这件事不会自己变 */
  deps.mark()
  return items.length
}

/** 真正接上库与 localStorage 的那一层。主界面启动时调一次 */
export async function migrateSummariesOnce(): Promise<number> {
  return migrateSummaries({
    summaries: getAllChatSummaries,
    existing: getAllMemories,
    save: (items) => putMemories(items),
    flag: () => {
      try {
        return localStorage.getItem(MIGRATED_KEY)
      } catch {
        /* 读不到就当没搬过。去重那一层保证重复跑不会攒出多份 */
        return null
      }
    },
    mark: () => {
      try {
        localStorage.setItem(MIGRATED_KEY, '1')
      } catch {
        /* 写不进去(隐私模式 / 配额满)就下次再搬一遍,靠去重收口 */
      }
    }
  })
}
