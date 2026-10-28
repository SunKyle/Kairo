import { createApp } from 'vue'
// 字标字体:只引 latin 子集,避免把西里尔/希腊等用不到的字形打进包
import '@fontsource/poppins/latin-700.css'
import '@fontsource/pacifico/latin-400.css'
import './style.css'
import './styles/settings.css'
import App from './App.vue'
import { applyTheme, currentTheme } from './lib/theme'
import { applyLocale, currentLocale } from './lib/i18n'

/* 首次渲染前先定下主题,避免闪一下浅色再跳到深色。
   口径(存档优先、否则跟随系统)与 App 的切换按钮共用 lib/theme 那一份。
   这一步失败也不该挡住挂载,所以 theme.ts 内部把所有异常都兜住了 */
applyTheme(currentTheme())
/* 语言同一条口径:首屏就把 <html lang> 定下来,读屏与浏览器排版不至于先按英文渲染。
   界面文案本身由 i18n 那份响应式 locale 驱动,这里只补 <html> 上那个属性 */
applyLocale(currentLocale())

createApp(App).mount('#app')