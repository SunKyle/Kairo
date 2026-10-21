import { describe, expect, it } from 'vitest'
import {
  chatMessageFromRow,
  isDeadConnectionError,
  orphanChatImages,
  planPrune,
  referencedChatImages,
  retryOnDeadConnection,
  shouldCheckStorage,
  songPreviewFromRow,
  type PruneCandidate
} from './idb'

/* 造一条候选记录。id 用时间戳序号,u 开头便于在断言里看清"
   第几条"—— createdAt 决定清理顺序,所以测试里两者保持一致 */
function rec(
  n: number,
  extra: { collectionId?: string; hasMarked?: boolean } = {}
): PruneCandidate {
  return { id: `e${n}`, createdAt: n, ...extra }
}

describe('planPrune · 该清哪些历史', () => {
  it('空间吃紧时从最旧的开始清,数量恰好是 count', () => {
    const all = [rec(1), rec(2), rec(3), rec(4), rec(5)]
    const { removedIds } = planPrune(all, 2)
    expect(removedIds).toEqual(['e1', 'e2'])
  })

  it('挂在作品集里的记录不参与清理', () => {
    const all = [rec(1), rec(2, { collectionId: 'c1' }), rec(3), rec(4)]
    const { removedIds } = planPrune(all, 2)
    // 第 2 条被保护,于是往后顺延到第 3 条 —— 清的数量仍是 2
    expect(removedIds).toEqual(['e1', 'e3'])
  })

  /* 这一条是本次修复的核心:修复前 .filter 只认 collectionId,
     最早的那条带标记记录会被当"最旧的"清掉 */
  it('含标记图的记录不参与清理,哪怕它是最旧的', () => {
    const all = [rec(1, { hasMarked: true }), rec(2), rec(3), rec(4)]
    const { removedIds } = planPrune(all, 2)
    expect(removedIds).not.toContain('e1')
    expect(removedIds).toEqual(['e2', 'e3'])
  })

  it('作品集与标记同时保护,清理窗口继续往后顺延', () => {
    const all = [
      rec(1, { hasMarked: true }),
      rec(2, { collectionId: 'c1' }),
      rec(3),
      rec(4),
      rec(5)
    ]
    const { removedIds } = planPrune(all, 2)
    expect(removedIds).toEqual(['e3', 'e4'])
  })

  it('keptMarked 只数"本来会被清、因标记而留下"的那些', () => {
    const all = [
      rec(1, { hasMarked: true }),
      rec(2),
      rec(3, { hasMarked: true }),
      rec(4)
    ]
    // count=2:本来会清 e1、e2;其中 e1 靠标记留下来
    expect(planPrune(all, 2).keptMarked).toBe(1)
    // 标记的那条排在很新(count=1 只涉及 e1),没有"多留一命"这回事
    const fresh = [rec(1), rec(2), rec(3, { hasMarked: true })]
    expect(planPrune(fresh, 1).keptMarked).toBe(0)
  })

  it('候选全被保护时,一条都不清(宁可空间吃紧)', () => {
    const all = [rec(1, { hasMarked: true }), rec(2, { collectionId: 'c1' })]
    const { removedIds } = planPrune(all, 2)
    expect(removedIds).toEqual([])
  })

  it('count 为 0 或负数时不清任何东西', () => {
    const all = [rec(1), rec(2)]
    expect(planPrune(all, 0)).toEqual({ removedIds: [], keptMarked: 0 })
    expect(planPrune(all, -3)).toEqual({ removedIds: [], keptMarked: 0 })
  })

  it('要清的比能清的还多时,只清到没有候选为止(不清空历史)', () => {
    const all = [rec(1), rec(2, { hasMarked: true })]
    expect(planPrune(all, 10).removedIds).toEqual(['e1'])
  })

  it('输入顺序不影响结果(内部按时间排)', () => {
    const asc = [rec(1), rec(2), rec(3), rec(4)]
    const shuffled = [rec(3), rec(1), rec(4), rec(2)]
    expect(planPrune(shuffled, 2).removedIds).toEqual(planPrune(asc, 2).removedIds)
  })

  it('不修改传入的数组', () => {
    const all = [rec(3), rec(1), rec(2)]
    const before = all.map((r) => r.id)
    planPrune(all, 1)
    expect(all.map((r) => r.id)).toEqual(before)
  })
})

describe('shouldCheckStorage · 体检节奏', () => {
  it('本会话第一次写入必查', () => {
    expect(shouldCheckStorage(1_000, 0, 0)).toBe(true)
  })

  it('刚查过、又没攒够条数就不查', () => {
    // 距上次 1 秒,才写了 3 条
    expect(shouldCheckStorage(1_000, 0 + 1_000, 3)).toBe(false)
  })

  it('攒够 20 条就提前查(不必等满 30 秒)', () => {
    expect(shouldCheckStorage(1_000, 1_000, 20)).toBe(true)
  })

  it('隔满 30 秒就查(哪怕只写了 1 条)', () => {
    expect(shouldCheckStorage(31_000, 1_000, 1)).toBe(true)
  })

  it('边界:差 1 毫秒不查,正好到点就查', () => {
    expect(shouldCheckStorage(1_000 + 29_999, 1_000, 1)).toBe(false)
    expect(shouldCheckStorage(1_000 + 30_000, 1_000, 1)).toBe(true)
  })

  it('节流参数可覆盖(便于将来按场景调整)', () => {
    expect(shouldCheckStorage(2_000, 1_000, 5, 1_000, 5)).toBe(true)
    expect(shouldCheckStorage(1_500, 1_000, 4, 1_000, 5)).toBe(false)
  })
})

/* ===== A1 缓存连接的健壮性 =====
   把连接改成缓存之后，"连接意外关闭"这条路上必须能自愈 ——
   否则后续每一次读写都打在死连接上，而每一处调用都把失败 catch 成"空"，
   在用户眼里就是"我的东西全没了" */

describe('isDeadConnectionError · 什么算“连接已死”', () => {
  it('认 InvalidStateError（在死连接上建事务时的报法）', () => {
    expect(isDeadConnectionError({ name: 'InvalidStateError' })).toBe(true)
  })

  it('也认 DatabaseClosedError（个别实现的叫法）', () => {
    expect(isDeadConnectionError({ name: 'DatabaseClosedError' })).toBe(true)
  })

  it('别的错误不算 —— 那些重试也没用，重试会把一次失败变成一次挂死', () => {
    for (const name of ['AbortError', 'QuotaExceededError', 'VersionError', 'UnknownError']) {
      expect(isDeadConnectionError({ name }), name).toBe(false)
    }
  })

  it('退化输入不抛异常', () => {
    expect(isDeadConnectionError(null)).toBe(false)
    expect(isDeadConnectionError(undefined)).toBe(false)
    expect(isDeadConnectionError('boom')).toBe(false)
    expect(isDeadConnectionError(new Error('x'))).toBe(false)
  })
})

describe('retryOnDeadConnection · 连接死了就重开一次', () => {
  const dead = () => Object.assign(new Error('dead'), { name: 'InvalidStateError' })
  const fakeDB = (tag: string) => ({ tag }) as unknown as IDBDatabase

  it('一切正常时只取一次连接、只跑一次', async () => {
    let opens = 0
    const res = await retryOnDeadConnection(
      async () => { opens++; return fakeDB('a') },
      () => {},
      (db) => (db as unknown as { tag: string }).tag
    )
    expect(res).toBe('a')
    expect(opens).toBe(1)
  })

  it('连接已死：清缓存、重开、再跑一次并成功', async () => {
    let opens = 0
    let resets = 0
    const res = await retryOnDeadConnection(
      async () => { opens++; return fakeDB(opens === 1 ? 'dead' : 'fresh') },
      () => { resets++ },
      (db) => {
        if ((db as unknown as { tag: string }).tag === 'dead') throw dead()
        return (db as unknown as { tag: string }).tag
      }
    )
    expect(res).toBe('fresh')
    expect(resets).toBe(1)
    expect(opens).toBe(2)
  })

  it('重试仍失败就如实抛出（不无限重试）', async () => {
    let opens = 0
    await expect(
      retryOnDeadConnection(
        async () => { opens++; return fakeDB('dead') },
        () => {},
        () => { throw dead() }
      )
    ).rejects.toThrow('dead')
    expect(opens).toBe(2) // 只重开一次
  })

  it('不是“连接已死”的错误直接抛，不清缓存也不重开', async () => {
    let opens = 0
    let resets = 0
    const boom = Object.assign(new Error('bad data'), { name: 'DataError' })
    await expect(
      retryOnDeadConnection(
        async () => { opens++; return fakeDB('a') },
        () => { resets++ },
        () => { throw boom }
      )
    ).rejects.toThrow('bad data')
    expect(opens).toBe(1)
    expect(resets).toBe(0)
  })

  it('run 返回 promise 时，异步失败同样触发重试', async () => {
    let opens = 0
    const res = await retryOnDeadConnection(
      async () => { opens++; return fakeDB(opens === 1 ? 'dead' : 'fresh') },
      () => {},
      async (db) => {
        if ((db as unknown as { tag: string }).tag === 'dead') throw dead()
        return 'ok'
      }
    )
    expect(res).toBe('ok')
    expect(opens).toBe(2)
  })
})

/* ===== 聊天附图的归属 =====
   这两个函数决定"删不删用户的字节":清空对话、删角色、空间体检都要用它。
   从前漏得比较彻底 —— 只收内存里那一档(最近 200 条)的 imageId,
   而角色发的图(photoId)一张都没回收过。 */

describe('referencedChatImages · 消息还指着哪些图', () => {
  it('imageId 与 photoId 都算 —— 一个是对方发来的,一个是它给你的', () => {
    const refs = referencedChatImages([
      { imageId: 'u1' },
      { photoId: 'p1' },
      { imageId: 'u2', photoId: 'p2' }
    ])
    expect([...refs].sort()).toEqual(['p1', 'p2', 'u1', 'u2'])
  })

  it('同一条消息带两张、或两条消息指着同一张,都只算一次', () => {
    expect([...referencedChatImages([{ imageId: 'x', photoId: 'x' }])]).toEqual(['x'])
    expect(referencedChatImages([{ imageId: 'x' }, { imageId: 'x' }]).size).toBe(1)
  })

  it('没有图的、以及空串/undefined 的字段都跳过', () => {
    expect(referencedChatImages([{}, { imageId: '' }, { photoId: undefined }]).size).toBe(0)
  })

  it('空列表给空集合(不抛)', () => {
    expect(referencedChatImages([]).size).toBe(0)
  })
})

describe('orphanChatImages · 哪些图已经没人认领', () => {
  it('只有没人指着的那几张被交出来', () => {
    const refs = new Set(['keep1', 'keep2'])
    expect(orphanChatImages(refs, ['keep1', 'gone1', 'keep2', 'gone2'])).toEqual([
      'gone1',
      'gone2'
    ])
  })

  it('一张都没被引用时,库里那些全是孤儿', () => {
    expect(orphanChatImages(new Set(), ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('全都被引用时一个都不删 —— 删了那些对话就只剩一句话', () => {
    expect(orphanChatImages(new Set(['a', 'b']), ['a', 'b'])).toEqual([])
  })

  it('库里是空的时什么都不做', () => {
    expect(orphanChatImages(new Set(['a']), [])).toEqual([])
  })

  it('保序:交出来的顺序与库里的键一致(便于调用方直接遍历删)', () => {
    expect(orphanChatImages(new Set(['b']), ['c', 'a', 'b'])).toEqual(['c', 'a'])
  })
})

/* ===== 从库里读出来的一行消息 ==========================================
 *  消息是结构化克隆存的,字段不会丢;但库里的内容可能来自更早的版本、
 *  被同步工具改过、或被一份手工拼的导入包写坏。而 `photoError` 会被
 *  **直接渲染在界面上**,一个不是字符串的值就够让那一格显示成
 *  `[object Object]` 或撑爆布局。 */

describe('chatMessageFromRow · 只收会被渲染的那一项', () => {
  const base = { id: 'm1', charId: 'c1', role: 'assistant', content: 'hi', createdAt: 1 }

  it('正常的行原样返回,不做多余拷贝', () => {
    const m = { ...base, photoError: 'Upstream returned 500' }
    expect(chatMessageFromRow(m)).toBe(m)
  })

  it('没有这一项时也不新造对象', () => {
    expect(chatMessageFromRow(base)).toBe(base)
  })

  it('不是字符串的值被抹掉 —— 它会被渲染出来', () => {
    expect(chatMessageFromRow({ ...base, photoError: { bad: true } }).photoError).toBeUndefined()
    expect(chatMessageFromRow({ ...base, photoError: 42 }).photoError).toBeUndefined()
  })

  it('超长的截断', () => {
    const long = 'x'.repeat(1000)
    expect(chatMessageFromRow({ ...base, photoError: long }).photoError?.length).toBe(300)
  })

  it('附件在读出时再收一次:坏地址整块丢掉,合法地址被归一化', () => {
    const bad = chatMessageFromRow({
      ...base,
      attachment: { kind: 'link', title: 'x', url: 'http://localhost:3101/x' }
    })
    expect(bad.attachment).toBeUndefined()

    const good = chatMessageFromRow({
      ...base,
      attachment: {
        kind: 'link',
        title: '  A  post ',
        url: 'https://www.example.com/x',
        preview: { description: ' the gist ' }
      }
    })
    expect(good.attachment).toEqual({
      kind: 'link',
      title: 'A post',
      url: 'https://www.example.com/x',
      preview: { description: 'the gist' }
    })
  })

  it('音乐卡在读出时同样收一次:坏地址只丢地址、留住卡,没地址也照样是一条消息', () => {
    /* 曲名是本体:地址过不了不该把整张卡带走 —— 这和链接恰好相反 */
    const badUrl = chatMessageFromRow({
      ...base,
      attachment: { kind: 'music', title: 'Night Changes', subtitle: 'Harry Styles', url: 'http://127.0.0.1:9/x' }
    })
    expect(badUrl.attachment).toEqual({ kind: 'music', title: 'Night Changes', subtitle: 'Harry Styles' })

    const noUrl = chatMessageFromRow({
      ...base,
      attachment: { kind: 'music', title: '  Solo  ' }
    })
    expect(noUrl.attachment).toEqual({ kind: 'music', title: 'Solo' })

    /* 只剩一个空壳(没标题)才是真的没东西可展示 —— 整块丢 */
    const noTitle = chatMessageFromRow({
      ...base,
      attachment: { kind: 'music', url: 'https://www.example.com/song' }
    })
    expect(noTitle.attachment).toBeUndefined()
  })

  it('退化输入不抛', () => {
    expect(chatMessageFromRow(null)).toBe(null)
    expect(chatMessageFromRow(undefined)).toBe(undefined)
  })
})

/* ===== 试听地址从库里出来时的收口 ======================================
 *  这条地址会被直接设成 <audio> 的 src,所以它是这一层最该管住的一项:
 *  一个 javascript: / file: 地址不该有机会走到播放器面前。其余字段只是
 *  显示与外链,坏了就丢那一项,不该把整条缓存判死 —— 判死的代价是
 *  每次打开对话都要重新搜一遍。 */

describe('songPreviewFromRow · 试听记录只留能用的部分', () => {
  const row = {
    key: '晴天|周杰伦',
    previewUrl: 'https://audio.example/a.m4a',
    trackName: '晴天',
    artistName: '周杰倫',
    trackViewUrl: 'https://music.apple.com/hk/song/1',
    createdAt: 1_700_000_000_000
  }

  it('正常的行原样收下,usedAt 缺省时用 createdAt 补', () => {
    expect(songPreviewFromRow(row)).toEqual({ ...row, usedAt: row.createdAt })
  })

  it('负结果(只记了 missing)是合法的一条,不需要地址', () => {
    expect(songPreviewFromRow({ key: 'x|y', missing: true, createdAt: 5 })).toEqual({
      key: 'x|y',
      missing: true,
      createdAt: 5,
      usedAt: 5
    })
  })

  it('key 或 createdAt 不合法时整条作废 —— 没有主键就无从谈起', () => {
    expect(songPreviewFromRow(null)).toBeUndefined()
    expect(songPreviewFromRow(undefined)).toBeUndefined()
    expect(songPreviewFromRow('x')).toBeUndefined()
    expect(songPreviewFromRow({ ...row, key: '' })).toBeUndefined()
    expect(songPreviewFromRow({ ...row, createdAt: Number.NaN })).toBeUndefined()
    expect(songPreviewFromRow({ ...row, createdAt: '1' })).toBeUndefined()
  })

  it('不是 http(s) 的试听地址整条丢掉 —— 它会被交给 <audio>', () => {
    expect(songPreviewFromRow({ ...row, previewUrl: 'javascript:alert(1)' })).toBeUndefined()
    expect(songPreviewFromRow({ ...row, previewUrl: 'file:///etc/passwd' })).toBeUndefined()
    expect(songPreviewFromRow({ ...row, previewUrl: '' })).toBeUndefined()
  })

  it('trackViewUrl 坏掉只丢这一项,卡本身仍然有效', () => {
    expect(songPreviewFromRow({ ...row, trackViewUrl: 'file:///x' })?.trackViewUrl).toBeUndefined()
    expect(songPreviewFromRow({ ...row, trackViewUrl: 42 })?.trackViewUrl).toBeUndefined()
  })

  it('曲名/歌手不是非空字符串时不带出去(显示回落由调用方负责)', () => {
    expect(songPreviewFromRow({ ...row, trackName: '   ' })?.trackName).toBeUndefined()
    expect(songPreviewFromRow({ ...row, artistName: 99 })?.artistName).toBeUndefined()
  })
})
