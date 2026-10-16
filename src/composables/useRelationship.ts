import { reactive } from 'vue'
import { evaluateRelationship, saveCharacters } from '../api'
import {
  applyEvaluation,
  coerceRelationship,
  hasCloseness,
  parseRelationshipDelta
} from '../lib/relationship'
import type { ApiConfig, Character, RelationshipState } from '../types'

/* ===== 关系状态这一域(PRD §3.2-C)====================================
   非界面的一半:读一次对话 → 让模型判三轴这几条上的变化量 → 落到角色身上 → 存回
   localStorage。与 useMemories 是同一条形状(后台整理、静默失败、按域收在
   composable 里,主界面只做装配),也刻意平行:记忆抽的是"关于你的事实",
   这里判的是"你俩走近了多少",两件事各走各的调用,不互相污染。

   它挂在 Character.relationship 上(additive 字段,不动 DB_VERSION,导出 JSON 自然带上),
   所以这一步写的是**整份角色目录**,不是某张单独的表 —— 与 togglePinChar 落 pinned
   同一条路:改 characters.value 里那一条,再 saveCharacters。

   三条硬规矩(熟悉封顶信任、信任封顶亲近 / 一次不跨两档 / 缺席不降)全收在
   lib/relationship 的纯逻辑里,这里不重复判 —— 这一层只做"取模型的话、
   落到人身上、存下去"。 */

export interface RelationshipDeps {
  characters: { value: Character[] }
  /* 评估要用对话那条模型配置 —— 与抽记忆同一条理由:它该和回话用同一个脑子,
     否则"它怎么记得你"与"它觉着你们多熟"会出自两个不一致的判断 */
  chatConfig: { value: ApiConfig | null }
}

/** 把当前的三轴摊成一句给人读、也给模型当"从哪儿起"的话。
 *  裸数字在这里是**内部刻度**,不进用户界面(界面只露档位),但喂模型时说清
 *  "0-100 的此刻值"最省事,也免得模型以为每格都是从 0 起 */
function standingText(s: RelationshipState): string {
  return `familiarity ${s.familiarity}/100, trust ${s.trust}/100, affection ${s.affection}/100`
}

export function useRelationship(deps: RelationshipDeps) {
  /* 正在评估的角色。同一时刻一个角色只该有一个评估在跑(与 extracting 同一条):
     压记忆按批触发,连着来两批不该并发地各读各写同一份关系 */
  const evaluating = reactive(new Set<string>())

  /**
   * 读这一段对话,判一次关系变化,落到角色身上。
   *
   * **静默**:这是一次后台整理,失败就退出、不弹提示,也不动任何已经存好的关系
   * (用户不该因为一次没判成而被打断)。返回这一次**是否真的写动了** ——
   * 三条都没变就不写,免得每压一次记忆都重写整份角色目录。
   *
   * `now` 由外部注入,便于单测把时间钉死(纯逻辑那层同样这么收 updatedAt)。
   */
  async function runEvaluate(
    charId: string,
    messages: { role: string; content: string }[],
    now: number = Date.now()
  ): Promise<boolean> {
    const cfg = deps.chatConfig.value
    if (!cfg || !cfg.model.trim() || !cfg.baseUrl.trim()) return false
    if (evaluating.has(charId) || !messages.length) return false
    const char = deps.characters.value.find((c) => c.id === charId)
    if (!char) return false
    evaluating.add(charId)
    try {
      const prev = coerceRelationship(char.relationship)
      const raw = await evaluateRelationship(cfg, messages, standingText(prev))
      const deltas = parseRelationshipDelta(raw)
      const next = applyEvaluation(prev, deltas, now)

      /* 只有真挪动了才落盘:三轴一个没变(哪怕盖了个新时间戳)就是"这段没什么值得改关系",
         那不该换来一次整目录重写 */
      const moved =
        prev.familiarity !== next.familiarity ||
        prev.trust !== next.trust ||
        prev.affection !== next.affection
      if (!moved) return false

      /* 挪到全 0(负 Δ 抵光了)就当"没攒下东西":删掉字段,让"从没评估过"与
         "评估过但没走动"保持同一种形状 —— 与 loadCharacters 收口那条同分寸 */
      if (hasCloseness(next)) char.relationship = next
      else delete char.relationship
      await saveCharacters(deps.characters.value)
      return true
    } catch (e) {
      // 关系是"锦上添花"那一层:判不成只是这阵子没更新上,绝不能打断对话或抹掉已有分值
      console.error('[Kairo] relationship evaluation failed', e)
      return false
    } finally {
      evaluating.delete(charId)
    }
  }

  /** 自动触发:压完记忆那一步顺手判一次,复用同一批消息,不额外读盘。
   *  这就是"受有意义互动影响、而非消息数堆出来"的落点 —— 一次评估对应一段被压出来的
   *  真实对话,而不是对应"用户又发了一条" */
  async function autoEvaluate(
    charId: string,
    batch: { role: string; content: string }[]
  ): Promise<void> {
    await runEvaluate(charId, batch)
  }

  return {
    /* 正在评估的角色集合(响应式)。界面若要在角色页显示"正在掂量",读它做忙碌态。
       用 reactive 的 Set 而不是普通 Set:普通 Set 增删不触发重渲染(与 extracting 同一条) */
    evaluating,
    runEvaluate,
    autoEvaluate
  }
}
