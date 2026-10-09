import { describe, expect, it } from 'vitest'
import { planChatPhoto } from './chatPhoto'
import {
  DIRECTOR_LINE_CHARS,
  applyDirector,
  directorBrief,
  directorTask,
  frameBrief,
  parseDirector,
  shotBrief
} from './photoDirector'

/* 这一层是"把一句短场景交给文本模型补成怎么拍"。而自由文本会以三种方式
   破坏已经拼好的提示词(改写场景 / 编时间 / 写焦段),这三种都**不会报错**,
   只会让画面变味。所以断言几乎全落在验收、护栏与降级上。

   还有一条同样重要(2026-10-05 起):**它改不了视角**。
   视角由聊天模型写在标签里、由 planChatPhoto 定为模板,它只被告知。 */

const ANCHOR = 'oval face, dark bob'
/** 一份"什么都没说"的场景:四位都得补 */
const BARE = 'leaning on the balcony'
/** 一份已经交代了光与景深的场景:那两位不该被覆盖 */
const COVERED = 'leaning on the balcony, warm lamp light, shallow depth of field'

const ANSWER = [
  'Camera: hand-held at chest height, slightly below eye level',
  'Lens: shallow focus, the railing soft in the foreground',
  'Light: a warm lamp just off frame to the left, grazing the wall',
  'Environment: the city below falling away into haze'
].join('\n')

/** 把一段原始输出走完整条解析 + 合并,与 useGeneration 里的顺序一致。
 *  `shot` 是**标签**给的那一项(不是摄影指导判的 —— 它已经没有这个权力了) */
function merge(scene: string, self: boolean, raw: string, shot?: 'selfie' | 'third') {
  const plan = planChatPhoto(scene, self, ANCHOR, shot)
  return applyDirector(plan, parseDirector(raw))
}

describe('parseDirector · 认固定几行', () => {
  it('四行都认出来', () => {
    const w = parseDirector(ANSWER)
    expect(w.camera).toContain('chest height')
    expect(w.lens).toContain('shallow focus')
    expect(w.light).toContain('warm lamp')
    expect(w.env).toContain('falling away into haze')
  })

  it('Shot 那行不进这四位 —— 它已经不写了,写了也不作数', () => {
    expect(parseDirector('Shot: selfie')).toEqual({})
    /* 混在一起时也不影响别的行 */
    const w = parseDirector('Shot: selfie\nCamera: low angle')
    expect(w).toEqual({ camera: 'low angle' })
  })

  it('标签大小写与空格都不计较 —— 模型不总写得一丝不差', () => {
    const w = parseDirector('camera : low angle\nLIGHT:  hard sun  ')
    expect(w.camera).toBe('low angle')
    expect(w.light).toBe('hard sun')
  })

  it('中文冒号也认', () => {
    expect(parseDirector('Camera：low angle').camera).toBe('low angle')
  })

  it('认不出的标签忽略,不影响认得出的', () => {
    const w = parseDirector('Mood: tense\nCamera: low angle\nFoo: bar')
    expect(w.camera).toBe('low angle')
    expect(Object.keys(w)).toEqual(['camera'])
  })

  it('散文、空行、前言都不认 —— 只认带标签的行', () => {
    expect(parseDirector('Sure! Here are the lines.\n\nThis is a balcony at night.')).toEqual({})
  })

  it('退化输入不抛', () => {
    expect(parseDirector('')).toEqual({})
    expect(parseDirector(undefined as unknown as string)).toEqual({})
  })

  it('空值行不算补上 —— 模型用空行表示"这一位留空"', () => {
    expect(parseDirector('Camera: \nLight: none')).toEqual({})
    expect(parseDirector('Camera: n/a\nLight: -')).toEqual({})
  })
})

describe('parseDirector · 三条验收(每一条都丢整行)', () => {
  it('编时间就丢 —— 场景没说几点,它写黄昏会和对话里正在值夜班的它矛盾', () => {
    expect(parseDirector('Light: soft light at dusk, warm from the west').light).toBeUndefined()
    /* 丢的是整行,不是那个词 —— 删完剩半句更糟 */
    expect(parseDirector('Camera: low angle\nLight: at dusk').camera).toBe('low angle')
  })

  it('写焦段或光圈就丢 —— 那是和场景无关的噪声', () => {
    expect(parseDirector('Lens: shot at 85mm, shallow focus').lens).toBeUndefined()
    expect(parseDirector('Lens: 35 mm wide').lens).toBeUndefined()
    expect(parseDirector('Lens: wide open f/1.4').lens).toBeUndefined()
  })

  it('"midnight blue" 这种合法颜色也会被时间词误伤 —— 宁可丢一行也不放它进画面', () => {
    /* 这一条记录的是取舍,不是缺陷:误伤的代价是退回模板(少一句话),
       放过去的代价是画面与对话矛盾(整张不对味) */
    expect(parseDirector('Light: midnight blue cast').light).toBeUndefined()
  })

  it('破坏行结构的字符被抹掉,短语本身留着', () => {
    expect(parseDirector('Camera: **low angle**; "hand-held"').camera).toBe('low angle hand-held')
  })

  it('逗号留着 —— 规则里要的就是逗号分隔的短语', () => {
    expect(parseDirector('Camera: low angle, hand-held, off-center').camera).toBe(
      'low angle, hand-held, off-center'
    )
  })

  it('超长截断', () => {
    const long = 'Light: ' + 'x'.repeat(DIRECTOR_LINE_CHARS + 200)
    expect(parseDirector(long).light?.length).toBe(DIRECTOR_LINE_CHARS)
  })
})

describe('applyDirector · 视角它一个字都改不了', () => {
  /* 2026-10-05 改:视角原先归它判,现在归聊天模型的标签(见 planChatPhoto)。
     这几条钉的是"改不了"这件事 —— 它是用户报的那个毛病的根:
     只看得到一句场景的模型,猜"谁拿的相机"永远猜成他拍。 */

  it('标签说 selfie,它那套机位盖不住这件事 —— 自拍那句硬约束还在', () => {
    const p = merge(BARE, true, ANSWER, 'selfie')
    expect(p.shot).toBe('selfie')
    expect(p.prompt).toContain('in the subject\u2019s own hand')
    expect(p.prompt).toContain('front camera')
    /* 机位那一句仍然听它的(那是它该管的事) */
    expect(p.prompt).toContain('chest height')
  })

  it('它自己写一行 Shot: selfie 也改不了他拍那一套', () => {
    const p = merge(BARE, true, 'Shot: selfie\nCamera: low angle', 'third')
    expect(p.shot).toBe('third')
    /* 机位那句被它自己换掉了,所以判据落在他拍模板独有的那几层上 */
    expect(p.prompt).toContain('casual snapshot taken on a phone by somebody else')
    expect(p.prompt).toContain('layered with depth')
    expect(p.prompt).not.toContain('front camera')
    expect(p.prompt).not.toContain('in the subject\u2019s own hand')
  })

  it('标签没说时按场景判:场景写着自拍就是自拍', () => {
    const p = merge('taking a selfie by the window', true, 'Camera: low angle')
    expect(p.shot).toBe('selfie')
    expect(p.prompt).toContain('front camera')
  })

  it('标签没说、场景也没说:默认自拍(原来的默认是他拍,那正是用户报的毛病)', () => {
    const p = merge(BARE, true, 'Camera: low angle')
    expect(p.shot).toBe('selfie')
    expect(p.prompt).toContain('front camera')
  })

  it('**画面里没有人时空镜不变** —— 空镜里长出一个人最严重', () => {
    const p = merge('an empty harbour', false, 'Shot: selfie\nCamera: low angle', 'selfie')
    expect(p.shot).toBe('scene')
    expect(p.prompt).toContain('no people in frame')
    /* 机位仍然听它的(空镜也要有人定机位),但绝不能出现自拍那套词 */
    expect(p.prompt).toContain('low angle')
    expect(p.prompt).not.toContain('arm\u2019s length')
    expect(p.prompt).not.toContain('front camera')
  })

  it('它换掉机位也不会把身份锚点弄丢', () => {
    expect(merge(BARE, true, ANSWER, 'selfie').prompt).toContain(ANCHOR)
  })
})

describe('applyDirector · 逐位合并与降级', () => {
  it('四位都写回来时,提示词里换成了模型写的那几句', () => {
    const p = merge(BARE, true, ANSWER)
    expect(p.prompt).toContain('chest height')
    expect(p.prompt).toContain('warm lamp')
    expect(p.prompt).toContain('falling away into haze')
    /* 模板那几句应当被换掉,而不是两份都在 */
    expect(p.prompt).not.toContain('third-person view')
    expect(p.prompt).not.toContain('layered with depth')
  })

  it('场景已经写了光,模型再写一句光也不采用 —— 两句光会互相打架', () => {
    const p = merge(COVERED, true, ANSWER)
    expect(p.prompt).toContain('warm lamp light')
    expect(p.prompt).not.toContain('warm lamp just off frame')
  })

  it('场景已经写了景深,模型再写一句镜头也不采用', () => {
    const p = merge(COVERED, true, ANSWER)
    expect(p.prompt).toContain('shallow depth of field')
    expect(p.prompt).not.toContain('railing soft in the foreground')
  })

  it('机位与纵深是无条件接受的 —— 它们不是事实,是相机原理', () => {
    const p = merge(COVERED, true, ANSWER)
    expect(p.prompt).toContain('chest height')
    expect(p.prompt).toContain('falling away into haze')
  })

  it('模型没写的位退回模板 —— 降级是逐位的,不是整层', () => {
    const p = merge(COVERED, true, 'Camera: low angle')
    expect(p.prompt).toContain('low angle')
    expect(p.prompt).toContain('warm lamp light')
    /* 没人写纵深,就用这一档模板自己的那句(默认自拍 ⇒ 是自拍那一句) */
    expect(p.prompt).toContain('right behind the shoulders')
  })

  it('护栏丢掉的行,那一位退回模板', () => {
    const p = merge(BARE, true, 'Light: at dusk\nCamera: low angle')
    expect(p.prompt).toContain('low angle')
    expect(p.prompt).not.toContain('dusk')
    expect(p.prompt).toContain('natural light falling on the face')
  })

  it('场景原文、锚点句、负面约束一个字都不许动', () => {
    const p = merge(BARE, true, ANSWER)
    expect(p.prompt).toContain(BARE)
    expect(p.prompt).toContain(ANCHOR)
    expect(p.prompt).toContain('not a character sheet')
  })

  it('空镜:摄影指导换得掉机位,却换不掉"画面里没有人"', () => {
    /* 防回归:那句约束原先是并进 camera 那一层的,而 applyDirector 会替换 camera ——
       于是空镜失去了唯一挡人的防线。现在它是独立一层(ShotTemplate.pin) */
    const p = merge('an empty harbour at dawn', false, ANSWER)
    expect(p.prompt).toContain('no people in frame')
    expect(p.prompt).toContain('chest height')
    expect(p.prompt).not.toContain('held steady')
  })

  it('有人那两档不带"没有人"这句话', () => {
    expect(merge(BARE, true, ANSWER).prompt).not.toContain('no people in frame')
  })

  it('合并后 prompt 与 layers 始终一致', () => {
    const p = merge(BARE, true, ANSWER)
    expect(p.prompt).toBe(p.layers.map(([, v]) => v).filter(Boolean).join(', '))
  })

  it('退化输入不抛(模型什么都没写)', () => {
    const plan = planChatPhoto(BARE, true, ANCHOR)
    expect(applyDirector(plan, {}).prompt).toBe(plan.prompt)
  })

  it('没场景时不动它(空计划没有层可换)', () => {
    const empty = planChatPhoto('', true, ANCHOR)
    expect(applyDirector(empty, parseDirector(ANSWER)).prompt).toBe('')
  })
})

describe('directorTask / directorBrief · 告诉模型该干什么', () => {
  it('任务里带场景原文 —— 它必须基于这一场写,不是凭空写', () => {
    expect(directorTask(planChatPhoto(BARE, true, ANCHOR))).toContain(BARE)
  })

  it('**把视角当事实告诉它** —— 它没有判的权力,但机位那句要与之相符', () => {
    const selfie = directorTask(planChatPhoto(BARE, true, ANCHOR, 'selfie'))
    expect(selfie).toContain('The character is in this image')
    expect(selfie).toContain('own hand')
    expect(selfie).toContain('do not switch to a third-person view')
    /* 不再要它自己判 —— 那句话是上一版的,正是"老出他拍"的来源 */
    expect(selfie).not.toContain('Decide Shot yourself')

    const third = directorTask(planChatPhoto(BARE, true, ANCHOR, 'third'))
    expect(third).toContain('Somebody else is holding the phone')
    expect(third).toContain('not a selfie')
    expect(third).not.toContain('own hand')

    const scene = directorTask(planChatPhoto('an empty harbour', false, ''))
    expect(scene).toContain('no character in this image')
  })

  it('shotBrief 三档各说各的一句(空镜那档不提人)', () => {
    expect(shotBrief('selfie')).toContain('own hand')
    expect(shotBrief('selfie')).toContain('do not switch to a third-person view')
    expect(shotBrief('third')).toContain('Somebody else is holding the phone')
    expect(shotBrief('third')).toContain('casual hand-held look')
    expect(shotBrief('scene')).toContain('set down or held steady')
    expect(shotBrief('scene')).not.toContain('selfie')
  })

  it('场景已经覆盖的位要明确告诉它留空', () => {
    const brief = directorBrief(planChatPhoto(COVERED, true, ANCHOR))
    expect(brief).toContain('Lens')
    expect(brief).toContain('Light')
    expect(brief).toContain('Leave those lines empty')
  })

  it('四位都空着时不说"留空"', () => {
    const brief = directorBrief(planChatPhoto(BARE, true, ANCHOR))
    expect(brief).toContain('covers none')
    expect(brief).not.toContain('Leave those lines empty')
  })
})

/* ===== 景别:同样只被告知,而且换不掉(2026-10-06) ==================
 *  它与视角是同一件事的两面 —— 都是"用户要什么",都不是它猜得出来的。
 *  它写的 `Camera:` 那一行正是"推多近",所以不告诉它,它就会自己挑一个距离,
 *  而 `applyDirector` 是整句替换:模板里那句对的会被整个顶掉。 */

describe('frameBrief · 把景别当事实告诉它', () => {
  it('任务里带着这一张的景别', () => {
    const close = directorTask(planChatPhoto('my eyes', true, ANCHOR, 'selfie', 'close'))
    expect(close).toContain('tight close-up')
    expect(close).toContain('do not pull back')

    const full = directorTask(planChatPhoto('me on the pier', true, ANCHOR, 'third', 'full'))
    expect(full).toContain('full-figure shot')
    expect(full).toContain('do not push in')
  })

  it('三档各说各的一句,而且人与空镜分开写', () => {
    expect(frameBrief('close', true)).toContain('cropped out')
    expect(frameBrief('medium', true)).toContain('half-body')
    expect(frameBrief('full', true)).toContain('head to feet')
    /* 空镜里没有"整个人"这回事 —— 写出来就是给"风景里长出一个人"递刀 */
    expect(frameBrief('close', false)).toContain('nobody is in it')
    expect(frameBrief('medium', false)).not.toContain('character')
    expect(frameBrief('full', false)).not.toContain('character')
    expect(frameBrief('full', false)).toContain('whole place')
  })
})

describe('applyDirector · 景别它一个字都改不了', () => {
  /* 它写回来的机位句是**整句替换**的 —— 所以"拉远"这件事它做得到,
     除非景别另有一层挡着。这一组就是那条护栏的回归测试 */
  const PULLED_BACK = 'Camera: wide shot, the whole room visible, the subject small'

  it('它写了一句"拉远",机位那句照旧被换掉,但 frame 那一层一个字没动', () => {
    const plan = planChatPhoto('my eyes, looking straight at you', true, ANCHOR, 'selfie', 'close')
    const after = applyDirector(plan, parseDirector(PULLED_BACK))
    const layer = (p: typeof plan, name: string) => p.layers.find(([slot]) => slot === name)?.[1]

    expect(layer(after, 'camera')).toContain('wide shot')
    expect(layer(after, 'frame')).toBe(layer(plan, 'frame'))
    expect(layer(after, 'frame')).toContain('tight close-up')
  })

  it('**验收线:摄影指导拉不回来的那一张,特写还在**', () => {
    /* 整串提示词里最后起作用的是 frame 那一层 ——
       它与机位那句挨着,而且排在机位之前(顺序就是权重) */
    const plan = planChatPhoto('my eyes', true, ANCHOR, 'selfie', 'close')
    const after = applyDirector(plan, parseDirector(PULLED_BACK))
    expect(after.frame).toBe('close')
    expect(after.prompt).toContain('a tight close-up')
    expect(after.prompt.indexOf('tight close-up')).toBeLessThan(after.prompt.indexOf('wide shot'))
  })

  it('景别不在它能补的四个位里 —— 它写一行 Shot:/Frame: 也进不来', () => {
    const plan = planChatPhoto('my eyes', true, ANCHOR, 'selfie', 'close')
    const after = applyDirector(plan, parseDirector('Shot: full figure\nFrame: wide\nCamera: held low'))
    expect(after.frame).toBe('close')
    expect(after.prompt).not.toContain('full figure')
  })
})

/* ===== 特写那一句"这一格属于这个人":与景别同一层级的护栏(2026-10-06) ====
 *  摄影指导写的就是 `Camera:` 那一行,而"这是谁的局部"不是它可以优化的工艺 ——
 *  它只看得到一句场景,看不到对话、也看不到那个角色是谁。
 *  (用户报的:"特写她的手,那只手却跟角色不符 —— 明明是女生,手很粗糙。") */
describe('applyDirector · "这一格属于这个人"它也改不了', () => {
  const REWRITE = 'Camera: low angle, weathered hands, rough knuckles'

  it('它写一句"粗糙的手",机位那是它的事,part 那一层一个字没动', () => {
    const plan = planChatPhoto(
      'my hands wrapped around the mug',
      true,
      ANCHOR,
      'selfie',
      'close',
      'female'
    )
    const after = applyDirector(plan, parseDirector(REWRITE))
    const layer = (p: typeof plan, name: string) => p.layers.find(([slot]) => slot === name)?.[1]

    expect(layer(after, 'camera')).toContain('weathered hands')
    expect(layer(after, 'part')).toBe(layer(plan, 'part'))
    expect(after.prompt).toContain('female')
  })
})

/* ===== 这一格落在身上时要告诉它的第二件事(2026-10-09)=================
 *  视角那两句话里的"臂展 / 对着镜子 / 脸和身体"都是给**拍脸**写的。
 *  拍脚时照着写,出来的就是"上身也在画面里、姿势很怪"那张图 ——
 *  而它写的 `Camera:` 是**整句替换**,所以事实这一层必须换掉。 */
describe('shotBrief / frameBrief · 这一格落在身上', () => {
  const FEET = 'my bare feet propped up on the desk'

  it('头也出画要说出来 —— 不说它就会按"拍脸"那一套写机位句', () => {
    const t = directorTask(planChatPhoto(FEET, true, ANCHOR, 'selfie', 'close'))
    expect(t).toContain('out of frame')
    expect(t).toContain('do not pull back to show their face')
    /* 举着手机拍自己的脚 —— 这两句照着写就是那个怪姿势 */
    expect(t).not.toContain('arm\u2019s length')
    expect(t).not.toContain('at arm\u2019s length or in a mirror')
    /* 而"相机在自己手上"这条事实照旧告诉它 */
    expect(t).toContain('own hand')
    expect(t).toContain('out over that one part')
  })

  it('**拍脸那一档一个字不变** —— 判据只在"特写 + 落在身上"那一格生效', () => {
    const t = directorTask(planChatPhoto('my eyes', true, ANCHOR, 'selfie', 'close'))
    expect(t).toContain('at arm\u2019s length or in a mirror')
    expect(t).not.toContain('out over that one part')
    expect(t).toContain('do not pull back to show their face, their body, or the room')
  })

  it('半身/全身那两档也不认(它们本来就不判"有没有脸")', () => {
    const t = directorTask(planChatPhoto(FEET, true, ANCHOR, 'selfie', 'medium'))
    expect(t).toContain('half-body')
    expect(t).not.toContain('out over that one part')
  })

  it('两个 brief 直接调用时的口径', () => {
    expect(shotBrief('selfie', true)).toContain('out over that one part')
    expect(shotBrief('selfie', true)).toContain('do not switch to a third-person view')
    /* 他拍与空镜不换 —— 别人的手机拍你的脚,天经地义 */
    expect(shotBrief('third', true)).toBe(shotBrief('third'))
    expect(shotBrief('scene', true)).toBe(shotBrief('scene'))

    expect(frameBrief('close', true, true)).toContain('head and the rest of the body are out of frame')
    expect(frameBrief('close', true)).toContain('cropped out')
    expect(frameBrief('medium', true, true)).toBe(frameBrief('medium', true))
    /* 空镜那一档与它无关 —— 画面里根本没有"身体"这回事 */
    expect(frameBrief('close', false, true)).toContain('nobody is in it')
  })
})
