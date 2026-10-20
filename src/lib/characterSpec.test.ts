import { describe, expect, it } from 'vitest'
import {
  CHAR_SPEC_LINE_COUNT,
  CHAR_SPEC_LINES,
  ORIGIN_SLOT,
  ORIGIN_TAGS,
  charSpecAlwaysSentence,
  charSpecEnumOf,
  charSpecKeys,
  charSpecLinesText,
  charSpecOriginRule
} from '../../server/charSpec.js'
import { ENHANCE_PROMPTS } from '../../server/enhancePrompts.js'
import {
  characterDesc,
  characterFaceDesc,
  emptyCharFields,
  emptyCharPersona,
  parseCharacterDraft
} from '../api'
import {
  ALL_FIELDS,
  GENDERS,
  ORIGIN_BADGES,
  PERSONA_FIELDS,
  STYLE_OPTIONS,
  genderOptionsFor,
  originOf,
  personaRows,
  specRows,
  styleOptionsFor
} from './characterSpec'
import type { Character, CharacterFields, CharacterPersona } from '../types'

/* ===== 角色设定的那份契约 ============================================
 *  这里看的不是某个函数算得对不对,而是**那几份清单还对不对得上**:
 *
 *     types.ts 的字段  ↔  server/charSpec.js 的行  ↔  两段起稿提示词
 *                                              ↔  解析回填的标签表
 *                                              ↔  界面的规格表与选项
 *
 *  这五处以前各写各的,加一栏要同时改六处,而漏掉任何一处都不报错 ——
 *  表现只是"模型少回一行,那个字段静静地空着"。所以这一组测试存在的意义
 *  就是让那种漏改**在 CI 里当场红**,而不是等用户发现设定图少了点什么。
 *  -------------------------------------------------------------------- */

/* 这两份清单的唯一作用是**让编译器看着 types.ts**:给 CharacterFields 加了一栏
   而这里没跟上,Record<keyof …> 会当场报"缺一个属性"。
   再拿它和行定义比一次,链条就闭合了:types ↔ 清单(编译期)↔ 行定义(运行期)。
   手写这两份是值得的 —— 它是唯一能真正拦住"加了字段忘了提示词"的办法 */
const FIELD_KEYS_TYPED: Record<keyof CharacterFields, true> = {
  style: true,
  gender: true,
  identity: true,
  face: true,
  height: true,
  build: true,
  muscle: true,
  posture: true,
  hair: true,
  brows: true,
  eyes: true,
  noseMouth: true,
  facialHair: true,
  faceMarks: true,
  outfit: true,
  marks: true
}
const PERSONA_KEYS_TYPED: Record<keyof CharacterPersona, true> = {
  language: true,
  traits: true,
  voice: true,
  address: true,
  boundaries: true,
  samples: true
}

/** 一个填满了假设值的角色。只给要断言的那几项也行 */
function char(
  fields: Partial<CharacterFields> = {},
  persona: Partial<CharacterPersona> = {}
): Character {
  return {
    id: 'c1',
    name: 'Probe',
    createdAt: 0,
    fields: { ...emptyCharFields(), ...fields },
    persona: { ...emptyCharPersona(), ...persona }
  }
}

describe('行定义 · 与类型对得上', () => {
  it('长相那一组的键与 CharacterFields 完全一致,顺序也一致', () => {
    expect(charSpecKeys('field')).toEqual(Object.keys(FIELD_KEYS_TYPED))
  })

  it('人格那一组的键与 CharacterPersona 完全一致,顺序也一致', () => {
    expect(charSpecKeys('persona')).toEqual(Object.keys(PERSONA_KEYS_TYPED))
  })

  it('每个键只出现一次(重复会让解析表悄悄盖掉前一个)', () => {
    const keys = CHAR_SPEC_LINES.map((l) => l.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('标签互不重复,且都是解析器认得出的形状', () => {
    const labels = CHAR_SPEC_LINES.map((l) => l.label.toLowerCase().replace(/[^a-z]/g, ''))
    expect(new Set(labels).size).toBe(labels.length)
    for (const l of labels) {
      // 解析器按"去掉非字母"查表,所以一个纯符号的标签等于没人认领
      expect(l).toMatch(/^[a-z]+$/)
    }
  })

  it('名字那一行归 name 组,且只有它一个', () => {
    expect(CHAR_SPEC_LINES.filter((l) => l.group === 'name')).toHaveLength(1)
    expect(CHAR_SPEC_LINES.find((l) => l.group === 'name')?.key).toBe('name')
  })

  it('风格与体型都进"每一张成品",不只在设定图里', () => {
    const sheetOnly = CHAR_SPEC_LINES.filter((l) => l.sheetOnly).map((l) => l.key)
    expect(sheetOnly.sort()).toEqual(['marks', 'outfit'])
  })
})

describe('行定义 · 起稿提示词由它生成', () => {
  it('两档的行清单都是同一个行数,且行数与数组长度一致', () => {
    for (const mode of ['character', 'vision'] as const) {
      const lines = charSpecLinesText(mode).split('\n')
      expect(lines).toHaveLength(CHAR_SPEC_LINE_COUNT)
    }
    // 十六行那个写法已经废了:数一改,提示词里那个数字必须跟着改
    expect(ENHANCE_PROMPTS.character).toContain(`exactly ${CHAR_SPEC_LINE_COUNT} lines`)
    expect(ENHANCE_PROMPTS.vision).toContain(`exactly ${CHAR_SPEC_LINE_COUNT} lines`)
    expect(ENHANCE_PROMPTS.character).not.toMatch(/sixteen/i)
    expect(ENHANCE_PROMPTS.vision).not.toMatch(/sixteen/i)
  })

  it('每一行的标签都真的出现在提示词里', () => {
    for (const mode of ['character', 'vision'] as const) {
      const prompt = mode === 'character' ? ENHANCE_PROMPTS.character : ENHANCE_PROMPTS.vision
      /* 标签后面紧跟那个来源槽 —— 槽是"这一行还得写一个来源标记"这件事
         在模型照抄的那一块里唯一的落点,掉了就等于协议没写进提示词 */
      for (const l of CHAR_SPEC_LINES) expect(prompt).toContain(`${l.label}: ${ORIGIN_SLOT} <`)
    }
  })

  it('两档各有自己的说法(识图那一档要它写"图里画的是哪种媒介")', () => {
    expect(charSpecLinesText('character')).toContain('auto to follow a reference image')
    expect(charSpecLinesText('vision')).toContain('the medium this image is drawn in')
    expect(charSpecLinesText('character')).not.toBe(charSpecLinesText('vision'))
  })

  it('必填那句枚举由 always 那几行算出来,不再手抄', () => {
    const said = charSpecAlwaysSentence('character')
    expect(said).toBe(
      'Name, Style, Gender, Identity, Face, Height, Build, Hair, Brows, Eyes, Nose & mouth, Facial hair and Outfit'
    )
    expect(ENHANCE_PROMPTS.character).toContain(`${said} must always have a value`)
    // 允许留空的那几行不该混进"必须有值"
    expect(said).not.toContain('Marks')
    expect(said).not.toContain('Language')
    // 身材那四行里,只有 Height 与 Build 是必答 —— Muscle / Posture 允许留空
    expect(said).toContain('Height')
    expect(said).not.toContain('Muscle')
    expect(said).not.toContain('Posture')
  })

  it('识图那一档的必填枚举少一个 Identity —— 一张照片里没有职业', () => {
    const vision = charSpecAlwaysSentence('vision')
    expect(ENHANCE_PROMPTS.vision).toContain(`${vision} must always have a value`)
    /* 少的那一个必须**正好是** Identity,而不是别的行被顺手漏掉:
       一句枚举分档算之后,"少了谁"这件事只能靠这一条钉住 */
    expect(charSpecAlwaysSentence('character').replace('Identity, ', '')).toBe(vision)
    /* 只说"它不是必答"不够 —— 模型仍会按最省事的做法编一个职业。
       提示词里必须明说留空(PRD §3.2-A:"这些信息应由用户提供,或保持未确定") */
    expect(ENHANCE_PROMPTS.vision).toContain('Leave Identity empty')
    // 而文字起稿那一档照旧必答:用户自己在描述里说了是谁
    expect(ENHANCE_PROMPTS.character).toContain('Identity, Face')
  })

  it('风格自己成行之后,Identity 不再被要求写风格', () => {
    expect(ENHANCE_PROMPTS.character).not.toContain('overall style')
    expect(ENHANCE_PROMPTS.vision).not.toContain('overall style')
    expect(ENHANCE_PROMPTS.character).toContain('never restate the gender or the style')
  })

  it('两档都禁止从长相推语言', () => {
    expect(ENHANCE_PROMPTS.character).toContain('Never infer a language from a name, a nationality')
    expect(ENHANCE_PROMPTS.vision).toContain('rather than guess from how someone looks')
  })

  it('枚举候选来自行定义,不是界面自己编的', () => {
    expect(charSpecEnumOf('gender')).toEqual(['female', 'male'])
    expect(charSpecEnumOf('style')).toContain('auto')
    expect(charSpecEnumOf('identity')).toEqual([])
  })
})

/* ===== 来源标记(PRD §3.2-A「你提供的 / AI 补全 / 待确认」)================
 *  这三态**客户端推不出来** —— 只有模型知道某一行是用户说过的、还是它编的。
 *  所以协议是三段式:行清单里给出槽 → 提示词里给出判据 → 解析侧摘掉并落表。
 *  任何一段掉了都不报错,表现只是"每一栏都长得一样"。这一组测试就是把
 *  那三段各自钉住,免得它悄悄地退化成一句没人照做的嘱咐。
 *  -------------------------------------------------------------------- */

describe('来源标记 · 协议', () => {
  it('三个词与 PRD 那三个标签一一对应', () => {
    expect(ORIGIN_TAGS).toEqual(['user', 'ai', 'pending'])
    expect(ORIGIN_SLOT).toBe('[user|ai|pending]')
  })

  it('两档的行清单里每一行都带着那个槽', () => {
    for (const mode of ['character', 'vision'] as const) {
      const lines = charSpecLinesText(mode).split('\n')
      expect(lines).toHaveLength(CHAR_SPEC_LINE_COUNT)
      for (const l of lines) expect(l).toContain(`: ${ORIGIN_SLOT} <`)
    }
  })

  it('两档的判据不同 —— 一档问"描述里说没说过",一档问"图里看不看得见"', () => {
    const c = charSpecOriginRule('character')
    const v = charSpecOriginRule('vision')
    expect(c).not.toBe(v)
    expect(c).toContain('the idea itself says it')
    expect(v).toContain('the image plainly shows it')
    // 两档都得点名三个标记:只说槽里那串字面量,模型只会把它原样抄回来
    for (const rule of [c, v]) for (const t of ORIGIN_TAGS) expect(rule).toContain(`[${t}]`)
  })

  it('两段提示词都真的带上了它 —— 规则写了而没插进去,整套标记就没人照做', () => {
    expect(ENHANCE_PROMPTS.character).toContain(charSpecOriginRule('character'))
    expect(ENHANCE_PROMPTS.vision).toContain(charSpecOriginRule('vision'))
  })

  it('识图那一档明说身份/职业不许从图里推 —— 那是 PRD 点名的四条之一', () => {
    // "不应仅凭图片擅自推断角色的身份、职业、人格或人生经历"
    expect(ENHANCE_PROMPTS.vision).toContain('Never read a trade, a role or a life story')
    // 人格那一段保留推断,但必须逐栏标 pending,并且不许编人生经历
    expect(ENHANCE_PROMPTS.vision).toContain('tag any persona line you fill in [pending]')
    expect(ENHANCE_PROMPTS.vision).toContain('Never invent a past, a relationship, a job or an event')
  })
})

describe('解析回填 · 新增的那几栏', () => {
  it('风格、身材、语言都落到对应的键上', () => {
    const d = parseCharacterDraft(
      [
        'Name: Ash',
        'Style: anime',
        'Gender: female',
        'Identity: dockhand',
        'Face: round, pale',
        'Height: about 1.6 m',
        'Build: small-framed, wiry',
        'Muscle: lightly toned',
        'Posture: shoulders hunched',
        'Hair: black bob',
        'Brows: thin',
        'Eyes: dark brown',
        'Nose & mouth: small nose',
        'Facial hair: none',
        'Face marks:',
        'Outfit: oilskin coat',
        'Marks:',
        'Language: 日本語',
        'Personality: quiet',
        'Voice: short sentences',
        'Address: calls you rookie',
        'Boundaries: never breaks character'
      ].join('\n')
    )
    expect(d.name).toBe('Ash')
    expect(d.fields.style).toBe('anime')
    expect(d.fields.height).toBe('about 1.6 m')
    expect(d.fields.build).toBe('small-framed, wiry')
    expect(d.fields.muscle).toBe('lightly toned')
    expect(d.fields.posture).toBe('shoulders hunched')
    expect(d.persona.language).toBe('日本語')
  })

  it('Style 写成 auto / 跟着参考图 = 留空(空值会被提示词滤掉)', () => {
    for (const v of ['auto', 'Auto', 'automatic', 'match the reference image', 'follow reference']) {
      expect(parseCharacterDraft(`Style: ${v}`).fields.style).toBe('')
    }
  })

  it('Style 写成预设之外的词也照收 —— 吞掉它才是错的', () => {
    expect(parseCharacterDraft('Style: watercolor').fields.style).toBe('watercolor')
  })

  it('Language 写成"跟随用户"的各种说法 = 留空', () => {
    for (const v of ['auto', 'same as the user', "the user's language", 'follow the user']) {
      expect(parseCharacterDraft(`Language: ${v}`).persona.language).toBe('')
    }
    expect(parseCharacterDraft('Language: English').persona.language).toBe('English')
  })

  it('老规矩不变:Facial hair 的 none 换成 clean-shaven,其余 none 留空', () => {
    const d = parseCharacterDraft(['Facial hair: none', 'Marks: n/a'].join('\n'))
    expect(d.fields.facialHair).toBe('clean-shaven')
    expect(d.fields.marks).toBe('')
  })

  it('老格式(没有新增那三行)照旧解析得动,新键是空串', () => {
    const d = parseCharacterDraft(
      [
        'Name: Old',
        'Gender: male',
        'Identity: pilot',
        'Face: long',
        'Hair: grey',
        'Brows: bushy',
        'Eyes: blue',
        'Nose & mouth: straight',
        'Facial hair: stubble',
        'Face marks:',
        'Outfit: jacket',
        'Marks:',
        'Personality: warm',
        'Voice: rambling',
        'Address: calls you kid',
        'Boundaries: none'
      ].join('\n')
    )
    expect(d.fields.style).toBe('')
    expect(d.fields.build).toBe('')
    expect(d.fields.height).toBe('')
    expect(d.fields.muscle).toBe('')
    expect(d.fields.posture).toBe('')
    expect(d.persona.language).toBe('')
    expect(d.fields.outfit).toBe('jacket')
  })

  it('装饰照旧剥得掉:加粗、项目符号、中文冒号', () => {
    const d = parseCharacterDraft(['**Style**: anime', '• Build：tall', '语言: 中文'].join('\n'))
    expect(d.fields.style).toBe('anime')
    expect(d.fields.build).toBe('tall')
    // "语言" 不是标签(标签是 Language),所以它被丢掉 —— 中文标签不在协议里
    expect(d.persona.language).toBe('')
  })
})

describe('来源标记 · 解析', () => {
  it('三个标记分别落到 user / ai / pending 上,并且从值里摘干净', () => {
    const d = parseCharacterDraft(
      ['Identity: [user] dockhand', 'Face: [ai] round, pale', 'Brows: [pending] thin'].join('\n')
    )
    expect(d.fields.identity).toBe('dockhand')
    expect(d.fields.face).toBe('round, pale')
    expect(d.fields.brows).toBe('thin')
    expect(d.origin.identity).toBe('user')
    expect(d.origin.face).toBe('ai')
    expect(d.origin.brows).toBe('pending')
  })

  it('标记不会漏进值里 —— 漏了会被拼进出图提示词', () => {
    const d = parseCharacterDraft('Identity: [pending] dockhand')
    expect(d.fields.identity).toBe('dockhand')
    expect(d.fields.identity).not.toContain('[')
  })

  it('标记写在值末尾也认 —— 有的模型习惯把修饰放在后面', () => {
    const d = parseCharacterDraft('Hair: short black [pending]')
    expect(d.fields.hair).toBe('short black')
    expect(d.origin.hair).toBe('pending')
  })

  it('模型把行清单里那个槽原样抄回来时,槽摘掉并按默认档处理', () => {
    const d = parseCharacterDraft(`Hair: ${ORIGIN_SLOT} short black`)
    expect(d.fields.hair).toBe('short black')
    expect(d.origin.hair).toBe('ai')
  })

  it('**摘不到标记一律落在 ai**,不进 pending', () => {
    /* 摘不到时我们只确定"这是模型写的";"它没有依据"是一个我们并不知道的、
       更强的断言 —— 替模型断言它没依据,与替用户断言他说过,是同一种错。
       这也是降级路径:模型完全没照做时,行为与加这套标记之前一样 */
    const d = parseCharacterDraft('Hair: short black')
    expect(d.origin.hair).toBe('ai')
  })

  it('名字不进来源表 —— 它是这张卡的标题,不是设定的一栏', () => {
    const d = parseCharacterDraft('Name: [pending] Ash')
    expect(d.name).toBe('Ash')
    expect(d.origin).not.toHaveProperty('name')
  })

  it('空着的栏不进来源表 —— 没写就是没写,不是"谁写的"', () => {
    const d = parseCharacterDraft(['Face marks:', 'Marks: [pending]'].join('\n'))
    expect(d.fields.faceMarks).toBe('')
    expect(d.fields.marks).toBe('')
    expect(d.origin.faceMarks).toBeUndefined()
    expect(d.origin.marks).toBeUndefined()
  })

  it('Facial hair 的 none 换成 clean-shaven 之后仍然保留它的来源', () => {
    const d = parseCharacterDraft('Facial hair: [pending] none')
    expect(d.fields.facialHair).toBe('clean-shaven')
    expect(d.origin.facialHair).toBe('pending')
  })

  it('Style 的 auto 落成空串之后不留来源 —— 那一栏没有值', () => {
    const d = parseCharacterDraft('Style: [ai] auto')
    expect(d.fields.style).toBe('')
    expect(d.origin.style).toBeUndefined()
  })

  it('人格那六栏同样带来源 —— 它们是最容易被编出来的一半', () => {
    const d = parseCharacterDraft(
      ['Personality: [pending] guarded', 'Language: [ai] English'].join('\n')
    )
    expect(d.origin.traits).toBe('pending')
    expect(d.origin.language).toBe('ai')
  })

  it('整段回填的值里一个标记都不剩 —— 它不该跟着值进提示词', () => {
    const d = parseCharacterDraft(
      [
        'Name: Ash',
        'Style: [ai] anime',
        'Gender: [user] female',
        'Identity: [pending] dockhand',
        'Face: [ai] round, pale',
        'Personality: [pending] guarded'
      ].join('\n')
    )
    for (const v of [...Object.values(d.fields), ...Object.values(d.persona)]) {
      expect(v).not.toContain('[user]')
      expect(v).not.toContain('[ai]')
      expect(v).not.toContain('[pending]')
    }
    // 而且值本身照旧拼得进提示词(见 characterFaceDesc)
    expect(characterFaceDesc(char(d.fields, d.persona))).toContain('dockhand')
  })
})

describe('拼提示词 · 老角色逐字不变', () => {
  const old = char({
    gender: 'female',
    identity: 'dockhand',
    face: 'round face',
    hair: 'black bob',
    brows: 'thin',
    eyes: 'dark brown',
    noseMouth: 'small nose',
    facialHair: 'none',
    faceMarks: 'none',
    outfit: 'oilskin coat',
    marks: 'rope burn'
  })

  it('没填风格与体型的角色,并进成品的描述里就没有这两项', () => {
    expect(characterFaceDesc(old)).toBe(
      'female, dockhand, round face, black bob, thin, dark brown, small nose, none, none'
    )
  })

  it('填了之后才出现,且风格排在最前(它是最上一层的那档条件)', () => {
    const withNew = char({ ...old.fields, style: 'anime', build: 'tall and lean' })
    const out = characterFaceDesc(withNew)
    expect(out.startsWith('anime, female, dockhand')).toBe(true)
    expect(out).toContain('tall and lean')
  })

  it('设定图那份"全量"描述按行定义的顺序拼,风格同样在最前', () => {
    const c = char({ style: 'comic', gender: 'male', identity: 'pilot', outfit: 'jacket' })
    expect(characterDesc(c)).toBe('comic, male, pilot, jacket')
  })

  it('没有 fields 的老角色仍然退回 desc,不因为新字段而改变', () => {
    const legacy: Character = { id: 'x', name: 'X', createdAt: 0, desc: 'a quiet stranger' }
    expect(characterFaceDesc(legacy)).toBe('a quiet stranger')
  })
})

describe('界面那份规格表 · 跟着行定义走', () => {
  it('详情页规格表的顺序就是提示词里的顺序', () => {
    expect(ALL_FIELDS.map((f) => f.key)).toEqual(charSpecKeys('field'))
  })

  it('人格那一组同理', () => {
    expect(PERSONA_FIELDS.map((f) => f.key)).toEqual(charSpecKeys('persona'))
  })

  it('风格那一排给的词与提示词能给的词是同一批', () => {
    const preset = STYLE_OPTIONS.filter((o) => o.value).map((o) => o.value)
    const allowed = charSpecEnumOf('style').filter((v) => v !== 'auto')
    expect(preset.sort()).toEqual(allowed.sort())
    // 第一枚必须是 Auto,而且它对应的值是空串(空值不进提示词,于是跟着参考图走)
    expect(STYLE_OPTIONS[0]).toEqual({ value: '', label: 'Auto' })
  })

  it('模型自己写出来的媒介词会多摆一枚,不会被界面吞掉', () => {
    expect(styleOptionsFor('watercolor')).toHaveLength(STYLE_OPTIONS.length + 1)
    expect(styleOptionsFor('anime')).toHaveLength(STYLE_OPTIONS.length)
    expect(styleOptionsFor('')).toHaveLength(STYLE_OPTIONS.length)
  })

  it('性别那排的选项取自行定义的枚举', () => {
    expect(GENDERS).toEqual(charSpecEnumOf('gender'))
    expect(genderOptionsFor('non-binary')).toEqual([...GENDERS, 'non-binary'])
  })
})

describe('来源徽标 · 界面', () => {
  it('只有 ai / pending 挂牌 —— 没有牌就是"这一栏来自用户"', () => {
    expect(Object.keys(ORIGIN_BADGES).sort()).toEqual(['ai', 'pending'])
    expect(ORIGIN_BADGES.user).toBeUndefined()
  })

  it('没有来源表的角色读出来全是 user —— 老角色与手填的角色同一个样子', () => {
    const c = char({ hair: 'black bob' })
    expect(originOf(c, 'hair')).toBe('user')
    expect(specRows(c).find((r) => r.label === 'Hair')?.origin).toBe('user')
    expect(ORIGIN_BADGES[originOf(c, 'hair')]).toBeUndefined()
  })

  it('有来源表的角色逐栏读得出 —— 长相与人格两张表都读', () => {
    const c: Character = {
      ...char({ hair: 'black bob' }, { traits: 'guarded' }),
      origin: { hair: 'pending', traits: 'ai' }
    }
    expect(specRows(c).find((r) => r.label === 'Hair')?.origin).toBe('pending')
    expect(personaRows(c).find((r) => r.label === 'Traits')?.origin).toBe('ai')
    // 表里没提的那一栏照旧读成 user —— 部分来源表也是合法形状
    expect(specRows(c).find((r) => r.label === 'Eyes')?.origin).toBe('user')
  })

  it('补充描述永远是 user —— 起稿那条路不填它', () => {
    const c: Character = {
      ...char({ hair: 'x' }),
      desc: 'no AI face please',
      origin: { hair: 'pending' }
    }
    expect(specRows(c).find((r) => r.label === 'Extra details')?.origin).toBe('user')
  })
})
