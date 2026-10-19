/* ===== 未发送的输入草稿 —— 按角色各自留存 ==============================
 *
 *  对话页只挂一份实例,换角色只是改 active(见 ChatPage 的 props)。所以输入框
 *  里那份草稿组件级存着会**跟着人跑** —— 给 A 打了一半,切到 B,那半句也跳到
 *  B 的输入框里。话是说给某一个人听的,不该在两个人之间串。
 *
 *  方案:草稿存在**模块级**的 Map 里,按角色 id 各放一份 —— 切走时存下旧的,
 *  切回时取回自己的。模块级而非组件级,是因为组件会被 async 卸载重建
 *  (App.vue 里 ChatPage 是 defineAsyncComponent),那份草稿不该跟着丢。
 *
 *  两条规矩:
 *  1. **只活在内存,不落盘** —— 草稿是几分钟内的意图,刷新即弃;写进 localStorage
 *     反而多一份要回收的数据(角色删了、标签页关了都留下过期的半句话);
 *  2. **空即删键** —— 发出去、清空、只剩空白,都把那一格整个撤掉,
 *     Map 里不留空条目,角色再多也不涨。
 *
 *  纯内存、无 DOM —— 单独成文件就是为了测得了(与 chatOrder / moodDisplay 同一种写法)。
 */

interface DraftSlot {
  text: string
}

/** 角色 id → 草稿。空 Map = 谁都没有半句话 */
const drafts = new Map<string, DraftSlot>()

/** 存这一格的草稿。空 id 拒收(还没挑中角色,没有"这一格"可写);
 *  空白视作没有 —— 顺手把旧键撤掉,不留空壳 */
export function saveDraft(charId: string, text: string): void {
  if (!charId) return
  if (!text.trim()) {
    drafts.delete(charId)
    return
  }
  drafts.set(charId, { text })
}

/** 取某一格的草稿;没有就回空串 —— 输入框据此显示"空的" */
export function getDraft(charId: string): string {
  const hit = drafts.get(charId)
  return hit ? hit.text : ''
}

/** 撤掉某一格(发送成功、清空对话时走这里) */
export function clearDraft(charId: string): void {
  drafts.delete(charId)
}

/** 全部撤掉。角色被删除时给主界面用来收垃圾 —— 人没了,半句话也不该留着 */
export function clearAllDrafts(): void {
  drafts.clear()
}
