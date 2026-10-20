/* 服务端那个模块是纯 JS(它跑在 Node 里,不参与前端的构建)。
   这里补一份声明,好让单测能带着类型引用它 —— 不然 vitest 里那个 import
   在 typecheck 阶段会被当成 any,测试本身就没人管了
   (与 chatTags.d.ts / chatTime.d.ts / chatMood.d.ts 同一条理由) */

/** 记忆条目那一段最多收几行 */
export declare const CHAT_MEMORY_MAX_LINES: number
/** 单行字符上限 */
export declare const CHAT_MEMORY_LINE_CHARS: number
/** 长期记忆简报(整段叙述)的字符上限 */
export declare const CHAT_MEMORY_BRIEF_MAX_CHARS: number
/** 摊成 system 里"它记得的关于你的事"那一段;空串表示这一块不该出现 */
export declare function memorySection(raw?: unknown): string
/** 把长期记忆简报摊成 system 里那段正文:折叠换行 + 单条上限;
 *  超过上限时在末尾留一道截断标记。空 / 坏输入 → 空串(整段不出现) */
export declare function memoryBrief(raw?: unknown, max?: number): string
/** 给 memoryBrief 折好的正文套上"你记得的这些事"那一段:标题 + 一句"这是靠不住的
 *  压缩回忆"的交代。入参是已折好的正文(不再折一次);空 → 空串(整段不出现) */
export declare function memoryBriefSection(brief?: unknown): string
