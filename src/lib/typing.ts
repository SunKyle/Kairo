/* ===== 打字节奏 ========================================================
 *  上游吐字是**匀速**的:一个字一个字,该停的地方也照吐不误。
 *  而真人打字不是匀速的 —— 句末会停一下,想事情会停一下。
 *  匀速正是"机器感"最直接的来源,而它跟内容一个字都不差。
 *
 *  所以这一层只做一件事:**在标点后面压一小段再放**。
 *  它不是"把速度调成人的打字速度" —— 那要慢十倍(真人中文一秒也就两三个字),
 *  八十个字的一句话要打半分钟,那不叫像人,那叫坏掉。
 *
 *  四条纪律,少一条都会变成"为了氛围罚用户的时间":
 *  1. **只延后,不加速**。上游快就压一压,上游本来就慢就跟着走;
 *  2. **总延迟封顶**(BUDGET_MS)。一条回复最多多等这么多,超了就一路放行 ——
 *     节奏是锦上添花,不该把"等它说完"变长;
 *  3. **没有标点就整段立刻放出**。卡在半句话上等着不像人,像卡了;
 *  4. **抖动由 id 决定,不用随机数**。同一个 id 重播一致、可断言;
 *     随机数会让"重生成"每次节奏都不同 —— 那是测试的敌人,也没有任何好处。
 *
 *  它是个纯状态机:**不碰计时器、不碰 DOM、不读时钟**。
 *  什么时候再问一次由调用方拿着返回的 `wait` 去决定 ——
 *  这样整个节奏可以在一秒钟里被断言完,而不是靠 sleep 去试。
 * ==================================================================== */

/** 一段回复上最多多等多久。超了就一路放行(见纪律 2) */
export const PACE_BUDGET_MS = 1200
/** 单次停顿的上限。换行那一档本来最长,给它留够,但也别让一处停顿吃掉整个预算 */
export const MAX_PAUSE_MS = 400

/** 句末:停一下,像把这句话说完 */
const SENTENCE = '。！？!?…'
/** 句中:停得更短,像换口气 */
const SOFT = '，、；：,;:'
/** 跟在这些后面的收尾符号要**一起**放出去 —— 否则 `"` 会在停顿之后孤零零地冒出来 */
const CLOSERS = '」』”’"\'）)】]》〉'

/** 句末 / 换行 / 句中的基准停顿 */
const BASE_SENTENCE = 150
const BASE_NEWLINE = 260
const BASE_SOFT = 80

/** 一个小小的字符串哈希。只为了"同一个 id 每次抖动一样",不用于任何安全用途 */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 抖动系数 0.7~1.3。同一个 (seed, 位置) 永远得到同一个系数 */
function jitter(seed: string, at: number): number {
  const h = hash(`${seed}:${at}`)
  return 0.7 + ((h % 61) / 60) * 0.6
}

function basePause(ch: string): number {
  if (ch === '\n') return BASE_NEWLINE
  if (SENTENCE.includes(ch)) return BASE_SENTENCE
  if (SOFT.includes(ch)) return BASE_SOFT
  return 0
}

/**
 * 这一刻能从 `buf` 开头放出去多长,以及放完之后该等多久。
 *
 * **不是**"找到最后一个标点":要放的是**第一个**停顿点之前的那一小段 ——
 * 一次放一句,后面那些留着下一轮再放,节奏才落得下来。
 * 整段一次性放出去等于节奏器不存在(那是它最容易写错的方式)。
 *
 * @param budget 这条回复还剩多少"多等"的额度。用完了就返回 wait=0(一路放行)
 */
export function nextChunk(buf: string, seed: string, budget: number): { take: number; wait: number } {
  if (!buf) return { take: 0, wait: 0 }

  let at = -1
  for (let i = 0; i < buf.length; i++) {
    if (basePause(buf[i]) > 0) {
      at = i
      break
    }
  }
  /* 这一段里一个停顿点都没有(模型刚吐了半个词):整段放出去,
     等下一批来了再说。**不能扣着** —— 那会变成"卡住了" */
  if (at < 0) return { take: buf.length, wait: 0 }

  let take = at + 1
  // 紧跟着的收尾符号一起放,别让引号在停顿后孤零零地冒出来
  while (take < buf.length && CLOSERS.includes(buf[take])) take++

  /* 标点正好落在末尾:后面还没字。这时候等也没意义(没有东西可等),
     等下一批来了再按它自己带的停顿走 */
  if (take >= buf.length) return { take, wait: 0 }

  const want = Math.min(MAX_PAUSE_MS, basePause(buf[at]) * jitter(seed, at))
  const wait = Math.max(0, Math.min(want, budget))
  return { take, wait: Math.round(wait) }
}

/**
 * 节奏器。`push` 进、`take` 出,`flush` 全放。
 *
 * 调用方的驱动方式(见 App.vue 的 runChat):
 * ```
 * pacer.push(delta)
 * const { text, wait } = pacer.take()
 * 把 text 贴到气泡上
 * wait > 0  → 等 wait 毫秒再问一次
 * wait === 0 → 这一批放完了,等下一次 push(若还有 pending,立刻再 take)
 * ```
 */
export class Pacer {
  private buf = ''
  private budget: number
  private readonly seed: string

  constructor(seed: string, budget = PACE_BUDGET_MS) {
    this.seed = seed
    this.budget = budget
  }

  /** 还没放出去的字数。界面不用它,探针与单测用它 */
  get pending(): number {
    return this.buf.length
  }

  /** 还剩多少"多等"的额度 */
  get left(): number {
    return this.budget
  }

  push(delta: string): void {
    if (delta) this.buf += delta
  }

  /**
   * 放出这一刻该放出的那一段。
   * 保证**有进展**:buf 非空时一定返回至少一个字(除非调用方拿它当查询用)。
   */
  take(): { text: string; wait: number } {
    const { take, wait } = nextChunk(this.buf, this.seed, this.budget)
    if (take <= 0) return { text: '', wait: 0 }
    const text = this.buf.slice(0, take)
    this.buf = this.buf.slice(take)
    /* 额度按"实际多等的时间"扣。扣的是**打算等多久**而不是等完之后的真实耗时 ——
       真实耗时里混着上游自己的间隔,那是它本来就有的,不该算在我们头上 */
    this.budget = Math.max(0, this.budget - wait)
    return { text, wait }
  }

  /**
   * 把手里剩下的**全部**放出来,并清空额度。
   *
   * 三处必须调:用户按 Stop、这一轮收尾(马上要落盘了,再扣着就写不全)、
   * 页面被切走(没人在看的时候攒着毫无意义)。幂等。
   */
  flush(): string {
    const rest = this.buf
    this.buf = ''
    this.budget = 0
    return rest
  }
}
