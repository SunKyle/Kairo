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

  it('明说这是"no narration"的受控例外,且 [think]/[act] 是末尾标签之外唯一允许的方括号', () => {
    const out = layerRules(true)
    expect(out).toContain('no narration')
    expect(out).toContain('the only brackets you may use')
    /* 不再逐字点 [photo:] / [mood:] 的名:canDraw 为假时发图那段根本不注入,
       这里提一个没教过的标签只会误导 —— 改成泛指"上面那几段放到末尾的标签行" */
    expect(out).not.toContain('[photo:')
    expect(out).not.toContain('[mood:')
    expect(out).toContain('tag lines the sections above')
  })

  it('只管区域与末尾标签的相处,不重排标签彼此顺序(那归 photo/mood 两段 owns)', () => {
    const out = layerRules(true)
    // 交互这一层还在:正文里的区域必须在末尾标签前收干净、不许包标签、不许越到结尾之外
    expect(out).toContain('close every [think] and [act]')
    expect(out).toContain('never put a marker inside a tag')
    expect(out).toContain('run past the end of your message')
    /* 标签彼此的位置(mood 最后、photo 在其前一行)不在这里重说一遍 —— 那是重复、会漂移。
       这句断言把"别再抄回来"钉住 */
    expect(out).not.toContain('very last line')
    expect(out).not.toContain('the line just before it')
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
