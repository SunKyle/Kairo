import type { RelationshipState } from '../types'
import { REL_MAX } from '../types'

/* REL_MAX 定在 types.ts(它是刻度上限,属于数据形状本身)。这里再转出口一次,
   是为了让"用这套关系逻辑的人"从一个地方就能拿到刻度边界,不必知道它住在 types 里 */
export { REL_MAX }

/* ===== 关系的纯逻辑(PRD §3.2-C)=====================================
   这一层不碰界面、不碰模型、不落盘 —— 它只回答四个问题:
   ① 盘上读回来的一条关系怎么收成合法形状(coerceRelationship);
   ② 模型吐回来的那几行怎么读成三个轴的增减(parseRelationshipDelta);
   ③ 一次评估怎么把 Δ 落到分值上、并守住几条硬规矩(applyEvaluation);
   ④ 分值怎么摊成注入 system 的几行指令(relationshipLines),以及
      怎么摊成给用户看的档位(relationshipStage)。

   抽出来单独成文件的理由,与 memory.ts / staleViews.ts 完全一样:
   §3.2-C 的验收靠的是几条**产品不变量**——"不因缺席扣减""受有意义互动
   影响而非消息数""刚认识不会突然掏心掏肺"——而这些都必须能被构造数据
   直接断言,而不是靠"聊两句看看感觉对不对"来验。它们钉死在这里。

   —— 三条硬规矩(都在 applyEvaluation / coerce 里收口,并有单测)——

   1. **结构约束**:亲近 ≤ 信任 ≤ 熟悉。熟悉是攒出来的地基,亲近是最贵的那一格;
      挡的是"聊得多就自动变亲密"那种懒惰推断,也挡模型把 affection 单独拉高。
   2. **一次不跨两档**:单次评估再大,档位最多升一格。跳档会让关系"一天一个样",
      而"我们一起慢慢熟起来"这件事的分量,正在于它是一格一格走的。
   3. **缺席不降**:这一层根本没有"按时间衰减"的入口——你没来,分值就冻在原处。
      能降的只有模型明确写下来的负 Δ(而且封在 DELTA_MIN)。
   -------------------------------------------------------------------- */

/** 对用户的三档可见刻度:分值 <34 是 0 档,34–66 是 1 档,≥67 是 2 档。
 *  阈值取三等分附近,好记、也够让一次 +8 不至于顶穿两格(见规矩 2) */
export const REL_STAGE_THRESHOLDS = [34, 67] as const

/** 三档的可见名字(顺序即 0→2)。角色页与对话页头部都读它一份 */
export const REL_STAGES = ['Getting to know', 'Warming up', 'Close'] as const

/** 单次评估单轴的下限。亲近是攒出来的、不是崩出来的——负值只留给
 *  "明确的疏远信号",所以刻意给得小 */
export const DELTA_MIN = -3
/** 单次评估单轴的上限。配合档位跨度(约 33 一格)天然挡得住一次跨两档,
 *  但那条规矩仍然显式收在 applyEvaluation 里(改常量也不失效) */
export const DELTA_MAX = 8

export type RelAxis = 'familiarity' | 'trust' | 'affection'
/** 三根轴。**顺序就是结构约束的方向**:熟悉 ≥ 信任 ≥ 亲近 */
const AXES: readonly RelAxis[] = ['familiarity', 'trust', 'affection']

/** 一次评估的输入:每轴一个 Δ,缺省的那一轴按 0(不动) */
export type RelationshipDeltas = Partial<Record<RelAxis, number>>

/** 一个"从没评估过"的关系。老角色读进来就是它 */
export function defaultRelationship(): RelationshipState {
  return { familiarity: 0, trust: 0, affection: 0, updatedAt: 0 }
}

/** 收一个刻度值:非有限数 / 越界 / NaN 一律落回 0..REL_MAX 内的整数 */
function asValue(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(REL_MAX, Math.round(v)))
}

/** 结构约束就地夹一次:先按熟悉封顶信任,再按信任封顶亲近。
 *  coerce 与 applyEvaluation 都要它,收在一处免得两份各写各的 */
function enforceOrdering(s: RelationshipState): RelationshipState {
  const trust = Math.min(s.trust, s.familiarity)
  const affection = Math.min(s.affection, trust)
  return { ...s, trust, affection }
}

/** 把盘上/内存里的一条收成合法形状。与 prefs 的 coercePrefs 同一分寸:
 *  读关系永远不抛异常,坏值一律落回默认。这里**再夹一次结构约束**——
 *  是防御性冗余,不能指望写数据的人永远记得(与 selectMemories 同一条理由) */
export function coerceRelationship(raw: unknown): RelationshipState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const base: RelationshipState = {
    familiarity: asValue(o.familiarity),
    trust: asValue(o.trust),
    affection: asValue(o.affection),
    updatedAt: typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) && o.updatedAt > 0 ? o.updatedAt : 0
  }
  return enforceOrdering(base)
}

/** 分值 → 对用户可见的三档(0 / 1 / 2)。认不出的值当 0 档 */
export function relationshipStage(v: number): 0 | 1 | 2 {
  if (!Number.isFinite(v) || v < REL_STAGE_THRESHOLDS[0]) return 0
  if (v < REL_STAGE_THRESHOLDS[1]) return 1
  return 2
}

/** 某个档位的分值天花板(用来挡"一次跨两档")。2 档封顶到 REL_MAX */
function bandTop(stage: 0 | 1 | 2): number {
  if (stage === 2) return REL_MAX
  return REL_STAGE_THRESHOLDS[stage] - 1
}

/** 把一个 Δ 收进 [DELTA_MIN, DELTA_MAX];非有限数当 0 */
function clampDelta(d: number): number {
  if (!Number.isFinite(d)) return 0
  return Math.max(DELTA_MIN, Math.min(DELTA_MAX, Math.round(d)))
}

/**
 * 把模型给的 Δ 落到分值上。这是关系变化的**唯一入口**,三条硬规矩都收在这里。
 *
 * - 每轴 Δ 先 clamp,缺省的轴按 0(不动)——**缺席不降**:没写就是没变;
 * - 每轴结果 clamp 到 0..REL_MAX,再按"档位最多升一格"封顶(规矩 2);
 * - 最后 enforceOrdering 夹一遍结构约束(规矩 1);
 * - updatedAt 刷成这次评估的时刻。
 *
 * `now` 由调用方给(便于测试注入固定时间)。
 */
export function applyEvaluation(
  prev: RelationshipState | undefined,
  deltas: RelationshipDeltas,
  now: number
): RelationshipState {
  const from = coerceRelationship(prev)
  const next: RelationshipState = { ...from }
  for (const axis of AXES) {
    const delta = clampDelta(deltas[axis] ?? 0)
    let candidate = Math.max(0, Math.min(REL_MAX, Math.round(from[axis] + delta)))
    // 规矩 2:一次最多升一格。升上去的值不得越过"上一档再往上一格"的天花板
    const ceiling = bandTop(Math.min(2, relationshipStage(from[axis]) + 1) as 0 | 1 | 2)
    candidate = Math.min(candidate, ceiling)
    next[axis] = candidate
  }
  return enforceOrdering({ ...next, updatedAt: now })
}

/* ===== 从模型输出里读回 Δ ==============================================
   输出格式是固定前缀的行(与 memory 那档 `CATEGORY|ORIGIN|TEXT` 同一条路):
     AXIS|+2 / AXIS|-1 / AXIS|0
   不用 JSON:少一整类"围栏 / 多余解释 / 半截引号"的解析坑,坏一行只丢一行。
   -------------------------------------------------------------------- */

/** 读模型那三行 `AXIS|Δ`。认不出的轴名、非整数的值一律跳过(不抛)。
 *  同一根轴只认第一次出现的那个值(模型偶尔会把同一轴写两遍) */
export function parseRelationshipDelta(raw: unknown): RelationshipDeltas {
  const out: RelationshipDeltas = {}
  if (typeof raw !== 'string' || !raw) return out
  for (const line of raw.split('\n')) {
    const sep = line.indexOf('|')
    if (sep < 0) continue
    const axis = line.slice(0, sep).trim().toLowerCase()
    const numText = line.slice(sep + 1).trim().replace(/^\+/, '')
    if (!AXES.includes(axis as RelAxis)) continue
    if (out[axis as RelAxis] !== undefined) continue // 先到为准
    const value = Number(numText)
    if (!Number.isFinite(value)) continue
    out[axis as RelAxis] = value
  }
  return out
}

/**
 * 把关系摊成注入 system 的那几行 "- …" 指令(与 prefs 的 interactionGuidance
 * 同一形状)。服务端 relationshipSection 只负责加标签、限长、补那句边界话。
 *
 * **从没评估过 / 三轴全 0 → 空串**:还没攒出任何东西,就不该有任何"你们很熟"的
 * 指令,那比不注入更假(老角色、刚建的角色都走这一条)。
 * 有熟悉度了就给一句基调;信任、亲近各只在**到了 1 档以上**才单列一行——
 * 0 档那两样没什么可说,写出来反而是"假装它信任你"。
 */
export function relationshipLines(state: RelationshipState | undefined): string {
  if (!state || state.updatedAt === 0) return ''
  const s = coerceRelationship(state)
  if (s.familiarity === 0 && s.trust === 0 && s.affection === 0) return ''
  const lines: string[] = []
  const fam = relationshipStage(s.familiarity)
  lines.push(
    fam >= 2
      ? '- You know each other very well by now — speak as long-time companions, with your own shared shorthand.'
      : fam === 1
        ? '- You know each other fairly well now — you can skip the background and refer to things you have talked about.'
        : '- You are still getting to know each other — be warm, but do not assume you already know them well.'
  )
  const trust = relationshipStage(s.trust)
  if (trust >= 2) {
    lines.push('- They trust you deeply — sensitive things are safe to bring up, and they expect you to remember.')
  } else if (trust === 1) {
    lines.push('- There is real trust between you — they open up to you, and you can be steady with them.')
  }
  const aff = relationshipStage(s.affection)
  if (aff >= 2) {
    lines.push('- You two are close and affectionate — warmth, teasing and easy familiarity are natural between you.')
  } else if (aff === 1) {
    lines.push('- You are comfortable with each other now — be affectionate and at ease.')
  }
  return lines.join('\n')
}

/** 发请求那一刻用这个:按角色身上的关系摊成提示词。没有就是空串 */
export function relationshipLinesFor(c: { relationship?: RelationshipState } | undefined): string {
  return relationshipLines(c?.relationship)
}

/**
 * 这段关系攒出东西了没有:三轴里只要有一格 >0 就算。
 *
 * 它是"要不要在角色身上留 relationship 这个字段""要不要在角色页显示这一块"
 * 的**唯一判据** —— 落盘处、载入收口处、界面都读它,免得"空"这件事在三处各定义一遍、
 * 哪天改口径就漂移。全 0 就当作"还没走到哪一步":字段删掉、界面按刚认识起步,
 * 与 relationshipLines 对全 0 回空串是同一条分寸。
 */
export function hasCloseness(state: RelationshipState | undefined): boolean {
  if (!state) return false
  const s = coerceRelationship(state)
  return s.familiarity > 0 || s.trust > 0 || s.affection > 0
}
