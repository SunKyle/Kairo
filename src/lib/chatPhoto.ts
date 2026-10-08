/* 对话里"角色发一张图"这一步的五个决定:
   ① 这张里有没有它本人(要不要拼外貌、要不要发参考图);
   ② 这一张是自拍、他拍还是空镜(**谁拿的相机**);
   ③ 这一张离得多近:特写 / 半身 / 全身(**景别**,2026-10-06 新增);
   ④ 拼进提示词的是"锚点句"还是那份全量设定表;
   ⑤ 这一张要不要补机位、光、环境 —— 以及**只补空着的位**。
 *
 *  —— 为什么这里不再是"场景 + 设定表"两个字符串相加 ——
 *
 *  从前这一层的产出是 `scene + ", " + characterFaceDesc`,即把外貌设定的
 *  二十个逗号短语整份接在场景后面。实测出来的图很死:平光、平视、居中、纯背景。
 *  原因不是模型不行,是那段提示词**只有"画什么"、没有"怎么拍"**:
 *  一个摄影师要拍出一张照片至少要定六件事(谁在拍、机位在哪、什么镜头、光从哪来、
 *  几点、背景有什么),而 120 字的场景串只回答了"在哪"。
 *  剩下的空位模型会自己补 —— 补出来的是它的缺省值,而死板正是缺省值的样子。
 *
 *  更隐蔽的一层:那份外貌清单不只在锁长相,它把**表情、姿态、机位一起锁住了**。
 *  "oval face, high cheekbones, ... clean-shaven"这种 token 密度下,模型最省力的
 *  解法就是交一张证件照 —— 而参考图恰好也是一张纯背景、中性表情、居中的证件照,
 *  两者互相加强。所以这一层的改法是**做减法**:只留几个不可变的身份特征
 *  (见 characterAnchor),把表情、姿态、光的方向、景深全部让出来。
 *
 *  —— 六层提示词,顺序不能反 ——
 *
 *      shot(谁拿的相机) → scene(画的是什么) → anchor(是谁)
 *      → expression(这一刻的心情,写在脸上)
 *      → part(特写时:这一格是那个人的局部) → pin/frame(这一档不可让渡的两条)
 *      → camera/lens/light/environment(补空的位)
 *      → negative(挡证件照、肢体画坏与拼贴)
 *
 *  顺序既是权重也是语义:
 *  - shot 排最前是因为没有它,"自拍"就只是场景里的一个词。图像模型没有"自拍"
 *    这个概念,depth 上它只有"画一个人";能把"画一个人"掰成一张自拍的,
 *    是"前置摄像头 + 臂展 + 手入画 + 轻微广角"这几个具体的词。
 *  - scene 必须在 anchor 之前。反过来写等于把固定的长相顶在最前面,
 *    "这一张要画什么"被压到最后 —— 与 composedPrompt 是同一条纪律。
 *  - camera/light/environment 在 anchor 之后:它们修饰的是画面,不是这个人。
 *
 *  —— 只补不覆盖 ——
 *
 *  模板绝不能无脑写死 `warm afternoon light, shallow depth of field`。
 *  场景里已经写了 "at dusk, rain on the glass" 时,再塞一句暖光就是自相矛盾,
 *  模型会挑一处当噪声丢掉、或者把两者硬凑成一张谁都不像的图。
 *  所以模板只补**场景没说的**位(见 missingSlots);一个位推不出来时宁可留空 ——
 *  留空至少让出图模型按场景自己长,塞一个错的默认值比留空更糟。
 *
 *  抽出来还有一个实际理由:真正的出图要花钱、要联网、靠手测试不全,
 *  而上面每一条判据都是纯字符串处理,可以直接断言。
 */

import { sizeClosestTo } from '../api'
import { moodWord } from '../../server/chatMood.js'

/** 拼给图模型的那一整段提示词的上限。
 *
 *  2026-10-04 从 1200 放宽到 6000:场景串的上限从 120 提到了 400
 *  (时间/天气/周围有什么 —— 那些只有聊天模型看得见的信息要写进去),
 *  锚点句那一层也可能上百字,几层相加很容易撞到 1200。而**截断发生在拼接的
 *  最后一步**,砍掉的正好是垫在末尾的负面约束(挡"证件照"那套默认构图的话)。
 *  放宽它不产生任何新调用,只是不再让最后那几层被无声吃掉。 */
export const CHAT_PHOTO_PROMPT_CHARS = 6000

/** 谁拿的相机。三档足够,再多就变成让聊天模型做摄影决定了(见下) */
export type ChatShot = 'selfie' | 'third' | 'scene'

/** 景别 —— 这一张离得多近。与 shot 正交的第二位(2026-10-06 新增)。
 *
 *  —— 为什么非得有它 ——
 *
 *  在这之前,景别是**写死在 template 的机位句里**的:自拍那句是
 *  "face and shoulders filling the upper half of the frame"(半身),
 *  他拍那句是 "full figure and hands inside the frame"(全身)。
 *  于是场景里写 "close-up of my eyes" 时,提示词里出现的是
 *  "特写" + "脸和肩膀占满上半幅" + "身后的地方看得清" —— 三句正面打架,
 *  模型只能挑一边信。用户报的"对于特写图还是不太能理解"就是这个。
 *
 *  三档而不是五档(特写/近景/中景/全景/远景):**这一位要的是"推到多近",
 *  不是一份分镜表**。close 与 full 之外的一切都落回 medium,而 medium 的文案
 *  逐字等于这一位不存在时的那三句 —— 老消息、认不出的说法,代价为零。 */
export type ChatFrame = 'close' | 'medium' | 'full'

/** 一层提示词:槽名 + 这一层的正文。槽名决定**这一位归谁管** ——
 *  摄影指导那一层只能改 camera / lens / light / env(见 lib/photoDirector),
 *  其余几个槽(medium / scene / anchor / part / pin / frame / action / negative)
 *  它连值都拿不到 */
export type ChatLayer = [string, string]

export interface ChatPhotoPlan {
  /** 真正发给上游的提示词。由 composeChatPrompt(layers) 拼出来 */
  prompt: string
  /** 要不要把角色的设定图/主参考图当参考图发出去 */
  useRefs: boolean
  /** 这一张怎么拍。调用方据它挑参考图与尺寸(自拍竖一点、空镜横一点)。
   *  **摄影指导有权改它** —— 见 lib/photoDirector 的 applyDirector */
  shot: ChatShot
  /** 这一张离得多近。**调用方据它挑参考图,但不据它挑尺寸** ——
   *  它决定机位/景深/环境那三句、那一条 frame 硬约束(见 FRAMING),
   *  以及参考图的取舍顺序(见 FRAME_REF_ORDER,2026-10-06 补)。
   *  与 shot 一样,摄影指导改不到它(不在 DIRECTOR_SLOTS 里) */
  frame: ChatFrame
  /** 它是不是在画面里。**这是聊天模型唯一回答的那件事**,
   *  存下来是因为摄影指导改视角时要重拼模板,而"画面里有没有人"是那道护栏:
   *  没有人时视角只能是空镜,谁都不许改成自拍(见 planChatPhoto 的 resolved) */
  self: boolean
  /** 收敛成一行之后的场景原文。摄影指导那一层要用它作输入,
   *  而它**永远原样进提示词** —— 谁都不许改写它 */
  scene: string
  /** 分层结构。摄影指导写回来的那几句要能逐位替换,所以必须留到这一层 */
  layers: ChatLayer[]
}

/* ===== 锚点句 =========================================================
 *  从结构化设定里只取**跨场景不该变、且模型光看图认不出来**的那几项。
 *
 *  为什么不能继续用全量的 characterFaceDesc:它把十几项平铺成同级权重,
 *  build 的"tall and lean"和 face 的"oval face"在模型眼里是同一层东西,
 *  而里面混着的 style(媒介)、identity(身份叙事)、muscle/posture(近景里看不见)
 *  一起构成了"档案照"的语境。这里只留身份,其余交给参考图。
 *
 *  **刻意不进锚点句的两项:**
 *  - style:它是"用哪种媒介画",属于第一层的介质,由 shotTemplate 给
 *    ("photographic")。两边都写会重复,而重复一旦措辞不一致,模型丢掉一个;
 *  - identity:"a night-shift nurse in a coastal town" 是**身份叙事,不是长相**。
 *    它进画面提示词会把模型引去做角色扮演式构图(制服、道具、环境全都跟着来),
 *    而"穿什么"本来就该由具体场景决定。要它出镜时由场景描述自己说。
 *
 *  **faceMarks 与 marks 也在清单里**(2026-10-08):它们是用户亲手写下的身份特征
 *  —— 脸上的痣/疤,身上的纹身与**标志性配饰**。"是不是她"从来不只看脸,而这两项
 *  从前到不了锚点:faceMarks 不在那张清单里,marks 还标着 sheetOnly(连创作区都
 *  不进)。于是"左眼下小痣 / 银项链"在对话图上只剩参考图一条路,而小痣在缩略图里
 *  根本看不见。两项都常常是空的 —— 空值由下面 filter(Boolean) 滤掉,所以填了才
 *  占位、不填一个字都不多。
 *
 *  **顺序就是取舍的优先级**(触到上限时从后往前丢):脸 → 头发 → 眼睛 → 眉毛 →
 *  鼻嘴 → 胡须 → 脸上的标记 → 身上的标记 → 体型。眼睛、眉毛、鼻嘴靠前是因为它们
 *  对人脸识别的贡献最大;体型垫底,因为它是唯一一项"在大部分近景里根本看不见"的
 *  特征,而且参考图里那张全身像本来就在管它。
 *
 *  上限定在**清单长度**(9 项):锚点句的用处是"给模型一个可锚的具体特征",
 *  不是把脸重述一遍。再多才又会变回那份 token 清单 —— 也就是这一层要治的东西。
 *  ==================================================================== */
const ANCHOR_KEYS = [
  'face',
  'hair',
  'eyes',
  'brows',
  'noseMouth',
  'facialHair',
  'faceMarks',
  'marks',
  'build'
] as const
const ANCHOR_MAX = ANCHOR_KEYS.length

function inline(s: string | undefined): string {
  return (s || '').replace(/\s+/g, ' ').trim()
}

/**
 * 角色设定 → 一小段身份锚点句。
 *
 * 入参刻意只声明"有一个 fields"而不是 import Character:这个模块是纯函数层,
 * 少一个类型依赖就少一圈耦合。任何带 fields 的角色卡都能直接传进来。
 *
 * @returns 逗号分隔、最多 5 项;没有结构化字段(加字段之前的老角色)时返回空串 ——
 *          那种角色仍然靠参考图锁脸,而不是退回全量描述。
 *          **这里不退回 characterFaceDesc 是有意的**:老角色的 desc 里什么都有
 *          (身份、性格、穿什么),把它当锚点句用等于把治好的病再请回来。
 */
export function characterAnchor(c: { fields?: unknown } | undefined): string {
  const f = c?.fields as Record<string, unknown> | undefined
  if (!f || typeof f !== 'object') return ''
  return ANCHOR_KEYS.map((k) => inline(typeof f[k] === 'string' ? (f[k] as string) : ''))
    .filter(Boolean)
    .slice(0, ANCHOR_MAX)
    .join(', ')
}

/**
 * 性别那一栏。**单独给,不并进锚点句** —— 那条取舍有它的道理,而且这里不需要推翻它:
 * 见 partLine 的说明(只有"画面里没有脸"的那一档才用得上这一位)。
 *
 * 它是 charSpec 里的必填项(enumValues: female / male),所以正常角色都不会是空串;
 * 加结构化字段之前的老角色才可能空着,那时 partLine 只留不带性别的那半句。
 */
export function characterGender(c: { fields?: unknown } | undefined): string {
  const f = c?.fields as Record<string, unknown> | undefined
  if (!f || typeof f !== 'object') return ''
  return inline(typeof f.gender === 'string' ? (f.gender as string) : '')
}

/**
 * 特写那一档:这一格是**那个人身上的一个局部**。
 *
 * —— 为什么非有它不可(用户 2026-10-06 报的那个)——
 *
 * "角色明明是女生，可是生成的那只手很粗糙。"根因不在手上,在**锚点句管不到手**:
 * 那七项全是头部与体型(脸、头发、眼睛、眉毛、鼻嘴、胡须、体型)。这一档的画面里
 * 往往没有脸 —— 于是提示词里唯一能说明"这个人是谁"的那一段整段失效,参考图里
 * 那张脸也一起失效(模型要画的是手)。它退回自己的缺省:一只手,而且是它画过最多
 * 的那种手。
 *
 * —— 为什么不干脆把性别加进锚点句 ——
 *
 * 那条取舍是**写过、也测过的**:「性别不进锚点句 —— 它由参考图和脸型特征决定,
 * 写出来只会变成标签」。那个判断对**画面里有脸**的那些图是成立的,失效的只是
 * "没有脸的那一档"。而加进锚点句会改掉这条路上**每一张**图,包括那绝大多数
 * 本来不必改的 —— 所以只补这一档,一个字的代价也不外溢。
 *
 * 后半句("same age / skin / build, not a generic stand-in")不需要任何结构化字段:
 * 它治的是"退回一只通用的手"这件事本身。所以**没有性别也留着它** ——
 * 老角色一样受用(皮肤与年龄那一层由 face 那一项兜着,见 charSpec 对 face 的说明)。
 */
export function partLine(gender: string): string {
  const sex = inline(gender)
  return (
    'a detail of that same person ' +
    `\u2014 ${sex ? `${sex}, ` : ''}same age, same skin and same build as the reference, ` +
    'not a generic stand-in'
  )
}

/**
 * 这一刻的心情,落到脸上的那一句。
 *
 * **一个词,不做词表** —— 词表一旦出现就要维护,而模型一出表外词就出错
 * (与 chatTags 那边"一个词,不做分类枚举"是同一条决定)。现在的图像模型对
 * `tired expression` 这类短语本身就能理解,不需要我们先替它翻译一遍。
 *
 * 后半句"not acted out"是冲着具体毛病去的:只写 `angry`,模型很容易把它
 * 演成一个**动作**(摔东西、吼)—— 而这里要的是**神情**,身体那件事由
 * action 层与 negative 层管,轮不到情绪插手。
 *
 * 措辞本身就是效果的一部分(与 ENHANCE_PROMPTS / CHAT_RULES 同一条),
 * 落地按实测调 —— 但**不要**在这里加一份"哪些词算情绪"的清单。
 */
export function expressionLine(word: string): string {
  return `a ${word} expression on the face, not acted out`
}

/* ===== 场景里已经说了什么 =============================================
 *  模板"只补不覆盖"的全部依据。宁可漏判(以为没写、于是补一句)也不能误判,
 *  所以词表取窄:只认那些**一旦出现就基本可以确定**该位已有内容的词。
 *
 *  为什么同时认中英文:这张图的场景串是聊天模型写的,它跟着用户的语言走
 *  (见 CHAT_RULES 的"用用户那种语言"一条),中文对话里就是中文串。
 *  ==================================================================== */
function mentions(text: string, en: RegExp, zh: string[]): boolean {
  /* 英文用词边界(免得 "sunny" 被判成 sun、"lens" 被判成"提到镜头");
     中文没有词边界,子串命中即可 —— 中文里"黄昏"出现在任何位置都是黄昏 */
  if (en.test(text)) return true
  return zh.some((w) => text.includes(w))
}

/** 光:已经写了光就不补 —— 这是"只补不覆盖"里最要紧的一位 */
const LIGHT_RE = /\b(light|lighting|lit|glow|glowing|backlit|rim light|silhouette|shadow|shadows|sunlight|moonlight|lamp|lantern|candle|neon|beam)\b/i
const LIGHT_ZH = ['光', '灯光', '阳光', '月光', '影子', '阴影', '逆光', '烛光', '霓虹', '照亮']

/** 镜头/景深:已经写了就不补,免得两个焦段打架。
 *
 *  **"特写 / close-up / macro" 从这一条里拿掉了**(2026-10-06)。从前它们算
 *  "已经写了镜头",于是场景一写特写,lens 那一句就整条不再补 —— 而那一句
 *  正是"把主体从背景里剥出来"的那句,恰好是特写最需要的一句。它们其实是
 *  **景别**的词,现在归 frameFromScene 管(见 FRAMING)。 */
const LENS_RE = /\b(lens|focal|\d{2,3}\s*mm|bokeh|depth of field|shallow focus|blurred|blurry|out of focus|telephoto|wide[- ]angle)\b/i
const LENS_ZH = ['镜头', '焦段', '景深', '虚化', '模糊', '广角', '长焦']

export interface SceneSlots {
  light: boolean
  lens: boolean
}

/**
 * 场景串里还没给出的位。模板只补 true 的那几个。
 *
 *  **为什么没有"环境"这一位**:环境是**事实**,该由场景自己说("在阳台"),
 *  而"前景 / 中景 / 远景"是**相机原理**,两者不冲突 —— 场景说了地点,
 *  照样需要一句"画面要有纵深"(那正是"人和环境融不进去"的药)。
 *  把纵深也做成"没说才补",结果是几乎每个场景都提过窗、桌、墙,
 *  于是这一句永远不出现,等于没有。
 *
 *  **也没有"时间/天气"**:那两样是事实,不是修辞。场景没说几点,
 *  模板猜"黄昏"就可能和对话里的时间矛盾(它明明在值夜班)。
 *  能推的只有一件事:已经在下雨时,补一句"湿的地方反光" —— 那是天气的**必然推论**,
 *  不是新事实(见 isWet 与模板的 lightWet)。
 */
export function missingSlots(scene: string): SceneSlots {
  const t = String(scene || '')
  return {
    light: !mentions(t, LIGHT_RE, LIGHT_ZH),
    lens: !mentions(t, LENS_RE, LENS_ZH)
  }
}

/** 场景里在下雨/下雪吗。只用来决定要不要补"湿处反光"那一句 */
const WET_RE = /\b(rain|rainy|raining|drizzle|snow|snowy|sleet|hail|wet|puddle|splash)\b/i
const WET_ZH = ['雨', '雪', '冰雹', '湿', '水洼', '积水']

export function isWet(scene: string): boolean {
  return mentions(String(scene || ''), WET_RE, WET_ZH)
}

/* ===== 这一张离得多近 =================================================
 *  —— 谁说了算,与视角同一套四级判据 ——
 *
 *      1. 标签说 close: / medium: / full: → 就是它(见 server/chatTags.js)
 *      2. 场景里明写"特写 / 全身 / macro…" → 按它
 *      3. 一条证据都没有 → **这一档视角的缺省景别**(见 DEFAULT_FRAME)
 *
 *  为什么第 3 条不是一个统一的默认值:缺省值该是"这种照片通常长什么样"。
 *  自拍是臂展举着的,半身是常态;朋友拿手机替你拍的那张,人整只都在画面里。
 *  给两者同一个默认值,等于把其中一半的图改掉 —— 而这一位不存在时,
 *  出来的提示词必须**逐字等于从前那三句**(见 FRAMING 的说明)。
 *
 *  —— 词表为什么取窄 ——
 *
 *  与 isSelfie / isThirdShot 同一条纪律:宁可漏判(落回缺省),也不误判
 *  (把"全身心投入"读成全身景)。所以 "full" / "wide" / "detail" 这些
 *  **单独出现时意思不明的词一律不认**,只认连在一起就基本能确定的说法。
 *  ==================================================================== */
/* 中文没有词边界,所以中英合并成一个正则、直接 test ——
   `全身(?!心)`:唯一一个真的会撞上的常用词是"全身心投入",
   而它一旦被读成"全身景",这一张的构图就整个跑了 */
const FRAME_CLOSE_RE = /\b(close[- ]?up|extreme close[- ]?up|macro|tight on|fills the frame)\b|特写|大特写|微距|放大到/i
const FRAME_FULL_RE = /\b(full[- ]?body|full[- ]?length|full figure|whole figure|head to toe|wide shot|establishing shot)\b|全身(?!心)|从头到脚|远景|全景/i
/* 半身那一档。**它不能省** —— 三档里少了它,`FRAMING.third.medium` 就成了
   一段谁也走不到的死代码(他拍那一档的缺省是全身,而"半身"没有任何别的入口)。
   `半身` 会顺带把"上半身"也命中 —— 这是对的,那句话说的就是取景到腰以上;
   真正会误伤的是"半身裙"这类词,而它猜错的方向(更近一点)正是可接受的那一侧 */
const FRAME_MEDIUM_RE = /\b(half[- ]?body|half[- ]?length|waist[- ]?up|from the waist|mid[- ]?shot)\b|半身|腰部以上|齐腰/i

/**
 * 场景里明说的景别。认不出来返回空串 —— **调用方据此落回缺省**,
 * 而不是在这里替它挑一个(与 isSelfie 同一条分工)。
 *
 * 两边都命中时**特写赢**:一句里同时出现"全身"和"特写"多半是模型在写
 * "全身照里的一个特写"这类绕的话,而用户报的毛病是一律拍得太远 ——
 * 猜近的那一侧是他能接受的那一侧。半身排在最后:三档里它是最弱的一条断言
 * (说"全身"的画面里通常不会同时说"半身",反过来也一样)。
 */
export function frameFromScene(scene: string): ChatFrame | '' {
  const t = String(scene || '')
  if (FRAME_CLOSE_RE.test(t)) return 'close'
  if (FRAME_FULL_RE.test(t)) return 'full'
  if (FRAME_MEDIUM_RE.test(t)) return 'medium'
  return ''
}

/** 这一档视角**通常**是多近。它只在标签与场景都没说时兜底,所以它同时是
 *  "这一位不存在时"的行为(自拍/空镜那三句的机位句本来就是半身/中景,
 *  他拍那句本来就是全身)—— 这一位加进来,一张图都不该被它改掉 */
const DEFAULT_FRAME: Record<ChatShot, ChatFrame> = {
  selfie: 'medium',
  third: 'full',
  scene: 'medium'
}

/** 标签 > 场景 > 这一档的缺省。**判据只有这三条,没有第四条** ——
 *  摄影指导也改不到它(不在 DIRECTOR_SLOTS 里),它只被告知(见 photoDirector) */
export function resolveFrame(shot: ChatShot, said: string, scene: string): ChatFrame {
  if (said === 'close' || said === 'medium' || said === 'full') return said
  return frameFromScene(scene) || DEFAULT_FRAME[shot]
}

/* ===== 三套镜头模板 ===================================================
 *  两条机位句是这一层存在的理由:**图像模型没有"自拍"这个概念**,
 *  它只有"画一个人"。能把"画一个人"掰成一张自拍的,是下面这几个具体的词。
 *
 *  每一句都写成"缺省值"而不是"必须出现":调用方按 missingSlots 逐位决定要不要。
 *  lens 那句在自拍/他拍两档都出现,是因为景深决定了**人和环境贴不贴**——
 *  这正是"人物与环境融不进去"的一半原因。
 *  ==================================================================== */
/* 垫在最末的那一条。它原本只挡"证件照"那套默认构图,2026-10-06 补进两类:
 *
 * **① 肢体画坏**(用户报的"四肢畸形、缺手少腿")。词只挑**多出来的、长错的**:
 * `no extra limbs` / 多指与连指 / 畸形或重复的手。**刻意不写 "no missing limbs"、
 * 也不写"不许在画面边缘裁到肢体"** —— 那两句会与特写那一档的构图直接打架
 * (那一档明写着"其余身体出画"),模型读到"不许缺"最省力的解法是**把镜头拉远**,
 * 而那正是这一轮刚修好的毛病。**"缺"要治在机位句上(裁切点落在关节之外),
 * 不是治在负面词上。** 负面词对 gpt-image-1 / Gemini 这类模型效力本就很弱,
 * 对认负面词的几家(豆包、万相这一档)才有实际作用 —— 所以它值一条,但不是主力。
 *
 * **② 拼贴/接触印相**。这一条有明确的来路:对话出图的参考图里有**两张 2×2 网格**
 * (见 shotViewOrder 与 api.ts 的 CHARACTER_VIEWS),而"参考图是拷贝先验"——
 * 拼贴先验最容易漏成一张多手多肢的拼版。背景图那条路早就为此把参考图砍到两张了,
 * 这里是同一件事在提示词这一侧的兜底。
 *
 * 不写 "no text":背景图那一层自己带着(见 planChatBackdrop),写两遍只是重复 */
const NEGATIVE =
  'not a character sheet, not a passport or ID photo, not centered neutral expression, not flat lighting, ' +
  'no extra limbs, no extra or fused fingers, no deformed or duplicated hands, ' +
  'not a collage, not a contact sheet, no panels'

interface ShotTemplate {
  medium: string
  /** 机位。自拍与第三人称差别最大的就是这一句 */
  camera: string
  lens: string
  light: string
  /** 场景里已经在下雨/下雪时改用这一句:只补"湿处反光"这个必然推论,不编新事实 */
  lightWet: string
  /** 纵深。**不是"没说才补"** —— 它是相机原理,与场景说了什么地点无关 */
  env: string
  /** 这个人此刻在做什么。只在场景没交代动作时补 —— 补错了比不补更糟 */
  action?: string
  /** 这一档的**硬约束**:这一张照片最要紧的那件事,谁都不许改。
   *
   *  **它不并进 camera** —— 摄影指导补机位的办法就是整句换掉 `camera`
   *  (见 lib/photoDirector 的 DIRECTOR_SLOTS),而下面这三件事都不能跟着那句话
   *  一起被换掉:
   *
   *  - 空镜:"画面里没有人"(换掉就会在风景里长出一个人);
   *  - 自拍:"相机在它自己手上"(换掉就画成别人拿相机 —— 用户 2026-10-05 报的那个);
   *  - 他拍:"**手机在别人手上**"(换掉就退回一张不知道谁拍的通用照片 ——
   *    用户 2026-10-05 的第二条要求:"要能理解自己用手机拍摄的视角,
   *    和别人用手机拍摄的视角")。
   *
   *  三者是同一件事(这一档不可让渡的那一句),所以共用**一层**、一个槽名。
   *  它不重复 camera:那句说的是"怎么拍"(臂展、前摄、手入画),
   *  这一条说的是"谁拿的相机、拿的是什么" —— 前者会被换掉,后者不会 */
  pin?: string
}

const TEMPLATES: Record<ChatShot, ShotTemplate> = {
  /* 自拍:关键是"相机在它手上"。前置摄像头、臂展距离、手臂入画、
     轻微广角畸变 —— 这四个词缺一个,模型就会退回第三人称的构图。

     取景那半句用"**从腰以上**"(2026-10-08):它与 `frame` 层的 half-body 是
     同一个距离,两处措辞必须一致 —— 从前这里写的是"头肩",而同一次请求里
     frame 层写着"半身",模型于是拿到两个不同的距离,只能挑一个信。 */
  selfie: {
    medium: 'photographic, shot on a phone front camera',
    pin:
      'the camera is in the subject\u2019s own hand \u2014 a selfie taken on their own phone at arm\u2019s length or in a mirror, not a picture somebody else took of them',
    camera:
      'selfie taken at arm\u2019s length, front camera, the face and upper body in frame from the waist up, shot from slightly above, slight wide-angle distortion, the arm holding the phone partly visible in frame',
    lens: 'shallow depth of field, background softly out of focus',
    /* 自拍的光必须落在脸上 —— 手臂挡不住的那种环境光 */
    light: 'natural light falling on the face and lighting it from one side, unposed',
    lightWet: 'overcast light with wet reflections catching on every surface, the face softly lit by it',
    env: 'the place clearly readable right behind the shoulders, close enough to touch',
    action: 'mid-moment, looking into the camera'
  },
  /* 他拍:相机在**别人手上** —— 而且那也是一部手机(用户 2026-10-05 的要求:
     "要能理解自己用手机拍摄的视角,和别人用手机拍摄的视角")。
     所以这一档的介质不是"一张照片",是**别人拿手机随手拍的一张**:机位不在它手上、
     取景随意、构图不讲究;环境要有纵深 —— 前景遮挡 / 中景主体 / 光源在画面里可见,
     这三样是"人和环境融在一起"的配方。

     刻意**不写"肖像照/写实摄影"**那类词:那会把画风推向影棚,而用户要的是
     "朋友拿手机拍了我一张"的那种照片。 */
  third: {
    medium: 'photographic, a casual snapshot taken on a phone by somebody else',
    pin:
      'the phone is in somebody else\u2019s hand \u2014 a snapshot another person took of the subject, not a picture the subject took of themselves',
    camera:
      'third-person view, hand-held phone snapshot taken by somebody else, the subject off-center with generous headroom, full figure and hands inside the frame, slight wide-angle distortion, framing casual rather than composed',
    lens: 'mild background blur, reading as a phone photo rather than a studio portrait',
    light: 'directional light with a clear source, one side of the face brighter than the other',
    lightWet: 'soft overcast light with wet reflections on the ground and walls, the subject rimmed by it',
    env: 'the scene layered with depth: something in the foreground, the subject in the middle, the rest falling away behind',
    action: 'caught mid-movement, unaware of the camera'
  },
  /* 空镜:画面里没有它本人(见 photoSelf)。模板只管"这是一张照片"与景深,
     一个字都不许提到人 —— 提到就是把"风景里凭空长出一个人"请回来 */
  scene: {
    medium: 'photographic',
    /* **"没有人"单独成一层,不并进 camera** —— 摄影指导会整句换掉 camera,
       而这一条是空镜唯一的挡人防线:换掉它就有可能在空镜里长出一个人。
       见 planChatPhoto 里那一层的槽名 */
    pin: 'a single unposed shot of the place itself, no people in frame',
    camera: 'the camera set down or held steady, an ordinary vantage point on the place',
    lens: 'shallow depth of field with a soft, readable foreground',
    light: 'light from a visible source, falling across the scene',
    lightWet: 'overcast light with wet reflections catching on every surface',
    env: 'depth in the frame: foreground, middle ground, and something further back'
  }
}

/* ===== 景别怎么改那三句 ===============================================
 *  上面 TEMPLATES 里那三句就是**这一档视角的缺省景别**(见 DEFAULT_FRAME),
 *  所以这里只登记"不是缺省的那两档" —— 缺省那一档压根没有条目,
 *  于是今天所有图的提示词**逐字不变**(这也让这次改动不可能弄坏已经对的东西)。
 *
 *  景别只改三样:**机位、景深、环境**。光与"谁拿的相机"跟它无关 ——
 *  一个特写不会换一个光源,也不会因此变成别人拿的相机。
 *
 *  —— 为什么 frame 还要单独成一层(见下面 frameLine) ——
 *
 *  因为摄影指导换机位的办法是**整句替换 `camera`**(见 photoDirector 的
 *  DIRECTOR_SLOTS)。它若写一句"广角,整个地方都看得见",上面这三句就一起
 * 被换掉了 —— 而它只拿得到一句场景,看不到用户是想要一张特写。
 *  这与视角当初被它判错是同一个坑,所以走同一条解法:**不可让渡的那一条
 *  单独成层**,它换不到(不在 DIRECTOR_SLOTS 里),只被告知(见 frameBrief)。
 *  ==================================================================== */
interface FrameOverride {
  camera: string
  lens?: string
  /** 只在特写那两档用得上:半身/全身那两句光**本来就成立**,
   *  而"一边脸比另一边亮"在拍手、拍疤的特写里是错的(那里没有脸) */
  light?: string
  env?: string
}

const FRAMING: Record<ChatShot, Partial<Record<ChatFrame, FrameOverride>>> = {
  selfie: {
    /* 特写:那四个"自拍"信号里,**臂展这一个在特写下物理上不成立** ——
       贴到眼睛那么近不可能是手臂伸直拍的。而"相机在它自己手上"这条事实
       由 `pin` 那一层不可让渡地写着(见 ShotTemplate.pin),所以这里可以放心
       把距离换成"一只手举近",剩下的三个信号(前置摄像头 / 手入画 / 轻微广角)
       一个不少 —— 单测直接钉住这三样还在。

       **一处轻微矛盾,刻意不收**:`pin` 那句里还留着 "at arm's length or in a
       mirror"(它是"谁拿的相机"那一句的举例说明)。要收掉它就得给 pin 也做一份
       景别变体 —— 那是"谁拿的相机"这条不变量的**第二份副本**,两份会漂;
       而代价还落在**每一张已经出过的自拍**上(缺省那一档就不再逐字不变)。
       权衡下来留着:它在前面二十个词的位置,紧跟着的 frame 与 camera 两层
       各自明说了"整个人出画" —— 两票对一票,且那一票说的是"手机在谁手上" */
    close: {
      camera:
        'selfie on the front camera, the phone held up close in one hand \u2014 one part of them fills the frame and the rest of the body runs off the edge, the hand holding the phone just inside the frame, slight wide-angle distortion',
      lens: 'very shallow depth of field, everything but that one part falling away',
      light: 'natural light falling across that one part, lighting it from one side, unposed',
      env: 'the place reduced to a soft wash of light and colour behind it'
    },
    /* 全身:臂展同样装不下整个人。**刻意不写"对镜"** —— 镜子是场景里的一件
       东西,场景没说它就不该被凭空添上(与"不许编时间/天气"同一条纪律)。
       `pin` 那层的说法是"at arm's length **or in a mirror**",两条路都留着,
       挑哪条交给出图模型 */
    full: {
      camera:
        'full-length selfie \u2014 the phone held up in one hand, the whole figure from head to feet inside the frame with a little room above and below, shot straight on, slight wide-angle distortion',
      lens: 'shallow depth of field, the room soft behind the whole figure',
      env: 'the place readable around the whole figure, floor and ceiling both in the frame'
    }
  },
  third: {
    /* 他拍那一档的缺省**就是全身**(见 DEFAULT_FRAME),所以这里补的是
       比缺省更近的那两档 —— 半身与特写。
       半身这一档靠"场景写着腰以上 / 半身"或标签里的 `medium:` 进得来
       (见 frameFromScene 的 FRAME_MEDIUM_RE 与 CHAT_RULES 那一句) */
    medium: {
      camera:
        'third-person view, hand-held phone snapshot taken by somebody else, the subject from the waist up, off-center with generous headroom, hands inside the frame, slight wide-angle distortion, framing casual rather than composed'
    },
    close: {
      camera:
        'hand-held phone snapshot taken from close in, one part of the subject filling the frame and the rest of them running off the edge, framing casual rather than composed, slight wide-angle distortion',
      lens: 'very shallow depth of field, only that one part sharp',
      light: 'directional light with a clear source, raking across that one part so its texture reads',
      env: 'the place falling away into blur behind that one part'
    }
  },
  scene: {
    /* 空镜那一档的缺省是中景,这里补特写与"整个地方"两头。
       人不在画面里,所以这两句一个字都不提人(见 scene 那条 pin)。
       camera 那两句刻意**不再重复"填满画面"** —— 那是上面 frame 那一层的活,
       两句说同一件事只会把提示词撑长 */
    close: {
      camera: 'the camera pushed right in and held steady on that one detail',
      lens: 'very shallow depth of field, everything but that detail soft',
      env: 'nothing beyond that detail reads \u2014 just a wash of the place behind it'
    },
    full: {
      camera: 'the camera set well back, an ordinary vantage point far enough to hold all of it',
      lens: 'deep focus, the place reading all the way to the back',
      env: 'the whole place in one view: foreground, middle ground, and the far side of it'
    }
  }
}

/**
 * 景别那一层不可让渡的话(进 `frame` 槽,摄影指导碰不到)。
 *
 * **它对人与空镜是两套说法**:空镜里没有"整个人"这回事,写"the whole person"
 * 就是给"风景里长出一个人"递刀(与 scene 那条 pin 同一个理由)。
 *
 * 这一句与 camera 那句是**一对**:camera 说"怎么拍"(推多近、镜头在哪),
 * frame 说"这一张是哪种景别"。前者摄影指导可以整句换掉,后者不能 ——
 * 所以后者必须自己站得住,不能写成"同上"。
 */
export function frameLine(self: boolean, frame: ChatFrame): string {
  if (!self) {
    if (frame === 'close') return 'a tight close-up of one detail of the place, that detail filling the frame'
    if (frame === 'full') return 'the whole place taken in at once, in one wide view'
    return 'a mid-distance view of the place: neither pushed in on one detail nor pulled back to take in all of it'
  }
  if (frame === 'close') {
    return 'a tight close-up: one detail of the subject fills the frame and the rest of them is cropped out'
  }
  if (frame === 'full') {
    return 'a full-figure shot: the whole person, head to feet, inside the frame'
  }
  /* 半身,不是"头肩" —— 他拍那一档的机位句写的是"腰以上",
     两句用同一个词才不会互相打架(见 FRAMING.third.medium) */
  return 'a half-body shot: the face and upper body, not the whole figure'
}

/* ===== 拼装 =========================================================== */

/* 场景里已经交代了动作时,别再补一句"它在做什么" —— 两句会互相打架。

   —— 这一层的偏置与其余各层**正好相反**(2026-10-08)——
   其余判据(missingSlots / frameFromScene / isSelfie)都"宁可漏判":漏判只是落回
   一个安全的默认值。这一层不是 —— 漏判的代价是**补一句与场景打架的动作**
   ("蜷在沙发里看书" 撞上模板的 "looking into the camera")。
   而中文动作极自由,十几个词的表认不出"蹲 / 趴 / 削苹果"这类说法,所以
   **中文场景一律不补这一层**:宁可不补,也不补一句错的。英文那一侧词表相对可控,
   照旧按它判。 */
const ACTION_RE = /\b(holding|sitting|standing|leaning|walking|lying|looking|smiling|laughing|drinking|smoking|reading|typing|cooking|reaching|waving|turning|dancing|running|waiting)\b/i

/** 场景里有没有汉字。**只用来挡 `action` 那一位**(见上面那段)——
 *  它是这条链上唯一一处"漏判会补出一句错话"的判据。
 *  汉字之外还覆盖日文汉字:那边是同一个毛病(词表认不出,漏判即补错) */
const HAN_RE = /\p{Script=Han}/u
function hasHan(scene: string): boolean {
  return HAN_RE.test(String(scene || ''))
}

/** 这一位只在**英文**场景里判 —— 中文那一侧由 `hasHan` 直接挡掉,所以这里没有中文词表 */
function hasAction(scene: string): boolean {
  return ACTION_RE.test(String(scene || ''))
}

/**
 * 这一张该怎么拼。
 *
 * @param scene  模型给的场景描述(已由 server/chatTags.js 收敛成一行)
 * @param self   它是不是在画面里。由标签的前缀回答(`self:` / `selfie:` 都在画面里)
 * @param anchor 角色的身份锚点句(characterAnchor)。空串表示这个角色没填过设定 ——
 *               这时**不要**退回全量描述,参考图仍然锁得住脸
 * @param shot   **这一张谁拿的相机**,由标签直接给(`selfie:` / `self:` 前缀,
 *               见 server/chatTags.js)。不传就按场景文本判、再不行按默认
 * @param frame  **这一张离得多近**,由标签直接给(`close:` / `medium:` / `full:`)。
 *               不传(或给了认不出的词)就按场景文本判、再不行按这一档视角的
 *               缺省景别(见 resolveFrame 与 DEFAULT_FRAME)。
 *               它与 shot 一样**只由这一层定死** —— 摄影指导改不到,
 *               只被告知(见 photoDirector 的 frameBrief)
 * @param gender **这个角色的性别**(见 characterGender)。只在特写那一档用得上 ——
 *               它是"画面里没有脸"时唯一还成立的身份特征(见 partLine)。
 *               空串 = 没填过(老角色),那时 partLine 只留不带性别的那半句
 * @param mood   **发这条消息时它的心情**(就是那条消息末尾那枚 `[mood:word]`,
 *               见 server/chatMood.js)。它落在 expression 那一层 ——
 *               "这一刻它脸上是什么神情"。空串 / 形状不合法 = 这一层不拼
 *
 * —— 视角是谁定的(2026-10-05 改过一次) ——
 *
 * `self` 只回答"画面里有没有人",回答不了"谁拿的相机"。这个判断先后换过两次主人:
 *
 * 1. **最初**:拿 isSelfie() 的词表在场景串里找"自拍",找不到就当第三人称。
 *    问题是聊天模型写场景时通常不写"自拍"这两个字 —— 它写"我在阳台"
 *    (设计文档里的例子就是 `[photo:self:me on the balcony, hair down]`)。
 *    于是**绝大多数本该是自拍的图都落到了第三人称**;
 * 2. **后来**:改由摄影指导(一次文本调用)判。可它只拿得到那一句场景、
 *    看不到对话,信息比聊天模型**更少** —— 它同样只能猜,而且猜出来的
 *    "third" 还会盖掉场景里明写的"自拍"。用户的原话:
 *    "对于自拍的理解总是不好,老是会生成他拍视角的图片";
 * 3. **现在**:由**聊天模型自己**在标签里说(它才知道自己在描述什么),
 *    见 server/chatTags.js 的三个前缀;它没说时才退回词表,再不行**默认自拍**。
 *
 * —— 为什么默认是自拍,而不是沿用原来的"默认第三人称" ——
 *
 * 原来那条默认值的理由是"猜错成自拍(一张举着手机的怪图)比猜错成他拍代价大"。
 * 那是**没有数据时的直觉**,而实测的结论正好相反:角色给用户发一张自己的图,
 * 本来就是"你看我"这个动作 —— 用户 2026-10-05 明确说老是出他拍是错的。
 *
 * 四级判据,先命中的赢:
 *
 *     1. 标签说 selfie: / third: → 就是它(模型对"谁拿的相机"的直接回答)
 *     2. 场景里明写自拍(mirror / arm's length / 自拍…) → 自拍
 *     3. 场景里明写"别人拍的"(taken by / 偷拍…) → 他拍
 *     4. 一条证据都没有 → **自拍**
 *
 * 第 2 条压过第 3 条:一句里同时出现两种字眼时,多半是模型在描述画面里的
 * **另一个人**("他给我拍的"想要的其实是"我在画面里"),而按自拍画错的方向
 * 恰好是用户能接受的那一侧。
 */
export function planChatPhoto(
  scene: string,
  self: boolean,
  anchor = '',
  shot?: ChatShot,
  frame?: ChatFrame,
  gender = '',
  mood = ''
): ChatPhotoPlan {
  const text = String(scene || '')
    .replace(/\s+/g, ' ')
    .trim()
  /* 没有场景就没有要画的东西。这里先收口,免得拼出 "photographic, oval face, …"
     这种只剩外貌的提示词 —— 那会画出一张没有场景的人像,而调用方本该放弃这一张 */
  if (!text) {
    return { prompt: '', useRefs: false, shot: 'scene', frame: 'medium', self, scene: '', layers: [] }
  }

  /* 画面里没有人时视角只能是空镜:**由 self 定死,不由任何人推断** ——
     一张"我看到的东西"里长出一个人,比视角选错严重得多。

     有人在画面里时按四级定:标签 > 场景写着自拍 > 场景写着"别人拍的" > 默认自拍 */
  const resolved: ChatShot = !self
    ? 'scene'
    : shot === 'selfie' || shot === 'third'
      ? shot
      : isSelfie(text)
        ? 'selfie'
        : isThirdShot(text)
          ? 'third'
          : /* 一条证据都没有:**默认自拍**(2026-10-05 改,理由见上) */
            'selfie'
  /* 景别跟着视角走:同一套四级判据,只是它的缺省值取决于视角(见 DEFAULT_FRAME) */
  const framed = resolveFrame(resolved, frame || '', text)
  const tpl = TEMPLATES[resolved]
  /* 非缺省景别那几档对机位/景深/环境的覆盖。**缺省那一档没有条目** ——
     于是这一位不存在时,下面每一句都还是原来那一句(见 FRAMING) */
  const over = FRAMING[resolved][framed]
  const miss = missingSlots(text)
  const spec = inline(anchor)

  /* —— 分层是要紧的,不是排版 ——
     每一层前面那句都是**这一位归谁管**的标记:
     `medium` / `scene` / `anchor` / `part` / `pin` / `frame` / `negative` 不在
     DIRECTOR_SLOTS 里,
     所以摄影指导那一层(见 photoDirector.applyDirector)结构上就改不到它们。
     场景原文进 layers 时带的是 `scene` 槽 —— 它永远原样保留,不改写 */
  const layers: ChatLayer[] = [
    ['medium', tpl.medium],
    ['scene', text]
  ]
  /* 锚点句排在场景之后:它是"这个人是谁"的约束,不是这一张的内容。
     只有它在画面里时才拼 —— 这正是把风景画成人的原因(见文件头) */
  if (self && spec) layers.push(['anchor', spec])
  /* 这一刻的心情**写在脸上**,紧跟在"这个人是谁"之后 ——
     锚点句立的是"是谁",这一层给的是"此刻什么样":先是谁,再是什么样子。
     两个护栏,都与上面那几条同源:
     - **画面里得有人**(self):一张空镜里没有脸,与锚点句同一个开关;
     - **特写那一档不拼**:那一档的画面里常常只有一只手、一片布料,请模型
       "在脸上写出神情"就是请它把一张脸画进来,与"一个局部填满画面"正面打架 ——
       正是 action 层在那一档被去掉的同一条理由。
     词不合法也不拼(见 moodWord):它是模型自由写的,而这个值绕了一圈从库里
     回来 —— 认不出就什么都不做,与 toneWithMood 的"绝不猜"同一条纪律 */
  const feel = self && framed !== 'close' ? moodWord(mood) : ''
  if (feel) layers.push(['expression', expressionLine(feel)])
  /* 特写那一档再补一句"这一格是那个人身上的局部"(见 partLine)。
     紧跟在锚点句之后:两者说的是同一件事("这个人是谁"),而**锚点句那七项
     全是头部特征** —— 这一档的画面里往往没有脸,它是那一段失效时唯一的接续。
     没有它,拍手就是"一只手",而不是"这个人的手" */
  if (self && framed === 'close') layers.push(['part', partLine(gender)])
  /* 这一档的硬约束垫在机位之前,而且是独立一层(见 ShotTemplate.pin):
     摄影指导换得掉 camera,换不掉这一层 ——
     空镜靠它挡住"风景里长出一个人",自拍靠它挡住"画成别人拿相机",
     他拍靠它挡住"退回一张不知道谁拿手机的照片" */
  if (tpl.pin) layers.push(['pin', tpl.pin])
  /* 景别也单独成层,理由与 pin 一样(见 FRAMING 的说明):摄影指导换机位是
     整句替换,而"这一张是特写"是**意图**,不是它可以优化的工艺 */
  layers.push(['frame', frameLine(self, framed)])
  layers.push(['camera', over?.camera ?? tpl.camera])
  if (miss.lens) layers.push(['lens', over?.lens ?? tpl.lens])
  if (miss.light) {
    /* 场景没说光时,先看它说没说不好的天气:下雨/下雪是**已经给出的事实**,
       而"湿的地方反光"是这个事实的必然推论 —— 补它不算替场景编新事实,
       却正好把光带进画面(阴天平光下,这是最容易丢的一种光)。
       那两句与景别无关,所以**湿的那一路不走景别的覆盖** ——
       一处光不会因为推近就换一个来源,而它照样能把特写照亮 */
    layers.push(['light', isWet(text) ? tpl.lightWet : (over?.light ?? tpl.light)])
  }
  /* 纵深是无条件的(见 missingSlots 的说明):它不是事实,是相机原理,
     场景说了地点照样需要这一句 —— 而它正是"人和环境融不进去"的药。
     **但"纵深"在特写下是另一句话**:那一档要的是"背景化开",不是"前景中景远景" */
  layers.push(['env', over?.env ?? tpl.env])
  /* 动作只在场景真的没交代时才补。补出来的动作是模板的猜测,
     而它比光和环境更容易和场景矛盾(场景说"靠栏杆",模板说"走在路上")。
     **特写这一档干脆不补**(2026-10-06 查这条链时发现):模板那两句是以
     "画面里有脸"写的 —— 自拍那句是 `mid-moment, looking into the camera`。
     而这一档的画面里常常只有一只手、一片布料、一处疤:请模型"看向镜头",
     就是请它把一双眼睛画进来,与"一个局部填满画面"正面打架(与当初
     "特写 vs 半身自拍"是同一类错)。何况这一档的场景通常自己交代了动作
     ("手压在笔记上")—— 只是不在 ACTION_RE 那张表里,而漏判的代价不该是
     补一句错的。
     **中文场景也不补**(2026-10-08):中文动作太自由,那张英文表认不出它,
     而认不出的结果不是"落回默认"、是"补一句与场景打架的动作"(见 ACTION_RE)。
     半身与全身照旧补:那两档人整只在画面里,那两句成立 */
  if (tpl.action && framed !== 'close' && !hasHan(text) && !hasAction(text))
    layers.push(['action', tpl.action])
  /* 负面约束垫在最后:它挡的是"证件照"那套默认构图,不是内容本身 */
  layers.push(['negative', NEGATIVE])

  return {
    prompt: composeChatPrompt(layers),
    /* 参考图与外貌设定同一个开关:场景照不带参考图 —— 它跟"同一张脸"无关 */
    useRefs: self,
    shot: resolved,
    frame: framed,
    self,
    scene: text,
    layers
  }
}

/** 分层 → 发出去的提示词。顺序就是权重(见文件头),空值丢掉不留空逗号 */
/* ===== 对话背景图 =====================================================
 *  沉浸页铺满屏幕的那一张。**它与"角色发的那张图"是两件事**:
 *  - 它不进消息流,所以不该按"随手拍给人的"那种形状拼 —— 它是一张**给字让位的底**;
 *  - 它要横构图、主体靠右、左边留出暗而干净的余地。参考图那一屏能读,
 *    靠的就是这个构图(而不是把照片糊掉 —— 那条路走过,把"这一场戏"整个糊没了);
 *  - 它按"当前这一场戏"生成,换一场就该换一张(编排见 App 的 ensureBackdrop)。
 *
 *  与设定图、参考图、消息里的图**各存各的**(见 idb.ts 的 chat_backdrops)-
 *  用户特意交代过:它是一份单独的图,不该和那几样混在一起。
 */
export function planChatBackdrop(scene: string, anchor = ''): ChatPhotoPlan {
  const text = inline(scene)
  /* 没有场景就没有"这一场"可画。调用方据此放弃这一张,而不是画一张没有场景的人像 */
  if (!text) {
    return { prompt: '', useRefs: false, shot: 'scene', frame: 'full', self: true, scene: '', layers: [] }
  }
  const spec = inline(anchor)
  const layers: ChatLayer[] = [
    /* 机位与**尺度**排在最前(顺序就是权重,见文件头)。
       从前这一层只说了"横构图",人多大、多远全交给后面那层"medium distance" ——
       而 medium distance 在摄影里就是半身景:一张大脸。加上场景串本身是从
       "发给你的那张照片"里抄来的("me in the back seat"),它自带"镜头就在脸前"
       的语境,两句一凑,交上来的就是那张大脸(**实测反馈**:人占比太大、而且在正中)。
       所以这一层必须把"广"写死:整个地方在画面里,人在画面里是小的 */
    [
      'medium',
      'cinematic film still, wide landscape framing of the whole place, ' +
        'the person small in the frame, camera set back across the room, made to sit behind text'
    ],
    ['scene', text]
  ]
  /* 锚点句垫在场景之后:它是"这个人是谁"的约束,不是这一张的内容 */
  if (spec) layers.push(['anchor', spec])
  layers.push([
    'camera',
    'the person is small \u2014 full figure, at most a third of the frame height \u2014 ' +
      'standing or sitting in the right third, seen from several metres away, facing left ' +
      'into the empty half; the left two thirds of the frame fall into shadow and stay ' +
      'uncluttered \u2014 words are read there'
  ])
  /* 深焦,不是浅景深:这一页要的是"这一场戏",而把房间虚掉就等于把戏虚掉了 */
  layers.push(['lens', 'deep focus, the place reading all the way to the back wall'])
  layers.push([
    'light',
    'low natural light, the brightest part of the frame is on the right near the subject'
  ])
  layers.push([
    'env',
    'the place readable around them and deep enough to feel like a room, not a studio backdrop'
  ])
  /* 负面约束垫在最末:它挡的正是"证件照"那套默认构图。
     背景图独有的几条里,**不许特写**是最要紧的一条 —— 少了它,场景里那句
     "我在车后座"会把镜头一路拉到脸上(与第一层那句"人在画面里是小的"是一对) */
  layers.push([
    'negative',
    `${NEGATIVE}, no text, no watermark, no caption, no bright cluttered left side, ` +
      'not a close-up, not a headshot, not a selfie, the face is not the subject of the ' +
      'picture and does not fill the frame, the subject is not centred and not on the ' +
      'left half of the frame'
  ])
  return {
    prompt: composeChatPrompt(layers),
    useRefs: true,
    shot: 'scene',
    /* 背景图是"整个地方都在画面里"的那一档。它不走 resolveFrame ——
       它压根不是"角色发的那张照片",景别在这里没有可判的东西(见这个函数的说明) */
    frame: 'full',
    self: true,
    scene: text,
    layers
  }
}

export function composeChatPrompt(layers: ChatLayer[]): string {
  return layers
    .map(([, value]) => value)
    .filter(Boolean)
    .join(', ')
    .slice(0, CHAT_PHOTO_PROMPT_CHARS)
}

/* —— 这一张是不是自拍 ——
 *  判据只在场景文本里。标签的前缀(见 server/chatTags.js)是**第一判据**,
 *  这里管的是"它没说,但场景自己写清楚了"的那一档 —— 两处都要认,
 *  而且**自拍那条比"他拍"那条优先**(见 planChatPhoto)。
 *
 *  词表取窄:只认**明确**的说法。认不出的由调用方落回默认,而默认现在是自拍 ——
 *  所以这里的漏判不再等于"画成他拍",只是"少一条证据"。
 *
 *  例:"taking a selfie" → 自拍;"自拍一张给你看" → 自拍;
 *      "me on the balcony" → 两条都不命中 → 默认自拍;
 *      "he took this photo of me" → 命中他拍那条。 */
const SELFIE_RE =
  /\b(selfie|self-portrait|selfie shot|front camera|front-facing camera|holding (?:my|the) phone|phone in (?:my|the) hand|mirror shot|in the mirror|arm[\u2019']?s[- ]length|wefie)\b/i
const SELFIE_ZH = [
  '自拍',
  '自拍照',
  '对镜自拍',
  '对镜拍',
  '对着镜头拍',
  '举着手机拍',
  '举着手机',
  '前置摄像头',
  '前置镜头',
  '自拍杆',
  '手臂伸出去拍'
]

export function isSelfie(scene: string): boolean {
  return mentions(String(scene || ''), SELFIE_RE, SELFIE_ZH)
}

/* —— 这一张明说了是别人拍的 ——
 *  只有**明确了"谁拿的相机"**的句子才算:有人替你按了快门、或那张照片出自
 *  别人的手。不认"看起来像被拍"这种语气 —— 那种判不出来,而判错的方向
 *  恰恰是用户报的那个毛病(把自拍判成他拍)。
 *
 *  它排在自拍那条之后(见 planChatPhoto):两边都命中时算自拍 ——
 *  一句里同时有"自拍"和"他拍"的字眼,多半是模型在描述画面里**另一个人**
 *  (比如"他给我拍的"要的其实是"我在画面里,但相机在别人手上")。
 *  真那样写的时候,标签里的 `self:` 前缀才是权威 —— 那条排在更前面。 */
const THIRD_RE =
  /\b(?:taken|shot|photographed|snapped|captured)\s+by\b|\b(?:he|she|they|someone|somebody|a friend|my friend)\s+(?:took|takes|snapped|shot|photographed|captured)\b|\bsomeone else'?s (?:camera|phone)\b|\bcandid\b/i
const THIRD_ZH = ['别人拍', '他拍', '她拍', '旁人拍', '朋友拍', '被人拍', '偷拍', '抓拍', '路人帮拍', '不是自拍']

export function isThirdShot(scene: string): boolean {
  return mentions(String(scene || ''), THIRD_RE, THIRD_ZH)
}

/* ===== 尺寸与参考图 ===================================================
 *  两个查表:尺寸由 shot 决定,参考图由 shot + frame 决定。它们放在这里而不是
 *  调用方,是因为"自拍该竖一点"与"特写不该拿全身像当参考"是同一个决定的
 *  两种表现 —— 都属于"这一张怎么拍"。
 *  ==================================================================== */

/** 这一张想要的画幅比例(宽/高)。挑尺寸时按它找最接近的一档 */
export function shotRatio(shot: ChatShot): number {
  /* 有人竖、空镜横。方框是两者都不想选时的兜底,不是默认 */
  if (shot === 'scene') return 3 / 2
  return 2 / 3
}

/** 参考图按镜头挑:先取哪张视图、再按什么顺序补。
 *  自拍/半身以正面为主(它就是要看正脸),全身那张打头才交代得住体型与服装轮廓。
 *  值必须与 types.ts 的 CharacterViewKind 一致 —— 写错一个键不会报错,
 *  只会静静地少一张参考图(所以单测直接断言这张表)
 *
 *  —— 景别对这一侧的影响(2026-10-06 补)——
 *
 *  这一位从前只改机位/景深/环境那三句,**参考图一动不动** —— 于是"特写"推到了
 *  眼睛上,手上给模型看的仍是正面全身与半身那几张。两条证据说明这一侧必须跟着走:
 *  - 参考图在图像编辑那条路上是**最强的机位来源**(见 api.ts 的 REF_IDENTITY_ONLY
 *    与 2×2 网格那两条注释):i2i 的默认行为就是保住输入的构图,一句"凑近"拗不过
 *    一张"整个人在画面里"的参考;
 *  - 背景图那条路已经量过一次(见 backdropViewOrder):发出去的四张里有三张头脸,
 *    模型跟着把镜头拉到脸上 —— 反过来同样成立。
 *
 *  所以只修**两端**,中间那一档不登记:
 *  - 全身:全身像必须打头(与他拍那一档的默认同一条理由);
 *  - 特写:全身像摘掉,正面像打头、closeups 紧跟;
 *  - 半身:不登记 —— 它夹在两端之间,而他拍那一档的默认本来就拿全身像打头。
 *
 *  **不登记的那一档逐字等于这一位不存在时的顺序** —— 与 FRAMING 是同一条纪律:
 * 老消息、认不出的说法、以及这条路上的绝大多数图,代价为零。
 *
 *  —— detail(四个头角度)全面退出参考图(2026-10-08)——
 *
 *  五张设定图里**三张是 2×2 网格**(detail / closeups / body),只有两张是单张人像
 *  (front / full)。而参考图在 i2i 那条路上是"拷贝先验":给它一张网格,它就多一份
 *  把画面排成多格、多人、多手的先验 —— 这是"畸形"的一大来源。负面约束里那三条
 *  (not a collage / not a contact sheet / no panels)挡的就是它,但负面词对
 *  gpt-image / Gemini 一类模型效力很弱,兜不住。
 *
 *  所以摘掉**语义离"随手拍"最远、又纯是网格**的那张:`detail` 是四个头角度
 *  (左右正侧 + 上下俯仰),五张里只有它"是为了建模这张脸"而画的,不是任何一张
 *  随手拍的样子。(close 那条注释里本来就写着"若日后特写开始漏出四格版式,第一个
 *  该摘的是 detail" —— 这里只是把它兑现。)
 *
 *  **同时把 body 从非特写那两条里移掉**:它本来就排在第五、上限四张,取不到它;
 *  留着的话,detail 一摘它就会顺势顶上第四位 —— 网格数一张不减。它在特写档仍然进
 *  (那才是加它的理由)。
 *
 *  结果:非特写档 2 张网格 → 1 张;特写档 3 张 → 2 张。发出的张数 4 → 3,摘掉的
 *  是"最不像随手拍"的那一张。
 *
 *  **这一改动要拿真图 A/B 验收** —— 畸形是概率问题,单张说明不了什么。
 *  detail 仍会生成、仍在角色页显示;创作区那条路(charRefSrcs 不传 order)照旧用它,
 *  这里只改了**对话出图挑哪几张**。 */
const FRAME_REF_ORDER: Partial<Record<ChatFrame, string[]>> = {
  /* 全身:身高体型与服装轮廓只有那一张交代得住。两条视角这一档用同一份顺序 ——
     取景是"离得多近",与谁拿的相机无关 */
  full: ['full', 'front', 'closeups'],
  /* 特写:**三张**,全身出局、肢体那张进来(2026-10-06):
     - 全身像出局 —— 它把取景往回拽,与这一档正相反(见上面第二条证据);
     - **body 进来** —— 这一档的画面里常常没有脸(手、脖子、肩),而锚点句那七项
       全是头部特征:那时"这个部位长什么样"在提示词里没有依据,参考图里也只有
       closeups 那四分之一格;
     - **正面像打头** —— 它是整条链的锚,又是这几张里唯一一张**单张**人像。
       头一张不留给带版式先验的网格,与背景图那条路的取舍同源;
     - closeups 紧跟第二 —— 眼、皮肤与脸上的标记、手、面料那几格正是特写的
       **内容**,少了它只能凭空编(见 api.ts 里这张图的来由)。 */
  close: ['front', 'closeups', 'body']
}

/**
 * @param frame 这一张离得多近。**只影响两端**(见 FRAME_REF_ORDER)——
 *              不传、或传中间那一档,顺序逐字等于从前
 */
export function shotViewOrder(shot: ChatShot, frame?: ChatFrame): string[] {
  const byFrame = frame ? FRAME_REF_ORDER[frame] : undefined
  if (byFrame) return byFrame
  if (shot === 'third') return ['full', 'front', 'closeups']
  return ['front', 'closeups', 'full']
}

/** 背景图拿哪几张设定图当参考。
 *
 *  **只留两张**:全身像打头(背景图里那个人是小的,交代身形与服装靠的就是它),
 *  正脸跟一张管"还是同一个人"。刻意**不发 detail / closeups 那两张 2×2** ——
 *  它们是头肩与面部的网格,四格里全是大脸:模型拿到这种参考,交上来的常常
 *  就是一张大脸居中(与它同一条路上那两句提示词正面冲突)。
 *
 *  这不是"参考图越少越像"的问题:背景里那张脸只占几十像素,likeness 由锚点句
 *  与这两张兜着已经够;而构图一旦跑偏,整张图就没法用了 */
export function backdropViewOrder(): string[] {
  return ['full', 'front']
}

/** 挑不出任何一档比例时的兜底:交给上游自己定 */
export const CHAT_PHOTO_SIZE_FALLBACK = 'auto'

/**
 * 这一张该发什么尺寸。
 *
 * 为什么不能继续用 `sizeForVendor(cfg, 'auto')`:那条路对只认固定枚举的厂商
 * 会退到 `allowed[0]`,通常是 1024×1024 —— 横着拍的窗、竖着站的人全被塞进方框。
 * 这张图该多大由**场景**决定,而 shot 就是场景的类型。
 *
 * @param candidates 厂商不认尺寸时给的那组常用值(api.ts 的 FREE_SIZES),
 *                   当前实现里不会走到(见下),留着是为了调用方能看着一处读完整条判断
 *
 * 两条取舍:
 * 1. **不挑 'auto'**。'auto' 是"上游自己定比例",而这张图的取景正是我们在决定的
 *    东西 —— 挑回 'auto' 等于把自己刚做的决定又交出去。所以先在去掉 'auto' 的
 *    候选里按比例挑;只有**一个显式比例都没有**时才退回 'auto'(那时确实没得挑)。
 * 2. 空字符串返回 'auto' 而不是 '' —— 调用方据此发请求,不该发一个空值出去。
 */
export function chatPhotoSize(allowed: string[], shot: ChatShot, autoOk: boolean): string {
  const list = Array.isArray(allowed) ? allowed : []
  const explicit = list.filter((s) => /^\d{1,5}x\d{1,5}$/i.test(String(s)))
  const best = sizeClosestTo(explicit, shotRatio(shot))
  if (best) return best
  /* 一个显式比例都没有:认 auto 的厂商就交给它,不认的用第一档兜底 */
  return autoOk && list.includes(CHAT_PHOTO_SIZE_FALLBACK)
    ? CHAT_PHOTO_SIZE_FALLBACK
    : list[0] || CHAT_PHOTO_SIZE_FALLBACK
}
