/* ===== 相处偏好那一段(PRD §3.2-D) ====================================
   客户端把用户表过态的几项摊成了几行 "- …" 指令(见 src/lib/prefs.ts 的
   interactionGuidance),这里只负责加标签、限长、插进 system。

   —— 三条纪律 ——

   1. **逐行白名单,不是整段截断**。它是外部输入,而换行在这个位置是有结构的
      —— 整段原样塞回 system,等于给了一份可以伪造提示词结构的入口。
      所以只接受以 "- " 开头的行,行数与每行长度各自封顶;

   2. **"它不覆盖你是谁"那句必须留在服务端**。那是 PRD §3.2-D 与反目标里
      "所有角色最后都变成同一种顺从的聊天机器人"的那条边界 ——
      不能指望每个调用点都记得带上;

   3. **一项都没表态就整段不出现**,不留 `How they like to be treated:` 的空壳
      (与 chatTime.js 第 4 条、chatMood.js 第 3 条同一手法)。

   纯函数、无 IO、无状态 —— 单独成文件就是为了测得了(与 chatTags.js /
   chatTime.js / chatMood.js 同一种写法)。
   -------------------------------------------------------------------- */

/** 行数上限。用户能表的是四项强度 + 一项安慰方式,八行已经宽了一倍 */
export const CHAT_GUIDANCE_MAX_LINES = 8
/** 单行上限。客户端那边一行最多几十个字符,200 是给手搓请求留的余地 */
export const CHAT_GUIDANCE_LINE_CHARS = 200

/**
 * 摊成 system 里的那一段。认不出 / 空 → 空串(调用方据此整段不插)。
 *
 * 标签里那句"它不覆盖你是谁"是**故意的**:相处偏好改的是**方式**,
 * 不是**人格**。少了它,模型会把这几行当成对角色本身的改写,
 * 于是每个角色都朝同一个方向收敛 —— 那正是这一整条需求要防的事。
 */
export function guidanceSection(raw) {
  if (typeof raw !== 'string' || !raw) return ''
  const lines = raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('- '))
    .slice(0, CHAT_GUIDANCE_MAX_LINES)
    .map((s) => s.slice(0, CHAT_GUIDANCE_LINE_CHARS))
  if (!lines.length) return ''
  return (
    'How they would like to be treated — this shapes your manner only. ' +
    'It never overrides who you are: your personality, your boundaries and your own judgement still come first.\n' +
    lines.join('\n')
  )
}
