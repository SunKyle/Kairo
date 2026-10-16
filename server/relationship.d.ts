/* 服务端那个模块是纯 JS(它跑在 Node 里,不参与前端的构建)。
   这里补一份声明,好让单测能带着类型引用它 —— 不然 vitest 里那个 import
   在 typecheck 阶段会被当成 any,测试本身就没人管了
   (与 chatGuidance.d.ts / chatMemory.d.ts 同一条理由) */

/** 行数上限(关系那一段最多收几行) */
export declare const CHAT_RELATIONSHIP_MAX_LINES: number
/** 单行字符上限 */
export declare const CHAT_RELATIONSHIP_LINE_CHARS: number
/** 摊成 system 里"你们熟到什么程度"那一段;空串表示这一块不该出现 */
export declare function relationshipSection(raw?: unknown): string
