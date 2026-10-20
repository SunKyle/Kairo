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
/** 长期记忆简报那一段的字符上限(整段一条,不是逐行)。与 chat.js 里消息、
 *  记忆简报共用的那道 8000 同量级 —— 一份压好的摘要远够不到,这个数只是
 *  防公开入口被超长输入放大。memoryBrief 的默认值,调用点会显式传 CHAT_MAX_CHARS */
export const CHAT_MEMORY_BRIEF_MAX_CHARS = 8000

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

/* ===== 长期记忆简报那一段(成篇叙述)================================
   与上面 memorySection 的"一条条事实"是两样东西:简报是**一段连贯的叙述**
   (这段关系的来龙去脉,由 ENHANCE_PROMPTS.summary 生成、经前端存一圈再发回来),
   收不成行,所以它走的是"折叠空白 + 单条上限"而非逐行白名单。

   两条纪律(与逐行那段的理由一脉相承):

   1. **折叠换行**:它是模型生成、又经前端转了一圈的文本,原样带着换行塞回
      system 等于让上一轮的输出有机会伪造提示词结构。折成一行就把这个口子关掉;

   2. **截断要留痕**:上限是防御性的(正常一份压好的摘要远够不到,只有病态或
      手搓的超长输入才会撞上)。原来直接 slice 会**无声**腰斩 —— 模型以为看到了
      全部记忆,而末尾那一段(常是最新的待办、未兑现的承诺)被悄悄丢掉。
      撞上限时在末尾补一句标记,让它知道"这只是记忆的一部分",别把残缺当完整。
      判断按**折叠后**的长度:折叠只会变短,按原始长度判会让一堆纯空白蒙混过关。

   纯函数、无 IO、无状态 —— 与 memorySection 同一条路,单测直接引(见 chatMemory.d.ts)。
   -------------------------------------------------------------------- */

/** 截断标记。写成一句给模型读的话,而不是一个省略号 ——
 *  省略号会被当成"话没说完",而这里要说清"是记忆被截了,不是它在斟酌" */
const BRIEF_TRUNCATED_MARK =
  ' …(your memory runs longer than this — what comes after the cut is not shown here)'

/**
 * 摊成 system 里"你记得的这些事"那段简报正文(不含标题行)。
 * 空 / 坏输入 → 空串(调用方据此整段不出现);超上限 → 截断 + 留痕。
 */
export function memoryBrief(raw, max = CHAT_MEMORY_BRIEF_MAX_CHARS) {
  const one = (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim()
  if (!one) return ''
  return one.length > max ? one.slice(0, max) + BRIEF_TRUNCATED_MARK : one
}

/* ===== "你记得的这些事"那一段的框架(标题 + 一句会出错的交代)========
   memoryBrief 只管把摘要**正文**折好、封顶、留痕;这一段负责给它套上标题、
   再补一句"它是靠不住的"。补这一句是补 doc §4 点名的缺口(摘要无 fallible 声明):
   摘要是**模型压出来的二手回忆**,会漏、会串、偶尔还会记错,而它读起来却像一段
   盖了章的历史 —— 不点破这一层,模型就会把"上次好像说要陪他去看展"当成一条板上钉钉
   的当下事实去执行(哪怕那其实是压丢了上下文的旧话)。

   刻意**不**在这里重说两件事,免得和别处复读:
   - "本轮对话 > 记忆"这个**权威顺序**归 chatPriority.js 的 priorityRules(它统一裁决
     各层谁说了算);这里只交代"这段文字本身的性质",不排座次。
   - "（inferred）不等于用户说过"归上面 memorySection 的开场白;那是记忆条目那一摊,
     与这段成篇简报是两样东西。

   标题必须**以 "What you remember" 起头** —— scripts/probe-chat-photo.mjs 拿这个子串
   当"时间/心情排在记忆之前"的定位锚,别改这前七个词。 */

/** 摊成 system 里"你记得的这些事"那一段。入参是 memoryBrief 折好的正文(不再折一次)。
 *  空 / 坏输入 → 空串(调用方据此整段不出现,与 memorySection / memoryBrief 同一手法)。 */
export function memoryBriefSection(brief) {
  const one = typeof brief === 'string' ? brief.trim() : ''
  if (!one) return ''
  return (
    'What you remember, as best you can recall it:\n' +
    one +
    '\nThis is a compressed recollection, not a transcript - it can be incomplete or partly wrong. Lean on it, do not quote it back as their exact words.'
  )
}
