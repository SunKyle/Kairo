/* 站点主题的唯一出处。main.ts 要在首屏渲染前把主题定下来,
   App.vue 要读它来渲染切换按钮并跟随系统变化 —— 两处各写一份的结果是
   "页面已是深色、按钮却说切到深色"(见下方的取舍说明),所以收在这里。

   这里所有函数都不抛异常:主题失败最多是配色不对,不该挡住渲染。
   localStorage 与 matchMedia 在 Safari 无痕、禁用 Cookie、sandbox iframe
   等场景下都可能直接抛,而 main.ts 的调用发生在 mount() 之前 ——
   一旦漏出去,整个应用就不挂载了。 */

export type Theme = 'light' | 'dark'

const THEME_KEY = 'kimage.theme'

/** 用户手动设过的主题。没设过(或被禁了存取)返回 null,由调用方回落系统偏好 */
export function savedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/** 当前该用哪套:用户手动设的优先,否则跟随系统 */
export function currentTheme(): Theme {
  return savedTheme() ?? (prefersDark() ? 'dark' : 'light')
}

/** 写进 <html data-theme>。样式是按这个属性分主题的(见 style.css) */
export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
}

/** 记下用户的选择。存不下就只在本次会话生效,不打断切换 */
export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* ignore */
  }
}

/**
 * 跟随系统主题变化。返回解绑函数(没绑上时是空函数,调用方不必判空)。
 *
 * 只在用户**没有**手动设过时回调:手动选择是一次明确的表态,
 * 不该被系统设置覆盖 —— 与 main.ts 的"存档优先"是同一条优先级。
 */
export function watchSystemTheme(cb: (theme: Theme) => void): () => void {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => {
      if (savedTheme()) return
      cb(e.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  } catch {
    return () => {}
  }
}
