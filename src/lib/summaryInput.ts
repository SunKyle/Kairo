/* ===== 后台整理那两条路的输入预算 =====================================
 *
 *  摘要把滑出窗口的消息压成一段纪要,抽记忆从一段对话里挑出几条事实 ——
 *  两者都把消息拼成一个大字符串交给模型。不加预算的话,最坏的输入是
 *  "300 条 × 单条 8000 字符"(摘要)或"40 条 × 8000"(抽取),前者能到
 *  两百多万字符 —— 上游会按上下文超限拒掉,而那条失败是静默的:
 *  用户只会看到记忆从此不再更新。
 *
 *  预算只在**拼输入**这一侧生效,不碰存下来的消息。截到哪一条,调用方就
 *  把游标/covered 停在哪一条:没发出去的那段不能被当成"已经压过"。
 *
 *  方向为什么由调用方选:
 *  - 摘要要按时间顺序往前追,超预算时保留**最早**的那些 —— 游标才能一格
 *    一格安全推进,不会跳过中间一段;
 *  - 抽取看的是"最近这段关系里有什么值得记",超预算时保留**最新**的那些。
 *
 *  纯函数、无 IO —— 单测直接钉住这两个方向与"至少放一条"。
 * -------------------------------------------------------------------- */

/** 每条消息除正文外的固定开销(说话人前缀 + 换行),按字符粗算就够 */
const LINE_OVERHEAD = 16

/**
 * 从一段消息里取出能放进预算的那些。
 *
 * `from = 'oldest'` 从旧往新收(摘要),`'newest'` 从新往旧收再正回来(抽取)。
 * **至少放一条** —— 否则一条超长的消息会让游标永远停在原地,后台整理卡死。
 * 放进去的那一条哪怕超预算,也只是一次请求大一点,好过永远压不动。
 */
export function fitInputBudget<T extends { content: string }>(
  messages: readonly T[],
  budget: number,
  from: 'oldest' | 'newest' = 'oldest'
): T[] {
  if (!messages.length || budget <= 0) return []
  const costOf = (m: T): number => String(m?.content ?? '').length + LINE_OVERHEAD

  const out: T[] = []
  let used = 0
  if (from === 'oldest') {
    for (const m of messages) {
      const cost = costOf(m)
      if (out.length && used + cost > budget) break
      out.push(m)
      used += cost
    }
    return out
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const cost = costOf(m)
    if (out.length && used + cost > budget) break
    out.push(m)
    used += cost
  }
  return out.reverse()
}
