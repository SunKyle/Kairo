/* 服务端那个模块是纯 JS(它跑在 Node 里,不参与前端的构建)。
   这里补一份声明,好让单测能带着类型引用它 —— 不然 vitest 里那个 import
   在 typecheck 阶段会被当成 any,测试本身就没人管了
   (与 chatTags.d.ts / chatTime.d.ts / chatMood.d.ts / chatGuidance.d.ts 同一条理由) */

/** 摊成 system 里"分层产出(说/想/做)"那一段。`sceneMode` 为真才邀请 `[act]`。 */
export declare function layerRules(sceneMode?: boolean): string
