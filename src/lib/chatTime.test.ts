import { describe, expect, it } from 'vitest'
import { agoLabel, localStamp, timeContext } from '../../server/chatTime.js'

/* 这一块的每一条判据都冲着同一件事:**说出去的时间必须是真的。**
   角色一旦报错时间(星期几不对、说"负三天前"、报一个不存在的日期),
   用户立刻就知道对面是个在念表的程序 —— 而这一整块存在的理由正是反过来。
   所以下面按"哪一句可能变成假话"来分组,不是按函数分组。 */

/** 建一个本地时刻的戳。用本地构造再交给 localStamp,
 *  所以断言与运行这台机器的时区无关 */
function stamp(y: number, mo: number, d: number, hh: number, mi: number, ss = 0) {
  return localStamp(new Date(y, mo - 1, d, hh, mi, ss))
}

describe('localStamp', () => {
  it('是本地时刻,不是 UTC —— 而且带偏移', () => {
    const s = stamp(2026, 10, 5, 23, 41, 7)
    // 前缀就是眼前的钟。用 toISOString() 会得到 15:41(UTC),那是错的
    expect(s.startsWith('2026-10-05T23:41:07')).toBe(true)
    // 偏移必须是 ±HH:MM(东八区 +08:00),没有它"现在几点"就无从谈起
    expect(s).toMatch(/^2026-10-05T23:41:07[+-]\d{2}:\d{2}$/)
  })

  it('跨月、跨年不丢前导零', () => {
    expect(stamp(2026, 1, 1, 0, 5, 9).startsWith('2026-01-01T00:05:09')).toBe(true)
  })

  it('自己生成的戳一定认得出(两端同一份实现,不该有对不上的形状)', () => {
    const s = localStamp(new Date())
    expect(timeContext({ nowLocal: s })).not.toBe('')
  })
})

describe('timeContext 的当前时间那一行', () => {
  it('星期几是真的', () => {
    // 2026-10-05 是星期一(拿 UTC 算的,与运行机器的时区无关)
    expect(timeContext({ nowLocal: stamp(2026, 10, 5, 23, 41) })).toContain('Monday')
    expect(timeContext({ nowLocal: stamp(2026, 10, 11, 9, 0) })).toContain('Sunday')
  })

  it('只到分钟 —— 秒是机器的时间', () => {
    const s = timeContext({ nowLocal: stamp(2026, 10, 5, 23, 41, 7) })
    expect(s).toContain('2026-10-05 23:41')
    expect(s).not.toContain('23:41:07')
  })

  it('一次都没聊过时,只有这一行', () => {
    const s = timeContext({ nowLocal: stamp(2026, 10, 5, 23, 41) })
    expect(s).not.toContain('last spoke')
  })

  /* 2026-10-08:这一行必须点明它只是**现实世界**的钟 —— 剧情有自己的时间,
     而用户报的毛病("已经过去的事又被说成等会要做")有一半就出在这两个钟没分开上 */
  it('标明那个钟是现实世界的，剧情时间另有出处', () => {
    const s = timeContext({ nowLocal: stamp(2026, 10, 5, 23, 41) })
    expect(s).toContain('real world only')
    expect(s).toContain('the story may be at another time')
  })
})

describe('"上次说话"那一行', () => {
  const now = stamp(2026, 10, 5, 23, 41)
  const base = Date.parse(now)
  const ago = (ms: number) => timeContext({ nowLocal: now, lastAt: base - ms })

  it('同一口气里连着说的不报', () => {
    expect(ago(30 * 1000)).not.toContain('last spoke')
    // 2 分钟是那条线本身,正好卡在线上
    expect(ago(2 * 60 * 1000 - 1)).not.toContain('last spoke')
  })

  it('分钟 / 小时 / 天各自成立,且单数复数不写错', () => {
    expect(ago(25 * 60 * 1000)).toContain('25 minutes ago')
    expect(ago(60 * 60 * 1000)).toContain('1 hour ago')
    expect(ago(90 * 60 * 1000)).toContain('1 hour ago')
    expect(ago(5 * 60 * 60 * 1000)).toContain('5 hours ago')
    expect(ago(24 * 60 * 60 * 1000)).toContain('1 day ago')
    expect(ago(3 * 24 * 60 * 60 * 1000)).toContain('3 days ago')
  })

  it('太久没见就不报 —— "两个月前"只会换来一句尴尬的寒暄', () => {
    expect(ago(30 * 24 * 60 * 60 * 1000)).toContain('30 days ago')
    expect(ago(31 * 24 * 60 * 60 * 1000)).not.toContain('last spoke')
  })

  it('未来时间不报 —— 宁可少一句,也不能让它说"负三天前"', () => {
    expect(timeContext({ nowLocal: now, lastAt: base + 60_000 })).not.toContain('last spoke')
  })

  it('坏时间戳一律不报', () => {
    for (const bad of [0, -1, NaN, Infinity, 'abc', null, undefined, {}]) {
      expect(timeContext({ nowLocal: now, lastAt: bad as never })).not.toContain('last spoke')
    }
  })

  it('两行都有的完整形状', () => {
    expect(timeContext({ nowLocal: now, lastAt: base - 3 * 24 * 60 * 60 * 1000 })).toBe(
      "Right now: 2026-10-05 23:41, Monday (the user's local clock, real world only — the story may be at another time).\nYou two last spoke 3 days ago."
    )
  })
})

describe('认不出来就整块丢掉', () => {
  it('形状不对的一律空串(不留 "Right now: " 的空壳)', () => {
    const bad = [
      '', 'now', '2026-10-05', '2026-10-05 23:41',
      '2026-10-05T23:41', // 没有偏移 —— 那就不是"某地的此刻"
      '2026-10-05T23:41:00', 'today', 0, null, undefined, {}
    ]
    for (const v of bad) expect(timeContext({ nowLocal: v as never })).toBe('')
  })

  it('不存在的日期不认 —— 报一个假的日期比不报糟', () => {
    expect(timeContext({ nowLocal: '2026-02-31T10:00:00+08:00' })).toBe('')
    expect(timeContext({ nowLocal: '2026-13-01T10:00:00+08:00' })).toBe('')
    expect(timeContext({ nowLocal: '2026-10-05T25:00:00+08:00' })).toBe('')
    expect(timeContext({ nowLocal: '2026-10-05T10:61:00+08:00' })).toBe('')
  })

  it('二月二十九:平年不认,闰年认', () => {
    expect(timeContext({ nowLocal: '2026-02-29T10:00:00+08:00' })).toBe('')
    expect(timeContext({ nowLocal: '2028-02-29T10:00:00+08:00' })).toContain('2028-02-29')
  })

  it('带坏的偏移不认 —— NaN 会让那句变成 "last spoke NaN days ago"', () => {
    expect(timeContext({ nowLocal: '2026-10-05T23:41:00+99:99', lastAt: 1 })).toBe('')
  })

  it('Z 不收:没有偏移就说不清是哪个时区的 23:41,而这一块宁可没有', () => {
    expect(timeContext({ nowLocal: '2026-10-05T23:41:07Z' })).toBe('')
  })
})

/* 这一句**两端共用**:服务端拼 "You two last spoke 3 days ago.",
   界面在消息流末尾显示 "Last spoke 3 days ago"。
   同一个事实在两处被说成两样,用户会以为它们在讲两件事 —— 所以边界只有一份 */
describe('agoLabel(两端共用的那一句)', () => {
  const MIN = 60 * 1000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it('两分钟以内不报 —— 同一口气里连着说的不算"上次"', () => {
    expect(agoLabel(0)).toBe('')
    expect(agoLabel(30 * 1000)).toBe('')
    expect(agoLabel(2 * MIN - 1)).toBe('')
    expect(agoLabel(2 * MIN)).toBe('2 minutes ago')
  })

  it('未来与坏值不报', () => {
    for (const bad of [-1, -DAY, NaN, Infinity, -Infinity, 'abc', null, undefined]) {
      expect(agoLabel(bad as never)).toBe('')
    }
  })

  it('分钟 / 小时 / 天,单复数都对', () => {
    expect(agoLabel(25 * MIN)).toBe('25 minutes ago')
    expect(agoLabel(60 * MIN)).toBe('1 hour ago')
    expect(agoLabel(90 * MIN)).toBe('1 hour ago')
    expect(agoLabel(5 * HOUR)).toBe('5 hours ago')
    expect(agoLabel(DAY)).toBe('1 day ago')
    expect(agoLabel(3 * DAY)).toBe('3 days ago')
  })

  it('默认不报超过 30 天的(提示词用:开口就提"两个月前"只会换来尴尬)', () => {
    expect(agoLabel(30 * DAY)).toBe('30 days ago')
    expect(agoLabel(31 * DAY)).toBe('')
  })

  it('long = true 时不设上限,而且粒度变粗(界面用)', () => {
    expect(agoLabel(31 * DAY, { long: true })).toBe('31 days ago')
    expect(agoLabel(60 * DAY, { long: true })).toBe('2 months ago')
    expect(agoLabel(365 * DAY, { long: true })).toBe('1 year ago')
    expect(agoLabel(800 * DAY, { long: true })).toBe('2 years ago')
  })

  it('提示词那一句就是它拼出来的(两处不可能各说各的)', () => {
    const now = localStamp(new Date(2026, 9, 5, 23, 41))
    const base = Date.parse(now)
    expect(timeContext({ nowLocal: now, lastAt: base - 3 * DAY })).toContain(agoLabel(3 * DAY))
  })
})
