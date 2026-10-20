/* 服务端那个模块是纯 JS(它跑在 Node 里,不参与前端的构建)。
   这里补一份声明,好让单测能带着类型引用它(与 chatPhoto.d.ts /
   chatTags.d.ts 同一条理由)。 */

import type { ChatAttachment } from './chatAttachments.js'

/** 工具名。System Prompt、探针、实现三处必须逐字一致 */
export declare const META_TOOL_NAME: string

/** 一份归一化之后的元数据 —— 与旧标签协议吐出来的扁平字段一字不差,
 *  外加一枚可选的附件(链接) */
export interface ChatMeta {
  mood: string
  photo: string
  photoSelf: boolean
  photoShot: string
  photoFrame: string
  attachment: ChatAttachment | null
}

/** `emit_message_meta` 的工具定义。canDraw 为假时 schema 里没有 photo 字段 */
export declare function metaTool(canDraw?: boolean): {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required: string[]
      additionalProperties: boolean
    }
  }
}

/** 一个已通过 JSON.parse 的参数对象 → 旧的扁平结果(不给 issue) */
export declare function normalizeMeta(obj: unknown, charName?: string): ChatMeta

export declare function newToolCalls(): Map<
  number,
  { id: string; name: string; args: string }
>

export declare function takeToolCallDeltas(
  calls: Map<number, { id: string; name: string; args: string }>,
  deltas: unknown
): Map<number, { id: string; name: string; args: string }>

/** 把攒下来的 tool calls 收成扁平元数据 + 一个可选的 issue */
export declare function toolMetaFromCalls(
  calls: Map<number, { id: string; name: string; args: string }> | null | undefined,
  charName?: string
): {
  meta: ChatMeta
  issue: '' | 'not_called' | 'unknown_tool' | 'invalid_arguments' | 'empty_metadata'
}

/** 这句上游报错是不是在说"本模型不支持工具调用" */
export declare function looksLikeToolUnsupported(text: unknown): boolean
