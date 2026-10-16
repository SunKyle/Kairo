/* 站点的一级页面清单。
   两处要用它:顶部导航(分段控件)把它渲染成五个图标,
   顶部字标取"当前在哪一页"的那个名字。各写一份迟早对不上 ——
   加了页面只改一处,所以摆在这儿。

   顺序就是导航上的顺序;value 取自下面那份 Page 联合类型 ——
   它同样摆在这儿:"有哪几页"与这份清单本来是同一件事,
   hash 路由的解析也读它一份(见 lib/router.ts)。
   label 是给人看的完整名字:导航里它是悬停提示与读屏名(条目本身只显示图标),
   字标里则直接显示出来。

   Kairo 的定位是超拟人对话,所以主体仍是"跟谁聊"这一组:对话、角色、记忆,
   外加产出归档(历史)与设置。KImage 那份里的 Studio 出图工作台、Canvas 画布、
   Prompt Library 提示词库三个页面没有带过来 —— 它们不属于"跟角色说话"这件事。

   **首页(Home)是第一格,它顶掉了对话页当默认落地位** —— `#/` 现在落在首页
   (见 lib/router)。这样做有三个理由:① PRD §5.1 的信息架构里首页排在第一位,
   §11.2 的效果图也把它画成导航第一格;② T7 的验收标准是"一进站能回到上次的
   陪伴",而对话页只能自动挑一个角色,给不了"看见自己这群人"这个视野;
   ③ 角色陪伴产品的落点该是**人**,不是**某一段对话**。
   对话仍是本站的主体,只是不再兼任"门口" —— 首页的「Continue where you
   left off」负责接住"回到上次",而"接着聊"始终只差一次点击。 */
export type Page = 'home' | 'chat' | 'chars' | 'memory' | 'history' | 'settings'

export interface NavItem {
  value: string
  label: string
}

export const NAV_ITEMS: NavItem[] = [
  /* 首页:角色展示为主,最近对话为辅 */
  { value: 'home', label: 'Home' },
  // 对话第一:这是本站的主体,角色是"跟谁聊",历史是"聊出来的东西"
  { value: 'chat', label: 'Chat' },
  // 角色紧跟对话:两者是同一个对象的两件事,一个造它,一个跟它说话
  { value: 'chars', label: 'Characters' },
  /* 记忆排在角色之后、历史之前。
     它不是"又一个管理页",而是这段关系的另一半:**它记得你什么** ——
     用户看不到也管不了的东西,就等于没有(PRD §5.5 记忆中心)。
     所以它紧挨着关系那两页(对话/角色),而不该沉到历史那种"产出归档"里去。 */
  { value: 'memory', label: 'Memory' },
  { value: 'history', label: 'History' },
  { value: 'settings', label: 'Settings' }
]
