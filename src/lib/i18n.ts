/* ===== 界面国际化(不是数据) ==========================================
   这一层管"界面上的字用哪种语言显示",与 lib/theme.ts 是同一类东西 ——
   都是这台设备上这个人的界面偏好,不碰任何目录数据。整套照 theme 那一份的口径来:

   - **存档优先、否则跟随系统**:用户手动选过就固定,没选过才读浏览器语言
     (见 currentLocale)。与主题"用户没手动设过时才跟系统"是同一条优先级。
   - **所有函数都不抛异常**:localStorage / navigator / document 在 Safari 无痕、
     禁用 Cookie、sandbox iframe 等场景都可能直接抛,而调用点就在挂载路径上,
     漏出去整个应用就不渲染了。语言失败最多是文案没换,不该挡住渲染。
   - **不跨标签页同步**:与 kimage.theme 同一条理由 —— 别人切了语言跟着变反而突兀。
     (所以新键在 lib/crossTab.test.ts 里登记进 KNOWN 的非同步白名单,synced:false)

   —— 为什么自研而不引 vue-i18n ——

   本站刻意不装 Pinia、路由是自己写的(见 lib/router.ts)。i18n 这里要的能力其实很窄:
   一个响应式的"当前语言" + 一个按 key 查表、缺词能回落的 t()。自己写几十行就够,
   还能把"中英两份键必须一致"钉成一条 vitest 不变量(见 i18n.test.ts)——
   引库反而要动 main.ts 装插件、把体积和心智负担带进来。

   —— 英文是事实来源 ——

   en 词典是英文展示串的唯一出处:组件里不再散着写英文,一律 t('key')。
   zh 缺某个键时 t() 自动回落到 en,所以"某个中文词还没补"会显示英文而不是空白 ——
   加界面时先补 en、再补 zh,i18n.test.ts 的键一致断言会提醒你别漏了中文。 */

import { ref, type Ref } from 'vue'

export type Locale = 'en' | 'zh'

const LOCALE_KEY = 'kimage.locale'

/* ===== 语言包 ==========================================================
   扁平的点分键,按界面分区加前缀。两份键必须逐一对齐(i18n.test.ts 守这条)。 */

export const EN: Record<string, string> = {
  // —— 顶部导航(lib/nav 的清单 + 字标) ——
  'nav.home': 'Home',
  'nav.chat': 'Chat',
  'nav.chars': 'Characters',
  'nav.memory': 'Memory',
  'nav.history': 'History',
  'nav.settings': 'Settings',
  'nav.main': 'Main navigation',

  // —— 顶栏主题按钮 ——
  'topbar.toLight': 'Switch to light',
  'topbar.toDark': 'Switch to dark',

  // —— 设置页骨架与分区导航(lib/settingsNav 的清单) ——
  'settings.aria': 'Settings',
  'settings.railAria': 'Settings sections',
  'settings.appearance.label': 'Appearance',
  'settings.appearance.hint': 'Theme and how Chat looks.',
  'settings.interaction.label': 'Getting along',
  'settings.interaction.hint': 'How each character treats you in Chat. Per character.',
  'settings.photos.label': 'Photos',
  'settings.photos.hint': 'How often they send pictures, and how each one gets planned.',
  'settings.memory.label': 'Memory & privacy',
  'settings.memory.hint': 'What it knows about you, and what stays private.',
  'settings.api.label': 'AI connections',
  'settings.api.hint': 'The models Kairo talks to, draws with and speaks through.',

  // —— 外观分区(设置页 Appearance 面板) ——
  'appearance.title': 'Appearance',
  'appearance.note': 'How Kairo looks on this device. Nothing here changes your data.',
  'appearance.theme': 'Theme',
  'appearance.themeHint': 'Follows your system setting until you pick one here.',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.chat': 'Chat',
  'appearance.chatHint':
    'Immersive hides the header and lets the conversation fill the screen. You can still leave it from inside Chat.',
  'appearance.regular': 'Regular',
  'appearance.immersive': 'Immersive',
  'appearance.chatAria': 'Chat layout',
  'appearance.language': 'Language',
  'appearance.languageHint': 'Interface language. Follows your system setting until you pick one here.',
  'appearance.english': 'English',
  'appearance.chinese': '中文',

  // —— 首页(T7) ——
  'home.aria': 'Home',
  'home.title': 'Your characters',
  'home.countOne': '{n} character',
  'home.countMany': '{n} characters',
  'home.empty': 'Nothing here yet',
  'home.new': 'New character',
  'home.emptyTitle': 'No characters yet',
  'home.emptySub':
    "Describe someone you'd like to meet, or upload a reference image — Kairo fills in the rest and draws them for you.",
  'home.createFirst': 'Create your first character',
  'home.cardChat': 'Chat',
  'home.cardDetails': 'Details',
  'home.recentTitle': 'Continue where you left off',

  // —— 对话页(左栏) ——
  'chat.railAria': 'Characters',
  'chat.searchPh': 'Search conversations…',
  'chat.searchAria': 'Search conversations',
  'chat.searchClear': 'Clear search',
  'chat.railPinned': 'Pinned',
  'chat.railConversations': 'Conversations',
  'chat.railNone': 'No conversation matches that. Try a name, or a word from what they said.',
  'chat.railEmpty': 'No characters yet.',
  'chat.railPin': 'Pin',
  'chat.railUnpin': 'Unpin',
  // —— 对话页(空态) ——
  'chat.emptyNoChars': 'Create a character first',
  'chat.emptyNoCharsSub': 'Characters are who you talk to here.',
  'chat.goChars': 'Go to Characters',
  'chat.emptyPick': 'Pick someone to talk to',
  'chat.emptyPickSub': 'Any character on the left — each one keeps its own conversation.',
  'chat.pickCharacter': 'Choose a character',
  'chat.saySomething': 'Say something to {name}',
  'chat.sayStarting': 'Starting…',
  'chat.sayVoice': "Every reply is written in {name}’s own voice.",
  'chat.addPersona': 'Add a personality to {name}',
  'chat.loadEarlier': 'Load earlier messages',
  // —— 对话页(⋮ 菜单与头部) ——
  'chat.menuOptions': 'Conversation options',
  'chat.openInChars': 'Open in Characters',
  'chat.newBg': 'New background',
  'chat.drawingBg': 'Drawing the background…',
  'chat.innerLife': 'Inner life',
  'chat.roleplay': 'Roleplay a scene',
  'chat.showThink': 'Show inner thoughts',
  'chat.showAct': 'Show actions',
  'chat.clearConv': 'Clear conversation',
  'chat.leaveImmersive': 'Leave immersive mode',
  'chat.enterImmersive': 'Immersive mode',
  // —— 对话页(消息级动作) ——
  'chat.openAttach': 'Open attached image',
  'chat.attachCaption': 'Attached image',
  'chat.readAloud': 'Read {name}’s reply out loud',
  'chat.stopReading': 'Stop reading this out loud',
  'chat.cancelReading': 'Cancel reading',
  'chat.delYours': 'Delete your message',
  'chat.delReply': 'Delete this reply from {name}',
  'chat.regenerate': 'Regenerate',
  'chat.tryAgain': 'Try again',
  'chat.openPhoto': 'Open the photo from {name}',
  'chat.photoCaption': 'Photo from the character',
  'chat.redrawPhoto': 'Draw this photo again',
  'chat.redrawPhotoName': 'Draw {name}’s photo again',
  'chat.photoFailed': 'Couldn’t generate that image.',
  'chat.retryImage': 'Try generating {name}’s image again',
  'chat.truncated': 'Cut off at the length limit',
  'chat.dayToday': 'Today',
  'chat.dayYesterday': 'Yesterday',
  // —— 对话页(输入区) ——
  'chat.jumpLatest': 'Latest',
  'chat.jumpNew': '{n} new',
  'chat.inputPh': 'Say something to {name}',
  'chat.inputAria': 'Message {name}',
  'chat.attachImage': 'Attach an image',
  'chat.insertEmoji': 'Insert an emoji',
  'chat.emojiDialog': 'Emoji',
  'chat.insertEmojiOne': 'Insert {emoji}',
  'chat.removeImage': 'Remove the image',
  'chat.attachPreview': 'Attachment preview',
  'chat.tooLong': 'That message is over {n} characters. Trim it before sending.',
  'chat.send': 'Send',
  'chat.stop': 'Stop',
  // —— 对话页(模型缺口提示 · 沿用站内系统层词表) ——
  'chat.offNoConfig': 'Add a Role chat model in AI connections to start talking.',
  'chat.offNoConfigBtn': 'Add a Role chat model',
  'chat.offMissing': '{name} is missing its {field} — fix it in AI connections to start talking.',
  'chat.offMissingBtn': 'Set the {field}',
  'chat.modelNone': 'No model',
  'chat.modelUntitled': 'Untitled config',
  'chat.fieldModelName': 'model name',
  'chat.fieldBaseUrl': 'Base URL',
  'chat.chipNone': 'No Role chat model yet — add one in AI connections',
  'chat.chipMissing': '{name} is missing its {field} — click to fix it in AI connections',
  'chat.chipBorrowed': 'Using the Prompt enhancing model ({name}) — click to add a dedicated one',
  'chat.chipChange': '{name} — click to change it in AI connections',
  'chat.noteMissing': 'missing its {field}',
  'chat.noteBorrowed': 'Borrowed',
  // —— 对话页(读屏归属那半句 · 屏幕外,只给读屏) ——
  'chat.srYouSaid': 'You said:',
  'chat.srThought': '{who} thought (not spoken):',
  'chat.srDid': '{who} did (narration):',
  'chat.srSaid': '{who} said:',
  'chat.srThey': 'They',
  'chat.zoomAria': 'Image preview',
  'chat.zoomClose': 'Close'
}

export const ZH: Record<string, string> = {
  // —— 顶部导航 ——
  'nav.home': '首页',
  'nav.chat': '对话',
  'nav.chars': '角色',
  'nav.memory': '记忆',
  'nav.history': '历史',
  'nav.settings': '设置',
  'nav.main': '主导航',

  // —— 顶栏主题按钮 ——
  'topbar.toLight': '切换到浅色',
  'topbar.toDark': '切换到深色',

  // —— 设置页骨架与分区导航 ——
  'settings.aria': '设置',
  'settings.railAria': '设置分区',
  'settings.appearance.label': '外观',
  'settings.appearance.hint': '主题与对话页的样子。',
  'settings.interaction.label': '相处',
  'settings.interaction.hint': '每个角色在对话里怎么待你,按角色分别设置。',
  'settings.photos.label': '出图',
  'settings.photos.hint': '他们多久发一次图,以及每张图怎么构思。',
  'settings.memory.label': '记忆与隐私',
  'settings.memory.hint': '它记得你什么,以及哪些保持私密。',
  'settings.api.label': 'AI 连接',
  'settings.api.hint': 'Kairo 用来对话、绘图、发声的那些模型。',

  // —— 外观分区 ——
  'appearance.title': '外观',
  'appearance.note': 'Kairo 在这台设备上长什么样。这里改什么都不动你的数据。',
  'appearance.theme': '主题',
  'appearance.themeHint': '在你没手动选之前,跟随系统设置。',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.chat': '对话',
  'appearance.chatHint': '沉浸模式会藏起顶栏,让对话铺满整屏。你仍可以在对话里退出它。',
  'appearance.regular': '常规',
  'appearance.immersive': '沉浸',
  'appearance.chatAria': '对话布局',
  'appearance.language': '语言',
  'appearance.languageHint': '界面语言。在你没手动选之前,跟随系统设置。',
  'appearance.english': 'English',
  'appearance.chinese': '中文',

  // —— 首页 ——
  'home.aria': '首页',
  'home.title': '你的角色',
  'home.countOne': '{n} 个角色',
  'home.countMany': '{n} 个角色',
  'home.empty': '这里还空着',
  'home.new': '新建角色',
  'home.emptyTitle': '还没有角色',
  'home.emptySub': '描述一个你想认识的人,或上传一张参考图 —— Kairo 会补齐设定并把他画出来。',
  'home.createFirst': '创建你的第一个角色',
  'home.cardChat': '开聊',
  'home.cardDetails': '详情',
  'home.recentTitle': '回到上次聊过的地方',

  // —— 对话页(左栏) ——
  'chat.railAria': '角色',
  'chat.searchPh': '搜索对话…',
  'chat.searchAria': '搜索对话',
  'chat.searchClear': '清除搜索',
  'chat.railPinned': '置顶',
  'chat.railConversations': '对话',
  'chat.railNone': '没有匹配的对话。试试输入名字，或对方说过的某个词。',
  'chat.railEmpty': '还没有角色。',
  'chat.railPin': '置顶',
  'chat.railUnpin': '取消置顶',
  // —— 对话页(空态) ——
  'chat.emptyNoChars': '先创建一个角色',
  'chat.emptyNoCharsSub': '角色就是你在对话里聊的那个人。',
  'chat.goChars': '去角色页',
  'chat.emptyPick': '选个人来聊',
  'chat.emptyPickSub': '左边任意一个角色 —— 每个各自保留一段对话。',
  'chat.pickCharacter': '选择角色',
  'chat.saySomething': '跟 {name} 说点什么',
  'chat.sayStarting': '开始中…',
  'chat.sayVoice': '每条回复都用 {name} 自己的口吻写。',
  'chat.addPersona': '给 {name} 加点个性',
  'chat.loadEarlier': '加载更早的消息',
  // —— 对话页(⋮ 菜单与头部) ——
  'chat.menuOptions': '对话选项',
  'chat.openInChars': '在角色页打开',
  'chat.newBg': '换一张背景',
  'chat.drawingBg': '正在画背景…',
  'chat.innerLife': '内心戏',
  'chat.roleplay': '演一场场景',
  'chat.showThink': '显示内心想法',
  'chat.showAct': '显示动作',
  'chat.clearConv': '清空这段对话',
  'chat.leaveImmersive': '退出沉浸模式',
  'chat.enterImmersive': '沉浸模式',
  // —— 对话页(消息级动作) ——
  'chat.openAttach': '打开附上的图',
  'chat.attachCaption': '附上的图片',
  'chat.readAloud': '朗读 {name} 的回复',
  'chat.stopReading': '停止朗读',
  'chat.cancelReading': '取消朗读',
  'chat.delYours': '删除你的消息',
  'chat.delReply': '删除 {name} 的这条回复',
  'chat.regenerate': '重新生成',
  'chat.tryAgain': '重试',
  'chat.openPhoto': '打开 {name} 发来的图',
  'chat.photoCaption': '角色发来的照片',
  'chat.redrawPhoto': '重新画这张图',
  'chat.redrawPhotoName': '重画 {name} 的这张图',
  'chat.photoFailed': '那张图没能生成。',
  'chat.retryImage': '再试一次生成 {name} 的图',
  'chat.truncated': '因长度上限被截断',
  'chat.dayToday': '今天',
  'chat.dayYesterday': '昨天',
  // —— 对话页(输入区) ——
  'chat.jumpLatest': '最新',
  'chat.jumpNew': '{n} 条新消息',
  'chat.inputPh': '跟 {name} 说点什么',
  'chat.inputAria': '给 {name} 发消息',
  'chat.attachImage': '附上图片',
  'chat.insertEmoji': '插入表情',
  'chat.emojiDialog': '表情',
  'chat.insertEmojiOne': '插入 {emoji}',
  'chat.removeImage': '移除这张图',
  'chat.attachPreview': '附件预览',
  'chat.tooLong': '这条超过 {n} 字了，发之前删减一下。',
  'chat.send': '发送',
  'chat.stop': '停止',
  // —— 对话页(模型缺口提示 · 沿用站内系统层词表) ——
  'chat.offNoConfig': '在 AI 连接里添加一个「角色对话」模型，才能开始对话。',
  'chat.offNoConfigBtn': '添加角色对话模型',
  'chat.offMissing': '{name} 缺了{field}——去 AI 连接补上才能开始对话。',
  'chat.offMissingBtn': '设置{field}',
  'chat.modelNone': '没有模型',
  'chat.modelUntitled': '未命名配置',
  'chat.fieldModelName': '模型名',
  'chat.fieldBaseUrl': 'Base URL',
  'chat.chipNone': '还没有「角色对话」模型——去 AI 连接加一个',
  'chat.chipMissing': '{name} 缺了{field}——点击去 AI 连接修复',
  'chat.chipBorrowed': '正在借用「提示词增强」模型（{name}）——点击添加一个专用的',
  'chat.chipChange': '{name}——点击去 AI 连接更换',
  'chat.noteMissing': '缺了{field}',
  'chat.noteBorrowed': '借用中',
  // —— 对话页(读屏归属那半句) ——
  'chat.srYouSaid': '你说：',
  'chat.srThought': '{who} 想（没说出口）：',
  'chat.srDid': '{who} 做（旁白）：',
  'chat.srSaid': '{who} 说：',
  'chat.srThey': 'TA',
  'chat.zoomAria': '图片预览',
  'chat.zoomClose': '关闭'
}

/* ===== 当前语言(响应式的唯一真相) ====================================
   模块级 ref 就是一个进程内单例:各组件 import t / locale 后共享同一份。
   初值按 currentLocale() 从存档/系统算出来 —— 即便 Vite HMR 把模块重载,
   也是重新读同一份存档,不会丢状态(存档在 localStorage,不在内存)。 */
export const locale: Ref<Locale> = ref(currentLocale())

/* ===== 存取与判定 ==================================================== */

/** 用户手动选过的语言。没设过(或被禁了存取)返回 null,由调用方回落系统 */
export function savedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_KEY)
    return v === 'en' || v === 'zh' ? v : null
  } catch {
    return null
  }
}

/** 浏览器语言:以 zh 开头(简体/繁体/区域变体)算中文,其余一律英文 */
function systemLocale(): Locale {
  try {
    const lang = (navigator.language || '').toLowerCase()
    return lang.startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

/** 现在该用哪种语言:用户手动选的优先,否则跟随系统 */
export function currentLocale(): Locale {
  return savedLocale() ?? systemLocale()
}

/** 写进 <html lang>,供读屏与浏览器排版识别。失败不影响切换 */
export function applyLocale(l: Locale): void {
  try {
    document.documentElement.setAttribute('lang', l === 'zh' ? 'zh-CN' : 'en')
  } catch {
    /* ignore */
  }
}

/** 记下选择。存不下就只在本次会话生效,不打断切换 */
export function saveLocale(l: Locale): void {
  try {
    localStorage.setItem(LOCALE_KEY, l)
  } catch {
    /* ignore */
  }
}

/** 设定某一档。**外观页那个分段开关是唯一的切换入口**,落盘、套用都收在这一个地方
 *  (两份写法迟早分叉)。与 theme 的 setTheme 同一条:同一个值就直接返回。 */
export function setLocale(l: Locale): void {
  if (locale.value === l) return
  locale.value = l
  applyLocale(l)
  saveLocale(l)
}

/* ===== 翻译 ======================================================== */

/**
 * 按 key 取当前语言的文案。
 *
 * - 读 locale.value,所以在模板里调用会把"当前语言"登记成依赖 —— 一切语言整页重渲染。
 * - 缺词先回落英文,再回落键名本身(绝不返回 undefined 让界面塌成空白)。
 * - params 做 {name} 占位替换,用于带数字/名字的串(如 "{n} characters")。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = locale.value === 'zh' ? ZH : EN
  let s = dict[key] ?? EN[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v))
    }
  }
  return s
}
