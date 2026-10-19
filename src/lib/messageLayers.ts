/* ===== 消息心理层次（说 / 想 / 做）的纯判据 ============================
 *
 *  一条助手回复可以是三层之一：说出口的话(say)、没说出口的内心(think)、
 *  动作/旁白(act)。模型在一轮里用成对区域标记划段
 *  （`[think]…[/think]` / `[act]…[/act]`），`parseLayers` 把这一轮**扇出**成
 *  多条带 `layer` 的独立消息；其余文件按 `layer` 决定「给不给看、进不进
 *  模型的下一轮、进不进长期记忆」。
 *
 *  设计口径见 doc/消息表达形态-心理层次设计.md（脊柱 A/B 已定）：
 *  - A：think/act 走**消息级 layer**，不走 chatTags 那套行内值标签 —— 所以
 *    这个文件与 server/chatTags.js 那套 `[photo:]`/`[mood:]` **刻意无关**；
 *  - B：think **留短期上下文、只挡长期摘要**。
 *
 *  两条收口纪律（都靠纯函数一处判定，好测、别抄到第二处）：
 *  1. **展示 / 记忆 / 上下文三根杆各自独立**，谁也不回写谁 —— 关掉展示不等于
 *     删了事件；进不进长期记忆也不看展示开关；
 *  2. **拿不准一律保守**：判不出实质还是氛围的动作，按"实质"保留，宁可摘要
 *     冗余也不丢关键事件。
 *
 *  纯函数、无 IO、无 DOM —— 单独成文件就是为了测得了（与 moodDisplay / chatOrder
 *  同一种写法）。
 */

import type { MessageLayer } from '../types'

/** 区域标记：`[think]` / `[/think]` / `[act]` / `[/act]` / `[say]`，大小写不敏感。
 *  捕获组 1 = 是否带斜杠（闭合），组 2 = 层名。 */
const LAYER_TOKEN_RE = /\[(\/?)(think|act|say)\]/gi

const ALL_LAYERS: readonly MessageLayer[] = ['say', 'think', 'act']

/** 扇出后的一段：属于哪一层 + 剪干净的文字。 */
export interface LayerSegment {
  layer: MessageLayer
  text: string
}

/** 展示开关：think/act 各一个；say 恒可见，没有开关。 */
export interface LayerVisibilityPrefs {
  showThink: boolean
  showAct: boolean
}

/** 场景模式的显式事件（迟滞开关，见下）。 */
export type SceneEvent = 'act-emitted' | 'scene-boundary' | 'user-on' | 'user-off'

/** 一个"带 layer 字段的东西"。用 unknown 收 layer，让未 coerce 的脏值也走同一判据。 */
interface Layered {
  layer?: unknown
}

/** 合法值原样返回，非法/缺省返回 undefined（供载入收口 + effectiveLayer 兜底用）。 */
export function normalizeMessageLayer(value: unknown): MessageLayer | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.toLowerCase()
  return (ALL_LAYERS as readonly string[]).includes(v) ? (v as MessageLayer) : undefined
}

/** 一条消息**生效**的层次：缺省/非法一律按 'say' 处理（老消息整批读出来都是 say）。 */
export function effectiveLayer(m: Layered): MessageLayer {
  return normalizeMessageLayer(m.layer) ?? 'say'
}

/**
 * 把一轮原始回复（含区域标记）扇出成有序的多层段落。
 *
 * 单游标语义：遇到 `[think]`/`[act]` 把游标切到那一层，遇到 `[/…]` 或 `[say]`
 * 切回 say；**未闭合的开标记 = 到轮尾都算那一层**（模型忘了收尾时，宁多不可漏，
 * 且标记本身绝不外泄上屏）。标记两侧的文字归入当前游标。
 */
export function parseLayers(raw: string): LayerSegment[] {
  if (typeof raw !== 'string' || raw === '') return []

  const runs: LayerSegment[] = []
  const pushRun = (layer: MessageLayer, text: string): void => {
    if (text) runs.push({ layer, text })
  }

  let current: MessageLayer = 'say'
  let cursor = 0
  LAYER_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LAYER_TOKEN_RE.exec(raw)) !== null) {
    pushRun(current, raw.slice(cursor, m.index))
    const closing = m[1] === '/'
    const name = m[2].toLowerCase() as MessageLayer
    // say（含其闭合）与任何闭合标记都把游标拨回 say；开标记把游标拨到那一层
    current = (name === 'say' || closing) ? 'say' : name
    cursor = m.index + m[0].length
  }
  pushRun(current, raw.slice(cursor))

  // 归一：每段去首尾空白、丢空段，相邻同层合并
  const merged: LayerSegment[] = []
  for (const run of runs) {
    const text = run.text.trim()
    if (!text) continue
    const last = merged[merged.length - 1]
    if (last && last.layer === run.layer) last.text = `${last.text}\n${text}`
    else merged.push({ layer: run.layer, text })
  }
  return merged
}

/**
 * 这一轮正文里**有没有区域标记**（`[think]` / `[/think]` / `[act]` / `[/act]` / `[say]`）。
 *
 * 存在它的理由只有一个：让**没有分层的普通一轮走一条完全不动原样的路**。绝大多数回复
 * 一个标记都没有 —— 调用方（`useChatFlow` 的扇出、`ChatPage` 的显示裁剪）先问这一句，
 * 为假就原样把消息当单条 `say` 处理，一个字节都不改；为真才进 `parseLayers` 那一路。
 * 少了这道闸，`parseLayers` 的 trim / 合并会悄悄改掉每条普通回复的首尾空白。
 *
 * `LAYER_TOKEN_RE` 带 `/g`，`.test` 会推进 `lastIndex` —— 每次调用前先归零，否则两次
 * 相邻调用会在上一条命中处的后半段接着找，判断就飘了。
 */
export function hasLayerMarkers(raw: string): boolean {
  if (typeof raw !== 'string' || raw === '') return false
  LAYER_TOKEN_RE.lastIndex = 0
  return LAYER_TOKEN_RE.test(raw)
}

/** 这一轮的扇出里**有没有 act** —— 用来触发场景进入（`act-emitted`）。 */
export function detectActEmitted(segments: LayerSegment[]): boolean {
  return segments.some((s) => s.layer === 'act')
}

/**
 * 界面可见性：只认展示开关，与"进不进记忆/上下文"无关（关展示 ≠ 删事件）。
 * say 恒可见；think 看 showThink；act 看 showAct。
 */
export function isVisibleForUI(m: Layered, prefs: LayerVisibilityPrefs): boolean {
  switch (effectiveLayer(m)) {
    case 'think':
      return prefs.showThink
    case 'act':
      return prefs.showAct
    case 'say':
    default:
      return true
  }
}

/**
 * 进不进「喂模型的下一轮短期上下文」（B 已定）：
 * 三层都保留 —— 角色记得到场发生过的动作，也记得自己上一轮想过什么（很自然）。
 * 单列一处是为了把这个决定写死、且将来要"更克制连 think 一起剥"时只改这里：
 *   `return effectiveLayer(_m) !== 'think'`
 */
export function keepInModelHistory(_m: Layered): boolean {
  return true
}

/** act 里指向**用户**的人称 —— 她/他/我 只是角色自己的主语，不算互动，故不列。 */
const ACT_INTERACT = /你|您|对方/
/** 处置 / 传递 / 朝用户方向的动作动词 —— 命中即是与对方共享的实质事件。 */
const ACT_DIRECTED = /递|给|抱|牵|拉|推|送|接|打开|关|拿|放下|塞|吻|握|挡|护|亲|凑|靠近|迎|盯|指|摸|拽|扯|披|擦/

/**
 * 保守启发式：一条 act 是不是**纯氛围**（短、无对象、不指向用户、无处置/朝向动词）。
 * 判得准的才敢丢；拿不准一律算实质。默认**不启用**于 keepInSummary（见下）。
 */
export function isAtmosphereAct(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (ACT_INTERACT.test(t)) return false
  if (ACT_DIRECTED.test(t)) return false
  return t.length <= 12
}

/**
 * 进不进**长期摘要**（chat_summaries）：
 * - say：进（事实 / 承诺）；
 * - think：**不进**（主观内心不固化成事实，读心/引用风险）—— 这是核心护栏；
 * - act：默认**进**（共享事件，ta 不能对自己的行动失忆）；只有显式开了
 *   `dropAtmosphereActs` 才把纯氛围动作滤掉，保守默认不冒丢关键事件的风险。
 */
export function keepInSummary(m: Layered, opts?: { dropAtmosphereActs?: boolean; text?: string }): boolean {
  switch (effectiveLayer(m)) {
    case 'think':
      return false
    case 'act':
      if (opts?.dropAtmosphereActs && isAtmosphereAct(opts.text ?? '')) return false
      return true
    case 'say':
    default:
      return true
  }
}

/**
 * 场景模式的迟滞开关：进场景靠"首个 act"，但**不**因后续没旁白就灭；
 * 只在明确的场景边界或用户显式操作时离开。只在这四个事件上变化，其余轮次
 * 不动它 —— 这正是"信号灯跟着状态走、不跟着标签频率闪"的落点。
 */
export function nextSceneMode(prev: boolean, ev: SceneEvent): boolean {
  switch (ev) {
    case 'act-emitted':
    case 'user-on':
      return true
    case 'scene-boundary':
    case 'user-off':
      return false
    default:
      return prev
  }
}

/** 场景模式才放行 act 的**产出**（展示与否是另一根杆，见 isVisibleForUI）。 */
export function actAllowedForProduction(sceneMode: boolean): boolean {
  return !!sceneMode
}
