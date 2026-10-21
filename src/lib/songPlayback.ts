/* ===== 歌卡的声音:一个页面只有一个 <audio>,一张卡只有一枚按钮 =====
 *
 *  这一层管三件事,而且刻意都不在组件里:
 *
 *  1. **一次只放一首**。音频元素是模块级单例 —— 不是每张卡一个 <audio>
 *     (那会有 N 个元素同时出声),也不是一个全局播放器组件(卡片散在消息流里,
 *     播放状态必须能回到它自己那张卡上)。点第二张时,第一张自然回到闲置态:
 *     它的键不再等于 currentKey。
 *  2. **四态是同一张卡的四种时刻**:idle → loading → playing ⇄ paused,
 *     找不到/放不出来落到 unavailable。进度只属于"当前这张卡",
 *     别的卡读到的永远是 0。
 *  3. **与朗读互斥**。角色刚念完一句话,不该紧接着又有一首歌在响;
 *     反过来聊天页开始朗读时会先调 stopSongPreview(见 ChatPage)。
 *     这里主动停朗读,是因为"点歌"这个动作比"它还张着嘴"更明确。
 *
 *  硬不变量(单例、一次一首、地址失效作废)留在模块级;能直接测的纯函数
 *  (formatSongTime / progressFraction)单独导出,见 songPlayback.test.ts。
 *  组件只拿 useSongPreview 返回的那几个 ref —— 它不碰 Audio,也不判断状态。
 * ------------------------------------------------------------------ */
import { computed, reactive, ref, type ComputedRef } from 'vue'
import { deleteSongPreview } from './idb'
import { lookupSongPreview, songKey, type SongPreview } from './songPreview'
import { stopSpeaking } from './speech'

/** 一张歌卡此刻的样子。paused 与 idle 的区别:
 *  paused 有位置、有已加载的音频,点一下续播;idle 什么都没开始。 */
export type SongCardState = 'idle' | 'loading' | 'playing' | 'paused' | 'unavailable'

/** 正在出声 / 正在等待的是哪首。空串 = 没有。 */
const currentKey = ref('')
/** 当前这首的状态。只有 currentKey 指向的卡会读到它 */
const liveState = ref<'loading' | 'playing' | 'paused'>('paused')
/** 当前这首播到第几秒、一共多长。别的卡不读这两个值 */
const elapsed = ref(0)
const total = ref(30)
/** 这一次会话里已经确认"没有试听"的歌。按曲目键记,不按消息 id ——
 *  同一首歌出现在两条消息里,不该一张卡能放、另一张说没有 */
const failed = reactive(new Set<string>())
/** 这一次会话里已经找到的试听。外链地址从这儿来:即使播完了、暂停了,
 *  右上角那枚"去听整首"也不该消失 */
const resolved = reactive(new Map<string, SongPreview>())

/* 单例音频。**懒建**:模块在 node 里被测试导入时没有 Audio,
   而这里不能在 import 阶段碰浏览器 API */
let audio: HTMLAudioElement | null = null
let ticker: ReturnType<typeof setInterval> | null = null
/** 当前这一轮"找 + 放"的代次。换歌、停歌、离开页面都 +1,
 *  一个还在飞的搜索回来时据此判断"这次还算不算数" */
let generation = 0

/** 进度条与时间只需要 10Hz:再快也只是多画几次同样的像素 */
const TICK_MS = 100

function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker)
    ticker = null
  }
}

function startTicker(): void {
  stopTicker()
  ticker = setInterval(() => {
    const el = audio
    if (!el || !currentKey.value) {
      stopTicker()
      return
    }
    if (Number.isFinite(el.currentTime)) elapsed.value = el.currentTime
    if (Number.isFinite(el.duration) && el.duration > 0) total.value = el.duration
  }, TICK_MS)
}

/** 建一次 <audio>,把这一层需要的几个事件接上 */
function ensureAudio(): HTMLAudioElement {
  if (audio) return audio
  const el = new Audio()
  /* 地址是点下去才设的,这里只是允许浏览器预读已设的那一段 */
  el.preload = 'auto'

  el.addEventListener('timeupdate', () => {
    if (!currentKey.value) return
    if (Number.isFinite(el.currentTime)) elapsed.value = el.currentTime
    if (Number.isFinite(el.duration) && el.duration > 0) total.value = el.duration
  })
  el.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(el.duration) && el.duration > 0) total.value = el.duration
  })
  el.addEventListener('ended', () => {
    /* 自然播完:**回到闲置**,不是停在最后一帧。卡片重新显示 0:00 / 0:30,
       点一下从头再来 —— 30 秒的试听没有"从头重播"之外的第二种期望 */
    stopTicker()
    currentKey.value = ''
    liveState.value = 'paused'
    elapsed.value = 0
    total.value = 30
    try {
      el.currentTime = 0
    } catch {
      /* 元数据已经没了:下一次换 src 会重置 */
    }
  })
  el.addEventListener('error', () => {
    if (!currentKey.value) return
    /* 地址过期、CDN 拒绝、格式不支持 —— 都归到"这张卡没有试听"。
       顺手把缓存作废:下次(刷新之后)还能重新搜到一条新的 */
    const key = currentKey.value
    failed.add(key)
    void deleteSongPreview(key)
    stopTicker()
    currentKey.value = ''
    liveState.value = 'paused'
    elapsed.value = 0
    total.value = 30
  })

  audio = el
  return el
}

function pauseCurrent(): void {
  if (audio) {
    try {
      audio.pause()
    } catch {
      /* ignore */
    }
  }
  stopTicker()
  if (currentKey.value) liveState.value = 'paused'
}

async function resumeCurrent(): Promise<void> {
  if (!audio || !currentKey.value) return
  const mine = generation
  try {
    await audio.play()
    if (mine !== generation) return
    liveState.value = 'playing'
    startTicker()
  } catch {
    /* 还是被拦(或音频已经失效):留在 paused,再点一次还能试 */
    if (mine !== generation) return
    liveState.value = 'paused'
  }
}

/**
 * 开始一首。顺序是:停朗读 → 停上一首 → 进入 loading → 找地址 → 播。
 *
 *  `await lookupSongPreview` 之后的那次 play() 可能已经离开用户手势
 *  (Safari 对自动播放的判定很严)。真被拦就落到 paused:卡片仍是播放键,
 *  用户再点一下会在手势里直接续播 —— 比弹一句"请再点一次"自然。
 */
async function startSong(key: string, title: string, artist: string): Promise<void> {
  /* 歌比朗读更明确:用户点的是"我要听这个",先把还在说话的那把嗓子停下 */
  stopSpeaking()
  stopTicker()
  if (audio) {
    try {
      audio.pause()
    } catch {
      /* ignore */
    }
  }

  const mine = ++generation
  currentKey.value = key
  liveState.value = 'loading'
  elapsed.value = 0
  total.value = 30

  const found = await lookupSongPreview(title, artist)
  if (mine !== generation) return

  if (!found) {
    /* 没有试听(搜不到 / 断网 / 超时)。卡片落到 unavailable:
       形状不变,进度线收掉,外链还留着 */
    failed.add(key)
    currentKey.value = ''
    liveState.value = 'paused'
    return
  }

  resolved.set(key, found)
  const el = ensureAudio()
  try {
    el.src = found.previewUrl
    el.currentTime = 0
  } catch {
    /* 设不进去就走下面的 play 失败分支 */
  }
  try {
    await el.play()
    if (mine !== generation) return
    liveState.value = 'playing'
    startTicker()
  } catch {
    if (mine !== generation) return
    liveState.value = 'paused'
  }
}

function toggleSong(key: string, title: string, artist: string): void {
  if (!key || failed.has(key)) return
  if (currentKey.value === key) {
    if (liveState.value === 'playing') pauseCurrent()
    else if (liveState.value === 'paused') void resumeCurrent()
    /* loading 时再点不做事:这一下不能变成"取消",那会让等待中的卡闪回 */
    return
  }
  void startSong(key, title, artist)
}

/**
 * 把声音停下,并让还在飞的搜索作废。
 *
 *  离开对话页、开始朗读、切到另一个角色都该走这里 —— 音频不该在
 *  "已经不在这一页"之后继续响(与朗读那条规矩一致)。
 */
export function stopSongPreview(): void {
  generation++
  stopTicker()
  if (audio) {
    try {
      audio.pause()
      audio.currentTime = 0
    } catch {
      /* ignore */
    }
  }
  currentKey.value = ''
  liveState.value = 'paused'
  elapsed.value = 0
  total.value = 30
}

/** 秒数 → "0:09"。负数、NaN 一律当 0 —— 时间戳只该安静地落回去 */
export function formatSongTime(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** 进度比例,夹在 0~1。时长还没读到时返回 0,不要拿 30 秒去猜 */
export function progressFraction(elapsedSeconds: number, durationSeconds: number): number {
  if (
    !Number.isFinite(elapsedSeconds) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return 0
  }
  return Math.min(1, Math.max(0, elapsedSeconds / durationSeconds))
}

export interface SongCardApi {
  state: ComputedRef<SongCardState>
  progress: ComputedRef<number>
  position: ComputedRef<number>
  length: ComputedRef<number>
  /** Apple Music 里整首的地址(找到试听之后才有)。模型没给链接时,外链用它 */
  viewUrl: ComputedRef<string>
  toggle: () => void
}

/**
 * 一张歌卡要的全部东西。
 *
 *  title / artist 用 getter 而不是值:附件是 props,换一条消息时同一个组件
 *  实例可能被复用,值捕获会把上一首的键留在手里。
 */
export function useSongPreview(title: () => string, artist: () => string): SongCardApi {
  const key = computed(() => songKey(title(), artist()))
  const active = computed(() => currentKey.value === key.value)

  const state = computed<SongCardState>(() => {
    if (failed.has(key.value)) return 'unavailable'
    if (!active.value) return 'idle'
    return liveState.value
  })
  const position = computed(() => (active.value ? elapsed.value : 0))
  const length = computed(() => (active.value && total.value > 0 ? total.value : 30))
  const progress = computed(() => progressFraction(position.value, length.value))
  const viewUrl = computed(() => resolved.get(key.value)?.trackViewUrl || '')

  function toggle(): void {
    toggleSong(key.value, title(), artist())
  }

  return { state, progress, position, length, viewUrl, toggle }
}
