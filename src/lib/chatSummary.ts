import type { ChatSummary } from '../types'

/* ===== 对话简报在内存里的两份来源 =====================================
 *
 *  简报平时按角色懒加载(打开谁的对话才读谁的那一份),而记忆中心要一次
 *  列出所有人的简报 —— 直接进那一页时,没打开过的角色手里一份都没有。
 *  补读全量之后不能粗暴替换内存那份:本页可能刚编辑过某一份(updatedAt
 *  更新),也可能有一条写入还在路上。**同一条只留 updatedAt 更新的那份**。
 *
 *  空正文 = 忘掉过 / 还没压过。界面上"有没有简报可看"只认这一条判据,
 *  记忆中心的分组与空态都从它来 —— 不要在模板里再写一遍 trim 判断。
 * -------------------------------------------------------------------- */

/** 把盘上读到的简报并进内存那份:同一条只留 updatedAt 更新的。 */
export function mergeChatSummaries(
  current: Readonly<Record<string, ChatSummary>>,
  rows: readonly ChatSummary[]
): Record<string, ChatSummary> {
  const next = { ...current }
  for (const rec of rows) {
    const cur = next[rec.charId]
    if (!cur || rec.updatedAt > cur.updatedAt) next[rec.charId] = rec
  }
  return next
}

/** 这条记录里有没有能显示的简报正文(空串 = 忘掉过 / 还没压过) */
export function hasBriefingText(rec: ChatSummary | undefined | null): boolean {
  return !!rec?.text.trim()
}
