/* ===== 转写旁白（transcript notes）的清理 ==============================
   附件与图片不能只留一行空正文回放给模型，所以旧版前端会在**助手消息的
   正文里**补一行 `(a song was shared — …)` / `(a link was shared — …)`。
   问题恰恰出在这:它是模型自己那一轮的正文,模型会把它当成"我上次就是这么
   写的",照抄进新回复 —— 实测里它宁可写这行括号,也不去调 emit_message_meta。

   现在"发过什么卡"改由 system 里一段简报交代（见 chatShare.js 的
   sharedCardsBrief），正文里不再补这行。这个模块只负责**清理**,不解析:
   入口（历史消息）与出口（流式正文）各清一次,清出来的东西一律丢掉 ——
   与旧 `[photo:]` / `[mood:]` 同一条规矩:文本永远不能顶替工具调用。

   两套名单是刻意分开的:
   - 入口只清**分享旁白**。`(sent a photo)` / `(sent a card)` / `(said nothing)`
     是前端给空正文写的占位,还要靠它告诉模型"这一轮不是真的空白";
   - 出口清全部。模型不该产出其中任何一种。
   -------------------------------------------------------------------- */

/** 分享卡的两行旁白。整行匹配（前后可以有空白），夹在句子中间的同款
 *  文字不碰 —— 那可能是角色真的在说这句话里的括号。 */
const SHARE_NOTE_RE = /^\((?:a song was shared|a link was shared)\b[^\n]*\)\s*$/

/** 出口的全套旁白（含占位）。模型写出来的任何一种都不该流给用户 */
const ANY_NOTE_RE =
  /^\((?:a song was shared|a link was shared|sent a photo|said nothing|sent a card)\b[^\n]*\)\s*$/

/** 流式里"还没写完"的旁白前缀。以它们开头的当前行先扣住,
 *  等换行或收尾时再交给清理函数决定丢不丢 */
const NOTE_STARTS = [
  '(a song was shared',
  '(a link was shared',
  '(sent a photo)',
  '(said nothing)',
  '(sent a card)'
]

/** 按给定名单整行摘掉。什么都没摘时**一个字都不动**（与 stripStandaloneTags
 *  同一条纪律:不借着清理的机会去改别人的正文）。摘过之后收一收多余空行与
 *  末尾空白 —— 旁白通常挂在正文最后一行,收走它会留下一个空行,界面上就是
 *  气泡底下多一截。 */
function stripLines(s, re) {
  const src = String(s || '')
  const lines = src.split('\n')
  const kept = []
  let removed = false
  for (const line of lines) {
    if (re.test(line.trim())) {
      removed = true
      continue
    }
    kept.push(line)
  }
  if (!removed) return src
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '')
}

/** 入口:只清分享旁白。占位原样留着 —— 它还在承担"这一轮是什么"的信息 */
export function stripShareNotes(s) {
  return stripLines(s, SHARE_NOTE_RE)
}

/** 出口:分享旁白与三种占位全清（模型不该产出其中任何一种） */
export function stripTranscriptNotes(s) {
  return stripLines(s, ANY_NOTE_RE)
}

/**
 * 这一截尾巴**可以放出去多长** —— 比 chatTags.js 的 tailHold 更保守:
 * 末尾那一行只要**可能**长成一条旁白,就整行扣住,等换行/收尾再处理。
 * 调用方与 tailHold 的返回值取 min。
 *
 * 只扣"以旁白前缀开头"的行:普通正文里的 `(I remember…)` 不在名单里,
 * 不会被这段按下 —— 流式不该因为它多等一拍。
 */
export function noteHold(buffer) {
  const s = String(buffer || '')
  const start = s.lastIndexOf('\n') + 1
  const line = s.slice(start)
  if (!line) return s.length
  const t = line.replace(/^\s+/, '')
  const could = NOTE_STARTS.some((p) => p.startsWith(t) || t.startsWith(p))
  return could ? start : s.length
}
