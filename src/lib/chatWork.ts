/* 对话里生成的那两种图"该怎么读" —— 一处定义,三处引用:
   历史页的图砖(角标 + 悬停那句正文)、预览卡(出处 + 正文)、
   角色作品墙(角标)。

   抽出来是因为这几处必须说同一句话。图砖角标写 "Sent in chat"、
   预览里写另一句,用户会以为是两条不同的来路;而"标题/正文读哪一句"
   更是同一个判断 —— 对话那两种记的 `prompt` 是真正发给模型的整段
   (机位、焦段、光、负面约束全在里面,见 lib/chatPhoto),读起来不像
   "画的是什么";`scene` 才是那句人话。

   这一层全是纯字符串判断,不碰存储也不碰网络,所以判据直接断言(与
   lib/historySearch、lib/text 同一条理由)。 */

import { titleFromPrompt } from './text'

/**
 * 这条记录的出处那句话。**用英文是因为整页界面就是英文** ——
 * 与 "Newest first" / "Made with this character" 同一套语言。
 *
 * 不是对话里来的就没有出处可说 —— 返回空串,调用方据此不画角标
 * (而不是画一个空角标)。
 *
 * 写成 switch 而不是查一张表:入参故意收成 `string | undefined` 而不是
 * HistorySource —— 库里的记录可能来自更新的版本、或被人手改过。
 * 查表时 `LABELS['__proto__']` 会命中原型上的东西(一个真值),
 * 于是"认不出"变成"认出了一个 undefined";switch 没有这个坑。
 */
export function chatWorkLabel(source: string | undefined): string {
  switch (source) {
    case 'chat-photo':
      return 'Sent in chat'
    case 'chat-backdrop':
      return 'Chat background'
    default:
      return ''
  }
}

/** 这条记录是不是对话里生成的(决定要不要画角标) */
export function isChatWork(source: string | undefined): boolean {
  return !!chatWorkLabel(source)
}

/** 记录里参与"读出来"的那两截。刻意收窄:这一层不该知道整条记录长什么样 */
export interface ReadableWork {
  prompt: string
  scene?: string
}

/**
 * 这条记录"画的是什么"那句话。**有场景就用场景** ——
 * 对话那两种的 prompt 是一整段摄影指令,给用户读的是场景。
 * 其余记录本来就只有提示词,原样返回。
 */
export function workText(entry: ReadableWork): string {
  return (entry.scene || '').trim() || entry.prompt
}

/** 图砖角标、读屏、提示词库卡片共用的短标题。取舍与 workText 同源 */
export function workTitle(entry: ReadableWork): string {
  return titleFromPrompt(workText(entry))
}
