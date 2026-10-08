/* 服务端那个模块是纯 JS(它跑在 Node 里)。**前端也要用它** ——
   起稿的标签 → 字段对照表、字段顺序、必填枚举全由它算出来(src/api.ts),
   所以这里补一份声明:不然 typecheck 会把那个 import 当成 any,
   而"标签与字段对不上"这类错误就没人管了(与 chatTags.d.ts 同一条理由) */

export type CharSpecGroup = 'name' | 'field' | 'persona'

export interface CharSpecLine {
  group: CharSpecGroup
  /** 它在 CharacterFields / CharacterPersona 里的键(name 那行对 CharacterDraft.name) */
  key: string
  /** 提示词里那行的标签,也是前端解析时认的那个词 */
  label: string
  /** `<...>` 里那句说明。两种起稿各要一句时给对象 */
  desc: string | { character: string; vision: string }
  /** 必须有个值(进 "… must always have a value" 那句枚举) */
  always?: boolean
  /** 只喂设定图、不进普通创作提示词 */
  sheetOnly?: boolean
  /** 模型只能从这几个词里挑一个。没有 = 自由文本 */
  enumValues?: string[]
}

export declare const CHAR_SPEC_LINES: CharSpecLine[]
export declare const CHAR_SPEC_LINE_COUNT: number
/** 某一组按顺序的键 */
export declare function charSpecKeys(group: CharSpecGroup): string[]
/** 提示词里那一整块行清单,按档位取 desc */
export declare function charSpecLinesText(mode: 'character' | 'vision'): string
/** "Name, Style, … and Outfit" —— always 那几行拼出来的枚举 */
export declare function charSpecAlwaysSentence(): string
/** 某个键的枚举候选。空数组 = 自由文本 */
export declare function charSpecEnumOf(key: string): string[]
