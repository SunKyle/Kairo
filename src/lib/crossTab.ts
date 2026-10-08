import {
  CHAT_ACTIVE_KEY,
  CHAR_KEY,
  COLL_KEY,
  CONFIG_ACTIVE_KEY,
  CONFIG_KEY,
  LIB_KEY,
  TEXT_ACTIVE_KEY,
  TTS_ACTIVE_KEY,
  VISION_ACTIVE_KEY
} from '../api'

/* ===== 跨标签页同步 ==================================================
   为什么需要它:localStorage 里的几份目录都是**整份覆盖写**的
   (见 api.ts 的 saveCharacters / savePrompts / saveCollections / saveConfigs)。
   两个标签页同时开着时,A 页删掉一个角色,B 页内存里还留着那份旧目录 ——
   B 页下一次保存会把它整个写回去,用户看到的是"我删掉的东西自己回来了"。

   storage 事件正好给出我们要的信号:**只有其他标签页写入时才会触发**,
   本页自己的写入不会惊动自己。所以处理方式就是"把这一份目录重新读一遍"。

   只重载目录,不碰任何正在编辑的草稿:向导里的表单、未提交的提示词都存在
   组件自己的状态里,换掉 props 不会动它们(代价是:如果另一个标签页改了
   你正在编辑的同一条,存盘时以本页为准 —— 这比"静默丢弃别人的改动"更可预期)。
   -------------------------------------------------------------------- */

/** 一次重载要动的目录 */
export type SyncTarget = 'configs' | 'characters' | 'collections' | 'prompts'

/* 键常量一律从 api.ts 取,不在这里重抄一遍字符串 ——
   抄一份的后果是"哪天改了键名,同步就悄悄不工作了",而且不报错 */
export const SYNC_KEYS: Record<SyncTarget, readonly string[]> = {
  // 五类用途的「当前生效」也一起看着:另一个标签页换了当前配置,本页要跟上
  configs: [
    CONFIG_KEY,
    CONFIG_ACTIVE_KEY,
    TEXT_ACTIVE_KEY,
    CHAT_ACTIVE_KEY,
    VISION_ACTIVE_KEY,
    TTS_ACTIVE_KEY
  ],
  characters: [CHAR_KEY],
  collections: [COLL_KEY],
  prompts: [LIB_KEY]
}

/**
 * 一个 storage 事件该触发哪些目录的重载。
 *
 * key 为 null 表示另一个标签页调用了 localStorage.clear() —— 那种情况下
 * 什么都可能变,四个目录一律重读。
 */
export function syncTargetsOf(key: string | null): SyncTarget[] {
  const targets = Object.keys(SYNC_KEYS) as SyncTarget[]
  if (key === null) return targets
  return targets.filter((t) => SYNC_KEYS[t].includes(key))
}

/* ===== 记录与字节那一侧 ==============================================
   上面那条走的是 localStorage 的 storage 事件,管的是"目录"(配置/角色/作品集/
   提示词目录)—— 那几份是整份覆盖写的,覆盖会带来真正的数据丢失。

   但历史记录、角色的设定图、对话消息都在 IndexedDB 里,**改它们不会触发
   storage 事件**。没有这一层的话:A 页删掉一条记录,B 页内存里还留着 ——
   图墙多出一个点开是空图的条目,删它也只是空操作;B 页删掉一个角色,
   A 页的对话列表还挂着它。

   所以再加一条广播通道。粒度是"哪一类东西变了 + 哪个角色",不是具体到
   某一条记录:收到的一方把那一类**重读一遍**。这样两端不会因为消息丢一条
   就对不上(重读是幂等的),代价是一次多读几条记录。
   -------------------------------------------------------------------- */

export type SyncKind = 'history' | 'charViews' | 'chat' | 'library'

export interface SyncMessage {
  /** 哪一类变了 */
  kind: SyncKind
  /** charViews 与 chat 要说清是哪个角色 —— 别的类的视图是整份的 */
  charId?: string
}

/**
 * 收拢一批广播。
 *
 * 一次生成会连着落盘好几条记录(每条一个槽),不合并的话对面要把历史重读
 * 好几遍;而重读一遍就是一次全表扫描。同类同角色只留一条。
 */
export function coalesceSync(messages: SyncMessage[]): SyncMessage[] {
  const seen = new Set<string>()
  const out: SyncMessage[] = []
  for (const m of messages) {
    const key = `${m.kind}:${m.charId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

/* 广播通道名。改它等于让新旧两个版本互相听不见(升级期间各开一个页面时
   会有一小段不同步),所以它跟着数据形状一起改,不单独动 */
const SYNC_CHANNEL = 'kimage.sync'
/* 收到消息后等一小会儿再处理:等的是一个批次攒齐,而不是让每条都触发一次重读 */
const SYNC_FLUSH_MS = 250

export interface SyncChannel {
  post(m: SyncMessage): void
  close(): void
}

/**
 * 开一个跨标签页通道。环境里没有 BroadcastChannel 时返回 null ——
 * 这只是"少了个便利",不该让整个应用起不来,所以是降级而不是报错。
 *
 * 注意广播**不会**送回给自己(BroadcastChannel 的规矩),所以不会自己触发自己。
 */
export function openSyncChannel(onBatch: (batch: SyncMessage[]) => void): SyncChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  let ch: BroadcastChannel
  try {
    ch = new BroadcastChannel(SYNC_CHANNEL)
  } catch {
    return null
  }
  let pending: SyncMessage[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  ch.onmessage = (e: MessageEvent) => {
    const m = e.data as SyncMessage | undefined
    if (!m || typeof m.kind !== 'string') return
    pending.push(m)
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      const batch = coalesceSync(pending)
      pending = []
      if (batch.length) onBatch(batch)
    }, SYNC_FLUSH_MS)
  }
  return {
    post(m) {
      try {
        ch.postMessage(m)
      } catch {
        /* 通道已关:这一次不同步而已,不该影响本页正在做的事 */
      }
    },
    close() {
      if (timer !== undefined) clearTimeout(timer)
      try {
        ch.close()
      } catch {
        /* ignore */
      }
    }
  }
}
