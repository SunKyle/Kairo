/* ===== 回复里的元数据标签 ==============================================
   模型产出不了情绪，也产出不了图片字节 —— 它只能产出**意图**。所以这两件事
   都做成"写在回复里的标签"，由这一层负责剪下来:

   - `[mood:amused]`  情绪。给界面出一枚药丸，也是朗读的语调
   - `[photo:pacing by a window at dawn]`  让它发一张图。这一枚只表达
     "想给你看什么"，真正出图在客户端(它才拿得到出图配置与参考图)

   三条纪律，缺一条就会漏给用户看:
   1. 末尾那枚走 `splitTags`（$ 锚定，绝不吃正文中间的方括号）；顶在行首、
      被正文顶到中间的那几枚走 `stripStandaloneTags`（仍以行首锚定，
      "正文在前、标签在后"一律不碰）;
   2. 流式期间半截标签必须**扣在手里**先不发(见 tailHold)，否则 `[pho` 会闪出来;
   3. 标签里的内容是**外部输入**(模型写的自由文本)。它会被拼进出图提示词，
      所以在这里就截断、压成一行 —— 越靠近边界收口越好。

   —— 2026-10 通用化(收益①：kind 注册表) ——
   以前"哪些 kind 存在"这件事散在四五个地方写死：`isTagRoom` 里的
   `p|h|ho|hot|photo|m|o|oo|ood` 前缀叉积、`head0` 的 startsWith、
   `stripStandaloneTags` 的 `(photo|mood)` 与逐类 if 分支、`splitTags` 的
   mood/photo 2×2 顺序分支、半截擦除的先后。每加一枚 kind 要在这些处各补一刀，
   且必须严格同步。现在这些都由下面那个 `TAGS` 注册表**派生**：加一枚 kind
   = 往 `TAGS` 追加一项（名字 + 各自的形状正则 + parse 归一化对象 + 扁平字段映射），
   剪取层与扣尾层**一处正则都不用再动**。公共函数(`splitTags`/`stripStandaloneTags`/
   `tailHold`)的签名与返回的扁平字段**保持不变**，调用方零改动 —— 这一版是纯重构。
   （"位置判据 → 形状判据"那一步是另一件事，见 doc/标签层通用化设计.md，本层未动。）

   单独成文件是为了测得了:它没有 IO、没有状态，只有几个正则和几行字符串处理。
   -------------------------------------------------------------------- */

/** 情绪标签:回复最末尾那枚 [mood:xxx]。
 *  容忍空格与 = 号，也容忍后面跟一个句号:模型不总写得一丝不差 */
const MOOD_RE = /\[\s*mood\s*[:=]\s*([a-z][a-z-]{1,19})\s*\]\s*[.!?]?\s*$/i
/** 收在半截上的标签(用户按了 Stop，或上游断了)。
 *  这时候**只擦不取** —— "gu" 不是一个情绪，宁可这一轮不出那枚药丸，
 *  也不出一个错的;但留在正文里的半截标签必须擦掉，那纯粹是难看 */
/* 允许词本身也被截断(`[moo` / `[pho`)—— 但只认到 3 个字母,再短的
   (`[m` / `[p`)在正经文字里太常见,宁可漏一枚半截标签也不吃掉一句人话。
   流式期间其实轮不到它:尾巴是扣着发的(见 tailHold),只有"正好停在半个
   词上"的那一下(用户按 Stop)才会走到这儿 */
const MOOD_PARTIAL_RE = /\[\s*moo[\s\S]*$/i

/** 发图意图:回复最末尾那枚 [photo:<场景>]。
 *  与 mood 不同，它带的是**自由文本**而不是枚举值，所以这里只做形状约束:
 *  长度 1..400、不含方括号(否则会把下一枚标签一起吞进来)、不含换行。
 *
 *  400 是 2026-10-04 从 120 放宽的:120 字的场景串只装得下"在哪",
 *  而时间/天气/周围有什么这些**只有聊天模型看得见**的信息一个都装不下 ——
 *  它们恰好是下游摄影指导最缺的输入(见 doc/角色配图构图与光影设计.md)。
 *  放宽之后正文的流式不受影响:扣尾是按"标签从哪开始"算的,不是按长度预留
 *  (见 tailHold)。 */
export const PHOTO_SCENE_CHARS = 400
const PHOTO_RE = new RegExp(
  `\\[\\s*photo\\s*[:=]\\s*([^\\[\\]\\n]{1,${PHOTO_SCENE_CHARS}}?)\\s*\\]\\s*[.!?]?\\s*$`,
  'i'
)
const PHOTO_PARTIAL_RE = /\[\s*pho[\s\S]*$/i

/** 把场景描述收敛成一行:连续空白压成一个空格，两端去空白，按上限截断 */
export function cleanScene(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PHOTO_SCENE_CHARS)
}

/* —— 这一张里有没有它本人、以及**谁拿的相机** ——
   有的图跟这个人长什么样无关(窗外的雨、桌上的咖啡)，有的图就是它自己。
   两者的出图条件正好相反:**带设定图**是"同一张脸"的唯一保证，而在一张风景里
   带上设定图，模型会被拽着往那个人的脸和衣服上靠 —— 画面跑偏。

   判据由模型自己写在标签里。前缀认四种写法，都不要求它一丝不差:

   1. `selfie:` / `self-portrait:` —— **它在画面里，相机在它自己手上**
      (臂展、镜子、举着手机)。剪掉标记;
   2. `third:` / `third-person:` —— **它在画面里，相机在别人手上**。剪掉标记;
   3. `self:` / `myself:` —— 纯标记，只回答"它在画面里"，相机没说。
      剪掉(它不是内容);
   4. `me:` / `me,` / `me -`，或直接以 `me at my desk` / `I'm on the balcony`
      开头 —— **代词本身是描述的一部分**，只置位不剪(剪掉就只剩 "at my desk"，
       画面里少了主语)。`\b` 保证 "meeting" / "selfish" 不会被误判。

   **第 3 种为什么不等于"他拍"** —— 它只说了"我在画面里"。谁拿的相机由客户端
   按"标签 → 场景文本 → 默认自拍"定(见 lib/chatPhoto 的 planChatPhoto)。
   2026-10-05 之前标签只有"在不在画面里"这一位，视角交给一次额外的文本调用去猜，
   大多数图被猜成他拍 —— 用户报的正是这个。现在一次说清两件事。

   —— 第五种：**没有前缀，但场景里点了身体的某个部位**(2026-10-06)——

   上面四种都要求模型**主动**写点什么(前缀、代词、或角色名)。而"拍我的手"
   这一类它三样都可能不写:中文那句"手压在笔记上，指甲还留着点上次涂的颜色"
   里没有 my、没有"我的手"、也没有角色名 —— 于是判成"画面里没有人"，
   参考图一张都不发。所以再补一条兜底:场景里出现**没有别的意思的部位词**
   (指甲 / 手腕 / 肩膀 / 皮肤 / 纹身…,nails / wrist / shoulder / tattoo…)，
   就认为那一部分在画面里。词表刻意不收"手""脚"这种会撞"手机 / 手艺 / 脚本"的
   词 —— 这条兜底宁可漏判，也不要把一扇窗当成一个人。

   —— 第二类前缀:景别(2026-10-06 新增)——

   `close:` / `medium:` / `full:` —— 这一张**离得多近**，写在"谁拿的相机"之后
   (`[photo:selfie:close:my eyes]`)。两类前缀顺序不挑，同一类只认第一枚。

   为什么"特写"必须由它来说:`close-up` 这三个字从前在链路里的**唯一作用**是
   把景深那句删掉(见 lib/chatPhoto 的 LENS_RE)，而机位那句写死的是半身 ——
   于是用户要的特写，交上来是一张臂展自拍。景别与视角是同一个性质的判断
   (用户要什么)，所以归同一层说。它没说时由场景词表判、再不行按这一档的缺省
   (见 lib/chatPhoto 的 resolveFrame)。 */
const SHOT_HEAD_RE =
  /^\s*(self-?portrait|selfie|mirror\s*selfie|third[\s-]?person|third|self|myself)\b\s*[:：,，\-–—]?\s*/i
/** 词表要小写、去掉空格与连字符之后查(见 headToken):模型写
 *  "Third-person" / "third person" 是同一样东西。空串 = 认出来了但那一项没值
 *  (`self:` 就只说"在画面里"，它不说相机) */
const SHOT_TOKENS = {
  selfportrait: 'selfie',
  selfie: 'selfie',
  mirrorselfie: 'selfie',
  thirdperson: 'third',
  third: 'third',
  self: '',
  myself: ''
}
/* 景别那一类**必须要求一个分隔符** —— 与上面那类不同:"close" / "medium" /
   "full" 本身就是常用词，不要求分隔符就会把 "close to the window" 里的那个
   close 当成景别剪掉，于是场景从"离窗很近"变成"窗"。

   长的写法必须排在短的前面:`full-length:` 若先被 `full` 吃掉，剩下的
   "-length:me by the window" 会顶在场景最前面(正则取第一个能匹配的选项,
   不是最长的那个)。 */
const FRAME_HEAD_RE =
  /^\s*(close-?up|closeup|close|macro|detail|half-?body|medium(?:[- ]?shot)?|full-?body|full-?length|full(?:[- ]?shot)?|wide(?:[- ]?shot)?)\s*[:：,，\-–—]\s*/i
/** **必须与 src/lib/chatPhoto 的 FRAME_CLOSE_RE / FRAME_FULL_RE 落到同一套档** ——
 *  这里是"模型写的词"，那里是"场景里的词"，两边认的都只能是那三档 */
const FRAME_TOKENS = {
  closeup: 'close',
  close: 'close',
  macro: 'close',
  detail: 'close',
  halfbody: 'medium',
  medium: 'medium',
  mediumshot: 'medium',
  fullbody: 'full',
  fulllength: 'full',
  full: 'full',
  fullshot: 'full',
  wide: 'full',
  wideshot: 'full'
}
const SELF_MARK_RE = /^\s*(?:me|i\s*'?m|i\s+am)\b\s*[:：,，\-–—]\s*/i
const SELF_PLAIN_RE = /^\s*(?:me|i\s*'?m|i\s+am)\b/i

/* —— 场景里点了身体的某个部位 ——
   有的模型不写前缀、也不写代词,直接写"手压在笔记上，指甲还留着点上次涂的颜色"
   (用户 2026-10-06 报的那句,原话)。中文尤其容易:它既没有 my、也没有"我的手"
   那三个字,只看上面两个正则就是"画面里没有人"。

   判错的代价不只是视角被定成空镜:**参考图一张都不发**(见 lib/chatPhoto 的
   useRefs = self),画出来自然不是这个人的手 —— 用户看到的正是这个。

   词表取窄:只收**没有别的意思**的部位词。像"脚"这种单独出现会撞
   "脚本 / 脚下"的一律不收;英文那一侧有两处例外,各带一道护栏 ——
   hand 会撞 "hand-held"(说的那台相机),那里是 `(?!-)`;
   neck 会撞 "the neck of the guitar / a bottle",那里是 `(?!\s+of)`。
   同一件事中文做不到:"手"会撞"手机 / 手艺"(它们比"一手拿着杯子"常见得多),
   所以中文那条干脆不收单字"手",靠"指甲 / 手指 / 手腕"这些去认 ——
   用户报的那句里正好有"指甲"。
   与 SELFIE_RE / FRAME_*_RE 同一条纪律:宁可漏判(落回"没有人"),也不误判
   (把一扇窗当成一个人)。 */
const BODY_PART_RE =
  /\b(hands?(?!-)|nails?|fingernails?|fingers?|fingertips?|knuckles?|palms?|wrists?|forearms?|elbows?|shoulders?|collarbones?|necks?(?!\s+of)|skin|complexion|tattoos?|scars?|freckles|lashes|thighs?|knees?|calves|ankles?)\b/i
const BODY_PART_ZH = [
  '指甲',
  '手指',
  '指尖',
  '手腕',
  '手掌',
  '手心',
  '手背',
  '拳头',
  '前臂',
  '手臂',
  '胳膊',
  '肩膀',
  '肩头',
  '锁骨',
  '脖子',
  '喉咙',
  '皮肤',
  '肤色',
  '纹身',
  '疤痕',
  '雀斑',
  '睫毛',
  '头发',
  '发梢',
  '眼睛',
  '嘴唇',
  '眉毛',
  '膝盖',
  '脚踝',
  '大腿',
  '小腿'
]

/** 模型偶尔会画蛇添足写个 scene: / view: —— 那不是内容，抹掉 */
const SCENE_PREFIX_RE = /^\s*(?:scene|view|no-?self)\s*[:：,，\-–—]\s*/i
/** 上面那条把 `no-self:` 和 scene:/view: 收在同一个壳里抹掉 —— 但前者是
 *  **明说"画面里没有人"**,与后两个只是画蛇添足不同。所以它得单独认一次:
 *  下面那条"点了身体部位就算你在画面里"的兜底不该越过它。 */
const NO_SELF_RE = /^\s*no-?self\s*[:：,，\-–—]/i

/** 前缀词 → 查表用的键:小写、去掉空格与连字符("Third-person" → "thirdperson") */
function headToken(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/[\s-]+/g, '')
}

/**
 * 拆出"场景 + 有没有它本人 + 谁拿的相机 + 景别"。
 *
 * @param raw      标签里那段自由文本
 * @param charName 角色名。**描述里点了自己的名字**也算它在画面里 ——
 *                 这是给"没写前缀但显然在说自己"的那种回复兜底。
 *                 名字为空(没传)时这条不生效。
 * @returns {{ scene: string, self: boolean, shot: 'selfie'|'third'|'', frame: 'close'|'medium'|'full'|'' }}
 *          shot 空串 = 标签没说谁拿的相机(客户端按场景判，再不行**默认自拍**);
 *          frame 空串 = 标签没说离得多近(客户端按场景判，再不行按这一档的缺省)
 */
export function parsePhotoIntent(raw, charName = '') {
  const s = String(raw || '')
  let self = false
  let shot = ''
  let frame = ''
  let base = s

  /* 两枚前缀:谁拿的相机、以及景别。顺序不挑(`close:selfie:` 也认)，
     同一类只认第一枚 —— 第二枚同名同类的多半是内容里的词，不是前缀 */
  for (let i = 0; i < 2 && base; i++) {
    const head = SHOT_HEAD_RE.exec(base)
    if (head && !self) {
      self = true
      shot = SHOT_TOKENS[headToken(head[1])] || ''
      base = base.slice(head[0].length)
      continue
    }
    const fr = FRAME_HEAD_RE.exec(base)
    if (fr && !frame) {
      frame = FRAME_TOKENS[headToken(fr[1])] || ''
      base = base.slice(fr[0].length)
      continue
    }
    break
  }

  const marked = SELF_MARK_RE.exec(base)
  if (marked) {
    self = true
    base = base.slice(marked[0].length)
  } else if (SELF_PLAIN_RE.test(base)) {
    // 代词留在描述里(它是内容)，只置位
    self = true
  }
  /* `no-self:` 是明说"画面里没有人" —— 先记下来，再连壳一起抹掉。
     下面那条身体部位的兜底不该越过它(建模时真写过 no-self 的只有这一条路) */
  const noSelfSaid = NO_SELF_RE.test(base)
  base = base.replace(SCENE_PREFIX_RE, '')
  /* 场景里点了身体的某个部位 → 那部分就是"你在画面里"(见 BODY_PART_RE 的说明)。
     放在前缀抹掉之后再判:那些壳不该影响这一个判断 */
  if (!self && !noSelfSaid && (BODY_PART_RE.test(base) || BODY_PART_ZH.some((w) => base.includes(w)))) {
    self = true
  }

  const scene = cleanScene(base)
  const name = String(charName || '').trim().toLowerCase()
  const named = !!name && !!scene && scene.toLowerCase().includes(name)
  /* 相机那一项要在画面里有人时才有意义,所以 self 为假时丢掉它。
     **景别不丢** —— "拍一张桌上的咖啡特写"里没有人,可它照样是特写 */
  return { scene, self: self || named, shot: self ? shot : '', frame }
}

/* ===== kind 注册表 ====================================================
   "有哪些 kind""这一 kind 长什么形状""剪下来之后往扁平结果里写哪几个字段"
   三件事在这里各登记一次。下面 `splitTags`/`stripStandaloneTags`/`head0`/
   `isTagRoom` 全部从这张表派生，**不再各自写死 kind 名字**。
   加一枚新 kind(music / video / …)= 往这个数组追加一项:
     - name       : 标签里的名字
     - trailingRe : $ 锚定、捕获组 1 = 内层内容的末尾形状(交给 splitTags)
     - partialRe  : "只擦不取"用的半截形状(交给 splitTags 的擦除分支)
     - parse      : (inner, charName) → 归一化意图对象(校验/拆位都关在这一层)
     - fields     : 归一化对象 → 扁平返回里的几个字段
     - empty      : 这一 kind 缺席时那几个字段的缺省值
   数组顺序有讲究:半截擦除时靠前的 kind 先判(photo 括号更长,见 splitTags 末尾)。 */

/** mood 的形状归一化:小写、两端去空白。末尾那条路已由 MOOD_RE 卡过字符集，
 *  行首那条(stripStandaloneTags)沿用从前一样的宽松(不过度收窄，保持行为等价)。 */
function parseMoodIntent(inner) {
  return { mood: String(inner || '').trim().toLowerCase() }
}

const TAGS = [
  {
    name: 'photo',
    trailingRe: PHOTO_RE,
    partialRe: PHOTO_PARTIAL_RE,
    parse: (inner, charName) => parsePhotoIntent(inner, charName),
    fields: (i) => ({ photo: i.scene, photoSelf: i.self, photoShot: i.shot, photoFrame: i.frame }),
    empty: { photo: '', photoSelf: false, photoShot: '', photoFrame: '' }
  },
  {
    name: 'mood',
    trailingRe: MOOD_RE,
    partialRe: MOOD_PARTIAL_RE,
    parse: (inner) => parseMoodIntent(inner),
    fields: (i) => ({ mood: i.mood }),
    empty: { mood: '' }
  }
]

/** name → kind 定义，供行首那条路按捕获到的名字回查 */
const TAG_BY_NAME = {}
for (const t of TAGS) TAG_BY_NAME[t.name] = t

/** 所有 kind 缺席时的扁平缺省集合（splitTags / stripStandaloneTags 拼返回值用） */
const EMPTY_RESULT = {}
for (const t of TAGS) Object.assign(EMPTY_RESULT, t.empty)

/** 行首/中段那条路的整体形状：名字候选从注册表派生，内层宽松(逐类再 parse)。
 *  判据仍然窄 —— `^\[...\]` 只吃顶到行首的标签，「正文在前、标签在后」不碰。 */
const ROW_TAG_RE = new RegExp(
  `^\\[\\s*(${TAGS.map((t) => t.name).join('|')})\\s*[:=]\\s*([^\\[\\]]*?)\\s*\\]\\s*[.!?]?(.*)$`,
  'i'
)

/** 从注册表派生"任一 kind 名字的所有前缀"(长前缀在前)—— 取代从前写死的
 *  `p|h|ho|hot|photo|m|o|oo|ood`。加 kind 时这里自动跟着长，不用手改。 */
const TAG_NAME_PREFIXES = TAGS.flatMap((t) => {
  const list = []
  for (let len = t.name.length; len >= 1; len--) list.push(t.name.slice(0, len))
  return list
}).join('|')

/** 把扁平缺省铺好，再把这一轮真取到的 kind 覆盖上去（不 mutate 入参） */
function flatten(intents, text) {
  const out = { text, ...EMPTY_RESULT }
  for (const t of TAGS) if (t.name in intents) Object.assign(out, t.fields(intents[t.name]))
  return out
}

/**
 * 把**顶在行首的**标签摘出来（不限于末尾）。
 *
 * —— 为什么还需要它 ——
 *
 * `splitTags` 只认**末尾**那一枚，那是为了不误吃正文里的方括号（`[注]`、`[1]`）。
 * 但模型并不总把标签写在最后：它会先写一句、再决定给你看张图、然后又补一句
 * 收尾的话 —— 于是那枚 `[photo:…]` 落在**中间**，`splitTags` 够不着，
 * 它会原样流给用户看（用户的原话是"为什么会有这种生成对话记录"）。
 *
 * 判据仍然窄——**标签必须顶到行首**（前面只能是空白），后面**允许**挂一句收尾话:
 * - 「正文在前、标签在后」一律不碰 —— 那是散句里的方括号,
 *   `我说[photo:x]这个词,你别多想` 靠这一条挡住;
 * - 「标签在前、正文在后」**要摘**,把标签剪掉、收尾那句原样留回气泡 ——
 *   这是 2026-10-17 用户报的走形：`[photo:selfie:medium:me sitting …bulb]这回应该能看见了`
 *   整段流出、既没被 splitTags（`$` 锚不上）也没被这一层（当时只认整行独占）吃下,
 *   于是原样上屏、photo 意图为空、出图不触发。
 *
 * 与末尾那条路的分工：末尾的标签尾巴会被 `tailHold` 扣住、由 `splitTags` 收走,
 * 走不到这里；能走到这里的就是"被正文顶到中间去 / 黏在正文前面"的那几枚。
 *
 * 每 kind 的取法、形状、扁平字段都由 `TAGS` 注册表给出；同一类出现多次时
 * **取第一枚** —— 它就是这一轮想说的事。
 *
 * @returns text 摘干净之后的正文；其余是顺手取出来的意图（photo / mood …，
 *          没有就是各自的缺省值）。
 */
export function stripStandaloneTags(s, charName = '') {
  const lines = String(s || '').split('\n')
  const kept = []
  const intents = {}
  let removed = false
  for (const line of lines) {
    /* 第 3 个捕获组 = 尾随正文：空/仅空白 → 整行吞掉（旧行为）,
       非空 → 把那段留回气泡（模型写完标签又补了一句收尾话的情形） */
    const m = ROW_TAG_RE.exec(line.trim())
    if (!m) {
      kept.push(line)
      continue
    }
    const kind = m[1].toLowerCase()
    const t = TAG_BY_NAME[kind]
    /* 同一类只取第一枚；标签照样从正文里摘掉（即便那枚没 parse 出东西） */
    if (t && !(kind in intents)) intents[kind] = t.parse(m[2], charName)
    /* 标签连它前面那个换行一起收走;但标签**后面**挂的话是它说的话,原样留回 */
    const rest = m[3]
    if (rest.trim()) kept.push(rest)
    removed = true
  }
  /* 标签常常是**空行包着**写的。抽掉那一行之后剩下连着的空行要收一收,
     否则用户看到的是一段话、两个空行、再一段话(收成一段一处空行)。
     没抽掉任何东西时一个字都不动 —— 不借着这个机会去改别人的正文 */
  const text = removed ? kept.join('\n').replace(/\n{3,}/g, '\n\n') : kept.join('\n')
  return flatten(intents, text)
}

/* 还没闭合的那一段:某个 `[` 之后既没有 `]` 也没有换行,一直延伸到末尾。
   它可能是"正在写"的标签(`[pho`、`[photo:self:me on the bal`),
   也可能只是一句人话里的方括号。

   用**贪婪**匹配取最后那个 `[`:未闭合只可能发生在末尾,取靠后的那个才不会
   把前面已经写完的标签一起卷进来(它们由 completeTagStart 负责)。

   这个候选**只有在没有完整标签可剥时才用得上** —— 见 tailHold 里的优先级。 */
const OPEN_TAIL_RE = /\[[^\]\n]*$/

/**
 * 这一截尾巴**可以放出去多长** —— 调用方发 `tail.slice(0, tailHold(tail))`,
 * 剩下那截留在手里。返回值 0 表示整截都还不能发。
 *
 * —— 要守住的不变量 ——
 *
 * 放出去的那一段里,**绝不能含有任何可能长成一枚标签的前缀**。
 * 用户看着 `[photo:self:me on the bal` 从聊天框里划过去,比图晚出来几秒难看得多。
 *
 * —— 为什么是"放到哪"而不是"扣多少" ——
 *
 * 前三版都在算"要扣住多少个字符",三版都漏了。"扣多少"这个量在标签开合之间
 * **不连续**:同一截缓冲,标签没闭合时要整段扣住,闭合之后又要放出去 ——
 * 而流到一半时根本无从判断它闭没闭合(整截缓冲**就是**那枚标签,
 * 后面还有没有正文只有流末才知道)。任何基于"闭合与否"的公式都会在那一瞬间放错。
 *
 * "放到哪"是连续的:它就是**末尾那枚标签的起点**。两个候选,有优先级:
 * 1. 末尾那几枚**已经长成形**的标签的起点(`completeTagStart`)—— 有它就返回它;
 * 2. 没有完整标签时,才看末尾那段**还没闭合**的 `[`(`OPEN_TAIL_RE`)。
 *
 * **不能把两者取更靠前的那个**:超长场景里末尾刚冒出一个 `[` 时,
 * 完整的标签还在它左边压着,而那个 `[` 因为落在正文中间没被剥干净 ——
 * 取 min 会选中它,等于把左边那枚完整标签整枚放了出去(探针抓到过)。
 *
 * —— 为什么边界要从末尾逐段剥出来 ——
 *
 * 早先这里是"从末尾往回读,允许跳过空白与标点"。那个启发式错在
 * **两枚标签相邻**的瞬间:`…balcony]` + `\n` + `[m` 里,剥 `[m` 时会把
 * 上一枚的 `]` 当成"末尾标点"跳过去,于是边界落在 `[m` 上 ——
 * 上一枚完整标签正好被挤进放出去的区间里。试出来的症状就是
 * 用户看见 `[photo:self:me on the balcony]` 从聊天框划过去。
 *
 * 所以不再猜:从末尾往前,**只在"这一段确实是一枚标签、而且它后面除了空白再无别的东西"
 * 时才继续剥**,剥不动就停 —— 边界就是停下的地方。
 *
 * @param buffer 还没发出去的那一截
 * @returns 可以放出去的长度(0 = 这一截全扣住)
 */
export function tailHold(buffer) {
  const s = String(buffer || '')
  /* 两个候选,前提写清楚:
     1. **末尾有已经长成形的标签** —— 边界就是它的起点。它一定比那个
        未闭合的 `[` 更靠左(后者在它右边),所以直接返回,不必再比;
     2. **没有完整标签** —— 才去看末尾那个还没闭合的 `[`。

     反过来"两个都算、取更靠左的那个"看着更稳,其实会错:超长场景里
     末尾刚冒出一个 `[` 时,完整的标签还在它左边压着没剥掉,
     而那个 `[` 因为落在正文中间(inner 里带换行)没被剥干净 ——
     取 min 会选中它,等于把左边那枚完整标签整枚放了出去。 */
  const closed = completeTagStart(s)
  const cut = closed >= 0 ? closed : (OPEN_TAIL_RE.exec(s)?.index ?? s.length)
  /* 再把末尾那段空白一起扣住 —— **它不是正文,而是"标签前面那个换行"**。
   *
   * 模型把标签写在单独一行,所以正文尾巴上总挂着一个 `\n`,而它**总是比标签先到**
   * (那时标签还没开这个头)。上面两条算出来的边界正好落在它后面,于是这个换行
   * 会被当成正文发出去 —— 界面上就是气泡底下多出一行空行
   * (`white-space: pre-wrap` 会把结尾的 `\n` 如实渲染出来),
   * 而收尾那次 `splitTags` 的 `trimEnd` 已经追不回来了:字早发出去了。
   *
   * 扣住它没有代价:后面一来非空白字符(或标签自己开了头),它就跟着放出去。
   * 代价只有一个:整条回复全是空白时什么都放不出去 —— 那本来也没有正文。 */
  let end = cut
  while (end > 0 && /\s/.test(s[end - 1])) end--
  return end
}

/** 末尾那几枚已经长成形的标签从哪开始。没有就返回 -1。
 *
 *  做法:**从右往左逐段剥**。每一轮取当前区段里最靠右的 `]`,
 *  找与它配对的 `[`,认它是不是一枚标签,然后把待处理区段收缩到它左边,
 *  直到某一段不是标签为止。
 *
 *  三处判断都不能省:
 * 1. `[` 与 `]` 之间必须**以某个已注册 kind 的名字开头** —— 否则它只是正文里的
 *    一个方括号(`[1]`、`[注]` 都靠这一条挡掉);
 * 2. 这一段的**右边**只允许空白或另一枚正在长的标签(`isTagRoom`)——
 *    右边夹着正文就说明它不是"末尾的那一枚";
 * 3. `]` 要在**当前区段内**找,不能全局找。 */

/** 这一段是标签的话,它开头的名字是什么;不是标签就返回空串。
 *  判据只有名字 —— 正文段落不会以某个已注册 kind 的名字开头。名字清单从 `TAGS` 来 */
function head0(inner) {
  const h = inner.trim().toLowerCase()
  for (const t of TAGS) if (h.startsWith(t.name)) return h
  return ''
}

function completeTagStart(s) {
  let cut = -1
  let end = s.length
  /* 无限回溯的护栏:正常人话里不会连着十几枚标签 */
  for (let guard = 0; guard < 12; guard++) {
    const close = s.lastIndexOf(']', end - 1)
    if (close < 0) break
    const open = s.lastIndexOf('[', close)
    if (open < 0) break
    /* 这一段右边(到当前区段末尾为止)只允许空白与**标签名的部分前缀** ——
       后者正是"另一枚标签还没写完"的样子(`\n[m` 里的 `[m`)。
       出现别的可见字符就说明右边夹着正文,这一段不是末尾标签 */
    if (!isTagRoom(s.slice(close + 1, end))) break
    const inner = s.slice(open + 1, close)
    /* 内层方括号:说明这不是一枚标签,边界停在它这里 */
    if (inner.includes('[') || inner.includes(']')) break
    /* **刻意不检查换行** —— 场景描述本身就可能很长、还会带换行,
       任何"含换行就不是标签"的规则都会把合法标签判掉,边界于是跑到
       末尾那个没闭合的 `[` 上,把整枚标签放出去(探针抓到过两次)。
       跨行散文被误当成标签的风险由下面那条 `head0` 判据挡住:
       正文段落不会以某个 kind 的名字开头。 */
    if (head0(inner) === '') break
    cut = open
    end = open
  }
  return cut
}

/** 这一段文字里是不是**只有标签结构**(没有正文)。
 *
 *  末尾往回剥的时候,已经剥掉的那部分右边常有东西,可能有两种:
 * - 一枚**已经写完**的标签 —— 剥到第二枚时就会看到它;
 * - 一枚**正在长**的标签头(`[m`、`[mood:t`、甚至只有一个 `[`)。
 *
 *  所以往右扫的时候,逐段吃掉"空白"或"一支标签段"。
 *
 *  —— 三种写法都试过,记下来免得再走一遍 ——
 *
 * 1. **逐字符判断**"`[` `]` `:` `=` 字母空白之外还有没有别的字符":
 *    简单,但区分不出 `[m`(标签头,该放行)与 `[1]`、`[注]`
 *    (正文里的方括号,该拦住);
 * 2. **只认完整标签**:漏掉 `[m`/`[` 这些"刚开个头"的形态,
 *    而它们恰恰是这个函数存在的理由;
 * 3. **要求名字后必须跟分隔符**:漏掉孤零零一个 `[`(它是下一枚标签的第一个字符,
 *    下一块增量来了才会接着长),而流式里这个瞬间每轮都会出现。
 *
 *  现在这版:名字与后面那整块都**可选**,`[photo]` 这种没有分隔符的仍然被当作正文
 *  —— 那是对的,splitTags 也不认它。名字前缀清单从 `TAGS` 派生(见 TAG_NAME_PREFIXES),
 *  加 kind 时这里自动扩,不再手写叉积。 */
const TAG_ROOM_TAG_RE = new RegExp(`^\\[(?:(?:${TAG_NAME_PREFIXES})\\s*[:=]?[^\\]]*\\]?)?`)

function isTagRoom(s) {
  let i = 0
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++
      continue
    }
    /* 一支"标签段":`[` + 名字(可只写一半)+ 可选分隔符 + 可选内容(未闭合也行)。
       **分隔符与闭合方括号都不要求** —— gap 里出现的正是"下一枚刚写到一半"
       (`[m`、`[mood:ti`),要求它们会把这个函数变成"只认完整标签",
       而那样一来第二枚还没写完时,第一枚完整标签就会被当成正文放出去。

       **换行必须排除在内容之外** —— 不然 `[^\]]*` 会一路跨过换行,
       把"超长场景里第一个换行之前的那一段"也当成标签内容,
       于是它右边判成"没有正文",边界一路往左跑到前一枚标签前面。 */
    /* `\[` 之后那一整块整体可选 —— **孤零零一个 `[` 也是合法的标签开头**
       (它是下一枚标签的第一个字符,下一块增量来了才会接着长)。 */
    /* 内容里允许换行 —— 场景描述可能很长并带换行 */
    const tag = TAG_ROOM_TAG_RE.exec(s.slice(i))
    if (tag) {
      i += tag[0].length
      continue
    }
    return false
  }
  return true
}

/**
 * 剪掉末尾的元数据标签。
 *
 * 从 `TAGS` 注册表派生末尾形状，**逐 kind、从末尾往内剥，一类只取最靠末尾的那一枚**
 * —— 这一条同时覆盖了从前 mood/photo 那 2×2 顺序分支要处理的"谁写在最后"的每种情形，
 * 且 kind 数量增加时这里一个字都不用改。顺序不挑:mood 在前、photo 在后，
 * 或反过来，都各取各的最末一枚。
 *
 * @param s        整段回复
 * @param charName 角色名。只用于判断"这一张里有没有它本人"(见 parsePhotoIntent)——
 *                 传空也能用,只是少一条兜底判据
 * @returns 扁平对象: `text` = 真正要说的话(标签连同它前面那个换行一起收走)，
 *   外加每一 kind 的字段(photo/photoSelf/photoShot/photoFrame、mood …)。
 *   某 kind 这一轮没给就是它的缺省值(见各 kind 的 `empty`)。
 *   —— 键集与重构前**逐字一致**，调用方与测试都无需改动。
 */
export function splitTags(s, charName = '') {
  const str = s || ''
  let text = str
  const intents = {}

  /* 一轮一轮从末尾往内剥:每轮扫一遍注册表，取第一个"末尾就压着它"的 kind，
     剪下来、把尾巴 trimEnd，再进下一轮。`break` 让外层重新从最末扫起，
     于是顺序天然无关、且天然是"最靠末尾那一枚赢"。 */
  for (;;) {
    let moved = false
    for (const t of TAGS) {
      if (t.name in intents) continue // 一类只取最末一枚
      const m = t.trailingRe.exec(text)
      if (!m) continue
      intents[t.name] = t.parse(m[1], charName)
      text = text.slice(0, m.index).trimEnd()
      moved = true
      break
    }
    if (!moved) break
  }

  if (Object.keys(intents).length) return flatten(intents, text)

  /* 一枚完整标签都没有:可能是半截(只擦不取)，也可能压根没写标签。
     半截的先后按注册表顺序(photo 在前 —— 它的括号更长,半截的 mood 只可能出现在它之后)。 */
  for (const t of TAGS) {
    const p = t.partialRe.exec(str)
    if (p) return { text: str.slice(0, p.index).trimEnd(), ...EMPTY_RESULT }
  }
  /* **末尾空白照样收掉** —— 这里以前是原样返回,于是
     "模型忘了写标签、但结尾带了个换行"的回复会把那行空行留在气泡里。
     它与上面几条分支做的事其实是同一件:末尾的空白不是它要说的话 */
  return { text: str.trimEnd(), ...EMPTY_RESULT }
}
