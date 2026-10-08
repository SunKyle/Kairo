/* 站点的一级页面清单。
   两处要用它:顶部导航(分段控件)把它渲染成四个图标,
   顶部字标取"当前在哪一页"的那个名字。各写一份迟早对不上 ——
   加了页面只改一处,所以摆在这儿。

   顺序就是导航上的顺序;value 取自下面那份 Page 联合类型 ——
   它同样摆在这儿:"有哪几页"与这份清单本来是同一件事,
   hash 路由的解析也读它一份(见 lib/router.ts)。
   label 是给人看的完整名字:导航里它是悬停提示与读屏名(条目本身只显示图标),
   字标里则直接显示出来。

   Kairo 的定位是超拟人对话,所以只留这四页:对话、角色、历史、设置。
   (KImage 那份里的 Studio 出图工作台、Canvas 画布、Prompt Library 提示词库
    三个页面没有带过来 —— 它们不属于"跟角色说话"这件事) */
export type Page = 'chat' | 'chars' | 'history' | 'settings'

export interface NavItem {
  value: string
  label: string
}

export const NAV_ITEMS: NavItem[] = [
  // 对话第一:这是本站的主体,角色是"跟谁聊",历史是"聊出来的东西"
  { value: 'chat', label: 'Chat' },
  // 角色紧跟对话:两者是同一个对象的两件事,一个造它,一个跟它说话
  { value: 'chars', label: 'Characters' },
  { value: 'history', label: 'History' },
  { value: 'settings', label: 'Settings' }
]
