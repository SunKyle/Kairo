/* ===== 记忆条目那一段(PRD §3.2-E / F) ================================
   与 `What you remember:` 那段**压缩简报**是两样东西,所以是两段、两个标签:

   - 简报(chat.js 里那个 memory 字段)是**一段成篇的叙述** —— 这段关系的来龙去脉;
   - 这里这一份是**一条条独立的事实**(记忆条目),由用户手写或 AI 抽取,
     各自可编辑、可删除、可标记(见 src/types.ts 的 MemoryItem)。

   客户端交过来的是一个字符串数组,每条已经摊成了 "- …"
   (见 src/lib/memory.ts 的 memoryLines)。

   —— 三条纪律 ——

   1. **逐行白名单,不是整段截断**。与 chatGuidance.js 同一条理由:换行在这个
      位置有结构(一条一行),而内容来自客户端。整段原样塞回 system 等于给了
      一份可以伪造提示词结构的入口,所以只接受以 "- " 开头的行,行数、行长各自封顶;

   2. **"(inferred) 不等于他说过"这句必须留在服务端**。PRD 的反目标里点名了
      "角色把 AI 推断包装成用户明确说过的事实",而这句话就是那条边界的执行者。
      标记本身由前端按 origin 写(见 memoryLines),这里负责解释它 ——
      不能指望每个调用点都记得带上这句解释;

   3. **一条都没有就整段不出现**,不留 `Facts you remember:` 的空壳
      (与 chatTime.js 第 4 条、chatMood.js 第 3 条同一手法)。

   纯函数、无 IO、无状态 —— 单独成文件就是为了测得了(与 chatTags.js /
   chatTime.js / chatMood.js 同一种写法)。
   -------------------------------------------------------------------- */

/** 行数上限。抽取那边一次最多 8 条(见 src/lib/memory.ts 的 MEMORY_EXTRACT_MAX),
 *  12 是"攒了几轮之后"的量级 —— 再往上加只是每一轮多烧几百 token,
 *  而那些内容多半与当下无关 */
export const CHAT_MEMORY_MAX_LINES = 12
/** 单行上限。客户端那边一条记忆最多 240 个字符(见 MEMORY_TEXT_MAX),
 *  200 是给手搓请求留的余地 */
export const CHAT_MEMORY_LINE_CHARS = 200

/**
 * 摊成 system 里的那一段。认不出 / 空 → 空串(调用方据此整段不插)。
 *
 * 那段开场白有三个任务,缺一不可:
 * - **"from earlier conversations — not from this scene"**:挡的是模型把一条
 *   记忆当成**当下正在发生**的事("你上次说…"读成"你刚说…");
 * - **"(inferred) … never state it as a fact they gave you"**:挡的是
 *   PRD 反目标里那条"把 AI 推断包装成用户明确说过的话";
 * - **"keep that to yourself … never say who told you"**:PRD §3.2-F 的最后一条
 *   ——"即使某条信息被授权共享,也应避免以不自然或令人不适的方式暴露信息来源"。
 *   共享画像是**用户授权给所有角色**的(见 lib/memory 的 selectMemories),
 *   于是 B 会知道一条本是从 A 那边来的事;这句话要求它别把"我从哪听来的"
 *   说出来 —— 那正是"令人不适"的来源(用户会觉得角色之间在背后议论自己)。
 *   对角色专属记忆这一句是空转,但整段共用一个开场白,不必为此分岔。
 */
export function memorySection(raw) {
  if (!Array.isArray(raw)) return ''
  const lines = raw
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => s.startsWith('- '))
    .slice(0, CHAT_MEMORY_MAX_LINES)
    .map((s) => s.slice(0, CHAT_MEMORY_LINE_CHARS))
  if (!lines.length) return ''
  return (
    'Facts you remember about them, from earlier conversations — not from this scene:\n' +
    lines.join('\n') +
    '\nA line marked (inferred) is something you worked out, not something they told you: ' +
    'never state it as a fact they gave you. ' +
    'If one of these reached you through another conversation, keep that to yourself — ' +
    'never say who told you or how you came to know it.'
  )
}
