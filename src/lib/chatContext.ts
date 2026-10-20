/* 拼给上游的上下文里,**空正文的消息不能用空串发**。
 *
 *  发送时是允许"只发一张图、一个字不打"的(见 ChatPage 的 send):那条消息的
 *  content 就是空串,挂在 imageId 上。而在历史里它只是一条普通消息 ——
 *  下一轮拼上下文时,`{role:'user', content:''}` 会被上游按"内容为空"拒掉
 *  (各家口径不一,但这不是我们能控制的:400 会当场砸在用户脸上)。
 *
 *  所以空正文要换一句**给模型看的**占位:
 *  - 它同时补回一件丢掉的信息 —— 那些图历史里不重发(一张上千 token),
 *    模型本来是"看不见"的,于是它后来说的"你那张照片"在上下文里没有任何来处;
 *  - **存下来的消息一个字不动**:占位只活在拼出来的这一次请求里,界面上、
 *    导出包里、库里都还是用户原本那条(空正文 + imageId)。
 *
 *  为什么用圆括号、不用方括号:方括号在我们这儿是**标签**语法(`[mood:` / `[photo:`),
 *  写成 `[sent a photo]` 万一被模型学去当标签吐出来,它既不是 mood 也不是 photo,
 *  解析器剪不掉 → 会原样漏给用户看。圆括号是叙述口吻,而提示词里明令
 *  角色不许写叙述 —— 两个方向都堵住了。
 *
 *  服务端在边界上还有一份同样规则的实现(见 server/index.js 的 samePlaceholder):
 *  这个端点没有鉴权,手搓一个空 content 的请求同样会打到上游,那边必须也兜住。
 */

import type { ChatAttachment } from '../types'
import { attachmentContextLine } from './chatAttachments'

/** 带图但一个字没写 */
export const EMPTY_WITH_IMAGE = '(sent a photo)'
/** 什么都空的消息:理论上前端不该产生,但 stopped 的空回复会落到这里 */
export const EMPTY_WITHOUT_IMAGE = '(said nothing)'

/** 这条消息带没带图(用户附的 / 角色发的,只认引用键,不读字节) */
function hasImage(m: { imageId?: string; photoId?: string }): boolean {
  return !!(m.imageId || m.photoId)
}

/**
 * 取出这条消息该发出去的正文。
 *
 * 不空的原样返回(**不 trim**:正文里的首尾空白是用户自己打的,
 * 上游那边本来也不会因为它报错)。
 *
 * 带附件的消息在正文后面补一行**给模型看的**转述 —— 否则它下一轮不记得
 * 自己转过什么(附件本身不重发,与图同一条理由)。补的那一行只在这份请求里,
 * 库里的消息与导出包都不含它。
 */
export function contextText(m: {
  content: string
  imageId?: string
  photoId?: string
  attachment?: ChatAttachment
}): string {
  const text = String(m?.content ?? '')
  const share = m.attachment ? `(${attachmentContextLine(m.attachment)})` : ''
  if (text.trim()) return share ? `${text}\n${share}` : text
  const parts = []
  if (hasImage(m)) parts.push(EMPTY_WITH_IMAGE)
  if (share) parts.push(share)
  return parts.length ? parts.join('\n') : EMPTY_WITHOUT_IMAGE
}

/** 发回模型这一条属于哪个心理层次。say(或没标)= 说出口的话,原样发。 */
export type ContextLayer = 'say' | 'think' | 'act'

/**
 * 把非台词的层次重新裹上区域标记,再拼进喂模型的 history。
 *
 * 落盘收尾那一步会把一轮回复按层次**扇成一条条带 layer 的消息**,而存下来的
 * content 是剪掉 `[think]`/`[act]` 之后的干净正文。若不回裹就发回去,下一轮模型
 * 看到的是一串**都说出口的话** —— 于是把心里话当台词接、把旁白当台词接,层次全糊。
 * 这里按生效层把它们各归各位:think 裹 `[think]…[/think]`,act 裹 `[act]…[/act]`。
 *
 * say / 未知层 / 空正文一律**原样返回** —— 常态的一轮一个字节都不动(与那两道
 * "普通路径不变"的闸同一条):这条函数只在真有层次时才改变形状。
 */
export function withLayerMarkers(content: string, layer?: ContextLayer): string {
  if (!content) return content
  if (layer !== 'think' && layer !== 'act') return content
  return `[${layer}]\n${content}\n[/${layer}]`
}
