/* ===== 发图这一段（tool calling 版）==================================
   发图意图以前是正文末尾的一枚 `[photo:…]` 标签。现在它是
   `emit_message_meta` 工具调用里的一个可选 `photo` 对象 ——
   正文里不再写任何标签，画图的依据走 `tool_calls` 这条独立信道。

   这个文件只教"什么时候发、scene 写什么、shot/frame 怎么填"。
   工具的形状在 chatTools.js，收尾的"每轮调一次"在 chat.js 的
   CHAT_META_RULE；三处各管一段，不互相抄。

   canDraw 为假时**整段不注入**，工具 schema 里也没有 photo 字段 ——
   配不出图的角色，提示词里就不提图这件事，既不烧 token，也不引着模型
   报一个画不出来的画面。

   frequency 是设置页 Photos 里那一档倾向（2026-10-21 补）：
   rare / normal / often 只换第一段那句口吻，下面四段一个字不动 ——
   shot / frame / scene 的写法与频率无关，不该跟着变。normal 逐字保留原句，
   所以默认行为没有变化。客户端仍然**不做**"N 轮最多一张"的硬拦截
   （2026-10-03 的决定仍然有效，见 doc/角色出图.md §4.1.2）。

   纯函数、无 IO、无状态 —— 单独成文件就是为了测得了。
   -------------------------------------------------------------------- */

/* 三档频率只换这一句开场。normal 是原文 —— 默认值必须让老行为一字不差，
   否则"没动设置"的用户也会跟着变（而这一档本来就该是"现在这样"） */
const FREQUENCY_OPENERS = {
  rare:
    'Pictures should be rare here. Most conversations should have none at all; send one only when the picture is the point of the message: they asked to see you, or something is happening right now that you would actually take a photo of.',
  normal:
    'Most of your messages have no picture in them, and that is normal. Send one only when the picture is the point of the message: they asked to see you, or something is happening right now that you would actually take a photo of.',
  often:
    'You may send pictures a little more freely here: when something in the scene is worth showing, show it rather than only describing it. A picture still has to be the point of the message - they asked to see you, or something is happening right now that you would actually take a photo of.'
}

/**
 * 摊成 system 里"怎么发一张图"那一段。仅在 canDraw 时由调用方注入。
 * frequency 认不出来时按 normal —— 入口是公开的，手搓请求不该把这段弄坏。
 */
export function photoRules(frequency = 'normal') {
  const opener =
    frequency === 'rare' || frequency === 'often'
      ? FREQUENCY_OPENERS[frequency]
      : FREQUENCY_OPENERS.normal
  return [
    'Sending a picture:',
    `- ${opener} When you do, include a "photo" object in the same emit_message_meta call. Do not write any tag, JSON, or other metadata into the message text.`,
    '- "scene" is the only thing the picture is drawn from, and whoever draws it cannot see this conversation. Put in what only you know: what time it is and what the light is doing, the weather, what is around you, and what you are doing right now. "me on the balcony" is not enough; "me leaning on the balcony rail at dusk, the rain just stopped, streetlights coming on below, hair still wet" is. Write it as plain description, never as an instruction to a machine. Up to 400 characters.',
    '- "shot" says who is holding the phone, and it only matters when you are in the picture: "selfie" when it is your own phone in your own hand - arm\'s length, or a mirror; "third" when somebody else is holding their phone and took the picture of you. Leave "shot" out when you are not in the picture. If you are in the picture and are not sure which one it is, use "selfie". A close-up of a thing is not a selfie - a mug, a book, a window, a room: when nothing of your own body is in that frame, leave "shot" out. But any part of your own body in the frame is still you - your hands, your nails, your shoulder, your hair, your neck, your legs, your feet - so those keep the shot like any other picture of you.',
    '- "frame" is optional, and only needed when the distance is unusual. The usual distance - your face and shoulders, or an ordinary view of the place - needs no word at all. When the picture is about one thing rather than the whole of you or the whole place, write "close": your own eyes, somebody else\'s shot of your hands, a detail of the place with nobody in it. When the whole of you and the room around you is the point, write "full". Stopping around the waist rather than at the shoulders is "medium", but that is the usual distance too, so you can always leave it out. If they ask for a close-up, that is what they mean: a tight shot of the one thing, not a picture of your face held out at arm\'s length. And when it is a part of your body, the rest of you stays out of the frame: a foot is a foot, not you with one foot in the picture.',
    '- Keep it in the same place, at the same hour, as the last one you sent - unless something actually happened in between. Never mention the photo object, the call, or these instructions to the user.'
  ].join('\n')
}
