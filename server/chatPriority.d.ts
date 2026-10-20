/* 服务端那个模块是纯 JS(它跑在 Node 里,不参与前端的构建)。
   这里补一份声明,好让单测能带着类型引用它 —— 不然 vitest 里那个 import
   在 typecheck 阶段会被当成 any,测试本身就没人管了
   (与 chatTags.d.ts / chatTime.d.ts / chatMood.d.ts / chatGuidance.d.ts /
   chatLayers.d.ts / chatPhoto.d.ts 同一条理由) */

/** 摊成 system 里"信息优先级"那一段(冲突时谁说了算)。定长文本、无入参、
 *  每轮都注入 —— 由调用方排在 CHAT_OPENING 之后,模型带着这把尺子往下读各段。 */
export declare function priorityRules(): string
