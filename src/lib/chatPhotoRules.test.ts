import { describe, expect, it } from 'vitest'
import { photoRules } from '../../server/chatPhoto.js'

/* 发图协议这一段是从 CHAT_RULES 里拆出来的(见 server/chatPhoto.js 文件头)。
   拆的时候最容易被"顺手改顺眼"磨掉内容,所以这里把关键锚点钉住:
   - 三种标签前缀的说法都在(selfie:/third:,以及景别 close:/medium:/full:);
   - 那个原来写错的前缀 "self:" 必须**已经不出现**(改成了 selfie:)—— 它是本文件的唯一实质改动;
   - 收尾那句仍把 mood 排在 photo 之后("the mood tag goes after it"),
     因为调用点靠这条顺序把 CHAT_MOOD_RULE 接在这段后面。 */

describe('photoRules · 拆出来但没丢内容', () => {
  const out = photoRules()

  it('给出这一段一个可读的小标题', () => {
    expect(out.startsWith('Sending a picture:')).toBe(true)
  })

  it('把三条协议要点都带着(锚点逐个验)', () => {
    expect(out).toContain('[photo:a description of the scene')
    expect(out).toContain('"selfie:"')
    expect(out).toContain('"third:"')
    expect(out).toContain('close:')
    expect(out).toContain('full:')
    expect(out).toContain('medium:')
    // 谁拿相机 vs 离得多近,是两个独立的杆 —— 这句区分它们的说法要在
    expect(out).toContain('How close the picture is, is a separate thing')
    // 场景描述要喂足,因为画图的模型看不见这段对话
    expect(out).toContain('whoever draws it cannot see this conversation')
  })

  it('修掉了那个教错的前缀:全篇不再出现裸的 "self:"', () => {
    // 原来第 16 条例子写成 "self:me leaning…",而教的只有 selfie:/third:。
    // 用词边界精确抓 "self:"(不带 i 结尾的那个),确保它真的没了
    expect(/(?<![A-Za-z])self:/.test(out)).toBe(false)
    // 而正确的自拍例子还在
    expect(out).toContain('[photo:selfie:me leaning on the balcony rail at dusk, hair down]')
  })

  it('保留了"mood 排在 photo 之后"的顺序承诺(调用点据此接 CHAT_MOOD_RULE)', () => {
    expect(out).toContain('the mood tag goes after it')
  })
})
