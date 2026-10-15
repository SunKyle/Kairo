/* ===== 界面偏好(不是数据) ============================================
   这里放"这台设备上这个人喜欢怎么看界面"的那几项。它们与目录数据是两回事:
   - 丢了不影响任何东西的完整性(所以**不跨标签页同步** —— 与 kimage.theme 同一条理由:
     别人切了主题/切了沉浸,跟着变反而突兀);
   - 与 lib/theme.ts 同一条硬规矩:**所有函数都不抛异常**。
     localStorage 在 Safari 无痕、禁用 Cookie、sandbox iframe 里都可能直接抛,
     而调用点就在挂载路径上 —— 漏出去整个应用就不渲染了。
   -------------------------------------------------------------------- */

import type { ComfortMode, InteractionPrefs, PrefLevel } from '../types'

/** 沉浸式对话页(bool)。存 '1' / '0' —— 与别的键一样是**字符串**,
 *  读取时只认 '1',所以"没设过"与"设成别的"都落回默认关 */
const IMMERSIVE_KEY = 'kimage.immersive'

/** 用户上次是不是开着沉浸模式。**没设过就是关** ——
 *  存量用户不该被突然换一套骨架(默认值是最强的产品表达,别替他决定) */
export function savedImmersive(): boolean {
  try {
    return localStorage.getItem(IMMERSIVE_KEY) === '1'
  } catch {
    return false
  }
}

export function saveImmersive(on: boolean): void {
  try {
    localStorage.setItem(IMMERSIVE_KEY, on ? '1' : '0')
  } catch {
    /* 记不住就记不住:这一次的选择照常生效,只是下次回不到这个状态 */
  }
}

/* ===== 相处偏好(PRD §3.2-D) ==========================================
   与上面两项的差别:主题/沉浸是"这台设备上这个人怎么看界面",而这一份是
   "这个人希望被角色怎么对待" —— 它会被拼进对话的 system 提示词。

   仍然走 localStorage,理由与目录那条一致:它是**轻量文本**,一个角色几百字节,
   而它必须能被同步读取(发请求那一刻就要用),IndexedDB 是异步的。
   整个库只有这一把键,里面按 charId 分条 —— 键的数量不随角色数增长,
   跨标签页扫描(source 扫描那类测试)也只需要认识一个常量。

   **保存时必须先把盘上那份重读一遍再合并这一个角色**,不能拿内存里那份整份覆盖:
   两个标签页各改各的角色时,整份覆盖会让后保存的那个把另一个的改动抹掉。
   -------------------------------------------------------------------- */

/** 全部相处偏好。键是角色 id,值是这个角色的偏好 */
export type InteractionPrefsMap = Record<string, InteractionPrefs>

const INTERACTION_KEY = 'kimage.interactionPrefs'

/** 三档强度里合法的那几个值。收口用 —— 盘上的内容可能是旧版本、被人手改过的 */
const LEVELS: readonly PrefLevel[] = ['neutral', 'low', 'high']
const COMFORTS: readonly ComfortMode[] = ['neutral', 'listen', 'advise', 'distract']

/** 一个"什么都没表态"的偏好。角色没配过、或用户全部拨回中间档时就是它 */
export function defaultInteractionPrefs(): InteractionPrefs {
  return { initiative: 'neutral', humor: 'neutral', directness: 'neutral', pace: 'neutral', comfort: 'neutral', updatedAt: 0 }
}

function asLevel(v: unknown): PrefLevel {
  return LEVELS.includes(v as PrefLevel) ? (v as PrefLevel) : 'neutral'
}
function asComfort(v: unknown): ComfortMode {
  return COMFORTS.includes(v as ComfortMode) ? (v as ComfortMode) : 'neutral'
}

/** 把盘上读回来的一条收成合法形状。形状不对的一律落回中性 ——
 *  与这个文件顶上那条硬规矩一致:读偏好永远不抛异常 */
function coercePrefs(raw: unknown): InteractionPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    initiative: asLevel(o.initiative),
    humor: asLevel(o.humor),
    directness: asLevel(o.directness),
    pace: asLevel(o.pace),
    comfort: asComfort(o.comfort),
    updatedAt: typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : 0
  }
}

/** 读出全部相处偏好。读不出来 / 内容坏掉一律当空表 */
export function loadInteractionPrefs(): InteractionPrefsMap {
  try {
    const raw = localStorage.getItem(INTERACTION_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: InteractionPrefsMap = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (id) out[id] = coercePrefs(v)
    }
    return out
  } catch {
    return {}
  }
}

/** 读一个角色的相处偏好。没配过返回 undefined(与"全部中性"是同一件事) */
export function loadInteractionPrefsOf(charId: string): InteractionPrefs | undefined {
  if (!charId) return undefined
  return loadInteractionPrefs()[charId]
}

/**
 * 写一个角色的相处偏好。`null` = 删掉这一条(用户全部拨回中性)。
 *
 * **先重读盘上那份再合并这一个角色**:整份覆盖会让另一个标签页刚改的
 * 别的角色被抹掉(见文件顶上那段)。写不进去就静默失败 ——
 * 这一次的选择照常生效,只是下次回不到这个状态(与 saveImmersive 同一条)。
 */
export function saveInteractionPrefsOf(charId: string, prefs: InteractionPrefs | null): void {
  if (!charId) return
  try {
    const all = loadInteractionPrefs()
    if (prefs && !isNeutralInteraction(prefs)) all[charId] = { ...coercePrefs(prefs), updatedAt: Date.now() }
    else delete all[charId]
    localStorage.setItem(INTERACTION_KEY, JSON.stringify(all))
  } catch {
    /* 见上 */
  }
}

/** 这个角色是不是一项都没表态。是的话保存等于删除这一条 ——
 *  免得盘上留一堆"全是中性"的空壳 */
export function isNeutralInteraction(p: InteractionPrefs | undefined): boolean {
  if (!p) return true
  return (
    p.initiative === 'neutral' &&
    p.humor === 'neutral' &&
    p.directness === 'neutral' &&
    p.pace === 'neutral' &&
    p.comfort === 'neutral'
  )
}

/* ===== 把偏好摊成提示词 ==============================================
   纯函数:输入偏好,输出几行指令(没有表态的维度不出现,全部中性时返回空串)。
   **标签与"它不覆盖人格"那句在服务端加**(见 server/routes/chat.js)——
   那句话是这条边界本身,不能指望前端每次都记得带上。
   -------------------------------------------------------------------- */
export function interactionGuidance(p: InteractionPrefs | undefined): string {
  if (!p || isNeutralInteraction(p)) return ''
  const lines: string[] = []
  if (p.initiative === 'high') lines.push('- Reach out on your own now and then: start a conversation when something reminds you of them.')
  if (p.initiative === 'low') lines.push('- Let them come to you. Do not start conversations on your own.')
  if (p.humor === 'high') lines.push('- Be playful — jokes and teasing are welcome.')
  if (p.humor === 'low') lines.push('- Keep it straight. Skip the jokes.')
  if (p.directness === 'high') lines.push('- Say it plainly. Do not soften things or pad them.')
  if (p.directness === 'low') lines.push('- Be gentle about it — softness matters more than bluntness here.')
  if (p.pace === 'high') lines.push('- Feel free to write a little more, and keep the back-and-forth quick.')
  if (p.pace === 'low') lines.push('- Keep your messages short. Do not flood them.')
  if (p.comfort === 'listen') lines.push('- When they are upset, let them talk. Do not rush to fix it.')
  if (p.comfort === 'advise') lines.push('- When they are upset, help them think it through.')
  if (p.comfort === 'distract') lines.push('- When they are upset, take their mind off it.')
  return lines.join('\n')
}

/** 发请求那一刻用这个:按角色读盘并摊成提示词。没配过就是空串 */
export function interactionGuidanceFor(charId: string): string {
  return interactionGuidance(loadInteractionPrefsOf(charId))
}

/* ===== 界面用的维度表 ================================================
   摆在数据层而不是组件里:选项值必须与上面那几个联合类型一一对应,
   两处各写一份迟早对不上(加了新档位而界面没有)。
   -------------------------------------------------------------------- */
export interface PrefOption {
  value: string
  label: string
}
export interface PrefDimension {
  key: 'initiative' | 'humor' | 'directness' | 'pace' | 'comfort'
  label: string
  hint: string
  options: PrefOption[]
}

const NEUTRAL_OPTION: PrefOption = { value: 'neutral', label: 'No preference' }

export const INTERACTION_DIMENSIONS: readonly PrefDimension[] = [
  {
    key: 'initiative',
    label: 'Reaching out',
    hint: 'How often they should start a conversation on their own.',
    options: [NEUTRAL_OPTION, { value: 'low', label: 'Let me come to them' }, { value: 'high', label: 'Reach out now and then' }]
  },
  {
    key: 'humor',
    label: 'Humour',
    hint: 'How playful they should be with you.',
    options: [NEUTRAL_OPTION, { value: 'low', label: 'Keep it straight' }, { value: 'high', label: 'Joke around' }]
  },
  {
    key: 'directness',
    label: 'Directness',
    hint: 'Blunt or gentle when it matters.',
    options: [NEUTRAL_OPTION, { value: 'low', label: 'Gentle' }, { value: 'high', label: 'Plain and blunt' }]
  },
  {
    key: 'pace',
    label: 'Chat pace',
    hint: 'Short, sparse messages or longer, quicker ones.',
    options: [NEUTRAL_OPTION, { value: 'low', label: 'Short and sparse' }, { value: 'high', label: 'Longer and quicker' }]
  },
  {
    key: 'comfort',
    label: 'When I am upset',
    hint: 'What actually helps when you are having a bad day.',
    options: [
      NEUTRAL_OPTION,
      { value: 'listen', label: 'Just listen' },
      { value: 'advise', label: 'Help me think it through' },
      { value: 'distract', label: 'Take my mind off it' }
    ]
  }
]
