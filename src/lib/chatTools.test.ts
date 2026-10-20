import { describe, expect, it } from 'vitest'
import {
  META_TOOL_NAME,
  looksLikeToolUnsupported,
  metaTool,
  newToolCalls,
  normalizeMeta,
  takeToolCallDeltas,
  toolMetaFromCalls
} from '../../server/chatTools.js'

/* 元数据从"正文末尾的标签"搬到 tool calling 之后,最容易坏的是接缝:
   - 流式分片按 index 攒错,arguments 永远拼不成一句合法 JSON;
   - 参数形状不对时,要么静默丢掉、要么把正文一起判死;
   - 上游压根不支持 tools,却当成普通报错,用户不知道该换模型。
   这些都是**静默**的失败 —— 图照样出、字照样说,只是心情和图少了。
   所以这里逐个钉住协议形状与归一化结果。 */

/** 把一次完整的工具调用塞进容器(单测里没必要真的分片) */
function call(
  calls: ReturnType<typeof newToolCalls>,
  index: number,
  name: string,
  args: unknown
) {
  takeToolCallDeltas(calls, [
    {
      index,
      id: `call_${index}`,
      type: 'function',
      function: {
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args)
      }
    }
  ])
}

describe('metaTool · 工具的形状', () => {
  it('名字叫 emit_message_meta,mood 必填', () => {
    const tool = metaTool(true)
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe(META_TOOL_NAME)
    expect(tool.function.name).toBe('emit_message_meta')
    expect(tool.function.parameters.required).toEqual(['mood'])
    expect(tool.function.description).toContain('exactly once')
    expect(tool.function.description).toContain('never mention')
  })

  it('canDraw 时带 photo 对象:scene 必填,shot/frame 是枚举', () => {
    const props = metaTool(true).function.parameters.properties
    const photo = props.photo as {
      type: string
      required: string[]
      properties: Record<string, { enum?: string[]; description?: string }>
    }
    expect(Object.keys(props).sort()).toEqual(['mood', 'photo'])
    expect(photo.type).toBe('object')
    expect(photo.required).toEqual(['scene'])
    expect(photo.properties.shot.enum).toEqual(['selfie', 'third'])
    expect(photo.properties.frame.enum).toEqual(['close', 'medium', 'full'])
    // 画图的人看不到对话 —— 这句必须留在字段说明里,否则模型只写"me on the balcony"
    expect(photo.properties.scene.description).toContain('cannot see this conversation')
    expect(photo.properties.scene.description).toContain('Up to 400 characters')
  })

  it('canDraw=false 时 schema 里连 photo 这个字段都不出现', () => {
    const props = metaTool(false).function.parameters.properties
    expect(Object.keys(props)).toEqual(['mood'])
    // 也不能只是把 required 去掉、留一个可选字段在那儿引着模型写
    expect(props.photo).toBeUndefined()
  })
})

describe('takeToolCallDeltas · 流式分片按 index 攒', () => {
  it('arguments 被切成好几帧时逐段拼回完整 JSON', () => {
    const calls = newToolCalls()
    takeToolCallDeltas(calls, [
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: META_TOOL_NAME, arguments: '{"mood":"ti' }
      }
    ])
    takeToolCallDeltas(calls, [
      { index: 0, function: { arguments: 'red","photo":{"sc' } }
    ])
    takeToolCallDeltas(calls, [
      { index: 0, function: { arguments: 'ene":"me on the balcony","shot":"selfie"}}' } }
    ])

    const got = toolMetaFromCalls(calls)
    expect(got.issue).toBe('')
    expect(got.meta.mood).toBe('tired')
    expect(got.meta.photo).toBe('me on the balcony')
    expect(got.meta.photoSelf).toBe(true)
    expect(got.meta.photoShot).toBe('selfie')
  })

  it('后到的分片不会把第一片里的工具名冲掉', () => {
    const calls = newToolCalls()
    takeToolCallDeltas(calls, [
      { index: 0, function: { name: META_TOOL_NAME, arguments: '{"mood":"calm"}' } }
    ])
    // 少数中转会每帧都带 name,而后续帧里可能是空串或别的形状 —— 名字只认第一枚
    takeToolCallDeltas(calls, [{ index: 0, function: { name: 'other', arguments: '' } }])
    expect(toolMetaFromCalls(calls).meta.mood).toBe('calm')
  })

  it('arguments 直接给成对象也收(不逼所有上游都守同一条协议)', () => {
    const calls = newToolCalls()
    takeToolCallDeltas(calls, [
      { index: 0, function: { name: META_TOOL_NAME, arguments: { mood: 'warm' } } }
    ])
    expect(toolMetaFromCalls(calls).meta.mood).toBe('warm')
  })

  it('没有 index 的帧按 0 收;多个 index 按顺序合并', () => {
    const calls = newToolCalls()
    takeToolCallDeltas(calls, [
      { function: { name: META_TOOL_NAME, arguments: '{"mood":"calm"' } }
    ])
    takeToolCallDeltas(calls, [{ function: { arguments: '}' } }])
    expect(toolMetaFromCalls(calls).meta.mood).toBe('calm')
  })
})

describe('toolMetaFromCalls · 收成旧的扁平字段', () => {
  it('一个工具都没调 → not_called,元数据全空', () => {
    const got = toolMetaFromCalls(newToolCalls())
    expect(got.issue).toBe('not_called')
    expect(got.meta).toEqual({
      mood: '',
      photo: '',
      photoSelf: false,
      photoShot: '',
      photoFrame: ''
    })
  })

  it('调了别的工具 → unknown_tool(不能把别人的参数当自己的)', () => {
    const calls = newToolCalls()
    call(calls, 0, 'search_web', { q: 'weather' })
    expect(toolMetaFromCalls(calls).issue).toBe('unknown_tool')
  })

  it('arguments 不是合法 JSON → invalid_arguments', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, '{"mood": "tired"')
    expect(toolMetaFromCalls(calls).issue).toBe('invalid_arguments')
  })

  it('参数合法但两项都空 → empty_metadata', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, {})
    expect(toolMetaFromCalls(calls).issue).toBe('empty_metadata')
    call(calls, 1, META_TOOL_NAME, { mood: '  ', photo: { scene: '   ' } })
    const got = toolMetaFromCalls(calls)
    expect(got.issue).toBe('empty_metadata')
    expect(got.meta.photo).toBe('')
  })

  it('只有一个合法 mood 就算成功,issue 是空串', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, { mood: ' Tired ' })
    const got = toolMetaFromCalls(calls)
    expect(got.issue).toBe('')
    expect(got.meta.mood).toBe('tired')
    expect(got.meta.photo).toBe('')
  })

  it('mood 不成词就当没给 —— 但同一份参数里的 photo 仍然有效', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, {
      mood: 'very tired',
      photo: { scene: 'rain running down the window pane', frame: 'close' }
    })
    const got = toolMetaFromCalls(calls)
    expect(got.meta.mood).toBe('')
    expect(got.meta.photo).toBe('rain running down the window pane')
    expect(got.meta.photoFrame).toBe('close')
    expect(got.issue).toBe('')
  })

  it('photo 对象:shot 说自拍时 self 自动为真,frame 原样带出', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, {
      mood: 'warm',
      photo: {
        scene: 'me leaning on the balcony rail at dusk',
        shot: 'Self-Portrait',
        frame: 'Close-Up'
      }
    })
    const got = toolMetaFromCalls(calls)
    expect(got.meta.photoSelf).toBe(true)
    expect(got.meta.photoShot).toBe('selfie')
    expect(got.meta.photoFrame).toBe('close')
  })

  it('显式 self:false 时,就算写了 shot 也只当"人不在画面里"', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, {
      mood: 'calm',
      photo: { scene: 'the harbour at dawn', shot: 'selfie', self: false }
    })
    const got = toolMetaFromCalls(calls)
    expect(got.meta.photoSelf).toBe(false)
    expect(got.meta.photoShot).toBe('')
  })

  it('photo 给成字符串也认,旧前缀会被剪掉', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, {
      mood: 'amused',
      photo: 'selfie: me in the bathroom mirror, hair wet'
    })
    const got = toolMetaFromCalls(calls)
    expect(got.meta.photo).toBe('me in the bathroom mirror, hair wet')
    expect(got.meta.photoSelf).toBe(true)
    expect(got.meta.photoShot).toBe('selfie')
  })

  it('没写 shot 时仍能从"手上的杯子"这类描述兜底判出它在画面里', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, {
      mood: 'warm',
      photo: 'my hands wrapped around the mug'
    })
    const got = toolMetaFromCalls(calls)
    expect(got.meta.photoSelf).toBe(true)
    // 相机那一项仍留空 —— 它在画面里,但模型没说谁拍的
    expect(got.meta.photoShot).toBe('')
  })

  it('纯风景照就是"人不在画面里",不靠猜', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, {
      mood: 'uneasy',
      photo: { scene: 'rain on the window at dawn' }
    })
    const got = toolMetaFromCalls(calls)
    expect(got.meta.photoSelf).toBe(false)
    expect(got.meta.photoShot).toBe('')
  })

  it('场景里点了角色名也算它在画面里', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, {
      mood: 'proud',
      photo: { scene: 'Alice on the pier, the whole harbour behind her' }
    })
    expect(toolMetaFromCalls(calls, 'Alice').meta.photoSelf).toBe(true)
  })

  it('场景按 400 字截断、压成一行', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, {
      mood: 'calm',
      photo: { scene: `me on the balcony\n\n${'x'.repeat(600)}` }
    })
    const got = toolMetaFromCalls(calls)
    expect(got.meta.photo.length).toBe(400)
    expect(got.meta.photo).not.toContain('\n')
  })

  it('分两次调用时按顺序合并,photo 是深一层而不是整块顶掉', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, {
      mood: 'calm',
      photo: { scene: 'me on the pier at dawn', shot: 'third' }
    })
    call(calls, 1, META_TOOL_NAME, { photo: { frame: 'full' } })
    const got = toolMetaFromCalls(calls)
    expect(got.issue).toBe('')
    expect(got.meta.mood).toBe('calm')
    expect(got.meta.photo).toBe('me on the pier at dawn')
    expect(got.meta.photoShot).toBe('third')
    expect(got.meta.photoFrame).toBe('full')
  })

  it('一枚写坏了,另一枚好的仍然算数', () => {
    const calls = newToolCalls()
    call(calls, 0, META_TOOL_NAME, '{"mood":')
    call(calls, 1, META_TOOL_NAME, { mood: 'delighted' })
    const got = toolMetaFromCalls(calls)
    expect(got.issue).toBe('')
    expect(got.meta.mood).toBe('delighted')
  })

  it('同时调了别的工具与本工具:本工具那一枚仍然有效', () => {
    const calls = newToolCalls()
    call(calls, 0, 'search_web', { q: 'weather' })
    call(calls, 1, META_TOOL_NAME, { mood: 'wary' })
    expect(toolMetaFromCalls(calls).meta.mood).toBe('wary')
  })
})

describe('normalizeMeta · 不做 issue 判断的那一层', () => {
  it('没有 photo 时四个 photo 字段都是缺省值', () => {
    expect(normalizeMeta({ mood: 'warm' })).toEqual({
      mood: 'warm',
      photo: '',
      photoSelf: false,
      photoShot: '',
      photoFrame: ''
    })
  })

  it('photo 不是对象/字符串时整块忽略,不抛错', () => {
    expect(normalizeMeta({ mood: 'warm', photo: 42 }).photo).toBe('')
    expect(normalizeMeta({ mood: 'warm', photo: [] }).photo).toBe('')
    expect(normalizeMeta(null).mood).toBe('')
  })
})

describe('looksLikeToolUnsupported · 认出"这个模型不支持工具"', () => {
  it('常见的几种上游说法都认得', () => {
    expect(looksLikeToolUnsupported('tools is not supported by this model')).toBe(true)
    expect(looksLikeToolUnsupported('This model does not support function calling')).toBe(true)
    expect(looksLikeToolUnsupported('unknown field tools')).toBe(true)
    expect(looksLikeToolUnsupported('tool_choice is not supported')).toBe(true)
    expect(looksLikeToolUnsupported('Unsupported parameter: tools')).toBe(true)
    expect(looksLikeToolUnsupported('function calling is not available')).toBe(true)
  })

  it('"参数坏了"不能说成"模型不支持工具"', () => {
    // 这条是模型会调工具、只是这一枚写坏了 —— 换模型治不了,重试才有用
    expect(looksLikeToolUnsupported('invalid tool call arguments')).toBe(false)
    expect(looksLikeToolUnsupported('invalid function arguments')).toBe(false)
    expect(looksLikeToolUnsupported('rate limit exceeded')).toBe(false)
    expect(looksLikeToolUnsupported('')).toBe(false)
    expect(looksLikeToolUnsupported(null)).toBe(false)
  })
})
