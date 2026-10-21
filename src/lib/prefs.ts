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

/* ===== 出图偏好(设置页的 Photos 分区) ================================
   两项都是**这台设备上这个人怎么看待对话里的图**,与具体角色无关 ——
   所以是全局的一条键,不像相处偏好那样按 charId 分条。

   —— 为什么频率不是"N 轮一张" ——

   2026-10-03 已经定过:发图频率该由对话本身决定,客户端不做"N 轮最多一张"
   那种硬拦截(任何 N 都是替用户做判断,见 doc/角色出图.md §4.1.2)。
   但"完全不可控"与"能调个倾向"不是一回事:这一项只改服务端发图说明里
   那一段的口吻,模型仍然按"这张图是不是这句话的重点"自己决定。
   所以它是**倾向**,不是配额 —— 关不掉发图,也不会保证第几张一定发。

   —— 摄影指导 ——

   它每张图多冒一次文本调用(见 useGeneration 的 withDirector),失败会退回
   模板层。默认开 = 维持既有行为;**关掉只是省掉那一跳**,不是关掉出图。
   与主题/沉浸同一条:存 localStorage 的 '1' / '0',不跨标签页同步,
   所有函数都不抛异常(调用点在挂载路径与每次出图上)。
   -------------------------------------------------------------------- */

const PHOTO_DIRECTOR_KEY = 'kimage.photoDirector'
const PHOTO_FREQUENCY_KEY = 'kimage.photoFrequency'

/** 发图频率的三档。名字与 server/chatPhoto.js 的 photoRules 一一对应 ——
 *  中间那档就是原来的写法,不是"多出来的一档" */
export type PhotoFrequency = 'rare' | 'normal' | 'often'

/** 摄影指导开没开。**没设过 = 开**(存量用户维持既有行为) */
export function savedPhotoDirector(): boolean {
  try {
    return localStorage.getItem(PHOTO_DIRECTOR_KEY) !== '0'
  } catch {
    return true
  }
}

export function savePhotoDirector(on: boolean): void {
  try {
    localStorage.setItem(PHOTO_DIRECTOR_KEY, on ? '1' : '0')
  } catch {
    /* 见上 */
  }
}

/** 发图频率。**没设过 = normal**(与原来那句"大多数消息没有图"同义);
 *  盘上是别的值(旧版本 / 手改)也落回 normal,不猜 */
export function savedPhotoFrequency(): PhotoFrequency {
  try {
    const v = localStorage.getItem(PHOTO_FREQUENCY_KEY)
    return v === 'rare' || v === 'often' ? v : 'normal'
  } catch {
    return 'normal'
  }
}

export function savePhotoFrequency(v: PhotoFrequency): void {
  try {
    localStorage.setItem(PHOTO_FREQUENCY_KEY, v === 'rare' || v === 'often' ? v : 'normal')
  } catch {
    /* 见上 */
  }
}

/* ===== 心理层次的展示开关与场景闸(见 doc/对话体验.md)====
   三根杆里"展示"这一根:think / act 各一个**全局**开关,只管界面上给不给看,
   **不回写记忆、也不回写喂模型的下一轮**(关掉展示 ≠ 删了事件 —— 设计 §5 那条硬规矩)。
   say 恒可见,没有开关。

   与主题/沉浸同一条:界面偏好,存 localStorage 的 '1' / '0',**不跨标签页同步**
   (别人切了、你这边跟着变,突兀),所有函数不抛异常。

   默认都开:think 是这套交互最招牌的亲密特征(设计 §11 决策 4),藏起来等于没做;
   嫌出戏的人一键关。sceneMode(下面)则**默认关** —— 满屏旁白会滑向三流同人文
   (设计 §7),它更该被显式打开而不是白送。 */

const SHOW_THINK_KEY = 'kimage.showThink'
const SHOW_ACT_KEY = 'kimage.showAct'

/** 没设过 = 开(读不到 '0' 就算 true,与 immersive 反过来:默认是最强表达,这里默认给看) */
export function savedShowThink(): boolean {
  try {
    return localStorage.getItem(SHOW_THINK_KEY) !== '0'
  } catch {
    return true
  }
}
export function saveShowThink(on: boolean): void {
  try {
    localStorage.setItem(SHOW_THINK_KEY, on ? '1' : '0')
  } catch {
    /* 见上 */
  }
}
export function savedShowAct(): boolean {
  try {
    return localStorage.getItem(SHOW_ACT_KEY) !== '0'
  } catch {
    return true
  }
}
export function saveShowAct(on: boolean): void {
  try {
    localStorage.setItem(SHOW_ACT_KEY, on ? '1' : '0')
  } catch {
    /* 见上 */
  }
}

/* 场景模式:**按角色存的一张 bool 表**(设计 §6:它是这条对话此刻在不在"场景"里的显式状态,
   由它 gate 服务端产不产出 `[act]`)。做成角色级而非全局,是因为"进没进场景"是**一段关系当前
   的处境**,不是这台设备上永久的界面口味 —— 跟互动偏好一样按 charId 分条。

   迟滞(auto「首个 act 点亮、不因后续没旁白就灭」)那半属于产出侧的反馈环,留待后续;
   这里先落**用户可钉住的 override + 持久位**。默认关:未设过的角色不产出 act(保守)。 */

const SCENE_KEY = 'kimage.sceneMode'

function loadSceneMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SCENE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, boolean> = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (id && v === true) out[id] = true // 只存 true,关 = 删键
    }
    return out
  } catch {
    return {}
  }
}

/** 这个角色的对话此刻在不在场景里。未设 = 关 */
export function sceneModeFor(charId: string): boolean {
  if (!charId) return false
  return loadSceneMap()[charId] === true
}

/** 全部角色的场景位。界面用它起一份**自己的响应式镜像**(界面偏好不跨标签页同步,
 *  与主题/沉浸同一条)—— 拨一下同时写这份镜像与 saveSceneMode,读的时候用镜像、
 *  发请求那一刻仍由 useChatFlow 现读 sceneModeFor,两边落的是同一把键、同一套逻辑。 */
export function loadSceneModes(): Record<string, boolean> {
  return loadSceneMap()
}

/** 开关某个角色的场景模式。**先重读盘上那份再合并这一个角色**(跨标签页覆盖,同互动偏好) */
export function saveSceneMode(charId: string, on: boolean): void {
  if (!charId) return
  try {
    const all = loadSceneMap()
    if (on) all[charId] = true
    else delete all[charId]
    localStorage.setItem(SCENE_KEY, JSON.stringify(all))
  } catch {
    /* 见上 */
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
