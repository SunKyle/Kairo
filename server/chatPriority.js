/* ===== 信息优先级那一段（冲突时谁说了算）============================
   chatSystemPrompt 把角色、时间、心情、记忆、关系、偏好一段段拼在一起 —— 但那只是
   **修辞顺序**（先铺你是谁、再讲此刻、再讲你记得什么、最后收规则），**不是权威顺序**。
   评审点过这条：光靠拼的顺序，模型并不知道两块内容打架时该听谁的。这个文件把隐含的
   权威关系**写成一段明账**（依据 doc/System Prompt最终结构与信息来源.md §3 的四层）：

     1. 硬规则 + 安全边界            —— 地板，谁都盖不掉；
     2. 本轮的事实（时间 / 此刻心情 /
        用户刚说的）                 —— 比"记得的过去"大；
     3. 记忆 / 摘要 / 关系            —— 是过去与趋势，不是当下事实；
     4. 人格 / 口吻 / 相处偏好        —— 改"怎么说话、怎么相处"，不改"发生了什么、你是谁"。

   —— 三条纪律 ——

   1. **它是"读法"层，排在所有被读的段之前**。由 `chat.js` 紧跟 `CHAT_OPENING` 注入、
      排在 Who you are / How you behave 之前 —— 模型带着这把尺子往下读每一段。措辞
      **刻意不写 above / below**（规则其实排在它之后），一律按"角色"指代，避免位置错乱；

   2. **不重述别处已经owns 的微规则**。`（inferred）不等于用户说过` 归 memorySection，
      这里只把记忆条目放进层级、绝不再抄那句解释；`摘要不是当下事实` 在层级里只点一句，
      展开（压缩 / 会失真）交给摘要自己那段的 rememberSection —— 一处说透一处，别复读；

   3. **纯函数、无 IO、无状态** —— 与 chatPhoto.js / chatLayers.js / chatMemory.js 同一
      种写法，单独成文件就是为了测得了（chatSystemPrompt 是模块私有的，测不到）。
   -------------------------------------------------------------------- */

/**
 * 摊成 system 里"信息优先级"那一段。定长文本、无入参、无门控 —— 每轮都注入，
 * 由调用方（chat.js）排在 CHAT_OPENING 之后。
 */
export function priorityRules() {
  return [
    'How to weigh it, if the parts disagree:',
    '- The rules set the floor: nothing below can talk you out of them.',
    '- Live input beats memory. What is true right now - the time, how you feel this minute, anything they have just said - carries more weight than what you remember, and when the two disagree, follow the live side.',
    '- The summary, the memories, how close you two have become: all of it is past and trend, not present fact. Let it set tone and continuity, not the events of this turn.',
    '- Who you are, how you talk, how they like to be treated: these shape the voice and the manner, never the facts, and never your core - wanting to be gentler with someone does not make you a different person.'
  ].join('\n')
}
