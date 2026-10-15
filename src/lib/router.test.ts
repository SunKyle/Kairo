import { describe, expect, it } from 'vitest'
import { formatHash, parseHash } from './router'

describe('router · 轻量 Hash 路由与深链接', () => {
  it('空 hash 或 #/ 默认回对话页', () => {
    expect(parseHash('')).toEqual({ page: 'chat' })
    expect(parseHash('#')).toEqual({ page: 'chat' })
    expect(parseHash('#/')).toEqual({ page: 'chat' })
  })

  it('正确解析一级页面', () => {
    expect(parseHash('#/chars')).toEqual({ page: 'chars' })
    expect(parseHash('#/chat')).toEqual({ page: 'chat' })
    expect(parseHash('#/history')).toEqual({ page: 'history' })
    expect(parseHash('#/settings')).toEqual({ page: 'settings' })
  })

  it('正确解析带参数的深链接', () => {
    expect(parseHash('#/chat/char_abc123')).toEqual({ page: 'chat', id: 'char_abc123' })
    expect(parseHash('#/chars/captain')).toEqual({ page: 'chars', id: 'captain' })
  })

  /* 历史页那两种深链**必须分得开**:`id` 是"打开某条记录",`byChar` 是"只看谁"。
     两者都来自 api.ts 的 uid()(一串无前缀的 base36),混在一格里就分不出该做哪件事 ——
     而认错的表现是静默的:applyRouteId 找不到那条记录,点进去什么都不发生 */
  it('历史页:by/<charId> 走 byChar,普通 <id> 仍走 id', () => {
    expect(parseHash('#/history/by/c1')).toEqual({ page: 'history', byChar: 'c1' })
    expect(parseHash('#/history/h9')).toEqual({ page: 'history', id: 'h9' })
  })

  it('历史页:by 后面没跟东西时不认这一支,退回普通 id 解析', () => {
    // 认成 { page:'history' } 会让地址栏里的 `by` 凭空消失,反而更怪
    expect(parseHash('#/history/by')).toEqual({ page: 'history', id: 'by' })
  })

  it('别的页不认 by 这个关键字', () => {
    expect(parseHash('#/chars/by')).toEqual({ page: 'chars', id: 'by' })
    expect(parseHash('#/chat/by/x')).toEqual({ page: 'chat', id: 'by' })
  })

  it('未知页面安全降级回对话页', () => {
    expect(parseHash('#/unknown_route')).toEqual({ page: 'chat' })
    expect(parseHash('#/invalid/123')).toEqual({ page: 'chat' })
    /* KImage 那三页(Studio 工作台 / 画布 / 提示词库)没有带过来:
       地址栏里还留着旧书签或旧链接时,一律回对话页,而不是整页空白 */
    expect(parseHash('#/home')).toEqual({ page: 'chat' })
    expect(parseHash('#/canvas')).toEqual({ page: 'chat' })
    expect(parseHash('#/lib')).toEqual({ page: 'chat' })
  })

  it('formatHash 生成正确的 hash 路径', () => {
    expect(formatHash('chat')).toBe('#/')
    expect(formatHash('chars')).toBe('#/chars')
    expect(formatHash('chat', 'char_456')).toBe('#/chat/char_456')
    expect(formatHash('history')).toBe('#/history')
  })

  it('formatHash 与 parseHash 在历史页那两种形态上来回一趟不走样', () => {
    expect(formatHash('history', undefined, 'c1')).toBe('#/history/by/c1')
    expect(parseHash(formatHash('history', undefined, 'c1'))).toEqual({
      page: 'history',
      byChar: 'c1'
    })
    expect(parseHash(formatHash('history', 'h9'))).toEqual({ page: 'history', id: 'h9' })
  })

  it('byChar 只对历史页生效 —— 别的页给了它也不该改写 hash', () => {
    expect(formatHash('chars', undefined, 'c1')).toBe('#/chars')
    expect(formatHash('chat', 'x', 'c1')).toBe('#/chat/x')
  })
})
