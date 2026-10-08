/* 从提示词派生一个短标题。图砖角标与提示词库卡片都要用同一个口径,
   所以抽到这里 —— 各写一份迟早改歪一边。

   刻意不新增字段存它:提示词本来就在记录里,派生得出来的东西不必再落一份盘,
   已有的历史与库也立刻就有标题,不用迁移。 */

/* 短标题结尾要摘掉的虚词。放模块级是为了不每次调用都重建正则 */
const TAIL_STOP =
  /\s+(of|in|on|at|with|and|or|for|to|from|by|the|a|an|as|into|over|under|that|is|are)$/i

export function titleFromPrompt(prompt: string): string {
  const s = (prompt || '').replace(/\s+/g, ' ').trim()
  if (!s) return 'Untitled'
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
  /* 拉丁文按词切,顺便去掉开头的冠词:
     "A cinematic portrait of a girl" 里的 A 只是语法,做了标题就是噪声 */
  if (!/[\u3400-\u9fff]/.test(s)) {
    const cut = s
      .replace(/^(a|an|the)\s+/i, '')
      .split(' ')
      .slice(0, 4)
      .join(' ')
    /* 切在虚词上收不住尾:"cinematic portrait of a" 读起来像被截断,
       所以把结尾的 of / in / the 这类非实词摘掉,直到落在一个实词上 */
    let out = cut
    while (TAIL_STOP.test(out)) out = out.replace(TAIL_STOP, '')
    // 整句都是虚词的极端情况:别返回空串,退回没修过的结果
    return cap(out || cut)
  }
  // 中日韩没有空格,按词切会把整句糊上来,所以按字截
  return s.slice(0, 12)
}
