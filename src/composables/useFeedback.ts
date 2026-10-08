import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { uid } from '../api'

/* ===== 反馈:错误、提示、删除撤销 =====================================
   三条通道,三种语义,别混:
   - error   出错了(红)。可重试的才给重试键
   - notice  中性告知(存好了、空间快满了)。自动收起,指针停上去不计时
   - undo    删除的后悔药。**真正落盘发生在窗口结束时**,窗口里数据还在,
             所以"撤销"只是把它放回列表,不必从磁盘上搬回来

   抽出来的理由:它们是每一块业务域都要用的东西(出图、角色、对话、作品集、
   提示词库都会报错、都会给提示、都有删除),留在 App.vue 里的话,
   后面每抽一个域都要反过来依赖主界面 —— 那就不是拆分而是搬家。
   -------------------------------------------------------------------- */

export interface PendingUndo {
  /** 换一次删除就换一个 token,撤销条据此重新点燃 */
  token: string
  /** 说明删掉了什么 */
  label: string
  /** 把东西放回列表,并把恢复后的状态落盘 */
  undo: () => void
  /** 窗口结束:真正落盘删除,释放图片地址 */
  purge: () => void
}

export function useFeedback() {
  const error = ref('')
  // 错误区默认收成一行:上游原文动辄上百字,整段铺开会把输入区顶得很高
  const errorOpen = ref(false)
  // 只有真正发起过生图才谈得上"重试",校验类提示不给这个按钮
  const canRetry = ref(false)
  /** 统一的错误出口:顺带把折叠状态收回、标记可否重试 */
  function fail(msg: string, retryable = false) {
    error.value = msg
    canRetry.value = retryable
    errorOpen.value = false
  }
  // 校验类提示都很短,不值得给「详情」;上游原文通常远长于此
  const errorLong = computed(() => error.value.length > 90)

  // 存储清理的事后告知。它不是错误,所以单独一条通道,中性配色
  const notice = ref('')

  /* —— 提示的自动收起 ——
     它是"说过就算"的中性通知(存好了、空间快满了),不该一直占着画面底部等人来关;
     但也不能一闪而过:长句得留够读的时间,所以按长度给时长 */
  let noticeTimer = 0
  /** 读一条提示要多久。短句 4 秒;长的每字再加 60ms ——
   *  "存储快满"那种一句能到一百多字,照 4 秒收掉等于没提示 */
  function noticeMs(msg: string) {
    return Math.min(9000, 4000 + msg.length * 60)
  }
  function clearNotice() {
    window.clearTimeout(noticeTimer)
    notice.value = ''
  }
  /** 把指针停在浮条上时不计时:长一点的提示用户可能正在读,
   *  读到一半整条消失,会让人怀疑自己是不是记错了 */
  function holdNotice() {
    window.clearTimeout(noticeTimer)
  }
  /** 指针移开,接着计时。整条重新算而不是接着上一段:实现简单,
   *  而且用户等于又看了一遍 —— 多留这几秒不亏 */
  function releaseNotice() {
    window.clearTimeout(noticeTimer)
    if (notice.value) noticeTimer = window.setTimeout(clearNotice, noticeMs(notice.value))
  }
  /* 换一条提示就重置计时。watch 而不是在每个赋值处手动起表:
     写提示的地方有几十处,漏一处就是"这条提示永远不收" */
  watch(notice, (v) => {
    window.clearTimeout(noticeTimer)
    if (v) noticeTimer = window.setTimeout(clearNotice, noticeMs(v))
  })
  onBeforeUnmount(() => window.clearTimeout(noticeTimer))

  /* —— 删除的撤销窗口 ——
     删除不再弹确认框,而是立刻生效、几秒内可撤销(见 components/UndoToast.vue)。
     同一时刻只保留一次待撤销:再来一次删除就把上一次落盘,否则两枚按钮会各烧各的 */
  const pendingUndo = ref<PendingUndo | null>(null)
  /** 4.5 秒:够看清删了什么、也够反悔,又不至于让这条一直挂在屏幕上 */
  const UNDO_MS = 4500

  function scheduleUndo(item: Omit<PendingUndo, 'token'>) {
    pendingUndo.value?.purge()
    pendingUndo.value = { ...item, token: uid() }
  }
  // 保险丝烧完 = 用户接受了这次删除
  function commitUndo() {
    const p = pendingUndo.value
    pendingUndo.value = null
    p?.purge()
  }
  function runUndo() {
    const p = pendingUndo.value
    pendingUndo.value = null
    p?.undo()
  }

  return {
    error,
    errorOpen,
    canRetry,
    errorLong,
    fail,
    notice,
    noticeMs,
    clearNotice,
    holdNotice,
    releaseNotice,
    pendingUndo,
    UNDO_MS,
    scheduleUndo,
    commitUndo,
    runUndo
  }
}
