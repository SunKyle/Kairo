/* 服务端那个模块是纯 JS(它跑在 Node 里)。**前端也要用它** ——
   `localStamp()` 要给请求带上"用户眼前的钟"(见 src/api.ts 的 chatStream),
   所以这里补一份声明:不然 typecheck 会把那个 import 当成 any,
   而"时刻格式写错"这类错误就没人管了(与 charSpec.d.ts / chatTags.d.ts 同一条理由) */

/** 本地时刻,写成带偏移的 RFC3339:`2026-10-05T23:41:07+08:00` */
export declare function localStamp(d?: Date): string

/** 拼出"现在几点 / 上次说话是什么时候"那两行;空串表示这一块不该出现 */
export declare function timeContext(input?: {
  nowLocal?: string
  lastAt?: number
}): string

/** "3 days ago" 这类相对说法 —— 系统提示词与界面**共用同一句**。
 *  空串 = 不该报(太近、太久、时间戳是坏的);`long: true` 时不限 30 天(界面用) */
export declare function agoLabel(ms: number, opts?: { long?: boolean }): string
