/* ===== 角色设定的那份行定义 ============================================
 *  "角色是什么"这件事只有一份权威定义 —— 就是这个数组。它同时决定:
 *
 *   1. 起稿提示词里那几行的**正文**（`Name: <...>` 一路到 `Boundaries: <...>`）；
 *   2. `exactly N lines` 里那个 N；
 *   3. "…… must always have a value" 那句枚举；
 *   4. 前端解析回填时的**标签 → 字段**对照表（见 src/api.ts 的 parseCharacterDraft）；
 *   5. 前端字段顺序 / 必填枚举 / "哪些只喂设定图"（见 src/api.ts 的 CHAR_FIELD_ORDER）。
 *
 *  为什么非得收成一份:在这之前,行数、行正文、必填枚举在这两个提示词里
 *  **各写了一遍**（character 与 vision 两份），前端还有第三份标签表、
 *  第四份字段顺序。加一栏要改六处,而漏掉任何一处**都不会报错** ——
 *  表现只是"模型少回一行,那个字段静静地空着"。这类静默失配比崩溃难查得多。
 *
 *  改这个数组时唯一还要跟手的是 src/types.ts 的 CharacterFields / CharacterPersona：
 *  两边的键必须一一对应,单测会把关（见 src/lib/characterSpec.test.ts）。
 *
 *  它跑在 Node 里(server/index.js)也被前端 import(src/api.ts 要那张标签表),
 *  所以**只能是纯数据与纯函数**:不碰 fs、不碰 process、不碰任何 Node API。
 *  -------------------------------------------------------------------- */

/**
 * 一行的定义。
 *
 * - `group`   name / field（长相） / persona（人格，只服务对话）
 * - `key`     它在 CharacterFields / CharacterPersona 里的键（name 那行对 CharacterDraft.name）
 * - `label`   提示词里那行的标签,也是前端解析时认的那个词。
 *             **改它等于改协议** —— 前端是按去掉非字母后的标签查表的。
 * - `desc`    `<...>` 里那句"这一栏该写什么"。两种起稿各要一句话时给对象
 * - `always`  必须有个值（进 "… must always have a value" 那句枚举）
 * - `sheetOnly` 只喂设定图、不进普通创作提示词（见 src/api.ts 的 characterFaceDesc）
 * - `enumValues` 模型只能从这几个词里挑一个（与 gender 同一条理由：别让它自己编）
 */
export const CHAR_SPEC_LINES = [
  {
    group: 'name',
    key: 'name',
    label: 'Name',
    always: true,
    desc: 'a short name or callsign for this character, one to three words, no quotes'
  },
  /* 风格排在最前:它管的是"用哪种媒介画",比这张脸是谁更靠上一层 ——
     而且它是那个**唯一能被文字左右、又必须在五张设定图之间保持一致**的东西。
     以前它藏在 Identity 里(那句提示词原话是 "plus the overall style"),
     用户看不见、也没法校对,模型写没写、写对没有全靠运气 */
  {
    group: 'field',
    key: 'style',
    label: 'Style',
    always: true,
    enumValues: ['photorealistic', 'anime', 'illustration', '3d render', 'comic', 'auto'],
    desc: {
      character:
        'the medium every image of this character is drawn in: one of photorealistic, anime, illustration, 3d render or comic — or auto to follow a reference image when the idea names no medium',
      vision:
        'the medium this image is drawn in: one of photorealistic, anime, illustration, 3d render or comic — or auto when the medium is genuinely unclear'
    }
  },
  {
    group: 'field',
    key: 'gender',
    label: 'Gender',
    always: true,
    enumValues: ['female', 'male'],
    desc: 'female or male'
  },
  /* Identity 里原来还要求写 "plus the overall style" —— 风格自己成行之后那句去掉了。
     留着的话风格会被写两遍,而两处措辞一旦不一致,模型会挑一处当装饰丢掉 */
  {
    group: 'field',
    key: 'identity',
    label: 'Identity',
    always: true,
    desc: 'who this character is — role, trade and setting; never restate the gender or the style here'
  },
  {
    group: 'field',
    key: 'face',
    label: 'Face',
    always: true,
    desc: 'face shape and bone structure, skin tone, apparent age'
  },
  /* —— 身材那一段(Height / Build / Muscle / Posture)——
     Face 只管头,其余几项更局部,而 Outfit 是"只喂设定图"的 ——
     在这几行之前,13 项里没有任何一项描述身材,于是那张 Full body 视图
     立意虽是"交代体型与服装轮廓",体型却没有任何输入:每张图的身材都是模型
     现编的,跨图漂移最大的就是这一处。

     为什么拆成四行而不是一行:身高、骨架、肌肉、体态**各自会独立漂移**
     (一张腿长一张腿短、一张精瘦一张壮)。写在同一段里,模型会把它们平均成
     "中等身材" —— 那恰恰是这一层要治的东西。

     四行都进每一张成品(不标 sheetOnly):它们是"这个人本身"的一部分,
     全身图一个身高、场景图另一个身高,就是两个人。
     Muscle 与 Posture 允许留空(与 Face marks 同一条理由):它们常常
     在这张图里根本看不见,硬要一个值等于逼模型去编 —— 编出来的疤与编出来的
     肌肉一样,是给每张图加噪声 */
  {
    group: 'field',
    key: 'height',
    label: 'Height',
    always: true,
    desc: {
      character:
        'how tall they stand — an absolute figure or a plain comparison, e.g. about 1.7 m, average height, noticeably short',
      vision:
        'how tall they stand — infer a plausible figure from their build and proportions when the image gives no scale'
    }
  },
  {
    group: 'field',
    key: 'build',
    label: 'Build',
    always: true,
    desc: 'frame and build — e.g. slim, athletic, broad-shouldered, curvy, wiry, small-framed'
  },
  {
    group: 'field',
    key: 'muscle',
    label: 'Muscle',
    desc: {
      character:
        'how much muscle and softness they carry — e.g. lean and lightly toned, soft and unathletic, visibly strong; leave empty if the idea does not say',
      vision:
        'how much muscle and softness they carry — only when the image shows enough of the body to tell; leave empty rather than guess from a head-and-shoulders shot'
    }
  },
  {
    group: 'field',
    key: 'posture',
    label: 'Posture',
    desc: {
      character:
        'how they carry themselves — e.g. upright and open, relaxed, hunched, chin slightly forward; leave empty if the idea does not say',
      vision:
        'how they carry themselves — only when the image shows it clearly; leave empty rather than guess'
    }
  },
  { group: 'field', key: 'hair', label: 'Hair', always: true, desc: 'hairstyle, length and hair color' },
  { group: 'field', key: 'brows', label: 'Brows', always: true, desc: 'eyebrow shape, thickness and color' },
  { group: 'field', key: 'eyes', label: 'Eyes', always: true, desc: 'eye color and any eye feature' },
  { group: 'field', key: 'noseMouth', label: 'Nose & mouth', always: true, desc: 'nose and lip shape' },
  {
    group: 'field',
    key: 'facialHair',
    label: 'Facial hair',
    always: true,
    desc: {
      character: 'beard, moustache or stubble — or "clean-shaven" / "none" if it does not fit',
      vision: 'beard, moustache or stubble — or "clean-shaven" if there is none'
    }
  },
  /* 这两行允许留空是**有意的**:默认给每个人脸上添一道疤、身上加一副义体是错的。
     所以它们与上面那几行不同,不进 always 那句枚举,提示词里单独交代怎么算空 */
  {
    group: 'field',
    key: 'faceMarks',
    label: 'Face marks',
    desc: {
      character:
        'scars, moles, birthmarks, facial tattoos or facial implants — leave empty if the idea does not mention any',
      vision:
        'scars, moles, birthmarks, facial tattoos or facial implants — leave empty if the image shows none'
    }
  },
  {
    group: 'field',
    key: 'outfit',
    label: 'Outfit',
    always: true,
    sheetOnly: true,
    desc: 'clothing, armor, gear'
  },
  {
    group: 'field',
    key: 'marks',
    label: 'Marks',
    sheetOnly: true,
    desc: {
      character:
        'body scars, tattoos, implants, signature accessories — leave empty if the idea does not mention any',
      vision:
        'body scars, tattoos, implants, signature accessories — leave empty if the image shows none'
    }
  },
  /* —— 人格那一段从这里开始 ——
     它管的是"这个人是个什么样的人、话怎么说出来",与上面那些像素级约束是两件事,
     所以既不进任何出图提示词,也要在界面上另成一组。

     语言排在这一段的最前:它比性格、语气都更硬 —— 说错语言不是"这个人不太像",
     而是"根本不是同一个人"。默认留空 = 跟着用户走(与加这一栏之前的行为一致) */
  {
    group: 'persona',
    key: 'language',
    label: 'Language',
    desc: {
      character:
        'the language this character speaks in conversation, e.g. English, 简体中文, 日本語 — leave empty unless the idea makes it clear',
      /* 识图这一档必须单独交代:从长相推语言是最典型的刻板印象,
         而这里唯一站得住的证据是图里真的出现了字 */
      vision:
        'the language this character speaks — only when the image itself carries it, such as a sign, a badge, a uniform or lettering; leave empty rather than guess from how someone looks'
    }
  },
  {
    group: 'persona',
    key: 'traits',
    label: 'Personality',
    desc: 'what this character is like: a few traits and a disposition'
  },
  {
    group: 'persona',
    key: 'voice',
    label: 'Voice',
    desc: 'how they talk: register, sentence length, verbal habits, and any word they use for themselves instead of "I"'
  },
  {
    group: 'persona',
    key: 'address',
    label: 'Address',
    desc: 'how they address the user, and what these two are to each other'
  },
  {
    group: 'persona',
    key: 'boundaries',
    label: 'Boundaries',
    desc: 'what this character would never do or say'
  },
  /* 说话样本(2026-10-08):上面那几栏都是**描述**,而描述会被模型平均成"通用口吻" ——
     "简短、偶尔反问"写出来是一回事,照着它打字是另一回事。所以再给一栏**样本**:
     两三组"用户说 X → 它会怎么回 Y"。读它的模型照抄的是**语气**,不是话题
     (提示词里明说了这条,见 server/routes/chat.js)。

     它与 voice 是两件事:voice 是"怎么说话"的**定义**,这里是**照着说**的例子。
     一栏描述 + 一组样本,比两栏描述有效得多。

     形状收在一行:协议是每栏一行(见文件头),所以组间用 " | "、组内用 "User: … You: …" */
  {
    group: 'persona',
    key: 'samples',
    label: 'Speech samples',
    desc: 'two or three example exchanges showing how this character actually types, all on this one line: each pair written as "User: <what they say> You: <what you say>", pairs separated by " | ", invented to fit the voice above'
  }
]

/** 行数由数组算出来 —— 写在提示词里那个数字不该是人手工维护的第二份真相 */
export const CHAR_SPEC_LINE_COUNT = CHAR_SPEC_LINES.length

/** 某一组按顺序的键。前端的字段顺序、人格键序都从这儿取,不再各抄一份 */
export function charSpecKeys(group) {
  return CHAR_SPEC_LINES.filter((l) => l.group === group).map((l) => l.key)
}

/** 这一行在某个档位下该写什么。给字符串就是两档共用 */
function descFor(line, mode) {
  const d = line.desc
  return typeof d === 'string' ? d : d[mode]
}

/** 提示词里那一整块行清单（`Name: <...>` 换行到底）。两种起稿共用,只有 desc 分档 */
export function charSpecLinesText(mode) {
  return CHAR_SPEC_LINES.map((l) => `${l.label}: <${descFor(l, mode)}>`).join('\n')
}

/* "A, B, C and D" —— 英文枚举的写法（不带牛津逗号,与这句提示词原来的语气一致）。
   收成一个函数是因为它由 always 那几位算出来,而人的手写版本迟早会和数组对不上 */
function joinAnd(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "Name, Style, … and Outfit" —— 必须始终有值的那几行,按数组顺序算出来 */
export function charSpecAlwaysSentence() {
  return joinAnd(CHAR_SPEC_LINES.filter((l) => l.always).map((l) => l.label))
}

/** 某个键该从哪几个词里挑。空数组 = 自由文本 */
export function charSpecEnumOf(key) {
  const line = CHAR_SPEC_LINES.find((l) => l.key === key)
  return (line && line.enumValues) || []
}
