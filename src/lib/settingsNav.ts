/* ===== 设置页的分区清单(PRD §5.6 / §11.12) ==========================
   设置页从"一张接口配置页"变成"用户向设置 + 接口配置"之后,它内部有了分区。
   清单摆在这一层,而不是写在 SettingsPage 的模板里,理由与 lib/nav.ts 一样:
   它有两处要用 —— 左侧那条分区导航,以及"当前在哪一区"的收口(见 normalizeSection)。
   各写一份迟早对不上。

   —— 顺序为什么是这个顺序 ——

   用户向的在前、技术向的在后(PRD §5.6 把接口那类归进"其他管理入口",
   而 §11.12 的示例导航里"外观"排在最后 —— 顺序本身不是硬要求,
   这里按"这一页的主体是用户自己的设置"来排)。
   AI connections 排在最后一名,但它是**唯一有引导入口**的一区:
   对话页那些"先配一个模型"的提示都直接跳到它(见 App 的 openChatConfigSettings)。

   —— 为什么没有"主动联系与通知" ——

   PRD §11.12 的示例导航里有它,§5.6 也点名了。但 T6(主动联系)还没做 ——
   一个"通知"开关摆在设置里、而全站没有任何东西会通知你,比没有这一区更糟:
   用户会以为是自己没配好。所以这一区**等 T6 落地时再加**,
   而不是先摆一排点不动的控件占位。
   -------------------------------------------------------------------- */

/** 设置页里的分区。key 同时也是地址栏里的那一段(见 lib/router 的说明) */
export type SettingsSection = 'appearance' | 'interaction' | 'memory' | 'api'

export interface SettingsSectionMeta {
  key: SettingsSection
  label: string
  hint: string
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  {
    key: 'appearance',
    label: 'Appearance',
    hint: 'Theme and how Chat looks.'
  },
  {
    key: 'interaction',
    label: 'Getting along',
    hint: 'How each character treats you in Chat. Per character.'
  },
  {
    key: 'memory',
    label: 'Memory & privacy',
    hint: 'What it knows about you, and what stays private.'
  },
  {
    key: 'api',
    label: 'AI connections',
    hint: 'The models Kairo talks to, draws with and speaks through.'
  }
]

/** 进设置页时先落在哪一区。
 *
 *  选"外观"而不是"接口配置"有两条理由:① 它是唯一在"一个角色都没有、
 *  一条配置都没建"时也完整可用的分区 —— 空库里落到接口配置上,新用户
 *  看到的第一屏会是一句"还没有配置";② 这一页的主体是用户自己的设置,
 *  技术向的那一区排在最后(见上面的顺序说明)。
 *  常来配接口的人不会因此多走一步:那些引导入口直接指定 section */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'appearance'

/** 这个值是不是一个认得的分区。认不出来的一律退回默认 ——
 *  地址栏 / 老书签里可能有拼错或已删掉的分区名 */
export function isSettingsSection(v: unknown): v is SettingsSection {
  return SETTINGS_SECTIONS.some((s) => s.key === v)
}

/** 把一个来路不明的值收成一个合法分区 */
export function normalizeSection(v: unknown): SettingsSection {
  return isSettingsSection(v) ? v : DEFAULT_SETTINGS_SECTION
}
