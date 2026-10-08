import { describe, expect, it } from 'vitest'
import { MAX_PAUSE_MS, PACE_BUDGET_MS, Pacer, nextChunk } from './typing'

/* 节奏器是**表现层**:它唯一不能犯的错是**把字弄丢或弄乱**。
   所以第一组用例全在证明"放出来的东西和收到的逐字相等",
   节奏本身反而是第二位的 —— 一个会丢字的节奏器比没有节奏器糟得多,
   而丢字的症状只在长回复里偶发(那时谁也不会怀疑是节奏器)。 */

/** 把闸门一路走完(不真的等),返回放出来的文本。
 *  节奏只决定"什么时候",不决定"什么",所以这么走是合法的 */
function drain(p: Pacer): string {
  let out = ''
  for (let guard = 0; guard < 5000; guard++) {
    const { text } = p.take()
    out += text
    if (p.pending === 0) return out
  }
  throw new Error('没有收敛 —— take() 卡住了')
}

/** 极小的分片:节奏的 bug 只在增量的边界上出现(与标签扣尾同一个道理) */
function tiny(s: string, size = 3): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

describe('一个字都不能丢', () => {
  const LONG =
    '今天去了趟海边。风很大,浪打在礁石上,溅了我一身。' +
    '回来的路上买了个面包。\n明天大概还会下雨。你呢?'

  it('分片流进来、一路放完 —— 与输入逐字相等', () => {
    const p = new Pacer('m1')
    let out = ''
    for (const c of tiny(LONG)) {
      p.push(c)
      out += drain(p)
    }
    out += p.flush()
    expect(out).toBe(LONG)
  })

  it('中途按 Stop(flush):已放出的 + 剩下的,仍然逐字相等', () => {
    const p = new Pacer('m2')
    p.push(LONG)
    const head = p.take().text
    const rest = p.flush()
    expect(head + rest).toBe(LONG)
    // flush 之后手里是空的,而且再 take 也只是空
    expect(p.pending).toBe(0)
    expect(p.take()).toEqual({ text: '', wait: 0 })
  })

  it('flush 幂等', () => {
    const p = new Pacer('m3')
    p.push('你好。')
    p.flush()
    expect(p.flush()).toBe('')
  })

  it('放出的永远是收到的**前缀**,不会多也不会乱序', () => {
    const p = new Pacer('m4')
    let seen = ''
    let released = ''
    for (const c of tiny(LONG, 5)) {
      seen += c
      p.push(c)
      const { text } = p.take()
      released += text
      expect(seen.startsWith(released)).toBe(true)
      expect(released.length).toBeLessThanOrEqual(seen.length)
    }
  })
})

describe('节奏落在标点上', () => {
  it('一次只放一句(不是"找到最后一个标点"整段放出去)', () => {
    const p = new Pacer('m5')
    p.push('第一句。第二句。第三句。')
    const a = p.take()
    expect(a.text).toBe('第一句。')
    expect(a.wait).toBeGreaterThan(0)
    expect(p.pending).toBeGreaterThan(0)
    const b = p.take()
    expect(b.text).toBe('第二句。')
  })

  it('段里没有标点时整段立刻放出 —— 扣着会像卡住', () => {
    const p = new Pacer('m6')
    p.push('还没有标点的一段话')
    expect(p.take()).toEqual({ text: '还没有标点的一段话', wait: 0 })
  })

  it('标点正好落在末尾时不等(后面还没字,等也没意义)', () => {
    const p = new Pacer('m7')
    p.push('说完了。')
    expect(p.take()).toEqual({ text: '说完了。', wait: 0 })
  })

  it('收尾符号跟着标点一起放 —— 别让引号孤零零地冒出来', () => {
    const p = new Pacer('m8')
    p.push('他说「走吧。」然后就起身了')
    const { text } = p.take()
    expect(text).toBe('他说「走吧。」')
  })

  it('句末比句中停得久,换行最久', () => {
    const seed = 'm9'
    const soft = nextChunk('嗯,好的', seed, PACE_BUDGET_MS).wait
    const hard = nextChunk('嗯。好的', seed, PACE_BUDGET_MS).wait
    const brk = nextChunk('嗯\n好的', seed, PACE_BUDGET_MS).wait
    expect(soft).toBeGreaterThan(0)
    expect(hard).toBeGreaterThan(soft)
    expect(brk).toBeGreaterThan(hard)
  })

  it('单次停顿有上限', () => {
    // 连着给一堆换行,每一处都不该跑飞
    for (let i = 0; i < 20; i++) {
      const w = nextChunk('\n' + 'x'.repeat(5), 'seed' + i, PACE_BUDGET_MS).wait
      expect(w).toBeLessThanOrEqual(MAX_PAUSE_MS)
    }
  })
})

describe('总延迟封顶', () => {
  it('一整段多句的回复,多等的总和不超过预算', () => {
    const many = '好。'.repeat(60) + 'end'
    const p = new Pacer('m10')
    p.push(many)
    let waited = 0
    let out = ''
    for (let i = 0; i < 500 && p.pending > 0; i++) {
      const { text, wait } = p.take()
      out += text
      waited += wait
    }
    expect(out).toBe(many)
    expect(waited).toBeLessThanOrEqual(PACE_BUDGET_MS)
  })

  it('额度用完就一路放行,不再压', () => {
    const p = new Pacer('m11', 150)
    p.push('一。二。三。四。五。六。')
    let waited = 0
    for (let i = 0; i < 500 && p.pending > 0; i++) waited += p.take().wait
    expect(waited).toBeLessThanOrEqual(150)
    expect(p.left).toBe(0)
  })
})

describe('抖动跟着 id 走,不用随机数', () => {
  const text = '第一句。第二句。第三句。第四句。'

  function waits(seed: string): number[] {
    const p = new Pacer(seed)
    p.push(text)
    const out: number[] = []
    for (let i = 0; i < 100 && p.pending > 0; i++) out.push(p.take().wait)
    return out
  }

  it('同一个 id 两次得到同一套节奏(重播一致、可断言)', () => {
    expect(waits('same')).toEqual(waits('same'))
  })

  it('不同的 id 节奏不同 —— 否则每条回复的停顿都像节拍器', () => {
    expect(waits('a')).not.toEqual(waits('b'))
  })
})

describe('按调用方的驱动协议跑一遍', () => {
  /* 单元测到上一组为止,测的都是"单项算得对"。
     真正会出 bug 的地方在**协议**上:wait=0 时该不该接着问、
     上游还在推的时候定时器该不该重排、以及最要命的 ——
     收尾那一刻手里还有没有没放出去的字(有就落盘落成半句)。
     所以这一组把协议当成一个整体来跑:上游按固定间隔推片,
     定时器按返回的 wait 唤醒,两条时间线交错推进。 */
  const LONG =
    '今天去了趟海边。风很大,浪打在礁石上。\n回来的路上买了个面包,还挺好吃。你呢?'

  it('交错推进:一字不丢,多等的总和也不超预算', () => {
    const p = new Pacer('wire')
    const chunks = tiny(LONG, 3)
    const GAP = 10 // 上游每 10ms 推 3 个字
    let out = ''
    let totalWait = 0
    let elapsed = 0
    let timerAt = Infinity
    let i = 0

    const pump = () => {
      const { text, wait } = p.take()
      out += text
      if (wait > 0) {
        totalWait += wait
        timerAt = elapsed + wait
      } else if (p.pending > 0) {
        timerAt = elapsed // 还有剩,下一拍接着放
      } else {
        timerAt = Infinity // 放干净了,等上游
      }
    }

    for (let step = 0; step < 10000; step++) {
      const pushAt = i < chunks.length ? i * GAP : Infinity
      if (pushAt === Infinity && timerAt === Infinity) break
      if (pushAt <= timerAt) {
        elapsed = pushAt
        p.push(chunks[i++])
        if (timerAt === Infinity) pump()
      } else {
        elapsed = timerAt
        pump()
      }
    }
    out += p.flush()

    expect(out).toBe(LONG)
    expect(totalWait).toBeLessThanOrEqual(PACE_BUDGET_MS)
  })

  it('上游推完时手里可能还扣着字 —— 收尾必须冲出来(否则落盘落成半句)', () => {
    const p = new Pacer('wire2')
    p.push('第一句。') // 标点收尾:take 会整段放掉
    p.take()
    p.push('第二句。第三句。')
    p.take() // 只放得出"第二句。",第三句还扣着
    expect(p.pending).toBeGreaterThan(0)
    const rest = p.flush()
    expect(rest).toBe('第三句。')
  })
})
