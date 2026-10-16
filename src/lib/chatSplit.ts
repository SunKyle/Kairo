/* ===== 一条 AI 回复怎么切成几气泡(PRD §3.2-B · 让回话更像"人在发消息") ====
   这一层只做一件事:把一段完整文本按**段落边界**切成有序的几片,让上层渲染成
   依次错开出场的几个气泡 —— 而不是把一段长长的话糊在一格气泡里。

   刻意**只**做渲染层的拆分:落库时它仍然是一条 ChatMessage(一个 id、一段完整
   文本、一份时间戳)。编辑 / 重生成 / 删除 / 导入导出这些"以一条为单位"的动作,
   一条都不用改;拆分只在把这条消息画到屏幕上的那一刻发生。

   产品不变量(都有单测):
   ① 一段话原样回一片 —— 模型自己就写成一整段的,不硬拆;
   ② 只认段落分隔(空行),单换行是同一段的软换行,不切;
   ③ 代码围栏 ```…``` 里的空行不算分隔 —— 一整块必须留在同一格,不然贴出的代码
      会被撕成两半;
   ④ 上限保护,超过就把后面所有片并回最后一格,内容不丢(用户宁可见到"最后一格
      长一点",也不愿见到一条回复变成刷屏);
   ⑤ 空文本 / 全空白 → 空数组(上层据此决定这一条不占位)。 */

/** 一条回复最多切成几格气泡。超过就把后面所有段并到最后一格,不丢弃内容。
 *  4 这个数字是"看着像连发三条以内最自然 + 一条特别长的回复也不至于撑出满屏"
 *  的折中,调它只需要动这里一处。 */
export const CHAT_SPLIT_MAX_BUBBLES = 4

/** 判断这一行是不是代码围栏的一行(``` 打头)。围栏切换就靠它,不解析语言。 */
function isFenceLine(line: string): boolean {
  return line.startsWith('```')
}

/**
 * 把一条 AI 回复按段落边界切成有序气泡片。
 *
 * 段落分隔 = 一段之后的空行(可能连着几行都空白,算一次分隔)。
 * 空行落在 ``` 代码围栏**内部**时不分 —— 整块代码留在同一格。
 * 每片自己 trim 一次;若切出的片数超过 {@link CHAT_SPLIT_MAX_BUBBLES},
 * 前 (N-1) 片原样保留,剩下所有片用 `\n\n` 拼回最后一格。
 */
export function splitAssistantReply(text: string): string[] {
  if (typeof text !== 'string' || !text) return []

  const lines = text.split('\n')
  const paragraphs: string[] = []
  let cur: string[] = []
  let inFence = false

  const flush = () => {
    const p = cur.join('\n').trim()
    if (p) paragraphs.push(p)
    cur = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 围栏开关:遇到 ``` 就翻一次,把 ``` 那行本身留在片内,让整块代码不裂开
    if (isFenceLine(line)) {
      cur.push(line)
      inFence = !inFence
      i++
      continue
    }
    // 段落分隔只发生在**围栏外**的空行;连续几行空白只算一次分隔
    if (!inFence && line.trim() === '') {
      flush()
      while (i < lines.length && !isFenceLine(lines[i]) && lines[i].trim() === '') i++
      continue
    }
    // 其余情形(含 inFence 里的空行 —— 那是代码块内的空行,不当分隔)原样留在当前片
    cur.push(line)
    i++
  }
  flush()

  if (paragraphs.length <= CHAT_SPLIT_MAX_BUBBLES) return paragraphs
  const head = paragraphs.slice(0, CHAT_SPLIT_MAX_BUBBLES - 1)
  const tail = paragraphs.slice(CHAT_SPLIT_MAX_BUBBLES - 1).join('\n\n')
  return [...head, tail]
}

/**
 * 一组气泡的可见**索引** —— 上层拿它做 stagger 的 `--i`。
 *
 * 单独抽出来是为了让"这一组几格、每格第几个"这件事有一个明确出处,而不是让
 * 界面自己去 `v-for` 里 `idx`。将来若要在中间某格前后加"分隔视觉"、或者根据
 * 组内位置改气泡圆角,读的都是这一个索引。
 */
export function bubblePositions(count: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(i)
  return out
}
