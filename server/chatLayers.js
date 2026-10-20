/* ===== 分层产出纪律（说 / 想 / 做）====================================
   角色的回复本来只有"说出口的话"这一层。这个文件补上另外两层的**产出规矩**：
   没说出口的内心 `[think]…[/think]`、场景里的动作旁白 `[act]…[/act]`
   （见 doc/消息表达形态-心理层次设计.md，脊柱 A/B）。

   —— 三条纪律 ——

   1. **这里只管"怎么产出"，不管"怎么拆"**。区域标记原样留在正文里往外走
      （photo/mood 已经走 `emit_message_meta` 这条独立信道，正文里只剩
      `[think]` / `[act]` 两种区域标记；服务端对它们不做任何处理）。把一轮**扇出**
      成多条带 `layer` 的独立消息，是前端 `lib/messageLayers` 的 `parseLayers` 的活 ——
      服务端不碰拆分，两边职责不重叠（脊柱 A）。

   2. **它与上面那条"no narration"是有意的对冲**。`CHAT_RULES` 里那句挡的是
      `*叹气*`、`(皱眉)` 这类**给说话化妆**的伪动作；而这里的 `[act]` 是**被单独隔离出来的
      一条旁白**，不混在话里，也不是星号。所以这块必须排在 `CHAT_RULES` **之后**、
      明说那条例外的边界，否则模型会把两条规则读成互相矛盾。

   3. **act 只在场景模式放行，think 只在"确实憋着话"时才有**。两个都用稀缺去换亲密：
      每轮都有内心、每句都配旁白，会一路滑向三流同人文（设计 §7）。灯跟着状态走
      （`sceneMode` 这个入参），不跟着"这轮模型想不想打旁白"闪。

   纯函数、无 IO、无状态 —— 单独成文件就是为了测得了（与 chatTags.js /
   chatTime.js / chatMood.js / chatGuidance.js 同一种写法）。
   -------------------------------------------------------------------- */

/**
 * 摊成 system 里"分层产出"那一段。它由 `chat.js` 排在 `CHAT_RULES` **之后**注入，
 * 用来在"no narration"之外开一个**受控的例外**。
 *
 * `sceneMode` 为真才邀请 `[act]`；为假时明确禁止。think 两种模式下都可以有
 * （内心与是否在场景里无关），但一律要求稀缺、只在"说的 ≠ 想的"时才漏一句。
 *
 * 结尾那句只管**区域标记与消息边界的相处**：`[think]` / `[act]` 是正文里的东西，
 * 必须在消息结束之前收干净，不许让区域越到消息后面去。元数据已经改走
 * `emit_message_meta` 工具调用（见 chatTools.js），它发生在消息之外，
 * 不会被区域包住，也不会被前端从正文里剪 —— 两套机制不再抢同一段文本。
 *
 * mood/photo 怎么报不在这里重说一遍 —— 那归 `chatPhoto.js`、
 * `CHAT_META_RULE` 与工具 schema 各自 owns，这里再抄一份就是重复、还会漂移。
 * 也正因如此这里不点 `[photo:]` 的名：旧标签只留给历史消息做兼容渲染，
 * 新回复里不该再教它写。
 */
export function layerRules(sceneMode) {
  const lines = [
    'Inner life — what you say, what you keep to yourself, and what you do:',
    '- The "no narration" rule above is about not dressing up your speech with *sighs* or (frowns). There is now one deliberate exception: [think] and [act] are the only brackets you may use in the message itself.',
    '- Most of what you write is just speech. Leave speech bare - do not wrap it in anything.',
    '- You may reveal a thought the character does NOT say out loud: wrap that stretch in [think] and [/think]. First person, one short line, and only when there is something real being kept back - what they think differs from what they let slip, or a feeling strong enough to leak. When there is nothing like that, leave it out entirely; an inner life in every single message is noise, not intimacy. Never explain the marker, never mention it exists.',
  ]
  if (sceneMode) {
    lines.push(
      '- You are inside a scene right now, so you may also show one brief thing the character physically does: wrap it in [act] and [/act]. Third person, the way a stage direction reads (she tightens her scarf), no more than one short action, no speech inside it, and no asterisks - the marker already says it is an action, so adding stars would double it. Most messages in a scene still have no action; use it to mark a real beat (a look, a hand on the rail, turning away), not to narrate every line.'
    )
  } else {
    lines.push(
      '- You are NOT in a scene right now - this is ordinary conversation. Do not use [act] at all. Only [think] is available beyond plain speech.'
    )
  }
  lines.push(
    '- These regions belong in the body of your message: close every [think] and [act] before the message ends, and never let a region run past the end of your message. The metadata call happens after the message and is not part of it.'
  )
  return lines.join('\n')
}
