import { describe, expect, it } from 'vitest'
import { SYNC_KEYS, coalesceSync, syncTargetsOf } from './crossTab'
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

describe('syncTargetsOf · 哪个键该触发哪份目录重载', () => {
  it('配置列表与五类「当前生效」都归到 configs', () => {
    for (const k of [
      CONFIG_KEY,
      CONFIG_ACTIVE_KEY,
      TEXT_ACTIVE_KEY,
      CHAT_ACTIVE_KEY,
      VISION_ACTIVE_KEY,
      TTS_ACTIVE_KEY
    ]) {
      expect(syncTargetsOf(k)).toEqual(['configs'])
    }
  })

  it('角色 / 作品集 / 提示词各归各的', () => {
    expect(syncTargetsOf(CHAR_KEY)).toEqual(['characters'])
    expect(syncTargetsOf(COLL_KEY)).toEqual(['collections'])
    expect(syncTargetsOf(LIB_KEY)).toEqual(['prompts'])
  })

  it('key 为 null(另一个标签页 clear 了)时四份目录全部重载', () => {
    expect(syncTargetsOf(null).sort()).toEqual(
      ['characters', 'collections', 'configs', 'prompts'].sort()
    )
  })

  it('不关心的键(主题、别人的站点等等)什么都不触发', () => {
    expect(syncTargetsOf('kimage.theme')).toEqual([])
    expect(syncTargetsOf('some-other-app')).toEqual([])
    expect(syncTargetsOf('')).toEqual([])
  })

  /* 这条是防漂移的:SYNC_KEYS 里的字符串必须真的等于 api.ts 导出的键。
     将来谁改了键名而没动这里,这条会红 —— 而不是"同步悄悄不工作了" */
  it('SYNC_KEYS 里的键与 api.ts 的常量逐一对得上', () => {
    const flat = Object.values(SYNC_KEYS).flat()
    expect(flat).toContain(CONFIG_KEY)
    expect(flat).toContain(CHAR_KEY)
    expect(flat).toContain(COLL_KEY)
    expect(flat).toContain(LIB_KEY)
    // 每个键都必须是 kimage.* 命名空间下的,别把别的应用/别的用途的键卷进来
    for (const k of flat) expect(k.startsWith('kimage.')).toBe(true)
  })
})

/* —— 防漂移:新增的 localStorage 键必须进同步范围 ——
   这份检查读源码,而不是读运行时状态 —— 因为要抓的正是「有人加了一份新的
   覆盖写目录,却忘了把它加进 SYNC_KEYS」:那种情况下同步会静默失效,
   而不会有任何报错。宁可测试红一次,也不要"删掉的东西又回来"。 */
describe('同步范围 · 与源码里的写入点保持一致', () => {
  /* 已知的键常量 → 它是否需要跨标签页同步。
     THEME_KEY 是唯一故意不同步的:主题改了不影响数据的完整性,
     跟着别人切换主题反而突兀 */
  const KNOWN: Record<string, { key: string; synced: boolean }> = {
    CONFIG_KEY: { key: CONFIG_KEY, synced: true },
    CONFIG_ACTIVE_KEY: { key: CONFIG_ACTIVE_KEY, synced: true },
    TEXT_ACTIVE_KEY: { key: TEXT_ACTIVE_KEY, synced: true },
    CHAT_ACTIVE_KEY: { key: CHAT_ACTIVE_KEY, synced: true },
    VISION_ACTIVE_KEY: { key: VISION_ACTIVE_KEY, synced: true },
    TTS_ACTIVE_KEY: { key: TTS_ACTIVE_KEY, synced: true },
    COLL_KEY: { key: COLL_KEY, synced: true },
    CHAR_KEY: { key: CHAR_KEY, synced: true },
    LIB_KEY: { key: LIB_KEY, synced: true },
    THEME_KEY: { key: 'kimage.theme', synced: false },
    /* 沉浸模式(见 lib/prefs.ts)。与 THEME_KEY 同一类:它答的是"这台设备上
       这个人喜欢怎么看界面",丢了不影响任何数据的完整性;另一个标签页切了
       沉浸跟着一起变,反而突兀 */
    IMMERSIVE_KEY: { key: 'kimage.immersive', synced: false }
  }

  /* 用 Vite 的 import.meta.glob 把 src 下的源码按原文读进来,而不是 node:fs ——
     这个项目没有装 @types/node,而测试本来就跑在 Vite 里,glob 是它的自带能力。
     顺带省掉一个只在测试里用得上的依赖 */
  const SOURCES = import.meta.glob('../**/*.{ts,vue}', {
    query: '?raw',
    import: 'default',
    eager: true
  }) as Record<string, string>

  function sourceFiles(): string[] {
    return Object.entries(SOURCES)
      .filter(([path]) => !path.endsWith('.test.ts'))
      .map(([, code]) => code)
  }

  it('每个 localStorage.setItem 用的键都在已知表里,且该同步的确实同步了', () => {
    const tokens = new Set<string>()
    for (const code of sourceFiles()) {
      for (const m of code.matchAll(/localStorage\.setItem\(\s*([A-Za-z_$][\w$]*|'[^']*')/g)) {
        tokens.add(m[1])
      }
    }
    // 至少该扫到几个,否则说明正则或路径已经不对了(空集会让下面的断言假装通过)
    expect(tokens.size).toBeGreaterThan(3)

    const covered = new Set(Object.values(SYNC_KEYS).flat())
    for (const token of tokens) {
      if (token.startsWith("'")) {
        // 直接写了字面量的地方:必须能在同步范围里找到
        const literal = token.slice(1, -1)
        expect(covered.has(literal), `字面量键 ${literal} 不在 SYNC_KEYS 里`).toBe(true)
        continue
      }
      const known = KNOWN[token]
      expect(known, `新增的键常量 ${token} 未登记 —— 请把它加进 SYNC_KEYS 或 KNOWN 的非同步白名单`).toBeTruthy()
      if (known?.synced) {
        expect(covered.has(known.key), `${token} 声明要同步,但不在 SYNC_KEYS 里`).toBe(true)
      }
    }
  })
})

describe('coalesceSync · 一批广播怎么收拢', () => {
  it('同类同角色只留一条', () => {
    expect(
      coalesceSync([
        { kind: 'history' },
        { kind: 'history' },
        { kind: 'history' }
      ])
    ).toEqual([{ kind: 'history' }])
  })

  it('不同角色分开留 —— 那是两个角色各自的对话', () => {
    const out = coalesceSync([
      { kind: 'chat', charId: 'a' },
      { kind: 'chat', charId: 'b' },
      { kind: 'chat', charId: 'a' }
    ])
    expect(out).toEqual([
      { kind: 'chat', charId: 'a' },
      { kind: 'chat', charId: 'b' }
    ])
  })

  it('不同类分开留', () => {
    expect(coalesceSync([{ kind: 'history' }, { kind: 'library' }])).toHaveLength(2)
  })

  it('带 charId 与不带的算两条(后者表示"整类都变了")', () => {
    expect(coalesceSync([{ kind: 'charViews', charId: 'a' }, { kind: 'charViews' }])).toHaveLength(2)
  })

  it('顺序按首次出现,空批次给空数组', () => {
    expect(coalesceSync([{ kind: 'library' }, { kind: 'history' }]).map((m) => m.kind)).toEqual([
      'library',
      'history'
    ])
    expect(coalesceSync([])).toEqual([])
  })
})
