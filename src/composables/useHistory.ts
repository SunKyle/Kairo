import { computed, ref, toRaw, watch, type Ref } from 'vue'
import {
  addHistoryRecord,
  backfillThumbs,
  loadCollections,
  loadHistory,
  mergeHistory,
  removeHistoryRecord,
  saveCollections,
  saveHistoryRecord,
  releaseEntryMedia,
  uid
} from '../api'
import type { Collection, HistoryEntry, ResultItem } from '../types'

/* ===== 历史 / 作品集 ================================================
   两份"目录"放在一起,因为它们共用同一套东西:
   - 删除都走撤销窗口(见 useFeedback 的 scheduleUndo)
   - 落盘之后都要广播给别的标签页(announce)
   - 图都是 Blob,离开界面时要释放 object URL(否则字节回收不了)

   历史本身不落 localStorage:记录在 IndexedDB 里,这里只持有内存副本。
   作品集目录是轻量的(localStorage),但调用方不必关心这个差别。
   -------------------------------------------------------------------- */

export interface HistoryDeps {
  /** 告诉其他标签页"这一类变了"(见 lib/crossTab.ts) */
  announce: (kind: 'history' | 'library', charId?: string) => void
  /** 删除的后悔药(见 useFeedback) */
  scheduleUndo: (item: { label: string; undo: () => void; purge: () => void }) => void
  /** 中性提示通道:存储清理、落盘失败都走它 */
  notice: Ref<string>
}

export function useHistory(deps: HistoryDeps) {
  const history = ref<HistoryEntry[]>([])
  // 作品集目录(只有标题 + id)。归属关系挂在记录上,这里只存目录
  const collections = ref<Collection[]>([])

  /* 正在写盘的那些记录 id。重读历史时要靠它区分两种情况:
     库里没有是"别的标签页删了它"(丢掉)还是"本页刚写、还没落地"(保住) */
  const writingIds = new Set<string>()

  // —— 历史图墙(输入框下方,可收起) ——
  const feedOpen = ref(true)
  const FEED_LIMIT = 12
  // 老记录没有 w/h,图片加载完再按真实像素补一下比例(与历史页同一个思路)。key 同 feedItems
  const measured = ref<Record<string, number>>({})
  /* 记录被删掉、或被存储清理淘汰之后,它量出来的比例跟着没用了 ——
     键只增不减会一直挂在内存里(与历史页同一处理) */
  watch(history, (list) => {
    const alive = new Set<string>()
    for (const e of list) for (let i = 0; i < e.results.length; i++) alive.add(`${e.id}-${i}`)
    const next: Record<string, number> = {}
    let dropped = false
    for (const k of Object.keys(measured.value)) {
      if (alive.has(k)) next[k] = measured.value[k]
      else dropped = true
    }
    if (dropped) measured.value = next
  })

  // 把历史记录里的多张图摊平成图墙,最新的排在最前
  const feedItems = computed(() => {
    const out: Array<{ key: string; entry: HistoryEntry; item: ResultItem; ratio: number }> = []
    for (const entry of history.value) {
      for (let i = 0; i < entry.results.length; i++) {
        if (out.length >= FEED_LIMIT) return out
        const key = `${entry.id}-${i}`
        out.push({ key, entry, item: entry.results[i], ratio: feedRatio(entry, key) })
      }
    }
    return out
  })
  // 缩略块按图片真实比例排:量到的真实比例 → 入库记的 w/h → 解析所选尺寸 → 方形兜底
  function feedRatio(entry: HistoryEntry, key: string) {
    const m = measured.value[key]
    if (m) return m
    if (entry.w && entry.h) return Math.min(2, Math.max(0.5, entry.w / entry.h))
    return tileRatio(entry.size)
  }
  // 按记录尺寸算宽高比(生成中的骨架仍按所选尺寸,不用真实比例)
  function tileRatio(size: string) {
    const [w, h] = size.split('x').map(Number)
    if (!w || !h) return 1
    return Math.min(2, Math.max(0.5, w / h))
  }
  // 图墙里没有 w/h 的老记录:图加载完切到真实比例,避免按所选尺寸裁掉一截
  function onFeedLoad(key: string, entry: HistoryEntry, e: Event) {
    if (measured.value[key] || (entry.w && entry.h)) return
    const img = e.target as HTMLImageElement
    if (!img.naturalWidth || !img.naturalHeight) return
    measured.value[key] = Math.min(2, Math.max(0.5, img.naturalWidth / img.naturalHeight))
  }

  /** 启动时读一次历史,并让缩略图在空闲时慢慢补齐 */
  async function initHistory() {
    const list = await loadHistory()
    history.value = list
    // 老记录没有列表缩略图,后台慢慢补;不 await,免得拖慢首屏
    void backfillThumbs(list)
  }

  /* 一条记录:入内存 + 落盘。裁剪与落盘失败的处置只有这一处,
     生成与对比出图的每条结果都走它 */
  async function persist(record: HistoryEntry) {
    history.value = [record, ...history.value]
    /* 记下"正在写"的那个 id:另一页的广播可能在这一笔落地之前到达,
       重读历史时靠它保住这一条(见 api.ts 的 mergeHistory) */
    writingIds.add(record.id)
    try {
      const pruned = await addHistoryRecord(record)
      // 别的标签页也要知道:它们的内存里没有这一条
      deps.announce('history')
      if (pruned) {
        // 磁盘上已经删掉了,内存里也要同步,否则界面还留着早已不存在的记录
        const goneIds = new Set(pruned.removedIds)
        const gone = history.value.filter((h) => goneIds.has(h.id))
        history.value = history.value.filter((h) => !goneIds.has(h.id))
        // 这些图不会再展示了,顺带把 object URL 撤掉,让 Blob 能被回收
        gone.forEach(releaseEntryMedia)
        const pct = Math.round(pruned.usageRatio * 100)
        /* 标记过的记录不参与自动清理(见 idb.ts 的 planPrune)。既然因此少删了,
           就得说出来 —— 否则用户会觉得"我标记了图,空间却没腾出来"是坏了 */
        const kept = pruned.keptMarked
          ? ` Kept ${pruned.keptMarked} marked ${pruned.keptMarked === 1 ? 'item' : 'items'}.`
          : ''
        deps.notice.value = pct
          ? `Local storage is about ${pct}% full. Removed the oldest ${pruned.removed} history ${pruned.removed === 1 ? 'item' : 'items'} to free space.${kept}`
          : `Removed the oldest ${pruned.removed} history ${pruned.removed === 1 ? 'item' : 'items'} to limit local usage.${kept}`
      }
    } catch {
      // 生成是成功的,失败的只是"存进本地":记录先留在内存里(本次会话仍可见),
      // 但必须如实告知刷新会丢 —— 不能混进"生成失败"的提示里
      deps.notice.value =
        'Image generated, but not saved locally. It will be lost on refresh — download it first.'
    } finally {
      // 落盘成功与否都要摘掉:失败的那条只活在本页内存里,不该因为"正在写"被永久保住
      writingIds.delete(record.id)
    }
  }

  // 历史页:不进预览,直接删掉某条记录
  function removeHistoryEntry(entry: HistoryEntry) {
    const at = history.value.findIndex((h) => h.id === entry.id)
    if (at < 0) return
    history.value = history.value.filter((h) => h.id !== entry.id)
    deps.scheduleUndo({
      label: 'Removed from history',
      undo: () => {
        history.value.splice(Math.min(at, history.value.length), 0, entry)
        // 窗口里可能正好生成了新图并触发淘汰,把这条按最旧的清掉了,所以补写一次
        saveHistoryRecord(entry)
      },
      purge: () => {
        removeHistoryRecord(entry.id)
        // 真正删掉才广播:撤销窗口里它还在,别的标签页不该先把它抹掉
        deps.announce('history')
        /* 地址到这时才释放:窗口里撤销回来还要渲染它。
           也只在这里释放 —— 预览开着时撤地址会让图裂掉 */
        releaseEntryMedia(entry)
      }
    })
  }

  /* 标记逐张标:图墙里一块图块就是一张图,所以标在结果项上而不是整条记录上。
     改完必须落盘,否则刷新就丢;界面靠响应式代理更新,而 idb 只吃原始对象,故 toRaw */
  async function toggleMark(entry: HistoryEntry, index: number) {
    const item = entry.results[index]
    if (!item) return
    item.marked = !item.marked
    await saveHistoryRecord(toRaw(entry))
    deps.announce('history')
  }

  /* 另一页改了历史:重读一遍。**合并而不是整份替换**,理由见 api.ts 的 mergeHistory */
  async function reloadHistoryFromDb() {
    const fromDb = await loadHistory()
    const next = mergeHistory(fromDb, history.value, writingIds)
    const keep = new Set(next.map((h) => h.id))
    const gone = history.value.filter((h) => !keep.has(h.id))
    history.value = next
    // 这些图不会再展示了:撤掉 object URL,让 Blob 能被回收(与清理那条路同一个理由)
    gone.forEach(releaseEntryMedia)
  }

  /* —— 作品集(Collection) ——
     把一组生成归拢起来,并让它们不被存储清理淘汰(见 idb.ts 的 pruneHistory)。
     目录本身轻量,放 localStorage;归属挂在记录上,在这里同步内存并落盘 */

  /** 新建一个作品集。空标题用占位名兜底;返回新 id 方便调用方顺手把它选中 */
  function createCollection(title: string): string {
    const c: Collection = {
      id: uid(),
      title: title.trim() || 'Untitled collection',
      createdAt: Date.now()
    }
    collections.value = [c, ...collections.value]
    saveCollections(collections.value)
    return c.id
  }

  /** 删除作品集:目录里摘掉,并把它名下所有记录的归属一并清掉。
      清掉归属之后那些记录就重新可以被自动清理 —— 这是删作品的预期语义。

      与别处的删除同一套:立刻生效、几秒内可撤销,真正落盘发生在窗口结束时 */
  function deleteCollection(id: string) {
    const at = collections.value.findIndex((c) => c.id === id)
    if (at < 0) return
    const gone = collections.value[at]
    /* 摘归属之前先把受影响的记录记下来:撤销时要原样还回去。
       摘掉归属只动内存,写盘推迟到窗口结束 —— 窗口里撤销回来不必再读一次库 */
    const detached = history.value.filter((h) => h.collectionId === id)
    collections.value = collections.value.filter((c) => c.id !== id)
    saveCollections(collections.value)
    for (const h of detached) delete h.collectionId
    deps.scheduleUndo({
      label: 'Collection deleted',
      undo: () => {
        // 放回原来的位置:目录顺序有意义(最近建的在前)
        collections.value = [
          ...collections.value.slice(0, Math.min(at, collections.value.length)),
          gone,
          ...collections.value.slice(Math.min(at, collections.value.length))
        ]
        saveCollections(collections.value)
        for (const h of detached) {
          h.collectionId = id
          saveHistoryRecord(toRaw(h))
        }
      },
      // 窗口结束才算真删:这时才把"归属已摘掉"落盘
      purge: () => {
        for (const h of detached) saveHistoryRecord(toRaw(h))
      }
    })
  }

  /** 把某条记录挂到某个作品集下(collectionId 为空串即摘出)。
      改的是内存 + 落盘,不重跑裁剪 —— 归属不影响裁剪体积 */
  function assignCollectionTo(entry: HistoryEntry, collectionId: string) {
    if (collectionId) entry.collectionId = collectionId
    else delete entry.collectionId
    saveHistoryRecord(toRaw(entry))
    deps.announce('history')
  }

  /** 连建带挂一次做完(预览里「新建作品集并纳入当前这条」) */
  function createAndAssign(entry: HistoryEntry | null, title: string): string {
    const id = createCollection(title)
    if (entry) assignCollectionTo(entry, id)
    return id
  }

  /* 读作品集目录:它是同步的 localStorage,直接读 */
  function initCollections() {
    collections.value = loadCollections()
  }
  function reloadCollectionsFromDb() {
    collections.value = loadCollections()
  }

  return {
    // 状态
    history,
    collections,
    writingIds,
    feedOpen,
    FEED_LIMIT,
    measured,
    // 派生与图墙
    feedItems,
    feedRatio,
    tileRatio,
    onFeedLoad,
    // 启动与重读
    initHistory,
    initCollections,
    reloadHistoryFromDb,
    reloadCollectionsFromDb,
    // 历史
    persist,
    removeHistoryEntry,
    toggleMark,
    // 作品集
    createCollection,
    deleteCollection,
    assignCollectionTo,
    createAndAssign
  }
}

