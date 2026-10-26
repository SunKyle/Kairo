import { describe, expect, it } from 'vitest'
import { countValueAt, easeOutCubic } from './countUp'

/* 这里只测那两个纯函数 —— 曲线形状和逐帧取值。动画编排(挂载触发、减弱动效跳转、
   进场一次后跟真值)要窗口与 rAF,属组合式那层,组合式无单测(见工作手册:硬不变量入
   lib/*.ts 走 vitest,带副作用的组合式不在单测范围)。
   要真正防住的是三件事:①曲线端点不钉死 → 0 帧或最后一下会跳;②进度没夹回 [0,1] →
   首帧出负数、尾帧越过目标值;③单调性破了 → 数字会倒着走一下,一眼就看出是 bug。 */

describe('easeOutCubic · 起步快收尾缓且端点钉死', () => {
  it('端点固定在 0 与 1(不跳)', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
  })

  it('把越界的进度夹回 [0,1](不出负、不越过)', () => {
    expect(easeOutCubic(-0.5)).toBe(0)
    expect(easeOutCubic(1.5)).toBe(1)
  })

  it('中点已过一半:这就是"落定感"的来源', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5)
  })
})

describe('countValueAt · 从 0 数到目标', () => {
  it('首帧 0、末帧等于目标', () => {
    expect(countValueAt(100, 0)).toBe(0)
    expect(countValueAt(100, 1)).toBe(100)
  })

  it('始终取整(不渲染出小数)', () => {
    for (const p of [0, 0.17, 0.42, 0.63, 0.88, 1]) {
      expect(Number.isInteger(countValueAt(1284, p))).toBe(true)
    }
  })

  it('单调不减(数字不会倒着走)', () => {
    let prev = -Infinity
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const v = countValueAt(50, p)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('0 目标恒为 0(冷启动/空页不该滚出一串)', () => {
    for (const p of [0, 0.3, 0.7, 1]) expect(countValueAt(0, p)).toBe(0)
  })
})
