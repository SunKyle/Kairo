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

export function shareRules() {
  return `Sharing something with a message:
- You can pass along exactly one thing by adding an "attachment" object to the same ${META_TOOL_NAME} call. Most messages have no attachment.
- kind "link" is a web page; kind "music" is a song you are putting on for them.
- A link has to point somewhere real. Only share a URL that already appears somewhere in this conversation, copied exactly as it was written. Never invent, complete, shorten, or guess a URL, and never make one up from a title or a site name. If the exact address is not in front of you, do not share a link. It must be a complete http:// or https:// address, never localhost or a private network address.
- A song needs no link to be shared: put the song title in "title" and the artist in "subtitle". Only add a "url" when its exact address is already in front of you — otherwise leave it out and just share the song.
- "title" is what the thing is, in a few words, the way you would name it to a friend. Do not put the URL in the title.
- Share at most one thing in a message, and only when the conversation actually calls for it. Do not turn every reply into a link or a playlist.
- Write the message as something you would say. Do not announce the card ("here is a link", "playing this for you"), and never describe the attachment object to the user.`
}
