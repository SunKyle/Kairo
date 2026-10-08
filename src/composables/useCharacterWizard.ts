import { computed, nextTick, ref, watch, type Component } from 'vue'
import { PhSpeakerHigh, PhSquaresFour, PhTextAa } from '@phosphor-icons/vue'
import { CHARACTER_VIEWS } from '../api'
import type { CharacterDraftForm } from './useCharacterDraft'
import { stopSpeaking } from '../lib/speech'
import type {
  Character,
  CharacterFields,
  CharacterPersona,
  CharacterView,
  CharacterViewKind,
  CharacterVoice
} from '../types'

/* ===== 新建 / 编辑向导 ================================================
 *  三步向导的**编排**:步数、进行中的角色 id、开关与焦点、右栏摘要、
 *  存完跳到哪一步,以及取消时的收尾(丢掉没人认领的录音、把嘴闭上)。
 *
 *  表单内容归 useCharacterDraft,声音归 useCharacterVoice —— 这里只调度它们,
 *  把结果交给主界面(见 deps.save)。
 *
 *  从 CharacterPage 抽出来的第六块(前五块:嗓音、字段规格表、草稿表单、
 *  详情与查看器、列表与卡片菜单)。到这里「列表 / 详情 / 向导 / Voice」四块
 *  已各自成块,页面只剩接线与模板。
 *  ------------------------------------------------------------------ */

export interface CharacterWizardDeps {
  characters: () => Character[]
  views: () => Record<string, CharacterView[]>
  /** 开一轮新表单:预填、清标记、清"已读"痕迹 */
  resetDraft: (c?: Character) => void
  /** 作废在途的起稿 / 识图请求(关向导、重开表单时) */
  cancelDraft: () => void
  cancelVision: () => void
  /** 正在编辑哪个已保存角色(空 = 新建) */
  editingId: { value: string }
  /** 表单草稿:右栏摘要读它的名字与设定,第 2 步保存时整份交出去 */
  draft: { value: CharacterDraftForm }
  /** 表单那一块的报错行(退出向导时清掉) */
  draftError: { value: string }
  /** 表单里带出去的那段克隆样本从此"有主"(见 useCharacterVoice) */
  markSampleCommitted: (sampleId: string | undefined) => void
  /** 取消向导时,把这一轮建出来却没人认领的那段录音丢掉 */
  dropOrphanVoiceSample: () => Promise<void>
  /** 存表单(内容怎么落库归主界面) */
  save: (payload: {
    id: string
    name: string
    fields: CharacterFields
    persona: CharacterPersona
    voice: CharacterVoice
    desc: string
    refData: string
  }) => void
  /** 进向导第 3 步要读这个角色的设定图 */
  emitOpen: (charId: string) => void
  /** 存完回详情页 */
  openDetail: (id: string) => void
}

export type WizardStep = 1 | 2 | 3

  /* 三步各配一枚图标,给步骤条上那个圆点用(见模板里的 .wz-dot)。
     挑的是"这一步在做什么",不是"它的序号是几":
       Basics  填名字、性别与那份设定 —— 收的全是字
       Voice   这个角色的嗓子:用系统的,还是自己配一把
       Views   先出一张正脸,再以它为参考出其余四张 —— 同一张脸的保证

     为什么把"声音"从第 1 步里分出来:那一屏原本同时回答"这个人是谁"与
     "它听起来什么样",而后半比前半复杂得多(两层选择 + 输入 + 试听),
     堆在一屏会让信息量翻倍 —— 而它其实与设定、参考图之间没有任何先后依赖。
     原来的第 2、3 步则合成一步:正脸与其余四张本来就是**同一件事的两轮**
     (先定基准、再照它长),而合成一屏之后"先出正脸"这句话只要说一次 */
  export const STEPS: Array<{ n: WizardStep; label: string; icon: Component }> = [
    { n: 1, label: 'Basics', icon: PhTextAa },
    { n: 2, label: 'Voice', icon: PhSpeakerHigh },
    { n: 3, label: 'Views', icon: PhSquaresFour }
  ]

export function useCharacterWizard(deps: CharacterWizardDeps) {
  // 正在编辑(新建)的表单:向导开着没有
  const editing = ref(false)
  /* 这两份状态归页面(草稿那一块也读同一份),这里只拿引用 */
  const { editingId, draft, draftError } = deps
  /** 开向导。不带角色是新建,带角色是改它 ——
   *  两种都从第 1 步那张表单开始,差别只在预填与"存下去是新的一条还是改这一条" */
  function startEdit(c?: Character) {
    // 上一轮可能在等起稿或识图结果:整份作废,免得它回来盖掉这次打开的表单
    deps.cancelDraft()
    deps.cancelVision()
    /* 表单本身交给 useCharacterDraft:预填、清标记、清"已读"痕迹都在它那儿 */
    deps.resetDraft(c)
    /* 这条角色**已经记着**的那段样本算是"有主"的。开一轮新表单时先认下来,
       否则编辑一个已克隆过的角色、什么都不动就退出,会把它的样本删掉 */
    deps.markSampleCommitted(c?.voice?.sampleId)
    /* 向导从头开始:上一次留下的 id、步数与起稿标记必须清掉,否则会直接跳进旧角色的第 3 步。
       wizardId 归零:新建流程里它是"第 1 步存下的那条",要等存完才有;
       编辑流程里谁在库里由 editingId 说(见 activeCharId),它也不必在这一轮被认成 wizardId */
    step.value = 1
    wizardId.value = ''
    /* 上一轮的"存完跳到哪一步"不能留到这一轮:上一次若存失败,标记还在,
       这次随便存点什么都跳到第 3 步去了 */
    afterSaveStep = 0
    editing.value = true
    /* 向导是漂浮卡,相当于开了一层模态:焦点得收进卡里。
       落点选卡片本身而不是第一个输入框 —— 先让读屏念出这张卡是什么,
       再让用户自己 Tab 进"名字"那一栏 */
    restoreWizardFocus = document.activeElement as HTMLElement | null
    nextTick(() => wizardBox.value?.focus())
  }

  /** 从详情页 Voice 那一块进来改嗓音:直接把步数拨到第 2 步。
   *
   *  它现在只是一条**捷径**,不再是唯一入口 —— startEdit 那条路上
   *  第 2 步本来就是开着的(见 activeCharId)。这一枚省掉的是"先落回第 1 步
   *  再自己点一下 Voice"。
   *
   *  所以这里不再去认 wizardId:那会让第 1 步那张表单变成只读摘要
   *  (表单的判据是 `!wizardId`),从嗓音往回退一步就改不了设定了。 */
  function startVoiceEdit(c: Character) {
    startEdit(c)
    step.value = 2
  }

  /* —— 新建向导 ——
     建角色本来是"填表 → 存 → 出图"一条线,拆成两页看着像两件事。
     现在摊成三步:基础信息(或参考图)→ 主视图 → 其余设定图,
     每步一张卡,步骤条在卡头上说明"现在在哪、还差什么"。

     角色在第 1 步保存时落库 —— 第 2、3 步都要 charId 才能出图。
     所以第 1 步存下之后转成只读摘要:这一页没有"改角色",
     留着可编辑的表单只会让人再点一次保存,多出一个副本 */
  const step = ref<WizardStep>(1)
  // 向导进行中的角色 id。第 1 步存完才有,后两步都靠它取图
  const wizardId = ref('')
  /* 这一轮向导说的**是哪条角色**:新建流程里是第 1 步存下的那条(wizardId),
     编辑流程里就是正在改的那条(editingId —— 它本来就在库里)。
     第 2 步(嗓音)能不能进、存哪一条,读的都是这一个。

     原来这两件事只认 wizardId,于是编辑态永远进不去第 2 步:一个角色的嗓子
     建完就再也改不了,只能回详情页点"Change voice"走另一条入口 ——
     而那条入口做的事与"编辑"完全一样(同一张卡、同一份草稿、同一个存盘),
     差别只是它偷偷把 wizardId 认成了这条角色。现在把这层窗户纸捅破:
     编辑态本来就有 id,用不着绕。 */
  const activeCharId = computed(() => wizardId.value || editingId.value)
  // 漂浮卡本身:用来把焦点收进来、把 Tab 圈住(与看大图的 viewerBox 同一套)
  const wizardBox = ref<HTMLElement | null>(null)
  // 打开向导时焦点在哪,关掉要还回去
  let restoreWizardFocus: HTMLElement | null = null

  const wizardChar = computed(() => deps.characters().find((c) => c.id === wizardId.value))
  function wizardViewOf(kind: CharacterViewKind): CharacterView | undefined {
    return deps.views()[wizardId.value]?.find((v) => v.kind === kind)
  }
  const wizardFront = computed(() => wizardViewOf('front'))

  /** 生成正脸会拿哪张图当参考。这是第 2 步最该说清的一件事:
   *  有参考图就是图生图,没有就是纯文字生图 —— 出来的东西差别很大。
   *  指的是第一步上传的那张底图(见 types.ts 的 sourceRef);
   *  老角色没有这一项,退回主图 —— 那批的 ref 里存的就是图本身 */
  const heroSource = computed(() => {
    const c = wizardChar.value
    return c?.sourceRef || c?.ref ? 'Your reference image' : 'Text only — no reference image'
  })
  // 第 3 步的四张,主视图不在其中
  const wizardRest = computed(() =>
    CHARACTER_VIEWS.filter((v) => v.kind !== 'front').map((v) => ({ ...v, view: wizardViewOf(v.kind) }))
  )
  const restMissing = computed(() => wizardRest.value.filter((c) => !c.view).length)
  /* 一次补齐的按钮文案。四张齐了就该停下 —— 齐了还能点、点了没反应,看着像坏了 */
  const restLabel = computed(() =>
    restMissing.value ? `Generate ${restMissing.value} remaining` : 'All views ready'
  )

  /** 这一步能不能进。声音与设定图都挂在角色上,所以后两步的前提是同一个:
   *  角色已经在库里 —— 新建时是第 1 步存下的那条,编辑时就是正改的这条。
   *  **第 3 步不再要求先有正脸** —— 正脸现在就在那一屏里,是它的第一件事 */
  function stepUnlocked(n: WizardStep): boolean {
    if (n === 1) return true
    return !!activeCharId.value
  }
  /** 这一步做完没有。做完的在步骤条上打勾,和"正在这一步"区分开 */
  function stepDone(n: WizardStep): boolean {
    /* 第 1、2 步同一个条件:声音没有"做完"这回事 —— 不配就是系统自带的那把嗓子,
       同样是一种选好的状态。角色存下来了,这两步就都算走过。
       (曾把第 2 步写成"配了自定义音色才算",可那样保持默认的人会在步骤条上
       看到一个永远不打勾的第 2 步,像是漏了什么,回头去看又没什么可填的) */
    if (n === 1 || n === 2) return !!wizardId.value
    return false
  }
  function goStep(n: WizardStep) {
    if (stepUnlocked(n)) step.value = n
  }
  /** 步骤条上两段连接线:x-1 与 x 之间那段,只在前一步做完时才点亮 */
  function lineDone(n: WizardStep): boolean {
    return n > 1 && stepDone((n - 1) as WizardStep)
  }
  function backStep() {
    if (step.value > 1) step.value = (step.value - 1) as WizardStep
  }

  /* 向导走到有角色的那一步就先把它的设定图取出来 ——
     第 2、3 步要读五格的状态,不取的话"正在生成"的那格看起来和空格子一样。
     只在编辑态里取:列表页不碰这些图(与 App 的 loadCharViews 同一约定) */
  watch([editing, wizardId], () => {
    if (editing.value && wizardId.value) deps.emitOpen(wizardId.value)
  })

  /** 第 1 步存完由父组件回调:拿到 id,推进到主视图那一步。
   *  中间不退到列表 —— 这条向导是一口气走完的 */
  function onSaved(id: string) {
    wizardId.value = id
    step.value = 2
    // 后两步要读这个角色的图:取图由上面的 watch 负责,拿到 id 就会去取
  }

  /** 存完之后要跳到哪一步。0 = 不跳(收尾回详情)。
   *
   *  为什么需要它:父组件只知道"存好了",不知道这一轮是**从详情页进来改设定**
   *  还是**在向导里改声音** —— 前者要收尾,后者要接着往下走。
   *  而"存完该去哪"本来就归这一页管(步数在这里),所以这个标记也留在这里 */
  let afterSaveStep = 0

  /** 改完一条已有角色,由父组件回调。
   *  默认收尾:关掉向导回到详情页 —— 从详情页进来那一轮到此为止。
   *  但向导中途的保存(第 2 步存声音)不算收尾,接着往下走 */
  function onUpdated(id: string) {
    /* -1:向导已经关了(用户在声音那一步直接按了 Close,我们顺手把改动存了)——
       存完什么都不做。不拦这一下的话,他会从当前页面被拽去这个角色的详情页 */
    if (afterSaveStep === -1) {
      afterSaveStep = 0
      return
    }
    if (afterSaveStep) {
      step.value = afterSaveStep as WizardStep
      afterSaveStep = 0
      return
    }
    /* 与 finishWizard 一样是"换页"而不是"关浮层":列表里那个按钮已经不在,
       焦点还回去只会掉在 body 上 */
    restoreWizardFocus = null
    editing.value = false
    editingId.value = ''
    draftError.value = ''
    deps.openDetail(id)
  }

  /** 退出向导。第 1 步还没存,退了就当没发生;
   *  存过之后角色已经在库里,退了它自己会出现在列表里 */
  function closeWizard() {
    // 关掉这一轮就把在途的起稿与识图一并作废:它们的结果不该落到下一次打开的表单里
    deps.cancelDraft()
    deps.cancelVision()
    /* 声音那一步的改动还没提交就走人 —— 顺手把它存了。
       那一步只有一个"Save & continue"的提交入口,而按 Close 的意图是"结束",
       不该因为没点那个按钮就把刚配好的嗓子丢掉(见 saveFromVoiceStep 的 -1)。
       **必须排在 dropOrphanVoiceSample 之前**:保存会把 sampleId 记成"有主",
       那之后清理才不会把刚认领的样本删掉 */
    if (step.value === 2 && activeCharId.value) saveFromVoiceStep(-1)
    /* 正念着的试听也停掉,并把这一轮建出来、却没人认领的那段克隆录音清掉 ——
       它是用户的录音,留着既没用又该清 */
    stopSpeaking()
    void deps.dropOrphanVoiceSample()
    editing.value = false
    editingId.value = ''
    step.value = 1
    wizardId.value = ''
    draftError.value = ''
    /* 焦点还回当初点开的那个按钮 —— 不还的话键盘用户关掉浮层后
       焦点会掉到 body 上,得从头 Tab 一遍(与关大图同一条理由) */
    const back = restoreWizardFocus
    restoreWizardFocus = null
    if (back) nextTick(() => back.focus())
  }

  /** 走完三步:把角色交给详情页 —— 那里是它的"落地页",
   *  有完整设定表、大图查看,以及"用它开画" */
  function finishWizard() {
    const id = activeCharId.value
    /* 走完是"换页"而不是"关浮层",所以不留焦点还回目标 ——
       列表里那个按钮已经不在页面上了,还回去只会把焦点丢在 body */
    restoreWizardFocus = null
    closeWizard()
    if (id) deps.openDetail(id)
  }


  /** 第 2 步(声音)的保存。
   *
   *  **不能直接复用 submit**:那个按 editingId 判断"改这一条还是新建",
   *  而走出向导的新建流程里 editingId 一直是空的 —— 角色是第 1 步存下的,
   *  它不是"正在编辑的对象"。照那个判断会把同一个角色再存出一条副本。
   *  所以这里显式带上 wizardId,并交代"存完跳到第 3 步"。
   *
   *  它同时把整份草稿交出去(名字、设定、参考图都一样)—— 不只是声音:
   *  这一屏能改的其实只有声音,但交一份残缺的表单反而要父组件去猜哪几项没动 */
  function saveFromVoiceStep(nextStep: number) {
    const id = activeCharId.value
    if (!id) return
    const d = draft.value
    /* 存完去哪由调用方定:从"Save & continue"来的是 3(接着去出图),
       从关闭按钮来的是 -1(向导已经关了,存完什么都别做 ——
       否则父组件的收尾会把人从当前页拽到这个角色的详情页去) */
    afterSaveStep = nextStep
    deps.save({
      id,
      name: d.name,
      fields: { ...d.fields },
      persona: { ...d.persona },
      voice: { ...d.voice },
      desc: d.desc,
      refData: d.ref
    })
    deps.markSampleCommitted(d.voice.sampleId)
  }
  return {
    editing,
    step,
    wizardId,
    wizardBox,
    wizardChar,
    wizardFront,
    heroSource,
    wizardRest,
    restMissing,
    restLabel,
    stepUnlocked,
    stepDone,
    goStep,
    lineDone,
    backStep,
    onSaved,
    onUpdated,
    closeWizard,
    finishWizard,
    saveFromVoiceStep,
    startEdit,
    startVoiceEdit
  }
}
