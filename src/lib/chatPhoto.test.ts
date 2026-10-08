import { describe, expect, it } from 'vitest'
import {
  CHAT_PHOTO_PROMPT_CHARS,
  backdropViewOrder,
  characterAnchor,
  characterGender,
  chatPhotoSize,
  frameFromScene,
  frameLine,
  isSelfie,
  isThirdShot,
  missingSlots,
  partLine,
  planChatPhoto,
  resolveFrame,
  shotRatio,
  shotViewOrder,
  planChatBackdrop
} from './chatPhoto'
import { CHARACTER_VIEWS } from '../api'

/* 这一层现在管四件事:这张里有没有它本人、是自拍还是他拍、拼锚点句还是全量设定表、
   以及"只补不覆盖"的补全。四件事都是纯字符串处理,而真正的出图要花钱、要联网、
   靠手测试不全 —— 所以判据全部放在这里直接断言。
 *
 * 断言尽量落在**语义**上(某句在不在、先后顺序),而不是整串等于什么:
 * 模板文案是会调的,把整串写死会让每次微调都变成一次改测试。 */

const ANCHOR = 'oval face, high cheekbones, dark bob'
/** 一份有人、没说时间的普通场景 —— 好几组用例共用它 */
const BARE_SCENE = 'leaning on the balcony'

/* ===== 锚点句 ======================================================== */

describe('characterAnchor · 只留不可变的身份特征', () => {
  const fields = {
    style: 'photorealistic',
    gender: 'female',
    identity: 'a night-shift nurse in a coastal town',
    face: 'oval face, high cheekbones',
    build: 'tall and lean',
    hair: 'black bob',
    brows: 'straight brows',
    eyes: 'dark eyes',
    noseMouth: 'small nose',
    facialHair: 'clean-shaven',
    faceMarks: '',
    outfit: 'worn flight jacket',
    marks: ''
  }

  it('风格不进锚点句 —— 它是"用什么媒介画",由模板那一层给', () => {
    expect(characterAnchor({ fields })).not.toContain('photorealistic')
  })

  it('身份叙事不进锚点句 —— 那是"这个人是谁",不是"长什么样"', () => {
    const a = characterAnchor({ fields })
    expect(a).not.toContain('nurse')
  })

  it('性别不进锚点句 —— 它由参考图和脸型特征决定,写出来只会变成标签', () => {
    expect(characterAnchor({ fields })).not.toContain('female')
  })

  it('清单里每一项都进得来 —— 上限就是那份清单的长度', () => {
    /* 数的是"取了几项",不是 split(',') 的段数:字段值自己带逗号
       ("oval face, high cheekbones" 是一项,却占两段) */
    const oneEach = {
      face: 'a', hair: 'b', eyes: 'c', brows: 'd', noseMouth: 'e', facialHair: 'f', build: 'g'
    }
    expect(characterAnchor({ fields: oneEach }).split(', ').length).toBe(7)
  })

  it('按固定顺序取:脸 → 头发 → 眼睛 → 眉毛 → 鼻嘴 → 胡须 → 脸上的标记 → 身上的标记 → 体型', () => {
    expect(characterAnchor({ fields })).toBe(
      'oval face, high cheekbones, black bob, dark eyes, straight brows, small nose, clean-shaven, tall and lean'
    )
  })

  /* faceMarks / marks(2026-10-08):用户亲手写下的身份特征,从前到不了锚点 ——
     faceMarks 不在清单里,marks 还标着 sheetOnly。于是"左眼下小痣 / 银项链"
     在对话图上只剩参考图一条路,而小痣在缩略图里根本看不见。 */
  it('faceMarks 与 marks 也进锚点 —— 认人从来不只看脸', () => {
    const c = {
      fields: { face: 'oval face', faceMarks: 'small mole under left eye', marks: 'silver necklace' }
    }
    expect(characterAnchor(c)).toBe('oval face, small mole under left eye, silver necklace')
  })

  it('这两项空着时一个字都不多 —— 它们本来就常常是空的', () => {
    const c = { fields: { face: 'oval face', faceMarks: '', marks: '' } }
    expect(characterAnchor(c)).toBe('oval face')
  })

  it('两项标记排在体型之前 —— 体型仍然垫底', () => {
    const a = characterAnchor({ fields: { faceMarks: 'mole', marks: 'necklace', build: 'tall' } })
    expect(a.indexOf('mole')).toBeLessThan(a.indexOf('tall'))
    expect(a.indexOf('necklace')).toBeLessThan(a.indexOf('tall'))
  })

  it('体型垫在最后 —— 顺序本身就是取舍的优先级', () => {
    /* 这份设定刚好 7 项可用,所以都进得来;只要再多一项,第一个出局的就是垫底的体型 */
    const a = characterAnchor({ fields })
    expect(a.indexOf('clean-shaven')).toBeLessThan(a.indexOf('tall and lean'))
  })

  it('只给脸和体型两项时,体型仍然进得来', () => {
    expect(characterAnchor({ fields: { face: 'oval face', build: 'tall and lean' } })).toBe(
      'oval face, tall and lean'
    )
  })

  it('只给脸和体型两项时,体型仍然进得来', () => {
    expect(characterAnchor({ fields: { face: 'oval face', build: 'tall and lean' } })).toBe(
      'oval face, tall and lean'
    )
  })

  it('没有结构化字段的老角色返回空串,不退回全量描述', () => {
    expect(characterAnchor(undefined)).toBe('')
    expect(characterAnchor({})).toBe('')
    expect(characterAnchor({ fields: undefined })).toBe('')
  })

  it('字段值不是字符串时不抛 —— 外部导入的包可能被写坏', () => {
    expect(characterAnchor({ fields: { face: 42, hair: null } })).toBe('')
  })
})

/* ===== 自拍 / 他拍 =================================================== */

describe('isSelfie · 只认明确是自拍的说法', () => {
  it.each([
    'taking a selfie on the balcony',
    'a quick self-portrait before work',
    'selfie, hair still wet',
    'me in the mirror, phone up',
    'an arm\u2019s length shot of my own face',
    '自拍一张给你看',
    '举着手机拍了一张',
    '对镜自拍'
  ])('认出自拍:%s', (s) => {
    expect(isSelfie(s)).toBe(true)
  })

  it.each([
    'me on the balcony, hair down',
    'leaning on the railing at night',
    '我在阳台抽烟',
    '窗外的雨'
  ])('不认成自拍:%s', (s) => {
    expect(isSelfie(s)).toBe(false)
  })

  it('认不出就是认不出 —— 它只回答"场景里写没写自拍",不再兼任默认值', () => {
    expect(isSelfie('a rooftop at dawn')).toBe(false)
  })
})

describe('isThirdShot · 只认明说了"别人拍的"', () => {
  it.each([
    'me on stage, taken by a friend in the crowd',
    'she took this photo of me at the party',
    'a candid of me at the market',
    '别人拍的我',
    '这张是偷拍的'
  ])('认成他拍:%s', (s) => {
    expect(isThirdShot(s)).toBe(true)
  })

  it.each(['me on the balcony', 'taking a selfie by the window', '我在阳台'])(
    '不认成他拍:%s',
    (s) => {
      expect(isThirdShot(s)).toBe(false)
    }
  )
})

/* ===== 分层拼装 ====================================================== */

/* ===== 视角归谁定 ====================================================
 *  `shot` 这个参数是"摄影指导判出来的视角"的入口(见 lib/photoDirector)。
 *  不传时退回 isSelfie 词表 —— 那是**没有摄影指导时的降级路径**,不是主路径。 */

describe('planChatPhoto · 视角', () => {
  it('标签说 selfie 就是自拍', () => {
    const p = planChatPhoto('leaning on the balcony', true, ANCHOR, 'selfie')
    expect(p.shot).toBe('selfie')
    expect(p.prompt).toContain('front camera')
  })

  it('标签说 third 就是他拍,哪怕场景里写着"自拍"', () => {
    /* 两处矛盾时以标签为准:它是模型对"谁拿的相机"的直接回答,
       而场景只是一句散文 */
    const p = planChatPhoto('taking a selfie by the window', true, ANCHOR, 'third')
    expect(p.shot).toBe('third')
    expect(p.prompt).toContain('third-person view')
    expect(p.prompt).not.toContain('arm\u2019s length')
  })

  it('标签没说:场景写着自拍就是自拍', () => {
    expect(planChatPhoto('taking a selfie by the window', true, ANCHOR).shot).toBe('selfie')
  })

  it('标签没说、场景也没说:**默认自拍**', () => {
    /* 这一条是用户 2026-10-05 报的那个毛病("老是会生成他拍视角的图片")的根:
       原来的默认是他拍,而聊天模型写场景时通常不写"自拍"两个字 ——
       设计文档里的例子就是 `[photo:self:me on the balcony, hair down]` */
    const p = planChatPhoto('me on the balcony, hair down', true, ANCHOR)
    expect(p.shot).toBe('selfie')
    expect(p.prompt).toContain('front camera')
    expect(p.prompt).toContain('own hand')
  })

  it('场景明说是别人拍的那就他拍', () => {
    const p = planChatPhoto('me on stage, taken by a friend in the crowd', true, ANCHOR)
    expect(p.shot).toBe('third')
    expect(p.prompt).toContain('third-person view')
  })

  it('画面里没有人时,传什么视角都只能是空镜', () => {
    /* 这道护栏不由标签负责:一张"我看到的东西"里长出一个人,
       比视角选错严重得多 */
    const p = planChatPhoto('an empty harbour', false, ANCHOR, 'selfie')
    expect(p.shot).toBe('scene')
    expect(p.prompt).toContain('no people in frame')
  })

  it('self 记在方案上', () => {
    expect(planChatPhoto('an empty harbour', false, ANCHOR).self).toBe(false)
    expect(planChatPhoto(BARE_SCENE, true, ANCHOR).self).toBe(true)
  })

  it('每一档都带一条硬约束层(pin)—— 换得掉机位,换不掉它', () => {
    /* 三档各一句,而且是同一层:这是"这一张不可让渡的那件事" */
    const selfie = planChatPhoto('me on the balcony', true, ANCHOR)
    expect(selfie.layers.find(([slot]) => slot === 'pin')?.[1]).toContain('own hand')

    const third = planChatPhoto('me on stage, taken by a friend', true, ANCHOR)
    expect(third.layers.find(([slot]) => slot === 'pin')?.[1]).toContain('somebody else')

    const scene = planChatPhoto('an empty harbour', false, ANCHOR)
    expect(scene.layers.find(([slot]) => slot === 'pin')?.[1]).toContain('no people in frame')
  })

  it('**两档读出来都是"手机拍的"** —— 只是拿手机的人不同', () => {
    /* 用户 2026-10-05 的原始要求:"要能理解自己用手机拍摄的视角,
       和别人用手机拍摄的视角"。两者都要像手机照,而不是"一张照片" */
    const selfie = planChatPhoto('me on the balcony', true, ANCHOR)
    expect(selfie.prompt).toMatch(/phone front camera/i)
    expect(selfie.prompt).toMatch(/holding the phone/i)

    const third = planChatPhoto('me on stage, taken by a friend', true, ANCHOR)
    expect(third.prompt).toMatch(/snapshot taken on a phone by somebody else/i)
    expect(third.prompt).toMatch(/hand-held phone snapshot/i)
    /* 不能读成影棚/肖像那一路 */
    expect(third.prompt).not.toMatch(/studio portrait of|posed portrait/i)
    expect(third.prompt).toContain('phone photo rather than a studio portrait')
  })
})

/* ===== 景别归谁定 ====================================================
 *  2026-10-06 加的第二位,与视角正交。判据同一套写法:
 *  标签 > 场景文本 > 这一档视角的缺省。
 *
 *  它治的是用户报的那件事:"让角色拍特写图,总是变成自拍"。 */

describe('frameFromScene · 只认明确的景别', () => {
  it.each([
    'close-up of my eyes, looking right at you',
    'an extreme close-up of the stitching',
    'a macro shot of the frost on the glass',
    'the scar on my collarbone fills the frame',
    '特写:睫毛上还挂着水珠',
    '大特写，别眨眼'
  ])('认成特写:%s', (s) => expect(frameFromScene(s)).toBe('close'))

  it.each([
    'full body, me standing on the pier',
    'a full-length mirror selfie',
    'me head to toe in the doorway',
    'an establishing shot of the harbour',
    '全身照，站在窗前',
    '从头到脚都是雨'
  ])('认成全身:%s', (s) => expect(frameFromScene(s)).toBe('full'))

  /* 半身这一档**必须有入口** —— 它同时是 `FRAMING.third.medium` 的唯一来路:
     他拍那一档的缺省是全身,没有这一条,那段覆盖就是谁也走不到的死代码 */
  it.each([
    'a half-body shot of me at the desk',
    'me from the waist up, the lamp behind me',
    '半身照，靠在门框上',
    '镜头齐腰，手里还拿着杯子',
    /* "上半身" 说的是取景到腰以上,落在这一档是对的 */
    '上半身都是雨'
  ])('认成半身:%s', (s) => expect(frameFromScene(s)).toBe('medium'))

  it.each([
    'me on the balcony, hair down',
    'leaning on the railing at night',
    '我在阳台抽烟',
    '窗外的雨',
    /* 词表取窄的理由:"wide" / "detail" 单独出现时不知道在说什么 */
    'a wide grin and a raised eyebrow',
    '细节我都记得'
  ])('认不出:%s', (s) => expect(frameFromScene(s)).toBe(''))

  it('"全身心投入"里的"全身"不是景别 —— 中文没有词边界,这一条得自己挡', () => {
    expect(frameFromScene('全身心投入地写着报告')).toBe('')
  })

  it('两边都命中时特写赢 —— 用户报的毛病是拍得太远', () => {
    expect(frameFromScene('全身照里的一张特写')).toBe('close')
  })
})

describe('planChatPhoto · 景别', () => {
  it('**验收线:让角色拍特写,不许退回一张臂展自拍**', () => {
    /* 从前景别**写死在机位句里**:自拍那句是半身、他拍那句是全身。
       于是场景里那句"特写"在整个链路里唯一的作用是把景深那句删掉,
       而机位那句照旧是"脸和肩膀占满上半幅 / 手臂入画 / 身后的地方看得清" ——
       三句正面打架,模型挑一边信,交上来的就是一张臂展自拍 */
    const p = planChatPhoto('my eyes, looking straight at you', true, ANCHOR, 'selfie', 'close')
    expect(p.frame).toBe('close')
    expect(p.prompt).toContain('close-up')
    /* 半身自拍那三件套一件都不许在 */
    expect(p.prompt).not.toContain('face and shoulders filling the upper half')
    expect(p.prompt).not.toContain('the arm holding the phone partly visible in frame')
    expect(p.prompt).not.toContain('the place clearly readable right behind the shoulders')
  })

  it('标签说 close 就是特写', () => {
    expect(planChatPhoto('me on the balcony', true, ANCHOR, 'selfie', 'close').frame).toBe('close')
  })

  it('标签没说、场景写着特写,也是特写(中文一样认)', () => {
    expect(planChatPhoto('close-up of my eyes', true, ANCHOR, 'selfie').frame).toBe('close')
    expect(planChatPhoto('特写:我的眼睛', true, ANCHOR, 'selfie').frame).toBe('close')
  })

  it('"特写"不再把景深那一句吞掉 —— 特写最需要的正好是那一句', () => {
    /* 从前 close-up / 特写 在 LENS_RE 里,命中就把 lens 那层整个删掉 */
    const p = planChatPhoto('close-up of my eyes', true, ANCHOR)
    expect(p.prompt).toMatch(/shallow depth of field/)
  })

  it('缺省景别由视角决定:自拍半身、他拍全身、空镜中景', () => {
    expect(planChatPhoto('me on the balcony', true, ANCHOR, 'selfie').frame).toBe('medium')
    expect(planChatPhoto('me on stage, taken by a friend', true, ANCHOR, 'third').frame).toBe('full')
    expect(planChatPhoto('an empty harbour', false, ANCHOR).frame).toBe('medium')
  })

  it('**缺省那一档逐字不变** —— 这一位加进来,一张本来对的图都不该被改掉', () => {
    /* 这是这次改动唯一真正的风险。FRAMING 表里**没有缺省那一档的条目**,
       所以两条路拼出来的必须是同一串,不是"差不多" */
    const cases = [
      ['me on the balcony, hair down', 'selfie', 'medium'],
      ['me on stage, taken from the crowd', 'third', 'full']
    ] as const
    for (const [scene, shot, dflt] of cases) {
      expect(planChatPhoto(scene, true, ANCHOR, shot, dflt).prompt).toBe(
        planChatPhoto(scene, true, ANCHOR, shot).prompt
      )
    }
    const empty = planChatPhoto('rain on the window', false, ANCHOR)
    expect(planChatPhoto('rain on the window', false, ANCHOR, 'scene', 'medium').prompt).toBe(empty.prompt)
  })

  it('认不出的景别词当"没说",落回缺省', () => {
    expect(resolveFrame('selfie', 'wide', 'me on the balcony')).toBe('medium')
    expect(resolveFrame('third', 'unknown', 'me on the pier')).toBe('full')
  })

  it('景别进的是独立一层 —— 它与 pin 一样,是别人换不掉的那一条', () => {
    const p = planChatPhoto('my eyes', true, ANCHOR, 'selfie', 'close')
    expect(p.layers.find(([slot]) => slot === 'frame')?.[1]).toContain('close-up')
  })

  it('空镜的特写照样是特写,而且仍然一个人都不许有', () => {
    const p = planChatPhoto('rain running down the window pane', false, ANCHOR, undefined, 'close')
    expect(p.frame).toBe('close')
    expect(p.prompt).toContain('no people in frame')
    expect(p.prompt).toContain('one detail of the place')
  })

  it('全身那一档照样有人、照样发参考图', () => {
    const p = planChatPhoto('me on the pier', true, ANCHOR, 'third', 'full')
    expect(p.frame).toBe('full')
    expect(p.prompt).toContain('whole person, head to feet')
    expect(p.useRefs).toBe(true)
  })

  /* —— 自查抓出来的三处,各钉一条 —— */

  it('他拍的半身:场景写着"腰以上"就真的从腰以上取景', () => {
    /* 他拍那一档的缺省是全身,半身只能靠这一条进来 —— 少了它,
       FRAMING.third.medium 就是一段谁也走不到的死代码 */
    const p = planChatPhoto('me at my desk, the lamp behind me, shot from the waist up', true, ANCHOR, 'third')
    expect(p.frame).toBe('medium')
    expect(p.prompt).toContain('from the waist up')
    expect(p.prompt).not.toContain('full figure and hands inside the frame')
    expect(p.prompt).toContain('half-body')
  })

  it('**特写不该凭空长出一面镜子** —— 镜子是场景里的东西,不是可以补的修辞', () => {
    /* 全身自拍一开始写成 "full-length mirror selfie",而镜子是场景里的一件
       实物。场景没说它有镜子就不该添上 —— 与"不许编时间/天气"同一条纪律。
       判据只看 camera 那一层:pin 那层写的是"at arm's length **or in a
       mirror**",它**故意**把两条路都留着,由出图模型按场景挑一条 ——
       那不是这一层该收窄的东西 */
    for (const frame of ['full', 'close'] as const) {
      const p = planChatPhoto('me by the window', true, ANCHOR, 'selfie', frame)
      const camera = p.layers.find(([slot]) => slot === 'camera')?.[1] || ''
      expect(camera, frame).not.toMatch(/mirror/i)
      expect(camera, frame).toContain('one hand')
      /* 而"相机在它自己手上"这条事实照旧由 pin 那一层保着 */
      expect(p.prompt).toContain('own hand')
    }
  })

  it('自拍的特写:臂展不成立,但那三个"自拍"信号一个都不能少', () => {
    /* 贴到眼睛那么近不可能是手臂伸直拍的 —— 所以距离那一个词换成"一只手举近",
       而"相机在它自己手上"这条事实由 pin 那层不可让渡地写着 */
    const p = planChatPhoto('my eyes', true, ANCHOR, 'selfie', 'close')
    expect(p.prompt).not.toContain('at arm\u2019s length, the front camera pushed right in')
    expect(p.prompt).toMatch(/front camera/)
    expect(p.prompt).toContain('the hand holding the phone just inside the frame')
    expect(p.prompt, '轻微广角是四个自拍信号里的第三个').toContain('slight wide-angle distortion')
    expect(p.prompt, '"相机在自己手上"由 pin 那层保着').toContain('own hand')
  })

  /* 取景有两个来源:`camera`(可被摄影指导整句换掉)与 `frame`(不可让渡),
     所以两处只能靠**措辞**对齐。缺省那一档是最高频的一档,尤其不能各说各的 */
  it('自拍缺省档:机位句与 frame 层说的是同一个距离', () => {
    const p = planChatPhoto('me on the balcony', true, ANCHOR, 'selfie', 'medium')
    const camera = p.layers.find(([s]) => s === 'camera')?.[1] || ''
    const frame = p.layers.find(([s]) => s === 'frame')?.[1] || ''
    expect(camera, '机位句用的是"到腰"').toMatch(/from the waist up/i)
    expect(camera, '不再说"头肩" —— 那与 frame 层的半身是两个距离').not.toMatch(/face and shoulders/i)
    expect(frame, 'frame 层那一句').toMatch(/face and upper body/i)
  })
})

describe('frameLine · 不可让渡的那一句', () => {
  it('人不在画面里时一个字都不提人 —— 与空镜那条 pin 同一条纪律', () => {
    for (const f of ['close', 'medium', 'full'] as const) {
      expect(frameLine(false, f)).not.toMatch(/\bperson\b|\bsubject\b|face/)
    }
  })

  it('人在画面里时三档各有各的说法', () => {
    expect(frameLine(true, 'close')).toContain('cropped out')
    expect(frameLine(true, 'medium')).toContain('half-body')
    expect(frameLine(true, 'full')).toContain('head to feet')
  })
})

/* ===== 特写的那一格属于这个人(2026-10-06)===============================
 *  用户报的:"特写她的手,但那只手跟角色不符 —— 明明是女生,手却很粗糙。"
 *  根因不在手上:锚点句那七项**全是头部与体型**,而这一档的画面里往往没有脸,
 *  于是"这个人是谁"整段失效、参考图里那张脸也一起失效。 */
describe('characterGender · 单独给,不并进锚点句', () => {
  it('取得到那一栏', () => {
    expect(characterGender({ fields: { gender: 'female', face: 'oval face' } })).toBe('female')
  })

  it('没填过(老角色)时是空串,不报错', () => {
    expect(characterGender({ fields: { face: 'oval face' } })).toBe('')
    expect(characterGender(undefined)).toBe('')
  })
})

describe('partLine · 这一格是那个人身上的局部', () => {
  it('带上性别 —— "一只手"与"这个女生的手"是两回事', () => {
    const line = partLine('female')
    expect(line).toContain('female')
    expect(line).toContain('same skin')
  })

  it('性别空着也留着后半句 —— 它治的是"退回一只通用的手"', () => {
    const line = partLine('')
    expect(line).toContain('not a generic stand-in')
    expect(line).not.toContain('female')
  })
})

describe('planChatPhoto · part 只在特写那一档出现', () => {
  const HANDS = 'my hands wrapped around the mug, steam rising'

  it('特写:锚点句之后补一句"这一格是那个人的局部",并带上性别', () => {
    const p = planChatPhoto(HANDS, true, ANCHOR, 'selfie', 'close', 'female')
    expect(p.prompt).toContain('female')
    /* 排在锚点句之后 —— 两者是同一件事("这个人是谁") */
    expect(p.prompt.indexOf('female')).toBeGreaterThan(p.prompt.indexOf(ANCHOR))
  })

  it('**其余各档一个字都不多** —— 性别送进来也不该改它们', () => {
    /* 他拍 + 全身、自拍 + 半身是这条路上绝大多数图:那两档画面里有脸,
       锚点句与参考图兜得住,补进去只会变成标签(见 ANCHOR_KEYS 那段注释) */
    for (const [shot, frame] of [['third', 'full'], ['selfie', 'medium']] as const) {
      const withSex = planChatPhoto(BARE_SCENE, true, ANCHOR, shot, frame, 'female')
      expect(withSex.prompt).toBe(planChatPhoto(BARE_SCENE, true, ANCHOR, shot, frame).prompt)
    }
  })

  it('空镜不补 —— 画面里没有"这个人",补了就是给"风景里长出一个人"递刀', () => {
    const p = planChatPhoto('rain running down the window pane', false, '', 'scene', 'close', 'female')
    expect(p.prompt).not.toContain('female')
    expect(p.layers.map(([slot]) => slot)).not.toContain('part')
  })

  it('它在 layers 里单独成层 —— 所以摄影指导拿不到它(见 photoDirector)', () => {
    const p = planChatPhoto(HANDS, true, ANCHOR, 'selfie', 'close', 'female')
    expect(p.layers.map(([slot]) => slot)).toContain('part')
  })
})

/* ===== 特写不补"动作"(2026-10-06 查这条链时发现)======================
 *  模板那两句是以"画面里有脸"写的:自拍那句是 `mid-moment, looking into the
 *  camera`。而这一档的画面里常常只有一只手、一片布料 —— 请模型"看向镜头",
 *  就是请它把一双眼睛画进来,与"一个局部填满画面"正面打架。 */
describe('planChatPhoto · 动作那一层在特写下不出现', () => {
  it('拍手时不补"看向镜头" —— 那不是这一档的画面里有的东西', () => {
    const p = planChatPhoto('my hands wrapped around the mug', true, ANCHOR, 'selfie', 'close')
    expect(p.prompt).not.toContain('looking into the camera')
    expect(p.layers.map(([slot]) => slot)).not.toContain('action')
  })

  it('半身与全身照旧补 —— 那两档人整只在画面里,那两句成立', () => {
    for (const [shot, frame] of [['selfie', 'medium'], ['third', 'full']] as const) {
      const p = planChatPhoto('the pier at dusk', true, ANCHOR, shot, frame)
      expect(p.layers.map(([slot]) => slot), `${shot}/${frame}`).toContain('action')
    }
  })

  it('场景自己交代了动作时,本来就不补 —— 这条纪律没变', () => {
    const p = planChatPhoto('leaning on the balcony rail', true, ANCHOR, 'selfie', 'medium')
    expect(p.layers.map(([slot]) => slot)).not.toContain('action')
  })

  /* 2026-10-08:这一层的偏置与其余各层相反 —— 漏判不是"落回默认",
     而是"补一句与场景打架的动作"。中文动作太自由,英文词表认不出
     "蜷在沙发上""削苹果"这类说法,所以中文场景整层不补 */
  it('中文场景一律不补动作 —— 判据是"场景是中文",不是"词表有没有命中"', () => {
    for (const zh of ['蜷在沙发上翻一本旧画册', '她坐着看窗外的雨']) {
      const p = planChatPhoto(zh, true, ANCHOR, 'selfie', 'medium')
      expect(p.layers.map(([slot]) => slot), zh).not.toContain('action')
    }
  })
})

describe('planChatPhoto · 心情写在脸上那一层', () => {
  const slots = (p: ReturnType<typeof planChatPhoto>) => p.layers.map(([slot]) => slot)

  it('有词、画面里有人、不是特写:那一层在,而且词原样出现', () => {
    const p = planChatPhoto(BARE_SCENE, true, ANCHOR, 'selfie', 'medium', '', 'wary')
    expect(slots(p)).toContain('expression')
    expect(p.prompt).toContain('wary')
  })

  it('排在锚点句之后 —— 先立住"是谁",再给"此刻什么样"', () => {
    const p = planChatPhoto(BARE_SCENE, true, ANCHOR, 'selfie', 'medium', '', 'wary')
    expect(p.prompt.indexOf('cheekbones')).toBeLessThan(p.prompt.indexOf('wary'))
  })

  it('画面里没有人:不拼 —— 一张空镜里没有脸', () => {
    const p = planChatPhoto('an empty harbour at dawn', false, ANCHOR, undefined, undefined, '', 'wary')
    expect(slots(p)).not.toContain('expression')
    expect(p.prompt).not.toContain('wary')
  })

  it('特写那一档不拼 —— 那一格常常没有脸,请它写神情就是请它把脸画进来', () => {
    const p = planChatPhoto('my hands wrapped around the mug', true, ANCHOR, 'selfie', 'close', '', 'wary')
    expect(slots(p)).not.toContain('expression')
  })

  it('词不合法就什么都不做,而且**不猜**', () => {
    for (const bad of ['', '   ', '喵', 'very tired']) {
      const p = planChatPhoto(BARE_SCENE, true, ANCHOR, 'selfie', 'medium', '', bad)
      expect(slots(p), bad).not.toContain('expression')
    }
  })

  it('不给这一项时与加它之前一模一样 —— 老记录那条路不受影响', () => {
    const p = planChatPhoto(BARE_SCENE, true, ANCHOR, 'selfie', 'medium', 'female')
    expect(slots(p)).not.toContain('expression')
  })

  it('大小写与空白容忍:库里那个词是大写也认', () => {
    const p = planChatPhoto(BARE_SCENE, true, ANCHOR, 'selfie', 'medium', '', ' TIRED ')
    expect(p.prompt).toContain('tired')
  })

  it('写的是"脸上的神情",不是把它演成一个动作', () => {
    /* 只写 angry,模型很容易画成摔东西、吼 —— 身体那件事由 action 层
       与 negative 层管,轮不到情绪插手 */
    const p = planChatPhoto(BARE_SCENE, true, ANCHOR, 'selfie', 'medium', '', 'angry')
    expect(p.prompt).toMatch(/on the face/)
    expect(p.prompt).toMatch(/not acted out/)
  })
})

describe('planChatPhoto · 分层与顺序', () => {

  it('场景照:不拼锚点、不发参考图、镜头是空镜', () => {
    const p = planChatPhoto('rain on the window at dawn', false, ANCHOR)
    expect(p.prompt).not.toContain('cheekbones')
    expect(p.useRefs).toBe(false)
    expect(p.shot).toBe('scene')
  })

  it('有它本人时拼锚点、发参考图', () => {
    const p = planChatPhoto('leaning on the balcony at night', true, ANCHOR)
    expect(p.prompt).toContain('cheekbones')
    expect(p.useRefs).toBe(true)
  })

  it('场景排在锚点之前 —— 前段权重更高,先说要画什么', () => {
    const p = planChatPhoto('leaning on the balcony', true, ANCHOR)
    expect(p.prompt.indexOf('balcony')).toBeLessThan(p.prompt.indexOf('cheekbones'))
  })

  it('镜头句排在锚点之前 —— 没有它,"自拍"只是场景里的一个词', () => {
    const p = planChatPhoto('taking a selfie by the window', true, ANCHOR)
    expect(p.prompt.indexOf('front camera')).toBeLessThan(p.prompt.indexOf('cheekbones'))
  })

  it('空镜模板一个字都不许提到人 —— 那正是"风景里长出一个人"', () => {
    const p = planChatPhoto('an empty harbour at dawn', false, '')
    expect(p.prompt).toContain('no people in frame')
    expect(p.prompt).not.toMatch(/\b(face|subject|figure|shoulders)\b/)
  })

  it('负面约束垫在最后,挡的是证件照那套默认构图', () => {
    const p = planChatPhoto('me on the balcony', true, ANCHOR)
    expect(p.prompt).toContain('not a character sheet')
    expect(p.prompt).toContain('not a passport or ID photo')
    /* 垫在最后是一条顺序上的不变量:前面几层被截断时,它才是最后一个被丢的 */
    expect(p.layers[p.layers.length - 1]?.[0]).toBe('negative')
  })

  /* —— 肢体与拼贴(2026-10-06)——
     用户报的是"生成的图特别是特写图会出现四肢畸形,或者缺少"。 */
  it('负面约束要挡"多出来的、长错的"肢体', () => {
    const p = planChatPhoto('me on the balcony', true, ANCHOR)
    expect(p.prompt).toMatch(/no extra limbs/i)
    expect(p.prompt).toMatch(/no extra or fused fingers/i)
    expect(p.prompt).toMatch(/no deformed or duplicated hands/i)
  })

  it('**刻意不写"不许缺肢体"** —— 那句会与特写的构图打架,把镜头拉回去', () => {
    /* 特写那一档明写着"其余身体出画"(见 FRAMING)。模型读到"no missing limbs"
       最省力的解法是把镜头拉远 —— 而那正是这一轮刚修好的毛病。
       "缺"要治在机位句上,不是治在负面词上 */
    const close = planChatPhoto('my eyes', true, ANCHOR, 'selfie', 'close')
    expect(close.prompt).not.toMatch(/missing limbs?/i)
    expect(close.prompt).not.toMatch(/cropped (?:through|at the edge)/i)
    /* 而它该有的那两条照旧在 */
    expect(close.prompt).toMatch(/no extra limbs/i)
  })

  it('负面约束也要挡拼贴 —— 我们发的参考图里有两张 2×2 网格', () => {
    const p = planChatPhoto('me on the balcony', true, ANCHOR)
    expect(p.prompt).toMatch(/not a collage/i)
    expect(p.prompt).toMatch(/not a contact sheet/i)
    expect(p.prompt).toMatch(/no panels/i)
  })

  it('没填过设定的角色照样发参考图 —— 参考图是图,不依赖那段文字', () => {
    const p = planChatPhoto('me, at my desk', true, '')
    expect(p.useRefs).toBe(true)
    expect(p.prompt).toContain('me, at my desk')
  })

  it('只写锚点、没有场景时给空提示词(调用方据此直接放弃这一张)', () => {
    expect(planChatPhoto('', true, ANCHOR).prompt).toBe('')
    expect(planChatPhoto('   ', true, ANCHOR).useRefs).toBe(false)
  })

  it('超长按上限截断', () => {
    const long = 'x'.repeat(CHAT_PHOTO_PROMPT_CHARS + 500)
    expect(planChatPhoto(long, false, ANCHOR).prompt.length).toBe(CHAT_PHOTO_PROMPT_CHARS)
  })

  it('退化输入不抛', () => {
    expect(planChatPhoto(undefined as unknown as string, false, '').prompt).toBe('')
    expect(planChatPhoto('a', true, undefined as unknown as string).prompt).toContain('a')
  })
})

/* ===== 只补不覆盖 ====================================================
 *  这一组是"模板不许和场景打架"的全部依据。场景说过的位,模板一个字都不许再说 ——
 *  两句光/两个焦段凑在一张提示词里,模型会挑一处当噪声丢掉,或者硬凑成一张怪图。 */

describe('missingSlots · 场景已经说了什么', () => {
  it('写了光就不补光', () => {
    expect(missingSlots('a lamp on the desk, warm light').light).toBe(false)
    expect(missingSlots('窗边一盏灯,暖光').light).toBe(false)
  })

  it('写了景深/镜头就不补镜头', () => {
    expect(missingSlots('a portrait, shallow depth of field').lens).toBe(false)
    expect(missingSlots('背景虚化').lens).toBe(false)
  })

  it('没写就补', () => {
    const m = missingSlots('a rooftop at dawn')
    expect(m.light).toBe(true)
    expect(m.lens).toBe(true)
  })

  it('"sunny" 里的 sun 不算写了光 —— 词表必须认词边界', () => {
    expect(missingSlots('a sunny rooftop').light).toBe(true)
  })
})

describe('planChatPhoto · 只补不覆盖', () => {
  it('场景写了光,模板就不再塞一句自己的光(含中文场景)', () => {
    /* 这几条场景都没有"自拍/他拍"的字眼,所以落回**默认视角 = 自拍** ——
       判据要拿自拍那一档模板的光句来比(见下面"视角"那一组) */
    const en = planChatPhoto('sitting by the window in warm afternoon light', true, ANCHOR)
    expect(en.prompt).not.toContain('natural light falling on the face')
    const zh = planChatPhoto('坐在窗边,午后的光很暖', true, ANCHOR)
    expect(zh.prompt).not.toContain('natural light falling on the face')
  })

  it('场景没说光,模板补一句', () => {
    const p = planChatPhoto('leaning on the balcony', true, ANCHOR)
    expect(p.prompt).toContain('natural light falling on the face')
  })

  it('下雨时补的是"湿处反光",不是一个凭空的晴天光', () => {
    const p = planChatPhoto('standing on the balcony, rain on the glass', true, ANCHOR)
    expect(p.prompt).toContain('wet reflections')
    expect(p.prompt).not.toContain('one side of the face brighter')
  })

  it('场景已经交代了动作,就不补模板那个"此刻在做什么"', () => {
    const p = planChatPhoto('sitting on the floor, reading a letter', true, ANCHOR)
    expect(p.prompt).not.toContain('caught mid-movement')
  })

  it('纵深是无条件的 —— 它是相机原理,不该被"场景提过窗/桌"挡掉', () => {
    const p = planChatPhoto('typing at my desk in the study', true, ANCHOR)
    expect(p.prompt).toContain('right behind the shoulders')
  })
})

/* ===== 尺寸与参考图 ================================================== */

describe('shotRatio / shotViewOrder', () => {
  it('有人竖、空镜横', () => {
    expect(shotRatio('selfie')).toBeLessThan(1)
    expect(shotRatio('third')).toBeLessThan(1)
    expect(shotRatio('scene')).toBeGreaterThan(1)
  })

  it('自拍以正面为主', () => {
    expect(shotViewOrder('selfie')[0]).toBe('front')
  })

  it('他拍以全身那张打头 —— 身高体型不能靠模型现编', () => {
    expect(shotViewOrder('third')[0]).toBe('full')
  })

  it('视图名必须是真实存在的枚举 —— 写错只会静静地少一张参考图', () => {
    /* 判据取自 CHARACTER_VIEWS 本身,不另抄一份:抄的那份在换视图时会静静地过期
       (2026-10-06 就发生过 —— expression 换成 body,而手抄的那张表还写着 expression) */
    const real = new Set(CHARACTER_VIEWS.map((v) => v.kind as string))
    for (const shot of ['selfie', 'third', 'scene'] as const) {
      for (const frame of [undefined, 'close', 'medium', 'full'] as const) {
        const order = shotViewOrder(shot, frame)
        for (const k of order) expect(real.has(k)).toBe(true)
        expect(new Set(order).size).toBe(order.length)
      }
    }
  })
})

/* ===== 景别 → 参考图(2026-10-06)=========================================
 *  与提示词那一侧同一条理由:参考图在图像编辑那条路上是**最强的机位来源** ——
 *  把机位句改近了、手上却给一张"整个人在画面里"的参考,取景照样会被拽回去。
 *  这一组钉住的是**边界**:两端必须动,中间必须一个字不动。 */
describe('shotViewOrder · 景别也决定参考图', () => {
  it('特写:全身像出局 —— 它正是把取景往回拽的那一张', () => {
    expect(shotViewOrder('selfie', 'close')).not.toContain('full')
    expect(shotViewOrder('third', 'close')).not.toContain('full')
  })

  it('特写:正面像打头、closeups 紧跟 —— 头一张不留给带版式先验的 2×2 网格', () => {
    for (const shot of ['selfie', 'third'] as const) {
      const order = shotViewOrder(shot, 'close')
      expect(order[0]).toBe('front')
      expect(order[1]).toBe('closeups')
    }
  })

  it('全身:全身像打头,两条视角都一样 —— 与谁拿的相机无关', () => {
    expect(shotViewOrder('selfie', 'full')[0]).toBe('full')
    expect(shotViewOrder('third', 'full')[0]).toBe('full')
  })

  it('特写:肢体那张(2×2 手/臂/腿/脚)在,而且落在外发的张数以内', () => {
    /* 这一档的画面里常常没有脸 —— 那时参考图里只有 closeups 那四分之一格
       是"手上的证据",不够。它必须落在上限 4 以内,排在最后一位等于白加 */
    for (const shot of ['selfie', 'third'] as const) {
      const order = shotViewOrder(shot, 'close')
      expect(order).toContain('body')
      expect(order.indexOf('body')).toBeLessThan(4)
    }
  })

  it('肢体那张只进特写这一档 —— 其余两条顺序里根本没有它', () => {
    /* 全身/半身里手和腿只占几十个像素,给一张 2×2 的肢体只是多一份网格。
       它从前排在第五、上限四张,取不到;现在直接移出数组,免得上限一变它就
       悄悄溜进来(2026-10-08) */
    for (const [shot, frame] of [['selfie', 'medium'], ['third', 'full']] as const) {
      expect(shotViewOrder(shot, frame), `${shot}/${frame}`).not.toContain('body')
    }
    expect(shotViewOrder('selfie', 'close')).toContain('body')
  })

  /* 2026-10-08:参考图里的 2×2 网格是 i2i 的"拷贝先验" —— 畸形的一大来源。
     摘掉 detail(四个头角度),并且只留一张网格;第一张永远是单张人像。 */
  it('detail(四个头角度)不进任何一条顺序 —— 它是纯网格,离随手拍最远', () => {
    for (const shot of ['selfie', 'third', 'scene'] as const) {
      for (const frame of [undefined, 'close', 'medium', 'full'] as const) {
        expect(shotViewOrder(shot, frame), `${shot}/${frame}`).not.toContain('detail')
      }
    }
  })

  it('最多一张 2×2 网格(特写档两张),第一张永远是单张人像', () => {
    const GRIDS = ['detail', 'closeups', 'body']
    const cases = [
      ['selfie', 'medium', 1],
      ['third', 'full', 1],
      ['selfie', undefined, 1],
      ['third', undefined, 1],
      ['scene', undefined, 1],
      ['selfie', 'close', 2],
      ['third', 'close', 2]
    ] as const
    for (const [shot, frame, max] of cases) {
      const order = shotViewOrder(shot, frame)
      expect(
        order.filter((k) => GRIDS.includes(k)).length,
        `${shot}/${frame} 的网格数`
      ).toBeLessThanOrEqual(max)
      expect(['front', 'full'], `${shot}/${frame} 的第一张`).toContain(order[0])
    }
  })

  it('**缺省那一档逐字不变** —— 他拍缺省是全身,自拍缺省是半身', () => {
    /* 这一档吃掉了这条路上绝大多数图:他拍 + 全身必须与"景别没参与时"逐字相同 */
    expect(shotViewOrder('third', 'full')).toEqual(shotViewOrder('third'))
    /* 半身不登记 —— 自拍那一档的缺省就是它,所以他拍传半身也照旧 */
    expect(shotViewOrder('selfie', 'medium')).toEqual(shotViewOrder('selfie'))
    expect(shotViewOrder('third', 'medium')).toEqual(shotViewOrder('third'))
  })
})

describe('chatPhotoSize · 按场景挑尺寸,别一律方框', () => {
  const FIXED = ['1024x1024', '1536x1024', '1024x1536']

  it('有人 → 竖幅那一档', () => {
    expect(chatPhotoSize(FIXED, 'selfie', false)).toBe('1024x1536')
    expect(chatPhotoSize(FIXED, 'third', false)).toBe('1024x1536')
  })

  it('空镜 → 横幅那一档', () => {
    expect(chatPhotoSize(FIXED, 'scene', false)).toBe('1536x1024')
  })

  it('在自由尺寸那组里也挑得出竖幅 —— 不挑回 auto', () => {
    const free = ['auto', '1024x1024', '1024x1792', '1792x1024', '512x512', '2560x1440']
    expect(chatPhotoSize(free, 'third', true)).toBe('1024x1792')
    /* 3:2 与 1.75 的距离(0.154)比与 16:9 的(0.170)更近 —— 挑的是比例,
       不是"数字大的那个" */
    expect(chatPhotoSize(free, 'scene', true)).toBe('1792x1024')
  })

  it('一个显式比例都没有时才退回 auto / 第一档', () => {
    expect(chatPhotoSize(['auto'], 'third', true)).toBe('auto')
    expect(chatPhotoSize(['1280x720'], 'third', false)).toBe('1280x720')
  })

  it('空候选不返回空串 —— 空值会被发到上游', () => {
    expect(chatPhotoSize([], 'selfie', false)).toBe('auto')
    expect(chatPhotoSize(undefined as unknown as string[], 'selfie', false)).toBe('auto')
  })
})

/* 对话背景图:沉浸页铺满屏幕的那一张。它与"角色发的那张图"是两件事 ——
   那张是随手拍给人的,这张是**给字让位的底**。所以这里盯的不是"画得像不像",
   而是那几条**只有背景图才需要**的性质:横构图、主体靠右、左边留给字。 */
describe('planChatBackdrop · 对话背景图', () => {
  it('横构图 + 主体靠右 + 左边留给字(这三条缺一条就不成其为背景)', () => {
    const p = planChatBackdrop('sitting by the window at night', 'warm smile, dark hair')
    expect(p.prompt).toMatch(/wide landscape/i)
    expect(p.prompt).toMatch(/right third/i)
    expect(p.prompt).toMatch(/left two thirds/i)
  })

  it('场景原文一字不改地进去(与照片那条同一条纪律)', () => {
    const scene = 'leaning on the balcony rail, the rain just stopped'
    expect(planChatBackdrop(scene).prompt).toContain(scene)
  })

  it('锚点句带上 —— 背景里那个人也得是同一个人', () => {
    const p = planChatBackdrop('at a rooftop bar', 'oval face, high cheekbones')
    expect(p.prompt).toContain('oval face, high cheekbones')
    // 没有锚点时不该留一句空的
    expect(planChatBackdrop('at a rooftop bar').prompt).not.toContain('undefined')
  })

  it('负面约束要挡掉"居中证件照"与"左边很亮很乱"', () => {
    const p = planChatBackdrop('at a rooftop bar')
    expect(p.prompt).toMatch(/not a passport or ID photo/i)
    expect(p.prompt).toMatch(/no bright cluttered left side/i)
  })

  it('没有场景就不出提示词 —— 一张没有场景的人像当背景不如用它的剧照', () => {
    expect(planChatBackdrop('').prompt).toBe('')
    expect(planChatBackdrop('   ').prompt).toBe('')
  })

  /* 实测反馈:"人物占比太大了,并且在正中间,和效果图差距太大"。
     根子在两处 —— 尺度没写死(那句 medium distance 在摄影里就是半身景),
     而负面约束里**一条"不许特写"都没有**,偏偏场景串常常写着"我在车后座"。
     下面几条盯的就是这两处,别让它们再退回去 */
  it('人在画面里是**小的**:尺度写在最前一层,而不是埋在机位那句里', () => {
    const p = planChatBackdrop('me in the back seat of the car')
    const [first] = p.layers
    expect(first[0]).toBe('medium')
    expect(first[1]).toMatch(/wide landscape/i)
    expect(first[1]).toMatch(/small in the frame/i)
    /* 顺序就是权重:这一层必须排在场景之前 —— 场景自带"镜头就在脸前"的语境 */
    expect(p.layers.findIndex(([k]) => k === 'medium')).toBe(0)
    expect(p.layers.findIndex(([k]) => k === 'scene')).toBeGreaterThan(0)
  })

  it('不许特写、不许大脸:negative 里那几条必须都在', () => {
    const p = planChatBackdrop('me in the back seat of the car')
    expect(p.prompt).toMatch(/not a close-up/i)
    expect(p.prompt).toMatch(/not a headshot/i)
    expect(p.prompt).toMatch(/not a selfie/i)
    expect(p.prompt).toMatch(/does not fill the frame/i)
  })

  it('不再写 "medium distance" —— 那句话正是半身景的来源', () => {
    expect(planChatBackdrop('at a rooftop bar').prompt).not.toMatch(/medium distance/i)
  })

  it('深焦:把房间虚掉就是把"这一场戏"虚掉了', () => {
    const p = planChatBackdrop('at a rooftop bar')
    expect(p.prompt).toMatch(/deep focus/i)
    expect(p.prompt).not.toMatch(/shallow depth of field/i)
  })
})

/* 背景图发哪几张设定图当参考。detail / closeups 是头肩与面部的 2×2 网格 ——
   四格里全是大脸,模型会跟着把镜头拉到脸上。这几条盯的是"别再把它们发出去" */
describe('backdropViewOrder · 背景图的参考图', () => {
  it('全身像打头、正脸跟上 —— 这两张管"还是同一个人"与身形', () => {
    expect(backdropViewOrder()).toEqual(['full', 'front'])
  })

  it('不发那两张 2×2 的面部网格', () => {
    const order = backdropViewOrder()
    expect(order).not.toContain('detail')
    expect(order).not.toContain('closeups')
  })

  it('每张都在已知视图清单里 —— 写错一个键不会报错,只会静静少一张参考图', () => {
    const known = CHARACTER_VIEWS.map((v) => v.kind as string)
    for (const kind of backdropViewOrder()) expect(known).toContain(kind)
  })
})
