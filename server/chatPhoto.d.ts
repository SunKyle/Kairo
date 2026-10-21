/* 服务端那个模块是纯 JS(它跑在 Node 里,不参与前端的构建)。
   这里补一份声明,好让单测能带着类型引用它 —— 不然 vitest 里那个 import
   在 typecheck 阶段会被当成 any,测试本身就没人管了
   (与 chatTags.d.ts / chatTime.d.ts / chatMood.d.ts / chatGuidance.d.ts /
   chatLayers.d.ts 同一条理由) */

/** 摊成 system 里"怎么发一张图"那一段(发图协议)。
 *  仅在角色发得出图时由调用方注入 —— 调用点用 canDraw 决定 push 与否,
 *  所以注入与否不在这里体现。
 *
 *  frequency 是设置页 Photos 那一档倾向('rare' / 'normal' / 'often')。
 *  这里收成 string 而不是联合类型:入口是公开的,盘上/手搓请求可能是任何值,
 *  实现会把它归一成 normal —— 类型层不该假装它只会收到那三个词。 */
export declare function photoRules(frequency?: string): string
