import { computed, nextTick, ref } from 'vue'
import { CHARACTER_VIEWS, coverSrc, imageSrc } from '../api'
import type {
  Character,
  CharacterStat,
  CharacterView,
  CharacterViewKind,
  CharacterWork
} from '../types'

/* ===== 角色详情与设定图查看器 ==========================================
 *  「这个角色长什么样、出了哪些图」:五格设定图、锁定与"生成中"的判断、
 *  作品墙,以及全屏看大图那一层。
 *
 *  它不管导航(进详情/回列表由页面做:那要顺带收起卡片菜单、还要发事件给主界面),
 *  也不管生成本身 —— 点"生成"只把意图交出去(见 deps.emitGenerate)。
 *
 *  从 CharacterPage 抽出来的第四块(前三块:嗓音、字段规格表、草稿表单)。
 *  依赖全是惰性函数:deps 收到的是 Refs,每次读到的都得是当下的值。
 *  ------------------------------------------------------------------ */

export interface CharacterDetailDeps {
  characters: () => Character[]
  /** 按角色 id 缓存的设定图 */
  views: () => Record<string, CharacterView[]>
  /** 按角色 id 聚合的用量(生成次数 / 最后使用时间) */
  stats: () => Record<string, CharacterStat>
  /** 按角色 id 归拢的作品 */
  works: () => Record<string, CharacterWork[]>
  /** 各角色正在生成哪几张视图(没有键 = 空闲) */
  busy: () => Record<string, CharacterViewKind[]>
  /** 让它生成某一格(请求由主界面发) */
  emitGenerate: (charId: string, kind: CharacterViewKind) => void
}

export function useCharacterDetail(deps: CharacterDetailDeps) {
  const detailId = ref('')
  // 正在全屏看的那张视图(空 = 没在看)
  const viewer = ref<CharacterViewKind | ''>('')
  const detailChar = computed(() => deps.characters().find((c) => c.id === detailId.value))

  function viewOf(charId: string, kind: CharacterViewKind): CharacterView | undefined {
    return deps.views()[charId]?.find((v) => v.kind === kind)
  }

  /* 还没用过的角色:给一个共享的空值,省得每次渲染都造新对象 */
  const NO_STAT: CharacterStat = { count: 0, lastAt: 0 }
  function statOf(id: string): CharacterStat {
    return deps.stats()[id] || NO_STAT
  }

  /** 时间戳的短格式,与历史页同一档:只到分钟,不带年份 */
  function fmtStamp(ts: number) {
    const d = new Date(ts)
    const p = (x: number) => String(x).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /** 只到日的写法:卡片上的"创建 / 最后使用"要的是哪一天,不是几点 */
  function fmtDay(ts: number) {
    const d = new Date(ts)
    const p = (x: number) => String(x).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  /** 特征胶囊:最多三枚 —— 卡片上只放得下这么多,完整的规格表在详情页。
   *  候选多于三枚是有意的:跨场景不变的面貌特征排在前面,后两项兜底 ——
   *  老角色没有 face,靠它们仍能凑出三枚,不会只剩一行空白 */
  function traitsOf(c: Character): string[] {
    const f = c.fields
    if (!f) return []
    return [f.face, f.hair, f.eyes, f.outfit, f.marks]
      .map((s) => (s || '').trim())
      .filter(Boolean)
      .slice(0, 3)
  }

  /** 详情页那一行用量:生成次数 → 创建时间 → 最后使用。
   *  没有的部分不占位 —— 一个刚建的角色只该说"还没用过",不该出现空的"最后使用" */
  const heroMeta = computed(() => {
    const c = detailChar.value
    if (!c) return []
    const s = statOf(c.id)
    const out = [
      s.count ? `${s.count} generations` : 'Not used yet',
      `Created ${fmtStamp(c.createdAt)}`
    ]
    if (s.lastAt) out.push(`Last used ${fmtStamp(s.lastAt)}`)
    return out
  })

  /** 角色卡的封面 = 主视图。生成正脸时会把它写回 c.ref(见 App 的 genCharView),
   *  所以列表上读 ref 就够,不必为每张卡去加载设定图;
   *  ref 空的极少数情况(老数据从没生成过正脸)再退回已经取过的正脸 */
  function coverOf(c: Character): Blob | undefined {
    return c.ref ?? viewOf(c.id, 'front')?.data
  }

  /** 头像优先用正脸:圆形容器裁的是一张脸。没有正脸时才退回封面那张 */
  const avatarSrc = computed(() => {
    const c = detailChar.value
    if (!c) return ''
    return coverSrc(viewOf(c.id, 'front')?.data ?? c.ref)
  })

  /** 设定图网格的五格:修饰词与取景来自 CHARACTER_VIEWS,内容是当前已有的那张 */
  const sheetCells = computed(() =>
    CHARACTER_VIEWS.map((v) => ({ ...v, view: viewOf(detailId.value, v.kind) }))
  )

  const filledCount = computed(() => sheetCells.value.filter((c) => c.view).length)
  const missingCount = computed(() => sheetCells.value.length - filledCount.value)

  /* 这个角色出过的图(主界面按 characterId 归拢好传进来)。
     与上面那张设定图网格是两回事:设定图是参考料,这里是作品 */
  const works = computed(() => deps.works()[detailId.value] || [])
  /* 只摆最近这一批:一个用久了的角色能攒下几百张,全铺出来会把下面的 Spec
     顶到几屏之外。多出来的交给历史页 —— 那里才是"翻全部"的地方 */
  const WORKS_SHOWN = 12
  const worksShown = computed(() => works.value.slice(0, WORKS_SHOWN))
  const worksRest = computed(() => Math.max(0, works.value.length - WORKS_SHOWN))

  /* 网格里用小缩略图:原图是整尺寸的,十几张一起挂上去浏览器会连续做十几次全尺寸解码。
     老记录没有 thumb,那时才退回原图(与历史图墙同一条回退) */
  function workSrc(w: CharacterWork) {
    return w.entry.thumb ? coverSrc(w.entry.thumb) : imageSrc(w.item)
  }

  /** 正脸在不在。其余四张都以它为参考图,所以它是这条流水线的前置 ——
   *  没有它时那四格是"上锁"而不是"可点但会报错"(见 App 的 genCharView 守卫) */
  const hasFront = computed(() => !!viewOf(detailId.value, 'front'))

  /** 这一格现在能不能点。除正脸外的空格子,要先有正脸 ——
   *  与其让它点下去弹一句"先生成正脸",不如直接锁住,把顺序摆在明面上 */
  function isLocked(kind: CharacterViewKind) {
    return kind !== 'front' && !hasFront.value
  }

  /** 主视图只有一个:正面。
   *  其余四张都是"照正面生的派生图",拿它们当主图会把脸串掉 ——
   *  所以这里没有"选"这件事,只有正面在不在(有无即状态,不必再存一个 refKind) */
  function isMainView(kind: CharacterViewKind) {
    return kind === 'front' && !!viewOf(detailId.value, kind)
  }

  /** 某个角色正在生成哪几张视图 */
  function busyKinds(charId: string): CharacterViewKind[] {
    return deps.busy()[charId] || []
  }
  function isBusy(charId: string, kind: string) {
    return busyKinds(charId).includes(kind as CharacterViewKind)
  }
  /* 正脸有没有在跑。它是其余四张的参考图 —— 在重跑正脸的窗口里开始生成别的张,
     那几张拿到的会是上一版正脸,"同一张脸"这个前提就破了。
     所以这个窗口里要停用的只是"非正脸"那些入口;正脸自己不依赖任何视图。
     其余时候几张就该能同时跑:它们之间没有依赖(见 App 的 genCharView),
     整片灰着不让点,顺手把"一次多发几张"这件事也挡掉了 */
  function frontBusy(charId: string) {
    return busyKinds(charId).includes('front')
  }
  /** 这一格(或这个入口)现在要不要停用。不含"还没有正脸"那种锁 —— 那个是 isLocked */
  function viewBlocked(charId: string, kind: CharacterViewKind) {
    return kind !== 'front' && frontBusy(charId)
  }

  /** 详情页这个角色在生成的那几张。文案与进度条只提它自己的 ——
   *  把别的角色的进度报到这一页上,看着就像这一页自己卡住了 */
  const detailBusy = computed(() => busyKinds(detailId.value))
  /** 大图里那个 Regenerate 能不能点:非正面的视图在正脸重跑期间要等一等 */
  const viewerRegenBlocked = computed(() => viewer.value !== 'front' && frontBusy(detailId.value))
  /** 正在生成的这一批叫什么。按钮与进度条上都用它,所以直接给能读的短语;
   *  同时跑几张时不列名字,报个数就够 —— 哪几格在转,网格上一眼看得见 */
  const busyLabel = computed(() => {
    const list = detailBusy.value
    if (list.length === 1) {
      return `${CHARACTER_VIEWS.find((v) => v.kind === list[0])?.label || ''} view`
    }
    return `${list.length} views`
  })

  /* 一次补齐的按钮文案。五张齐了就该停下 —— 原来写成"Generate the rest",
     全部齐了也能点,点了却什么都不发生,看着像坏了 */
  const generateAllLabel = computed(() => {
    if (!missingCount.value) return 'All views ready'
    return viewOf(detailId.value, 'front') ? `Generate ${missingCount.value} more` : 'Generate all views'
  })

  // 大图里能翻的只有"已经有图"的那几张,空位不参与
  const viewerKinds = computed(() =>
    CHARACTER_VIEWS.map((v) => v.kind).filter((k) => viewOf(detailId.value, k))
  )
  const viewerSrc = computed(() => {
    if (!viewer.value) return ''
    const v = viewOf(detailId.value, viewer.value)
    return v ? coverSrc(v.data) : ''
  })
  const viewerLabel = computed(
    () => CHARACTER_VIEWS.find((v) => v.kind === viewer.value)?.label || ''
  )
  /* 翻到第几张 / 共几张。只有一张时不摆 —— "1 / 1" 是废话,
     而且它本来就是为"左右翻"这件事服务的 */
  const viewerPos = computed(() => {
    const list = viewerKinds.value
    return { i: list.indexOf(viewer.value as CharacterViewKind) + 1, n: list.length }
  })

  /* 大图是个模态框:打开时把焦点收进来,关闭时还回原来那张格子 ——
     不还回去的话,键盘用户关掉大图后焦点会掉到 body 上,得从头 Tab 一遍 */
  const viewerBox = ref<HTMLElement | null>(null)
  let restoreFocus: HTMLElement | null = null

  function openViewer(kind: CharacterViewKind) {
    restoreFocus = document.activeElement as HTMLElement | null
    viewer.value = kind
    nextTick(() => viewerBox.value?.focus())
  }
  function closeViewer() {
    viewer.value = ''
    nextTick(() => restoreFocus?.focus())
    restoreFocus = null
  }
  /** 在大图里前后翻。到头就绕回另一头:只有几张图,循环比禁用更好用 */
  function stepViewer(dir: number) {
    const cur = viewer.value
    const list = viewerKinds.value
    if (!cur || list.length < 2) return
    const at = list.indexOf(cur)
    viewer.value = list[(at + dir + list.length) % list.length]
  }

  // 大图上的动作:针对"正在看的那张"。空态直接不发,免得把空串当视图名传下去
  function regenerateViewer() {
    const c = detailChar.value
    if (c && viewer.value) deps.emitGenerate(c.id, viewer.value)
  }

  /** 身份区的副标题:只用"身份"这一句 */
  function heroSub(c: Character) {
    /* 只取"身份"这一项。原来是把 identity · face · hair · eyes · outfit
       五段用 · 连成一行 —— 那读起来是一行字段清单,"这一页像表单"有一半是它给的。
       而这一页该先回答的只有一句"这是谁";其余的字段下面那张规格表里都有,
       在这里再抄一遍只是噪声 */
    return (c.fields?.identity || '').trim()
  }
  return {
    detailId,
    viewer,
    detailChar,
    viewOf,
    statOf,
    fmtStamp,
    fmtDay,
    traitsOf,
    heroMeta,
    coverOf,
    avatarSrc,
    sheetCells,
    filledCount,
    missingCount,
    works,
    worksShown,
    worksRest,
    workSrc,
    hasFront,
    isLocked,
    isMainView,
    busyKinds,
    isBusy,
    frontBusy,
    viewBlocked,
    detailBusy,
    viewerRegenBlocked,
    busyLabel,
    generateAllLabel,
    viewerKinds,
    viewerSrc,
    viewerLabel,
    viewerPos,
    viewerBox,
    openViewer,
    closeViewer,
    stepViewer,
    regenerateViewer,
    heroSub
  }
}
