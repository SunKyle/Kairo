/* ===== 分享链接 / 歌曲的提示词 ========================================
   与 chatPhoto.js 同一分工：这里只写"什么时候该转、怎么转"，
   字段怎么归一化是 chatAttachments.js 的事。

   为什么链接这条要卡得比发图更死：画错一张图，用户看得出来是一张画；
   编出来一个网址，用户点下去之前看不出来它是假的。而模型**没有联网**，
   它知道的网址都可能过期或根本不存在 —— 所以一个链接唯一能允许的来源，
   是这段对话里已经出现过的那个地址（通常是用户自己贴的）。

   歌曲是另一回事：分享"我在放这首歌"靠的是曲名与歌手，不是那条网址。
   所以这里明确允许**不带链接**的一张分享卡，同时把上面那条"别编网址"
   原样套上去 —— 有地址就说，没有就只报曲名歌手，绝不硬凑一条 URL。

   不分享也完全正常。绝大多数轮次什么都不该带。
   -------------------------------------------------------------------- */

import { META_TOOL_NAME } from './chatTools.js'
import { normalizeAttachment } from './chatAttachments.js'

/* 最多交待几张最近的卡。窗口是 20 条消息，卡不会很多；设个上限是因为
   这个字段来自前端，而入口没有鉴权 —— 不设上限就是一句免费放大的提示词 */
const SHARED_CARDS_MAX = 8

export function shareRules() {
  return `Sharing something with a message:
- You can pass along exactly one thing by adding an "attachment" object to the same ${META_TOOL_NAME} call. Most messages have no attachment.
- kind "link" is a web page; kind "music" is a song you are putting on for them.
- A link has to point somewhere real. Only share a URL that already appears somewhere in this conversation, copied exactly as it was written. Never invent, complete, shorten, or guess a URL, and never make one up from a title or a site name. If the exact address is not in front of you, do not share a link. It must be a complete http:// or https:// address, never localhost or a private network address.
- A song needs no link to be shared: put the song title in "title" and the artist in "subtitle". Only add a "url" when its exact address is already in front of you — otherwise leave it out and just share the song.
- "title" is what the thing is, in a few words, the way you would name it to a friend. Do not put the URL in the title.
- Share at most one thing in a message, and only when the conversation actually calls for it. Do not turn every reply into a link or a playlist.
- Write the message as something you would say. Do not announce the card ("here is a link", "playing this for you"), and never describe the attachment object to the user. Never write a parenthetical like "(a song was shared — …)" or "(a link was shared — …)" yourself: a card exists only when it is sent through the tool, and you never narrate one as text.`
}

/**
 * 历史里发过的卡 → system 里的一段简报。
 *
 * 为什么放在 system 而不是助手消息正文里：回放历史时若把 `(a song was
 * shared — …)` 补进上一轮的正文，模型会把它当成自己写过的台词照抄，
 * 宁可写字也不去调工具（实测；见 server/chatNotes.js 开头）。这里改用
 * 一段**说人话**的清单，不写成括号模板 —— 越不像可复制的格式越好。
 *
 * shares 是前端带来的 `[{ role, attachment }]`，属于外部输入：
 * 逐条过 normalizeAttachment，不合法的那条直接丢；最多交待最近 8 张。
 */
export function sharedCardsBrief(shares) {
  if (!Array.isArray(shares) || !shares.length) return ''
  const lines = []
  for (const s of shares.slice(-SHARED_CARDS_MAX)) {
    const att = normalizeAttachment(s && typeof s === 'object' ? s.attachment : null)
    if (!att) continue
    const who = s.role === 'user' ? 'The user' : 'You'
    if (att.kind === 'music') {
      const artist = att.subtitle ? ` by ${att.subtitle}` : ''
      const link = att.url ? ` — ${att.url}` : ''
      lines.push(`- ${who} put on a song: "${att.title}"${artist}${link}`)
    } else {
      lines.push(`- ${who} shared a link: "${att.title}" — ${att.url}`)
    }
  }
  if (!lines.length) return ''
  return `Cards already sent in this conversation (they are on screen; do not send the same card again, and do not describe them as text):\n${lines.join('\n')}`
}
