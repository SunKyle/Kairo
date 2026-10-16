/* ===== 关系那一段(PRD §3.2-C)=======================================
   客户端把当前三轴的分值摊成了几行 "- …" 指令(见 src/lib/relationship.ts 的
   relationshipLines),这里只负责加标签、限长、插进 system。

   与 chatGuidance.js(相处偏好)是同一类东西、同一套纪律 —— 因为关系和偏好
   都是**关于这段关系的软指令**,不是"这个角色是谁":

   1. **逐行白名单,不是整段截断**。它是外部输入(经前端存了一圈再发回来),
      而换行在这个位置是有结构的。只接受以 "- " 开头的行,行数与每行长度各自封顶;

   2. **"这只改温度、不改你是谁、也不许表演没攒来的亲"那句必须留在服务端**。
      那是 PRD §3.2-C「核心人格稳定」与反目标里那条的关系版:少了它,模型会把
      "你们很熟"当成对角色本身的改写,于是关系越高越像一个"跟谁都亲"的通用暖男 ——
      不能指望每个调用点都记得带上;

   3. **一行都没有就整段不出现**,不留 `How close you two are:` 的空壳
      (与 chatGuidance.js 第 3 条、chatTime.js 第 4 条同一手法)。

   纯函数、无 IO、无状态 —— 单独成文件就是为了测得了(与 chatGuidance.js /
   chatMemory.js 同一种写法)。
   -------------------------------------------------------------------- */

/** 行数上限。三轴最多各一行(见 relationshipLines),6 行已经宽了一倍 */
export const CHAT_RELATIONSHIP_MAX_LINES = 6
/** 单行上限。客户端那边一行最多几十字符,200 是给手搓请求留的余地 */
export const CHAT_RELATIONSHIP_LINE_CHARS = 200

/**
 * 摊成 system 里的那一段。认不出 / 空 → 空串(调用方据此整段不插)。
 *
 * 标签里那句"这只改温度、不改你是谁、也不表演没攒来的亲"是**故意的**:
 * 关系改的是**你们此刻的相处温度**,不是**人格**。少了它,模型会照着
 * "你们很熟"把角色本身的性格也往"亲"的方向改,而 PRD 要的是同一个人、
 * 只是越来越像你认识的那个人的**分寸**。
 */
export function relationshipSection(raw) {
  if (typeof raw !== 'string' || !raw) return ''
  const lines = raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('- '))
    .slice(0, CHAT_RELATIONSHIP_MAX_LINES)
    .map((s) => s.slice(0, CHAT_RELATIONSHIP_LINE_CHARS))
  if (!lines.length) return ''
  return (
    'How close you two have become — this shapes warmth and familiarity only. ' +
    'It never changes who you are, and you do not perform closeness you have not earned.\n' +
    lines.join('\n')
  )
}
