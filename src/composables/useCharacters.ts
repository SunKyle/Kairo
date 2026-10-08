import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  CHARACTER_VIEWS,
  FREE_SIZES,
  allowedSizes,
  coverSrc,
  imageSrc,
  coerceCharVoice,
  releaseSrc,
  sizeClosestTo
} from '../api'
import { blobToDataURL, getCharViews, urlToBlob } from '../lib/idb'
import type { Provider } from '../api'
import type {
  Character,
  CharacterStat,
  CharacterView,
  CharacterViewKind,
  CharacterWork,
  HistoryEntry,
  ResultItem
} from '../types'

/* ===== 角色：目录、设定图缓存、以及读取侧的原语 ========================
   一个角色 = 五张设定图 + 一段结构化设定 + 名字 + 一张底图。这里管的是
   「有哪些角色、它们的图在不在手上、以及按视图取一张」这一层。

   写入那一侧(saveCharFromPage / deleteChar / duplicateChar / genCharView /
   导入导出)暂时留在主界面:它们要么跨到对话域(删角色连带删对话、导出带上
   记忆),要么要动出图配置与页面切换 —— 归属还没定清之前先不搬,
   免得把一个域拆成两半还各欠对方几个人情。
   -------------------------------------------------------------------- */

export interface CharacterDeps {
  /** 角色名下的作品与用量都是从历史派生的(见 charStats / charWorks) */
  history: Ref<HistoryEntry[]>
  /** 当前生效的厂商能力:决定设定图能挑哪一档尺寸 */
  provider: ComputedRef<Provider>
  /** 挑不出合适档位时退回的那个尺寸(创作区当前尺寸)。
   *  **传函数而不是 Ref**:那个尺寸由出图参数域提供,而那一域又要用这里的
   *  charRefSrcs —— 传 Ref 会让两个 composable 互相等待对方先声明 */
  coverSize: () => string
  /** 显示级压缩(主界面那份):角色图要给人看,不走"只喂给模型"的那条路 */
  compressImage: (
    dataUrl: string,
    maxEdge?: number,
    quality?: number,
    force?: boolean
  ) => Promise<string>
}

export function useCharacters(deps: CharacterDeps) {
  const characters = ref<Character[]>([])
  const activeCharId = ref('')
  /* 设定图按角色 id 缓存在内存里。启动时不碰这些图:
     5 张 × N 个角色全读进来太重(见 loadCharViews) */
  const charViews = ref<Record<string, CharacterView[]>>({})
  /* 每一格是不是在生成中。必须按"角色 + 视图"分开:
     A 的正脸在跑时切到 B,B 的格子不该跟着显示"生成中" */
  const charViewBusy = ref<Record<string, CharacterViewKind[]>>({})
  /* 中断手柄按 (角色, 视图) 各存一个:每张图要能单独停 */
  const charViewControllers = new Map<string, AbortController>()
  /** 角色页暴露出来的两个回调:向导靠它推进步数 */
  /* openDetail 也在这里:对话页头部的 Details 要从那一侧直接落到某个角色的详情,
     而这个 ref 是主界面够得着角色页的唯一入口 */
  const charPageRef = ref<{
    onSaved: (id: string) => void
    onUpdated: (id: string) => void
    openDetail: (id: string) => void
  } | null>(
    null
  )

  function charViewKey(charId: string, kind: CharacterViewKind) {
    return `${charId}:${kind}`
  }

  const activeCharacter = computed(() =>
    characters.value.find((c) => c.id === activeCharId.value)
  )
  /* 当前角色的头像。角色可能只有设定没有参考图,那时返回空串,界面上退回图标 */
  const activeCharSrc = computed(() => coverSrc(activeCharacter.value?.ref))

  const charStats = computed<Record<string, CharacterStat>>(() => {
    const m: Record<string, CharacterStat> = {}
    for (const h of deps.history.value) {
      const id = h.characterId
      if (!id) continue
      const s = m[id] || (m[id] = { count: 0, lastAt: 0 })
      s.count += 1
      if (h.createdAt > s.lastAt) s.lastAt = h.createdAt
    }
    return m
  })

  /* 每个角色名下的作品:历史里带 characterId 的那些图,按记录顺序(新的在前)。
     与上面的 stats 同一趟口径、同一个出处 —— 角色页上"12 images"和它下面
     那排图是同一份数据,不会出现数字说有 12 张、点开只找到 3 张 */
  const charWorks = computed<Record<string, CharacterWork[]>>(() => {
    const m: Record<string, CharacterWork[]> = {}
    for (const h of deps.history.value) {
      const id = h.characterId
      if (!id) continue
      const list = m[id] || (m[id] = [])
      h.results.forEach((item, index) =>
        list.push({ key: `${h.id}:${index}`, entry: h, index, item })
      )
    }
    return m
  })

  /** 读回来的角色逐条规整(老数据缺字段、被同步工具截断过) */
  function normalizeChar(c: Character): Character {
    const legacySource = c.refKind ? undefined : c.ref
    if (c.refKind && c.refKind !== 'front') delete c.refKind
    if (!c.sourceRef && legacySource) c.sourceRef = legacySource
    /* 嗓音逐项收一遍:它是从 localStorage 读回来的,可能被手改过、
       也可能来自更早的版本 —— 形状不对时整个退回"浏览器语音",
       而不是让一个残缺的对象一路走到合成请求里 */
    c.voice = coerceCharVoice(c.voice)
    return c
  }

  /** 卸下当前角色 */
  function detachCharacter() {
    activeCharId.value = ''
  }

  /** 选中/取消一个角色卡:再点当前这个即取消。
   *  只动 activeCharId,不碰参考图槽 —— 角色和参考图是两个独立的输入,
   *  角色那几张图在发请求时才并进去(见 charRefSrcs) */
  function toggleChar(id: string) {
    activeCharId.value = activeCharId.value === id ? '' : id
  }

  function viewOf(charId: string, kind: CharacterViewKind): CharacterView | undefined {
    return charViews.value[charId]?.find((v) => v.kind === kind)
  }

  /* 竖幅的目标比例。全身像用 2:3:站姿人形只有竖框装得下,
     9:16 会把人大幅缩小、面料与配饰的细节跟着丢,3:4 又偏紧、容易切到脚 */
  const PORTRAIT_RATIO = 2 / 3

  /* 取景 → 实际尺寸。比例是按视图写死的(见 api.ts 的 framing),
     但像素值写不死 —— 各厂商只认自己那几档,所以这里挑最接近那个比例的。
     厂商不限尺寸时用应用自己那组常用值(FREE_SIZES 里有 1024x1792 这一档竖幅)。
     刻意不沿用创作区当前尺寸 —— 那可能是个宽幅,拿来当全身图的画框会得到一张
     横过来的人;只在挑不出任何一档时才退回它 */
  function viewSize(framing: 'square' | 'portrait'): string {
    const allowed = allowedSizes(deps.provider.value.id, deps.provider.value.model)
    const want = framing === 'square' ? 1 : PORTRAIT_RATIO
    /* 挑最接近的一档。这里原先自己算了一遍(abs(w/h - want)),而编辑那条路
       用的是对数距离(见 api.ts 的 sizeClosestTo)—— 同一件事两套度量。
       统一走那一个:对数距离才是比例该有的比法 */
    const best = sizeClosestTo(allowed === 'free' ? FREE_SIZES : allowed, want)
    return best || deps.coverSize()
  }

  /* —— 角色身上的图 ——
     角色有两处图:ref(卡面与头像)与 5 张设定图。它们和 record.ref 的用处不同 ——
     后者只是"当时用了哪张参考图"的复现凭据,只喂给模型,压到最长边 512 就够
     (见 refThumbOf);而角色这两处是要给人看的:角色卡封面、详情页头像、
     以及全屏查看器里能铺到 600px 宽 —— 2× 屏就是 1200px。
     512 一到那个尺寸一眼就糊,所以这条路按显示级编:最长边 1280、JPEG q0.88。
     1280 是照着全屏查看器定的(600 CSS px × 2),再大对观感没有增益,
     只是让一套 6 张图多占几 MB */
  const CHAR_IMAGE_MAX = 1280

  async function charImageBlob(src: string): Promise<Blob | undefined> {
    if (!src) return undefined
    try {
      /* 先把字节抓回来再转 data URL:src 可能是上游回的外链,
         直接塞进 <img> 会让 canvas 被跨域污染,toDataURL 直接抛错 */
      const raw = await blobToDataURL(await urlToBlob(src))
      /* force 重编码:模型给的多半是 PNG,原样留下就是 1MB 上下 ——
         一套六张图好几 MB,画质上却看不出多出来的好处 */
      const out = await deps.compressImage(raw, CHAR_IMAGE_MAX, 0.88, true)
      const blob = await urlToBlob(out)
      return blob.type.startsWith('image/') ? blob : undefined
    } catch {
      return undefined
    }
  }

  /** 一张生成结果 → 落进角色设定图的 Blob(显示级,见上面 CHAR_IMAGE_MAX) */
  async function resultRefBlob(item: ResultItem | undefined): Promise<Blob | undefined> {
    if (!item) return undefined
    return charImageBlob(imageSrc(item))
  }

  /** 复制一份 Blob —— 结构化克隆进库时用,顺带把类型带上 */
  function reBlob(b: Blob): Blob {
    return new Blob([b], { type: b.type })
  }

  const MAX_CHAR_REFS = 4

  /** 当前角色的图 → data URL,发请求时并进参考图。
   *  角色不占表单里的参考图槽 —— 表单上看到的始终是用户自己挑的那张,
   *  角色这几张只在这一刻合进来。
   *  上传的那张底图不在这里:它只为生成正脸服务一次(见 genCharView),
   *  那之后 c.ref 里存的已经是正脸本身,再送一次就是把同一张图送两遍 */
  /** 某个角色的图 → data URL。**按 id 取,不认"当前选中"** ——
   *  对话页可能正跟另一个角色说话,拿创作区那个角色的脸去画,
   *  画出来当然不像(这是实测反馈里最要紧的一条)。
   *
   *  @param order 视图的取舍顺序。**对话出图按镜头与景别传**(见 lib/chatPhoto 的
   *               shotViewOrder):自拍以正面为主,全身像那张打头才交代得住
   *               体型与服装轮廓,而特写那一档反过来把全身像摘掉。
   *               从前这里写死"正面永远排最前",于是拍全身也拿一张头像当主
   *               参考图 —— 身高体型全靠模型现编。
   *               不传 = 保持原顺序(创作区那条路照旧) */
  async function charRefSrcsOf(charId: string, order: string[] = []): Promise<string[]> {
    const c = characters.value.find((x) => x.id === charId)
    if (!c) return []
    // 视图是按需加载的,这里先确保取过一次
    await loadCharViews(c.id)
    /* 认不出的视图名直接跳过:它指的那张不存在,而这里每 push 一张都要
       读一次 IndexedDB、转一次 data URL —— 不认识的键就是白读一次 */
    const wanted = order.length
      ? Array.from(new Set(order)).filter((k) => CHARACTER_VIEWS.some((v) => v.kind === k))
      : CHARACTER_VIEWS.map((v) => v.kind as string)
    const out: string[] = []
    for (const kind of wanted) {
      if (out.length >= MAX_CHAR_REFS) break
      const view = viewOf(c.id, kind as CharacterViewKind)
      if (view) out.push(await blobToDataURL(view.data))
    }
    return out
  }

  /** 创作区当前选中的那个角色(出图面板用)。
   *  order 由调用方给:创作区那条路不传,保持"正面打头"的原顺序 */
  async function charRefSrcs(order: string[] = []): Promise<string[]> {
    return activeCharId.value ? charRefSrcsOf(activeCharId.value, order) : []
  }

  function stopCharView(charId: string, kind: CharacterViewKind) {
    charViewControllers.get(charViewKey(charId, kind))?.abort()
  }

  /* 取出某个角色的设定图并缓存。已经取过就不再读 IndexedDB ——
     启动时不碰这些图,5 张 × N 个角色全读进来太重 */
  /* 正在路上的读取。同一个 id 可能被两处同时触发(创作区选中角色时的 watch,
     与角色页的 @open),读两遍 IndexedDB 是白费 */
  const charViewsLoading = new Map<string, Promise<void>>()
  async function loadCharViews(id: string) {
    if (!id || charViews.value[id]) return
    const inflight = charViewsLoading.get(id)
    if (inflight) return inflight
    const task = (async () => {
      try {
        const rows = await getCharViews(id)
        /* 回来时如果这个角色的图已经有了,就别拿这份快照盖上去:
           期间多半刚生成完一张,库里那次写入是后发生的,却不一定被这次读看到 ——
           盖上去的结果是刚出的图从网格上消失,刷新才回来 */
        if (charViews.value[id]) return
        const known = new Set<string>(CHARACTER_VIEWS.map((v) => v.kind))
        /* 存储层只知道"有个 kind 字符串",这里按已知视图清单收窄 ——
           万一库里留着旧版写下的未知 kind,不该让它混进网格 */
        charViews.value = {
          ...charViews.value,
          [id]: rows
            .filter((r) => known.has(r.kind))
            .map((r) => ({ kind: r.kind as CharacterViewKind, data: r.data }))
        }
      } finally {
        charViewsLoading.delete(id)
      }
    })()
    charViewsLoading.set(id, task)
    return task
  }

  /** 另一页改了某个角色的设定图:丢掉缓存重读一次
   *  (缓存那一格本身就是"已加载过"的标记,不丢的话 loader 直接返回) */
  async function reloadCharViewsFromDb(id: string) {
    const before = charViews.value[id]
    // 旧的 Blob 不再有界面引用:把它们的 object URL 放掉,否则字节回收不了
    if (before) for (const v of before) releaseSrc(v.data)
    const rest = { ...charViews.value }
    delete rest[id]
    charViews.value = rest
    /* 角色本身没了的(删角色):不再去读,留个空格就行 ——
       读它会返回空数组,反而在内存里留一个"加载过"的假标记 */
    if (!characters.value.some((c) => c.id === id)) return
    await loadCharViews(id)
  }

  return {
    characters,
    activeCharId,
    charViews,
    charViewBusy,
    charViewControllers,
    charPageRef,
    charViewKey,
    activeCharacter,
    activeCharSrc,
    charStats,
    charWorks,
    normalizeChar,
    detachCharacter,
    toggleChar,
    viewOf,
    viewSize,
    CHAR_IMAGE_MAX,
    charImageBlob,
    resultRefBlob,
    reBlob,
    MAX_CHAR_REFS,
    charRefSrcs,
    charRefSrcsOf,
    stopCharView,
    loadCharViews,
    reloadCharViewsFromDb
  }
}
