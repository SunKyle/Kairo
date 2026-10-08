/* ===== 浮层的公共行为 ================================================
   三件事在各组件里被重复实现过:把 Tab 关在浮层里、点浮层外收起、
   一次 Esc 只退一层。它们都不是"业务",却各有各的细节坑
   (焦点不在列表里怎么办、容器本身可聚焦怎么办、Esc 该退哪一层),
   所以收在这里一处,而不是抄六份 —— 抄的那六份已经开始漂移了:
   同样是 trapTab,两份逐字相同,第三份用的是另一套选择器与判断。
   -------------------------------------------------------------------- */

/* 可聚焦元素。**取并集**是有意的:焦点陷阱只要漏掉一类可聚焦元素,
   焦点就会从那个元素溜到背后的页面上 —— 而"漏掉哪一类"正是三份实现
   不一致的地方(一份漏了 a[href] 与 [tabindex],另一份漏了 disabled 过滤)。
   排除 tabindex="-1":那是"能用脚本聚焦、但不在 Tab 序里"的标记
   (浮层容器自己就是),把它算进来会让循环多走一步空门 */
const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

export interface FocusTrapOpts {
  /** 只算可见的(默认开)。浮层里常有 display:none 的备用控件,
   *  把看不见的东西排进循环顺序,等于让用户 Tab 到一片空白 */
  visibleOnly?: boolean
}

/** 容器里当前可聚焦的元素,按文档顺序 */
export function focusablesIn(box: HTMLElement | null, opts: FocusTrapOpts = {}): HTMLElement[] {
  if (!box) return []
  const list = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE))
  if (opts.visibleOnly === false) return list
  // 有布局盒子的才算真的能聚焦:display:none 与未挂载的都没有 rects
  return list.filter((el) => el.getClientRects().length > 0)
}

/**
 * Tab 该把焦点送到第几个(null = 不用管,让浏览器自己走)。
 *
 * 抽成纯函数是因为这里的边界最容易写错,而它又完全测不了(要真开一个浮层):
 * - 焦点不在列表里(刚打开时落在容器上、或落在别处):正向进第一个,反向进最后一个
 * - 正向走到最后一个、反向走到第一个:绕回另一端
 * - 其余情况返回 null,交回浏览器 —— 不 preventDefault 才不会破坏别的东西
 */
export function trapTargetIndex(count: number, activeIndex: number, shiftKey: boolean): number | null {
  if (count <= 0) return null
  if (activeIndex < 0) return shiftKey ? count - 1 : 0
  if (shiftKey) return activeIndex === 0 ? count - 1 : null
  return activeIndex === count - 1 ? 0 : null
}

/** 把 Tab 关在浮层里:走到首/尾时绕回另一端,不让焦点跑到背后的页面 */
export function trapTab(
  box: HTMLElement | null,
  e: KeyboardEvent,
  opts: FocusTrapOpts = {}
): void {
  const items = focusablesIn(box, opts)
  const at = document.activeElement as HTMLElement | null
  const target = trapTargetIndex(items.length, at ? items.indexOf(at) : -1, e.shiftKey)
  if (target === null) return
  e.preventDefault()
  items[target]?.focus()
}

/* —— 点外收起 ——
   两种判定都要:多数地方手上有一个 ref(菜单容器),直接 contains 更准;
   而随行渲染的菜单(每一行一个)拿不到稳定的 ref,只能按祖先类名判 */
export function isInside(target: EventTarget | null, el: HTMLElement | null | undefined): boolean {
  return !!el && !!target && el.contains(target as Node)
}

export function isInsideSelector(target: EventTarget | null, selector: string): boolean {
  const t = target as (Element & Node) | null
  // e.target 可能是文本节点,它没有 closest —— 这一层判空以前散在每一处调用点
  return !!t && typeof t.closest === 'function' && !!t.closest(selector)
}

/* —— Esc 逐层退 ——
   顺序就是"从最上面那一层开始"。一次 Esc 只关一层:
   开着大图按一下直接退回列表,会让人丢掉"我看的是哪个角色" */
export interface EscLayer {
  open: boolean
  close: () => void
}

/** 返回是否关掉了一层(调用方据此决定要不要 return) */
export function layerOnEscape(key: string, layers: EscLayer[]): boolean {
  if (key !== 'Escape') return false
  for (const l of layers) {
    if (!l.open) continue
    l.close()
    return true
  }
  return false
}
