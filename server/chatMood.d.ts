/* 服务端那个模块是纯 JS(它跑在 Node 里)。**前端也要用它** ——
   `moodWord()` 是两处共用的那把尺子:收尾写入状态之前、以及拼出图提示词的
   表情层之前,都要先问一句"这个词合法吗"。所以这里补一份声明,
   不然 typecheck 会把那个 import 当成 any(与 chatTime.d.ts 同一条理由) */

/** 情绪词还作数多久(6 小时)。喂回 system 与"这一条状态还有没有用"共用它 */
export declare const CHAT_MOOD_HOLD_MS: number

/** 收成合法的小写情绪词;认不出返回空串(调用方据此什么都不做) */
export declare function moodWord(raw?: unknown): string

/** 拼出"你现在是什么心情"那两行;空串表示这一块不该出现 */
export declare function moodContext(input?: {
  word?: unknown
  at?: number
  now?: number
}): string
