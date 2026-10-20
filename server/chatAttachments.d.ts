/* 与 chatTools.d.ts 同一条理由：服务端是纯 JS，前端单测需要一份类型声明。 */

export declare const ATTACHMENT_KINDS: readonly string[]
export declare const ATTACHMENT_TITLE_CHARS: number
export declare const ATTACHMENT_SUBTITLE_CHARS: number
export declare const ATTACHMENT_URL_CHARS: number

/** 归一化之后真正落到消息上的那一样东西。
 *  link 一定带 url；music 的 url 可缺（纯分享一首歌也成立）。 */
export interface ChatAttachment {
  kind: 'link' | 'music'
  title: string
  url?: string
  subtitle?: string
}

/** 字面量层面就该拒绝的本机/内网主机名 */
export declare function isPrivateHost(host: unknown): boolean

/** 能安全交给 `<a href>` 的 http(s) 地址；不合法回空串 */
export declare function normalizeHttpUrl(raw: unknown): string

/** 模型给的 attachment → 消息上的附件；不合法回 null */
export declare function normalizeAttachment(v: unknown): ChatAttachment | null

/** `emit_message_meta` 的 parameters.properties.attachment */
export declare function attachmentSchema(): {
  type: 'object'
  description: string
  properties: Record<string, unknown>
  required: string[]
  additionalProperties: boolean
}
