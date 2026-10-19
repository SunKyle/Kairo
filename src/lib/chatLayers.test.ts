import { describe, expect, it } from 'vitest'
import { layerRules } from '../../server/chatLayers.js'

/* 这一层只管两件事:think 的**稀缺邀请**在不在、act 的**场景闸**开不开。
   它决定了 system 里那一段的形状 —— 而"每轮都有内心"或"日常里满屏旁白"
   这两件事,恰是设计 §7 点名的命门,靠"聊两句看看"验不出稀缺,只能断言措辞。 */

describe('layerRules · 两种模式都带着的那几条', () => {
  it('始终邀请 think,但把它写成"只在确实憋着话时才有"的稀缺件', () => {
    const out = layerRules(false)
    expect(out).toContain('[think]')
    expect(out).toContain('[/think]')
    // 稀缺与触发条件:不是每条都写内心
    expect(out).toContain('only when there is something real being kept back')
    expect(out).toContain('noise, not intimacy')
  })

  it('明说这是"no narration"的一个受控例外,且是除 photo/mood 外唯一允许的方括号', () => {
    const out = layerRules(true)
    expect(out).toContain('no narration')
    expect(out).toContain('only brackets allowed besides the [photo:...] and [mood:...]')
  })

  it('把 mood / photo 的位置钉死在所有区域标记闭合之后', () => {
    const out = layerRules(true)
    expect(out).toContain('[mood:...]')
    expect(out).toContain('after every region marker is closed')
  })

  it('普通话保持裸写,不被包进任何标记', () => {
    const out = layerRules(false)
    expect(out).toContain('Leave speech bare')
  })
})

describe('layerRules · act 受场景闸', () => {
  it('sceneMode=true 才放行 [act],并规定第三人称、一条、无星号、无台词', () => {
    const out = layerRules(true)
    expect(out).toContain('[act]')
    expect(out).toContain('[/act]')
    expect(out).toContain('inside a scene')
    expect(out).toContain('Third person')
    expect(out).toContain('no asterisks')
  })

  it('sceneMode=false 明确禁止 [act],只留 think', () => {
    const out = layerRules(false)
    expect(out).toContain('NOT in a scene')
    expect(out).toContain('Do not use [act] at all')
    // 关闭态里不能反过来出现"可以打 act"的邀请
    expect(out).not.toContain('you may also show one brief thing')
  })

  it('不传参按关闭态处理(缺省保守:宁可不产出旁白)', () => {
    expect(layerRules()).toBe(layerRules(false))
  })
})
