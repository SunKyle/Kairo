import { computed, ref, type Ref } from 'vue'
import {
  coverSrc,
  draftCharacterFields,
  draftCharacterFromImage,
  emptyCharFields,
  emptyCharPersona,
  emptyCharVoice,
  hasPersona
} from '../api'
import { REF_IMAGE_EDGE } from '../lib/payload'
import type {
  ApiConfig,
  Character,
  CharacterDraft,
  CharacterFields,
  CharacterPersona,
  CharacterVoice
} from '../types'

/* ===== 角色草稿(表单)==================================================
 *  「正在编辑的那份表单」:内容、AI 起稿填过的标记、识图那一路的状态、
 *  参考图的读入,以及最后把表单交出去(见 submit)。
 *
 *  它**不管向导本身**(步数、向导 id、开关与焦点)—— 那些是"界面走到哪儿",
 *  而这里是"表单里有什么"。
 *
 *  **draft 与 editingId 由页面持有**(见 deps):嗓音那一块也要读同一份草稿,
 *  状态放在页面、两块各按引用拿,比让两个 composable 互相依赖干净。
 *
 *  依赖全部是引用、惰性函数或回调:props 会变、保存要走父组件。
 *  ------------------------------------------------------------------ */

/** 表单草稿:设定拆成五项,参考图先收成 data URL ——
 *  压小成 Blob 是主界面的事(与参考图存档同一档参数)。
 *  编辑已有角色时 ref 为空表示"没换参考图",那一边就不动库里那张 */
export interface CharacterDraftForm {
  name: string
  fields: CharacterFields
  /* 人格设定。与 fields 一起编辑,但存的时候分开走(见 types 的 CharacterPersona)——
     它只服务对话,混进 fields 会被拼进每一张出图的提示词 */
  persona: CharacterPersona
  /* 嗓音(朗读时听起来什么样)。与 persona 同为"只服务对话"的一类,同样分开存 */
  voice: CharacterVoice
  desc: string
  ref: string
}

/** 一份空表单。新建、以及"这一轮没带角色"时用它 */
export function emptyCharacterDraft(): CharacterDraftForm {
  return {
    name: '',
    fields: emptyCharFields(),
    persona: emptyCharPersona(),
    voice: emptyCharVoice(),
    desc: '',
    ref: ''
  }
}

/** 交回给主界面的那份表单。字段与参考图各拷一份,免得表单被继续改动时
 *  牵动已经发出的这次保存 */
export interface CharacterSavePayload {
  id?: string
  name: string
  fields: CharacterFields
  persona: CharacterPersona
  voice: CharacterVoice
  desc: string
  refData: string
}

export interface CharacterDraftDeps {
  /** 正在编辑的那份表单。**页面持有** —— 嗓音那一块也读它 */
  draft: Ref<CharacterDraftForm>
  /** 正在编辑哪个已保存角色。空 = 新建 */
  editingId: Ref<string>
  /** 角色目录:编辑态要预填、要显示库里那张参考图 */
  characters: () => Character[]
  /* 两条都是**惰性函数**:props 会变,而"有没有配模型"必须在点下去那一刻问 */
  textConfig: () => ApiConfig | undefined
  visionConfig: () => ApiConfig | undefined
  /** 存表单。内容怎么落库由主界面决定 */
  save: (payload: CharacterSavePayload) => void
  /** 导入一个角色包:只把文件交出去,解包与落盘归主界面 */
  importFile: (file: File) => void
  /** 表单里带出去的那段克隆样本从此"有主"(见 useCharacterVoice) */
  markSampleCommitted: (sampleId: string | undefined) => void
}

export function useCharacterDraft(deps: CharacterDraftDeps) {
  /* 这两份状态归页面,这里只是拿同一个引用 —— 所以下面那些 `draft.value = …`
     改的仍是页面上那一份 */
  const { draft, editingId } = deps
const isEditing = computed(() => !!editingId.value)
const editingChar = computed(() => deps.characters().find((c) => c.id === editingId.value))
/* 编辑态下参考图的预览地址:draft.ref 只在"换了新图"时才有值,
   没换的时候要显示库里那张。这一页不碰字节,地址交给 coverSrc */
const editRefSrc = computed(() => (isEditing.value ? coverSrc(editingChar.value?.sourceRef) : ''))

// 起稿:一句话 + 请求状态 + 它自己的报错(不占用生图那套错误出口)
const idea = ref('')
const drafting = ref(false)
const draftError = ref('')
/* 起稿请求的代次。等待中关掉向导、或重新开一轮时,上一次的结果回来后
   会把新表单里刚写的东西整个盖掉 —— 加一条代次,对不上就整份丢弃 */
let draftSeq = 0
/** 作废在途的起稿请求。只加代次不够:drafting 得一起松开,
 *  否则下一轮起稿键会一直点不动 */
function cancelDraft() {
  draftSeq++
  drafting.value = false
}

  /** 开一轮新表单:把草稿重置成"空白"或"照这个角色预填"。
   *  这是"开向导"里**只管表单**的那一半 —— 步数、向导 id、焦点、模态都归页面管 */
  function resetDraft(c?: Character) {
    // 参考图那一块的状态跟着清:上一轮读过的图不该在新表单里留着"已读"的痕迹
    visionError.value = ''
    visionRead.value = false
    idea.value = ''
    draftError.value = ''
    editingId.value = c?.id || ''
    draft.value = c
      ? {
          name: c.name,
          fields: c.fields ? { ...c.fields } : emptyCharFields(),
          /* 老角色没有 persona(loadCharacters 会补一份空的,这里再兜一层):
             与 fields 分开拷一份,表单被继续改动时才不会牵动已经存下的那份 */
          persona: { ...emptyCharPersona(), ...(c.persona || {}) },
          /* 嗓音同样兜一层:老角色没有这一项。深拷一份 —— 表单里改音色时
             不该牵动已经存下的那份 */
          voice: { ...emptyCharVoice(), ...(c.voice || {}) },
          desc: c.desc || '',
          // 预填页面上那张图由 editRefSrc 负责,这里只表示"还没换"
          ref: ''
        }
      : emptyCharacterDraft()
    aiFilled.value = {}
  }

/* 起稿填过、而用户还没动过的字段。
   校对要有个落点 —— 提示写着 "check what it got wrong",但看不出哪几项是
   模型编的:模型给的值和人手写的值在界面上长得一模一样。
   改一下那一项就抹掉标记(见 markEdited),扫一眼就知道还剩哪几处没看过。

   键是长相与人格两套字段的并集。两套的键不重合,所以标在同一份里不会打架 ——
   而图例说的是"这枚点是模型写的",本来就该把两套一起算 */
type DraftFieldKey = keyof CharacterFields | keyof CharacterPersona
const aiFilled = ref<Partial<Record<DraftFieldKey, boolean>>>({})
// 有标记 ⇒ 组说明换成那条图例,不然用户不知道这枚点是什么意思
const hasAiFilled = computed(() => Object.values(aiFilled.value).some(Boolean))
/* 已经填过内容 ⇒ 起稿键变成 "Draft again"。
   人格也算:它同样是起稿会覆盖的东西 */
const hasSpec = computed(
  () =>
    Object.values(draft.value.fields).some((s) => (s || '').trim()) ||
    hasPersona(draft.value.persona)
)

function markEdited(key: DraftFieldKey) {
  if (aiFilled.value[key]) aiFilled.value[key] = false
}

/* —— 识图:把上传的参考图读成设定 ——
   与上面那条"一句话起稿"是并行的两个入口,共用同一份回填规矩(applyDraft)。
   状态与报错也自成一套:draftError 那块在起稿框里,而这里出错的地方在参考图旁边 */
const visionBusy = ref(false)
const visionError = ref('')
// 这张图已经读过至少一次了 ⇒ 按钮从 "Read the spec" 变成 "Read again"
const visionRead = ref(false)
/* 这一行要不要摆取景框:没跑过(也没失败过)时它只是一句提示,
   摆一个不动的取景框反而像坏了。跑过之后才把结果留在原地 */
const visionRan = computed(() => visionBusy.value || !!visionError.value || visionRead.value)
/** 取景框的状态:busy 之外只有"刚读完"和"刚失败"两种收尾 */
const visionLoader = computed<'working' | 'done' | 'error'>(() =>
  visionBusy.value ? 'working' : visionError.value ? 'error' : 'done'
)
/* 代次:和起稿同一个理由 —— 等待中换了一张图、关掉向导,上一次的结果回来时
   不能落到新表单里 */
let visionSeq = 0
/** 作废在途的识图请求,并把 loading 松开(只加代次的话按钮会一直点不动) */
function cancelVision() {
  visionSeq++
  visionBusy.value = false
}

/* 一次起稿的结果落进表单。文字起稿与识图共用 —— 两条路拿到的是同一份
   「名字 + 结构化设定」,回填的规矩就该一模一样 */
function applyDraft(d: CharacterDraft) {
  /* 名字只在还空着的时候补:它是这张卡的标题,用户自己敲进去的那个
     不该被一次起稿顶掉。想换成模型起的名字,先清空再点一次 */
  if (!draft.value.name.trim() && d.name) draft.value.name = d.name
  draft.value.fields = d.fields
  /* 人格只有模型真写出来了才覆盖。这里与 fields 不同,是有意的 ——
     那十几行长相是必答项,而人格那几行是后加的:一次回不来时
     把用户自己写好的人格抹成空,比"这次没更新"糟得多 */
  if (hasPersona(d.persona)) draft.value.persona = { ...d.persona }
  /* 记下这一趟哪些栏是模型填的。空着的那些不标 —— 标了反而像在说
     "这里有什么要看",而它们本来就该留空(见 server 那条提示) */
  const marks: Partial<Record<DraftFieldKey, boolean>> = {}
  for (const k of Object.keys(d.fields) as Array<keyof CharacterFields>) {
    if (d.fields[k].trim()) marks[k] = true
  }
  for (const k of Object.keys(d.persona) as Array<keyof CharacterPersona>) {
    if (d.persona[k].trim()) marks[k] = true
  }
  aiFilled.value = marks
}

/* 回车起稿,Shift+回车换行。
   与首页那条同一笔账:输入法用回车「上屏」时也会发 keydown.enter,
   那一下既不能当提交、也不能 preventDefault(一 prevent 拼音就上不了屏了)。
   现在这一栏是 textarea,回车默认是换行 —— 所以这个 preventDefault 非写不可 */
function onIdeaEnter(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  draftWithAI()
}

/* 起稿:一句话交给文本模型拆成这套设定 + 一个名字,回填后可逐项修改。
   只填字段、不出图 —— 先校对再花钱。结果只落在这张表单里,不写库 */
async function draftWithAI() {
  const text = idea.value.trim()
  if (!text || drafting.value) return
  const cfg = deps.textConfig()
  if (!cfg || !cfg.model || !cfg.baseUrl) {
    draftError.value = 'Set up prompt enhancing in API settings first.'
    return
  }
  drafting.value = true
  draftError.value = ''
  const seq = ++draftSeq
  try {
    const d = await draftCharacterFields(cfg, text)
    /* 回来时表单可能已经换了一轮(关掉向导又重开、或去编辑了别的角色):
       这一趟属于上一轮,整份丢掉 —— 否则会把用户刚写的内容覆盖掉 */
    if (seq !== draftSeq) return
    // 一项都没解出来 = 模型没按那个格式回。如实说,别假装已经填好了
    if (!Object.values(d.fields).some((s) => s.trim())) {
      draftError.value =
        'The model did not return a usable spec. Fill the fields by hand, or try another text model.'
      return
    }
    applyDraft(d)
  } catch (e: any) {
    if (seq !== draftSeq) return
    draftError.value = e?.message || 'Could not draft the character'
  } finally {
    // 只有还是自己那一次才复位:新一轮已经在跑时,别把它的 loading 关掉
    if (seq === draftSeq) drafting.value = false
  }
}

/* 送去识图模型的那一份:最长边压到上限的 JPEG。
   上传的原图可能有几十 MB,而请求体上限是 15MB —— 原样发过去会直接 413。
   上限与其余几处参考图共用同一个常量(见 lib/payload.ts 的 REF_IMAGE_EDGE)。
   存档用的仍是原图(见 submit 那条路),这张副本只给模型看 */
const VISION_MAX_EDGE = REF_IMAGE_EDGE
function visionCopy(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, VISION_MAX_EDGE / Math.max(img.width, img.height))
      if (scale >= 1) return resolve(dataUrl) // 本来就小,原样发
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.width * scale))
      c.height = Math.max(1, Math.round(img.height * scale))
      const ctx = c.getContext('2d')
      if (!ctx) return resolve(dataUrl)
      // 透明 PNG 转 JPEG 会变黑底,先铺一层白
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.drawImage(img, 0, 0, c.width, c.height)
      resolve(c.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

/* 识图:把这张参考图交给视觉模型,读成同一份「名字 + 结构化设定」。
   上传完自动跑一次(见 onPickRef)——"传张图上去"的意图本来就是照着它填,
   再让用户找一下按钮是多余的一步;旁边那个按钮留着是为了重读与改配置后重试 */
async function draftFromImage() {
  const src = draft.value.ref
  if (!src || visionBusy.value) return
  const cfg = deps.visionConfig()
  if (!cfg || !cfg.model || !cfg.baseUrl) {
    visionError.value = 'Set up an image-recognition config in API settings first.'
    return
  }
  visionBusy.value = true
  visionError.value = ''
  const seq = ++visionSeq
  try {
    const d = await draftCharacterFromImage(cfg, await visionCopy(src))
    /* 回来时可能已经换了一张图、或关掉了向导:这一趟属于上一轮,整份丢掉 */
    if (seq !== visionSeq) return
    if (!Object.values(d.fields).some((s) => s.trim())) {
      visionError.value =
        'The model did not return a usable spec. Fill the fields by hand, or try another vision model.'
      return
    }
    applyDraft(d)
    visionRead.value = true
  } catch (e: any) {
    if (seq !== visionSeq) return
    visionError.value = e?.message || 'Could not read this image'
  } finally {
    // 只有还是自己那一次才复位:重新挑过图时别把新一轮的 loading 关掉
    if (seq === visionSeq) visionBusy.value = false
  }
}

/* 参考图的上限。FileReader 会把整张读成 data URL 进内存,几百 MB 能把标签页顶掉;
   而这张图随后还要进 localStorage / IndexedDB 的队列,不是"随便传多大的都行" */
const MAX_REF_BYTES = 32 * 1024 * 1024

function onPickRef(e: Event) {
  const el = e.target as HTMLInputElement
  const file = el.files?.[0]
  // 清空 input:同一个文件选第二次也要能触发 change
  el.value = ''
  if (!file) return
  /* 下面两条以前没有:accept 只是选择器上的过滤,用户能强制改选任意文件,
     真把上百 MB 的东西塞进来的话是这一页自己先卡住 */
  if (!file.type.startsWith('image/')) {
    draftError.value = 'That file is not an image.'
    return
  }
  if (file.size > MAX_REF_BYTES) {
    draftError.value = 'That image is too large to use as a reference.'
    return
  }
  draftError.value = ''
  const reader = new FileReader()
  reader.onload = () => {
    // 换了一张图 ⇒ 上一张的读取结论与在途请求一起作废
    cancelVision()
    visionError.value = ''
    visionRead.value = false
    draft.value.ref = String(reader.result)
    /* 传完顺手读一次:这个动作的意图本来就是"照着这张图填设定"。
       没配识图接口时不报错 —— 图当参考照常用,只在那一行里说明怎么开。
       编辑态不读:用户是来换参考图的,不是让模型把他校对过的那份设定重写一遍 */
    if (deps.visionConfig() && !isEditing.value) void draftFromImage()
  }
  reader.readAsDataURL(file)
}

/* 撤掉参考图:连它读出来的那些状态一起清掉 —— 留着"已读"会像是这张图还在 */
function clearRef() {
  cancelVision()
  draft.value.ref = ''
  visionError.value = ''
  visionRead.value = false
}

/* 导入:只把文件交出去。zip 要解包、图要落 IndexedDB —— 那是主界面的活,
   这一页从头到尾不碰字节(与参考图那条路同一分工) */
function onImportFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  // 清空 input:同一个文件选第二次也要能触发 change
  ;(e.target as HTMLInputElement).value = ''
  if (file) deps.importFile(file)
}

function submit() {
  const d = draft.value
  // 姓名与性别是仅有的两条必填:一个给卡片当标题,一个给模型定这张脸
  if (!d.name.trim() || !d.fields.gender.trim()) return
  /* 字段与参考图各拷一份交出去,免得表单被继续改动时牵动已经发出的这次保存。
     编辑态带上 id:主界面据此改这一条,而不是多存一个副本;
     refData 为空则表示"没换参考图",那一边不会去动库里那张 */
  deps.save({
    ...(editingId.value ? { id: editingId.value } : {}),
    name: d.name,
    fields: { ...d.fields },
    persona: { ...d.persona },
    // 嗓音浅拷一份就够:它底下的值全是字符串与数字,没有嵌套
    voice: { ...d.voice },
    desc: d.desc,
    refData: d.ref
  })
  /* 这一次交出去的嗓音里如果带着一段克隆样本,它就是**有主**的了 ——
     下面那次取消不该把它删掉(见 dropOrphanVoiceSample)。
     存失败时这里会偏保守地留着它:宁可多留一段录音,也不能删掉一个角色正指着的样本 */
  deps.markSampleCommitted(d.voice.sampleId)
  /* 这里不推进也不关表单:存完由父组件回调 onSaved 推向导走下一步 ——
     save 是异步的,现在改步数会在角色还没进列表时先跳到"主视图",
     那一格既没有 id 也没有图。存失败时表单留着,改完可以直接再点一次 */
}
  return {
    isEditing,
    editingChar,
    editRefSrc,
    idea,
    drafting,
    draftError,
    cancelDraft,
    aiFilled,
    hasAiFilled,
    hasSpec,
    markEdited,
    applyDraft,
    resetDraft,
    visionBusy,
    visionError,
    visionRead,
    visionRan,
    visionLoader,
    cancelVision,
    draftFromImage,
    onIdeaEnter,
    draftWithAI,
    onPickRef,
    clearRef,
    onImportFile,
    submit
  }
}
