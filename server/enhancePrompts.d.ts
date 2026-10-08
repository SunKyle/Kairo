/* 与 charSpec.d.ts 同一条理由:服务端那个模块是纯 JS,
   这里补一份声明好让单测能带着类型 import 它(不然 vitest 里那个 import
   在 typecheck 阶段会被当成 any,提示词里那几行就没人看着了) */

export type EnhanceMode = 'quick' | 'creative' | 'character' | 'vision' | 'summary'

/** 五档系统提示。character / vision 那两段由 server/charSpec.js 生成 */
export declare const ENHANCE_PROMPTS: Record<EnhanceMode, string>
/** 五档温度。拆角色取中间偏放开,识图要"照着图写"所以更低 */
export declare const ENHANCE_TEMPERATURE: Record<EnhanceMode, number>
