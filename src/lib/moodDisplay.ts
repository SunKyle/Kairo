/* ===== 情绪词的展示层（en → 中文 / 色桶 / 表情）=========================
 *
 *  服务端那枚 `[mood:word]` 刻意「不做分类表」—— 写词的读词的都是模型，中间不
 *  该插一张词表去翻译（见 server/chatMood.js）。那条纪律约束的是**对话回路**。
 *
 *  这个文件是**另一件事**：把那个自由英文词，翻成中文界面上能看的一枚小胶囊。
 *  它纯展示、不进回路、不改服务端逻辑，因此不违背上面那条。
 *
 *  两条硬规矩（都靠 resolveMood 一处收口，好测）：
 *  1. **没配到的词绝不硬编一个假中文** —— 原样回显英文 + 走中性灰，宁可素也不
 *     能错。模型给的是自由词，词表永远补不全，兜底路径才是常态；
 *  2. **色桶只有 4 个温度**（warm/hot/cool/low）+ neutral 兜底，刻意少 ——
 *     Apple+Linear 的基调是墨色克制，情绪只该「泄露一点温度」，不该变成彩虹。
 *
 *  纯函数、无 IO、无 DOM —— 单独成文件就是为了测得了（与 chatOrder / grow 同一种写法）。
 */

/** 情绪的四个温度桶 + 一个中性兜底。色值在 MoodPill.vue 里按主题给。 */
export type MoodTone = 'warm' | 'hot' | 'cool' | 'low' | 'neutral'

export interface MoodDisplay {
  /** 胶囊上显示的字：命中的中文，或（未命中时）原英文词 */
  label: string
  /** 温度桶，决定淡底 / 前景色 */
  tone: MoodTone
  /** 一枚表情；空串表示没有对应的脸（未命中的词就不硬塞表情） */
  face: string
}

/** 英文词 → 中文 / 色桶 / 表情。键一律小写。 */
const LEXICON: Record<string, { zh: string; tone: MoodTone; face: string }> = {
  // —— warm：亮、暖、往外 —— //
  amused: { zh: '被逗乐了', tone: 'warm', face: '😄' },
  delighted: { zh: '雀跃', tone: 'warm', face: '🤩' },
  warm: { zh: '暖暖的', tone: 'warm', face: '🤗' },
  happy: { zh: '开心', tone: 'warm', face: '😄' },
  glad: { zh: '高兴', tone: 'warm', face: '😊' },
  proud: { zh: '得意', tone: 'warm', face: '😌' },
  playful: { zh: '玩心大起', tone: 'warm', face: '😏' },
  mischievous: { zh: '想使坏', tone: 'warm', face: '😏' },
  teasing: { zh: '想逗你', tone: 'warm', face: '😏' },
  affectionate: { zh: '黏人', tone: 'warm', face: '🥰' },
  loving: { zh: '柔情', tone: 'warm', face: '🥰' },
  grateful: { zh: '心存感激', tone: 'warm', face: '🙏' },
  excited: { zh: '兴奋', tone: 'warm', face: '🤩' },
  hopeful: { zh: '有盼头', tone: 'warm', face: '🌟' },
  cozy: { zh: '惬意', tone: 'warm', face: '🥰' },
  content: { zh: '知足', tone: 'warm', face: '😌' },
  calm: { zh: '平静', tone: 'warm', face: '😌' },
  dreamy: { zh: '有点飘', tone: 'warm', face: '✨' },
  flustered: { zh: '有点上头', tone: 'warm', face: '😊' },
  shy: { zh: '不好意思', tone: 'warm', face: '😊' },
  // —— hot：烫、带刺、自我 —— //
  angry: { zh: '恼火', tone: 'hot', face: '😠' },
  irritated: { zh: '冒火', tone: 'hot', face: '😠' },
  annoyed: { zh: '烦躁', tone: 'hot', face: '😠' },
  furious: { zh: '火大', tone: 'hot', face: '😡' },
  grumpy: { zh: '炸毛', tone: 'hot', face: '😠' },
  arrogant: { zh: '趾高气扬', tone: 'hot', face: '😤' },
  jealous: { zh: '发酸', tone: 'hot', face: '😒' },
  defensive: { zh: '竖起刺', tone: 'hot', face: '😾' },
  // —— cool：收、防、往回 —— //
  wary: { zh: '警觉', tone: 'cool', face: '👀' },
  uneasy: { zh: '心里打鼓', tone: 'cool', face: '😬' },
  nervous: { zh: '发怵', tone: 'cool', face: '😰' },
  anxious: { zh: '不安', tone: 'cool', face: '😰' },
  cautious: { zh: '留了个心眼', tone: 'cool', face: '🧭' },
  confused: { zh: '犯迷糊', tone: 'cool', face: '😕' },
  serious: { zh: '认真起来', tone: 'cool', face: '😐' },
  distant: { zh: '有点疏离', tone: 'cool', face: '🧊' },
  cold: { zh: '冷淡', tone: 'cool', face: '🧊' },
  guarded: { zh: '收着', tone: 'cool', face: '🧊' },
  tense: { zh: '紧绷', tone: 'cool', face: '😬' },
  // —— low：低、平、往下 —— //
  tired: { zh: '累了', tone: 'low', face: '😮‍💨' },
  sleepy: { zh: '犯困', tone: 'low', face: '😴' },
  bored: { zh: '提不起劲', tone: 'low', face: '🫥' },
  sad: { zh: '低落', tone: 'low', face: '😔' },
  melancholic: { zh: '多愁', tone: 'low', face: '🥲' },
  lonely: { zh: '孤单', tone: 'low', face: '🫧' },
  nostalgic: { zh: '念旧', tone: 'low', face: '🥲' },
  wistful: { zh: '怅然', tone: 'low', face: '🥲' },
  down: { zh: '蔫了', tone: 'low', face: '😔' },
  drained: { zh: '被掏空', tone: 'low', face: '🫠' },
  blue: { zh: '闷闷的', tone: 'low', face: '😔' }
}

/**
 * 把一枚情绪词收成展示数据。
 *
 * @returns 空 / 全空白 → `null`（这一轮没情绪，胶囊整枚不该出现）；
 *   命中词表 → 中文 + 温度桶 + 表情；
 *   没命中 → `{ label: 原英文词, tone: 'neutral', face: '' }`（回显原词、无脸、走灰）。
 */
export function resolveMood(word: unknown): MoodDisplay | null {
  const w = String(word ?? '')
    .trim()
    .toLowerCase()
  if (!w) return null
  const hit = LEXICON[w]
  if (hit) return { label: hit.zh, tone: hit.tone, face: hit.face }
  // 兜底：原样回显（服务端已把它收成小写），不翻译、不给表情
  return { label: w, tone: 'neutral', face: '' }
}
