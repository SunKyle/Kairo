import { computed, nextTick, onMounted, onUpdated, ref, watch } from 'vue'

/* ===== 对话流的滚动编排 =================================================
   从 ChatPage 抽出来的"自动跟随 + 往前读一档"那一整块。
   它管的只有一件事:消息在变、用户在滚,视口该落在哪。
   —— 流式时贴着底就一路跟下去,用户往上翻了就别拽他回来;
   —— 往前读一档时内容从**上面**插进来,要按长高了多少把滚动条往下推,稳住他正在看的那句。

   之所以值得单拆:这是全页最容易出 bug、又最该能单独测的一段(纯 DOM/滚动,
   不碰数据、不碰网络)。ChatPage 只负责"把它接到那个滚动容器上"。

   它不读 props,只认几个 getter(谁调用谁负责把当前值喂进来):
   - messageCount:当前这一场的消息条数。流式改的是同一条的**内容**,数组长度不变,
     所以"跟着走"不能靠 watch 它 —— 那是 onUpdated 的活;它只管"不贴底时又长了几条"。
   - active:当前角色 id。换角色 = 换一段对话,要重置并落到最新那句。
   - hasMore / streaming:往前读一档的两个前置条件(没得读 / 正在生成时不给读)。
   - onLoadEarlier:读一档这个意图交回调用方(它再 emit 给主界面,分工不变)。 */
export function useChatStream(opts: {
  messageCount: () => number
  active: () => string
  hasMore: () => boolean
  streaming: () => boolean
  onLoadEarlier: () => void
}) {
  /* 滚动容器。调用方把它绑到那条 overflow 列表上(ref="streamEl") */
  const streamEl = ref<HTMLElement | null>(null)
  /* 距底多少像素以内算"贴着底"。给一点余量:像素取整、滚动条动画都会让
     scrollHeight - scrollTop - clientHeight 差那么一两 px,卡 0 会误判成"翻上去了" */
  const FOLLOW_GAP = 80

  /* 贴着底没有。这是"自动跟随"的开关 —— 只在贴底时把视口带下去,
     用户往上翻的时候要让他安静地看。
     做成响应式(原来是普通变量)是因为界面还要据此决定要不要给"回到最新" */
  const atBottom = ref(true)
  /* 翻上去之后又来了几条。说的不是"未读" —— 用户可能刚看过,
     只是此刻不在底部,所以文案用"N new"而不是红点角标 */
  const pendingNew = ref(0)
  /* 正在做"回到最新"的平滑滚动。滚动过程会一路触发 scroll 事件、
     把 atBottom 反复算成 false,那枚按钮就会自己闪一下 —— 用一个旗子按住 */
  let jumping = false

  function onStreamScroll() {
    if (jumping) return
    const el = streamEl.value
    if (!el) return
    atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_GAP
    // 自己滚回底部就等于看过了
    if (atBottom.value) pendingNew.value = 0
  }
  function toEnd(smooth = false) {
    const el = streamEl.value
    if (!el) return
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
    atBottom.value = true
    pendingNew.value = 0
  }
  /* 那枚"回到最新"。只在真有内容、而且不贴底时出现 */
  const showJump = computed(() => !atBottom.value && opts.messageCount() > 0)
  function jumpToLatest() {
    if (jumping) return
    jumping = true
    toEnd(true)
    window.setTimeout(() => {
      jumping = false
    }, 400)
  }

  /* 放在 onUpdated 而不是 watch(messages):流式时改的是**同一条消息的内容**,
     数组长度没变,watch 抓不到 */
  onUpdated(() => {
    if (atBottom.value) toEnd()
  })

  /* 不贴底的时候底下又长了东西 ⇒ 记一笔,好在那枚按钮上说出来。
     往前读一档不算:那是用户自己点出来的,而且内容插在**上面** ——
     那种情况下该做的是稳住视口(见下面的 earlierFrom) */
  watch(opts.messageCount, (n, prev) => {
    if (!prev || earlierFrom) return
    if (!atBottom.value && n > prev) pendingNew.value += n - prev
  })

  /* 换角色 = 进到另一段对话,该落在最新那一句上。
     (收菜单、收记忆卡片那类"顺带把浮层关掉"不在这里 —— 那是 UI 的事,
      留在 ChatPage 自己那条 active watcher 里,这块只管滚动落点) */
  watch(opts.active, async () => {
    atBottom.value = true
    pendingNew.value = 0
    await nextTick()
    toEnd()
  })

  onMounted(async () => {
    await nextTick()
    toEnd()
  })

  /* ===== 往前读一档 ===================================================
     库里装的是最近一档,更早的还在库里没读。
     往上面插内容时浏览器不一定能自己稳住视口,所以读之前先记下高度,
     回来后按"长高了多少"把滚动条往下推同样的距离 */
  let earlierFrom = 0

  function loadEarlier() {
    if (!opts.hasMore() || opts.streaming()) return
    const el = streamEl.value
    earlierFrom = el ? el.scrollHeight : 0
    /* 先把"贴着底"关掉:消息一回来组件就会重渲染,
       这时若还贴着底,onUpdated 会把视口拽到底部去 —— 那是反方向 */
    atBottom.value = false
    opts.onLoadEarlier()
  }

  watch(
    opts.messageCount,
    () => {
      if (!earlierFrom) return
      const el = streamEl.value
      const grew = el ? el.scrollHeight - earlierFrom : 0
      earlierFrom = 0
      if (el && grew > 0) el.scrollTop += grew
    },
    // post:要在 DOM 更新**之后**量,否则量到的还是插进来之前的高度
    { flush: 'post' }
  )

  return {
    streamEl,
    atBottom,
    pendingNew,
    showJump,
    onStreamScroll,
    toEnd,
    jumpToLatest,
    loadEarlier
  }
}
