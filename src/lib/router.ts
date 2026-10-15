import type { Page } from './nav'

/* ===== 轻量 Hash 路由与深链接 ==========================================
   没有引入 vue-router 是这个项目的既有决定(保持单页、无多余依赖)。
   但刷新强制回首页、无法把某个角色或某段对话发给人是一个明显痛点。
   这里用 window.location.hash 提供极简的深链接支持:
   - '#/' 或空 -> chat(Kairo 的主页就是对话)
   - '#/chat' / '#/chat/:id'
   - '#/chars' / '#/chars/:id'
   - '#/memory' / '#/history' / '#/settings'
   - '#/history/:entryId'      -> 打开某一条历史记录的预览
   - '#/history/by/:charId'    -> 历史页只看这个角色的图(T12)
   -------------------------------------------------------------------- */

export interface RouteState {
  page: Page
  id?: string
  /* 历史页的「只看这个角色」(T12)。
     **不能借 `id` 那一格**:那已经是"打开某条记录"的意思(见 App 的 applyRouteId),
     而两种 id 长得一模一样(都是 api.ts 的 uid(),一串无前缀的 base36)——
     混在同一格里就分不出该做哪件事。所以另起一个带关键字的段,写成
     `#/history/by/<charId>`。`by` 是字面量关键字,不是变量 */
  byChar?: string
}

export const VALID_PAGES: readonly Page[] = [
  'chat',
  'chars',
  'memory',
  'history',
  'settings'
] as const

/** 解析当前的 hash 字符串。认不出的段落一律回对话页 */
export function parseHash(hash: string): RouteState {
  const clean = hash.replace(/^#\/?/, '').trim()
  if (!clean) return { page: 'chat' }
  const [segment, second, third] = clean.split('/')
  if (!VALID_PAGES.includes(segment as Page)) {
    return { page: 'chat' }
  }
  const page = segment as Page
  /* `#/history/by/<charId>` 要在认 `id` 之前拦下:否则 `by` 会被当成某条记录的 id,
     而 `applyRouteId` 会拿它去 history 里找一条不存在的记录(找不到就静默什么都不做,
     表现是"点了没反应") */
  if (page === 'history' && second === 'by' && third) {
    return { page, byChar: third }
  }
  return { page, ...(second ? { id: second } : {}) }
}

/** 将页面与参数格式化为 hash */
export function formatHash(page: Page, id?: string, byChar?: string): string {
  /* byChar 先判:它在 history 页上的优先级高于 id,而两者本来就互斥
     (一处是"只看谁",一处是"看哪一条") */
  if (page === 'history' && byChar) return `#/history/by/${byChar}`
  if (page === 'chat' && !id) return '#/'
  return id ? `#/${page}/${id}` : `#/${page}`
}
