import { reactive, ref, toRaw } from 'vue'
import { CHAT_WINDOW, extractMemories, uid } from '../api'
import { deleteMemory, getAllMemories, getChatMessages, getChatSummary, putMemory } from '../lib/idb'
import { categoryNeedsChar, freshExtracted, memoryLines, parseExtractedMemories, selectMemories } from '../lib/memory'
import type { ApiConfig, Character, MemoryCategory, MemoryItem } from '../types'

/* ===== 记忆条目这一域(PRD §3.2-E / F) ================================
   非流式的一半:读、写、标记、授权、以及"从对话里抽几条"。
   抽出来放这里而不是留在主界面,理由与 useChat / useHistory 一样:
   主界面只做装配,业务状态按域收在 composable 里。

   它与 useChat 的 chatSummary 是**两条平行的线**,刻意不互相引用:
   - chatSummary 是"这一整段对话的压缩纪要"(机制性的,随对话走);
   - memories 是"一条条独立的事实"(用户可管的,跨对话留)。
   抽取时把纪要当"它已经记得什么"读一次(免得重复抽同一件事),
   但两者不共享任何状态 —— 合并会让"忘掉这条"与"重压这段"变成同一个动作。
   -------------------------------------------------------------------- */

/** 抽取时往前看多少条消息。比对话窗口大一档:抽取要的是"这段关系里
 *  有什么值得记",而不只是"最近聊了什么" */
const EXTRACT_WINDOW = CHAT_WINDOW * 2

export interface MemoryDeps {
  characters: { value: Character[] }
  /* 抽取要用对话那条模型配置 —— 与压记忆同一条理由:它该和回话用同一个脑子 */
  chatConfig: { value: ApiConfig | null }
  notice: { value: string }
  /** 告诉其他标签页"记忆变了"(见 lib/crossTab.ts)。
   *  **不带 charId**:共享画像一改,所有角色的可见范围都变了 */
  announce: (kind: 'memories', charId?: string) => void
  scheduleUndo: (item: { label: string; undo: () => void; purge: () => void }) => void
}

export function useMemories(deps: MemoryDeps) {
  /* 全部记忆条目(含共享画像)。条数是几十的量级,所以整份持有、
     由界面按分类/角色去筛 —— 不必为它做分页或索引查询 */
  const memories = ref<MemoryItem[]>([])
  /* 正在抽取的角色。同一时刻一个角色只该有一个抽取在跑(与 chatSummarizing 同一条)。
     用 reactive 的 Set 而不是普通 Set:记忆中心那枚"整理一下"按钮要拿它做忙碌态,
     而普通 Set 的增删不会触发任何重渲染 */
  const extracting = reactive(new Set<string>())

  /** 从库里重读全部记忆。读不出来当空 —— 记忆中心空着,好过整页打不开 */
  async function loadMemories() {
    memories.value = await getAllMemories()
  }

  /** 库里的原始对象不能带 Vue 的响应式代理进去(idb 只吃纯对象) */
  function plain(m: MemoryItem): MemoryItem {
    return { ...toRaw(m) }
  }

  function replace(updated: MemoryItem) {
    memories.value = memories.value.map((m) => (m.id === updated.id ? updated : m))
  }

  /** 手写一条。用户自己加的,来源就是 'user' —— 那是他说的,不是谁猜的 */
  async function addMemory(input: {
    charId: string | null
    category: MemoryCategory
    text: string
    note?: string
  }): Promise<MemoryItem | null> {
    const text = input.text.trim()
    if (!text) return null
    /* 角色专属 / 事件计划**必须挂在某个角色上**。挂空了会变成一条
       "谁都看不到"的孤条目 —— charId 是 null 而分类又不是 profile,
       selectMemories 里两条分支都不认它。界面已经拦过一道(canSubmit),
       这里再收一次:它是数据入口,不该只靠调用方自觉 */
    if (categoryNeedsChar(input.category) && !input.charId) return null
    const now = Date.now()
    const item: MemoryItem = {
      id: uid(),
      /* 共享画像没有主人:它不是"跟谁的记忆",是"关于用户的事"。
         界面传 null 进来时按分类兜一道,免得 profile 被挂到某个角色名下 */
      charId: input.category === 'profile' ? null : input.charId,
      category: input.category,
      text,
      origin: 'user',
      important: false,
      ...(input.note ? { note: input.note } : {}),
      createdAt: now,
      updatedAt: now
    }
    memories.value = [item, ...memories.value]
    try {
      await putMemory(plain(item))
    } catch (e) {
      console.error('[Kairo] save memory failed', e)
      deps.notice.value = 'Could not save that memory.'
      return null
    }
    deps.announce('memories')
    return item
  }

  /** 改一条的正文 */
  async function editMemory(id: string, text: string) {
    const cur = memories.value.find((m) => m.id === id)
    const next = text.trim()
    if (!cur || !next || next === cur.text) return
    const updated: MemoryItem = { ...plain(cur), text: next, updatedAt: Date.now() }
    replace(updated)
    await putMemory(updated)
    deps.announce('memories')
  }

  /** 标记重要。它同时意味着"不参与任何自动清理" */
  async function setImportant(id: string, on: boolean) {
    const cur = memories.value.find((m) => m.id === id)
    if (!cur || cur.important === on) return
    const updated: MemoryItem = { ...plain(cur), important: on, updatedAt: Date.now() }
    replace(updated)
    await putMemory(updated)
    deps.announce('memories')
  }

  /** 授权 / 撤销跨角色共享。**只有共享画像用得上** ——
   *  角色专属记忆永远私有,界面上也不该给它这个开关 */
  async function setShared(id: string, on: boolean) {
    const cur = memories.value.find((m) => m.id === id)
    if (!cur || cur.category !== 'profile' || cur.shared === on) return
    const updated: MemoryItem = { ...plain(cur), ...(on ? { shared: true } : { shared: false }), updatedAt: Date.now() }
    replace(updated)
    await putMemory(updated)
    deps.announce('memories')
  }

  /* 删一条。**立刻生效 + 撤销窗 + purge 才真删** —— 全站删除同一条规矩
     (见 useFeedback)。记忆尤其经不起误删:它是模型写的,撤销窗一过就找不回来了 */
  function removeMemory(id: string) {
    const cur = memories.value.find((m) => m.id === id)
    if (!cur) return
    const snapshot = plain(cur)
    const at = memories.value.findIndex((m) => m.id === id)
    memories.value = memories.value.filter((m) => m.id !== id)
    deps.scheduleUndo({
      label: 'Memory removed',
      undo: () => {
        memories.value = [
          ...memories.value.slice(0, at),
          snapshot,
          ...memories.value.slice(at)
        ]
        void putMemory(snapshot)
      },
      purge: () => {
        void deleteMemory(id)
          .then(() => deps.announce('memories'))
          .catch((e) => {
            console.error('[Kairo] remove memory: saved data was not removed', e)
          })
      }
    })
  }

  /**
   * 从最近这段对话里抽几条值得记的(PRD §3.2-E 的"AI 自动判断")。
   *
   * **静默**:与压记忆同一条 —— 它是一次后台整理,失败就退出,不弹提示、
   * 也不影响任何已经落盘的东西(用户不该因为一次整理没成而被打断)。
   * 返回这一次新记了几条(手动触发那条路拿它显示结果)。
   */
  async function runExtract(charId: string, messages: { role: string; content: string }[]): Promise<number> {
    const cfg = deps.chatConfig.value
    if (!cfg || !cfg.model.trim() || !cfg.baseUrl.trim()) return 0
    if (extracting.has(charId) || !messages.length) return 0
    extracting.add(charId)
    try {
      const summary = await getChatSummary(charId)
      /* 把它"已经记得的"一起告诉模型:否则同一件事会被抽第二遍 ——
         抽取是尽力而为,重复入库却会永久留在记忆中心里 */
      const known = [
        summary?.text || '',
        ...memoryLines(selectMemories(memories.value, charId))
      ]
        .filter(Boolean)
        .join('\n')
      const raw = await extractMemories(cfg, messages, known)
      const picked = freshExtracted(parseExtractedMemories(raw), memories.value, charId)
      if (!picked.length) return 0
      const now = Date.now()
      const items: MemoryItem[] = picked.map((e) => ({
        id: uid(),
        /* 画像不挂人:它是"关于用户"的,不属于这段关系(见 types 的 MemoryItem.charId) */
        charId: e.category === 'profile' ? null : charId,
        category: e.category,
        text: e.text,
        origin: e.origin,
        important: false,
        createdAt: now,
        updatedAt: now
      }))
      memories.value = [...items, ...memories.value]
      await Promise.all(items.map((m) => putMemory(m)))
      deps.announce('memories')
      return items.length
    } catch (e) {
      console.error('[Kairo] memory extraction failed', e)
      return 0
    } finally {
      extracting.delete(charId)
    }
  }

  /** 手动触发(记忆中心那枚"整理一下"):从库里读最近一窗消息 */
  async function extractNow(charId: string): Promise<number> {
    const { list } = await getChatMessages(charId, EXTRACT_WINDOW)
    if (!list.length) return 0
    return runExtract(
      charId,
      list.map((m) => ({ role: m.role, content: m.content }))
    )
  }

  /** 自动触发:压完记忆那一步顺手跑一次,复用同一批消息,不额外读盘 */
  async function autoExtract(charId: string, batch: { role: string; content: string }[]): Promise<void> {
    await runExtract(charId, batch)
  }

  return {
    memories,
    /* 正在抽取的角色集合(响应式)。界面拿它做按钮的忙碌态 ——
       没有它的话,点一次"整理一下"到结果出来之间界面毫无反应,
       而这一步要打一次模型,快不了 */
    extracting,
    loadMemories,
    addMemory,
    editMemory,
    setImportant,
    setShared,
    removeMemory,
    extractNow,
    autoExtract
  }
}
