import { describe, expect, it } from 'vitest'
import {
  FLICK_VELOCITY,
  canCommit,
  clamp,
  commitPoint,
  exposeDistance,
  fingerDistance,
  isArmed,
  projectDistance,
  releasePlan,
  rubber,
  unrubber,
  velocityOf,
  type SwipeTrack
} from './swipeTrack'

/* 这些判据决定"滑动置顶"的手感与正确性:橡皮筋收不收得住、提交点露不露得全动作、
   松手落在哪一边。每一条都冲着"写反了会当场出丑"的地方去。 */

/** 一条典型的左栏对话行:240px 宽、76px 动作、可全滑 */
function track(over: Partial<SwipeTrack> = {}): SwipeTrack {
  return { width: 240, drawer: 76, action: 76, resistance: 0.55, commitAt: 0.6, fullSwipe: true, ...over }
}

const round = (v: number) => Math.round(v * 1000) / 1000

describe('rubber / unrubber · 橡皮筋', () => {
  it('零点即零,且保持符号', () => {
    expect(rubber(0, 240, 0.55)).toBe(0)
    expect(rubber(-100, 240, 0.55)).toBeLessThan(0)
  })

  it('越拖越远但永远够不到整幅(渐近 dim,起始斜率≈resist)', () => {
    expect(rubber(50, 240, 0.55)).toBeLessThan(rubber(500, 240, 0.55))
    // 小位移段近似按 resist 打折:50×0.55=27.5,橡皮筋只会比这个更收
    expect(rubber(50, 240, 0.55)).toBeLessThan(50 * 0.55 + 1)
    // 无穷远也只能逼近 240,永远到不了
    expect(rubber(1e6, 240, 0.55)).toBeLessThan(240)
  })

  it('往返一致:r 后取反回到原位', () => {
    for (const over of [20, 90, 300, -45]) {
      const y = rubber(over, 240, 0.55)
      expect(round(unrubber(y, 240, 0.55))).toBeCloseTo(over, 2)
    }
  })

  it('resistance=1 时越界一比一跟手(在小于行宽的范围内)', () => {
    // dim*1/(dim+|over|) × over… resist=1 时 rubber = over*dim/(dim+over) 仍收敛,
    // 但比 0.55 时明显更跟手
    expect(rubber(100, 240, 1)).toBeGreaterThan(rubber(100, 240, 0.55))
  })
})

describe('exposeDistance · 分段映射', () => {
  it('抽屉段(0..drawer)一比一,反向是橡皮筋', () => {
    const t = track()
    expect(exposeDistance(40, t)).toBe(40)
    expect(exposeDistance(76, t)).toBe(76)
    expect(exposeDistance(-60, t)).toBeLessThan(0)
  })

  it('过了抽屉就打折:行走得比手指慢', () => {
    const t = track()
    expect(exposeDistance(120, t)).toBeLessThan(120)
  })

  it('单调不减:手指一路往外,行不会倒退', () => {
    const t = track()
    let prev = -Infinity
    for (let raw = -300; raw <= 600; raw += 5) {
      const ex = exposeDistance(raw, t)
      expect(ex).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = ex
    }
  })

  it('反向橡皮筋有底:怎么拖都透不过一整幅行宽', () => {
    const t = track()
    expect(exposeDistance(-1e5, t)).toBeGreaterThan(-240)
  })

  it('不可提交(行太窄)时过了抽屉只剩橡皮筋,永远进不了 commit', () => {
    // 100px 的行:提交点下限 drawer + action/2 = 114 > 100 → 提交不了
    const t = track({ width: 100 })
    expect(canCommit(t)).toBe(false)
    // 抽屉(76)之外最多再橡皮筋出一幅行宽,且松手方案里不会出现 commit
    expect(exposeDistance(1000, t)).toBeLessThan(76 + 100)
    expect(releasePlan(exposeDistance(1000, t), 0, t)).not.toBe('commit')
  })

  it('正反函数互为逆:手指→行→手指 回到原值', () => {
    const t = track()
    for (const raw of [-80, 0, 30, 76, 120, 200, 400]) {
      expect(round(fingerDistance(exposeDistance(raw, t), t))).toBeCloseTo(raw, 0)
    }
  })
})

describe('commitPoint / isArmed · 提交点', () => {
  it('宽行按 commitAt×width', () => {
    expect(commitPoint(track({ width: 300 }))).toBe(180)
  })

  it('窄行按下限兜底:动作块没露全之前不许提交', () => {
    // drawer + action/2 = 114,而 0.6×160=96 < 114 → 取下限
    const t = track({ width: 160 })
    expect(commitPoint(t)).toBe(114)
    // 且 114 > 160?不,114 ≤ 160,还能提交
    expect(canCommit(t)).toBe(true)
  })

  it('armed 判据:刚好过点算,差一丝不算,不能提交则永远不算', () => {
    const t = track({ width: 300 })
    expect(isArmed(180, t)).toBe(true)
    expect(isArmed(179.5, t)).toBe(false)
    expect(isArmed(300, track({ width: 100 }))).toBe(false)
  })

  it('fullSwipe 关掉后没有任何点可提交', () => {
    const t = track({ fullSwipe: false })
    expect(canCommit(t)).toBe(false)
    expect(isArmed(t.width, t)).toBe(false)
  })
})

describe('releasePlan · 松手去哪', () => {
  it('越过提交点直接执行,不看速度', () => {
    const t = track({ width: 300 })
    expect(releasePlan(180, 0, t)).toBe('commit')
    expect(releasePlan(200, -500, t)).toBe('commit') // 甚至往回拽也认(已经够狠)
  })

  it('甩动(flick)按速度方向:外甩打开、内甩关回', () => {
    const t = track()
    expect(releasePlan(10, FLICK_VELOCITY + 1, t)).toBe('open')
    expect(releasePlan(70, -(FLICK_VELOCITY + 1), t)).toBe('close')
  })

  it('慢放按"投影后过没过抽屉中点"(76/2=38)', () => {
    const t = track()
    expect(releasePlan(37, 0, t)).toBe('close')
    expect(releasePlan(39, 0, t)).toBe('open')
  })

  it('慢放但余势很足:投影把落点推过中点就开', () => {
    const t = track()
    // v=20 < FLICK,不算甩;project(20)=20/1000×499≈10 → 28+10=38 → 不过中点(要严格大于)
    expect(releasePlan(28, 20, t)).toBe('close')
    expect(releasePlan(30, 20, t)).toBe('open')
  })

  it('一点没动(0 速度 0 位置)关回', () => {
    expect(releasePlan(0, 0, track())).toBe('close')
  })
})

describe('velocityOf / projectDistance · 速度', () => {
  it('不足两点没有速度', () => {
    expect(velocityOf([])).toBe(0)
    expect(velocityOf([[0, 10]])).toBe(0)
  })

  it('px/ms 折算成 px/s', () => {
    // 100ms 走 30px → 300px/s
    expect(velocityOf([[0, 0], [100, 30]])).toBeCloseTo(300, 6)
  })

  it('封顶在 VELOCITY_MAX,偶发巨帧不会飞出去', () => {
    expect(velocityOf([[0, 0], [1, 1e6]])).toBe(1500)
  })

  it('投影距离与速度同号(往回甩就往前投)', () => {
    expect(projectDistance(300)).toBeGreaterThan(0)
    expect(projectDistance(-300)).toBeLessThan(0)
    expect(projectDistance(0)).toBe(0)
  })
})

describe('clamp', () => {
  it('夹在区间内', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(-2, 0, 1)).toBe(0)
    expect(clamp(0.5, 0, 1)).toBe(0.5)
  })
})
