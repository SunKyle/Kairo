/* ===== 界面偏好(不是数据) ============================================
   这里放"这台设备上这个人喜欢怎么看界面"的那几项。它们与目录数据是两回事:
   - 丢了不影响任何东西的完整性(所以**不跨标签页同步** —— 与 kimage.theme 同一条理由:
     别人切了主题/切了沉浸,跟着变反而突兀);
   - 与 lib/theme.ts 同一条硬规矩:**所有函数都不抛异常**。
     localStorage 在 Safari 无痕、禁用 Cookie、sandbox iframe 里都可能直接抛,
     而调用点就在挂载路径上 —— 漏出去整个应用就不渲染了。
   -------------------------------------------------------------------- */

/** 沉浸式对话页(bool)。存 '1' / '0' —— 与别的键一样是**字符串**,
 *  读取时只认 '1',所以"没设过"与"设成别的"都落回默认关 */
const IMMERSIVE_KEY = 'kimage.immersive'

/** 用户上次是不是开着沉浸模式。**没设过就是关** ——
 *  存量用户不该被突然换一套骨架(默认值是最强的产品表达,别替他决定) */
export function savedImmersive(): boolean {
  try {
    return localStorage.getItem(IMMERSIVE_KEY) === '1'
  } catch {
    return false
  }
}

export function saveImmersive(on: boolean): void {
  try {
    localStorage.setItem(IMMERSIVE_KEY, on ? '1' : '0')
  } catch {
    /* 记不住就记不住:这一次的选择照常生效,只是下次回不到这个状态 */
  }
}
