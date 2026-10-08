/* 历史搜索:什么算命中。
 *
 *  抽成纯函数是因为它是"用户能不能找到那张图"的全部依据,而真到界面上试
 *  要造几百条记录、试好几种输入才碰得到边界(与 planPrune 同一条理由)。
 *
 *  匹配四处:提示词正文、对话里那段场景、角色名、作品集名 —— 这四样正是
 *  用户脑子里"哪张图"的抓手("我写过 window" / "它当时说在阳台" /
 *  "跟 Alice 那张" / "在「夜班」那个集里")。名字都是 id,所以要把反查表喂进来。
 *
 *  **不做**按图搜图(那要把每张图喂给视觉模型,成本与延迟都不是搜索该有的),
 *  也不搜尺寸、模型这些参数 —— 它们是"怎么生成的",不是"画的是什么"。
 */

/** 反查表:历史记录里存的是 id,而用户记得的是名字 */
export interface HistorySearchNames {
  /** 角色 id → 名字 */
  charNames: Record<string, string>
  /** 作品集 id → 标题 */
  collTitles: Record<string, string>
}

/** 记录里参与匹配的那几项。刻意收窄成这个形状,便于直接喂构造数据测试 */
export interface SearchableEntry {
  prompt: string
  /* 对话里生成的那两种图另有一段"画的是什么"(见 lib/chatWork):
     它们的 prompt 是整段摄影指令(机位、焦段、光全在里面),
     而用户找图时想起的是那段场景 —— 所以场景也要进匹配 */
  scene?: string
  characterId?: string
  collectionId?: string
}

/** 关键词归一:去首尾空白、转小写。空串 = 不筛(不是"什么都匹配不到") */
export function normalizeQuery(raw: string): string {
  return String(raw || '').trim().toLowerCase()
}

/**
 * 这条记录算不算命中。
 *
 * 多个词按 **AND** 处理,而且是在**拼起来的整段文字**里找 ——
 * 于是"alice window"能命中"Alice 这个人 + 提示词里有 window 的那张",
 * 哪怕这两截分别来自角色名与提示词。词序不影响结果。
 */
export function matchesHistoryQuery(
  entry: SearchableEntry,
  rawQuery: string,
  names: HistorySearchNames
): boolean {
  const q = normalizeQuery(rawQuery)
  if (!q) return true
  const who = entry.characterId ? names.charNames[entry.characterId] || '' : ''
  const where = entry.collectionId ? names.collTitles[entry.collectionId] || '' : ''
  /* 场景与提示词并列进同一段:用户不会去想"这句在 prompt 里还是 scene 里",
     他只知道自己记得那个词。场景缺省时是空串,拼进去不影响 */
  const hay = `${entry.prompt || ''} ${entry.scene || ''} ${who} ${where}`.toLowerCase()
  return q.split(/\s+/).every((token) => hay.includes(token))
}
