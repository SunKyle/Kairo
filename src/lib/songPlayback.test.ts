import { describe, expect, it } from 'vitest'
import { formatSongTime, progressFraction } from './songPlayback'

/* 歌卡的进度线只有 1.5px 高,它上面任何一个错的数字都会被看见:
   时间戳跳成 "0:60"、进度条越界撑出卡片、时长还没读到时先画半条 ——
   这些都不是"数据小瑕疵",是卡上唯一的动态部分在乱动。
   两个纯函数把这两件事各收在一处,这里只锁它们的边界。 */

describe('formatSongTime · 秒数折成 m:ss', () => {
  it('整秒与零', () => {
    expect(formatSongTime(0)).toBe('0:00')
    expect(formatSongTime(30)).toBe('0:30')
    expect(formatSongTime(65)).toBe('1:05')
  })

  it('带小数的秒数向下取整 —— 时间戳只后退,不四舍五入抢跑', () => {
    expect(formatSongTime(9.9)).toBe('0:09')
    expect(formatSongTime(59.99)).toBe('0:59')
  })

  it('补齐两位:9 秒是 0:09,不是 0:9', () => {
    expect(formatSongTime(5)).toBe('0:05')
    expect(formatSongTime(61)).toBe('1:01')
  })

  it('负数、NaN、Infinity 都落回 0:00 —— 时间戳只该安静地回去', () => {
    expect(formatSongTime(-1)).toBe('0:00')
    expect(formatSongTime(Number.NaN)).toBe('0:00')
    expect(formatSongTime(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('progressFraction · 进度条的那一段', () => {
  it('正常比例', () => {
    expect(progressFraction(7.5, 30)).toBeCloseTo(0.25, 5)
    expect(progressFraction(15, 30)).toBe(0.5)
    expect(progressFraction(30, 30)).toBe(1)
  })

  it('超出时长夹回 1;负的已播夹回 0', () => {
    expect(progressFraction(31, 30)).toBe(1)
    expect(progressFraction(-2, 30)).toBe(0)
  })

  it('时长还没读到(0 / NaN)时返回 0 —— 不拿默认的 30 秒去猜', () => {
    expect(progressFraction(5, 0)).toBe(0)
    expect(progressFraction(5, Number.NaN)).toBe(0)
    expect(progressFraction(5, -30)).toBe(0)
  })

  it('已播不是数时返回 0', () => {
    expect(progressFraction(Number.NaN, 30)).toBe(0)
    expect(progressFraction(Number.POSITIVE_INFINITY, 30)).toBe(0)
  })
})
