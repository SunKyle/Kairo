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
})
