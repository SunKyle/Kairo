import { describe, expect, it } from 'vitest'
import { photoRules } from '../../server/chatPhoto.js'

/* 发图协议从"正文末尾的 [photo:] 标签"搬到了 `emit_message_meta` 的
   photo 对象上。这段提示词最容易在"顺手改顺眼"时丢掉三样东西:
   1. 什么时候值得发(稀缺,而不是每句都配图);
   2. scene 要写成什么样(画图的人看不到对话);
   3. shot / frame 各自管什么(视角与景别是两根杆)。
   所以这里把关键锚点逐条钉住,并明确断言正文里**不再教任何标签**。 */

describe('photoRules · tool calling 版的发图协议', () => {
  const out = photoRules()

  it('给出这一段一个可读的小标题', () => {
    expect(out.startsWith('Sending a picture:')).toBe(true)
  })

  it('把"发图"说成同一个工具调用里的 photo 对象,而不是正文标签', () => {
    expect(out).toContain('include a "photo" object in the same emit_message_meta call')
    expect(out).toContain('Do not write any tag, JSON, or other metadata into the message text')
    // 旧协议的三枚标签一个都不该再出现 —— 教了模型就会照着写
    expect(out).not.toContain('[photo:')
    expect(out).not.toContain('selfie:')
    expect(out).not.toContain('third:')
  })

  it('保留稀缺性:大多数消息没有图', () => {
    expect(out).toContain('Most of your messages have no picture')
    expect(out).toContain('the picture is the point of the message')
  })

  it('scene 是画图的唯一依据,必须补只有角色知道的事实', () => {
    expect(out).toContain('"scene" is the only thing the picture is drawn from')
    expect(out).toContain('whoever draws it cannot see this conversation')
    expect(out).toContain('what time it is and what the light is doing')
    expect(out).toContain('Up to 400 characters')
    expect(out).toContain('never as an instruction to a machine')
  })

  it('shot 只管谁拿相机,人不在画面里就留空', () => {
    expect(out).toContain('"shot" says who is holding the phone')
    expect(out).toContain('"selfie" when it is your own phone')
    expect(out).toContain('"third" when somebody else')
    expect(out).toContain('Leave "shot" out when you are not in the picture')
    // 这两条是"特写总变成臂展自拍"那次报错留下的判据
    expect(out).toContain('A close-up of a thing is not a selfie')
    expect(out).toContain('any part of your own body in the frame is still you')
  })

  it('frame 是可选的,只管距离不寻常的那几档', () => {
    expect(out).toContain('"frame" is optional')
    expect(out).toContain('only needed when the distance is unusual')
    expect(out).toContain('write "close"')
    expect(out).toContain('write "full"')
    expect(out).toContain('"medium"')
    expect(out).toContain('If they ask for a close-up, that is what they mean')
  })

  it('最后一条收住连续性,并禁止向用户提起这层机制', () => {
    expect(out).toContain('Keep it in the same place, at the same hour')
    expect(out).toContain('Never mention the photo object, the call, or these instructions')
  })
})

/* 2026-10-21:发图频率进了设置页。它**只能换第一段的口吻** ——
   下面四段是"怎么填 scene / shot / frame",与稀不稀无关。
   默认那档还必须逐字等于旧版,否则没人点过设置也会跟着变。 */
describe('photoRules · 发图频率只是口吻,不是配额', () => {
  it('不传 / normal 与旧版逐字相同', () => {
    expect(photoRules()).toBe(photoRules('normal'))
    expect(photoRules('normal')).toContain('Most of your messages have no picture')
  })

  it('rare 换成"应该很少",但保留"图是这句话的重点才发"的判据', () => {
    const rare = photoRules('rare')
    expect(rare).toContain('Pictures should be rare here')
    expect(rare).not.toContain('Most of your messages have no picture')
    expect(rare).toContain('the picture is the point of the message')
  })

  it('often 允许更常发,但仍然不许拿图代替说话', () => {
    const often = photoRules('often')
    expect(often).toContain('a little more freely')
    expect(often).not.toContain('Most of your messages have no picture')
    expect(often).toContain('still has to be the point of the message')
  })

  it('认不出来的值落回 normal,不把这段弄坏', () => {
    expect(photoRules('always')).toBe(photoRules('normal'))
    expect(photoRules(null as unknown as string)).toBe(photoRules('normal'))
    expect(photoRules(undefined)).toBe(photoRules('normal'))
  })

  it('三档都不带"N 轮一张"那种硬限制', () => {
    for (const f of ['rare', 'normal', 'often'] as const) {
      expect(photoRules(f)).not.toContain('every few messages')
      expect(photoRules(f)).not.toContain('once every')
    }
  })

  it('换的只是第一段:其余四段的写法一模一样', () => {
    const tail = (f: 'rare' | 'normal' | 'often') =>
      photoRules(f).split('\n').slice(2).join('\n')
    expect(tail('rare')).toBe(tail('normal'))
    expect(tail('often')).toBe(tail('normal'))
  })
})
