import { describe, expect, it } from 'vitest'
import { priorityRules } from '../../server/chatPriority.js'

/* 这段是"读法"层的定稿文本 —— 没有分支、没有入参,能断言的就只有**四条层级在不在、
   措辞点不点得破**。而它真正要防的是两件事:①某一层的 tie-break 说法被改没了,
   模型就退化成"只按拼的顺序读";②它把别处已 owns 的微规则(inferred、摘要失真的展开)
   又抄一遍 —— 那正是这次重构一路在消解的重复。所以两条反断言和正向断言一样重要。 */

describe('priorityRules · 四层权威关系', () => {
  const out = priorityRules()

  it('第 1 层:规则是地板,谁都盖不掉', () => {
    expect(out).toContain('How to weigh it')
    expect(out).toContain('The rules set the floor')
  })

  it('第 2 层:本轮事实 > 记得的过去,打架时听当下的', () => {
    expect(out).toContain('Live input beats memory')
    expect(out).toContain('follow the live side')
  })

  it('第 3 层:记忆/摘要/关系 = 过去与趋势,不是当下事实', () => {
    expect(out).toContain('past and trend, not present fact')
  })

  it('第 4 层:人格/口吻/偏好只改说法与相处,不改人格内核', () => {
    expect(out).toContain('shape the voice')
    expect(out).toContain('never your core')
    expect(out).toContain('does not make you a different person')
  })
})

describe('priorityRules · 不越界复读别处的微规则', () => {
  const out = priorityRules()

  /* "(inferred) 不等于用户说过"归 memorySection 的开场白,这里只把记忆条目排进层级、
     绝不把那句解释再抄一遍 */
  it('不复述 (inferred) 那条边界', () => {
    expect(out).not.toContain('inferred')
  })

  /* 这段排在 CHAT_OPENING 之后、摘要段之前;而 probe-chat-photo.mjs 拿大小写敏感的
     "What you remember" 当定位锚。这里一旦原样出现这七个词,锚就会错指到优先级块上,
     把"时间/心情排在记忆之前"那两条断言悄悄判坏 —— 所以按层指代时避开这个专名 */
  it('不含 "What you remember" 这个摘要段专名(免抢 probe 的定位锚)', () => {
    expect(out).not.toContain('What you remember')
  })
})
