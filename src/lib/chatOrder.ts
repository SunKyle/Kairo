/* 对话左栏的顺序 —— 以及进页面时该替用户挑哪一个。
 *
 *  为什么值得单独一个文件:同一件事有**两处**在问。一处是左栏铺出来的时候
 *  (ChatPage 的 ordered),一处是进对话页替用户挑一个的时候(主界面的
 *  ensureChatChar)。两处各排一遍,刷新之后选中的那一行就不是第一行 ——
 *  用户看到的是"打开的对话不对",而不是"排序不对"。
 *
 *  规则:置顶的永远在最前(那是用户亲手说的"别让它沉下去"),其余按最后一条
 *  消息的时间排(最近聊的在前),一条都没聊过的按创建时间排(最近建的在前)。
 *  **与角色页那条"最近建的在前"不是一回事** —— 那边答的是"我最近造了谁",
 *  这边答的是"我刚跟谁说过话"(见 useCharacterList 的 listedChars)。
 *
 *  顺序是派生的,不落盘 —— 与 charStats / charWorks 同一条规矩。
 */

import type { Character, ChatMessage } from '../types'

/**
 * "某个角色最后一句"的取法,两处共用一个口径:**内存里那份优先,库里那份兜底**。
 *
 *  内存里那份更新(刚说完的话就在里面),而 lastMsg 是给没打开过的角色用的 ——
 *  消息按角色懒加载,不补这一路的话它们在左栏一律显示 No messages yet 并排到最后:
 *  明明聊过,看起来却像从没聊过。
 *
 *  两个来源都收**函数**而不是对象:它们被整份换掉是常态(ref 重新赋值、props
 *  收到新对象),捕获住旧的那一份,排出来的就是一份过期快照。
 */
export function lastMessageLookup(
  messages: () => Record<string, ChatMessage[]>,
  lastMsg: () => Record<string, ChatMessage>
): (id: string) => ChatMessage | undefined {
  return (id) => {
    const list = messages()[id]
    if (list && list.length) return list[list.length - 1]
    return lastMsg()[id]
  }
}

/** 左栏的顺序。**排的是副本** —— 传进来的那份顺序还有别的含义
 *  (角色页是"最近建的在前",撤销删除要放回原来的位置),
 *  在这里就地排一遍等于替别人改主意 */
export function orderConversations(
  chars: Character[],
  lastOf: (id: string) => ChatMessage | undefined
): Character[] {
  return [...chars].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      (lastOf(b.id)?.createdAt || 0) - (lastOf(a.id)?.createdAt || 0) ||
      b.createdAt - a.createdAt
  )
}
