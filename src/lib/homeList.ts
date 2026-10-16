/* 首页两块列表的顺序,与卡片上那一行"简短身份"(T7) ====================
   首页有两块,它们答的是**两个不同的问题** —— 这一点 lib/chatOrder 的注释
   已经说过了,这里只是各自落地:

   ① 主区「Your characters」:我最近造了谁 → 置顶在前,其余按创建时间(最近建的在前)
   ② 次区「Continue where you left off」:我刚跟谁说过话 → orderConversations,
      **并且只列真聊过的**

   **两块不能用同一个顺序**:主区用"最近聊的"排,次区就只是主区的复制品
   (少了那一行摘要);反过来用"最近建的",次区顶上的就是一个从没说过话的角色,
   而"上次说到哪儿了"在它那儿根本没有答案。

   PRD §11.2 给首页列了一串"避免项",其中**统计面板与消息数排行榜**正在这一块:
   所以这个文件不产出任何计数 —— 首页不回答"我跟它说过多少句"。
   -------------------------------------------------------------------- */

import { agoLabel } from '../../server/chatTime.js'
import { orderConversations } from './chatOrder'
import type { Character, ChatMessage } from '../types'

/** 次区摆几行。给个固定的小数字:这一块是"回到上次",不是第二份角色目录。
 *  列太多会把主区挤到首屏之外 —— 而主区才是首页的主体(PRD §5.1) */
export const RECENT_CAP = 4

/** 主区的顺序:置顶的排在最前面,其余保持主界面给的原顺序(最近建的在前)。
 *  **排的是副本** —— 与 orderConversations 同一条理由:传进来的那份顺序
 *  还有别的含义(删除的撤销要放回原来的位置,见 App 的 deleteChar)。
 *  与角色页的 listedChars 是同一个判据,但**不共用那一份** —— 它长在
 *  useCharacterList 里,而那个 composable 还带着卡片的菜单状态一大堆东西。
 *  首页用不到那些,引过来等于把半个角色页拖进首页 */
export function homeGrid(chars: readonly Character[]): Character[] {
  return [...chars].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
}

export interface RecentChat {
  char: Character
  /** 最后一条消息。**一定有** —— 没有聊过的角色不进这一列 */
  last: ChatMessage
}

/**
 * 次区:按"最近聊的"排,只留真聊过的,取前 cap 个。
 *
 * @param chars  角色目录(不要求已排序 —— orderConversations 自己会排一份)
 * @param lastOf "某个角色最后一句"的取法。传**函数**而不是对象:
 *              整份被换掉是常态(ref 重新赋值、props 收到新对象),
 *              捕获住旧的那一份,排出来的就是一份过期快照。
 *              (与 lib/chatOrder 的 lastMessageLookup 同一条理由)
 */
export function recentChats(
  chars: readonly Character[],
  lastOf: (id: string) => ChatMessage | undefined,
  cap: number = RECENT_CAP
): RecentChat[] {
  const out: RecentChat[] = []
  for (const c of orderConversations(chars as Character[], lastOf)) {
    const last = lastOf(c.id)
    /* "聊过"的判据是**有最后一条消息**,不是"出过图"也不是"有记忆":
        用户在这一行问的是"上次说到哪儿了",一个只出过图、没说过话的角色
        在这儿没有答案。而 orderConversations 也会把没聊过的按创建时间排上来,
        不过滤的话第一行就可能是个从没开口的 */
    if (!last) continue
    out.push({ char: c, last })
    if (out.length >= cap) break
  }
  return out
}

/**
 * 卡片上那一行"简短身份"。**逐级兜底** —— 一级都没有时给一句中性的话,
 * 而不是留一行为空:空行看起来像渲染出错,而它真正想说的是"这人还没写设定"。
 *
 * 顺序是有意的:**identity 那栏是"它是谁"** (身份 / 职业 / 环境);
 * desc 是用户自己写的那段备注,是第二选择。不拿 persona 顶第一级 ——
 * 那是"它是什么样的人",与"它是谁"不是同一件事。
 */
export function homeIdentity(c: Character): string {
  const id = (c.fields?.identity || '').trim()
  if (id) return id
  const desc = (c.desc || '').trim()
  if (desc) return desc
  return 'No description yet'
}

/**
 * 那一行"多久以前"。**与对话页、系统提示词共用同一句** ——
 * agoLabel 是那份口径的唯一出处(见 server/chatTime.js 顶部那段注释):
 * 同一个事实在两处被说成两样,用户会以为它们在讲两件事。
 *
 * 它返回空串表示"不该报"(太近、太久、或时间戳是坏的)。这一行退回
 * 'Just now':一个刚说完话的角色,时间那一侧空着比写句"1 minute ago"更奇怪。
 * @param now 可注入,好让单测不碰真实时钟
 */
export function homeAgo(ts: number, now: number = Date.now()): string {
  return agoLabel(now - ts, { long: true }) || 'Just now'
}

/** 那一行摘要:最后一条**说了什么**。超长时收一行 —— 这是列表项,不是消息流 */
export function homeSnippet(msg: ChatMessage, max = 90): string {
  const text = (msg.content || '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}
