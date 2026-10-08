import { emptyCharFields, emptyCharPersona } from '../api'
import { charSpecEnumOf, charSpecKeys } from '../../server/charSpec.js'
import type { Character, CharacterFields, CharacterPersona } from '../types'

/* 角色的字段规格:**键、标签、占位示例**集中在这一处。
 *
 *  表单、详情页的规格表、右栏摘要都由它生成 —— 所以标签不会两处走样。
 *  它只有数据与几个纯函数,与页面、与 Vue 都无关,所以从 CharacterPage 里
 *  搬出来单独放(那一页 5000 行,按 列表/详情/向导/嗓音 分块拆)。
 *
 *  **哪些字段、什么顺序**不在这儿定 —— 那是 server/charSpec.js 那份行定义的事
 *  (服务端拼起稿提示词用的同一份)。这里只管"它们在界面上叫什么、给什么例子、
 *  用哪种控件",以及"只喂设定图的那几项要单独成组"。
 */

export type FieldSpec = {
  key: keyof CharacterFields
  label: string
  // 占位示例:写具体值而不是"请输入",它同时是这一栏该写什么的示范
  hint: string
}

/* 性别与风格都不进 FACE_FIELDS —— 它们不是填文字的栏位,而是**一份固定的选择**
   (原生下拉,模板单独渲染)。但它们仍然是规格:会拼进提示词、也要进详情页的规格表,
   所以都得出现在 ALL_FIELDS 里 */
const GENDER_FIELD: FieldSpec = { key: 'gender', label: 'Gender', hint: 'female' }
/* 导出是给模板用的:那一行的标签与说明都从这儿取,页面上不再抄一遍 */
export const STYLE_FIELD: FieldSpec = {
  key: 'style',
  label: 'Style',
  hint: 'Auto follows your reference image'
}

/** 两个固定选项。做成下拉而不是输入框:图像模型认的就是这两个词,
 *  而这一栏的意义恰恰是"别让模型自己挑"。
 *  选项本身取自服务端那份枚举 —— 界面能给的词与提示词能给的词必须是同一批 */
export const GENDERS: string[] = charSpecEnumOf('gender')

/* 风格那一栏。与性别是同一条理由:图像模型认的就是那几个媒介词,
   留一栏自由文字等于把这件事又交回给它去猜 —— 而它猜出来的通常是
   "半写实",那既不是动漫也不是照片,五张设定图放在一起还不一致。

   空串是 Auto,而且是**默认**:有参考图的时候风格本来就由图决定,
   这时再写死一个词就是让文字去跟图打架。所以第一项是 Auto 而不是某个画风。
   label 与 value 分开写:模型要的是 '3d render' 这种词,而界面上该显示 '3D render' */
export const STYLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Auto' },
  { value: 'photorealistic', label: 'Photorealistic' },
  { value: 'anime', label: 'Anime' },
  { value: 'illustration', label: 'Illustration' },
  { value: '3d render', label: '3D render' },
  { value: 'comic', label: 'Comic' }
]

export const FACE_FIELDS: FieldSpec[] = [
  { key: 'identity', label: 'Identity', hint: 'veteran space smuggler, worn flight jacket' },
  { key: 'face', label: 'Face', hint: 'angular jaw, warm tan skin, late 30s' },
  { key: 'hair', label: 'Hair', hint: 'short silver hair, undercut' },
  { key: 'brows', label: 'Brows', hint: 'thick straight black brows' },
  { key: 'eyes', label: 'Eyes', hint: 'glowing blue optics' },
  { key: 'noseMouth', label: 'Nose & mouth', hint: 'narrow straight nose, full lips' },
  { key: 'facialHair', label: 'Facial hair', hint: 'clean-shaven' },
  { key: 'faceMarks', label: 'Face marks', hint: 'scar over left brow' }
]

/* 身材那一组。以前只有一栏 Build,而且它一句话里同时写着身高、骨架与体态 ——
   模型于是把三件事平均成"中等身材",而这一组的全部意义正是"别让它平均":
   一张腿长一张腿短、一张精瘦一张壮,是跨图一致漏得最大的一处。

   它们和上面那组一样会进每一张成品(不标 sheetOnly),所以界面上分成两组
   只是**读法**上的分组,不影响它们去哪儿 —— 见 FORM_GROUPS 的说明

   占位符刻意**一头一尾各举一例**(清瘦 / 敦实),不预设体型:
   这四栏对男女同样适用(身高、骨架、肌肉、体态与性别无关,性别另有 Gender 一栏),
   而只给"宽肩、端肩"这类例子,会让建女性角色的用户以为这不是给自己用的。
   也**刻意不给三围那种测量式的例子** —— 这一层要的是"五张图是同一个人",
   不是给身材打分,数字喂给图像模型反而画得更歪 */
export const BODY_FIELDS: FieldSpec[] = [
  { key: 'height', label: 'Height', hint: 'about 1.7 m, or noticeably tall / short' },
  { key: 'build', label: 'Build', hint: 'slim and long-limbed, or broad and sturdy' },
  { key: 'muscle', label: 'Muscle', hint: 'lean and lightly toned, or soft' },
  { key: 'posture', label: 'Posture', hint: 'upright and relaxed, or hunched' }
]

export const SHEET_FIELDS: FieldSpec[] = [
  { key: 'outfit', label: 'Outfit', hint: 'armored jacket, neon trim' },
  { key: 'marks', label: 'Marks', hint: 'chrome right arm, engraved dog tags' }
]

/* 全部规格的完整顺序 —— 详情页的规格表、右栏摘要都按它排。
   **顺序直接取自服务端那份行定义**(它就是拼提示词的顺序),不再在这里抄一遍:
   抄一遍的下场是两处迟早对不上,而顺序一变,同一个角色每轮拿到的条件就变了 */
const SPEC_BY_KEY: Partial<Record<keyof CharacterFields, FieldSpec>> = {}
for (const f of [STYLE_FIELD, GENDER_FIELD, ...BODY_FIELDS, ...FACE_FIELDS, ...SHEET_FIELDS]) {
  SPEC_BY_KEY[f.key] = f
}
export const ALL_FIELDS: FieldSpec[] = (charSpecKeys('field') as Array<keyof CharacterFields>).map(
  (k) => SPEC_BY_KEY[k] as FieldSpec
)

/** 性别那一栏要摆出来的选项。模型偶尔会写出 female / male 之外的值(比如 non-binary)——
 *  把它当成第三项显示出来:已填的值在界面上看不见,比"选不中"更难理解,
 *  一栏空着却拦不住保存,用户会以为是坏了。
 *  (在页面里它是个 computed,依赖只有那一个值,所以这里收成纯函数) */
export function genderOptionsFor(value: string): string[] {
  const v = (value || '').trim()
  return v && !GENDERS.includes(v) ? [...GENDERS, v] : GENDERS
}

/** 风格那一栏同理。模型自己写出来的媒介词(比如 'watercolor')要显示成一项可选项,
 *  不能因为不在预设里就把它吞掉 —— 吞掉之后提示词里却还带着它,界面上却看不见 */
export function styleOptionsFor(value: string): Array<{ value: string; label: string }> {
  const v = (value || '').trim()
  if (!v || STYLE_OPTIONS.some((o) => o.value === v)) return STYLE_OPTIONS
  return [...STYLE_OPTIONS, { value: v, label: v }]
}

/* 表单上的分组,各有自己的标题。
   **分组表达的是"去哪儿",不是"去哪一类"**:Spec 与 Body 两组的差别是
   "往哪儿看"(脸 / 身材),而 Reference sheet only 那一组才是那条真正要紧的
   界线 —— "会不会进你每一张图"。脚注语气(11px 灰字)压不住它,
   所以给它一个与 Spec 平级的标题,让它自己成为一段。

   为什么 Spec 与 Body 也要分成两组:挤在一组里是 12 行等长的栏位,
   而身材那四行恰恰是"读一眼就能校完"的 —— 单独成组,它们才读得出是一件事 */
export type FormGroup = {
  title: string
  hint: string
  fields: FieldSpec[]
  // 这一组末尾再补一个自由备注栏(占满两列)。备注不是 CharacterFields 的成员
  notes?: boolean
}

export const FORM_GROUPS: FormGroup[] = [
  {
    title: 'Spec',
    hint: 'The face travels with every image you generate.',
    fields: FACE_FIELDS
  },
  {
    title: 'Body',
    hint: 'Height, build, muscle and posture — also kept the same everywhere.',
    fields: BODY_FIELDS
  },
  {
    title: 'Reference sheet only',
    hint: 'Shaped into the reference sheet only — never merged into your other prompts.',
    fields: SHEET_FIELDS,
    notes: true
  }
]

/* —— 人格那一组 ——
   只有对话用得上,与上面两组是**完全分开**的一件事:那两组管"它长什么样",
   这一组管"它是个什么样的人"。它不影响任何一张图,混进 Spec 的字段顺序
   只会让那条界线变糊。

   为什么 traits 与 voice 要分成两栏:写在同一栏里模型会把两者平均掉,
   结果是性格写了、说话方式被稀释成通用口吻 —— 而"像人"主要靠后者。

   为什么语言也单独一栏:voice 管的是**措辞**,language 管的是**用哪种语言说**。
   合在一栏里模型同样会把两者平均掉,而语言的错法比措辞的错法严重得多 ——
   说错语言不是"这个人不太像",而是"根本不是同一个人"。
   这一栏还兼一个用处:朗读挑音色时以它为准(见 lib/speech 的 langOf)。
   默认留空 = 跟着用户走,与加这一栏之前的行为一致。

   **"Voice" 这个词归嗓音(听得到的那个),这里不让它出现。**
   这一组讲的是"这个人是个什么样的人、话怎么说出来",所以组名是 Personality;
   管"话怎么说出来"的那个字段叫 Speech style。
   把音频音色那一档功能加进来之后,一个叫 Voice 的文字栏会和它彻底混淆 ——
   用户会以为在这里写字就能改变角色听起来的声音 */
export type PersonaSpec = { key: keyof CharacterPersona; label: string; hint: string }

export const PERSONA_FIELDS: PersonaSpec[] = [
  { key: 'language', label: 'Language', hint: "English — leave empty to follow the user's" },
  { key: 'traits', label: 'Traits', hint: 'guarded, dry humor, slow to trust' },
  { key: 'voice', label: 'Speech style', hint: 'short clipped sentences, rarely asks questions' },
  { key: 'address', label: 'Address', hint: "calls you 'kid', an old partner" },
  { key: 'boundaries', label: 'Boundaries', hint: 'never breaks character, never mentions AI' },
  /* 样本那一栏(2026-10-08):上面几栏都是**描述**,描述会被平均成"通用口吻";
     这一栏是**例子**,模型照抄的是语气。形状见 charSpec 的 desc(一行、` | ` 分隔) */
  {
    key: 'samples',
    label: 'Speech samples',
    hint: "User: how was your day → You: long. don't ask. | User: im outside → You: door's open"
  }
]

/* 详情页的规格表:固定的那几项按顺序排,再做一条可选的补充描述 */
const SPEC_LABELS: Array<[keyof CharacterFields, string]> = ALL_FIELDS.map((f) => [f.key, f.label])

export function specRows(c: Character) {
  const f = c.fields || emptyCharFields()
  const rows = SPEC_LABELS.map(([k, label]) => ({ label, value: (f[k] || '').trim(), wide: false }))
  const notes = (c.desc || '').trim()
  // 补充描述是自由文本,回看时占满整行
  if (notes) rows.push({ label: 'Extra details', value: notes, wide: true })
  return rows
}

/** 人格那一段的读法。与 specRows 同一形状,但单独成表 ——
 *  它回答的是"这个人怎么说话",不是"这个人长什么样" */
export function personaRows(c: Character) {
  const p = { ...emptyCharPersona(), ...(c.persona || {}) }
  return PERSONA_FIELDS.map((f) => ({ label: f.label, value: (p[f.key] || '').trim() }))
}
