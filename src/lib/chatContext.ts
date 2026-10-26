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

import type { ChatAttachment, ChatMessage } from '../types'

/** 带图但一个字没写 */
export const EMPTY_WITH_IMAGE = '(sent a photo)'
/** 带了一张卡(链接/歌曲)但一个字没写 */
export const EMPTY_WITH_CARD = '(sent a card)'
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
 * 空正文换一句占位。附件/图片**不再把细节补进正文** —— 旧版这里会补一行
 * `(a song was shared — …)`,而那一行是助手消息的正文,模型会把它当成自己
 * 写过的台词照抄,宁可写字也不去调工具(实测)。"发过哪几张卡"改由
 * useChatFlow 随请求带 `shares`,在服务端拼进 system 的一份简报里;
 * 这里只说"这一轮发过一张卡",不给任何可模仿的格式。
 */
export function contextText(m: {
  content: string
  imageId?: string
  photoId?: string
  attachment?: ChatAttachment
}): string {
  const text = String(m?.content ?? '')
  if (text.trim()) return text
  const parts = []
  if (hasImage(m)) parts.push(EMPTY_WITH_IMAGE)
  if (m.attachment) parts.push(EMPTY_WITH_CARD)
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

/**
 * 这一轮该带哪些历史消息。
 *
 * 只取最近 `window` 条会漏掉一段:摘要的游标停在"上一批压完的那条",
 * 而窗口只覆盖最新 20 条 —— 两者之间可能隔着 1~19 条,既不在摘要里,
 * 也没随这次请求发出去。模型于是一边"记得"一段旧事、一边看不见紧接着
 * 它的那几句(用户看到的是"它怎么忘了刚才说的")。
 *
 * 所以取并集:**摘要游标之后的全部消息 + 最近 `window` 条**,按 id 去重,
 * 再按服务端一轮最多收的条数 `max` 封顶。封顶时丢最旧的 ——
 * 它们离当前最远,而且下一轮 maybeSummarize 会先把它们压进摘要。
 *
 * 没有游标(还没压过)时只发最近一窗:那是原来的行为,不该因为补空窗
 * 把一段正常对话的请求撑大一倍。
 *
 * 纯函数、无 IO:窗口怎么算可以单测,不必把整条发送链跑起来。
 */
export function chatContextWindow(
  messages: readonly ChatMessage[],
  summary: { upToAt: number } | null | undefined,
  window = 20,
  max = 40
): ChatMessage[] {
  if (!messages.length) return []
  const take = Math.max(0, Math.floor(window))
  const cap = Math.max(1, Math.floor(max))
  const tail = take ? messages.slice(-take) : []
  const upToAt = typeof summary?.upToAt === 'number' ? summary.upToAt : 0
  if (upToAt <= 0) return tail.slice(-cap)

  const inTail = new Set(tail.map((m) => m.id))
  const since = messages.filter((m) => m.createdAt > upToAt && !inTail.has(m.id))
  return [...since, ...tail].slice(-cap)
}
