/* 让 textarea 随内容长高。

   两条规矩:

   1. **先归零再量**。不归零的话 scrollHeight 只会越量越大,永远缩不回去;
   2. **封顶不在这里算**。对话页那份曾经用 Math.min(scrollHeight, 132) 自己封顶,
      行高一变就错;而 CSS 的 max-height 本来就压得住内联 height,
      交给样式表即可(见 .ed-input / .compose-box textarea)。

   做成共用的一份是因为它有两个使用方:角色向导的规格字段与对话页的输入框。
   两处各写一份的下场是只有一边被修 —— 这边的注释就是从那边合并过来的。 */

export function growTextarea(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/* v-grow:mounted 时定一次高,之后随组件重渲染再量一次。
   v-model 会触发重渲染,所以敲字与清空都跟得上 —— 不需要再挂 @input */
export const vGrow = {
  mounted(el: HTMLTextAreaElement) {
    growTextarea(el)
  },
  updated(el: HTMLTextAreaElement) {
    growTextarea(el)
  }
}
