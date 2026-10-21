import { describe, expect, it } from 'vitest'
import {
  artistOf,
  baseTitle,
  bestSongMatch,
  matchSong,
  songKey,
  songQuery,
  trustedCjkTopHit,
  usableSongPreview,
  type SongCandidate
} from './songPreview'

/* 搜索结果里的曲名/歌手是外部输入,而这张卡片会直接把它交给 <audio>。
   这里测的都是"哪一条才是这首"的判据 —— 判错的代价不是难看,
   是替用户放了一首别人的歌。 */

describe('songKey · 同一首歌落到同一条缓存上', () => {
  it('大小写、多余空白、全半角都拉平', () => {
    expect(songKey('  Shape  of You ', 'Ed Sheeran')).toBe(
      songKey('shape of you', 'ed sheeran')
    )
    expect(songKey('ＳＨＡＰＥ', 'ED')).toBe(songKey('shape', 'ed'))
  })

  it('歌手写成 "by X" 与只写 X 是同一个键', () => {
    expect(songKey('轨迹', 'by 周杰伦')).toBe(songKey('轨迹', '周杰伦'))
  })

  it('版本注记保留在键里 —— 原版与 live 可以是两条不同的试听', () => {
    expect(songKey('Song', 'X')).not.toBe(songKey('Song (Live)', 'X'))
  })
})

describe('artistOf / baseTitle · 比较前的收口', () => {
  it('剥掉歌手前面的 by / artist:', () => {
    expect(artistOf('by 周杰伦')).toBe('周杰伦')
    expect(artistOf('Artist: Radiohead')).toBe('Radiohead')
    expect(artistOf('周杰伦')).toBe('周杰伦')
    expect(artistOf('')).toBe('')
  })

  it('去掉括号里的版本注记与横线后缀,但不动 "Live Forever" 这种正名', () => {
    expect(baseTitle('Shape of You (Acoustic)')).toBe('shape of you')
    expect(baseTitle('晴天 - Remastered 2011')).toBe('晴天')
    expect(baseTitle('Live Forever')).toBe('live forever')
  })
})

describe('matchSong · 哪一条结果才是这首', () => {
  it('曲名与歌手完全相等 = 1', () => {
    expect(matchSong('Shape of You', 'Ed Sheeran', 'Shape of You', 'Ed Sheeran')).toBeCloseTo(
      1,
      5
    )
  })

  it('带 Remastered 尾巴的仍是原版,但比完全相等的低一点', () => {
    const exact = matchSong('Shape of You', 'Ed Sheeran', 'Shape of You', 'Ed Sheeran')
    const remaster = matchSong(
      'Shape of You',
      'Ed Sheeran',
      'Shape of You - Remastered',
      'Ed Sheeran'
    )
    expect(remaster).toBeGreaterThan(0.9)
    expect(remaster).toBeLessThan(exact)
  })

  it('原版赢过 remix 与 live —— 用户点的是歌名,不是混音清单', () => {
    const original = matchSong('Shape of You', 'Ed Sheeran', 'Shape of You', 'Ed Sheeran')
    const remix = matchSong(
      'Shape of You',
      'Ed Sheeran',
      'Shape of You (NOTD Remix)',
      'Ed Sheeran'
    )
    const live = matchSong('晴天', '周杰伦', '晴天 (Live)', '周杰倫')
    expect(original).toBeGreaterThan(remix)
    expect(matchSong('晴天', '周杰伦', '晴天', '周杰倫')).toBeGreaterThan(live)
  })

  it('目标本身就是 live 时不再罚它', () => {
    expect(matchSong('Song (Live)', 'X', 'Song (Live)', 'X')).toBeCloseTo(1, 5)
  })

  it('繁简差异靠共用字判:富士山下 / 告白气球都认得出来', () => {
    expect(matchSong('富士山下', '陈奕迅', '富士山下', '陳奕迅')).toBeGreaterThan(0.85)
    expect(matchSong('告白气球', '周杰伦', '告白氣球', '周杰倫')).toBeGreaterThan(0.7)
  })

  it('逐字都不共用的繁简标题交给"榜首可信"通道,而不是 matchSong', () => {
    // 轨迹 vs 軌跡:一个字都不共用,单靠 matchSong 必判死 —— 这条锁住现状,
    // 免得有人把下面那条窄门删了还不知道它挡的是什么
    expect(matchSong('轨迹', '周杰伦', '軌跡', '周杰倫')).toBe(0)
  })

  it('歌手对不上直接判 0 —— 不替用户放翻唱', () => {
    expect(matchSong('Yellow', 'Coldplay', 'Yellow', 'Cigarettes After Sex')).toBe(0)
    expect(
      matchSong('Motion Picture Soundtrack', 'Radiohead', 'Motion Picture Soundtrack', 'Cigarettes After Sex')
    ).toBe(0)
  })

  it('同一位歌手的另一首歌也不认', () => {
    expect(matchSong('轨迹', '周杰伦', '晴天', '周杰倫')).toBe(0)
  })

  it('只有曲名时只认主标题相等,不认包含关系', () => {
    expect(matchSong('Yellow', '', 'Yellow', 'Coldplay')).toBeGreaterThan(0.9)
    expect(matchSong('Yellow', '', 'Yellow Submarine', 'The Beatles')).toBe(0)
  })
})

describe('trustedCjkTopHit · 繁简榜首那条窄门', () => {
  it('曲名字数相同、歌手高度重合的第一条放行', () => {
    expect(trustedCjkTopHit('轨迹', '周杰伦', '軌跡', '周杰倫')).toBe(true)
    expect(trustedCjkTopHit('告白气球', '周杰伦', '告白氣球', '周杰倫')).toBe(true)
  })

  it('歌手对不上、字数不同、或不是 CJK 都不放行', () => {
    expect(trustedCjkTopHit('轨迹', '周杰伦', '軌跡', '五月天')).toBe(false)
    expect(trustedCjkTopHit('轨迹', '周杰伦', '軌跡 (Live)', '周杰倫')).toBe(false)
    expect(trustedCjkTopHit('Yellow', 'Coldplay', 'Yellow', 'Coldplay')).toBe(false)
  })
})

describe('bestSongMatch · 从候选里挑一条', () => {
  const hit = (trackName: string, artistName: string) => ({
    trackName,
    artistName,
    previewUrl: 'https://audio.example/preview.m4a',
    trackViewUrl: 'https://music.apple.com/hk/song/1'
  })

  it('有原版时选原版,不选后面的 live / 翻唱', () => {
    const results: SongCandidate[] = [
      hit('晴天', '周杰倫'),
      hit('晴天 (Live)', '周杰倫'),
      hit('晴天', '五月天')
    ]
    // 第一条就是原版(它同时满足完全相等);翻唱因歌手对不上被拒
    expect(bestSongMatch(results, '晴天', '周杰伦')?.trackName).toBe('晴天')
  })

  it('逐字不共用的繁简结果,若是第一条就收下', () => {
    const results: SongCandidate[] = [hit('軌跡', '周杰倫'), hit('晴天', '周杰倫')]
    const found = bestSongMatch(results, '轨迹', '周杰伦')
    expect(found?.trackName).toBe('軌跡')
    expect(found?.previewUrl).toBe('https://audio.example/preview.m4a')
  })

  it('同样的条目排到第二条就不再信任', () => {
    const results: SongCandidate[] = [hit('晴天', '五月天'), hit('軌跡', '周杰倫')]
    // 第一条是完全无关的另一首;第二条本来可信,但它不在榜首 —— 窄门只开给第一条
    expect(bestSongMatch(results, '轨迹', '周杰伦')).toBeNull()
  })

  it('没有 http(s) 试听地址的条目直接跳过', () => {
    const results: SongCandidate[] = [
      { ...hit('晴天', '周杰倫'), previewUrl: 'javascript:alert(1)' }
    ]
    expect(bestSongMatch(results, '晴天', '周杰伦')).toBeNull()
  })

  it('trackViewUrl 不是 http(s) 时不带出去', () => {
    const results: SongCandidate[] = [
      { ...hit('晴天', '周杰倫'), trackViewUrl: 'file:///etc/passwd' }
    ]
    expect(bestSongMatch(results, '晴天', '周杰伦')?.trackViewUrl).toBeUndefined()
  })
})

describe('usableSongPreview · 缓存还算不算数', () => {
  const now = 1_000_000_000
  const hit = {
    key: 'song|x',
    previewUrl: 'https://audio.example/a.m4a',
    createdAt: now - 1000
  }

  it('正结果 7 天内有效', () => {
    expect(usableSongPreview(hit, now)).toBe(true)
    expect(usableSongPreview({ ...hit, createdAt: now - 8 * 24 * 3600 * 1000 }, now)).toBe(false)
  })

  it('负结果只记 24 小时 —— 目录会补歌', () => {
    const miss = { key: 'song|x', missing: true as const, createdAt: now - 1000 }
    expect(usableSongPreview(miss, now)).toBe(true)
    expect(usableSongPreview({ ...miss, createdAt: now - 25 * 3600 * 1000 }, now)).toBe(false)
  })

  it('形状不对、地址不合法的一律当没有', () => {
    expect(usableSongPreview(undefined, now)).toBe(false)
    expect(usableSongPreview({ ...hit, previewUrl: 'ftp://x/a.m4a' }, now)).toBe(false)
    expect(usableSongPreview({ ...hit, createdAt: Number.NaN }, now)).toBe(false)
  })

  it('系统时间被改到过去时当作刚写入,不因时钟歪了而作废', () => {
    expect(usableSongPreview({ ...hit, createdAt: now + 10_000 }, now)).toBe(true)
  })
})

describe('songQuery · 发给 iTunes 的那一句', () => {
  it('曲名与歌手一起去,歌手剥掉 by', () => {
    expect(songQuery('Shape of You', 'by Ed Sheeran')).toBe('shape of you ed sheeran')
  })

  it('曲名去掉版本注记,避免搜出一堆 live', () => {
    expect(songQuery('Song (Live)', 'X')).toBe('song x')
    expect(songQuery('晴天 - Remastered 2011', '周杰伦')).toBe('晴天 周杰伦')
  })
})
