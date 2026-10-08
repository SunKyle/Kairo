import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { isInsideSelector } from '../lib/ui'
import type { Character } from '../types'

/* ===== 角色列表与卡片菜单 ==============================================
 *  列表的顺序(置顶在前)与卡片右上角那个 ⋮ 菜单:开合、指针宽限、
 *  点外收起,以及四个管理动作的转发(编辑 / 复制 / 置顶 / 导出 / 删除)。
 *
 *  动作本身不在这里做 —— 它们都要动目录、动库、动撤销窗口,那是主界面的活;
 *  这一块只负责"把菜单收掉,再把意图交出去"。
 *
 *  从 CharacterPage 抽出来的第五块(前四块:嗓音、字段规格表、草稿表单、详情与查看器)。
 *  ------------------------------------------------------------------ */

export interface CharacterListDeps {
  characters: () => Character[]
  /** 编辑:开向导并预填这一条(向导本身归页面) */
  startEdit: (c: Character) => void
  duplicate: (id: string) => void
  pin: (id: string) => void
  exportChar: (id: string) => void
  remove: (id: string) => void
}

export function useCharacterList(deps: CharacterListDeps) {
  /* 卡上那四项管理动作(置顶 / 复制 / 导出 / 删除)收进一个 ⋮ 菜单。
     常驻的圆钮太吵,而它们都是低频动作。
     同一时刻只开一个:键是角色 id,同一套写法见 PromptLibrary */
  const openCardMenu = ref('')
  // 菜单默认朝下开。最后一行离视口底部不够高时改朝上 —— 否则菜单会伸到屏幕外
  const cardMenuUp = ref(false)
  // 菜单大致高度(四项 + 内边距 + 与按钮的间距),留一点余量
  const MENU_ROOM = 165
  /* 指针离开这张卡就把菜单收掉。⋮ 本来就是悬停才出现的,菜单却不跟着走 ——
     指针一挪开,图上就剩一块没有锚点的浮层挂在那儿。
     两个细节:① 留 120ms 宽限,⋮ 与菜单之间隔了 6px,横穿那一下不算"离开";
     ② 只认鼠标 —— 触摸抬手时浏览器也会发 pointerleave,照做会把刚点开的菜单立刻收掉 */
  const MENU_GRACE = 120
  let menuLeaveTimer: number | undefined

  /** 收起菜单。几条收起的路径(再点 ⋮、点别处、Esc、选中动作)都走这里,
   *  顺手把宽限计时器清掉 —— 否则它晚一步才响,会把刚重新打开的那张收掉 */
  function closeCardMenu() {
    window.clearTimeout(menuLeaveTimer)
    openCardMenu.value = ''
  }

  function toggleCardMenu(id: string, e: MouseEvent) {
    if (openCardMenu.value === id) {
      closeCardMenu()
      return
    }
    const r = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect()
    cardMenuUp.value = !!r && r.bottom + MENU_ROOM > window.innerHeight
    window.clearTimeout(menuLeaveTimer)
    openCardMenu.value = id
  }

  /* 指针从 ⋮ 挪向菜单要穿过那道 6px 的缝,缝里既不在 ⋮ 上也不在菜单上 ——
     于是先起倒计时,人重新落回这一片(pointerenter)就把倒计时撤掉 */
  function onMenuEnter() {
    window.clearTimeout(menuLeaveTimer)
  }
  function onMenuLeave(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return
    window.clearTimeout(menuLeaveTimer)
    menuLeaveTimer = window.setTimeout(closeCardMenu, MENU_GRACE)
  }

  /* 展开后点别处收起:管理动作低频,不该逼用户再点一次 ⋮ 才能走。
     用 closest 判断"点的是不是某个菜单内部",而不是记住某一个容器 ——
     列表里每张卡都挂着一个菜单,一个 ref 挂多处只会拿到最后一个 */
  function onDocPointerDown(e: PointerEvent) {
    if (!openCardMenu.value) return
    if (isInsideSelector(e.target, '.menu-wrap')) return
    closeCardMenu()
  }

  /* 三个动作各自包一层:先收起菜单再交出去。
     菜单留着不关会盖住卡片,而这三个动作都会让主界面改 props、重渲染这张卡 */
  function editFromCard(id: string) {
    closeCardMenu()
    // 找不到就是这一条正好被删了:startEdit() 不带角色会当成新建,不能那样兜底
    const c = deps.characters().find((x) => x.id === id)
    if (c) deps.startEdit(c)
  }
  function duplicateFromCard(id: string) {
    closeCardMenu()
    deps.duplicate(id)
  }
  /* 置顶 / 取消置顶。与另外三个动作同一套:先收菜单再交出去 ——
     置顶会让这张卡立刻换位置(排到最前),菜单留着就成了一个跟错地方的浮层 */
  function pinFromCard(id: string) {
    closeCardMenu()
    deps.pin(id)
  }
  function exportFromCard(id: string) {
    closeCardMenu()
    deps.exportChar(id)
  }
  function removeFromCard(id: string) {
    closeCardMenu()
    deps.remove(id)
  }

  /* 列表顺序:置顶的排在最前面,其余保持主界面给的原顺序(最近建的在前)。
     排序是**派生**的,不动 characters 数组本身 —— 那份顺序还有别的含义
     (删除的撤销要放回原来的位置,见主界面的 deleteChar);
     而 sort 是稳定的,所以未置顶的那些相对次序一点没变 */
  const listedChars = computed(() =>
    [...deps.characters()].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
  )
  /* 这个监听由这一块自己挂:它是菜单的"点外收起",与页面其余部分无关。
     写在 composable 里的 onMounted 与写在使用它的组件里是同一时机 */
  onMounted(() => document.addEventListener('pointerdown', onDocPointerDown))
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onDocPointerDown)
    window.clearTimeout(menuLeaveTimer)
  })

  return {
    openCardMenu,
    cardMenuUp,
    closeCardMenu,
    toggleCardMenu,
    onMenuEnter,
    onMenuLeave,
    editFromCard,
    duplicateFromCard,
    pinFromCard,
    exportFromCard,
    removeFromCard,
    listedChars
  }
}
