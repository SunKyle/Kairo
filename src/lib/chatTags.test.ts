import { describe, expect, it } from 'vitest'
import {
  PHOTO_SCENE_CHARS,
  cleanScene,
  splitTags,
  stripStandaloneTags,
  tailHold
} from '../../server/chatTags.js'

/* 这些用例都是"会漏给用户看"的那几类:
   标签没剪干净、半截标签闪出来、自由文本没收敛。 */

describe('splitTags 的剪取', () => {
  it('情绪那枚照旧', () => {
    expect(splitTags('Fine. [mood:warm]')).toEqual({
      text: 'Fine.',
      mood: 'warm',
      photo: '',
      photoSelf: false,
      photoShot: '',
      photoFrame: ''
    })
  })

  it('发图那枚照旧', () => {
    expect(splitTags('Look at this.\n[photo:standing in the rain]')).toEqual({
      text: 'Look at this.',
      mood: '',
      photo: 'standing in the rain',
      photoSelf: false,
      photoShot: '',
      photoFrame: ''
    })
  })

  /* 提示词让模型把两枚各写一行,而模型经常写成一前一后 ——
     只认末尾那一枚的实现会漏掉另一枚,那枚就会**原样漏给用户看** */
  it('两枚同时出现:mood 在前', () => {
    expect(splitTags('Here.\n[mood:amused]\n[photo:a rooftop at dusk]')).toEqual({
      text: 'Here.',
      mood: 'amused',
      photo: 'a rooftop at dusk',
      photoSelf: false,
      photoShot: '',
      photoFrame: ''
    })
  })

  it('两枚同时出现:photo 在前', () => {
    expect(splitTags('Here.\n[photo:a rooftop at dusk]\n[mood:amused]')).toEqual({
      text: 'Here.',
      mood: 'amused',
      photo: 'a rooftop at dusk',
      photoSelf: false,
      photoShot: '',
      photoFrame: ''
    })
  })

  it('正文中间出现方括号不该被吃', () => {
    const r = splitTags('I kept the [draft] you sent. [mood:tired]')
    expect(r.text).toBe('I kept the [draft] you sent.')
    expect(r.mood).toBe('tired')
  })
})

describe('splitTags 的半截标签', () => {
  /* 流式中途用户按了停止 —— 这时尾巴上很可能就是半枚标签 */
  it('只擦不取', () => {
    expect(splitTags('Wait, I was going to say [pho')).toEqual({
      text: 'Wait, I was going to say',
      mood: '',
      photo: '',
      photoSelf: false,
      photoShot: '',
      photoFrame: ''
    })
    expect(splitTags('Hmm [moo')).toEqual({
      text: 'Hmm',
      mood: '',
      photo: '',
      photoSelf: false,
      photoShot: '',
      photoFrame: ''
    })
  })

  /* 但也不能太贪:`[p]` / `[m]` 这种在正经文字里会出现,不该被吃掉 */
  it('太短的前缀不吃(那是人话)', () => {
    expect(splitTags('See item [p] here').text).toBe('See item [p] here')
    expect(splitTags('See item [m] here').text).toBe('See item [m] here')
  })

  it('括号还没闭上、但内容已经写了', () => {
    expect(splitTags('[photo:a quiet street').photo).toBe('')
    expect(splitTags('[photo:a quiet street').text).toBe('')
  })
})

describe('这一张里有没有它本人', () => {
  /* 判据决定出图带不带角色的设定图:风景照带上会被带跑,自拍不带会画成陌生人 */

  it('没写前缀 = 场景照(它看到的东西),不带设定', () => {
    const r = splitTags('Look.\n[photo:rain on the window]')
    expect(r.photo).toBe('rain on the window')
    expect(r.photoSelf).toBe(false)
  })

  it('self: 前缀 = 它在画面里,前缀本身不进场景描述', () => {
    const r = splitTags('Look.\n[photo:self:me on the balcony, hair down]')
    expect(r.photo).toBe('me on the balcony, hair down')
    expect(r.photoSelf).toBe(true)
  })

  /* —— 谁拿的相机(2026-10-05 新增) ——
     `self:` 只说"它在画面里",相机那一项它没说;`selfie:` / `third:` 才回答。
     这一位是用户报的那个毛病的解药:"老是会生成他拍视角的图片" ——
     因为在此之前,视角交给一个只看得到一句场景的模型去猜。 */
  it('selfie: 前缀 = 相机在它自己手上', () => {
    const r = splitTags('Here.\n[photo:selfie:me leaning on the balcony rail, hair down]')
    expect(r.photo).toBe('me leaning on the balcony rail, hair down')
    expect(r.photoSelf).toBe(true)
    expect(r.photoShot).toBe('selfie')
  })

  it('third: 前缀 = 相机在别人手上', () => {
    const r = splitTags('Here.\n[photo:third:me on stage, taken from the crowd]')
    expect(r.photo).toBe('me on stage, taken from the crowd')
    expect(r.photoSelf).toBe(true)
    expect(r.photoShot).toBe('third')
  })

  it('third 那几种写法都认(大小写、连字符、person)', () => {
    for (const raw of ['THIRD: me at the desk', 'third-person:me at the desk', 'Third person - me at the desk']) {
      const r = splitTags(`x\n[photo:${raw}]`)
      expect(r.photoShot, raw).toBe('third')
      expect(r.photoSelf, raw).toBe(true)
    }
  })

  it('selfie 那几种写法都认,self-portrait 不会被 self 那条吃掉一半', () => {
    for (const raw of ['SELFIE: me in the mirror', 'self-portrait:me by the window']) {
      const r = splitTags(`x\n[photo:${raw}]`)
      expect(r.photoShot, raw).toBe('selfie')
      expect(r.photoSelf, raw).toBe(true)
    }
    /* `self` 那条若先匹配,`self-portrait:me by the window` 会被剪成
       "portrait:me by the window" —— 剪错了前缀还留在场景里 */
    expect(splitTags('x\n[photo:self-portrait:me by the window]').photo).toBe('me by the window')
  })

  it('self: 与代词那几种 = 在画面里,但**没说**谁拿的相机', () => {
    for (const raw of ['self: me at the desk', 'me: at the desk', 'me at the desk', "I'm on the balcony"]) {
      expect(splitTags(`x\n[photo:${raw}]`).photoShot, raw).toBe('')
    }
  })

  it('没写前缀 = 画面里没有人,更谈不上相机', () => {
    expect(splitTags('x\n[photo:rain on the window]').photoShot).toBe('')
  })

  it('点了自己的名字(兜底)也不算说了相机', () => {
    const r = splitTags('x\n[photo:Alice leaning on the railing]', 'Alice')
    expect(r.photoSelf).toBe(true)
    expect(r.photoShot).toBe('')
  })

  it('前缀写得随意也认:大小写、空格、逗号、破折号', () => {
    for (const raw of [
      'SELF: me at the desk',
      'Self - me at the desk',
      'self,me at the desk',
      'myself:me at the desk',
      'me: at the desk',
      'me at the desk',
      "I'm on the balcony",
      'I am on the balcony'
    ]) {
      expect(splitTags(`x\n[photo:${raw}]`).photoSelf, raw).toBe(true)
    }
  })

  /* 代词有两副面孔:`self:` 是纯标记(剪掉),而 "me at my desk" 里的 me
     是描述的主语 —— 剪掉就只剩 "at my desk",画面里少了那个人 */
  it('纯标记剪掉,代词留着', () => {
    expect(splitTags('x\n[photo:self:on the balcony]').photo).toBe('on the balcony')
    expect(splitTags('x\n[photo:me: at the desk]').photo).toBe('at the desk')
    expect(splitTags('x\n[photo:me at the desk]').photo).toBe('me at the desk')
    expect(splitTags("x\n[photo:I'm on the balcony]").photo).toBe("I'm on the balcony")
  })

  /* \b 那一刀:这两个词以 me/self 开头,但不是那个意思 */
  it('不误判:meeting / selfish 这类词不算', () => {
    expect(splitTags('x\n[photo:meeting at dawn]').photoSelf).toBe(false)
    expect(splitTags('x\n[photo:selfish grin on a rooftop]').photoSelf).toBe(false)
    expect(splitTags('x\n[photo:Imposing cliffs at dawn]').photoSelf).toBe(false)
  })

  it('模型多写一个 scene: / view: 不算内容,抹掉', () => {
    const r = splitTags('x\n[photo:scene:an empty harbour]')
    expect(r.photo).toBe('an empty harbour')
    expect(r.photoSelf).toBe(false)
  })

  /* 没写前缀、但描述里点了自己的名字 —— 那种回复显然是在说自己。
     名字由服务端传进来(它手上有角色卡) */
  it('描述里点了自己的名字 = 它在画面里(兜底)', () => {
    const r = splitTags('x\n[photo:Alice leaning on the railing]', 'Alice')
    expect(r.photoSelf).toBe(true)
    // 名字不在描述里就还是场景照
    expect(splitTags('x\n[photo:an empty railing]', 'Alice').photoSelf).toBe(false)
    // 没传名字时这条兜底不生效
    expect(splitTags('x\n[photo:Alice leaning on the railing]').photoSelf).toBe(false)
  })

  it('两枚标签同时出现时同样认前缀', () => {
    const r = splitTags('Here.\n[mood:warm]\n[photo:self:a rooftop at dusk]')
    expect(r).toEqual({
      text: 'Here.',
      mood: 'warm',
      photo: 'a rooftop at dusk',
      photoSelf: true,
      photoShot: '',
      photoFrame: ''
    })
  })
})

/* ===== 这一张离得多近(2026-10-06 新增) ==============================
 *  景别与视角同源:都是"用户要什么",都由聊天模型在标签里说 ——
 *  它没说时客户端按场景文本判(见 lib/chatPhoto 的 frameFromScene)。
 *
 *  加它的直接原因是用户那句话:"让角色拍特写图,总是变成自拍"。 */

describe('景别前缀', () => {
  it('写在"谁拿的相机"之后,两类都不进场景描述', () => {
    const r = splitTags('x\n[photo:selfie:close:my eyes, looking straight at you]')
    expect(r.photo).toBe('my eyes, looking straight at you')
    expect(r.photoSelf).toBe(true)
    expect(r.photoShot).toBe('selfie')
    expect(r.photoFrame).toBe('close')
  })

  it('他拍 + 全身', () => {
    const r = splitTags('x\n[photo:third:full:me on the pier, the harbour behind me]')
    expect(r.photo).toBe('me on the pier, the harbour behind me')
    expect(r.photoShot).toBe('third')
    expect(r.photoFrame).toBe('full')
  })

  /* **这一条最要紧**:镜头对着一个东西、人不在画面里 —— 也正是
     "拍个特写给我看"最常见的那个形状。它没有相机前缀,但景别照旧成立 */
  it('空镜也能有景别 —— 画面里没有人不等于没有景别', () => {
    const r = splitTags('x\n[photo:close:rain running down the window pane]')
    expect(r.photo).toBe('rain running down the window pane')
    expect(r.photoSelf).toBe(false)
    expect(r.photoShot).toBe('')
    expect(r.photoFrame).toBe('close')
  })

  it('两类前缀顺序不挑 —— 模型写反了也认', () => {
    const r = splitTags('x\n[photo:close:selfie:my eyes]')
    expect(r.photo).toBe('my eyes')
    expect(r.photoShot).toBe('selfie')
    expect(r.photoFrame).toBe('close')
  })

  it('那几种写法都认(大小写、连字符、shot/length)', () => {
    for (const raw of ['CLOSE: my eyes', 'close-up:my eyes', 'macro: my eyes', 'detail:my eyes']) {
      expect(splitTags(`x\n[photo:${raw}]`).photoFrame, raw).toBe('close')
    }
    for (const raw of ['full: me on the pier', 'full-length:me in the mirror', 'full-body: me', 'wide shot: the harbour']) {
      expect(splitTags(`x\n[photo:${raw}]`).photoFrame, raw).toBe('full')
    }
    for (const raw of ['medium: me at the desk', 'half-body:me at the desk']) {
      expect(splitTags(`x\n[photo:${raw}]`).photoFrame, raw).toBe('medium')
    }
  })

  /* **必须要求一个分隔符**:close / medium / full 本身就是常用词。
     不要求的话 "[photo:close to the window, the rain]" 会被剪成
     "to the window, the rain" —— 场景从"离窗很近"变成"窗" */
  it('"close to the window" 里的 close 不是景别', () => {
    const r = splitTags('x\n[photo:close to the window, the rain]')
    expect(r.photo).toBe('close to the window, the rain')
    expect(r.photoFrame).toBe('')
  })

  it('长写法不被短写法咬掉一半', () => {
    /* `full` 若先匹配，剩下的 "-length:" 会顶在场景最前面 */
    expect(splitTags('x\n[photo:full-length:me in the mirror]').photo).toBe('me in the mirror')
    expect(splitTags('x\n[photo:wide shot:the empty harbour]').photo).toBe('the empty harbour')
  })

  it('没说就是空串 —— 由客户端按场景文本判、再不行落回缺省', () => {
    expect(splitTags('x\n[photo:selfie:me on the balcony]').photoFrame).toBe('')
    expect(splitTags('x\n[photo:rain on the window]').photoFrame).toBe('')
  })

  it('认不出的词不是景别,而且留在场景里(它是内容)', () => {
    const r = splitTags('x\n[photo:selfie:extreme zoom on my eyes]')
    expect(r.photoFrame).toBe('')
    expect(r.photo).toBe('extreme zoom on my eyes')
  })

  it('两条路都要带上它 —— 独占一行的中段标签一样算', () => {
    const r = stripStandaloneTags('a\n[photo:selfie:close:my eyes]\nb')
    expect(r.photoFrame).toBe('close')
    expect(r.photoShot).toBe('selfie')
    expect(r.text).toBe('a\nb')
  })
})

/* ===== 没有前缀、但场景里点了身体的某个部位(2026-10-06) ==============
 *  第一条就是用户报的那句**原话**:模型既没写相机前缀、也没写代词,而中文那句
 *  "手压在笔记上"里连"我的手"三个字都没有 —— 只看前缀与代词,它就是"画面里
 *  没有人"。而"没有人"的后果不只是视角被定成空镜:**参考图一张都不发**
 *  (见 lib/chatPhoto 的 useRefs = self),画出来自然不是这个人的手。 */
describe('身体部位的兜底', () => {
  it('用户报的那句原话 —— 中文、没前缀、没代词,也认得出它在画面里', () => {
    const r = splitTags('x\n[photo:close:手压在笔记上，指甲还留着点上次涂的颜色，快掉光了]')
    expect(r.photoSelf).toBe(true)
    expect(r.photoFrame).toBe('close')
  })

  it('英文同理 —— "hands wrapped around the mug" 这类不带 my 的说法', () => {
    const r = splitTags('x\n[photo:close:hands wrapped around the mug, steam rising]')
    expect(r.photoSelf).toBe(true)
  })

  it('**"手机"不能撞成"手"** —— 词表只收没有别的意思的部位词', () => {
    expect(splitTags('x\n[photo:close:手机放在桌上，屏幕还亮着]').photoSelf).toBe(false)
  })

  it('英文那一侧同理 —— "hand-held" 说的是那台相机,不是手', () => {
    expect(splitTags('x\n[photo:close:a hand-held lamp lighting the corner]').photoSelf).toBe(false)
  })

  it('"the neck of the guitar" 不是脖子 —— neck 那道护栏', () => {
    expect(splitTags('x\n[photo:close:the neck of the guitar in the foreground]').photoSelf).toBe(false)
    /* 真说脖子的时候照认(这一句里**只有** neck 一个部位词,别让别的词把这条测空) */
    expect(splitTags('x\n[photo:close:her neck, hair pushed aside]').photoSelf).toBe(true)
  })

  it('普通静物仍然判成"没有人" —— 这条兜底不该把一扇窗当成一个人', () => {
    expect(splitTags('x\n[photo:close:rain running down the window pane]').photoSelf).toBe(false)
    expect(splitTags('x\n[photo:a mug on the desk, steam rising]').photoSelf).toBe(false)
  })

  it('`no-self:` 是明说"没有人",这条兜底不能越过它', () => {
    const r = splitTags('x\n[photo:close:no-self:指甲上的旧漆快掉光了]')
    expect(r.photoSelf).toBe(false)
    /* 壳抹掉,内容留着 —— 与 scene: / view: 同一处理 */
    expect(r.photo).toBe('指甲上的旧漆快掉光了')
  })

  it('身体部位是内容,不是前缀 —— 它不能被剪掉', () => {
    const r = splitTags('x\n[photo:close:手压在笔记上，指甲还留着点上次涂的颜色]')
    expect(r.photo).toContain('指甲')
    expect(r.photo).toContain('手压在笔记上')
  })
})

describe('场景描述的收敛', () => {
  it('换行与连续空白压成一个空格', () => {
    expect(cleanScene('  a   rooftop\nat  dusk ')).toBe('a rooftop at dusk')
  })

  it('按上限截断', () => {
    expect(cleanScene('x'.repeat(PHOTO_SCENE_CHARS + 200)).length).toBe(PHOTO_SCENE_CHARS)
  })

  /* 方括号会把下一枚标签一起吞进来 —— 形状上直接不许有 */
  it('带方括号的内容剪不出来', () => {
    expect(splitTags('Hi [photo:evil] [injected]').photo).toBe('')
  })

  it('400 字的场景也剪得出来 —— 上限放宽后必须仍然认得出末尾那枚标签', () => {
    const long = 'a'.repeat(PHOTO_SCENE_CHARS)
    expect(splitTags(`Look.\n[photo:${long}]`).photo.length).toBe(PHOTO_SCENE_CHARS)
  })
})

/* ===== 扣尾 ==========================================================
 *  这一组钉的是"放开标签上限之后,正文还能不能流式"。
 *  `tailHold` 返回的是**可以放出去的长度**(不是"要扣住多少")——
 *  扣多少这个量在标签开合之间不连续,而"放到哪"是连续的:它就是标签的起点。
 *
 *  下面几条里,有两条是**端到端探针抓出来的真 bug**,单测当时全绿:
 *  1. 两枚标签相邻时,上一枚完整标签被当成正文放了出去;
 *  2. 超长场景里"第一个换行之前那一段"被当成了标签内容。
 *  两者都只在**增量边界**上显形,所以这里的用例都按"分块喂"来写。 */

describe('tailHold · 放到哪才不漏半截标签', () => {
  /** 按固定长度切块喂进去,复刻服务端流式那一步的累积过程 */
  function stream(reply: string, size = 3) {
    let tail = ''
    const released: string[] = []
    for (let i = 0; i < reply.length; i += size) {
      tail += reply.slice(i, i + size)
      const rel = tailHold(tail)
      if (rel > 0) {
        released.push(tail.slice(0, rel))
        tail = tail.slice(rel)
      }
    }
    return { released: released.join(''), held: tail }
  }

  it('没有标签的正文整段放出去(照常流式)', () => {
    const s = 'leaning on the balcony at dusk'
    expect(tailHold(s)).toBe(s.length)
    expect(tailHold('')).toBe(0)
    expect(tailHold(undefined)).toBe(0)
  })

  it('末尾是完整标签时,边界停在标签起点', () => {
    const prose = 'Rain again. I am so tired of it. '
    const s = prose + '[photo:me on the balcony]'
    /* **连正文与标签之间那个空白一起扣住** —— 它是"标签前面那一截",
       收尾时会被 splitTags 的 trimEnd 收掉;提前放出去就成了气泡底下的空行
       (2026-10-05 修的那条,见下面那条用例) */
    expect(tailHold(s)).toBe('Rain again. I am so tired of it.'.length)
  })

  it('标签还没闭合时,边界停在那个 `[` 上', () => {
    const prose = 'It is coming down hard. '
    const s = prose + '[photo:rain on the window'
    expect(tailHold(s)).toBe('It is coming down hard.'.length)
    /* 只打出一个 `[` 也一样 —— 那是下一块增量还没到(它前面那个空格同样扣住) */
    expect(tailHold('some words [')).toBe('some words'.length)
  })

  it('末尾那段空白一律扣住 —— 它是"标签前面那个换行",不是正文', () => {
    /* 这条修的是用户报的"短回复底下多一行空行"。
       模型把标签写在单独一行,而那个 `\n` **总是比标签先到** ——
       按"标签起点"算出来的边界正好落在它后面,于是它被当成正文发了出去,
       收尾的 trimEnd 追不回来(字早发出去了);pre-wrap 会把结尾的 `\n`
       如实渲染成一行空行。
       扣住它没有代价:后面一来非空白字符,它就跟着放出去 */
    expect(tailHold('嗯。\n')).toBe(2)
    expect(tailHold('嗯。\n\n')).toBe(2)
    expect(tailHold('嗯。\n[mo')).toBe(2)
    expect(tailHold('嗯。\n[mood:x]')).toBe(2)
    // 空白后面只要来了正文,它就不再是"末尾",照常放出去
    expect(tailHold('嗯。\nNext')).toBe('嗯。\nNext'.length)
    // 整截都是空白:一个字符都不放(那本来也没有正文)
    expect(tailHold('   \n\n')).toBe(0)
  })

  it('**两枚标签相邻时,上一枚完整标签也不许放出去**', () => {
    /* 探针抓到的第一类 bug:剥第二枚时把上一枚的 `]` 当成了"末尾标点",
       边界跳过第二枚的 `[` 落到它上面,于是整枚 photo 标签被放了出去。
       触发条件是"两枚标签相邻",也就是**每一轮正常的回复**都会遇到。 */
    const s = '[photo:self:me on the balcony]\n[m'
    expect(tailHold(s)).toBe(0)
    expect(tailHold('[photo:self:me on the balcony]')).toBe(0)
    expect(tailHold('[photo:self:me on the balcony]\n')).toBe(0)
    expect(tailHold('[photo:self:me on the balcony]\n[mood:ti')).toBe(0)
  })

  it('正文 + 两枚标签:只放正文,两枚都留住', () => {
    const prose = 'Rain again. I am tired.\n'
    const s = prose + '[photo:me on the balcony]\n[mood:tired]'
    expect(tailHold(s)).toBe('Rain again. I am tired.'.length)
  })

  it('正文里长得像标签的方括号不算标签 —— 数字与汉字都排除了', () => {
    expect(tailHold('notes [1] and [2] here')).toBe('notes [1] and [2] here'.length)
    expect(tailHold('他说的[注]在这里')).toBe('他说的[注]在这里'.length)
    /* `[photo]` 没有分隔符,splitTags 也不认它 —— 同样当正文 */
    expect(tailHold('see [photo] above')).toBe('see [photo] above'.length)
  })

  it('**超长场景里第一个换行之前的那一段,不许被当成标签内容**', () => {
    /* 探针抓到的第二类 bug:`[^\]]*` 跨过了换行,把"第一个换行之前"
       也算进标签,于是它右边判成"没有正文",边界一路跑到前一枚标签前面。
       这里用一个带换行的超长场景复现。 */
    const scene = 'me leaning on the rail at dusk, the rain just stopped,\n' + 'x'.repeat(300)
    const s = `Look at this.\n[photo:${scene}]\n[`
    expect(tailHold(s)).toBe('Look at this.'.length)
  })

  it('分块喂完整一轮:放出去的只有正文,两枚标签一个字符都没漏', () => {
    const reply = 'Rain again. I am so tired of it.\n[photo:self:me on the balcony]\n[mood:tired]'
    const { released, held } = stream(reply)
    /* 放出去的正文**末尾不带那个换行**(它归标签那一截),所以界面上
       不会多出一行空行 */
    expect(released).toBe('Rain again. I am so tired of it.')
    expect(held).toBe('\n[photo:self:me on the balcony]\n[mood:tired]')
  })

  it('分块喂长场景:正文先流出去,标签留在手里', () => {
    const scene = 'me leaning on the balcony rail at dusk, the rain just stopped, ' + 'y'.repeat(300)
    const reply = `Look at this.\n[photo:${scene}]\n[mood:warm]`
    const { released, held } = stream(reply, 7)
    /* 正文完整放出去,而且**不是等到流末才放** —— 这是这一整套改动的目的 */
    expect(released).toBe('Look at this.')
    expect(held).toContain('[photo:')
    /* 放出去的那一段里绝不能带半个标签 */
    expect(released).not.toContain('[ph')
  })

  it('流水里任何一帧都不含"可能长成标签的前缀"', () => {
    const reply = 'Sure.\n[photo:self:me on the balcony]\n[mood:warm]'
    let tail = ''
    const frames: string[] = []
    for (let i = 0; i < reply.length; i += 2) {
      tail += reply.slice(i, i + 2)
      const rel = tailHold(tail)
      if (rel > 0) {
        frames.push(tail.slice(0, rel))
        tail = tail.slice(rel)
      }
    }
    for (const f of frames) expect(f).not.toMatch(/\[(p|ph|pho|m|mo|moo)/)
  })
})

/* 中段那枚标签:模型先说一句、再决定给你看张图、然后又补一句收尾的话 ——
   于是 `[photo:…]` 落在正文中间,而 splitTags 只认末尾(那是为了不误吃
   正文里的方括号)。用户看到的就是聊天框里明晃晃一行 `[photo:self:…]`。 */
describe('stripStandaloneTags · 摘掉"独占一行的"标签(不限于末尾)', () => {
  it('正文中间那枚被摘掉,意图照样取出来', () => {
    const r = stripStandaloneTags(
      '等下等下,我这个状态你也想看呀?\n\n[photo:self:me in the car, tired but grinning]\n\n怎么样,值不值得你等这么久诶?',
      'Tian'
    )
    expect(r.text).toBe('等下等下,我这个状态你也想看呀?\n\n怎么样,值不值得你等这么久诶?')
    expect(r.photo).toBe('me in the car, tired but grinning')
    expect(r.photoSelf).toBe(true)
  })

  it('连着两枚也认(photo + mood)', () => {
    const r = stripStandaloneTags('先说一句。\n[photo:rain on the window]\n[mood:tired]\n再说一句。')
    expect(r.text).toBe('先说一句。\n再说一句。')
    expect(r.photo).toBe('rain on the window')
    expect(r.photoSelf).toBe(false)
    expect(r.mood).toBe('tired')
  })

  it('同一类出现两次时取第一枚 —— 它就是这一轮想说的事', () => {
    const r = stripStandaloneTags('[photo:first scene]\n中间\n[photo:second scene]')
    expect(r.photo).toBe('first scene')
  })

  it('**夹在句子里的方括号一律不碰** —— 那是正文', () => {
    for (const t of [
      '我说[photo:x]这个词,你别多想。',
      '他说的[注]在这里。',
      'notes [1] and [2] here'
    ]) {
      expect(stripStandaloneTags(t).text).toBe(t)
    }
  })

  it('半截标签不动(它这一块还没写完,由流式那一层扣着)', () => {
    const t = '先说一句。\n[photo:tired'
    expect(stripStandaloneTags(t).text).toBe(t)
  })

  it('摘掉之后剩下的空行收一收,但不碰没有标签的正文', () => {
    expect(stripStandaloneTags('一段。\n\n[photo:x]\n\n另一段。').text).toBe('一段。\n\n另一段。')
    const plain = '一段。\n\n\n\n另一段。'
    expect(stripStandaloneTags(plain).text).toBe(plain)
  })

  it('标签后面只跟标点也认(模型偶尔写得随意)', () => {
    const r = stripStandaloneTags('你好。\n[photo:me on the balcony].\n再见。')
    expect(r.text).toBe('你好。\n再见。')
    expect(r.photo).toBe('me on the balcony')
  })
})
