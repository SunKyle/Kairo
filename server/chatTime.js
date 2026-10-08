/* ===== "现在几点、上次说话是什么时候" ==================================
   在这之前,角色**完全不知道时间**:system 里只有"你是谁 / 发生过什么 / 规则",
   于是凌晨两点它还精神抖擞,隔了三天回来它像上一秒还在说话 ——
   而这两件事恰恰是真人在聊天里最先注意到的。

   时间这块的数据由**前端**给(只有它知道用户在哪个时区),
   措辞由**这里**定(`chatSystemPrompt` 直接用)—— 与人格字段同一条分工:
   改措辞不该要求用户重装前端。

   四条纪律:
   1. **不精确到秒**:`23:41:07` 是机器的时间;分钟已经够,也不会随请求漂移;
   2. **同一口气里连着说的不算"上次"**(2 分钟内):那时候报一句
      "you last spoke 1 minute ago" 纯粹是噪声;
   3. **超过约 30 天不报间隔**:"两个月前"会让它开口就落进一句尴尬的寒暄 ——
      不如只报当前时间,让它自己决定要不要提;
   4. **认不出来就整块丢掉**,不留 `Right now: ` 的空壳
      (与 characterDesc 里 filter(Boolean) 同一条手法)。

   它同时是给两端用的:前端调 `localStamp()` 生成本地时刻,
   服务端调 `timeContext()` 把它拼成那两行。**纯函数、无 IO、无状态** ——
   单独成文件就是为了测得了(与 chatTags.js 同一种写法)。
   -------------------------------------------------------------------- */

/** 报不报间隔的两条线。2 分钟以下是"同一口气",30 天以上是"太久没见" */
const SAME_BREATH_MS = 2 * 60 * 1000
const TOO_LONG_DAYS = 30

/** `YYYY-MM-DDTHH:MM(:SS)?±HH:MM` —— 只认我们自己发的那种形状。
 *  **必须带偏移**:没有它,"现在几点"就无从谈起(一个光秃秃的
 *  `2026-10-05T23:41` 说的是哪个时区的 23:41?)。
 *  所以 `Z` 也不收 —— 手搓的请求拿不到这一块,而这一块本来只是锦上添花 */
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?[+-]\d{2}:?\d{2}$/

/** 上面那条正则只保证"长得像",不保证"这一天存在":
 *  `Date.parse('2026-02-31T…')` 会悄悄滚到 3 月 2 日(实测过),而那样一来
 *  system 里就会出现一个不存在的日期 —— 这一块的每一句话都必须是**真的**,
 *  所以拿 UTC 拼回去逐项比一遍(也顺手挡掉 13 月、25 点) */
function dateIsReal(y, mo, d, hh, mi) {
  if (+hh > 23 || +mi > 59) return false
  const dt = new Date(Date.UTC(+y, +mo - 1, +d))
  return (
    dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d
  )
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * 本地时刻,写成带偏移的 RFC3339:`2026-10-05T23:41:07+08:00`。
 *
 * 刻意不用 `toISOString()` —— 那是 UTC,而这里要的恰恰是**用户眼前的钟**。
 * 偏移跟着系统走,所以跨时区、跨夏令时都不用我们操心。
 */
export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  /* getTimezoneOffset() 的符号与 RFC3339 相反:东八区返回 -480,而我们要写 +08:00 */
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  )
}

/**
 * "多久以前"那句话 —— **两端共用同一种说法**。
 *
 * 服务端拿它拼 "You two last spoke 3 days ago."(见下),
 * 界面拿它显示消息流末尾那行 "Last spoke 3 days ago"。
 * 共用的理由不是省几行字:同一个事实在两处被说成两样,
 * 用户会以为它们在讲两件事 —— 而它们讲的是同一件。
 *
 * @param ms   过去了多久
 * @param opts.long  true = 不设上限(界面用:隔了半年也该说出个大概)。
 *                   false = 超过 30 天不报(系统提示词用:让它开口就提"两个月前"
 *                   只会换来一句尴尬的寒暄,不如让它自己决定要不要提)
 * @returns 那句话;空串表示**不该报**(太近、太久、或时间戳是坏的)
 */
export function agoLabel(ms, { long = false } = {}) {
  const t = Number(ms)
  /* 未来(负数)、NaN、以及"同一口气"里连着说的,都不报 ——
     宁可少一句,也不能让它说出自相矛盾的话 */
  if (!Number.isFinite(t) || t < SAME_BREATH_MS) return ''

  const min = Math.floor(t / 60000)
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'} ago`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hours / 24)
  if (!long) return days > TOO_LONG_DAYS ? '' : `${days} ${days === 1 ? 'day' : 'days'} ago`
  /* 再往上只给"界面"用,粒度也粗一档:隔了半年还说 "183 days ago"
     是机器在报数,而这时候人会说"半年了" */
  if (days <= 31) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} months ago`
  const years = Math.round(days / 365)
  return `${years} ${years === 1 ? 'year' : 'years'} ago`
}

/** "上次说话"那一句。返回空串表示这一句不该出现(太近、太久、或压根没有) */
function intervalLine(base, lastAt) {
  const t = Number(lastAt)
  if (!Number.isFinite(t) || t <= 0) return ''
  /* 未来时间(用户改过系统钟,或上一条的时间戳坏了)由 agoLabel 挡掉 ——
     报"负三天前"比不报糟得多,它会让角色说出自相矛盾的话。
     天不写"昨天":26 小时前可能是前天的 23 点,按日历算并不是昨天。
     这一块里每一句话都必须是**真的**,宁可用不那么亲切的说法 */
  const ago = agoLabel(base - t)
  return ago ? `You two last spoke ${ago}.` : ''
}

/**
 * 拼成塞进 system 的那一块。认不出来就返回空串(调用方整块丢掉)。
 *
 * @param nowLocal 前端给的本地时刻(localStamp() 那种形状)
 * @param lastAt   上一条消息的时间戳(epoch ms)。没有 = 这是第一次开口
 * @returns 一到两行文本;空串表示这一块不该出现
 */
export function timeContext({ nowLocal, lastAt } = {}) {
  /* 先截断再匹配:入口是公开的,这块虽然结构简单,也不该让一个超长串进来 */
  const stamp = String(nowLocal || '').trim().slice(0, 40)
  const m = STAMP_RE.exec(stamp)
  if (!m) return ''
  const [, y, mo, d, hh, mi] = m
  if (!dateIsReal(y, mo, d, hh, mi)) return ''
  /* 偏移本身也可能是坏的(`+99:99`):那时候 Date.parse 给 NaN,
     而 NaN 参与比较**全部为假** —— 后面那条流水线会一路走到
     "last spoke NaN days ago"。所以基准值先在这里验一次 */
  const base = Date.parse(stamp)
  if (!Number.isFinite(base)) return ''

  /* 星期只看年月日:用 UTC 拼一个日期再取 getUTCDay() ——
     它和服务器时区、和夏令时都无关,同一个日期在哪儿跑都是同一个答案 */
  const day = new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()

  /* 那两个钟必须在这里就分开(2026-10-08):这一行是**现实世界**的钟,而剧情有
     自己的时间 —— 现实里过了三分钟,剧情里可能过了三天。不划清这条界,模型会拿
     它去推断剧情里的"现在",于是把早就发生过的承诺重新当成待办
     (用户报的"已经过去的事情还会被说成等会要做")。
     括号里那句就是划界用的,不是修饰。 */
  const lines = [
    `Right now: ${y}-${mo}-${d} ${hh}:${mi}, ${WEEKDAYS[day]} (the user's local clock, real world only — the story may be at another time).`
  ]
  /* 间隔以**前端给的那个钟**为基准,不取服务器的 Date.now():
     两边的钟可能差几分钟,而"上次"和"现在"必须是同一把尺子量出来的 */
  const ago = intervalLine(base, lastAt)
  if (ago) lines.push(ago)
  return lines.join('\n')
}
