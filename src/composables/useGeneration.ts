import type { Ref } from 'vue'
import {
  FREE_SIZES,
  allowedSizes,
  chatExtraParams,
  enhancePrompt,
  generate,
  imageSrc,
  photoFailureText,
  makeThumb
} from '../api'
import { REF_ARCHIVE_EDGE } from '../lib/payload'
/* 场景串的长度上限。**权威定义住在服务端**(剪标签那一层就在用),
   这里与 api.ts 的导入校验都引它 —— 同一个数抄成三份,已经漏改过一次 */
import { PHOTO_SCENE_CHARS } from '../../server/chatTags.js'
import {
  backdropViewOrder,
  characterAnchor,
  characterGender,
  chatPhotoSize,
  planChatBackdrop,
  planChatPhoto,
  shotViewOrder
} from '../lib/chatPhoto'
import type { ChatPhotoPlan } from '../lib/chatPhoto'
import { DIRECTOR_SLOTS, applyDirector, directorTask, parseDirector } from '../lib/photoDirector'
import { urlToBlob } from '../lib/idb'
import type { ApiConfig, Character, HistoryEntry, HistorySource, ResultItem } from '../types'

/* ===== 对话出图:角色发的那张照片 + 沉浸页的背景图 ====================
   这一层只服务「超拟人对话」:对话里角色会发照片,沉浸页有背景图。
   两条路都要拼提示词、取参考图、发请求,并且都把结果连同**配方**
   交回调用方(它才碰存储,见 App 的 saveChatWork / useChatFlow)。

   KImage 那份里这里还住着创作区的出图参数(提示词 / 尺寸 / 张数 / 画质 /
   种子 / 参考图 / 改写)与并发生成编排 —— 那些属于已删掉的 Studio,没有带过来。
   -------------------------------------------------------------------- */

export interface GenerationDeps {
  /** 当前生效的出图配置:尺寸与扩展参数都要过它的能力表 */
  config: Ref<ApiConfig>
  /** 当前生效的文本模型:摄影指导那一步用它 */
  textConfig: Ref<ApiConfig | null>
  /** 全部角色:对话里发图要按**对话中那个角色**取设定与参考图 */
  characters: Ref<Character[]>
  /** 按 id 取某个角色的图(对话发图要走它)。
   *  order 由这一张的镜头决定(见 lib/chatPhoto 的 shotViewOrder) */
  charRefSrcsOf: (charId: string, order?: string[]) => Promise<string[]>
  /** 显示级压缩(主界面那份),用来存参考图的存档副本 */
  compressImage: (
    dataUrl: string,
    maxEdge?: number,
    quality?: number,
    force?: boolean
  ) => Promise<string>
}

export function useGeneration(deps: GenerationDeps) {
  /* 摄影指导这一跳最多等多久。它不是用户主动发起的(用户只看到"图在画"),
     所以不能无限等 —— 卡住时宁可交一张模板拼的图,也不能让骨架一直转。
     但**它耽误的只是"图晚多久出来",不是正文**(正文早就流完在屏幕上了),
     所以这个数该按"文本模型能有多慢"来定,而不是按"别让骨架转多久":

     - 服务端那一侧给的是 UPSTREAM_TIMEOUT_MS = 120 秒 —— 也就是说 2 分钟以内,
       它**不会**替我们放弃;
     - 而这一层打的是"当前生效的文本配置",它很可能是**思考型**模型:
       思考也走这段路,一个短任务花 20 秒以上是常事。

     15 秒是原值,实测经常不够(用户 2026-10-06:"角色生图前的 enhance 经常
     超时失败"),而它一超时就**整层丢掉**、退回模板 —— 那正是"图看着没用上
     摄影指导"的样子。30 秒是个折中:覆盖绝大多数思考时间,又不至于真卡住时
     让骨架转太久。

     **真正该换的是模型**:如果 30 秒仍然经常不够,下一步不是继续加这个数,
     而是给"提示词改写"配一条非思考型的文本配置 —— 它这一跳要的只是一段
     四行的短回答。 */
  const DIRECTOR_TIMEOUT_MS = 30_000

  /** 让摄影指导写这一张的机位、镜头、光与环境。
   *
   *  **失败一律返回 null,绝不抛** —— 调用方据此退回模板那一层。
   *  这条约定与 generateChatPhoto 的"失败只返回 error"同源:
   *  多出来的一层不许成为"这张图出不来了"的新理由。
   *
   *  三处刻意的取舍:
   *  - **走 /api/enhance 的 photo 档**,不新开端点:它已经解决了上游超时、
   *    代理直连重试、错误回显这些事,而多一条端点就是多一处要跟着改的地方;
   *  - **用当前生效的文本配置**,与提示词改写同一个来源。没配就跳过一次 ——
   *    这不该是这个功能的硬依赖(用户可能只配了出图那条);
   *  - **等它,但不与出图并行**:它改的就是出图要用的那段提示词。
   *
   *  —— 每一处跳过都留一行 console.debug(2026-10-06 补)——
   *
   *  这一层从前**完全静默**:没配文本模型、超时、上游报错,在界面上长得一模一样
   *  (都是"图看起来没用上摄影指导"),而这三件事要做的事完全不同 ——
   *  没配要去配,超时要换模型或调时限,报错要去看那一句 detail。
   *  与 [chat] photo intent 那行同一套:详细级别、不落盘、不上报。
   *  **看之前要把控制台的 Verbose 打开**(debug 默认是折叠的)。 */
  async function withDirector(base: ChatPhotoPlan, cfg: ApiConfig): Promise<ChatPhotoPlan | null> {
    const textCfg = deps.textConfig.value
    if (!textCfg?.baseUrl || !textCfg.model) {
      console.debug('[chat] photo director skipped: no text model configured')
      return null
    }
    const ac = new AbortController()
    /* 计时只为那一行日志:它同时回答"这次等了多久"与"30 秒够不够" */
    const startedAt = Date.now()
    const timer = setTimeout(() => ac.abort(), DIRECTOR_TIMEOUT_MS)
    try {
      const raw = await enhancePrompt(
        textCfg,
        directorTask(base),
        {
          mode: 'photo',
          /* 目标模型那两项在 photo 档不会进系统提示(服务端刻意跳过),
             但仍然要传:EnhanceOpts 里它们不是可选的 */
          targetVendor: cfg.vendor || '',
          targetModel: cfg.model || '',
          hasRef: false
        },
        ac.signal
      )
      const written = parseDirector(raw)
      /* 一位都没解析出来 = 它没按格式回。这时**整层当作不可用**,
         而不是逐位退回 —— 一个都没认出来说明格式已经崩了,
         再从碎片里挑可信的只会引入噪声。
         **视角与景别都不在它那几位里**(2026-10-05 / 10-06 起它不判这两样,
         只被告知),所以这里只看那四位 */
      const ms = Date.now() - startedAt
      if (!DIRECTOR_SLOTS.some((s) => written[s])) {
        console.debug('[chat] photo director: nothing usable in its answer', ms, 'ms', raw.slice(0, 80))
        return null
      }
      console.debug('[chat] photo director:', ms, 'ms', Object.keys(written).join('/'))
      return applyDirector(base, written)
    } catch (e) {
      /* AbortError 只可能是上面那个定时器:这条链上没有第二处会 abort 它
         (用户按 Stop 中断的是对话流,不是这一跳) */
      console.debug(
        '[chat] photo director skipped after',
        Date.now() - startedAt,
        'ms:',
        (e as Error)?.name === 'AbortError'
          ? `no answer within ${DIRECTOR_TIMEOUT_MS / 1000}s`
          : (e as Error)?.message || e
      )
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 聊天里画出来的那张图**连同它的配方**一起交回调用方。
   *
   *  `elapsedMs` 同理:出图耗时的表在这里,调用方那边已经是一段 await 之后了 */
  type ChatWorkOut = {
    blob: Blob
    /** 真正发给上游的那一整段(含机位、焦段、光、负面约束) */
    prompt: string
    /** 真正发出去的尺寸。由这一张的镜头定(见 chatPhotoSize),不由创作区决定 */
    size: string
    model: string
    /** 当时那条出图配置的 id。配置被改/被删之后仍能说清这张是谁出的 */
    configId: string
    elapsedMs: number
  }

  /** 画一张的结果:要么给图,要么给**原因**。两者必有一个。
   *
   *  从前这里返回 `Blob | undefined`,而 undefined 是**一个**值 ——
   *  "没配出图模型""上游说密钥不对""参考图读不出来""上游回了个空数组"
   *  全都被压成它,界面于是只能说一句"生成失败"。用户既不知道是配置问题
   *  还是模型问题,也不知道下一步该改什么。 */
  type ChatPhotoResult = ChatWorkOut | { blob?: undefined; error: string }

  /* 出图那条配置**缺在哪儿**,说成人话。比"没配好"具体得多 ——
     用户看到"缺模型名"就知道去哪儿补,看到"生成失败"只能来问你 */
  function imageConfigGap(cfg: ApiConfig): string {
    if (!cfg.baseUrl) return 'No image API is configured — set one up in Settings.'
    if (!cfg.model) return 'The image API has no model name — fill it in under Settings.'
    return ''
  }

  /** 上游确实回了一张图,我们却把它落不成 Blob 时该说什么。
   *
   *  最典型的一种是**它回的是图片链接**:豆包的 response_format 默认就是 `url`,
   *  而那张链接是给浏览器之外的地方下载的 —— 前端拿到 url 还得再跨域拉一次,
   *  被 CORS 挡住、或 24 小时过期,拉不动就是拉不动。
   *  这时说"上游没给可用的图"会把人送去查模型,而该查的是响应格式 ——
   *  所以两种情形分开说(见 api.ts 能力表的 responseFormat:认这一项的厂商
   *  我们已经直接要 base64 了)。
   */
  function unusableImageText(first: ResultItem): string {
    return first.type === 'url'
      ? 'The upstream returned an image link this browser could not download — blocked cross-origin, or the link has expired. Check the vendor in API Settings: providers that can return base64 are asked for it, and that removes the second hop.'
      : 'The image API returned something that is not a usable image.'
  }

  /* 一条配置下"可以挑的显式尺寸"。厂商不限尺寸时用应用自己那组常用值 ——
     与角色设定图那条路(useCharacters 的 viewSize)同一个口径:
     两边都是"按比例挑最接近的一档",所以两边都吃同一份 FREE_SIZES */
  function sizeChoicesOf(cfg: ApiConfig): string[] {
    const a = allowedSizes(cfg.vendor, cfg.model || '')
    return a === 'free' ? FREE_SIZES : a
  }

  /* 参考图的存档副本:配方要能完整复现,就得连参考图一起留下 ——
     hasRef 只说得出"用过参考图",说不出是哪一张,重跑时就会悄悄退化成文生图。
     压到最长边 512(它只当参考用,不需要原分辨率),存 Blob 不存 data URL,
     与结果图同一套。压不出来就返回 undefined,按"没存档"处理,不阻断生成 */
  async function refThumbOf(src: string): Promise<Blob | undefined> {
    if (!src) return undefined
    try {
      const out = await deps.compressImage(src, REF_ARCHIVE_EDGE, 0.72)
      return /^data:image\//.test(out) ? await urlToBlob(out) : undefined
    } catch {
      return undefined
    }
  }

  /** 对话里现场画一张:只在被要求或确实合适时由那一轮的标签触发。
   *  **画出来的图由调用方落两处**(见 App 的 saveChatWork 与 useChatFlow 的 drawChatPhoto)。
   *
   *  几个输入都是"这一张怎么拍"的一部分(见 lib/chatPhoto 的文件头):
   *  - `self` = 这一张里有没有**它本人**。有 → 拼身份锚点、把设定图当参考图,
   *    这是"同一张脸"的保证;没有 → 提示词里只有场景、一张参考图都不发
   *    —— 一张风景照带上设定图,模型会被拽着往那个人的脸和衣服上靠;
   *  - `shot` = **谁拿的相机**,由聊天模型写在标签前缀里(selfie: / third:)。
   *  - `frame` = **离得多近**,同样由聊天模型写在标签前缀里(close: / medium: / full:);
   *  - `mood` = **发这一条时它的心情**(那枚 `[mood:word]`)。它落在 expression
   *    那一层,"这一刻脸上是什么神情"。
   *
   *  **绝不 reject**:这条链是后台跑的,往外抛没有调用方接得住
   *  (见 useChatFlow 的 drawChatPhoto)。所以一律返回上面那个结果对象。 */
  async function generateChatPhoto(
    charId: string,
    scene: string,
    self: boolean,
    shot = '',
    frame = '',
    mood = ''
  ): Promise<ChatPhotoResult> {
    /* 场景串的第二道收口。上限引的是**服务端那一份**(剪标签时已经截过一次)——
       从前这里是另抄的一个 400,而同一个数在导入校验那处抄漏成了 120 */
    const text = String(scene || '').trim().slice(0, PHOTO_SCENE_CHARS)
    if (!text) return { error: 'There is no scene to draw for this message.' }
    /* **认对话里那个角色**,不认创作区选中的那个:设定与参考图都按 charId 取。
       这一点错了就会"一点不像" —— 参考图是空的,等于纯文生图 */
    const who = deps.characters.value.find((c) => c.id === charId)
    /* 视角只认标签给的那两个词 —— 它是库里的字段、也是模型写的自由文本,
       认不出的当"没说",由 planChatPhoto 按场景判(见那个函数的说明)。
       景别同理,只认那三档 */
    const wantShot = shot === 'selfie' || shot === 'third' ? shot : undefined
    const wantFrame = frame === 'close' || frame === 'medium' || frame === 'full' ? frame : undefined
    const basePlan = planChatPhoto(
      text,
      self,
      who ? characterAnchor(who) : '',
      wantShot,
      wantFrame,
      /* 性别只服务特写那一档(见 lib/chatPhoto 的 partLine):那一段画面里
         往往没有脸,而锚点句那七项全是头部特征 —— 它是"这个人是谁"唯一的
         接续。有脸的那些图用不上它,所以不加进锚点句、不改动它们 */
      who ? characterGender(who) : '',
      /* 心情只服务有脸、且不是特写的那几档(见 planChatPhoto 的 expression 层) */
      mood
    )
    const cfg = deps.config.value
    const gap = imageConfigGap(cfg)
    if (gap) return { error: gap }
    const ctrl = new AbortController()
    try {
      /* —— 摄影指导层(见 lib/photoDirector 与设计文档 §四)——
         插在"剪完标签"和"发图"之间。这一段本来就是异步的(正文早就可读,
         用户在等的是图),所以多一次文本调用只增加出图延迟,不影响聊天。

         **没有文本模型、或它挂了,都只是降级**:退回模板那一层(见 lib/chatPhoto),
         不阻断这张图。所以这里吞掉它的原因,不冒到外层 */
      const plan = (await withDirector(basePlan, cfg)) || basePlan
      /* 取参考图这一步**也要在 try 里**:它会读 IndexedDB、把 Blob 转成 data URL,
         是这条链上最容易真抛出来的一步。抛出去有两个后果,都不能接受 ——
         一是"同一张脸"的依据没了却照样发请求(画出来是个陌生人),
         二是**这个函数往外抛时调用方那侧会静默**:界面既没有提示,
         那条消息还永远停在骨架上(见 useChatFlow 的 drawChatPhoto) */
      let refList: string[] = []
      if (plan.useRefs) {
        try {
          /* 顺序由 **shot + frame** 一起给:视角定"哪一类照片"(自拍以正面为主、
             他拍以全身打头),景别定"离得多近"(特写把全身像摘掉、全身把全身像
             提到最前,见 lib/chatPhoto 的 FRAME_REF_ORDER)。
             **少传 frame 那一半就等于上一版** —— 参考图是这条链上最强的机位来源,
             只改提示词那一侧是不够的(那正是"特写仍拿全身像当参考"的旧毛病) */
          refList = await deps.charRefSrcsOf(charId, shotViewOrder(plan.shot, plan.frame))
        } catch {
          /* 参考图读不出来仍然照画(纯文生图),但要说明"这张可能不像它" */
          refList = []
        }
      }
      /* 尺寸在这里定一次、两处用:发请求用它,落历史也用它。从前它只出现在
         请求体里,记录那边就无从知道这一张究竟多大(与工作台记录的 size 同义) */
      const usedSize = chatPhotoSize(sizeChoicesOf(cfg), plan.shot, true)
      /* 计时从真正发请求这一刻起:取参考图与摄影指导那一段不是用户在等的
         "出图时间" */
      const startedAt = Date.now()
      const res = await generate(
        {
          prompt: plan.prompt,
          /* **对话里的图由场景决定尺寸,不跟创作区那个尺寸走** ——
             创作区选的是"我这次要多大"。从前这里写死 'auto',而它对只认固定
             枚举的厂商会被 sizeForVendor 退到 allowed[0](通常 1024×1024):
             横着拍的窗、竖着站的人全被塞进同一个方框。
             现在按镜头挑最接近的一档比例(见 lib/chatPhoto 的 chatPhotoSize) */
          size: usedSize,
          n: 1,
          ...(refList.length ? { images: refList } : {}),
          /* 画质与背景都由 chatExtraParams 收口(见它的说明) */
          ...chatExtraParams(cfg)
        },
        cfg,
        ctrl.signal
      )
      const first = res?.[0]
      /* 上游 200 但一张图都没有 —— 这是最容易被压成"生成失败"的一种,
         而它其实通常是内容被安全策略拦了,或者中转回了个空壳 */
      if (!first) return { error: 'The image API returned no image for this prompt.' }
      try {
        return {
          blob: await urlToBlob(imageSrc(first)),
          prompt: plan.prompt,
          size: usedSize,
          model: cfg.model || '',
          configId: cfg.id,
          elapsedMs: Date.now() - startedAt
        }
      } catch {
        return { error: unusableImageText(first) }
      }
    } catch (e) {
      /* 上游/代理的真实错误。`generate()` 抛的就是 /api/generate 回给我们的
         那句话(例如"密钥不对""模型不存在"),它比任何我们编的文案都有用 */
      return { error: photoFailureText(e) }
    }
  }

  /**
   * 画**这一场戏的背景图**（沉浸页铺满屏幕的那一张）。
   *
   * 与 `generateChatPhoto` 的三处不同，都是刻意的：
   * - 提示词走 `planChatBackdrop`（横构图、主体靠右、左边留给字）；
   * - **不进消息流**：它不属于哪一条消息，画完由调用方写进 `chat_backdrops`；
   * - **不过摄影指导那一层**：那是"这一张照片怎么拍"的层，而背景图自己已经把
   *   机位与光写死了（见那段提示词的注释）。多一次文本调用换不到什么，
   *   而它正好压在"进沉浸页"这条路上 —— 那条路该尽量短。
   *
   * 与 `generateChatPhoto` 同一条约定：**失败只返回 error，绝不往外抛**。
   */
  async function generateChatBackdrop(charId: string, scene: string): Promise<ChatPhotoResult> {
    const who = deps.characters.value.find((c) => c.id === charId)
    const plan = planChatBackdrop(scene, who ? characterAnchor(who) : '')
    if (!plan.prompt) return { error: 'There is no scene to draw a background for yet.' }
    const cfg = deps.config.value
    const gap = imageConfigGap(cfg)
    if (gap) return { error: gap }
    const ctrl = new AbortController()
    try {
      let refList: string[] = []
      try {
        refList = await deps.charRefSrcsOf(charId, backdropViewOrder())
      } catch {
        /* 参考图读不出来仍然照画（纯文生图），背景不像它总好过一片空 */
        refList = []
      }
      /* 横构图。复用"空镜"那一档比例（3:2）—— 它比人像档宽，
         又比 16:9 更容易在各家的档位表里找到。
         定一次、两处用（请求 + 落历史），与那张照片同一条 */
      const usedSize = chatPhotoSize(sizeChoicesOf(cfg), 'scene', true)
      const startedAt = Date.now()
      const res = await generate(
        {
          prompt: plan.prompt,
          size: usedSize,
          n: 1,
          ...(refList.length ? { images: refList } : {}),
          /* 与那张照片同一条规矩:两项都过能力表(没有 quality 字段的厂商
             一个字节都不发)。见 chatExtraParams 那一段说明 */
          ...chatExtraParams(cfg)
        },
        cfg,
        ctrl.signal
      )
      const first = res?.[0]
      if (!first) return { error: 'The image API returned no image for this prompt.' }
      try {
        return {
          blob: await urlToBlob(imageSrc(first)),
          prompt: plan.prompt,
          size: usedSize,
          model: cfg.model || '',
          configId: cfg.id,
          elapsedMs: Date.now() - startedAt
        }
      } catch {
        return { error: unusableImageText(first) }
      }
    } catch (e) {
      return { error: photoFailureText(e) }
    }
  }

  /* 把一组结果包成一条历史记录,并补上缩略图与真实像素。
     缩略图要在入列表和落盘之前补上:入列表后拿到的是响应式代理,
     在代理上改动不会回写到这里的原始对象,而 idb 又只接受原始对象。
     同时把量到的真实像素写进记录,图墙就能按真实比例排,而不是按所选尺寸 */
  async function recordFor(
    res: ResultItem[],
    meta: {
      prompt: string
      size: string
      model?: string
      quality?: string
      background?: string
      hasRef?: boolean
      groupId?: string
      /* 这一批是「从某条记录拉下来改的」时的父记录 id */
      parentId?: string
      /* 这一批套用的角色 id。见 Character */
      characterId?: string
      elapsedMs: number
      // 完整配方里其余的三项:重跑时要用它们还原当时的条件
      configId?: string
      seed?: number
      // 参考图本体(data URL)。存一份压过的小图,不然"当时用了哪张参考图"就丢了
      refSrc?: string
      /* —— 下面两项只有对话里生成的那两张图会带(见 types.ts 的 HistoryEntry.source)—— */
      // 来自对话里的哪条路
      source?: HistorySource
      /* 对话里那一场戏的描述。它是这两张图"画的是什么"那句人话,
         而 prompt 是整段摄影指令 —— 界面上读的是它(见 lib/chatWork) */
      scene?: string
    }
  ): Promise<HistoryEntry> {
    const record: HistoryEntry = {
      id: Date.now() + Math.random().toString(16).slice(2),
      prompt: meta.prompt,
      size: meta.size,
      model: meta.model,
      quality: meta.quality,
      background: meta.background,
      hasRef: meta.hasRef,
      groupId: meta.groupId,
      parentId: meta.parentId,
      characterId: meta.characterId,
      configId: meta.configId,
      seed: meta.seed,
      elapsedMs: meta.elapsedMs,
      createdAt: Date.now(),
      results: res
    }
    if (meta.source) record.source = meta.source
    if (meta.scene) record.scene = meta.scene
    const t = await makeThumb(res[0])
    if (t) {
      record.thumb = t.blob
      record.w = t.w
      record.h = t.h
    }
    if (meta.refSrc) record.ref = await refThumbOf(meta.refSrc)
    return record
  }

  return {
    generateChatPhoto,
    generateChatBackdrop,
    recordFor
  }
}
