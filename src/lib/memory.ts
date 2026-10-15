import type { MemoryCategory, MemoryItem, MemoryOrigin } from '../types'

/* ===== 记忆的纯逻辑 ==================================================
   这一层不碰 IndexedDB、不碰界面 —— 它只回答三个问题:
   ① 一条记忆该归谁、该给谁看(selectMemories);
   ② 怎么排、怎么摊成提示词(memoryLines);
   ③ 模型吐回来的那几行怎么读(parseExtractedMemories)。

   抽出来的理由与 idb.ts 的 planPrune 完全一样:**第 ① 条决定"谁看得到什么"**,
   而那正是 PRD §3.2-F「角色专属记忆不得未经授权跨角色共享」那条隐私边界。
   它必须能被构造数据直接断言,而不是靠"开两个角色聊两句看看"来验。
   -------------------------------------------------------------------- */

/** 记忆中心的分类导航(顺序即界面顺序) */
export interface MemoryCategoryMeta {
  key: MemoryCategory
  label: string
  hint: string
}
export const MEMORY_CATEGORIES: readonly MemoryCategoryMeta[] = [
  {
    key: 'profile',
    label: 'About you',
    hint: 'Stable things about you — interests, habits, long-term goals. Share one and every character may know it.'
  },
  {
    key: 'character',
    label: 'Together',
    hint: 'Private to one character: what you two talked about, did, or agreed on.'
  },
  {
    key: 'event',
    label: 'Events & plans',
    hint: 'Things with a long tail — changes, ongoing worries, plans worth following up on.'
  }
]

/** 这一条是不是"关于用户"的共享画像。共享画像不属于任何一段关系 */
export function isProfileMemory(m: MemoryItem): boolean {
  return m.category === 'profile'
}

/**
 * 这个分类的记忆**必须挂在某个角色上**吗。只有共享画像可以不挂 ——
 * 它属于用户,不属于任何一段关系(见 MemoryItem.charId)。
 *
 * 这条规则有两处要用:记忆中心那张手写表单(选了"关于你"就收起"跟谁"那一格)
 * 与写入那一侧(addMemory 收口)。所以摆在纯逻辑这一层 ——
 * 两处各写一份 `category !== 'profile'`,迟早会有一处改了另一处没改。
 */
export function categoryNeedsChar(category: MemoryCategory): boolean {
  return category !== 'profile'
}

/** 归到某个角色名下的记忆。**共享画像不算在内** ——
 *  它属于用户,不归任何角色;要按角色看它,走 selectMemories */
export function memoriesOf(all: readonly MemoryItem[], charId: string): MemoryItem[] {
  return all.filter((m) => !isProfileMemory(m) && m.charId === charId)
}

/**
 * **该喂给这个角色的记忆**。这一条就是 PRD §3.2-F 的实现:
 *
 * - 角色专属 / 事件与计划:必须属于这个角色(charId 相等)。默认私有,
 *   别的角色一条都读不到;
 * - 共享画像:charId 为 null(它不属于任何角色)**且** shared 为 true。
 *   没勾共享的画像一条都不注入 —— "跨角色共享需要用户明确授权";
 * - 角色专属记忆即便被写成 shared: true 也不生效:`shared` 只对画像有意义。
 *   这一句是**故意的冗余防御**:字段是共享的,判断就必须在这里收死,
 *   不能指望写数据的人永远记得只给画像勾它。
 */
export function selectMemories(all: readonly MemoryItem[], charId: string): MemoryItem[] {
  return all.filter((m) =>
    isProfileMemory(m) ? m.charId === null && m.shared === true : m.charId === charId
  )
}

/**
 * 这一条记忆**谁会知道、以及会被用在哪儿** —— 记忆详情里那一行说明。
 *
 * 它同时答 PRD 的两处要求:§3.2-E「记忆详情应……说明记忆的用途」,
 * 以及 §3.2-F「用户可以查看……共享授权」。
 *
 * 摆在纯逻辑这一层(而不是 MemoryPage 的模板里)有两个理由:
 * ① 它是隐私边界的**界面侧表述**,而那条边界在这一层(selectMemories)——
 *    两处必须同一口径。分开写的话,界面可以承诺一件数据层不会做的事
 *    (比如对一条永远私有的记忆说"每个角色都能知道");
 * ② 它会出现在记忆中心与设置页两处(见 MemoryPrivacyPanel),各写一份迟早走偏。
 *
 * ownerName 由调用方解析好再传进来:这一层不认识角色目录。
 * 传空串是有意义的一种输入 —— 归属角色已被删掉,那时不能渲染出
 * "Only  knows this." 这种半截句子。
 */
export function memoryAudience(m: MemoryItem, ownerName: string): string {
  if (isProfileMemory(m)) {
    /* 没勾共享的画像**谁都看不到**(见 selectMemories),所以这里不能只说
       "只有你知道",还得说清"怎么才能让它用上" —— 否则用户会以为
       共享是自动的,只是还没轮到 */
    return m.shared
      ? 'Every character can bring this up when it fits.'
      : 'Not shared yet — no character knows this. Share it and they can use it.'
  }
  const who = ownerName
    ? `Only ${ownerName} knows this`
    : 'Only the character it belongs to knows this'
  return m.category === 'event'
    ? `${who}, and it will follow up on it when it fits.`
    : `${who} — it comes up when you two talk.`
}

/** 排序:重要的在前,其余按最近更新。两个分区内部都按更新时间倒序 */
export function sortMemories(list: readonly MemoryItem[]): MemoryItem[] {
  return [...list].sort((a, b) => {
    if (a.important !== b.important) return a.important ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

/** 记忆正文的比对口径:大小写、空白、句末标点都不算差别。
 *  去重与"这条是不是已经记过了"都按它判。
 *
 *  顺序是有讲究的:**先收空白再剪标点**。反过来的话,句末那个空格会让
 *  `$` 锚定的标点剪不掉("…shifts!! " 末尾是空格不是叹号),
 *  同一句话带着一个尾随空格就绕过了去重 */
export function normalizeMemoryText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。,，!！?？;；:：]+$/g, '')
    .trim()
}

/**
 * 摊成提示词里的那几行。
 *
 * **推断出来的必须带标记** —— PRD 把"角色将 AI 推测当成用户明确说过的事实"
 * 列进了反目标,而模型在提示词里看到自己"记得"的东西时,默认就会当成事实。
 * 标一句 `(inferred)` 是最低成本的解药:它让那一行在模型眼里是"我猜的",
 * 而不是"他说的"。
 */
export function memoryLines(items: readonly MemoryItem[]): string[] {
  return items.map((m) => `- ${m.origin === 'ai' ? '(inferred) ' : ''}${m.text}`)
}

/* ===== 从模型输出里读回记忆条目 ======================================
   输出格式是固定前缀的行(与 charSpec 那几档同一条路):
     CATEGORY|ORIGIN|TEXT
   CATEGORY ∈ profile | character | event,ORIGIN ∈ user | ai。
   不用 JSON:少一整类"围栏 / 多余解释 / 半截引号"的解析坑,
   而且坏一行只丢一行,不会整批报废 —— 记忆抽取本来就是尽力而为。
   -------------------------------------------------------------------- */

const EXTRACT_CATEGORIES: readonly MemoryCategory[] = ['profile', 'character', 'event']
const EXTRACT_ORIGINS: readonly MemoryOrigin[] = ['user', 'ai']
/** 单条记忆正文的上限。记忆是"一句话",不是一段纪要 */
export const MEMORY_TEXT_MAX = 240
/** 一次抽取最多收多少条。模型偶尔会一口气列十几条琐事 */
export const MEMORY_EXTRACT_MAX = 8

export interface ExtractedMemory {
  category: MemoryCategory
  origin: MemoryOrigin
  text: string
}

/** 读模型那一批 `CATEGORY|ORIGIN|TEXT` 行。认不出的行直接跳过(不抛) */
export function parseExtractedMemories(raw: unknown): ExtractedMemory[] {
  if (typeof raw !== 'string' || !raw) return []
  const out: ExtractedMemory[] = []
  for (const line of raw.split('\n')) {
    const parts = line.split('|')
    if (parts.length < 3) continue
    const category = parts[0].trim().toLowerCase()
    const origin = parts[1].trim().toLowerCase()
    /* 正文自己可能含 '|',所以只按前两个分隔符切 */
    const text = parts.slice(2).join('|').trim().slice(0, MEMORY_TEXT_MAX)
    if (!text) continue
    if (!EXTRACT_CATEGORIES.includes(category as MemoryCategory)) continue
    if (!EXTRACT_ORIGINS.includes(origin as MemoryOrigin)) continue
    out.push({ category: category as MemoryCategory, origin: origin as MemoryOrigin, text })
    if (out.length >= MEMORY_EXTRACT_MAX) break
  }
  return out
}

/** 抽出来的这批里,哪些是新的(库里还没有同一句话) */
export function freshExtracted(
  incoming: readonly ExtractedMemory[],
  existing: readonly MemoryItem[],
  charId: string
): ExtractedMemory[] {
  const seen = new Set(
    existing
      /* 比对的对手要包含共享画像:否则同一句"他上夜班"会被每个角色各记一遍 */
      .filter((m) => isProfileMemory(m) || m.charId === charId)
      .map((m) => normalizeMemoryText(m.text))
  )
  const out: ExtractedMemory[] = []
  for (const e of incoming) {
    const key = normalizeMemoryText(e.text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}
