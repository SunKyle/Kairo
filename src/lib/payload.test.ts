import { describe, expect, it } from 'vitest'
import {
  EDIT_PAYLOAD_BUDGET,
  EDIT_PAYLOAD_EDGE,
  REF_ARCHIVE_EDGE,
  REF_IMAGE_EDGE,
  dataUrlBytes,
  payloadOverBudget,
  payloadScaleFor,
  shrinkScaleFor
} from './payload'

describe('dataUrlBytes · 载荷字节数', () => {
  it('按 base64 的 3/4 折算正文,不算头部', () => {
    // 'AAAA' 是 4 个 base64 字符 → 3 字节
    expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3)
  })

  it('头部长度不影响结果', () => {
    expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(
      dataUrlBytes('data:image/jpeg;base64,AAAA')
    )
  })

  it('没有逗号(不是合法 data URL)时把整串当 base64 正文,不抛异常', () => {
    // 退化情形:契约是"当作 base64 正文来估",所以 'nonsense' 的 8 字符算 6 字节
    expect(dataUrlBytes('nonsense')).toBe(6)
    expect(dataUrlBytes('')).toBe(0)
  })

  it('实测量级对得上:12MB 的 base64 正文', () => {
    const body = 'A'.repeat(16 * 1024 * 1024)
    expect(dataUrlBytes(`data:image/png;base64,${body}`)).toBeCloseTo(12 * 1024 * 1024, -3)
  })
})

describe('payloadScaleFor · 收窄到上限', () => {
  it('没超上限就不缩', () => {
    expect(payloadScaleFor(1920, 1080)).toBe(1)
    expect(payloadScaleFor(2560, 1440)).toBe(1)
  })

  it('4K 收到 2560:0.666…(横竖都按长边算)', () => {
    expect(payloadScaleFor(3840, 2160)).toBeCloseTo(2560 / 3840, 5)
    expect(payloadScaleFor(2160, 3840)).toBeCloseTo(2560 / 3840, 5)
  })

  it('极端长图也按长边收', () => {
    expect(payloadScaleFor(10000, 100)).toBeCloseTo(0.256, 3)
  })

  it('尺寸未知(0)时不动它,免得算出 Infinity', () => {
    expect(payloadScaleFor(0, 0)).toBe(1)
    expect(payloadScaleFor(NaN, 100)).toBe(1)
  })

  it('上限可覆盖', () => {
    expect(payloadScaleFor(2000, 1000, 1000)).toBe(0.5)
  })
})

describe('shrinkScaleFor · 超预算时再退一档', () => {
  it('按 0.7 退档', () => {
    expect(shrinkScaleFor(1)).toBeCloseTo(0.7, 5)
    expect(shrinkScaleFor(0.7)).toBeCloseTo(0.49, 5)
  })

  it('退到下限之下就停(返回 null),不会把图缩到看不清', () => {
    // 0.343 × 0.7 = 0.24 < 0.25
    expect(shrinkScaleFor(0.343)).toBeNull()
    // 刚好在下限上还允许
    expect(shrinkScaleFor(0.36)).toBeCloseTo(0.252, 5)
  })
})

describe('payloadOverBudget · 超预算判定', () => {
  it('几段加起来算', () => {
    const third = 'A'.repeat(4 * 1024 * 1024) // 约 3MB
    const url = `data:image/png;base64,${third}`
    expect(payloadOverBudget([url, url])).toBe(false) // 约 6MB < 8MB
    expect(payloadOverBudget([url, url, url])).toBe(true) // 约 9MB > 8MB
  })

  it('刚过预算线就算超', () => {
    const payload = 'A'.repeat(Math.ceil((EDIT_PAYLOAD_BUDGET * 4) / 3) + 8)
    expect(payloadOverBudget([`data:image/png;base64,${payload}`])).toBe(true)
  })

  it('空载荷不超', () => {
    expect(payloadOverBudget([])).toBe(false)
  })

  it('默认上限就是 2560 与 8MB —— 改动它们要有意识地改', () => {
    expect(EDIT_PAYLOAD_EDGE).toBe(2560)
    expect(EDIT_PAYLOAD_BUDGET).toBe(8 * 1024 * 1024)
  })
})

describe('尺寸上限之间的关系 · 别让它们悄悄错位', () => {
  it('参考图比编辑载荷更省:两者的取舍不同,不能混成一个数', () => {
    expect(REF_IMAGE_EDGE).toBeLessThan(EDIT_PAYLOAD_EDGE)
    expect(REF_ARCHIVE_EDGE).toBeLessThanOrEqual(REF_IMAGE_EDGE)
  })

  it('编辑载荷上限不低于本站给出的最大档(2560×1440)', () => {
    /* 厂商那边不动手,我们自己收窄就是有损的:如果这个上限被调到比用户
       能选的档位还小,那"选 2560 出图"就会变成"实际只送了 X 进去" ——
       结果看起来只是"糊了一点",不会有任何报错。这条把它钉住 */
    const largestOfferedEdge = 2560
    expect(EDIT_PAYLOAD_EDGE).toBeGreaterThanOrEqual(largestOfferedEdge)
  })

  it('三个数都必须是正整数,别写成 0 或 NaN', () => {
    for (const n of [EDIT_PAYLOAD_EDGE, REF_IMAGE_EDGE, REF_ARCHIVE_EDGE, EDIT_PAYLOAD_BUDGET]) {
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThan(0)
    }
  })
})
