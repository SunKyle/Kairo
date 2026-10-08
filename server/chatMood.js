/* ===== 角色此刻的心情 ==================================================
   情绪本来只是回复末尾那枚 `[mood:word]` —— 它被服务端剪下来、挂在消息上、
   显示在名字旁边(见 chatTags.js 与 ChatMessage.mood)。那是**给眼睛看的**,
   而它的问题是:每一轮都从零决定,而且只出不进 —— 上一句被气到了,
   这一句还是好声好气。

   这个文件补的就是那一半:**把上一轮的心情喂回去**,让它带着走。
   它同时是**状态**那一侧的判据来源(还作不作数)。

   —— 四条纪律 ——

   1. **不做分类表**。写这个词的是模型,读这个词的也是模型,中间不需要一张
      词表去翻译它(chatTags.js 那边刻意没有枚举,这条不破)。唯一需要形状检查
      的是**代码**这一侧:一个坏词塞进 system 就是一段伪造的提示词结构;
   2. **措辞归这里,数据归前端**。与人格字段、"现在几点"完全同一条分工:
      前端发结构(word + at),这里拼句子。改措辞不该要求用户重装前端;
   3. **过时不喂,而且整块丢掉** —— 不留 `How you feel:` 的空壳
      (与 chatTime.js 第 4 条、characterDesc 里 filter(Boolean) 同一手法);
   4. **可以转向**。只写"你正在恼",模型会一轮一轮地恼下去。那句话里必须
      留一个出口 —— 延续还是改口,由刚才发生了什么定。这也是"不做数值模型"
      换来的东西:惯性由模型演,不由权重算。

   纯函数、无 IO、无状态 —— 单独成文件就是为了测得了(与 chatTags.js /
   chatTime.js 同一种写法)。
   -------------------------------------------------------------------- */

/** 情绪词还作数多久。**6 小时 = "隔夜就散了"**,不是"一次会话"是"同一场戏"。
 *
 *  两条理由:
 *  - 三天的隔阂之后它还端着你上次惹的火,那是**惩罚**不是拟人;
 *  - 真正的"很久没见"已经有出口了 —— `You two last spoke 3 days ago`
 *    那行本来就在,不需要心情再演一遍(见 chatTime.js)。
 *
 *  **不做定时清理**:判据是读的时候算的,不去写一个后台任务追着删。 */
export const CHAT_MOOD_HOLD_MS = 6 * 60 * 60 * 1000

/** 情绪词的形状。**必须与 chatTags.js 里 MOOD_RE 的捕获组一致** ——
 *  那边收的是 `[a-z][a-z-]{1,19}`,这里是同一把尺子。
 *  为什么要再收一道:库里存着的老记录、导入包里那一份、以及手搓的请求,
 *  都不经过那个正则。而一个坏词是会直接进 system 的。 */
const MOOD_WORD_RE = /^[a-z][a-z-]{1,19}$/

/** 收成合法的小写情绪词;认不出返回空串(调用方据此什么都不做) */
export function moodWord(raw) {
  const w = String(raw || '')
    .trim()
    .toLowerCase()
  return MOOD_WORD_RE.test(w) ? w : ''
}

/**
 * 拼出"你现在是什么心情"那两行;空串表示这一块不该出现。
 *
 * `now` 由调用方给(服务端的此刻),不在这一层取 —— 与 timeContext 同一条:
 * 同一把尺子量出来的两个时刻,比较才有意义。
 *
 * 认不出的三种情况一律返回空串:**词不合法**、**没有时间戳**、**过时了**。
 * 它们都不该在 system 里留一个空壳,也不该被"当成没有情绪"和"情绪是空"
 * 混成同一件事 —— 前者是"没话说",后者是"说了个没意义的词"。
 */
export function moodContext(input) {
  const { word, at, now } = input || {}
  const w = moodWord(word)
  if (!w) return ''
  if (!Number.isFinite(at) || at <= 0) return ''
  /* 时钟对不上时 at 可能落在"未来",那时差是负数 —— 照旧当新鲜,
     不去为一次机器时间错位把这一块丢掉(与 chatTime 的 intervalLine 同一条) */
  if (Number.isFinite(now) && now - at > CHAT_MOOD_HOLD_MS) return ''
  return [
    `You are feeling ${w} right now.`,
    `You already felt that way before they said anything - carry it into your reply, or let what they just said turn it.`
  ].join('\n')
}
