import type { ChatImage, ChatMessage, ChatSummary, CharacterMood, HistoryEntry } from '../types'

// 极简 IndexedDB 封装:用来持久化历史记录与提示词封面(比 localStorage 容量大得多)
const DB_NAME = 'kimage.db'
const STORE = 'history'
/* 提示词封面单独一个 store。它们原来是 base64 塞在 localStorage 条目里的,
   而 localStorage 一共只有约 5MB —— 五六十张封面就顶到天花板,写不下时
   只能把所有封面整批丢掉(见 git 历史的 savePrompts)。挪到这里之后,
   封面与历史图共用浏览器级配额,那个"整批丢封面"的降级路径也就不需要了 */
const COVER_STORE = 'covers'
/* 角色的参考图单独一个 store,不和提示词封面挤在一起 ——
   putCovers 会按"目录里现存的封面"反向裁剪,角色图混进去会被当成孤儿删掉 */
const CHAR_STORE = 'chars'
/* 角色的设定图与主参考图共用一个 store:
   主图 key 是裸的角色 id(启动时要读它),视图 key 是 `${角色id}:${视图}`(按需取) */
const VIEW_SEP = ':'
/* 角色对话的消息。一期一个角色一条连续对话,所以按 charId 建索引就够了 ——
   将来要开多段会话时再加 sessionId,并在这里补一条兼容读 */
const CHAT_STORE = 'chat_messages'
/* 对话的长期记忆(滑出窗口的消息压成的一段简报)。
   一个角色一条,keyPath 直接是 charId —— 它是"这一整段对话的当前状态",
   不是按条存的东西,所以不需要索引。
   (有一个中间版本把它换成了 sessionId,改动已撤回,但那个版本可能已经把库升了上去。
    这里不去改表结构 —— 那要整表重建,失败会让库彻底打不开。
    读与写各自兼容两种形状:见 getChatSummary 与 putChatSummary) */
const SUMMARY_STORE = 'chat_summaries'
/* 朗读用的音频缓存。**这不是优化,是这个功能能不能用的前提** ——
   接了第三方 TTS 之后每合成一句都按字符计费,而"再听一遍"是聊天里最自然的动作。
   缓存键里已经含了文本与音色指纹(见 api.ts 的 ttsCacheKey),所以改一句描述
   就不会命中旧的音频 */
const TTS_STORE = 'tts_cache'
/* 声音克隆用的样本音频。它是这一块唯一的二进制资产 ——
   Blob 进不了 localStorage,与设定图(vs charViews)同一条路 */
const VOICE_SAMPLE_STORE = 'voice_samples'
/* 聊天里用户附的图。**与消息分开存** —— 消息要一次读一整屏(几十条),
   而图一条就是几百 KB:混在一张表里,"读这一屏消息"就变成"顺便把
   这些图全拖进内存"。消息上只留一个 id(见 types.ts 的 ChatMessage.imageId) */
const CHAT_IMAGE_STORE = 'chat_images'
/* 对话背景图(沉浸页铺满屏幕的那一张)。
   **单独一张表**,理由与"角色的参考图不跟提示词封面挤在一起"完全一样:
   它有自己的生命周期(一场戏一张、换戏就换),而 chat_images 是按"消息引用到没有"
   来回收的(见 pruneChatImages)—— 混进去它要么被当成孤儿删掉,要么永远留着 */
const BACKDROP_STORE = 'chat_backdrops'
/* 角色**此刻的心情**。一个角色一条,keyPath 也是 charId ——
   它与 chat_summaries 是同一层的东西(对话侧的派生状态、都能从消息那一侧重建),
   但**刻意不并进那张表**:记忆是"发生过什么"(成篇、可展开、可编辑、可忘),
   心情是"此刻什么状态"(一个词 + 一个时间戳)。
   混在一张记录里,"忘掉记忆该不该连心情一起清""导出包带不带它"这两件事
   会立刻变成说不清的边界(前者的答案是不该,后者是不带 —— 见设计文档 §3.2) */
const MOOD_STORE = 'char_moods'
/* ===== 历史容量 =====================================================
   不按固定条数淘汰,而是看浏览器给的配额:只有占用接近上限时才清理最旧的一批。
   固定条数会在空间还很宽裕时就静默删记录,而每条记录的体积差很多,
   「50 条」到底占多少空间其实无从预估。
   拿不到配额信息(旧浏览器/隐私模式)时退回条数兜底,避免历史无限增长。
   ------------------------------------------------------------------ */
/** 占用超过这条水位线才开始清理 */
const HIGH_WATER = 0.8
/** 一次清掉最旧的这个比例:0.8 × (1 − 0.3) ≈ 0.56,能压回水位线以下 */
const PRUNE_RATIO = 0.3
/** 无论如何都至少留这么多条,避免把历史清空 */
const MIN_KEEP = 20
/** 拿不到配额信息时的兜底上限 */
const HARD_LIMIT = 500

export interface PruneResult {
  /** 清掉了几条 */
  removed: number
  /** 被清掉的记录 id:界面据此把内存里的条目一并摘掉,并释放其图片地址 */
  removedIds: string[]
  /** 清理前的占用比例,用于向用户解释为什么会清 */
  usageRatio: number
  /** 本该被清、但因为"里面有被标记的图"而保下来的记录数 —— 界面据此说明为什么没删得更多 */
  keptMarked: number
}

/* ===== 库版本。**只能往上加,永远不要改小** ========================
   IndexedDB 的版本只能升不能降。代码里的号比库里的小时,open 会直接失败
   (VersionError),而这个失败会被每一处调用 catch 成"读不出来" ——
   在用户眼里就是"我的图、我的历史全没了",而数据其实一条都没少。
   所以哪怕这一次没有任何结构要改,号该加也得加。
   ------------------------------------------------------------------ */
const DB_VERSION = 13

/* 连接只开一次。
   indexedDB.open 是一次异步握手,而原实现每次读写都重开一遍 ——
   落盘一条记录、读一屏消息、量一次缩略图,全都要重新握手一次;
   一个连接本来就可以被任意多的事务复用,没必要每次重来。
   失败的 promise 不缓存:版本过低、隐私模式下被拒都可能是"这一次"的事,
   缓存住会让整个会话再也连不上。
   另见下面 resetDB 与 retryOnDeadConnection:缓存带来的一处新风险在那里补 */
let dbPromise: Promise<IDBDatabase> | null = null

/** 清掉缓存的连接 —— 下一次 openDB() 会重新开 */
function resetDB(): void {
  dbPromise = null
}

/**
 * 这个错误是不是"连接已经死了"。
 * 死连接上的表现是创建事务时抛 InvalidStateError(Chrome/Safari),
 * 个别实现给的是 DatabaseClosedError —— 两个名字都认。
 */
export function isDeadConnectionError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name
  return name === 'InvalidStateError' || name === 'DatabaseClosedError'
}

/**
 * 在一个"活的"连接上做一件事;连接已死就清掉缓存重开一次。
 *
 * **缓存连接之后必须补这一环。** 连接会因为浏览器回收存储、DevTools 清存储、
 * IDB 后端异常而意外关闭;那时缓存里的 promise 仍然指着那个死连接,
 * 而每一处调用都把失败 catch 成"读不出来" —— 在用户眼里就是**"我的东西全没了"**
 * (把连接改成缓存之前,每次重开,死了会自然恢复;缓存之后就再也恢复不了)。
 *
 * 只对"连接已死"重试一次:别的原因(数据坏、版本不符)重试也没用,
 * 而无限重试会把一次失败变成一次挂死。
 */
export async function retryOnDeadConnection<T>(
  getDB: () => Promise<IDBDatabase>,
  reset: () => void,
  run: (db: IDBDatabase) => T,
  isDead: (e: unknown) => boolean = isDeadConnectionError
): Promise<T> {
  const db = await getDB()
  try {
    return await run(db)
  } catch (e) {
    if (!isDead(e)) throw e
    reset()
    return run(await getDB())
  }
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      const tx = req.transaction
      if (!tx) return
      const store = db.objectStoreNames.contains(STORE)
        ? // 从 v1 升上来时 store 已存在,从升级事务里取出来补索引
          tx.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: 'id' })
      // createdAt 索引让"淘汰最旧"只需读主键,不必把整表记录读出来
      if (!store.indexNames.contains('createdAt')) store.createIndex('createdAt', 'createdAt')
      // v3 新增:提示词封面
      if (!db.objectStoreNames.contains(COVER_STORE)) {
        db.createObjectStore(COVER_STORE, { keyPath: 'id' })
      }
      // v4 新增:角色的参考图
      if (!db.objectStoreNames.contains(CHAR_STORE)) {
        db.createObjectStore(CHAR_STORE, { keyPath: 'id' })
      }
      // v5 新增:角色对话的消息
      if (!db.objectStoreNames.contains(CHAT_STORE)) {
        const chat = db.createObjectStore(CHAT_STORE, { keyPath: 'id' })
        /* 按角色取消息、按角色清消息都靠它。
           没有它就得全表读出来再筛,而消息是只增不减的那一类 */
        chat.createIndex('charId', 'charId')
      }
      /* v6 新增:对话消息的复合索引。
         v5 那条只能按 charId 取全部,而对话页要的是**最近这些条** ——
         有了 (charId, createdAt) 才能开一个游标从最新往回走,
         走够一屏就停,不必把这个角色几千条历史整个读进内存 */
      if (db.objectStoreNames.contains(CHAT_STORE)) {
        const chat = tx.objectStore(CHAT_STORE)
        if (!chat.indexNames.contains('charIdCreated')) {
          chat.createIndex('charIdCreated', ['charId', 'createdAt'])
        }
      }
      /* v7 新增:对话的长期记忆。一个角色一条,keyPath 直接是 charId ——
         它是"这一整段对话的当前状态",不是按条存的东西 */
      if (!db.objectStoreNames.contains(SUMMARY_STORE)) {
        db.createObjectStore(SUMMARY_STORE, { keyPath: 'charId' })
      }
      /* v9:把 v8 那次留下的痕迹收拾掉。
         v8 那个号被写出来过(多段会话的改动,已撤回),可能已经把库升了上去,
         而它给对话消息挂了一条没人问的会话索引。摘掉即可 ——
         索引是同步的结构操作,不存在重建表那种中途失败的风险。
         判断是幂等的:库里没有这条索引时什么都不做 */
      if (db.objectStoreNames.contains(CHAT_STORE)) {
        const chat = tx.objectStore(CHAT_STORE)
        if (chat.indexNames.contains('charIdSessionCreated')) {
          chat.deleteIndex('charIdSessionCreated')
        }
      }
      /* 注意这里**不去碰** chat_summaries。
         v8 把它的主键从 charId 换成了 sessionId,要改回去只能整表删掉重建 ——
         在那个升级事务里做这种操作,Safari 上是有失败风险的,
         而一旦失败整个升级事务回滚,库就卡在 8 打不开了(正是这次事故的形状)。
         换一条路:表形状不动,把兼容放在写入处(见 putChatSummary),
         两种形状都能读写,于是这里什么都不用做 */
      /* v10 新增:朗读的音频缓存、声音克隆的样本。
         一个是纯派生物(删了什么都不会丢),一个是唯一原件(删了就真没了),
         所以分开两张表 —— 清理缓存时的批量删除不该有机会碰到样本 */
      if (!db.objectStoreNames.contains(TTS_STORE)) {
        const tts = db.createObjectStore(TTS_STORE, { keyPath: 'key' })
        // 淘汰最旧的一批时按它游走,不必把记录(含音频)读出来
        tts.createIndex('createdAt', 'createdAt')
      }
      if (!db.objectStoreNames.contains(VOICE_SAMPLE_STORE)) {
        db.createObjectStore(VOICE_SAMPLE_STORE, { keyPath: 'id' })
      }
      /* v11 新增:聊天里的附图(见 CHAT_IMAGE_STORE 的说明) */
      if (!db.objectStoreNames.contains(CHAT_IMAGE_STORE)) {
        db.createObjectStore(CHAT_IMAGE_STORE, { keyPath: 'id' })
      }
      /* v12 新增:对话背景图,keyPath 直接是 charId —— 一个角色一张(见 BACKDROP_STORE) */
      if (!db.objectStoreNames.contains(BACKDROP_STORE)) {
        db.createObjectStore(BACKDROP_STORE, { keyPath: 'charId' })
      }
      /* v13 新增:角色此刻的心情,keyPath 也是 charId —— 一个角色一条(见 MOOD_STORE)。
         新增一张表是安全的升级:建表是同步的结构操作,没有"整表读进内存再重建"
         那种中途失败的风险(与 v12 那次同一条理由) */
      if (!db.objectStoreNames.contains(MOOD_STORE)) {
        db.createObjectStore(MOOD_STORE, { keyPath: 'charId' })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      /* 另一个标签页要升级(或删库)时必须让开,否则它会一直卡在 blocked,
         用户看到的是"另一个页面打不开"。让开的同时清掉缓存,
         下一次调用会重新开、拿到新版本 */
      db.onversionchange = () => {
        db.close()
        if (dbPromise === opening) resetDB()
      }
      /* 连接**意外**关闭时也要清缓存(不是我们主动 close 的那种)。
         不清的话,后面每一次读写都打在一个死连接上,而所有失败都被 catch 成"空" ——
         那正是"数据好像全没了"的形状。这条与 onversionchange 是两回事:
         那个是别人要升级,这个是我们自己这边坏掉了 */
      db.onclose = () => {
        if (dbPromise === opening) resetDB()
      }
      resolve(db)
    }
    req.onerror = () => {
      /* 版本号低于库里那个时会被直接拒掉。这种失败会顺着每一处 catch
         变成"什么都没读到",界面上看就是"数据全没了" ——
         所以至少在控制台留一句,别让它彻底无声 */
      console.error('[idb] cannot open', DB_NAME, req.error)
      reject(req.error)
    }
  })
  dbPromise = opening
  opening.catch(() => {
    if (dbPromise === opening) resetDB()
  })
  return opening
}

/* 申请持久化存储。不申请的话,浏览器在磁盘吃紧时可以把整个 origin 的数据清掉,
   而这里存的正是用户唯一的作品与提示词库。浏览器多半要求"这个站点正在被使用"
   才给,所以在第一次真正写入时申请,不在启动时空喊。
   结果不往上抛:它只影响"磁盘满时会不会被回收",而这件事在正常使用中不该打断用户 */
let askedPersist = false
export async function ensurePersisted(): Promise<boolean> {
  if (askedPersist) return true
  askedPersist = true
  try {
    if (await navigator.storage?.persisted?.()) return true
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

/* ===== 提示词封面 =====
   存的是原图(仅长边超 1600 时缩一次),不是缩略图。用 Blob 不用 data URL:
   base64 会膨胀 33%,而且整段字符串要进 JS 堆;Blob 由浏览器放在堆外。
   封面按 id 存,与提示词目录(localStorage)分开 —— 目录每条只有几百字节 */
export interface CoverRecord {
  id: string
  data: Blob
}

/** 读出全部封面。库不大,一次读完最简单,调用方按 id 贴回条目 */
export async function getAllCovers(): Promise<Map<string, Blob>> {
  // 库里存着的形状不一定等于 CoverRecord:封面刚挪进 IDB 那版存的是 data URL 字符串
  type CoverRow = { id: string; data: Blob | string }
  try {
    const db = await openDB()
    const rows = await new Promise<CoverRow[]>((resolve, reject) => {
      const req = db.transaction(COVER_STORE, 'readonly').objectStore(COVER_STORE).getAll()
      req.onsuccess = () => resolve(req.result as CoverRow[])
      req.onerror = () => reject(req.error)
    })
    const out = new Map<string, Blob>()
    for (const row of rows) {
      if (row.data instanceof Blob) {
        out.set(row.id, row.data)
      } else if (typeof row.data === 'string' && row.data.startsWith('data:image/')) {
        // 封面刚一挪进 IDB 那版存的是 data URL 字符串,这里统一转成 Blob,
        // 让上层只需要认一种形状;转不出来的坏数据跳过
        try {
          out.set(row.id, await urlToBlob(row.data))
        } catch {
          /* ignore */
        }
      }
    }
    return out
  } catch {
    // 拿不到就当没有封面:库还能用,不该因为封面读不出来而整页打不开
    return new Map()
  }
}

/**
 * 写回封面:只补库里还没有的那几张,并删掉已经不在库里的那些
 * (删掉一条提示词,它的封面不该留下)。
 * 不做全量重写是有意的 —— 封面是原图,而每次保存提示词(取用一次也算)都会
 * 走到这里,全量重写就是几十上百 MB 的写入。封面只会新增,不会改。
 */
export async function putCovers(covers: CoverRecord[]): Promise<void> {
  const db = await openDB()
  const keep = new Set(covers.map((c) => c.id))
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(COVER_STORE, 'readwrite')
    const store = tx.objectStore(COVER_STORE)
    const keysReq = store.getAllKeys()
    keysReq.onsuccess = () => {
      const existing = new Set(keysReq.result.map(String))
      for (const k of keysReq.result) if (!keep.has(String(k))) store.delete(k)
      for (const c of covers) if (!existing.has(c.id)) store.put(c)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/* ===== 角色的参考图 =====
   与提示词封面同一套做法:名字与描述在 localStorage 目录里,图按 id 存在这里 */
export interface CharRefRecord {
  id: string
  data: Blob
}

/** 读出全部角色参考图。角色不会太多,一次读完最简单,调用方按 id 贴回条目 */
export async function getAllCharRefs(): Promise<Map<string, Blob>> {
  try {
    const db = await openDB()
    const rows = await new Promise<Array<{ id: string; data: Blob }>>((resolve, reject) => {
      const req = db.transaction(CHAR_STORE, 'readonly').objectStore(CHAR_STORE).getAll()
      req.onsuccess = () => resolve(req.result as Array<{ id: string; data: Blob }>)
      req.onerror = () => reject(req.error)
    })
    const out = new Map<string, Blob>()
    for (const row of rows) {
      // 这个 store 是新加的,不会有老的 data URL 数据;但脏数据仍要跳过
      if (row.data instanceof Blob) out.set(row.id, row.data)
    }
    return out
  } catch {
    // 读不出来就当没有:角色本身还能用,不该因为一张图而整块打不开
    return new Map()
  }
}

/**
 * 写回角色参考图:整批覆盖写,并删掉已经不在目录里的那些。
 *
 * 为什么不能"只补库里还没有的":角色的主参考图是会被改的 ——
 * 「Use as reference」就是把主图换成另一张视图。跳过错在的 key,
 * 内存里当场生效、刷新后却读回旧的那张,用户看到的就是"改了又弹回去"。
 * 每个角色最多一张、都是 512px 的压缩图,全量重写这点开销不值得省
 */
export async function putCharRefs(refs: CharRefRecord[]): Promise<void> {
  const db = await openDB()
  const keep = new Set(refs.map((r) => r.id))
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHAR_STORE, 'readwrite')
    const store = tx.objectStore(CHAR_STORE)
    const keysReq = store.getAllKeys()
    keysReq.onsuccess = () => {
      const keys = keysReq.result.map(String)
      /* 设定图的 key 是 `${角色id}:${视图}`,不是裸的角色 id。
         只比对裸 id 的话,每次保存角色都会把刚生成好的设定图整批删掉 ——
         所以凡是"某个还在的角色名下"的 key 都算保留。
         角色 id 是 uuid,不含冒号,按第一个冒号切归属是安全的。
         反过来说:角色从列表里移除后,它的主图与全部视图会在这里一起被收走,
         不需要另写一套"删角色的图" */
      for (const k of keys) {
        const cut = k.indexOf(VIEW_SEP)
        const owner = cut > 0 ? k.slice(0, cut) : k
        if (!keep.has(owner)) store.delete(k)
      }
      for (const r of refs) store.put(r)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/* ===== 角色的设定图 =====
   只在这个界面打开时才取,不在启动时加载:5 张图 × N 个角色全部读进内存太重 */

/* 上传底图在这个 store 里的 key 后缀。与设定图共用 `${角色id}:${后缀}` 这套前缀,
   所以 putCharRefs 按归属裁剪时,它会跟着角色一起被收走,不必另写一套删除逻辑 */
const SOURCE_KEY = 'source'

/** 某个角色"第一步上传的那张底图"在 store 里的 key */
export function charSourceKey(id: string): string {
  return id + VIEW_SEP + SOURCE_KEY
}

/** 读出某个角色的全部设定图。先按 key 前缀筛出自己那几张,再逐张取 ——
 *  不整车读进来,免得把别的角色的图也拉进内存 */
export async function getCharViews(charId: string): Promise<Array<{ kind: string; data: Blob }>> {
  try {
    const db = await openDB()
    const prefix = charId + VIEW_SEP
    const keys = await new Promise<string[]>((resolve, reject) => {
      const req = db.transaction(CHAR_STORE, 'readonly').objectStore(CHAR_STORE).getAllKeys()
      req.onsuccess = () => resolve(req.result.map(String))
      req.onerror = () => reject(req.error)
    })
    const out: Array<{ kind: string; data: Blob }> = []
    for (const key of keys.filter((k) => k.startsWith(prefix))) {
      // 底图的 key 也挂在这个前缀下,但它不是一张视图(见 charSourceKey)
      if (key === charSourceKey(charId)) continue
      const data = await new Promise<Blob | undefined>((resolve, reject) => {
        const req = db.transaction(CHAR_STORE, 'readonly').objectStore(CHAR_STORE).get(key)
        req.onsuccess = () => {
          const row = req.result as { data?: Blob } | undefined
          resolve(row?.data)
        }
        req.onerror = () => reject(req.error)
      })
      if (data instanceof Blob) out.push({ kind: key.slice(prefix.length), data })
    }
    return out
  } catch {
    // 读不出来就当没有:角色本身还能用,不该因为设定图而整块打不开
    return []
  }
}

/** 写入一张视图。同一个 kind 再写就是覆盖(重生成) */
export async function putCharView(charId: string, kind: string, data: Blob): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHAR_STORE, 'readwrite')
    tx.objectStore(CHAR_STORE).put({ id: `${charId}${VIEW_SEP}${kind}`, data })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/* ===== 角色对话的消息 =====
   只增不减的一类数据,所以不放进 localStorage(那里一共只有约 5MB):
   几十轮对话就是几十上百 KB,塞进去迟早把它撑爆 */

/** 一次读多少条。**这只是显示上限,不是删除** —— 更早的还在库里,
 *  "加载更早"把这个数再往上抬一档。
 *  200 条足够铺满好几屏,而一次性渲染几千个气泡会让页面直接卡住 */
export const CHAT_PAGE = 200

/**
 * 读出某个角色**最近**的一段消息,按时间升序返回。
 *
 * 走 (charId, createdAt) 复合索引开一个倒着走的游标:取够 limit 条就停 ——
 * 用 getAll 会把这个角色几千条历史整个读进内存,而界面一次只看得见一屏。
 *
 * hasMore 表示前面还有更早的没读。多取一条来判:拿到 limit + 1 条就说明
 * 前面还有(那多出来的一条丢掉,不进返回值)。
 */
export async function getChatMessages(
  charId: string,
  limit = CHAT_PAGE
): Promise<{ list: ChatMessage[]; hasMore: boolean }> {
  try {
    const db = await openDB()
    const rows: ChatMessage[] = []
    let hasMore = false
    await new Promise<void>((resolve, reject) => {
      const index = db
        .transaction(CHAT_STORE, 'readonly')
        .objectStore(CHAT_STORE)
        .index('charIdCreated')
      /* 时间戳作上下界:IDB 不认 Infinity,用 MAX_SAFE_INTEGER 当"直到最后" */
      const range = IDBKeyRange.bound([charId, 0], [charId, Number.MAX_SAFE_INTEGER])
      const req = index.openCursor(range, 'prev')
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve()
          return
        }
        if (rows.length >= limit) {
          hasMore = true
          resolve()
          return
        }
        rows.push(chatMessageFromRow(cursor.value))
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })
    // 游标是倒着走的,正回来才是对话的顺序
    rows.reverse()
    return { list: rows, hasMore }
  } catch {
    /* 读不出来就当没有:这个角色照常能开始一段新对话,
       不该因为读盘失败整页打不开 */
    return { list: [], hasMore: false }
  }
}

/**
 * 每个角色**最后一条**消息,一批角色一起取。
 *
 * 左栏要显示"最后说了什么"、还要按最近活跃排序,而消息是按角色懒加载的 ——
 * 没打开过的角色一条都读不到,于是它一律显示 "No messages yet" 并排到最后:
 * 明明聊过,看起来却像从没聊过。这个 bug 只在"聊过的角色不止一个"时才显形。
 *
 * 每个角色开一个倒着走的游标、只取第一条就停,而且全部开在同一个事务里并发跑 ——
 * **代价与角色数成正比、与消息条数无关**,不会因为某个角色聊了几千轮而变慢。
 */
export async function getLastChatLine(charIds: string[]): Promise<Map<string, ChatMessage>> {
  const out = new Map<string, ChatMessage>()
  if (!charIds.length) return out
  try {
    const db = await openDB()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(CHAT_STORE, 'readonly')
      const index = tx.objectStore(CHAT_STORE).index('charIdCreated')
      let pending = charIds.length
      const done = () => {
        if (--pending === 0) resolve()
      }
      /* 事务被打断时上面的 done 不一定跑满,得自己解绳 ——
         否则这个 promise 永远悬着,左栏就一直停在加载态 */
      tx.onabort = () => resolve()
      for (const id of charIds) {
        const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])
        const req = index.openCursor(range, 'prev')
        req.onsuccess = () => {
          const cursor = req.result
          if (cursor) out.set(id, cursor.value as ChatMessage)
          done()
        }
        // 单个角色读不出来就跳过:少一行摘要不该让整条左栏空掉
        req.onerror = done
      }
    })
    return out
  } catch {
    return out
  }
}

/** 追加一条消息。**流式过程中不逐块写** —— 只在整条回复收尾时落一次:
 *  一次回复可能产生上百个增量,逐块写就是上百次事务,
 *  而中途崩掉丢掉半句话,与"用户按了 Stop"在用户眼里没有区别 */
export async function putChatMessage(msg: ChatMessage): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHAT_STORE, 'readwrite')
    tx.objectStore(CHAT_STORE).put(msg)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 一行消息从库里出来时的收口。
 *
 *  消息是**结构化克隆**存进去的,所以字段本身不会丢;但库里的内容可能来自
 *  更早的版本、被同步工具改过、或者被一份手工拼的导入包写坏 ——
 *  而 `photoError` 会被**直接渲染在界面上**,一个不是字符串的值
 *  (对象 / 数字 / 超长文本)就够让那一格显示成 `[object Object]` 或撑爆布局。
 *
 *  只收这一项:别的字段各自有各的读法(见 useChat 的 settlePhoto),
 *  在这里顺手改它们等于把判断抄到第二处 */
export function chatMessageFromRow(row: unknown): ChatMessage {
  const m = row as ChatMessage
  if (!m || typeof m !== 'object') return m
  if (typeof m.photoError !== 'string') {
    return m.photoError === undefined ? m : { ...m, photoError: undefined }
  }
  return m.photoError.length > 300 ? { ...m, photoError: m.photoError.slice(0, 300) } : m
}

/** 删一条。重新生成时删掉最后那条助手消息用 */
export async function deleteChatMessage(id: string): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHAT_STORE, 'readwrite')
    tx.objectStore(CHAT_STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 清掉某个角色的全部对话痕迹:消息 + 长期记忆 + **消息指着的那几张附图**。
 *
 *  三者必须一起走 —— 消息没了而记忆还留着,下一句开口就会提起一段
 *  用户刚刚清掉的旧事,那比失忆更糟;而附图是另一回事:
 *  **消息一删,它带过哪几张图就再也问不出来了**,留下的字节永远没人认领
 *  (空间体检只认历史那张表,见 pruneHistory)。所以放在同一个事务里,
 *  要么都清、要么都没清。
 *
 *  要按 charId 把**全部**消息读一遍,不是界面上那一档:界面上只装着最近
 *  CHAT_PAGE(200)条,照它收的话更早的图会全部变成孤儿 —— 这正是修之前
 *  的漏洞之一。另一个是 photoId(角色发的图)从来没被收过。 */
export async function deleteChatOf(charId: string): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const storeNames = [CHAT_STORE, SUMMARY_STORE, CHAT_IMAGE_STORE]
    if (db.objectStoreNames.contains(BACKDROP_STORE)) storeNames.push(BACKDROP_STORE)
    /* 心情也一起收。**"消息没了而情绪还在"比失忆更糟** ——
       清空之后下一句开口,它会端着一份用户刚刚清掉的火气(与记忆那条同一条理由) */
    if (db.objectStoreNames.contains(MOOD_STORE)) storeNames.push(MOOD_STORE)
    const tx = db.transaction(storeNames, 'readwrite')
    const store = tx.objectStore(CHAT_STORE)
    const index = store.index('charId')
    /* 两个请求都在事务开头发出:读到的都是"动手删之前"的状态,
       所以下面那个 onsuccess 里问不出空结果 */
    const keysReq = index.getAllKeys(charId)
    const msgsReq = index.getAll(charId)
    keysReq.onsuccess = () => {
      for (const k of keysReq.result) store.delete(k)
    }
    msgsReq.onsuccess = () => {
      const imgs = tx.objectStore(CHAT_IMAGE_STORE)
      for (const id of referencedChatImages(msgsReq.result as ChatMessage[])) imgs.delete(id)
    }
    tx.objectStore(SUMMARY_STORE).delete(charId)
    if (db.objectStoreNames.contains(BACKDROP_STORE)) {
      tx.objectStore(BACKDROP_STORE).delete(charId)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/* ===== 对话的长期记忆 =====
   滑出窗口的那些消息在这里留下痕迹。写它的是摘要那一步(见 App 的 maybeSummarize),
   读它的有两处:拼 system 提示词,以及界面顶上那段可展开的"记忆" */

/** 读出某个角色的记忆。读不出来(没压过 / 盘坏了 / 形状不对)一律当没有。
 *
 *  这里按 charId 查,而那个中间版本的表主键是 sessionId —— 两种形状下都对:
 *  那张表里每条记录的 sessionId 就是它的 charId(见 putChatSummary),
 *  所以 get(charId) 恰好落在同一条上。 */
export async function getChatSummary(charId: string): Promise<ChatSummary | undefined> {
  try {
    const db = await openDB()
    const row = await new Promise<ChatSummary | undefined>((resolve, reject) => {
      const req = db.transaction(SUMMARY_STORE, 'readonly').objectStore(SUMMARY_STORE).get(charId)
      req.onsuccess = () => resolve(req.result as ChatSummary | undefined)
      req.onerror = () => reject(req.error)
    })
    /* 逐项收一遍:这是从盘上读回来的东西,形状不一定是当初写进去的那个。
       covered / upToAt 是数字参与运算,一个 undefined 就能让"该不该压"
       算成 NaN 并永远为假 —— 记忆从此再也不更新,而且不报错 */
    if (
      !row ||
      typeof row.text !== 'string' ||
      typeof row.upToId !== 'string' ||
      typeof row.upToAt !== 'number' ||
      typeof row.covered !== 'number'
    ) {
      return undefined
    }
    return row
  } catch {
    return undefined
  }
}

export async function putChatSummary(rec: ChatSummary): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SUMMARY_STORE, 'readwrite')
    /* 顺手补一个 sessionId。这张表的主键在正常形状下是 charId,
       而有一个中间版本(见 openDB 里 v9 那段)把它换成了 sessionId。
       主键是 sessionId 时,记录里缺这个字段会被 put 直接拒掉(DataError)——
       于是记忆读得到、却再也写不进去,而且失败是静默的。
       两种形状下这一句都无害:主键是 charId 时它就是个没人看的闲字段 */
    tx.objectStore(SUMMARY_STORE).put({ ...rec, sessionId: rec.charId })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/* ===== 角色此刻的心情 =====
   一个词加一个时间戳,覆盖写。写它的是每一轮说完那一刻(见 App 的 runChat),
   读它的有两处:拼 system 提示词(服务端按 6 小时窗口判,见 server/chatMood.js),
   以及画图时拼出图提示词的表情层(见 lib/chatPhoto) */

/** 读出某个角色此刻的心情。读不出来 / 形状不对一律当没有。
 *
 *  **这一层不判"过没过期"** —— 那是读的人的事(服务端按 CHAT_MOOD_HOLD_MS 判)。
 *  这里把记录原样交出去,因为"这个心情是什么时候的"本身就是它的一部分:
 *  界面与出图那一侧都可能要它。 */
export async function getCharMood(charId: string): Promise<CharacterMood | undefined> {
  try {
    const db = await openDB()
    const row = await new Promise<CharacterMood | undefined>((resolve, reject) => {
      const req = db.transaction(MOOD_STORE, 'readonly').objectStore(MOOD_STORE).get(charId)
      req.onsuccess = () => resolve(req.result as CharacterMood | undefined)
      req.onerror = () => reject(req.error)
    })
    /* 逐项收一遍:这是从盘上读回来的东西(老记录、坏盘、别人手改过的),
       形状不一定是当初写进去的那个。word 非字符串会让 moodWord 静默返回空串
       (那还好),而 at 非数字会让"过没过期"算成 NaN 并一路当真 ——
       于是情绪永远喂不回去,而且不报错 */
    if (!row || typeof row.word !== 'string' || typeof row.at !== 'number') return undefined
    return row
  } catch {
    return undefined
  }
}

export async function putCharMood(rec: CharacterMood): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MOOD_STORE, 'readwrite')
    tx.objectStore(MOOD_STORE).put(rec)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 这个角色一共有多少条消息。**只看索引、不读记录** ——
 *  它唯一的用处是算"还有多少条没进摘要",没必要为此把消息捞出来 */
export async function countChatMessages(charId: string): Promise<number> {
  try {
    const db = await openDB()
    return await new Promise<number>((resolve, reject) => {
      const req = db
        .transaction(CHAT_STORE, 'readonly')
        .objectStore(CHAT_STORE)
        .index('charIdCreated')
        .count(IDBKeyRange.bound([charId, 0], [charId, Number.MAX_SAFE_INTEGER]))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return 0
  }
}

/**
 * 取出"该压进摘要的那一段":从 afterAt 之后、**由旧到新**收 limit 条。
 *
 * 方向是关键。反过来(从最新的往回收)第一批会把最近那些还没摘要的消息
 * 全吃掉,而更早的永远轮不到 —— 对话最开头那一段会被跳过一辈子,
 * 而这个 bug 只在几百条之后才显形。
 *
 * 收多少条由调用方算:**总条数 − 最近要保留的条数 − 已覆盖的条数**。
 * 这样算出来的边界正好落在"最近窗口"前面,窗口里的原话一句都不会被压掉。
 */
export async function getChatMessagesToSummarize(
  charId: string,
  afterAt: number,
  limit: number
): Promise<ChatMessage[]> {
  if (limit <= 0) return []
  try {
    const db = await openDB()
    const rows: ChatMessage[] = []
    await new Promise<void>((resolve, reject) => {
      const index = db
        .transaction(CHAT_STORE, 'readonly')
        .objectStore(CHAT_STORE)
        .index('charIdCreated')
      /* 左开:afterAt 那一条已经进过摘要了,不能重复压 */
      const range = IDBKeyRange.bound(
        [charId, afterAt],
        [charId, Number.MAX_SAFE_INTEGER],
        true,
        false
      )
      const req = index.openCursor(range, 'next')
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor || rows.length >= limit) {
          resolve()
          return
        }
        rows.push(chatMessageFromRow(cursor.value))
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })
    return rows
  } catch {
    return []
  }
}

/* ===== 朗读的音频缓存 =====
   每一条都是"某个音色念某段文本"的结果。键里含文本与音色指纹
   (见 api.ts 的 ttsCacheKey),所以改了描述、换了音色就不会命中旧的音频 */

export interface TtsClipRecord {
  key: string
  blob: Blob
  createdAt: number
}

/* 缓存条数上限。按**条数**封顶而不是字节数:算字节得先把每条记录(含音频)
   读出来才知道,而这里单条本来就不大(一句话的 mp3 通常几十 KB),
   按条数既够用、又完全不必碰盘上的内容 */
const TTS_CACHE_MAX = 200

/** 取一段念过的音频。没有(或读坏了)返回 undefined —— 调用方据此去合成 */
export async function getTtsClip(key: string): Promise<Blob | undefined> {
  try {
    const db = await openDB()
    const row = await new Promise<TtsClipRecord | undefined>((resolve, reject) => {
      const req = db.transaction(TTS_STORE, 'readonly').objectStore(TTS_STORE).get(key)
      req.onsuccess = () => resolve(req.result as TtsClipRecord | undefined)
      req.onerror = () => reject(req.error)
    })
    return row && row.blob instanceof Blob ? row.blob : undefined
  } catch {
    return undefined
  }
}

/** 存一段音频,顺手淘汰最旧的一批。写不进去只影响"下次还得再合成一次",
 *  不该让这一次朗读失败,所以整个失败路径都是静默的 */
export async function putTtsClip(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(TTS_STORE, 'readwrite')
      const store = tx.objectStore(TTS_STORE)
      store.put({ key, blob, createdAt: Date.now() })
      const index = store.index('createdAt')
      /* 裁在同一个事务里:写完就裁,不开第二趟。
         计数与游标都排在 put 之后,所以看到的是写完之后的账 */
      const countReq = index.count()
      countReq.onsuccess = () => {
        let over = countReq.result - TTS_CACHE_MAX
        if (over <= 0) return
        // 索引是升序的,所以游走的方向就是淘汰的顺序:最旧的先走
        const cursorReq = index.openCursor()
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor || over <= 0) return
          cursor.delete()
          over--
          cursor.continue()
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* 见上 */
  }
}

/* ===== 声音克隆的样本 =====
   与音频缓存分开:那些是派生物,删了不会有任何损失;这个是**唯一原件**,
   删了就真没了。混在一张表里,清缓存时的批量删除就有机会碰到它 */

export interface VoiceSampleRecord {
  id: string
  /* 原始文件名。界面上回显"当初用的是哪一段" */
  name: string
  blob: Blob
  bytes: number
  createdAt: number
}

export async function putVoiceSample(rec: VoiceSampleRecord): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VOICE_SAMPLE_STORE, 'readwrite')
    tx.objectStore(VOICE_SAMPLE_STORE).put(rec)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getVoiceSample(id: string): Promise<VoiceSampleRecord | undefined> {
  try {
    const db = await openDB()
    const row = await new Promise<VoiceSampleRecord | undefined>((resolve, reject) => {
      const req = db.transaction(VOICE_SAMPLE_STORE, 'readonly').objectStore(VOICE_SAMPLE_STORE).get(id)
      req.onsuccess = () => resolve(req.result as VoiceSampleRecord | undefined)
      req.onerror = () => reject(req.error)
    })
    return row && row.blob instanceof Blob ? row : undefined
  } catch {
    return undefined
  }
}

/** 删掉一段样本。删角色、或者用户换掉嗓音时都要走到这里 ——
 *  留着一段没人认领的录音,比留一个没人认领的图更该清掉 */
export async function deleteVoiceSample(id: string): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(VOICE_SAMPLE_STORE, 'readwrite')
      tx.objectStore(VOICE_SAMPLE_STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* 删不掉最多是多占一点空间,不该打断删除角色这件事 */
  }
}

/* ===== 聊天里的附图 =====
   存的是用户附的那张原图。它**不是派生物**:消息上那个 imageId 指着它,
   删了之后那条消息就只剩一句话 —— 所以清缓存那套不许碰它 */

/* 最近一次写聊天附图是什么时候(见 pruneChatImages 顶部那段)。
   放在模块级而不是入参:这件事是"这个库刚被写过",与是哪一次写入无关 */
let lastChatImageWriteAt = 0
/** 写过图之后这段时间内不做附图体检。见 pruneChatImages */
const CHAT_IMAGE_QUIET_MS = 30_000
export async function putChatImage(rec: ChatImage): Promise<void> {
  const db = await openDB()
  // 记一笔"刚写过图":pruneChatImages 靠它避开下面那一段时间差
  lastChatImageWriteAt = Date.now()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHAT_IMAGE_STORE, 'readwrite')
    tx.objectStore(CHAT_IMAGE_STORE).put(rec)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 一个角色的对话背景图。**带它当时画的那段场景** ——
 *  调用方据此判断"换戏了没有",从而决定要不要重画一张(见 App 的 ensureBackdrop) */
export interface ChatBackdrop {
  charId: string
  /** 画它时用的场景描述。与当前这一场不一致 = 该重画了 */
  scene: string
  blob: Blob
  createdAt: number
}

export async function getChatBackdrop(charId: string): Promise<ChatBackdrop | undefined> {
  try {
    const db = await openDB()
    const row = await new Promise<ChatBackdrop | undefined>((resolve, reject) => {
      const req = db.transaction(BACKDROP_STORE, 'readonly').objectStore(BACKDROP_STORE).get(charId)
      req.onsuccess = () => resolve(req.result as ChatBackdrop | undefined)
      req.onerror = () => reject(req.error)
    })
    return row && row.blob instanceof Blob ? row : undefined
  } catch {
    /* 读不出来当作没有:退回首图/主题色,不该因为一张背景让整页打不开 */
    return undefined
  }
}

export async function putChatBackdrop(rec: ChatBackdrop): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BACKDROP_STORE, 'readwrite')
      tx.objectStore(BACKDROP_STORE).put(rec)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* 写不进去就只活在内存里这一场:下一场再画一张,不是数据丢失 */
  }
}

export async function deleteChatBackdrop(charId: string): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BACKDROP_STORE, 'readwrite')
      tx.objectStore(BACKDROP_STORE).delete(charId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* 同上 */
  }
}

export async function getChatImage(id: string): Promise<ChatImage | undefined> {
  try {
    const db = await openDB()
    const row = await new Promise<ChatImage | undefined>((resolve, reject) => {
      const req = db.transaction(CHAT_IMAGE_STORE, 'readonly').objectStore(CHAT_IMAGE_STORE).get(id)
      req.onsuccess = () => resolve(req.result as ChatImage | undefined)
      req.onerror = () => reject(req.error)
    })
    return row && row.blob instanceof Blob ? row : undefined
  } catch {
    return undefined
  }
}

/** 删一张附图。
 *
 *  **注意:整段对话的回收不走这里,走 deleteChatOf** —— 它按 charId 把消息
 *  整批读出来、把 imageId 与 photoId 一起收,一个事务里完成。
 *  从前是在界面上遍历内存里那一档消息逐个调这个函数,于是更早的附件
 *  与角色发的每一张图都成了孤儿(见 deleteChatOf 的说明)。
 *  留它是因为按张回收将来用得上(比如"删掉某一条消息"),而不是现在有调用方。 */
export async function deleteChatImage(id: string): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHAT_IMAGE_STORE, 'readwrite')
      tx.objectStore(CHAT_IMAGE_STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* 删不掉最多是多占一点空间,不该因为一张图打断删消息这件事 */
  }
}

/* ===== 附图的归属:谁还被指着 =====
   附图与消息分两张表存,于是"消息删了、字节还在"这件事没有任何外键替我们挡着。
   两个纯函数把这份判断从 IDB 里拆出来 —— 它们决定"删不删用户的字节",
   而真正会出错的那条路(清空、删角色、空间体检)平时几乎碰不到,
   抽出来才能喂构造数据直接断言(与 planPrune 同一条理由)。
   ------------------------------------------------------------------ */

/** 消息还指着哪些附图。用户的 imageId 与角色发的 photoId 都要算 ——
 *  两者语义不同(一个"对方发来的",一个"它给你的"),但"还有没有人指着它"
 *  是同一个问题,回收时不必分开 */
export function referencedChatImages(
  msgs: readonly Pick<ChatMessage, 'imageId' | 'photoId'>[]
): Set<string> {
  const out = new Set<string>()
  for (const m of msgs) {
    if (m?.imageId) out.add(m.imageId)
    if (m?.photoId) out.add(m.photoId)
  }
  return out
}

/** 库里哪些附图已经没有任何消息指着了。这些字节谁也显示不出来,
 *  留着只是白占配额 —— 空间体检先拿它们开刀(见 pruneHistory)。
 *  判据只有"没人指着"这一条:还在消息里的图一张都不动,
 *  删了它们那段对话就只剩一句话了 */
export function orphanChatImages(
  referenced: ReadonlySet<string>,
  keys: readonly string[]
): string[] {
  return keys.filter((k) => !referenced.has(k))
}

/**
 * 把没人认领的聊天附图收掉,返回扔掉了几张。
 *
 * 为什么需要它:**空间体检量的是整个库,而历史那套清理只动一张表**。
 * 聊天里的图(用户附的 + 角色发的)从来不参与清理,于是水位被它们顶上去、
 * 挨删的却是用户的记录 —— 清理删错了对象。先扔掉这些谁都显示不出来的字节,
 * 往往就够压回水位线以下(调用处见 pruneHistory)。
 */
export async function pruneChatImages(): Promise<number> {
  /* 刚写过图就先别体检。**它挡的是一类静默的坏数据**:
     putChatImage 与"把 photoId / imageId 挂到消息上"是**两个事务**,
     中间那一瞬字节已经在库里、却还没有任何消息指着它 —— 而下面判孤儿的
     唯一依据正是"库里有没有消息指着它"。撞进那个窗口,一张刚画好的图会被
     当成垃圾收掉;之后消息带着 photoId 写回来,就成了谁也显示不出来的空引用。
     代价只是那一档孤儿晚 30 秒再收,而收错了是用户的一张图没了 */
  if (Date.now() - lastChatImageWriteAt < CHAT_IMAGE_QUIET_MS) return 0
  return retryOnDeadConnection(openDB, resetDB, (db) =>
    new Promise<number>((resolve, reject) => {
      const tx = db.transaction([CHAT_STORE, CHAT_IMAGE_STORE], 'readwrite')
      let removed = 0
      const msgsReq = tx.objectStore(CHAT_STORE).getAll()
      msgsReq.onsuccess = () => {
        const referenced = referencedChatImages(msgsReq.result as ChatMessage[])
        /* 只要键不要值:附图的值是几百 KB 的 Blob,判归属根本用不着读它们 */
        const keysReq = tx.objectStore(CHAT_IMAGE_STORE).getAllKeys()
        keysReq.onsuccess = () => {
          const imgs = tx.objectStore(CHAT_IMAGE_STORE)
          for (const id of orphanChatImages(referenced, keysReq.result as string[])) {
            imgs.delete(id)
            removed += 1
          }
        }
      }
      tx.oncomplete = () => resolve(removed)
      tx.onerror = () => reject(tx.error)
    })
  )
}

async function txStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  /* 走"连接已死就重开一次"这条:高频路径上的每一次失败都会在调用方
     被 catch 成"读不出来",而那与"真的没有数据"长得一模一样 */
  return retryOnDeadConnection(openDB, resetDB, (db) =>
    db.transaction(STORE, mode).objectStore(STORE)
  )
}

export async function getAll<T>(): Promise<T[]> {
  const store = await txStore('readonly')
  return new Promise((resolve, reject) => {
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error)
  })
}

/** 读取浏览器给的存储配额;隐私模式等场景会抛,一律当作"拿不到" */
async function storageUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.()
    if (est && est.usage != null && est.quota) return { usage: est.usage, quota: est.quota }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * 清理的候选资格。**抽成纯函数是有意的** —— 这段逻辑决定「删用户的哪些东西」,
 * 而它平时几乎不会跑(占用到 80% 才触发),靠手测根本碰不到;
 * 抽出来之后可以喂构造数据直接断言,不必真的把浏览器撑到 80%(见 idb.test.ts)。
 */
export interface PruneCandidate {
  id: string
  createdAt: number
  /** 归属某个作品集 = 用户特意归拢的,不参与自动清理 */
  collectionId?: string
  /** 记录里是否有被用户标记过的图(标记按张记,见 types.ts 的 ResultItem) */
  hasMarked?: boolean
}

export interface PrunePlan {
  /** 该清掉的记录 id,从最旧的开始 */
  removedIds: string[]
  /** 本该被清、但因含标记图而保下来的记录数(用于向用户解释为什么没删更多) */
  keptMarked: number
}

/**
 * 决定清哪些。规则只有两条:
 * - 按时间从旧到新,清够 count 条;
 * - 挂了作品集、或含标记图的记录不进候选,直接跳过。
 *
 * keptMarked 的口径:先按时间取出「不看保护、本来会清掉的那 count 条」,
 * 数其中有多少条是含标记图的 —— 那才是"因为标记而多留了一命"的条数,
 * 而不是库里一共有多少条标记(那些本来就轮不到被清)。
 */
export function planPrune(all: PruneCandidate[], count: number): PrunePlan {
  const n = Math.max(0, count)
  if (n === 0) return { removedIds: [], keptMarked: 0 }
  const byAge = [...all].sort((a, b) => a.createdAt - b.createdAt)
  const removedIds = byAge
    .filter((r) => !r.collectionId && !r.hasMarked)
    .slice(0, n)
    .map((r) => r.id)
  const keptMarked = byAge.slice(0, n).filter((r) => r.hasMarked).length
  return { removedIds, keptMarked }
}

/** 两次存储体检之间至少隔这么久 */
const PRUNE_MIN_INTERVAL_MS = 30_000
/** 或者攒够这么多条新记录就提前体检一次 */
const PRUNE_MIN_WRITES = 20

/**
 * 这一次写入要不要顺带做存储体检。
 *
 * 为什么需要它:体检本身要先问一次 navigator.storage.estimate()。写入是高频动作
 * (并发出图时三条一起落盘),每次都问一遍既没必要,也会让"超出水位线"那一刻
 * 出现多个并发的全表扫描。
 *
 * 口径:本会话第一次写入必查(否则第一个 80% 只有等下次写入才发现);
 * 之后要么攒够 minWrites 条,要么距上次已过 minIntervalMs ——
 * 于是体检频率被夹在「每 20 条」与「每 30 秒」之间,取更快的那一档。
 */
export function shouldCheckStorage(
  now: number,
  lastCheckAt: number,
  writesSinceCheck: number,
  minIntervalMs = PRUNE_MIN_INTERVAL_MS,
  minWrites = PRUNE_MIN_WRITES
): boolean {
  if (lastCheckAt === 0) return true
  if (writesSinceCheck >= minWrites) return true
  return now - lastCheckAt >= minIntervalMs
}

/* 体检节奏的状态。放在模块级而不是调用方 —— 它是"这个库被写得有多频繁",
   与具体是哪一次写入无关 */
let pruneCheckedAt = 0
let pruneWrites = 0

/**
 * 空间吃紧时清掉最旧的一批历史;还宽裕就原样返回 null。
 * 替代了原来的「按固定条数淘汰」——那个会在空间充裕时就静默删记录。
 *
 * 两类记录不参与自动清理,哪怕它们是同类里最旧的:
 * - 归属某个作品集(collectionId 不为空):用户特意归拢的作品;
 * - 里面有一张被标记过的图(marked):标记是用户亲手挑出来的收藏。
 *   标记按「张」记、清理按「条」删,所以只要有一条被标记就整条避让 ——
 *   宁可少腾一点空间,也不能删掉用户点名要留下的那张。
 *
 * 返回清了多少条,交由界面告知用户。
 */
let pruneInFlight: Promise<PruneResult | null> | null = null

export async function pruneHistory(): Promise<PruneResult | null> {
  if (pruneInFlight) return pruneInFlight
  pruneInFlight = doPruneHistory().finally(() => {
    pruneInFlight = null
  })
  return pruneInFlight
}

async function doPruneHistory(): Promise<PruneResult | null> {
  /* 先问"要不要体检",再决定要不要连库 —— 节流的意义就在于被跳过时
     连 openDB 与 estimate() 都不发生 */
  const now = Date.now()
  const due = shouldCheckStorage(now, pruneCheckedAt, pruneWrites)
  pruneWrites += 1
  if (!due) return null
  pruneCheckedAt = now
  pruneWrites = 0

  const est = await storageUsage()
  const usageRatio = est ? est.usage / est.quota : 0
  // 有余量就不动历史
  if (est && usageRatio < HIGH_WATER) return null

  /* 超标了先扔垃圾,再决定要不要动用户的记录 —— 顺序是有意的:
     聊天里那些没主的附图(角色发图从前从来没回收过、清空时也只收了最近一档)
     占的正是这份配额,而它们在历史这张表里根本查不到。
     先清历史的话,挨删的是用户的记录,垃圾一张不动。
     收不掉也不该挡住后面的体检,所以这里的失败只当没收到 */
  try {
    await pruneChatImages()
  } catch {
    /* 收不掉垃圾就照旧走下面那条路 */
  }
  /* 收完再量一次。可能已经压回水位线以下,那历史一条都不用动 ——
     这正是这一步想要的结果:垃圾优先于用户的记录 */
  const est2 = (await storageUsage()) || est
  const afterRatio = est2 ? est2.usage / est2.quota : 0
  if (est2 && afterRatio < HIGH_WATER) return null

  /* 全表读一遍:要避让挂了作品集的、以及含标记图的记录,只凭 createdAt 键做不到。
     同样走重试:读不出来与"真的没有记录"在调用方看来是一样的 */
  const all = await retryOnDeadConnection(
    openDB,
    resetDB,
    (live) =>
      new Promise<PruneCandidate[]>((resolve, reject) => {
        const req = live.transaction(STORE, 'readonly').objectStore(STORE).getAll()
        req.onsuccess = () =>
          resolve(
            (req.result as HistoryEntry[]).map((r) => ({
              id: r.id,
              createdAt: r.createdAt,
              ...(r.collectionId !== undefined ? { collectionId: r.collectionId } : {}),
              ...(r.results?.some((x) => x?.marked) ? { hasMarked: true } : {})
            }))
          )
        req.onerror = () => reject(req.error)
      })
  )
  // 配额驱动时按比例清;拿不到配额则退回条数兜底
  const want = est2 ? Math.ceil(all.length * PRUNE_RATIO) : Math.max(0, all.length - HARD_LIMIT)
  const count = Math.min(Math.max(0, all.length - MIN_KEEP), want)
  if (count <= 0) return null

  const { removedIds, keptMarked } = planPrune(all, count)
  /* 一条都不该清(全在作品集里,或全被标记保护着)就什么都不做:
     宁可空间继续吃紧,也不动用户特意留下的东西 */
  if (removedIds.length === 0) return null

  await retryOnDeadConnection(
    openDB,
    resetDB,
    (live) =>
      new Promise<void>((resolve, reject) => {
        const tx = live.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        for (const id of removedIds) store.delete(id)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
  )

  /* 报的是**收完垃圾之后**那个比例:用户看到这条提示时垃圾已经没了,
     报清理前那个数会把"为什么删我的东西"说成一个当下已经不成立的数 */
  return { removed: removedIds.length, removedIds, usageRatio: afterRatio, keptMarked }
}

export async function putOne<T extends { id: string }>(item: T): Promise<void> {
  const store = await txStore('readwrite')
  return new Promise((resolve, reject) => {
    const req = store.put(item)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function deleteOne(id: string): Promise<void> {
  const store = await txStore('readwrite')
  return new Promise((resolve, reject) => {
    const req = store.delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/* ===== 图片载荷的编解码 =====
   历史里存 Blob 而不是 data URL:base64 会膨胀 33%,
   而且字符串要整段进 JS 堆;Blob 由浏览器放在堆外,只在渲染时按需读。 */

export async function urlToBlob(url: string): Promise<Blob> {
  const resp = await fetch(url, { mode: 'cors' })
  if (!resp.ok) throw new Error(`Couldn't fetch the image (${resp.status})`)
  return await resp.blob()
}

/** base64(不含 data: 前缀)→ Blob */
export function base64ToBlob(b64: string, mime = 'image/png'): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** Blob → data URL。接口只认 data URL,用作参考图时需要这一趟转换 */
export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** 根据 base64 内容探测真实图片 MIME(避免写死 png 导致 JPEG 裂图) */
export function detectMimeFromDataUrl(dataUrl: string): string {
  // 已是完整 Data URL,直接沿用其 MIME
  const m = /^data:(image\/[a-z+]+);base64,/.exec(dataUrl)
  if (m) return m[1]

  // 纯 base64,按字节头判断(全部转大写比较)
  const head = dataUrl.slice(0, 22).toUpperCase()
  if (head.startsWith('/9J/') || head.startsWith('/9')) return 'image/jpeg'
  if (head.startsWith('IVBOR')) return 'image/png'
  if (head.startsWith('R0LG')) return 'image/gif'
  if (head.startsWith('UKLGR')) return 'image/webp'
  return 'image/png'
}