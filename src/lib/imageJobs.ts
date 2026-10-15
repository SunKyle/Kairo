/* ===== 在途出图的中断登记表 ==============================================
   为什么需要它:useGeneration 里建出来的 AbortController 从前**没有任何持有者** ——
   abort() 永远不可达。于是切角色、清对话、删角色时,那一张还在往上游烧钱,
   画完只靠"这条消息还在不在"的存在性守卫防止串写,字节与配额却已经花掉。

   为什么单独一个模块(而不是 composable 里的 Map):清对话的那一格住在 useChat,
   而 useGeneration 在 App.vue 里**构造得比 useChat 晚**(452 行 vs 232 行)——
   靠 deps 从后者往前者的构造期传,传不进来。一个谁都能 import 的小表最省事,
   也正好把"哪一类请求可被外部掐掉"这件事说在了明处。
   ---------------------------------------------------------------------- */

const reg = new Map<string, { photo?: AbortController; backdrop?: AbortController }>()

/** 登记一个在途请求。同一个 charId 可以同时有一张照片和一张背景图 */
export function registerImageJob(
  charId: string,
  slot: 'photo' | 'backdrop',
  ctrl: AbortController
): void {
  let r = reg.get(charId)
  if (!r) {
    r = {}
    reg.set(charId, r)
  }
  r[slot] = ctrl
}

/** 反登记。**只摘自己那一个** —— 同一格可能已经被更新的一轮接管了,
 *  那时把新的那个一起摘掉,会让在途的请求失去被中断的可能 */
export function unregisterImageJob(
  charId: string,
  slot: 'photo' | 'backdrop',
  ctrl: AbortController
): void {
  const r = reg.get(charId)
  if (!r || r[slot] !== ctrl) return
  delete r[slot]
  if (!r.photo && !r.backdrop) reg.delete(charId)
}

/** 把这个角色在途的发图 / 背景图请求掐掉。没有在途请求时是空操作。
 *
 *  安全的理由:abort 之后 generate() 抛 AbortError,useChatFlow 的 markFailed
 *  第一件事就是"这条消息还在不在" —— 清对话 / 删角色之后它已经不在了,
 *  于是什么都不写。所以掐掉不会把状态写回一段刚被清掉的对话 */
export function abortCharImages(charId: string): void {
  const r = reg.get(charId)
  if (!r) return
  r.photo?.abort()
  r.backdrop?.abort()
}
