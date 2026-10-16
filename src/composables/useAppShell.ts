import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  applyTheme,
  currentTheme,
  saveTheme,
  watchSystemTheme,
  type Theme
} from '../lib/theme'

/* ===== 应用外壳的纯装饰状态 =============================================
   从 App.vue 抽出来的两块"壳"自己的状态。它们共同点是:不碰数据、不碰路由、
   不碰角色,只是界面外壳的两枚开关 ——
   - 主题:当前深浅档、切换入口、跟随系统。
   - 滚动:页面滚没滚,顶栏据此浮出毛玻璃底,避免与内容糊在一起。

   之所以值得单拆:这两件事与那上千行的业务编排毫无关系,留在 App 里只会把
   "外壳开关"和"编排"糊成一团。拆出来后 App 只负责把它们接到模板上
   (theme/setTheme/toggleTheme 供顶栏按钮与设置页外观分区,scrolled 供顶栏的类)。
   沉浸态(immersive)没有一起搬:它的 immersiveOn 要看 page、卸载时还要收尾
   chatCharId / loadBackdrop,那是编排不是装饰,留在 App 里才对。

   生命周期在 setup 期间调用是合法的,所以监听器的挂载与卸载都收在这里,
   调用方不必再记着收尾 —— 少一处"忘了 removeEventListener"的隐患。 */
export function useAppShell() {
  // —— 主题 ——
  /* 初值必须与 main.ts 同一套口径(存档优先、否则跟随系统)。
     原来这里只认存档、没有就硬当浅色,于是系统是深色且用户没手动设过时:
     页面已是深色,按钮却显示"切到深色",点一下毫无变化 —— 要连点两次才对 */
  const theme = ref<Theme>(currentTheme())
  /* 设定某一档。**顶栏那枚按钮与设置页的外观分区共用这一个入口** ——
     两处都能改主题,落盘与套用必须只发生在这一个地方(两份写法迟早分叉) */
  function setTheme(t: Theme) {
    if (theme.value === t) return
    theme.value = t
    applyTheme(t)
    saveTheme(t)
  }
  function toggleTheme() {
    setTheme(theme.value === 'dark' ? 'light' : 'dark')
  }
  /* 系统里切深浅色,页面要跟着走(用户手动设过就不再跟,见 watchSystemTheme) */
  let unwatchSystemTheme: (() => void) | null = null

  // —— 顶部导航滚动状态 ——
  const scrolled = ref(false)
  function onScroll() {
    scrolled.value = window.scrollY > 4
  }

  onMounted(() => {
    unwatchSystemTheme = watchSystemTheme((t) => {
      theme.value = t
      applyTheme(t)
    })
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
  })
  onBeforeUnmount(() => {
    unwatchSystemTheme?.()
    window.removeEventListener('scroll', onScroll)
  })

  /* onScroll 不外露:它只是"把 scrolled 刷新一下"的内部动作,
     模板里从头到尾只读 scrolled 那个状态,没地方需要手动调它 */
  return { theme, setTheme, toggleTheme, scrolled }
}
