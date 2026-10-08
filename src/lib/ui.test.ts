import { describe, expect, it, vi } from 'vitest'
import { isInside, isInsideSelector, layerOnEscape, trapTargetIndex } from './ui'

describe('trapTargetIndex · Tab 在浮层里怎么绕', () => {
  it('焦点不在列表里(刚打开、落在容器上)时:正向进第一个,反向进最后一个', () => {
    expect(trapTargetIndex(3, -1, false)).toBe(0)
    expect(trapTargetIndex(3, -1, true)).toBe(2)
  })

  it('正向走到最后一个 → 绕回第一个', () => {
    expect(trapTargetIndex(3, 2, false)).toBe(0)
  })

  it('反向走到第一个 → 绕回最后一个', () => {
    expect(trapTargetIndex(3, 0, true)).toBe(2)
  })

  it('中间位置交给浏览器(返回 null,不 preventDefault)', () => {
    expect(trapTargetIndex(3, 1, false)).toBeNull()
    expect(trapTargetIndex(3, 1, true)).toBeNull()
  })

  it('只有一个元素时,两个方向都绕回它自己', () => {
    expect(trapTargetIndex(1, 0, false)).toBe(0)
    expect(trapTargetIndex(1, 0, true)).toBe(0)
  })

  it('没有可聚焦元素时什么都不做(否则会把 Tab 吃掉)', () => {
    expect(trapTargetIndex(0, -1, false)).toBeNull()
    expect(trapTargetIndex(0, -1, true)).toBeNull()
  })
})

describe('isInside · 点在不在这个元素里', () => {
  const inside = { tag: 'inside' } as unknown as Node
  const outside = { tag: 'outside' } as unknown as Node
  const el = { contains: (n: Node) => n === inside } as unknown as HTMLElement

  it('点在里面 → true,落在外面 → false', () => {
    expect(isInside(inside, el)).toBe(true)
    expect(isInside(outside, el)).toBe(false)
  })

  it('元素还没挂上( ref 为空)时算"不在里面"', () => {
    expect(isInside(inside, null)).toBe(false)
    expect(isInside(inside, undefined)).toBe(false)
  })

  it('没有 target 时算"不在里面",不抛异常', () => {
    expect(isInside(null, el)).toBe(false)
  })
})

describe('isInsideSelector · 按祖先类名判', () => {
  it('命中选择器 → true', () => {
    const target = { closest: (sel: string) => (sel === '.menu-wrap' ? {} : null) }
    expect(isInsideSelector(target as unknown as EventTarget, '.menu-wrap')).toBe(true)
  })

  it('没命中 → false', () => {
    const target = { closest: () => null }
    expect(isInsideSelector(target as unknown as EventTarget, '.menu-wrap')).toBe(false)
  })

  it('文本节点没有 closest —— 这种情况必须安静返回 false', () => {
    expect(isInsideSelector({ nodeType: 3 } as unknown as EventTarget, '.menu-wrap')).toBe(false)
    expect(isInsideSelector(null, '.menu-wrap')).toBe(false)
  })
})

describe('layerOnEscape · 一次 Esc 只退一层', () => {
  function layers(state: [boolean, boolean, boolean]) {
    const calls: string[] = []
    return {
      calls,
      list: [
        { open: state[0], close: () => calls.push('a') },
        { open: state[1], close: () => calls.push('b') },
        { open: state[2], close: () => calls.push('c') }
      ]
    }
  }

  it('退最先开着的那一层,且只退一层', () => {
    const l = layers([true, true, true])
    expect(layerOnEscape('Escape', l.list)).toBe(true)
    expect(l.calls).toEqual(['a'])
  })

  it('第一层没开时退第二层', () => {
    const l = layers([false, true, true])
    layerOnEscape('Escape', l.list)
    expect(l.calls).toEqual(['b'])
  })

  it('全都没开时什么都不做,并返回 false(调用方可以接着处理别的键)', () => {
    const l = layers([false, false, false])
    expect(layerOnEscape('Escape', l.list)).toBe(false)
    expect(l.calls).toEqual([])
  })

  it('别的键一律不管 —— 否则会把方向键之类也吃掉', () => {
    const l = layers([true, true, true])
    expect(layerOnEscape('ArrowLeft', l.list)).toBe(false)
    expect(layerOnEscape('Tab', l.list)).toBe(false)
    expect(l.calls).toEqual([])
  })

  it('层层退的完整过程:连按三次把三层退干净', () => {
    const calls: string[] = []
    let open = [true, true, true]
    const build = () =>
      open.map((o, i) => ({ open: o, close: () => calls.push(String(i)) }))
    for (let i = 0; i < 3; i++) {
      layerOnEscape('Escape', build())
      open = open.map((_, idx) => idx > i) // 已退掉的层置为关闭
    }
    expect(calls).toEqual(['0', '1', '2'])
    expect(layerOnEscape('Escape', build())).toBe(false)
  })

  it('close 只被调用一次(不会顺手把下层也关了)', () => {
    const spy = vi.fn()
    layerOnEscape('Escape', [
      { open: true, close: spy },
      { open: true, close: spy }
    ])
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
