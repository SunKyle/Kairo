/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  /* 这是 Vue 官方给的 .vue 垫片写法,原样保留:
     `{}` 在这里是「任意 props」、`any` 是「任意 data」,换成 `object` 或
     `unknown` 会让每个 .vue 的默认导入都不可用。
     这两条规则针对的是**描述业务数据形状**的类型 —— 而这是声明式垫片,
     不是在给某份数据建模,所以按规则字面改只会把类型改坏 */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any
  const component: DefineComponent<{}, {}, any>
  export default component
}
