<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  PhMaskHappy,
  PhPlus,
  PhCopy,
  PhDownloadSimple,
  PhTrash,
  PhSparkle,
  PhUploadSimple,
  PhArrowLeft,
  PhArrowRight,
  PhArrowsClockwise,
  PhCaretDown,
  PhCaretLeft,
  PhCaretRight,
  PhCheck,
  PhEye,
  PhImage,
  PhPencilSimple,
  PhSpeakerHigh,
  PhStopCircle,
  PhX,
  PhChatCircleDots
} from '@phosphor-icons/vue'
import {
  coverSrc
} from '../api'
import LatticeLoader from './LatticeLoader.vue'
// 角色海报卡(顶图 + 名字 + 特征 + 用量 + ⋮ 菜单)。只做展示与上报
import CharacterCard from './CharacterCard.vue'
// 设定图格子(生成中 / 已有图 / 空格 / 锁着)。三处共用,只做展示与上报
import ViewCell from './ViewCell.vue'
import type {
  ApiConfig,
  Character,
  CharacterFields,
  CharacterPersona,
  CharacterStat,
  CharacterView,
  CharacterViewKind,
  CharacterVoice,
  CharacterWork,
  HistoryEntry
} from '../types'
import { vGrow } from '../lib/grow'
/* 作品墙上那枚"这是对话里来的"角标要说的话(见 lib/chatWork)。
   与历史页、预览卡共用同一份口径 —— 三处不能各说各的 */
import { chatWorkLabel } from '../lib/chatWork'
// 浮层的公共行为(Tab 圈定 / 点外收起 / Esc 逐层退)
import { layerOnEscape, trapTab } from '../lib/ui'
import { speakingId, stopSpeaking } from '../lib/speech'
import { VOICE_SOURCES, useCharacterVoice } from '../composables/useCharacterVoice'
import { emptyCharacterDraft, useCharacterDraft } from '../composables/useCharacterDraft'
import { useCharacterDetail } from '../composables/useCharacterDetail'
import { STEPS, useCharacterWizard } from '../composables/useCharacterWizard'
import { useCharacterList } from '../composables/useCharacterList'
import {
  FORM_GROUPS,
  PERSONA_FIELDS,
  STYLE_FIELD,
  genderOptionsFor,
  personaRows,
  specRows,
  styleOptionsFor
} from '../lib/characterSpec'

/* 角色:网站的重点页面。
   一个角色 = 一组设定图 + 一段结构化设定。设定图是它的骨架 ——
   正脸当锚,其余四张都以正脸为参考图生成,这是跨图保持同一张脸的唯一办法。

   这一页只管展示与编排:生成、落盘、存储都在主界面 ——
   参考图与设定的字节归 App/IndexedDB 管,这里只发意图(与预览卡同一套分工) */

const props = defineProps<{
  characters: Character[]
  // 按角色 id 缓存的设定图。主界面按需从 IndexedDB 取,这里只读
  views: Record<string, CharacterView[]>
  /* 按角色 id 聚合的用量(生成次数 / 最后使用时间)。源数据是历史记录,
     主界面算好传进来 —— 这一页不碰历史 */
  stats: Record<string, CharacterStat>
  /* 按角色 id 归拢的作品:用这个角色出过的图。源数据同样是历史记录,
     与 stats 一起在主界面算好 —— 这一页不碰历史,只负责摆 */
  works: Record<string, CharacterWork[]>
  /* 各角色正在生成哪几张视图(没有该角色的键 = 空闲)。
     必须按角色分开 —— A 的正脸在跑时切到 B,B 的格子不该跟着显示"生成中" */
  busy: Record<string, CharacterViewKind[]>
  // 起稿要用的文本模型配置。没配就走不了 AI 起稿,但手填照常
  textConfig?: ApiConfig
  /* 识图要用的视觉模型配置。上传参考图后就是它在读这张图 ——
     没配也不拦着上传:图本身当参考照常用得着,只是不会反填设定 */
  visionConfig?: ApiConfig
  /* 朗读要用的合成配置。没配时音色区会提示去配一条,而朗读会退回浏览器自带的语音 ——
     "能出声"和"是这个角色自己的嗓子"之间的分界线就在这一条配置上 */
  ttsConfig?: ApiConfig
}>()

const emit = defineEmits<{
  /* 带 id 是改这一条,不带是新建 —— 落盘由主界面按这个分支走 */
  (e: 'save', payload: {
    id?: string
    name: string
    fields: CharacterFields
    persona: CharacterPersona
    voice: CharacterVoice
    desc: string
    refData: string
  }): void
  (e: 'remove', id: string): void
  // 复制:目录与图都由主界面拷一份(这一页不碰字节)
  (e: 'duplicate', id: string): void
  // 置顶 / 取消置顶。落在角色自己身上(Character.pinned),由主界面写盘
  (e: 'pin', id: string): void
  // 导出成一个 zip。文件本身也由主界面生成 —— 打包要读图,那不归这一页管
  (e: 'export', id: string): void
  // 导入:只把选中的文件交出去,怎么读怎么落盘由主界面决定(与上面同一条分工)
  (e: 'import', file: File): void
  (e: 'open', id: string): void
  /* 点开一件作品:交出去的是那条历史记录本身,由主界面开预览 ——
     与历史图墙、首页图砖走同一个入口 */
  (e: 'preview', entry: HistoryEntry): void
  // 跟这个角色说话:跳到对话页并选中它,由主界面负责跳转
  (e: 'chat', id: string): void
  (e: 'generate', charId: string, kind: CharacterViewKind): void
  (e: 'generateAll', charId: string): void
  // 停掉某个角色正在跑的那一张设定图(只停它)。中断手柄在主界面(请求从那里发出)
  (e: 'stopView', charId: string, kind: CharacterViewKind): void
}>()

// 导入用的隐藏 file input:页头那个按钮点它(见模板里的注释)
const importInput = ref<HTMLInputElement | null>(null)



/* 两个视图态:列表(空)与详情(有 id)。
   设定图与整套设定都挪进详情 —— 五张图加整套设定挤在一张卡上,
   既不好看也点不明白:点已有图会重新生成、想看大图又没地方看 */
/* 这一轮向导改的是哪个已保存角色(空 = 新建)。
   刻意不和 wizardId 合并:wizardId 是"向导进行中的角色",新建时第 1 步存完才有,
   而它同时是第 2、3 步的解锁条件(stepUnlocked)—— 编辑一条已有的角色时
   这两步不该解锁,那一轮只做第 1 步 */
const editingId = ref('')
const draft = ref(emptyCharacterDraft())
/* 嗓音(音色来源 / 试听 / 克隆 / 样本认领)。**依赖只有三样**:
   草稿里的 voice、正在编辑的角色 id、以及 TTS 配置 —— 后者用惰性函数传,
   因为 props 会变(见 useCharacterVoice 里的说明) */
const {
  voiceSource,
  voiceSourceHint,
  setVoiceSource,
  auditioning,
  voiceError,
  auditionVoice,
  cloneBusy,
  cloneError,
  onVoiceSample,
  markSampleCommitted,
  dropOrphanVoiceSample,
  onCloneIdTyped,
  voiceRows,
  auditionChar
} = useCharacterVoice({
  draft,
  editingId,
  // 试听什么语言由草稿里那一栏说了算(见 CharacterVoiceDeps.draftLanguage)
  draftLanguage: () => draft.value.persona.language,
  ttsConfig: () => props.ttsConfig
})

/* 草稿表单:内容、AI 起稿填过的标记、识图那一路、参考图的读入、以及提交。
   **向导本身**(步数、向导 id、开关与焦点)留在这一页 ——
   那些是"界面走到哪儿",而这里是"表单里有什么"。
   draft 与 editingId 也留在这一页:上面那块嗓音要读同一份,状态放这儿两边才不互相依赖 */
const {
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
} = useCharacterDraft({
  draft,
  editingId,
  characters: () => props.characters,
  textConfig: () => props.textConfig,
  visionConfig: () => props.visionConfig,
  save: (payload) => emit('save', payload),
  importFile: (file) => emit('import', file),
  markSampleCommitted
})


/* 规格字段是 textarea,随内容长高。
   为什么不用 <input>:字段值上限 12 个词(约 70 字符),两列之后每栏只有 338px,
   在 13px 下约 55 字符 —— 边界值会被截在视野外,只能靠方向键摸。
   封顶三行、再多内部滚(见样式),不然一栏长起来会把整行拉高 */
/* 详情与设定图查看器:五格设定图、锁定与"生成中"的判断、作品墙、全屏看大图。
   **导航留在这一页** —— openDetail / backToList 要顺手收起卡片菜单、还要发事件给主界面 */
const {
  detailId,
  viewer,
  detailChar,
  statOf,
  fmtDay,
  traitsOf,
  heroMeta,
  coverOf,
  avatarSrc,
  sheetCells,
  filledCount,
  missingCount,
  works,
  worksShown,
  worksRest,
  workSrc,
  hasFront,
  isLocked,
  isMainView,
  isBusy,
  frontBusy,
  viewBlocked,
  detailBusy,
  viewerRegenBlocked,
  busyLabel,
  generateAllLabel,
  viewerKinds,
  viewerSrc,
  viewerLabel,
  viewerPos,
  viewerBox,
  openViewer,
  closeViewer,
  stepViewer,
  regenerateViewer,
  heroSub
} = useCharacterDetail({
  characters: () => props.characters,
  views: () => props.views,
  stats: () => props.stats,
  works: () => props.works,
  busy: () => props.busy,
  emitGenerate: (charId, kind) => emit('generate', charId, kind)
})

/* —— 作品墙上"这张是哪来的" ——
   一格小样里混着两样东西:拿这个角色做出来的图,与它在对话里发来/生成的图
   (见 App 的 saveChatWork)。图标角标给眼睛看,这两句给读屏 ——
   只画一枚图标而不改 aria-label,读屏用户听到的还是"Open the image from 10-05",
   分不出这一格与旁边那些有什么区别 */
function workLabel(w: { entry: HistoryEntry }): string {
  return chatWorkLabel(w.entry.source)
}
function workAria(w: { entry: HistoryEntry }): string {
  const src = workLabel(w)
  return src
    ? `Open the image from ${fmtDay(w.entry.createdAt)} — ${src}`
    : `Open the image from ${fmtDay(w.entry.createdAt)}`
}

/* 三步向导的编排:步数、进行中的角色 id、开关与焦点、存完去哪。
   表单内容与声音分别在 useCharacterDraft / useCharacterVoice 里,这里只调度 */
const {
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
} = useCharacterWizard({
  characters: () => props.characters,
  views: () => props.views,
  draft,
  draftError,
  resetDraft,
  cancelDraft,
  cancelVision,
  editingId,
  markSampleCommitted,
  dropOrphanVoiceSample,
  save: (payload) => emit('save', payload),
  emitOpen: (id) => emit('open', id),
  openDetail: (id) => openDetail(id)
})

/* 主界面拿这个 ref 回调向导的两处收尾:存完推进、改完收尾
   (见 App 的 saveCharFromPage / charPageRef) */
/* openDetail 也交出去:对话页头部的 Details 要直接落到**这个角色**的详情,
   而不是把用户扔到角色列表让他自己再找一遍 */
defineExpose({ onSaved, onUpdated, openDetail })

/* 卡头上摆几步。编辑态只走前两步(设定 / 嗓音)——
   出图那一步这一轮不做:五张设定图在详情页已经有整片网格(点开看大图、
   重出、一次补齐都在那儿),再塞进编辑向导就是两处做同一件事。
   而嗓音必须留着:它是这个角色的一部分,编辑态进不去的话,一个角色的嗓子
   建完就只能从详情页那枚 "Change voice" 改 —— 两个入口,其中一个还做不全 */
const wizardSteps = computed(() => (isEditing.value ? STEPS.filter((s) => s.n <= 2) : STEPS))

/* 列表顺序与卡片 ⋮ 菜单(开合 / 指针宽限 / 点外收起 / 四个动作的转发)。
   顺序是**派生**的:置顶在前,其余保持主界面给的顺序(最近建的在前) */
const {
  openCardMenu,
  cardMenuUp,
  closeCardMenu,
  toggleCardMenu,
  onMenuEnter,
  onMenuLeave,
  editFromCard,
  duplicateFromCard,
  pinFromCard,
  exportFromCard,
  removeFromCard,
  listedChars
} = useCharacterList({
  characters: () => props.characters,
  startEdit: (c) => startEdit(c),
  duplicate: (id) => emit('duplicate', id),
  pin: (id) => emit('pin', id),
  exportChar: (id) => emit('export', id),
  remove: (id) => emit('remove', id)
})


function openDetail(id: string) {
  detailId.value = id
  viewer.value = ''
  closeCardMenu()
  // 进详情才去取图:列表阶段一张都不读 IndexedDB
  emit('open', id)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

/* 卡片上那枚 Create:套上这个角色直接回工作台,由主界面负责跳转 ——
   与详情页那枚、左栏那次转发说的是同一件事 */
function createFromCard(id: string) {
  emit('chat', id)
}

function backToList() {
  detailId.value = ''
  viewer.value = ''
}


/* Esc 逐层退:先关大图,再关向导,最后回列表 ——
   开着大图按 Esc 直接退出详情会让人丢掉"我看的是哪个角色"。
   左右键在大图里翻页,和预览卡同一套操作 */
function onKey(e: KeyboardEvent) {
  if (
    layerOnEscape(e.key, [
      { open: !!viewer.value, close: closeViewer },
      { open: !!openCardMenu.value, close: closeCardMenu },
      { open: editing.value, close: closeWizard },
      { open: !!detailId.value, close: backToList }
    ])
  ) {
    return
  }
  // 大图与向导都是模态,但同一时刻只会开一个(一个在详情里,一个在列表里)
  if (viewer.value) {
    if (e.key === 'Tab') trapTab(viewerBox.value, e)
    else if (e.key === 'ArrowLeft') stepViewer(-1)
    else if (e.key === 'ArrowRight') stepViewer(1)
  } else if (editing.value && e.key === 'Tab') {
    trapTab(wizardBox.value, e)
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  /* 离开这一页就把嘴闭上:试听不属于"后台也该继续"的那类东西 */
  stopSpeaking()
})

/* 字段规格表(键/标签/占位示例)与详情页那两张只读表都搬进了
   lib/characterSpec.ts —— 它们是纯数据与纯函数,与页面无关。
   这里只留"往草稿里写"的那一步。
   (genderOptions / styleOptions 本来是这里的 computed,现在收成 characterSpec
     里的纯函数 —— 它们各自只依赖那一个值) */
const genderOptions = computed(() => genderOptionsFor(draft.value.fields.gender))
const styleOptions = computed(() => styleOptionsFor(draft.value.fields.style))

/* 这两栏的下拉要"贴着当前的值"那么宽(见 .wz-select 的说明),而原生 select
   的宽度取的是**最长的那一枚选项**,不是选中的那一枚 —— 于是选中 Auto 时
   文字与箭头之间会空出一大截("Photorealistic" 的宽度)。所以真正参与排版的是
   下面这两个字符串:它们被一层 visibility:hidden 的元素量出宽度,下拉本体
   绝对定位盖在上面。值是什么,框就是多宽 */
const genderLabel = computed(() => draft.value.fields.gender.trim() || 'Select…')
const styleLabel = computed(() => {
  const v = draft.value.fields.style.trim()
  return (styleOptions.value.find((o) => o.value === v) || styleOptions.value[0]).label
})

function pickGender(v: string) {
  draft.value.fields.gender = v
  markEdited('gender')
}

function pickStyle(v: string) {
  draft.value.fields.style = v
  markEdited('style')
}


</script>

<template>
  <div class="chars">
    <!-- —— 列表 —— -->
    <template v-if="!detailChar">
      <header class="chars-head">
        <!-- 页面名不在这儿写第二遍:顶部横条的字标已经在说"Characters" -->
        <p class="chars-sub">
          A fixed spec plus a set of reference views. Pick a character while composing and both are
          applied, so the face stays the same across images.
        </p>
        <!-- 导入放页头:它是一次针对整个角色区的动作(一个包里可能有多个角色),
             不属于某一张卡。按钮用 <button> 触发那个隐藏 input 而不是用 label ——
             label 本身进不了 Tab 键序,键盘用户就点不到 -->
        <div v-if="!editing" class="chars-acts">
          <button class="chars-import" @click="importInput?.click()">
            <PhUploadSimple aria-hidden="true" />
            Import
          </button>
          <button class="chars-new" @click="startEdit()">
            <PhPlus aria-hidden="true" />
            New character
          </button>
        </div>
      </header>

    </template>

    <!-- 浮层**不能待在列表那个分支里**:它要在两个地方都能开 —— 列表页的
         "New character" 和详情页的 "Edit"。原先它嵌在 `v-if="!detailChar"`
         的列表分支内,于是从详情页点 Edit 时它根本不在 DOM 里(点了没反应)。
         所以这里把列表分支切成两段,让浮层落在中间、两个分支之外 -->

    <!-- —— 新建向导:漂浮卡 ——
           创建是一条独立流程,不该插进列表里把页面顶开 —— 它是盖在这一页之上的一层,
           关掉就回到原样。三步摊成一张卡:步骤条在头上,内容在中间,进退在脚下;
           没做到的那一步在条上是锁的,点不动 —— 顺序靠结构说,不靠报错说。
           暗幕是与卡片平级的另一个 fixed 元素,不是把卡包起来(理由见样式注释) -->
      <div v-if="editing" class="wz-veil" aria-hidden="true"></div>
      <section
        v-if="editing"
        ref="wizardBox"
        class="wizard"
        role="dialog"
        aria-modal="true"
        :aria-label="isEditing ? 'Edit character' : 'New character'"
        tabindex="-1"
      >
        <!-- 卡头是步骤条。新建三步,编辑两步(见 wizardSteps)。

             编辑态原来没有这条步骤条,只给一句 "Edit {name}" —— 于是
             **改嗓音这件事在这一页根本走不到**:第 2 步是锁的,一个角色的嗓子
             建完就只能回详情页点 "Change voice" 走另一条入口。可编辑态本来就
             有 id(角色就在库里),后两步没有任何理由锁着。
             现在两个入口合流:详情页那一枚仍是一条捷径(直接落在第 2 步),
             从 Edit 进来也能自己点过去 -->
        <nav class="wz-steps" aria-label="Creation steps">
          <template v-if="isEditing">
            <h3 class="wz-edit-title">Edit {{ editingChar?.name }}</h3>
            <!-- 那句话跟着**当前这一步**走,不跟"从哪个入口进来"走:
                 编辑态现在两步都到得了,从设定点过嗓音、或从嗓音退回设定,
                 卡头这句都得说对 -->
            <p class="wz-edit-sub">
              {{
                step === 2
                  ? 'The voice is what this character sounds like when read aloud. Its spec is untouched.'
                  : 'The spec is what every image of this character is built from — the reference views stay as they are.'
              }}
            </p>
          </template>
          <div class="wz-step-row">
          <template v-for="s in wizardSteps" :key="s.n">
            <span
              v-if="s.n > 1"
              class="wz-line"
              :class="{ 'is-done': lineDone(s.n) }"
              aria-hidden="true"
            ></span>
            <button
              class="wz-step"
              :class="{
                'is-active': step === s.n,
                'is-done': stepDone(s.n) && step !== s.n,
                'is-locked': !stepUnlocked(s.n)
              }"
              :disabled="!stepUnlocked(s.n)"
              :aria-current="step === s.n ? 'step' : undefined"
              @click="goStep(s.n)"
            >
              <!-- 圆点里放这一步的图标,不写序号:
                   旁边就是这一步的名字,一枚图标比一个数字更早被认出来,
                   而三枚图标本身也把"从哪儿走到哪儿"画出来了。
                   做完的那枚换成对勾(图标的位置留给"已经过站"这件事)。
                   两枚都 aria-hidden —— 这一步叫什么,由旁边的 .wz-name 说 -->
              <span class="wz-dot">
                <PhCheck v-if="stepDone(s.n) && step !== s.n" weight="bold" aria-hidden="true" />
                <component :is="s.icon" v-else weight="bold" aria-hidden="true" />
              </span>
              <span class="wz-name">{{ s.label }}</span>
            </button>
          </template>
          </div>
        </nav>

        <div class="wz-body">
          <!-- 曾经这里还有一栏"这个角色是什么"的常驻摘要(名字 + 已填的设定,
               第 3 步再加上一枚主视图缩略)。去掉的理由是它没在干活:
                 · 设定就在下面那张表里,而且是可改的 —— 右栏那份是同一份东西的
                   只读副本,校对时眼睛本来就在可改的那几行上;
                 · 第 3 步要的"基准图"就在那一屏正中间(主视图那一格比缩略图大得多),
                   再缩到 100px 摆一遍,比的是同一张图;
                 · 它占掉 248px,而三步里有两步基本空着 —— 空着的那一栏
                   还把"这里应该有点什么"写在脸上。
               现在卡身只有一栏:一次回答一件事 -->
          <!-- 第 1、2 步共用这一屏。第 1 步是"这个人是谁"(存下之前是可填的表单,
               存下之后换成只读摘要 —— 角色已经落库,再点一次只会多一个副本);
               第 2 步是"它听起来什么样",整组声音字段见下面那个 step === 2 -->
          <div v-if="step === 1 || step === 2" class="wz-pane wz-form">
            <template v-if="step === 1 && !wizardId">
              <!-- 起稿块是这一页的重点:大多数人是一句话起稿、再逐栏校对,
                   而不是从空白一栏栏手填。所以它拿的是整张卡上唯一一块"区域"待遇,
                   并且自带标题与引导语 —— 标题问的是人,不是这个工具;
                   引导语只说"一句话就能开工、出来的东西还能改",
                   不描述机器在背后做什么(原来那句 "Fills the name and the spec —
                   check what it got wrong" 就是后一种,读起来像说明书)。
                   报错与状态仍旧留在这块里,离触发它的按钮最近。
                   起稿中整块走等待态光晕:光晕只能画在能放伪元素的元素上,
                   而 textarea 是替换元素、::after 不生效,所以挂在这块上 ——
                   它正是这次起稿要交付的那一件东西 -->
              <!-- 起稿块只在新建时给:编辑是"改几栏",不是"让模型重编一份" ——
                   摆在这里会变成一个大号的"覆盖我刚写的东西" -->
              <div v-if="!isEditing" class="wz-draft" :class="{ 'halo-breathe': drafting }">
                <div class="wz-draft-head">
                  <h3 class="wz-draft-title">Who are you creating?</h3>
                  <p class="wz-draft-sub">
                    A sentence, a vibe, a half-formed idea — start anywhere. The details below
                    are only a starting point.
                  </p>
                </div>
                <!-- 这一栏收的是"一个人的样子",不是一个词,所以给的是一个 textarea:
                     两行起步、随内容长高(见 vGrow),写满一句不用横向滚动;
                     长到 6 行封顶,再多转内部滚动(见 textarea.wz-idea) -->
                <textarea
                  v-model="idea"
                  v-grow
                  rows="2"
                  class="ed-input wz-idea"
                  aria-label="Describe the character"
                  placeholder="A retired sea captain in her sixties, sun-beaten and quiet"
                  @keydown.enter="onIdeaEnter"
                ></textarea>
                <!-- 提示/报错占左边的余量,主按钮靠右钉住 —— 没有提示时按钮也不动位置 -->
                <div class="wz-draft-foot">
                  <p v-if="draftError" class="wz-err" role="alert">{{ draftError }}</p>
                  <p v-else-if="drafting" class="wz-draft-hint">Filling in the spec…</p>
                  <!-- 有标出来的栏时换成图例。图例放在这里而不是各组的说明里:
                       标记是这一块产生的,而且两组里都可能有 —— 挂在哪一组都是偏的 -->
                  <p v-else-if="hasAiFilled" class="wz-draft-hint">
                    <span class="wz-ai" aria-hidden="true">AI</span>
                    written by the model — the mark clears once you edit that line
                  </p>
                  <button
                    class="ed-btn primary"
                    :disabled="drafting || !idea.trim()"
                    @click="draftWithAI"
                  >
                    <PhSparkle aria-hidden="true" />
                    {{ drafting ? 'Drafting…' : hasSpec ? 'Draft again' : 'Draft the spec' }}
                  </button>
                </div>
              </div>

              <!-- 基础信息:全表仅有的两条必填,而且都是"这个人是谁"的一部分 ——
                   姓名是给这张卡的,性别是给模型定脸的第一道条件。
                   它们和下面的 Spec / Reference sheet only 是平级的一组,
                   所以同样有组标题。

                   必填靠字段名后面那枚星号,不写 "Required" 这个词:
                   "Required" 有八九个字符,挂在 88px 的标签列里会把
                   放得下的行和放不下的行推成两种版式,而且一路念下来,
                   到第二行它就不再是信息、只是噪音了(见 .wz-mark)。
                   星号给读屏留了 aria-hidden,必填这件事由控件自己的
                   aria-required 说 —— 语义不走装饰

                   性别给按钮而不是输入框:模型只认 female / male 这两个词,
                   留一栏自由文字等于又把这件事交回给它去猜 -->
              <div class="wz-group">
                <div class="wz-group-head">
                  <h4 class="wz-group-title">Basics</h4>
                  <span class="wz-group-hint">
                    The name on the card, the word the model uses to place a face, and how every
                    image of them is drawn.
                  </span>
                </div>

                <div class="wz-basics">
                  <label class="wz-field">
                    <span class="wz-label">
                      Name
                      <span class="wz-mark" aria-hidden="true">*</span>
                    </span>
                    <input
                      v-model="draft.name"
                      class="ed-input"
                      placeholder="Name this character"
                      aria-required="true"
                    />
                  </label>

                  <!-- 性别与风格:两条**闭合选择**,不是一个可以随便写的词。
                       模型只认 female / male 与那几个媒介词,留一栏自由文字
                       等于把这件事又交回给它去猜 —— 所以给的是一份下拉。

                       为什么是下拉而不是一排胶囊(原来那样):
                       一排胶囊要先画一条灰槽、把选中的那枚涂成实心墨块,
                       两个词的选项于是占掉一整条 46px 高的横档;风格那六枚
                       更是铺成 470px 宽的一整块灰板 —— 而这一页的其余每一行
                       都只是"一个灰标签 + 一行字"。这五栏里真正要读的是**值**,
                       不是控件本身;下拉收成一个值的大小,行才回到同一套读法。

                       它同时把"值"这一列留给了文字:.ed-input 那套无框无底
                       照旧,右边一枚小箭头说明"这里点得开"。
                       Auto 排在第一枚而且默认就是它 —— 有参考图时风格本来就由
                       那张图决定,再写死一个媒介词就是让文字去跟图打架
                       (见 charSpec 里 style 那条),空值会被提示词那边滤掉 -->
                  <label class="wz-field">
                    <span class="wz-label">
                      Gender
                      <span class="wz-mark" aria-hidden="true">*</span>
                      <template v-if="aiFilled.gender">
                        <span class="wz-ai" aria-hidden="true">AI</span>
                        <span class="sr-only">drafted by the model</span>
                      </template>
                    </span>
                    <span class="wz-select" :class="{ 'is-empty': !draft.fields.gender.trim() }">
                      <span class="wz-select-val" aria-hidden="true">{{ genderLabel }}</span>
                      <select
                        class="ed-input"
                        aria-required="true"
                        :value="draft.fields.gender.trim()"
                        @change="pickGender(($event.target as HTMLSelectElement).value)"
                      >
                        <option value="" disabled>Select…</option>
                        <option v-for="g in genderOptions" :key="g" :value="g">{{ g }}</option>
                      </select>
                      <PhCaretDown class="wz-select-ico" aria-hidden="true" />
                    </span>
                  </label>

                  <label class="wz-field">
                    <span class="wz-label">
                      {{ STYLE_FIELD.label }}
                      <template v-if="aiFilled.style">
                        <span class="wz-ai" aria-hidden="true">AI</span>
                        <span class="sr-only">drafted by the model</span>
                      </template>
                    </span>
                    <span class="wz-select">
                      <span class="wz-select-val" aria-hidden="true">{{ styleLabel }}</span>
                      <select
                        class="ed-input"
                        :value="draft.fields.style.trim()"
                        @change="pickStyle(($event.target as HTMLSelectElement).value)"
                      >
                        <option v-for="o in styleOptions" :key="o.value || 'auto'" :value="o.value">
                          {{ o.label }}
                        </option>
                      </select>
                      <PhCaretDown class="wz-select-ico" aria-hidden="true" />
                    </span>
                  </label>
                </div>
              </div>

              <!-- 设定分成两组,各有自己的标题。
                   这条界线的分量值得一个标题:Spec 那一组会进你每一张成品,
                   Reference sheet only 那组只塑造设定图 ——
                   它是这份设定里最要紧的一条区分。
                   两组都由 FORM_GROUPS 生成,栏位的模板只写一遍 -->
              <div v-for="g in FORM_GROUPS" :key="g.title" class="wz-group">
                <div class="wz-group-head">
                  <h4 class="wz-group-title">{{ g.title }}</h4>
                  <span class="wz-group-hint">{{ g.hint }}</span>
                </div>

                <div class="wz-fields">
                  <label v-for="f in g.fields" :key="f.key" class="wz-field">
                    <!-- 不标星号 = 可选。全表只有姓名与性别要标,
                         所以"可选"不必再写一遍(见 .wz-mark 那条注释) -->
                    <span class="wz-label">
                      {{ f.label }}
                      <template v-if="aiFilled[f.key]">
                        <span class="wz-ai" aria-hidden="true">AI</span>
                        <span class="sr-only">drafted by the model</span>
                      </template>
                    </span>
                    <textarea
                      v-grow
                      rows="1"
                      v-model="draft.fields[f.key]"
                      class="ed-input"
                      :placeholder="f.hint"
                      @input="markEdited(f.key)"
                    ></textarea>
                  </label>

                  <!-- 补充描述不进 CharacterFields(它是自由文本,不参与起稿的那份固定行),
                       所以单独写一格,占满两列。
                       它是"设定表里没覆盖到的那些要求"唯一的落点 ——
                       例如"别画成典型的 AI 脸"这种**对画法的要求**,
                       固定栏位里没有一处装得下,所以把例子写进占位符里说清它是干什么的 -->
                  <label v-if="g.notes" class="wz-field is-wide">
                    <span class="wz-label">Extra details</span>
                    <textarea
                      v-grow
                      rows="1"
                      v-model="draft.desc"
                      class="ed-input"
                      placeholder="e.g. an ordinary, non-AI-looking face, film-like skin"
                    ></textarea>
                  </label>
                </div>
              </div>

              <!-- 人格:第三组,但它与前两组不是一类东西 ——
                   那两组决定每张图长什么样,这一组只在对话里起作用。
                   所以标题不叫 "Spec",也点明它不会进出图提示词。
                   标题用 Personality 而不是 Voice:Voice 归嗓音(听得到的那个),
                   见 PERSONA_FIELDS 上面的注释 -->
              <div class="wz-group">
                <div class="wz-group-head">
                  <h4 class="wz-group-title">Personality</h4>
                  <span class="wz-group-hint">
                    Who they are and how they talk. Used in Chat only — never in your prompts.
                  </span>
                </div>

                <div class="wz-fields">
                  <label v-for="f in PERSONA_FIELDS" :key="f.key" class="wz-field">
                    <span class="wz-label">
                      {{ f.label }}
                      <!-- 起稿也会填这四栏,所以这里的标记规矩与前两组一致 -->
                      <template v-if="aiFilled[f.key]">
                        <span class="wz-ai" aria-hidden="true">AI</span>
                        <span class="sr-only">drafted by the model</span>
                      </template>
                    </span>
                    <textarea
                      v-grow
                      rows="1"
                      v-model="draft.persona[f.key]"
                      class="ed-input"
                      :placeholder="f.hint"
                      @input="markEdited(f.key)"
                    ></textarea>
                  </label>
                </div>
              </div>

            </template>

            <!-- 第 2 步:声音。它自成一屏 —— 上面那些字段回答"这个人是谁",
                 这一组回答"它听起来什么样"。两者没有先后依赖,
                 但堆在同一屏里会让信息量翻倍,而这一组本身就比别的组复杂
                 (两层选择 + 输入 + 试听)。
                 代码留在原地、只在这里切一刀:整块挪走的话,那 170 行的
                 缩进与顺序全要重排,而它本来就在这儿不需要动 -->
            <template v-if="step === 2">
              <!-- 嗓音:朗读时它听起来什么样。与上面那组人格字段是两件事 ——
                   那边是**文字**(话怎么说出来),这里是**声音本身** -->
              <div class="wz-group">
                <div class="wz-group-head">
                  <h4 class="wz-group-title">Voice</h4>
                  <span class="wz-group-hint">
                    How it sounds when read aloud. Used in Chat only — never in your prompts.
                  </span>
                </div>

                <!-- 这一组的东西比别处多(两层选择 + 输入 + 动作),而且形状和
                     上面那些"行"完全不是一回事。直接铺在表单里就会和它们糊成
                     一片 —— 给它一块自己的底,是这里唯一的边界手段 -->
                <div class="voice-panel">
                  <div class="voice-block">
                    <span class="voice-cap">Engine</span>
                    <div class="voice-seg" role="group" aria-label="Voice engine">
                      <button
                        type="button"
                        :class="{ on: draft.voice.engine === 'browser' }"
                        :aria-pressed="draft.voice.engine === 'browser' ? 'true' : 'false'"
                        @click="draft.voice.engine = 'browser'"
                      >
                        Browser voice
                      </button>
                      <button
                        type="button"
                        :class="{ on: draft.voice.engine === 'tts' }"
                        :aria-pressed="draft.voice.engine === 'tts' ? 'true' : 'false'"
                        @click="draft.voice.engine = 'tts'"
                      >
                        Custom voice
                      </button>
                    </div>
                    <p class="voice-note">
                      {{
                        draft.voice.engine === 'browser'
                          ? 'Played by your system’s own voices. Free and instant — different characters just get different voices.'
                          : !ttsConfig
                            ? 'Needs a config first: open Interface Settings, add one with the purpose “Voice”. Base URL, API key and Resource ID all live there.'
                            : 'Synthesised by your voice provider. Slower and billed per character, but this is the character’s own voice.'
                      }}
                    </p>
                  </div>

                  <template v-if="draft.voice.engine === 'tts'">
                    <div class="voice-block">
                      <span class="voice-cap">Voice source</span>
                      <div class="voice-seg" role="group" aria-label="Voice source">
                        <button
                          v-for="s in VOICE_SOURCES"
                          :key="s.id"
                          type="button"
                          :class="{ on: voiceSource() === s.id }"
                          :aria-pressed="voiceSource() === s.id ? 'true' : 'false'"
                          @click="setVoiceSource(s.id)"
                        >
                          {{ s.label }}
                        </button>
                      </div>
                      <!-- 选完这一档接着要做什么,就写在这排键底下 —— 三档的入口
                           长得一样(都是一个输入框),差别全在这句话里 -->
                      <p class="voice-note">{{ voiceSourceHint }}</p>
                    </div>

                    <!-- 要填的那一格。上面全是灰字与胶囊,这里画了整组唯一的框 ——
                         "哪些是要填的"由这个框说,不再靠一句提示 -->
                    <div class="voice-block">
                      <label v-if="voiceSource() === 'preset'" class="voice-field">
                        <span class="voice-label">Voice ID</span>
                        <span class="voice-control">
                          <input
                            v-model="draft.voice.vendorVoice"
                            class="ed-input"
                            autocapitalize="off"
                            autocorrect="off"
                            spellcheck="false"
                            placeholder="e.g. zh_female_vv_uranus_bigtts"
                          />
                        </span>
                        <span class="voice-hint">
                          The ID, not the display name. If it looks like <em>S_xxxxxxxx</em>
                          or a custom name, that is a cloned voice — use the Clone slot.
                        </span>
                      </label>

                      <label v-else-if="voiceSource() === 'describe'" class="voice-field">
                        <!-- 这一档**不需要底子音色**。上游那条"音频生成"的纯文本模式
                             什么都不用给 —— 一段描述就是全部输入(见 server 的 ttsDesignPrompt)。
                             曾经误按"音色设计"那条端点实现过,那条要一个买过的底子音色,
                             界面上因此多出过一格 Voice ID,已经撤掉 -->
                        <span class="voice-label">Description</span>
                        <span class="voice-control">
                          <textarea
                            v-grow
                            rows="2"
                            v-model="draft.voice.describe"
                            class="ed-input"
                            placeholder="e.g. young male, bright and a little hoarse, fast, big pitch swings"
                          ></textarea>
                        </span>
                        <span class="voice-hint">
                          Sound words only — age, pitch, pace, texture, mood.
                          <em>This description is the voice.</em>
                        </span>
                      </label>

                      <template v-else>
                        <!-- 复刻音色有两条来路,而它们是**并列**的,不是二选一:
                             号已经在手(控制台自己复刻过)就直接填;没有就上传一段录音当场建。
                             上传建完会把号回填到下面这一格,所以两条路的终点是同一个字段 -->
                        <label class="voice-field">
                          <span class="voice-label">Voice ID</span>
                          <span class="voice-control">
                            <input
                              v-model="draft.voice.vendorVoice"
                              class="ed-input"
                              autocapitalize="off"
                              autocorrect="off"
                              spellcheck="false"
                              placeholder="e.g. S_xxxxxxxx"
                              @input="onCloneIdTyped"
                            />
                          </span>
                          <span class="voice-hint">
                            A cloned ID looks like <em>S_xxxxxxxx</em> or a custom name. If it
                            looks like <em>zh_female_…_bigtts</em>, that is a built-in voice —
                            use the Built-in slot.
                          </span>
                        </label>

                        <div class="voice-field">
                          <span class="voice-label">Recording</span>
                          <div class="voice-clone">
                            <label class="ed-btn file">
                              <PhUploadSimple aria-hidden="true" />
                              {{ cloneBusy ? 'Cloning…' : 'Choose a recording' }}
                              <input
                                type="file"
                                accept="audio/*"
                                hidden
                                :disabled="cloneBusy"
                                @change="onVoiceSample"
                              />
                            </label>
                            <span v-if="draft.voice.sampleName" class="voice-sample">
                              {{ draft.voice.sampleName }}
                            </span>
                          </div>
                          <span v-if="cloneError" class="voice-err" role="alert">{{ cloneError }}</span>
                          <span v-else class="voice-hint">
                            10–60s, one speaker, no music. Registering is free — billing only starts
                            when you first speak with it.
                          </span>
                        </div>
                      </template>

                      <div class="voice-audition">
                        <button type="button" class="ed-btn" @click="auditionVoice">
                          <PhStopCircle v-if="auditioning" aria-hidden="true" />
                          <PhSpeakerHigh v-else aria-hidden="true" />
                          {{ auditioning ? 'Stop' : 'Hear it' }}
                        </button>
                      </div>
                      <p v-if="voiceError" class="voice-err" role="alert">{{ voiceError }}</p>
                    </div>
                  </template>
                </div>
              </div>

            </template>

            <template v-if="step === 1 && !wizardId">
              <!-- 参考图:比文字更能定形状,但是可选的,所以放在最后 -->
              <div class="wz-group">
                <div class="wz-group-head">
                  <h4 class="wz-group-title">Reference image</h4>
                </div>

                <!-- 空态与有图态占同样的高度:挑完图不该整块往上跳一下。
                     编辑态一来就有图(库里那张),所以判条件要把 editRefSrc 也算上 -->
                <div v-if="draft.ref || editRefSrc" class="wz-ref-wrap">
                  <!-- 读取中整行走那圈金色呼吸光晕(与起稿块同一套):
                       机器在动这件事,靠"框外的光"说出来,框本身不动。
                       光晕的定位基准就是这一行(见样式里的 position: relative) -->
                  <div class="wz-ref" :class="{ 'halo-breathe': visionBusy }">
                    <img
                      class="wz-ref-thumb"
                      :src="draft.ref || editRefSrc"
                      alt="Reference image"
                    />
                    <span class="wz-ref-body">
                      <span class="wz-ref-main">Reference image</span>
                      <span class="wz-ref-hint">
                        {{
                          isEditing
                            ? 'The starting point for this character’s faces'
                            : 'Applied on top of the spec when generating'
                        }}
                      </span>
                    </span>
                    <!-- 编辑态只能换、不能删:底图是其余四张设定图的一张参考资料,
                         删掉它那些图就失去了"原本是什么样子"这一半信息。
                         移除有它自己的场合(还没出过图时),那种场合在新建那一步 -->
                    <label v-if="isEditing" class="ed-btn" for="cp-file">Replace</label>
                    <button v-else class="ed-btn" @click="clearRef">Remove</button>
                  </div>

                  <!-- 识图那一行:图与上面那份设定之间的桥。
                       在跑 / 跑过 / 跑失败都用取景框 + 秒表 ——
                       与出图、起稿两处的等待态是同一样东西,只是换了个动词。
                       没配识图接口时不说"失败",而是给出下一步 ——
                       图本身当参考照常用得着,只是不会反填 -->
                  <div v-if="!isEditing" class="wz-scan">
                    <div class="wz-scan-main">
                      <LatticeLoader
                        v-if="visionRan"
                        :label="'Reading the image'"
                        :done-label="'Read in'"
                        :error-label="'Failed after'"
                        :status="visionLoader"
                        :font-size="12"
                      />
                      <p v-else-if="!visionConfig" class="wz-scan-hint">
                        Add an image-recognition config in API settings to read the spec from this image.
                      </p>
                      <p v-else class="wz-scan-hint">
                        Read the spec straight from this image — the fields above fill in from it.
                      </p>
                      <!-- 填完得说清"上面变了":这一行在表单最底下,
                           用户未必回头看一眼那两组输入框 -->
                      <p v-if="visionRead && !visionBusy && !visionError" class="wz-scan-hint">
                        Filled the spec above — the dots mark what it read.
                      </p>
                      <p v-if="visionError" class="wz-scan-err" role="alert">{{ visionError }}</p>
                    </div>
                    <button
                      v-if="visionConfig && !visionBusy"
                      class="ed-btn"
                      type="button"
                      @click="draftFromImage"
                    >
                      <PhSparkle aria-hidden="true" />
                      {{ visionRead ? 'Read again' : 'Read the spec' }}
                    </button>
                  </div>
                </div>
                <label v-else class="wz-ref wz-ref-pick" for="cp-file">
                  <PhImage aria-hidden="true" />
                  <span class="wz-ref-body">
                    <span class="wz-ref-main">Add an image</span>
                    <span class="wz-ref-hint">Pins the shape far better than words can</span>
                  </span>
                </label>
              </div>
            </template>

            <!-- 条件里必须带 step === 1:上面那三个 v-if 是各自独立的,
                 少了它,走到第 2 步时这里会当作"第 1 步的另一半"一起渲染,
                 于是声音那一屏下面会多出一块第 1 步的只读摘要 -->
            <template v-else-if="step === 1 && wizardChar">
              <!-- 存下之后这一步就没有可填的了(再点一次保存只会多一个副本),
                   所以这里不再重复名字与那份设定 —— 它们已经归到这条角色名下。
                   只剩一句交接:设定从这一刻起是"存下来的",而下一步会拿什么当输入 -->
              <h3 class="wz-h">Saved</h3>
              <p class="wz-p">
                The spec is saved with this character — it is what every view, and every image you
                generate with them, is built from. Nothing left to fill on this step.
              </p>
              <div v-if="wizardChar.ref" class="wz-ref">
                <img class="wz-ref-thumb" :src="coverSrc(wizardChar.ref)" alt="" />
                <span class="wz-ref-body">
                  <span class="wz-ref-main">Reference image</span>
                  <span class="wz-ref-hint">The front view will be built from it</span>
                </span>
              </div>
            </template>
          </div>

          <!-- 第 2 步:主视图。它是整条流水线的锚,其余四张都照它生成。
               左图右事:空态、生成中、已有图共用同一个框,所以点下去之后画面不跳。
               右边那一栏回答两件这一屏最该说清的事 ——
               它会拿哪张图当参考,以及"接下来该点哪里" -->
          <!-- 第 3 步:设定图。一屏两轮 —— 先出正脸(它是基准),再出其余四张。
               原来这是两步,而它们本来就是同一件事的两半:"先定基准、再照它长"
               那句话说了两遍,中间还隔着一次点按 -->
          <div v-else class="wz-pane wz-views">
            <!-- 这一屏是**两段**,不是一段带两句说明。
                 原来"主视图"与"其余四张"只是三块内容按顺序堆着:
                 中间浮着一句说明、下面挂着按钮,再下面才是网格 ——
                 谁是基准、哪几张在等它,全靠把那两句话读完才知道。
                 现在两段各有自己的题头(与第 1 步那几段同一套 .wz-group),
                 段的边界由那条两端内缩的发丝线画出来,
                 "一次补齐"也回到它管的那一段题头上 —— 说明与动作同源 -->
            <div class="wz-group">
              <div class="wz-group-head">
                <h4 class="wz-group-title">Main view</h4>
                <span class="wz-group-hint">
                  The anchor every other view is built from. Get it right before moving on.
                </span>
              </div>

              <div class="wz-hero">
                <div class="wz-hero-shot">
                  <ViewCell
                    label="Front"
                    noun="the main view"
                    :view="wizardFront"
                    :busy="isBusy(wizardId, 'front')"
                    start
                    action="generate"
                    @stop="emit('stopView', wizardId, 'front')"
                    @generate="emit('generate', wizardId, 'front')"
                  />
                </div>

                <div class="wz-hero-body">
                  <p class="wz-hero-note">
                    {{
                      wizardFront
                        ? 'Every other view is generated from this one — that is what keeps the face the same.'
                        : 'One front-facing headshot. It becomes the reference every other view is built from.'
                    }}
                  </p>

                  <!-- 这一步最该说清、而界面上一直没地方说的一件事:正脸会拿哪张图当参考。
                       有主参考图就是图生图,没有就是纯文字生图 —— 出来的东西差别很大 -->
                  <dl class="wz-facts">
                    <dt class="wz-facts-k">Generated from</dt>
                    <dd class="wz-facts-v">{{ heroSource }}</dd>
                  </dl>

                  <!-- 主按钮永远代表"接下来该做的那件事":还没有正脸时是它;
                       有了之后主按钮交给卡脚那个 Next(见卡脚上的条件 class) -->
                  <button
                    class="ed-btn"
                    :class="{ primary: !wizardFront }"
                    :disabled="isBusy(wizardId, 'front')"
                    @click="emit('generate', wizardId, 'front')"
                  >
                    <PhSparkle v-if="!isBusy(wizardId, 'front')" aria-hidden="true" />
                    {{
                      isBusy(wizardId, 'front')
                        ? 'Generating…'
                        : wizardFront
                          ? 'Regenerate'
                          : 'Generate main view'
                    }}
                  </button>
                </div>
              </div>
            </div>

            <!-- 四张那一排。动作挂在段题头上:说明与"一次补齐"讲的是同一件事 ——
                 这批图从主视图长出来,而且可以一次全出。
                 主视图还没出时按钮点不动:没有基准,那四张就没有依据 -->
            <div class="wz-group">
              <div class="wz-group-head">
                <div class="wz-group-row">
                  <h4 class="wz-group-title">Other views</h4>
                  <button
                    class="ed-btn"
                    :disabled="!restMissing || frontBusy(wizardId) || !wizardFront"
                    @click="emit('generateAll', wizardId)"
                  >
                    <PhSparkle aria-hidden="true" />
                    {{ restLabel }}
                  </button>
                </div>
                <span class="wz-group-hint">
                  Each of these is built from the main view. Generate them one at a time, or all at
                  once — failing early stops the run instead of burning four more calls.
                </span>
              </div>

              <div class="wz-grid">
                <ViewCell
                  v-for="cell in wizardRest"
                  :key="cell.kind"
                  :label="cell.label"
                  :view="cell.view"
                  :busy="isBusy(wizardId, cell.kind)"
                  :blocked="viewBlocked(wizardId, cell.kind)"
                  :portrait="cell.framing === 'portrait'"
                  action="generate"
                  @stop="emit('stopView', wizardId, cell.kind)"
                  @generate="emit('generate', wizardId, cell.kind)"
                />
              </div>
            </div>
          </div>
        </div>

        <div class="wz-foot">
          <button
            v-if="step === 1 && !wizardId"
            class="ed-btn primary"
            :disabled="!draft.name.trim() || !draft.fields.gender.trim()"
            @click="submit"
          >
            {{ isEditing ? 'Save' : 'Save & continue' }}
          </button>
          <button v-else-if="step === 1" class="ed-btn primary" @click="goStep(2)">
            Next: voice
          </button>
          <!-- 声音那一步没有非填不可的东西(不配就是系统自带的嗓子),所以这里的
               按钮一直是主按钮。但它**必须存一下**:嗓音是随角色存在库里的,
               不存就白填了 —— 而进到这一步时角色早就在库里(第 1 步存的),
               所以这是一次"更新",得走 saveFromVoiceStep(见那边的说明) -->
          <button
            v-else-if="step === 2"
            class="ed-btn primary"
            @click="saveFromVoiceStep(isEditing ? 0 : 3)"
          >
            {{ isEditing ? 'Save' : 'Save & continue' }}
          </button>
          <!-- 最后一步的收尾。主按钮永远只该有一个:还没有正脸时,主按钮是卡身里
               那个"Generate main view"(见那边的条件 class),Done 退一档;
               出了正脸才轮到它。两个都涂黑会让"接下来做什么"变得含糊 -->
          <button v-else class="ed-btn" :class="{ primary: !!wizardFront }" @click="finishWizard">
            Done
          </button>

          <!-- 编辑态的下一步是嗓音,而脚下那枚主按钮是"Save"(改设定到这儿就完了)。
               两件事都摆在明面上,免得专门来改嗓子的人顺手点了 Save、卡就关了。
               排在整条 v-if / v-else-if 链之后:插在中间会把那条链切断,
               新建流程的第 1 步会同时冒出两枚主按钮 -->
          <button v-if="step === 1 && isEditing" class="ed-btn" @click="goStep(2)">
            Next: voice
          </button>

          <button v-if="step > 1" class="ed-btn" @click="backStep">Back</button>
          <button class="ed-btn" @click="closeWizard">
            {{ step === 1 && !wizardId ? 'Cancel' : 'Close' }}
          </button>
        </div>
      </section>

      <!-- 列表接着上面被切开的那一段继续(见浮层之前那段说明) -->
      <template v-if="!detailChar">

      <!-- 列表:卡片网格。卡本身在 CharacterCard.vue(顶图全出血 + 底部毛玻璃信息区),
           这里只管这一排怎么排 —— 每张卡的用量与特征从这一页算好交下去 -->
      <div v-if="props.characters.length" class="grid">
        <!-- 一张海报卡:顶图 + 名字 + 特征 + 用量 + ⋮ 菜单。它只做展示与上报,
             顺序、菜单开合、用量怎么算都由这一页给(见 CharacterCard.vue) -->
        <CharacterCard
          v-for="c in listedChars"
          :key="c.id"
          :char="c"
          :cover="coverSrc(coverOf(c))"
          :traits="traitsOf(c)"
          :image-count="statOf(c.id).count"
          :created-label="fmtDay(c.createdAt)"
          :updated-label="statOf(c.id).lastAt ? fmtDay(statOf(c.id).lastAt) : '—'"
          :menu-open="openCardMenu === c.id"
          :menu-up="cardMenuUp"
          @open="openDetail"
          @chat="createFromCard"
          @pin="pinFromCard"
          @edit="editFromCard"
          @duplicate="duplicateFromCard"
          @export="exportFromCard"
          @remove="removeFromCard"
          @toggle-menu="toggleCardMenu"
          @menu-enter="onMenuEnter"
          @menu-leave="onMenuLeave"
        />
      </div>

      <div v-else class="empty">
        <PhMaskHappy class="empty-ico" aria-hidden="true" />
        <h3 class="empty-title">No characters yet</h3>
        <p class="empty-sub">
          Describe one in a line and let the model draft the spec, or fill the fields by hand.
          Then generate a reference sheet to keep the same face everywhere.
        </p>
        <button class="ed-btn primary" @click="startEdit()">Create a character</button>
      </div>
    </template>

    <!-- —— 详情 —— -->
    <template v-else-if="detailChar">
      <div class="dt-bar">
        <button class="back" @click="backToList">
          <PhArrowLeft aria-hidden="true" />
          All characters
        </button>
        <!-- 三个动作都收在这一行:复制(改一个变体)、导出(带走)、删除(破坏性)。
             删除仍然压成静默的字、悬停才亮红 —— 三个都是同样的份量会读不出主次 -->
        <div class="dt-acts">
          <!-- 编辑排在最前:改一个已有的比复制一个更常做,而它也是进向导的唯一入口 -->
          <button class="dt-act" @click="startEdit(detailChar)">
            <PhPencilSimple aria-hidden="true" />
            Edit
          </button>
          <button class="dt-act" @click="emit('duplicate', detailChar.id)">
            <PhCopy aria-hidden="true" />
            Duplicate
          </button>
          <button class="dt-act" @click="emit('export', detailChar.id)">
            <PhDownloadSimple aria-hidden="true" />
            Export
          </button>
          <button class="dt-del" @click="emit('remove', detailChar.id)">
            <PhTrash aria-hidden="true" />
            Delete
          </button>
        </div>
      </div>

      <!-- 身份区:一张卡把"这是谁、进行到哪、能做什么"说全。
           主视觉用**正脸那张大图**,而不是一枚小圆头像 —— 88px 的圆是
           "通讯录条目"的形状,而这一页要看起来像一个人。
           3:4 与列表里的角色卡同一个比例:这一页就是那张卡"打开之后"的样子,
           同一个人该是同一个形状,只是尺寸大了一档。

           **两栏**:左图,右边再分"我是谁"(文字列,封到 46ch)与
           "能做什么"(动作列,靠右站成一条竖列)。
           以前文字列一路铺到卡的右边缘、动作跟在文字后面,于是
           1000px 宽的卡里最长的一行只有 421px,右边近 380px 是空的,
           两枚按钮还悬在整条中线上。 -->
      <header class="hero">
        <div class="hero-shot">
          <img v-if="avatarSrc" :src="avatarSrc" alt="" />
          <PhMaskHappy v-else aria-hidden="true" />
        </div>
        <div class="hero-body">
          <div class="hero-id">
            <h2 class="hero-name">{{ detailChar.name }}</h2>
            <p v-if="heroSub(detailChar)" class="hero-sub">{{ heroSub(detailChar) }}</p>
            <!-- 用量:这个角色到底干了多少活。放在设定摘要下面、标签上面 ——
                 它比"几张图"更像这个角色的成绩单 -->
            <p class="hero-meta">
              <span v-for="m in heroMeta" :key="m">{{ m }}</span>
            </p>
            <div class="hero-tags">
              <span class="tag">{{ filledCount }} / {{ sheetCells.length }} views</span>
              <span v-if="hasFront" class="tag tag-on">
                <PhEye weight="fill" aria-hidden="true" />
                Main view · Front
              </span>
              <span v-else class="tag">No main view yet</span>
            </div>
          </div>

          <!-- 动作列:同一时刻只该有一个涂黑的主按钮,否则"下一步做什么"就含糊了。
               设定图没齐时那件事是**补齐**(只有在这儿能做);
               齐了之后主操作换成**跟它说话** —— 角色做出来就是为了聊的
               (见 doc/角色对话功能设计.md),而列表卡上一直有它。
               原来这一格是一枚禁用的 All views ready:全页最重的位置上
               摆着一件点不动的事,而真正该点的那个入口根本不在这一页 -->
          <div class="hero-actions">
            <button
              v-if="missingCount"
              class="ed-btn primary hero-cta"
              :disabled="frontBusy(detailChar.id)"
              @click="emit('generateAll', detailChar.id)"
            >
              <PhSparkle v-if="!detailBusy.length" aria-hidden="true" />
              {{ detailBusy.length ? `Generating ${busyLabel}…` : generateAllLabel }}
            </button>
            <button
              v-else
              class="ed-btn primary hero-cta"
              :aria-label="`Chat with ${detailChar.name}`"
              @click="emit('chat', detailChar.id)"
            >
              Chat
              <PhArrowRight aria-hidden="true" />
            </button>
            <!-- 没齐的时候"进对话"退成描边的次动作:图还没备全时它仍是可用的 -->
            <button
              v-if="missingCount"
              class="ed-btn hero-create"
              :aria-label="`Chat with ${detailChar.name}`"
              @click="emit('chat', detailChar.id)"
            >
              Chat
              <PhArrowRight aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <section class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Reference sheet</h3>
          <!-- 生成中就把说明换成进度:在标题旁边,是这一屏视线必经的位置。
               放在网格下面用一行小字写"Generating…"几乎等于没写 -->
          <LatticeLoader
            v-if="detailBusy.length"
            class="panel-progress"
            :label="`Generating ${busyLabel}`"
            :font-size="12"
          />
          <span v-else class="panel-note">
            {{
              hasFront
                ? detailChar.sourceRef
                  ? 'Every other view is built from the front view and your reference image.'
                  : 'Every other view is built from the front view.'
                : 'Start with the front view — the other four unlock once it exists.'
            }}
          </span>
        </div>

        <!-- 空格点一下即生成;有图的点开看大图,重新生成与设为主参考图都在大图里 ——
             原来这两件事挤在每格底下的小字上,既难点也说不清在做什么 -->
        <div class="sheet">
          <ViewCell
            v-for="cell in sheetCells"
            :key="cell.kind"
            :label="cell.label"
            :view="cell.view"
            :busy="isBusy(detailId, cell.kind)"
            :locked="isLocked(cell.kind)"
            :blocked="viewBlocked(detailId, cell.kind)"
            :is-main="isMainView(cell.kind)"
            :start="cell.kind === 'front'"
            :portrait="cell.framing === 'portrait'"
            action="open"
            @stop="emit('stopView', detailId, cell.kind)"
            @generate="emit('generate', detailChar.id, cell.kind)"
            @open="openViewer(cell.kind)"
          />
        </div>

      </section>

      <!-- 用这个角色出过的图。排在设定图之后:上面是"材料",这里是"产出"。
           图来自历史记录(按 characterId 归拢,见 App 的 charWorks),
           点开走的是与历史图墙、首页图砖同一个预览入口 -->
      <section v-if="works.length" class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Made with this character</h3>
          <span class="panel-note">
            {{ works.length }} {{ works.length === 1 ? 'image' : 'images' }} · newest first
          </span>
        </div>
        <div class="works">
          <button
            v-for="w in worksShown"
            :key="w.key"
            class="work"
            :aria-label="workAria(w)"
            @click="emit('preview', w.entry)"
          >
            <img :src="workSrc(w)" alt="" loading="lazy" decoding="async" />
            <!-- 对话里生成的那两种图带一枚小角标(见 lib/chatWork)。
                 这一格里混着两样东西:"我拿这个角色做的图"与"它在对话里
                 发给我/生成给我的图"。没有这枚角标,后者看起来像是自己做的 -->
            <span v-if="workLabel(w)" class="work-src" aria-hidden="true">
              <PhChatCircleDots />
            </span>
          </button>
        </div>
        <!-- 只摆最近这一批,其余的指个去处。不做"展开全部":
             这一页是看角色的,翻作品该去历史页 -->
        <p v-if="worksRest" class="works-more">{{ worksRest }} more in History.</p>
      </section>

      <!-- 三张资料表并排成一段"附录"(见 .dt-facts 的说明)。
           它们同等次要,所以每一张都得是个完整的卡:标题 + 一句话(说明它管哪一头) -->
      <div class="dt-facts">
      <section class="panel fact-spec">
        <div class="panel-head">
          <h3 class="panel-title">Spec</h3>
          <span class="panel-note">Merged into every image you make.</span>
        </div>
        <dl class="spec">
          <template v-for="r in specRows(detailChar)" :key="r.label">
            <dt class="spec-k">{{ r.label }}</dt>
            <dd class="spec-v" :class="{ dim: !r.value }">{{ r.value || '—' }}</dd>
          </template>
        </dl>
      </section>

      <!-- 人格单独一段:上面那张表里的每一项都会进你每一张成品,
           这一段一项都不会 —— 它只在对话里起作用。混在同一张表里,
           用户会以为改"说话方式"也会改变出图。
           标题同向导那边:用 Personality,把 Voice 让给嗓音 -->
      <section class="panel fact-persona">
        <div class="panel-head">
          <h3 class="panel-title">Personality</h3>
          <span class="panel-note">Used in Chat only — never merged into your prompts.</span>
        </div>
        <dl class="spec">
          <template v-for="r in personaRows(detailChar)" :key="r.label">
            <dt class="spec-k">{{ r.label }}</dt>
            <dd class="spec-v" :class="{ dim: !r.value }">{{ r.value || '—' }}</dd>
          </template>
        </dl>
      </section>

      <!-- 嗓音:与上面那段同一条理由(只在对话里起作用),
           但它比人格多两件事 —— 可以直接听,也可以改。
           刚建好的角色,第一件想做的事就是听听它什么嗓子,所以这里给一枚试听键;
           而改的那一枚是**必需的**:向导第 2、3 步的解锁条件是 wizardId,
           只有新建流程里第 1 步存完才有 —— 光靠详情页那枚 Edit 进不去嗓音那一步,
           一个角色的嗓子建完就再也改不了(见 startVoiceEdit) -->
      <section class="panel fact-voice">
        <div class="panel-head">
          <h3 class="panel-title">Voice</h3>
          <div class="panel-acts">
            <button type="button" class="ed-btn" @click="auditionChar(detailChar)">
              <PhStopCircle v-if="speakingId === `audition:${detailChar.id}`" aria-hidden="true" />
              <PhSpeakerHigh v-else aria-hidden="true" />
              {{ speakingId === `audition:${detailChar.id}` ? 'Stop' : 'Hear it' }}
            </button>
            <button type="button" class="ed-btn" @click="startVoiceEdit(detailChar)">
              <PhPencilSimple aria-hidden="true" />
              Change voice
            </button>
          </div>
        </div>
        <dl class="spec">
          <template v-for="r in voiceRows(detailChar)" :key="r.label">
            <dt class="spec-k">{{ r.label }}</dt>
            <dd class="spec-v" :class="{ dim: !r.value }">{{ r.value || '—' }}</dd>
          </template>
        </dl>
        <p v-if="voiceError" class="voice-err" role="alert">{{ voiceError }}</p>
      </section>
      </div>
    </template>

    <!-- 看大图:同一张图上顺手做决定 —— 重新生成、设为主参考图,以及左右翻 -->
    <div v-if="viewer" class="viewer" @click="closeViewer">
      <div
        ref="viewerBox"
        class="viewer-box"
        role="dialog"
        aria-modal="true"
        :aria-label="`${viewerLabel} view`"
        tabindex="-1"
        @click.stop
      >
        <div class="viewer-top">
          <span class="viewer-head">
            <span class="viewer-label">{{ viewerLabel }}</span>
            <!-- 翻到第几张:图多于一屏时才有意义,一张时不摆 -->
            <span v-if="viewerPos.n > 1" class="viewer-pos">{{ viewerPos.i }} / {{ viewerPos.n }}</span>
          </span>
          <button class="viewer-x" aria-label="Close" @click="closeViewer">
            <PhX aria-hidden="true" />
          </button>
        </div>

        <div class="viewer-stage">
          <button
            v-if="viewerKinds.length > 1"
            class="viewer-nav"
            aria-label="Previous view"
            @click="stepViewer(-1)"
          >
            <PhCaretLeft aria-hidden="true" />
          </button>
          <img class="viewer-img" :src="viewerSrc" alt="" />
          <button
            v-if="viewerKinds.length > 1"
            class="viewer-nav"
            aria-label="Next view"
            @click="stepViewer(1)"
          >
            <PhCaretRight aria-hidden="true" />
          </button>
        </div>

        <!-- 只剩下"重新生成"一个动作:设为主视图那件事没有了 ——
             主视图只能是正面,其余四张都是照它生的派生图,拿它们当主图会串脸 -->
        <div class="viewer-acts">
          <!-- 正在重跑这一张:原地把它换成"停止" -->
          <button
            v-if="isBusy(detailId, viewer)"
            class="ed-btn"
            @click="emit('stopView', detailId, viewer as CharacterViewKind)"
          >
            <span class="ed-stop" aria-hidden="true"></span>
            Stop
          </button>
          <button
            v-else
            class="ed-btn"
            :disabled="viewerRegenBlocked"
            @click="regenerateViewer"
          >
            <PhArrowsClockwise aria-hidden="true" />
            Regenerate
          </button>
        </div>
      </div>
    </div>

    <input id="cp-file" type="file" accept="image/*" hidden @change="onPickRef" />
    <!-- 导入用的 file input:页头那个按钮点它。这里只认 .zip ——
         角色包一定是 zip(设定 + 图),`.json` 那种没有脸的包不该被导进来 -->
    <input
      ref="importInput"
      type="file"
      accept=".zip,application/zip"
      hidden
      @change="onImportFile"
    />
  </div>
</template>

<style scoped>
/* 页容器与左右留白都由 .shell 给(App.vue),这一页不再自己套一层
   —— 原来那层 max-width + padding 让内容比别的页多缩进一圈,左边缘对不齐 */
.chars {
  min-width: 0;
  /* 报错文字的墨色,整页共用(向导里三处 + 详情页嗓音那一处)。
     --danger 在白面上只有 3.9:1 —— 它本来就偏低,而报错正是最该被读清的一行;
     压深一档之后浅色面上到 6:1 上下。暗色主题下 --text 是近白,
     混出来是一枚更亮的红 —— 两边都成立,红的含意没变,变的只是它压不压得住底色 */
  --danger-ink: color-mix(in oklch, var(--danger) 72%, var(--text));
}
/* 以下骨架与历史 / 提示词库 / 设置三页保持一致 */
.chars-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  padding-top: var(--sp-2);
}
.chars-sub {
  margin-top: 6px;
  max-width: 60ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
/* 页头右侧一组动作。页头只该有一个实心按钮,所以导入用描边款 ——
   两个都涂黑等于没有主次 */
.chars-acts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.chars-import {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: 500;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.chars-import:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.chars-import:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.chars-import svg {
  width: 15px;
  height: 15px;
}
/* 与设置页「Add config」、提示词库「New prompt」同款:黑药丸,标题行主操作 */
.chars-new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 34px;
  padding: 0 14px;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.chars-new:hover {
  background: var(--cta-hover);
}
.chars-new svg {
  width: 15px;
  height: 15px;
}

/* —— 新建向导:漂浮卡 ——
   创建是一条独立流程,不该插进列表里把页面顶开 —— 它是盖在这一页之上的一层,
   关掉就回到原样。与全屏看大图(viewer)同一套模态语言:暗幕 + 模糊 + 居中的卡。
   这里是三张平级的卡,不是一张套三张:
     卡头  流程引导 —— 三步走到哪儿
     卡身  下方信息区域 —— 左边要填的表单 + 右边这个角色"是什么"(一张卡)
     卡脚  进退动作
   所以 .wizard 这一层自己不再是卡(无底色、无描边、无圆角、无影子),
   只是给这三张卡排版的一画布:三张卡之间、以及与视口之间,都隔 16px。
   原先是一张大卡包住三块 —— 那等于把"这是一层壳"和"这是三件事"
   同时说了,四道圆角一层层套下去还会越看越像弹窗套弹窗 */


/* 暗幕。与卡片是平级的两个 fixed 元素,而不是"卡包在暗幕里":
   卡片要 overflow:hidden 来切圆角,一旦套进暗幕里,那层 overflow
   会顺手把铺满视口的背景裁掉 */
.wz-veil {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: color-mix(in srgb, var(--stage-bg) 86%, transparent);
  backdrop-filter: blur(6px);
}
.wizard {
  /* 顶边钉住、左右居中,而不是整体垂直居中。
     为什么改:卡片高度由内容决定,而三步的内容长度差着好几倍
     (第 1 步最满、第 2 步只有一组引擎选择)—— 垂直居中时,
     每换一步卡头与步骤条都要在视口里上下跳一次,像换了一页;
     顶边钉住之后只有底边在动,步骤条与右栏始终在原地。
     用 left 50% + translateX 而不是外面套一层 flex 容器:
     auto 高度下 margin:auto 居中并不成立,为居中多包一层不划算 */
  --wz-top: max(var(--sp-4), 4vh);
  position: fixed;
  top: var(--wz-top);
  left: 50%;
  transform: translateX(-50%);
  z-index: 71;
  /* 卡头 / 卡身 / 卡脚三行。
     宽度:**一栏**的宽度。右栏摘要去掉之后,卡身只剩信息区一块,
     再留着 960px 只会让"标签 + 值"那一行横铺一千来像素 ——
     值那一列的行长本来就该有个上限(正文 65–75 字符那条账)。
     760 是让内容区落在 700 上下:与去掉右栏之前的信息区几乎同宽,
     所以每一步的排版与之前是同一份,只是不再陪跑那 248px */
  display: flex;
  flex-direction: column;
  /* 三张卡之间 16px、外圈也是 16px —— 同一个档 */
  gap: var(--sp-4);
  padding: var(--sp-4);
  width: min(760px, calc(100% - 2 * var(--sp-4)));
  max-height: calc(100vh - var(--wz-top) - var(--sp-4));
  max-height: calc(100dvh - var(--wz-top) - var(--sp-4));
  /* 最简的那一步(第 2 步)也要有一副像样的框:
     否则它缩成一条,与另外两步判若两物,关掉再打开都认不出是同一张卡。
     min() 里的两项,后一项是矮视口下的让步 —— 屏幕不够高时不该硬撑。
     这个值只兜底,不追求把三步拉成一样高:硬拉齐只会让第 2 步空出一大片 */
  min-height: min(440px, calc(100vh - var(--wz-top) - var(--sp-4)));
  min-height: min(440px, calc(100dvh - var(--wz-top) - var(--sp-4)));
  /* 这一层不再是卡:没有底色、描边、圆角、影子。
     它只是一块排版用的画布 —— 三张卡各自"浮"在这上面 */
  background: none;
}
/* 卡身:此刻要填/要生的那一块 —— 向右栏摘要道别之后,它是这一层唯一的内容。
   这一层用 flex 而不是 grid:卡片高度是内容决定的(auto + max-height),
   而 grid 的 1fr 行在容器高度不确定时会按内容撑开,撑开之后被 max-height 一夹,
   里面的 overflow 就不起作用了 —— 卡脚会被直接裁掉。flex 的 flex:1 + min-height:0
   在同一条件下是有保证的(这也正是改之前的样子)。
   只剩一块也仍旧留着这一层:滚动区、圆角与那道接触影都归它 */
.wz-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 第二张卡:下方信息区域。左边是此刻要填的东西,右边是这个角色"是什么" ——
     两块合成一张卡,而不是并排两张:它们是同一件事的两面
     (填进去的,与填成什么样了),拆成两张卡反而要读者自己把它们对起来 */
  border-radius: var(--r);
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
  /* 右栏那层 --bg 与两块的滚动内容都要被这张卡的圆角切齐 */
  overflow: hidden;
}
/* 步骤条:横向三步,中间用短线连起来。
   线点亮 = 前一步做完了 —— 进度不必靠读文字,余光扫一眼就知道走到哪 */
/* 编辑态卡头那两行(在改谁、这一轮改什么)现在住在 .wz-steps 那张卡里 ——
   原来它们自成一卡,于是编辑态是"一句说明 + 一张没有步骤条的卡",
   而嗓音那一步根本走不到 */
.wz-edit-title {
  font-size: var(--fs-md);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}
.wz-edit-sub {
  margin-top: 2px;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}

/* 第一张卡:流程引导。间距全部由 .wizard 的 padding 与 gap 给,
   这儿不再自己写 margin —— 卡与卡的距离只该有一处定义 */
.wz-steps {
  flex: none;
  /* 一列:编辑态这张卡里先有一行"Edit {name}"与那句说明,步骤条跟在其下;
     新建态没有那两行,这一列里就只有那一排步骤 —— 两种态共用同一张卡,
     卡的数量与顺序都不变(卡头 / 卡身 / 卡脚) */
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  padding: 10px var(--sp-4);
  border-radius: var(--r);
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
}
.wz-step-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* 连接线:走过的那一段整条转成墨色 —— 它和左边那枚墨色圆点连成一段实心的墨,
   于是"走到哪儿了"不用读文字,一条深浅就看出来了。
   高度给到 2px 并做圆头:1px 的线在视网膜屏上几乎是一条影子,
   而这一条正是进度唯一的读数 */
.wz-line {
  flex: 1;
  height: 2px;
  border-radius: 2px;
  background: var(--line);
  transition: background var(--dur) var(--ease);
}
.wz-line.is-done {
  background: var(--accent);
}
.wz-step {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
/* 没到的步骤点不动。光标也不给手指,免得看着像能点 */
.wz-step:disabled {
  cursor: default;
}
.wz-step.is-locked {
  opacity: 0.5;
}
/* 三态各占一档色深:当前(满墨)> 走过(--text-2)> 未到(--text-3) */
.wz-step.is-active {
  color: var(--text);
}
.wz-step.is-done {
  color: var(--text-2);
}
.wz-step:not(.is-active):not(:disabled):hover {
  color: var(--text);
}
.wz-step:not(.is-active):not(:disabled):hover .wz-dot {
  border-color: var(--text-3);
}
/* 圆点里装的是这一步的图标(见模板)。当前那枚实心墨 + 一圈淡墨晕;
   走过的收成一枚淡墨底的对勾;未到的只留一圈细描边 ——
   三样排在一起,顺序本身就看得出 */
.wz-dot {
  flex: none;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  color: var(--text-3);
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease), color var(--dur) var(--ease);
}
/* 14px:图标要在 24px 的圆里留得出边距,又要认得清是什么 */
.wz-dot svg {
  width: 14px;
  height: 14px;
}
/* 当前这一步。只把它涂黑还不够 —— 三步并排时"现在在这儿"要有别的东西托着,
   所以在圆点外补一圈 accent-soft 的晕:它是这条线上唯一带光的东西 */
.wz-step.is-active .wz-dot {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
  box-shadow: 0 0 0 4px var(--accent-soft);
}
.wz-step.is-done .wz-dot {
  border-color: transparent;
  background: var(--accent-soft);
  color: var(--text-2);
}
.wz-name {
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
}
.wz-step.is-active .wz-name {
  font-weight: 600;
}

/* 信息区:当前这一步的内容,间距 10px 一档。
   它就是那个滚动区 —— 卡自己不滚,滚的是这一层(见 .wz-body)。
   这一步的内容装不下时只有中间这段滑动,卡头卡脚不动,
   这才是"信息区域滚动"该有的样子。
   min-height:0 是关键:少了它 flex 子项不肯缩,滚动条根本出不来。
   内边距 12px 一档:下面每一行自己还有 12px 横向内边距,
   两层加起来 24px,正好是卡里那一档留白 */
.wz-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  /* 滚到底不再把滚动传给后面的页面 —— 否则滚过头会连背景一起滚走 */
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: var(--sp-3);
}

/* 段题头里"标题 + 一个动作"并排的那种(第 3 步的 Other views:
   那一段说明的是"这批图怎么出",而"一次补齐"正是这件事的按钮) */
.wz-group-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.wz-h {
  font-size: var(--fs-lg);
  color: var(--text);
}
.wz-p {
  max-width: 64ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}

/* 第 3 步那一屏:与第 1 步同一档的段间距(32px)。
   这一屏没有分割线 —— 两段的边界由那两句段题头与这段留白给。
   (第 1 步那边还多一层:每段的内容坐在自己的色块上。这里的内容本来就是图,
   图自己划得清边界,再垫一块灰底只是多一层壳) */
.wz-views {
  gap: var(--sp-6);
}

/* 主视图那一步:左图右事。
   为什么并排 —— 原来是"一个 300px 的方块浮在 720px 的卡中间",左右各空 390px,
   而这一屏最该说清的两件事(拿哪张图当参考、接下来点哪里)一个字都没说。
   并排之后图有分量,说明也有地方可放 */
.wz-hero {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
}
.wz-hero-shot {
  flex: none;
  width: min(288px, 44%);
}
/* 向导里这一格是整屏最大的:中间的 "+" 也跟着放大一档,
   否则一枚 34px 的小圆落在这么大的空位里会显得没精神 */
.wz-hero-shot :deep(.cell-ph),
.wz-hero-shot :deep(.cell-lock),
.wz-hero-shot :deep(.cell-busy-stop) {
  width: 46px;
  height: 46px;
}
.wz-hero-shot :deep(.cell-ph) {
  font-size: var(--fs-xl);
}
.wz-hero-shot :deep(.cell-lock) {
  padding: 13px;
}
/* 停止钮里那个方块跟着放大一档,不然圆变大、方块还是 11px 会显得空 */
.wz-hero-shot :deep(.cell-busy-stop)::after {
  width: 14px;
  height: 14px;
}
.wz-hero-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  flex: 1;
  min-width: 0;
}
.wz-hero-note {
  max-width: 46ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
/* 事实行:标签 + 值,与详情页规格表同一套语言(dt/dd 两列)——
   这里说的正是"这次会用到的条件",用同一套写法读者不必重新认 */
.wz-facts {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  gap: 4px var(--sp-3);
}
.wz-facts-k {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.wz-facts-v {
  font-size: var(--fs-base);
  color: var(--text);
}
/* 其余四张:一排四格,与详情页的设定图同一套格子语言。
   四格必须一样高 —— 其中 Full body 是竖幅(2:3),照它自己的比例铺,
   那一格会高出别人一大截,四枚标签也就落不到同一条基线上,
   而"一排里哪张不齐"会被读成"这张出了问题"。
   所以这一排统一用方框:方图本来就把框占满(cover 不裁任何东西),
   竖幅那张在方框里完整放下(contain),两侧留出图片画布色 ——
   它读起来是"一张缩略预览",而且头和脚都还在(详情页那一排是
   另一套排法:竖幅跨两行,因为那边一屏只有五格,腾得出位置) */
.wz-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-3);
}
.wz-grid .cell.is-portrait :deep(.cell-img) {
  aspect-ratio: 1;
}
.wz-grid .cell.is-portrait :deep(.cell-img) img {
  object-fit: contain;
}

/* 第三张卡:进退动作。主操作在左,回退与退出紧跟其后
   (与表单里一贯的主次排法一致)。
   它不在滚动区里,所以滚动的永远是卡身,它自己不动 */
.wz-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px var(--sp-4);
  border-radius: var(--r);
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
}

/* —— 第 1 步的表单 ——
   整屏内容装在**一张**卡里(见 .wz-body),卡内再分成几段:
   起稿 / 基础信息 / Spec / Reference sheet only / 参考图。
   段与段靠留白和段标题分层,不再是"一段一张卡" ——
   卡本身已经说了"这一整块是一件事",里面再切四张,
   边界就把同一句话说四遍,而这里真正要区分的是"段"。

     重点   —— 只有起稿那一段有底色(一块淡底圆角槽),另外四段都是白面上的清单
     段标题 —— 15px/600 满墨 + 一句 12px 的说明(见 .wz-group-head)
     行     —— 段内每一栏是"标签在左、内容在右"的列表行,四段同一形状:
               同一个宽度、同一条 88px 标签列、同一条 12px 发丝线
     控件   —— 输入框一律无框无底:可写这件事由行的底色和左缘那道短竖线去说
   字号**五档**(整个向导只有这五档,任何一处都该能对上其中一档):
       20 页面主标题   —— 只有起稿那一块
       16 段标题       —— 各段题头,以及第 2、3 步的标题
       14 值 / 正文    —— 输入框、右栏的值、详情
       13 说明         —— 段说明、步骤说明、状态提示
       12 标签         —— 行标签、键、图注
   上一版是 20/15/13/12 四档,问题出在 13 与 12 只差 1px:密集的行里
   这两档在视觉上根本分不开,整页就只剩"满墨"与"灰"两种重量,
   于是"信息没有差距"。拉开到 14 对 12 之后,相邻两档至少差 1px、
   多则 4px,且每一档都对应一个**固定的语义角色** —— 不再出现
   "同一个角色在这个段里 12、在那个段里 13"这种说法。

   间距同时承担分组:段与段 32px、段内标题到内容是 8px —— 四倍的落差 */
.wz-form {
  gap: var(--sp-6);
}
/* 只有第 1 步那张长表的题头吸顶(十三栏,滚到中段就说不清自己在哪一段了)。
   第 2、3 步一屏就装得下,吸顶反而会让题头压住下面那张主视图 ——
   同一个组件在两处的用法不同,所以这条规则挂在 .wz-form 上而不是 .wz-group-head 上。

   吸顶只在**自己那一段**内生效(sticky 的边界是父元素),
   下一段的题头会把它顶走,不必额外写逻辑。
   底色用卡面的 --surface:它得盖住从下面滚过去的行。

   题头自己**不画横线**。上一版在标题底下补过一条,理由是"第一行那条线
   跟着滚走了" —— 那是把"有东西从底下经过"这件事交给了线去说,
   结果每一段都变成"上下各一条线夹着一个标题",一屏十几条横线,
   比它想解决的那个问题还乱。这件事改由下面那道渐隐去说:
   它只在真有内容经过时才看得见,而且说的是"还有东西在下面",不是"这里断开" */
.wz-form .wz-group-head {
  position: sticky;
  /* 滚动区自己有 12px 内边距(见 .wz-pane),退到那里才贴住卡边 */
  top: calc(-1 * var(--sp-3));
  z-index: 2;
  /* 上下的 8/6px 是给吸顶留的:贴住顶端时标题不该顶着卡边 */
  padding: var(--sp-2) var(--sp-3) 6px;
  background: var(--surface);
}
/* 题头底下那道渐隐。滚上来的内容是在题头的下沿被**硬切**掉的 ——
   一行字切一半还看得过去,一排字被齐齐截断就像是坏了。
   从卡面白渐到透明:底色与滚动区一致,所以只在有东西从下面经过时才看得见,
   不吸顶的时候它什么都不是。
   (渐隐是给眼睛的,真正要防的是键盘:焦点落到一栏时浏览器会把它滚进视野,
   而它算不出顶上压着一条题头 —— 见下面 .ed-input 的 scroll-margin-top) */
.wz-form .wz-group-head::before {
  content: '';
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: 12px;
  background: linear-gradient(to bottom, var(--surface), transparent);
  pointer-events: none;
}
/* 姓名 + 性别:一个段(题头是 Basics)。
   卡身比照 .wz-fields —— 行与行之间一条发丝线,行内标签左、值右。
   它自己不再是卡:这一整块已经是卡里的一段 */
/* 一段的内容坐在**自己的一块底**上 —— 这是这一页唯一的层次手段:
   没有一条分割线,段的边界由块的四条边给。
   底色用 --bg-elev(与起稿块、嗓音面板同一档):三处用的是同一个语言,
   读者不必为"这里为什么是灰的"再学一遍。
   overflow:hidden 是让行的悬停底色跟着块的四角切齐 —— 少了它,
   首行与末行会从圆角里探出直角来 */
.wz-basics {
  display: flex;
  flex-direction: column;
  gap: 0;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
}
/* 按首行对齐,不按中线 —— 标签现在是两行(字段名 + 标记),
   整块居中的话"Name"会比输入框里那行字高出四五个像素,
   而这两行本来就该齐在第一条基线上 */
.wz-basics > .wz-field {
  align-items: flex-start;
}

/* 起稿是这一页的第一段,也是它最常用的入口 —— 一句话交给模型,
   下面所有栏位由它填出来。整段坐在一块淡底圆角槽里:
   这是这张卡上唯一一块有底色的地方,另外四段都是白面上一行行的清单 ——
   "重点"靠的是"这一块跟别的不一样",而不是把标题再放大一号 */
.wz-draft {
  /* 起稿中那圈呼吸光晕要拿它当定位基准(见 .halo-breathe)。
     光晕只加在槽外,槽本身全程不动 —— 与首页那个输入框同一套:
     槽还是那个槽,变的是槽外的光 */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  /* 12px:与下面每一行的横向内边距同档,于是槽里的字仍然落在
     距卡边 24px 那条竖线上,和另外四段对齐 */
  padding: var(--sp-3);
  border-radius: var(--r-sm);
  background: var(--bg-elev);
  transition: background var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
/* 光标进到这一栏时,槽从淡底翻成白面并亮起一圈淡墨。
   全站不给输入框画焦点描边(见 style.css),这一下就是它的焦点信号 */
.wz-draft:has(textarea:focus) {
  background: var(--surface);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--accent) 18%, transparent);
}
/* 标题与引导语贴成一组:两者是一句话的两半(问什么 + 怎么答) */
.wz-draft-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* 这一页最大的字(20px,--fs-xl),比第二档的段标题高整整五档。
   层次要的是这种一眼可见的落差;此前它只比段标题大一档(16 对 15),
   等于把"最大"和"次大"糊在一起,一页自然没有重点 */
.wz-draft-title {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}
.wz-draft-sub {
  max-width: 56ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
/* 输入槽。字号抬到 15px 并给正文色 ——
   这一栏收的是"一个人的样子",是整页唯一写给人看的话,而下面各栏是填给模型的参数;
   字号与颜色把这两件事分开(15px 与首页的提示词框同档,不是新开的尺寸)。
   它自己不画边框也不画底线:外面那层淡底槽就是它的边界,
   再描一道线等于把"这是一块能写字的地方"说两遍。
   选择器带上 textarea 是为了压过 .ed-input 那几条:两个单类分处文件两头,
   靠先后顺序去赢太脆 */
textarea.wz-idea {
  padding: 0;
  font-size: var(--fs-md);
  line-height: 1.6;
  resize: none;
  /* 随内容长高(见 vGrow),但最多长到 6 行 —— 与首页那个提示词框同一档
     (见 App.vue 的 INPUT_MAX_ROWS)。封顶之后转成内部滚动。
     不封顶的代价在这一页比首页还大:起稿块在整张卡的最上面,
     一段半页长的描述会把下面整套设定、连右栏那份摘要一起顶出视口,
     而用户填到一半最需要看的恰恰是"它到底读出了什么"。
     em 跟着自身的字号走,窄屏那条 16px 的规则一改,这里也自己跟着涨 */
  max-height: calc(1.6em * 6);
  /* 只放行纵向:一长串没有空格的字符不该顶出一条横向滚动条 */
  overflow-x: hidden;
  overflow-y: auto;
}
/* 动作行:提示与报错占左边的余量,主按钮钉在右边。
   用 flex-end + margin-right:auto 而不是 space-between —— 没有提示时按钮也不挪位 */
.wz-draft-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px var(--sp-3);
}
.wz-draft-foot .wz-err,
.wz-draft-foot .wz-draft-hint {
  margin-right: auto;
  min-width: 0;
}
/* 提示与报错都留在这块里:它们是"这一句交给模型"的结果。
   原本挂在表单最末尾,离触发它的按钮隔了四行。
   提示用 text-2 而不是 text-3:这块底是 bg-elev,text-3 在它上面只有 4.40:1,
   过不了正文的 4.5 —— text-3 的 4.6:1 是按 bg / surface 标的 */
.wz-draft-hint {
  /* flex 是为了让图例里那枚小点与文字对齐;纯文案时就是一个普通的文本行 */
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-2);
}
.wz-err {
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--danger-ink);
}

/* 组:卡外一行标题(带一句副题)+ 一张装内容的卡 */
.wz-group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
/* 段与段之间**没有线**:每一段的内容坐在自己的色块上,边界由块的四条边给。
   线与块的分别在于:一条横线把整页切成上下两半,而一块底色只说
   "这一片是一件事" —— 这一页有四五件事,切五刀就成了一页横格纸 */
/* 段标题与副题上下排,像小节的题头。
   标题行下面那条发丝线见 .wz-form .wz-group-head::after ——
   它只在第 1 步那张长表里有,理由与"为什么只有第 1 步吸顶"是同一条。 */
.wz-group-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
  /* 与下面每一行的内容同一条左边缘:行自己有 12px 横向内边距,
     眉标就得补上同样那 12px,否则它会比它管的那些行往里缩 */
  padding: 0 var(--sp-3);
}
/* 段标题:15px / 600 / 满墨 —— 一个实打实的标题。
   上一版把它做成 12px 全大写的眉标,想靠"换一种写法"分层;
   可眉标和行标签同为 12px,一页里就只剩"起稿标题 16、其余全 12"两档,
   反而比原来更平。层次终究要靠字号差,字距与大小写是辅助。

   这一页的**五档**(全向导统一,见 .wz-form 那段的总说明):
     20 页面主标题 / 16 段标题 / 14 行值 / 13 说明 / 12 标签
   段标题原来是 15,而第 2、3 步的标题是 16 —— 同一个角色两种字号,
   这正是"字很乱"的来源。现在统一到 16 */
.wz-group-title {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  font-size: var(--fs-lg);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}
/* 段说明:压在标题下面,与标题差三档。
   原来是 12px + text-3,而"说明"这一角色在别的段里时而是 12、时而是 13,
   颜色时而 text-2 时而 text-3 —— 现在统一到 13px/text-2 这一档:
   它是要读的一句话,不是可以扫过去的脚注(--text-3 那档留给标签) */
.wz-group-hint {
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-2);
}
/* "必填"用一枚墨色星号,不写 "Required" 这个词 ——
   星号是表单里通用的约定,一眼认得,而且只占一个字宽;
   写成词(八九个字符)会把这 88px 的标签列挤成两种版式:
   放得下的挤成一行、放不下的折成两行,同一张卡里两行标签就不是一个形状。
   颜色用 --accent(与字段值同色的墨),不是 --text-3:
   它是这几个字里唯一一条"约束",该压得住旁边那行灰标签。
   读屏不听它(aria-hidden),必填由控件自己的 aria-required 说 */
.wz-mark {
  flex: none;
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 1;
  color: var(--accent);
}

/* 字段区:一列"标签在左、值在右"的列表行 ——
   与详情页那张规格表(.spec,84px 标签列)是同一套读法,只是这里可以就地改。
   为什么是一列而不是两列 —— 四段必须长得一样宽才看得出是一份表:
   两列时 Spec 那一段是两个半宽的行,而 Basics 与 Reference image 是整宽的行,
   并排放在一张卡里,每一段的边界都落在不同的横线上,越看越乱。
   值那一栏有 700px 上下,13px 的字一行放得下十二个词,
   所以改成一列并没有把行撑高多少 —— 换来的是四段同一个形状 */
.wz-fields {
  display: grid;
  grid-template-columns: 1fr;
  /* 行与行不留缝,也不画线:一块底已经说了"这几行是一段",
     行与行的分界交给每一行自己的内边距(见 .wz-field) */
  gap: 0;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
  /* 刻意**不写 overflow:hidden**:被选中的那一行要往外投一道影子,
     裁掉的话首行与末行就成了一块没有边的白斑。
     不去裁也不会露角:首末两行的圆角(8px)与块自己的圆角同值同起点,
     两个圆是重合的 */
}
/* 一行。它自己就是被选中时立起来的那一块:
   底换成白面,再往外投一道接触影 —— 那一行于是从这块灰底上"抬"了起来 */
.wz-field {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: var(--sp-3);
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  transition: background var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
/* ===== 嗓音 =====
   两块:上面一排引擎(系统嗓子 / 自己配的那把),下面按来源分叉。
   分叉只有一行输入 —— 因为三种来源在请求那边本来就只差"voice 从哪来" */
/* 这一组的容器。给一块淡底,把它从上面的"行"里挑出来(见模板里的注释)。
   内边距 12/14 与 .wz-field 那一档对齐,里面的东西不必再自己撑边距 */
.voice-panel {
  display: flex;
  flex-direction: column;
  padding: 14px;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
}
/* 面板里分三块:引擎 → 来源 → 要填的那一格。
   三块的形状各不相同(一排胶囊、一排胶囊、一个输入框),不划线就会糊成一片 ——
   块与块之间一条发丝线,两端内缩,与卡里别处的分隔同一个规矩 */
/* 块与块之间也**不画线**:面板本身已经是一块底,里面再切几刀
   就成了"卡片里套卡片"。分块交给每块开头那枚小标题(ENGINE / VOICE SOURCE)
   与 20px 的留白 —— 它们本来就写在每一块的最前面,是比线更早看到的东西 */
.voice-block + .voice-block {
  margin-top: 20px;
}
/* 组内的小标题(Engine / Voice source)。
   满墨 + 大写 + 字距:这一组里除了字段名,别的字都是 --text-2 的灰 ——
   标题只有用最重的那档墨色才压得住,分块才立得起来 */
.voice-cap {
  display: block;
  margin: 0 0 8px;
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: var(--text);
}
.voice-seg {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.voice-seg button {
  min-height: 36px;
  padding: 0 13px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.voice-seg button:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
/* 选中的那枚用实心纸色 —— 与查看器的主操作同一个说法:
   这一组里"现在哪一档"必须一眼看得出来 */
.voice-seg button.on {
  border-color: var(--cta);
  background: var(--cta);
  color: var(--cta-text);
}
/* 说明:解释"这一档是什么意思"。它是要读的一句话,留在 13px/--text-2 */
.voice-note {
  margin: 8px 0 0;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-2);
}

/* —— 要填的那一格 ——
   上面全是灰字,这里必须一眼看出"框里才是要写的"。所以三件事同时做:
   字段名压成 12px 的墨色小标、控件套一个白面描边的框、注脚退回框外的灰字。
   框是这一组里唯一的"可写"信号 —— 它也是"哪些是要填的"这句话的答案 */
.voice-field {
  display: block;
}
/* 块里第一格贴块顶(上边距由块自己出),后面的格与它拉开一档 */
.voice-block > .voice-field:first-child {
  margin-top: 0;
}
.voice-field + .voice-field {
  margin-top: 14px;
}
/* 墨色而不是灰:它是"这一格填什么",就压在框的上沿,该比注脚重 */
.voice-label {
  display: block;
  margin-bottom: 6px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text);
}
/* 框。白面托在淡灰面板上,再描一道发丝线 —— 深色主题下两者明暗相反,
   但"这里是一个框"这件事两边都成立。
   min-height 40px 是这一页可点区域的底线(与首页那些按钮同档) */
.voice-control {
  display: flex;
  align-items: center;
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.voice-control:hover {
  border-color: var(--line-strong);
}
/* 焦点落在框上,而不是里面那条无框的字(.ed-input 自己的焦点样式是空的),
   否则"光标落在这格"就没有任何信号 */
.voice-control:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
/* 内边距由框来撑,里面的控件不再自己留上下余量(否则会多出 4px) */
.voice-control .ed-input {
  flex: 1;
  padding: 0;
}
/* 描述那一档的 textarea 随内容长高(见 vGrow),框也跟着长 */
.voice-control textarea.ed-input {
  resize: none;
  line-height: 1.5;
}
/* 注脚:框下面那行解释。与 .voice-note 同档 —— 两者的分界交给位置,
   一句在选项下、一句在框下 */
.voice-hint {
  display: block;
  margin-top: 6px;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-2);
}
/* 注脚里的强调句(如 "This description is the voice.")。
   原来 em 被抹成和正文一样的灰,等于没强调 —— 它该压得住旁边那句解释 */
.voice-hint em {
  font-style: normal;
  font-weight: 600;
  color: var(--text);
}
.voice-clone {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.voice-sample {
  font-size: var(--fs-xs);
  color: var(--text-3);
  overflow-wrap: anywhere;
}
.voice-audition {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
/* 报错。display:block 是给 clone 那一条(它是 span)补的 ——
   行内元素上写 margin-top 本来就不生效 */
.voice-err {
  display: block;
  margin: 8px 0 0;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--danger-ink);
}
/* 选中/聚焦那一行的底:往 --accent(墨)里掺一档,再从块底上取色。
   为什么不直接用现成的两个 token —— 这套灰阶是刻意压密的:
   白 #FFF 与块底 #F5F5F2 只差 1.09:1,--surface-hover 与它更近(1.08:1)。
   换哪个 token 都是"换了个寂寞":键盘 Tab 过去,看不出光标落在哪一行。
   而分割线与左缘那条强调线这一版都已经撤了,没有第二种东西可以标记它。

   掺墨的比例在**两个主题里都朝"更显眼"走**:浅色面上掺的是近黑,
   于是那一行是一块比周围更深的灰;暗色面上掺的是近白,于是它比周围更亮。
   同一个 4% / 9%,两边各自成立,不必为暗色另写一套。

   悬停与聚焦差一档(4% → 9%),不是同一格,是一格比一格重:
   "够得着这里"与"就在这一行"本来就该读得出先后。
   那块接触影只补在更重的那一档上 —— 浅色主题里它给出一点厚度,
   暗色主题里看不见也无妨(底色那一档已经说清楚了) */
.wz-field:hover {
  /* 3% 而不是 4%:再深一点,标签(text-2)在它上面就只剩 4.43:1 ——
     12px 的字差这一点就过不了线。悬停这一档本来就该轻,
     真正要看得清的是下面那一档;这点厚度不足以说明"够得着",影子来补 */
  background: color-mix(in oklch, var(--accent) 3%, var(--bg-elev));
  box-shadow: 0 1px 3px -1px rgba(0, 0, 0, 0.08);
}
.wz-field:focus-within {
  z-index: 1;
  background: color-mix(in oklch, var(--accent) 9%, var(--bg-elev));
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 10px 22px -14px rgba(0, 0, 0, 0.35);
}
/* 光标落进这一行,连标签一起醒过来:灰变墨。
   这一下不只是好看 —— 底色压深之后,text-2 的标签在它上面只剩 3.95:1,
   而"正在编辑的那一行"恰恰是最需要读清的一行。提到满墨是 12:1。
   两处深浅差一档(4% → 9%)加这一下颜色,合起来才是"选中"该有的分量:
   比悬停重,又不必画线 */
.wz-field:focus-within .wz-label {
  color: var(--text);
}
/* 值占满标签右边的那点余量。它自己不带边框也不带底 ——
   行的底色已经说清了"这一格能写" */
.wz-field > .ed-input {
  flex: 1;
  min-width: 0;
  width: auto;
}
/* 备注是自由文本,占满两列 */
.wz-field.is-wide {
  grid-column: 1 / -1;
}

/* —— 性别与风格:两枚闭合选择 ——
   没有灰槽、没有实心药丸:这两栏在页面上是**值**,不是一个工具条 */
/* 选择器:一枚**贴着当前值**的下拉,右边紧跟一枚小箭头。
   宽度跟内容走(不加 width:100%)—— 一栏两三个词的选项铺满 530px 的值列,
   空出来的那一大片比控件本身还显眼,而"宽"正是它上一版被诟病的地方。

   为什么里面多一层 .wz-select-val:原生 select 的宽度取的是**最长的那一枚选项**,
   不是选中的那一枚 —— 选中 Auto 时,"Photorealistic" 会把框撑宽,
   于是文字与箭头之间空出一大截,看着像坏了。所以量宽度的活儿交给那层
   (visibility:hidden,照常参与排版),下拉本体绝对定位盖在上面:
   值是什么,框就是多宽,箭头永远紧跟着字 */
.wz-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
  min-width: 0;
}
.wz-select-val {
  /* 只为量宽度:它不显示,但它撑出和当前值一样宽的一条 */
  visibility: hidden;
  white-space: nowrap;
  padding: 4px 22px 4px 0;
  font-size: var(--fs-base);
  /* 值按原样存(提示词里要的就是 female / male 这两个词),
     只有摆在界面上时才首字母大写 */
  text-transform: capitalize;
}
.wz-select select {
  /* 原生下拉的箭头与外框都去掉,换成自己那枚 —— .ed-input 那套
     (无框、无底、14px 满墨)照旧,于是它读起来和别的值一样是"一行字" */
  appearance: none;
  -webkit-appearance: none;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-width: 0;
  padding: 4px 22px 4px 0;
  cursor: pointer;
  text-transform: capitalize;
}
/* 还没选:那一格收的是"没有值",字要退到占位符那一档灰 */
.wz-select.is-empty select,
.wz-select.is-empty .wz-select-val {
  color: var(--text-3);
}
.wz-select-ico {
  position: absolute;
  right: 2px;
  width: 13px;
  height: 13px;
  color: var(--text-3);
  pointer-events: none;
}
.wz-field:hover .wz-select-ico,
.wz-field:focus-within .wz-select-ico {
  color: var(--text-2);
}
/* 行标签:定宽 88px 的左边一列 —— 所有字段值于是从同一条竖线起排。
   88px 与详情页规格表的 84px 同一档(这里多 4px,是因为表单里的字要首字母大写、
   最长的一条 "Nose & mouth" 得留出富余)。

   字号与颜色都压到最安静那一档(12px / 500 / text-3):
   这一段里标签只是"这一格填什么"的提示,真正的内容是右边那个值,
   而值给的是 13px 的满墨 —— 两者差的不只是 1px,还有一整档色深。
   标签再重一点,一行里就会变成两段同样有分量的字,谁也不让谁。

   这一行里还会跟两枚小东西:必填的星号(.wz-mark)、
   "模型填过"的小牌(.wz-ai)—— 都是字段名的一部分,跟它同一行 */
.wz-label {
  flex: none;
  width: 88px;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 与右边的值对齐首行基线:值的输入框自带 4px 上内边距 */
  padding-top: 4px;
  font-size: var(--fs-xs);
  font-weight: 500;
  line-height: 1.4;
  /* text-2 而不是 text-3:这一行的底是 --bg-elev(不是白面),
     text-3 在它上面只有 4.14:1 —— 12px 的字差这一点就过不了正文那条线。
     与值(14px 满墨)仍差着一整档,标签还是那行里更安静的一半 */
  color: var(--text-2);
  transition: color var(--dur) var(--ease);
}
/* 起稿填过、还没动过的标记。原来是一枚 5px 的小黑点 ——
   它没有说自己是什么,得靠起稿块里那行图例去解释("the dot clears once you
   edit that line"),而图例在卡片最上面,读到第十行时早忘掉了。
   换成两三个字母的小牌:同名同姓的记号在别处也这么写,不必先读一遍说明书。
   压得很轻(10px / text-2 / 淡墨底)是因为它标的是**还没校对过**这件事,
   不是"这一栏很重要";用户改一下那一栏它就消失(见 markEdited) */
.wz-ai {
  flex: none;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--accent-soft);
  /* 牌上的字比 --text-2 再压深一档:10px 已经是最小的一档字号,
     而它脚下的淡墨底把 --text-2 的有效对比拉到 4.26:1 —— 差一点点过不了正文那条线。
     混一档墨之后回到 5:1 上下,深浅仍在"标签"那一带,抢不过字段名 */
  color: color-mix(in oklch, var(--text-2) 80%, var(--text));
  font-size: 10px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.04em;
}
/* 给读屏的"这栏是模型填的"。视觉上靠那枚牌,但那三个字母不值得被逐字念出来 ——
   样式在 style.css 的 .sr-only,这里不另立一份 */
/* 参考图:空态与有图态同一个高度 —— 挑完图不该整块往上跳一下。
   它就是段里的一行:横向内边距与 .wz-field 同档(12px),
   于是它的外框与上面那些行的悬停底色同起同止,
   里面的图与字也落在距卡边 24px 那条竖线上。
   这里不再额外收 margin —— 卡自己已经收了 12px,
   再收一层会让这一段的框比别的段窄一圈(就是"宽度不一致"的由来) */
.wz-ref {
  /* 读取中那圈呼吸光晕的定位基准(见模板里的 halo-breathe)。
     光晕只加在卡外,卡本身全程不动 */
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 68px;
  padding: 10px var(--sp-3);
  border-radius: var(--r-sm);
  /* 与其他几段同一个语言:这一块也是一片内容区,坐在自己的底上 */
  background: var(--bg-elev);
}
/* 空态就是同一块底,只是里面的话换成"往这儿放图"。
   原来这里画的是一条虚线框 —— 全站的格子(设定图、海报卡)都是
   "有底无边",虚线只在这一处出现过:它是线框稿的写法,
   读起来像待填的表单,而这一块与别处一样是已经设计好的界面 */
.wz-ref-pick {
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.wz-ref-pick:hover {
  background: var(--surface);
}
.wz-ref-pick > svg {
  flex: none;
  width: 20px;
  height: 20px;
  color: var(--text-3);
  transition: color var(--dur) var(--ease);
}
.wz-ref-pick:hover > svg {
  color: var(--text);
}
.wz-ref-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}
.wz-ref-main {
  font-size: var(--fs-base);
  font-weight: 500;
  color: var(--text);
}
.wz-ref-hint {
  font-size: var(--fs-sm);
  /* 同 text-3 的账:这块底是 bg,悬停时变 bg-elev,text-3 在后者上只有 4.40:1 */
  color: var(--text-2);
}
.wz-ref-thumb {
  flex: none;
  /* 48 + 上下内边距 18 + 边框 2 = 68,与空态的 min-height 分毫不差 ——
     挑完图那一行不会悄悄长高两像素 */
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}
/* 有图之后这一块多一行识图状态,所以外面包一层纵向容器。
   图片那一行本身的高度不变(见上面的 min-height) */
.wz-ref-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
/* 识图状态行:左边是取景框与说明,右边是重读按钮。
   min-height 兜住基线 —— 从"读取中"到"已读"再到"又跟了一行说明",
   每次换态整块不该抽一下 */
.wz-scan {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 34px;
  /* 与上下那两行的内容同一条左边缘(上面 .wz-ref 自己收了 12px 外边距) */
  padding: 0 var(--sp-3);
}
/* 取景框与它下面那几句说明竖着排。颜色定在这里:
   LatticeLoader 的 label 走 currentColor,跟着它就有了深浅两种主题下的正确墨色 */
.wz-scan-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text-2);
}
.wz-scan-hint {
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-2);
}
/* 识图失败的正文。上游回的是**一整段原样 JSON**(认证失败、图片过大、
   模型不存在都会连错误码和 request id 一起带回来),原样铺开就是三五行
   红字,把这一行撑成一堵墙,还顺手把旁边的"重读"按钮挤到看不见的地方。
   所以给它一块自己的底、一个高度上限,细节留在里面滚:
   要读的人读得到,不读的人也不会被它挡住下一步 */
.wz-scan-err {
  margin-top: 2px;
  padding: 7px 10px;
  border-radius: var(--r-sm);
  background: color-mix(in oklch, var(--danger) 7%, transparent);
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--danger-ink);
  /* 长 JSON 里没有空格可断,得允许它在任意位置折行 */
  overflow-wrap: anywhere;
  /* 四行封顶。加号右边那 14px 是上下内边距 —— 全局是 border-box,
     只写行高的话上限会把第 4 行切成半行 */
  max-height: calc(1.5em * 4 + 14px);
  overflow-y: auto;
}

/* —— 表单控件:所有文本输入共用 ——
   无框、无底、无圆角:它现在是"列表行里的一段可写文字",不是一个盒子。
   行的底色与左缘那道短竖线负责说"这一格能写、光标正落在这儿"(见 .wz-field),
   盒子只会把一行行东西重新切回原来那种方框阵 —— 那正是这一版要丢掉的 */
.ed-input {
  width: 100%;
  min-width: 0;
  padding: 4px 0;
  border: 0;
  border-radius: 0;
  background: none;
  color: var(--text);
  /* 14px:整份表单里"值"的统一档。原来是 13,和 12 的标签只差 1px ——
     两者在密集的行里几乎分不出来,"信息没有差距"说的就是这一处 */
  font-size: var(--fs-base);
}
/* 第 1 步那几段是吸顶的(见 .wz-form .wz-group-head)。焦点落到某栏时
   浏览器会把这一栏滚进视野,而它算不出顶上压着一条题头 ——
   于是刚点进去的那一行正好藏在题头底下。留出题头的高度即可 */
.wz-form .ed-input {
  scroll-margin-top: 76px;
}
/* 占位符显式定色:浏览器默认那一档灰在浅色面上过不了 4.5:1 */
.ed-input::placeholder {
  color: var(--text-3);
}
.ed-input:focus {
  outline: none;
  box-shadow: none;
}
/* 规格字段是 textarea,随内容长高(见 vGrow),但三行封顶。
   为什么不封顶:一行行往下摞的表里,只要有一格长起来,
   整份表的分栏线就跟着塌一格 —— 用户扫的时候会以为那是一片空白,
   而不是"这一栏我写多了"。封顶之后每一行的高度是稳定的。
   封顶就要配内部滚动(不能让它溢出),这是这一版认下的代价:
   一页里两条滚动条,好过一次把整张表的节奏打乱。
   1.5em × 3 跟着自身字号走,窄屏那条 16px 的规则一改,这里也自己跟着涨 */
.wz-field textarea.ed-input {
  resize: none;
  line-height: 1.5;
  max-height: calc(1.5em * 3);
  overflow-x: hidden;
  overflow-y: auto;
}
.ed-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  padding: 9px 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.ed-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.ed-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 键盘走到哪个按钮上要看得见:这条以前是缺的,只有 hover 有反馈 */
.ed-btn:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.ed-btn svg {
  width: 15px;
  height: 15px;
}
.ed-btn.primary {
  border-color: var(--cta);
  background: var(--cta);
  color: var(--cta-text);
}
.ed-btn.primary:hover:not(:disabled) {
  border-color: var(--cta-hover);
  background: var(--cta-hover);
}
/* 已选中的状态(主参考图):墨色描边 + 实心底,和别处"当前项"同一套 */
.ed-btn.is-on {
  border-color: var(--cta);
  color: var(--text);
  background: var(--bg-elev);
}
/* 停止符号:一个方块,和设定图格子上那枚同源(都用 CSS 画,不引图标)。
   currentColor 让它跟着按钮的文字色走,深浅两种底都成立 */
.ed-stop {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 2px;
  background: currentColor;
}

/* —— 列表:卡片网格 ——
   卡片本身在 CharacterCard.vue(顶图全出血 + 底部毛玻璃信息区),
   这里只管这一排怎么排 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--sp-5);
  margin-top: var(--sp-5);
}

/* —— 详情 —— */
/* 详情页没有大标题,但顶部要与列表页及其他页的标题行对齐 */
.dt-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding-top: var(--sp-2);
  margin-bottom: var(--sp-4);
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-sm);
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.back:hover {
  color: var(--text);
}
.back svg {
  width: 15px;
  height: 15px;
}
/* 顶栏右侧一组动作:复制 / 导出是常规动作,删除是破坏性的 ——
   前者悬停提亮到正文色,后者悬停才亮红。三个同重会读不出主次 */
.dt-acts {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.dt-act,
.dt-del {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: var(--fs-sm);
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.dt-act:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.dt-del:hover {
  color: var(--danger);
  background: color-mix(in oklch, var(--danger) 8%, transparent);
}
.dt-act svg,
.dt-del svg {
  width: 15px;
  height: 15px;
}

/* 身份区:一张卡把"这是谁、进行到哪、能做什么"说全。
   卡里是两栏 —— 左图,右边一栏里再分"我是谁"与"能做什么"。
   图与文字之间留一档半的呼吸:200px 的图旁边紧贴文字会读起来像"图注" */
.hero {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  padding: var(--sp-5);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
/* 主视觉:正脸那张图。3:4 与列表里的角色卡同一个比例,圆角也同一档 ——
   这一页是那张卡"打开之后",同一个人不该换个形状。
   影是贴边接触影(见 --sh-sm):浅色主题里照片边缘不托一道会糊在卡面上。
   没有正脸时是一块淡底的占位框,尺寸不塌 —— 那一栏的存在感先立住 */
.hero-shot {
  flex: none;
  /* 240 × 320。内容区约 1040px,它占四分之一 —— 再小就只是"配图",
     再大又会把下面那五张设定图压成附属品,而它们才是这一页的正文 */
  width: 240px;
  aspect-ratio: 3 / 4;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 24px;
  background: var(--image-bg);
  color: var(--text-4);
  box-shadow: var(--sh-sm);
}
.hero-shot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hero-shot svg {
  width: 40px;
  height: 40px;
}
/* 文字那一栏与动作那一栏并排,各占一头。
   文字**封到 46ch**:这一栏要回答的是一句"这是谁",不是一段正文 ——
   封顶之后右端不再被拉成一整行空,动作列也有地方站 */
.hero-body {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-6);
}
.hero-id {
  min-width: 0;
  max-width: 46ch;
}
/* 名字是这一页的标题,而它旁边现在站的是一张 267px 高的图 ——
   22px 的名字配那个体量会显得像图注。抬到 28px(fs-3xl,与各页页标题同档) */
.hero-name {
  font-size: var(--fs-3xl);
  line-height: 1.2;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}
.hero-sub {
  margin-top: 5px;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
/* 用量那一行:数字是主角,所以点用最淡的一档隔开,别和数字抢注意力 */
.hero-meta {
  margin-top: 8px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.hero-meta span + span::before {
  content: '·';
  margin: 0 7px;
  color: var(--text-4);
}
.hero-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
/* 底用 bg-elev 而不是 bg:卡片本身就是 surface,浅色主题下 bg 与它几乎同色,
   胶囊只剩一圈描边、没有实体感 */
.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-elev);
  font-size: var(--fs-micro);
  color: var(--text-2);
}
.tag svg {
  width: 11px;
  height: 11px;
}
/* 主参考图是本页唯一需要"一眼看出是哪张"的状态,用 accent 标出来 */
.tag-on {
  border-color: color-mix(in oklch, var(--accent) 30%, var(--line));
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}
.hero-cta {
  padding: 10px 16px;
}
/* 动作靠右站成一条竖列(不再是跟在文字后面的下半段):
   一是它与上面 .dt-bar 那排动作同为"能做什么",该在同一条右边缘上;
   二是主次一眼可见 —— 涂黑的那枚永远在最上面。
   三枚按钮里只有一或两枚在场(齐了就没有"补齐"那一枚),
   用 align-items: stretch 让它们同宽,列才不会看着参差 */
.hero-actions {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
}
.hero-chat {
  min-height: 40px;
  padding: 10px 15px;
}

.panel {
  margin-top: var(--sp-4);
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
/* 三张资料表(Spec / Personality / Voice)收成一段"附录"。
   它们原来是三张上下堆叠的卡,一路读下来就是一堵"表单墙" ——
   可它们其实是同等次要的东西:都是"要用的时候才查"的资料,
   而这一页的主角是上面那张脸,以及它那五张设定图。
   并排之后它们从"页面正文"退成一段注脚,视线扫过就行。

   排法是**左一右二**:Spec 跨两行,人格与嗓音叠在右栏。
   为什么不是三张等宽一排 —— 三张的行数差得太远(13 / 5 / 3):等宽时
   Spec 的每个值都折两三行,自己长到 658px,而人格与嗓音底下各空着
   327px 和 475px。试过把 Spec 加宽成 1.6 : 1 : 1 与 2 : 1 : 1(行高压到
   554 / 492),但那是拿另外两张的宽度换来的:242px 时值那一列只剩 114px、
   一行十来个字符,嗓音卡头上那两枚按钮直接溢出卡外。
   改成一左一右之后 Spec 拿到 599px(每个值一行放得下),另外两张各 353px
   (比原来的 323px 还宽),整段从 658 降到 509,剩下的一点余量全落在
   Spec 卡内(它比右栏矮 56px),底边由 align-items: stretch 拉齐 */
.dt-facts {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr);
  gap: var(--sp-4);
  align-items: stretch;
  margin-top: var(--sp-4);
}
/* 并排之后卡自己那条上边距要去掉:间隙由 grid 的 gap 统一给,
   否则三张卡会一起再往下挪一格 */
.dt-facts > .panel {
  margin-top: 0;
}
/* 三张卡各自的位置写死(不再靠 auto-fit 自动落位):
   Spec 管"进提示词的设定"这一头,行数最多,给它左栏两行的高度 */
.fact-spec {
  grid-column: 1;
  grid-row: 1 / span 2;
}
.fact-persona {
  grid-column: 2;
  grid-row: 1;
}
.fact-voice {
  grid-column: 2;
  grid-row: 2;
}
/* 861–900 这一段右栏只有 250–290px,嗓音卡头刚好卡在临界上:
   让它能换行 —— 那两枚按钮掉到第二行,好过挤出卡外 */
.fact-voice .panel-head {
  flex-wrap: wrap;
}
.panel-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: var(--sp-3);
}
.panel-title {
  font-size: var(--fs-lg);
  color: var(--text);
}
/* 一块里有两枚动作时(试听 / 改嗓音)收成一组推到最右 ——
   与 .panel-note 占满余量是同一条路:标题在左,动作在右。
   只给一枚动作的块不用它,那一枚本来就该跟着标题走 */
.panel-acts {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-note {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}
/* 生成进度占的是"说明"那一格。loader 是一块方格,按基线对齐会歪,单独居中 */
.panel-progress {
  flex: 1;
  min-width: 0;
  align-self: center;
  color: var(--text-2);
}
/* 带 panel-head 的那块由 panel-head 自己留白,只有 Spec 这种裸标题才要补 */
.panel > .panel-title {
  margin-bottom: var(--sp-3);
}

/* —— 设定图 ——
   原来是五格并排。但四张方块(1:1)与 Full body 那张竖幅(2:3)同排并立时,
   竖幅会比旁人高出一大截,一行里参差不齐 —— 改成"左四右一":
   四张方块拼成 2×2,竖幅独占右列。这个分法也正好对上信息层级:
   左边是同一张脸的四个方向,右边是整个人 */
.sheet {
  display: grid;
  /* 1.4fr 是算出来的:要让左边 2×2 的总高与右边那张 2:3 的总高相等,
     竖幅这列就得比一个方块宽 1.4 倍。按内容区 1040px 宽算,两边差 6px 上下 ——
     落在标签的字里行间,看不出来 */
  grid-template-columns: 1fr 1fr 1.4fr;
  gap: var(--sp-3);
  align-items: start;
}
/* 竖幅挪到第三列并纵向跨两行;四张方块随之自动落进左边的 2×2 */
.cell.is-portrait {
  grid-column: 3;
  grid-row: 1 / span 2;
}

/* —— 这个角色出过的图 ——
   这里是小样,不是作品墙:一律裁成正方形(cover),不按每张的真实比例摆 ——
   那会让格子高低不齐。点开才是完整的那张 */
.works {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: var(--sp-2);
}
.work {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--image-bg);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.work img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 700ms var(--ease);
}
/* "这张来自对话"的角标(见 lib/chatWork)。小样只有 96px 上下,
   所以只用一枚 12px 的图标、垫在左下角,不写文字。
   白 + 投影那套与历史图墙的角标一致:格子里的图什么底色都有 */
.work-src {
  position: absolute;
  left: 5px;
  bottom: 5px;
  display: flex;
  color: #fff;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.6));
  pointer-events: none;
}
.work-src svg {
  display: block;
  width: 13px;
  height: 13px;
}
/* 与角色卡同一套悬停语言:抬一点、图放大一点 */
.work:hover {
  border-color: var(--line-strong);
  transform: translateY(-2px);
}
.work:hover img {
  transform: scale(1.06);
}
.works-more {
  margin-top: var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--text-3);
}

/* —— 规格表 —— */
.spec {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 9px 12px;
  align-items: baseline;
}
.spec-k {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.spec-v {
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text);
  overflow-wrap: anywhere;
}
.spec-v.dim {
  color: var(--text-3);
}

/* —— 看大图 ——
   从"白卡 + 顶部标题条 + 底部按钮条"的工具型弹窗,改成照片浏览器:
   图自己浮在深底上,控件是压在图上的玻璃件。

   深色遮罩是刻意的、与主题无关 —— 和角色卡、设定图格子一样,
   凡是"衬着照片"的表面都不走 token:照片需要一层中性的暗底才看得出影调,
   浅色主题下把页面糊成浅灰反而会让图发飘 */
.viewer {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
  background: rgba(16, 16, 18, 0.86);
  backdrop-filter: blur(20px) saturate(120%);
  -webkit-backdrop-filter: blur(20px) saturate(120%);
}
/* 盒子收缩到图的大小、且不带底色 —— 白卡一撤,图才真的"浮"起来 */
.viewer-box {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  max-width: 100%;
  max-height: 100%;
  min-width: 0;
}
.viewer-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  min-height: 40px;
  margin-bottom: 12px;
  padding-left: 2px;
}
/* 与设定图格子同一套眉标写法:它答的是同一个问题(这是哪一视图) */
.viewer-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.viewer-label {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: rgba(252, 251, 249, 0.78);
}
/* 翻到第几张:比标签再淡一档 —— 它是注解,不是标题 */
.viewer-pos {
  flex: none;
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: rgba(252, 251, 249, 0.42);
}
.viewer-x {
  flex: none;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(252, 251, 249, 0.12);
  color: #fbfaf7;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.viewer-x:hover {
  background: rgba(252, 251, 249, 0.24);
}
.viewer-x svg {
  width: 16px;
  height: 16px;
}
.viewer-stage {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 0;
}
.viewer-img {
  display: block;
  max-width: 100%;
  /* 上下两块控制条 + 一点余量。dvh 那一行是必须的:移动端的 100vh 指的是
     地址栏收起时那个更大的高度,照它算,图的下半截会伸到地址栏底下 */
  max-height: calc(100vh - 210px);
  max-height: calc(100dvh - 210px);
  object-fit: contain;
  border-radius: var(--r-lg);
  background: var(--stage-bg);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
}
/* 翻页钮压在图的两侧边上,而不是把图挤窄 ——
   和角色卡、设定图格子是同一套"浮层压在照片上"的语言。
   两只钮靠 :first-of-type / :last-of-type 分左右(图不是 button,不参与) */
.viewer-nav {
  position: absolute;
  top: 50%;
  z-index: 2;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(24, 24, 22, 0.44);
  color: #fbfaf7;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  transform: translateY(-50%);
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.viewer-nav:first-of-type {
  left: 10px;
}
.viewer-nav:last-of-type {
  right: 10px;
}
.viewer-nav:hover {
  background: rgba(24, 24, 22, 0.68);
}
.viewer-nav svg {
  width: 16px;
  height: 16px;
}
/* 动作排在图下方、居中。
   只剩一个动作了(重新生成 / 停止),所以它直接是纸色实心 ——
   在深底上必须一眼看得出这是可点的;两枚淡玻璃的旧写法连边界都看不清 */
.viewer-acts {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 16px;
}
.viewer-acts .ed-btn {
  padding: 10px 20px;
  border-color: transparent;
  background: #fbfaf7;
  color: #1a1a18;
  font-weight: 600;
}
.viewer-acts .ed-btn:hover:not(:disabled) {
  border-color: transparent;
  background: #fff;
  color: #000;
}

/* —— 空态 —— */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: var(--sp-7);
  text-align: center;
}
/* 与历史页的空态同一档尺寸与留白 */
.empty-ico {
  width: 44px;
  height: 44px;
  color: var(--text-3);
}
.empty-title {
  font-size: var(--fs-lg);
  color: var(--text);
}
.empty-sub {
  max-width: 48ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
.empty .ed-btn {
  margin-top: 6px;
}

/* 资料区那一左一右在 860 以下并排不下:右栏只剩 250 来像素,嗓音卡头上
   那三样(标题 + Hear it + Change voice)会挤到卡外。落成一栏,三张各占一行。
   位置是写死的,这里必须一起复位,否则后两张会叠进同一个格子 */
@media (max-width: 860px) {
  .dt-facts {
    grid-template-columns: 1fr;
  }
  .fact-spec,
  .fact-persona,
  .fact-voice {
    grid-column: 1;
    grid-row: auto;
  }
}

@media (max-width: 720px) {
  /* 手机上把这一排的触控目标抬到 40px —— 站内对触屏的底线
     (见 App.vue 里 .param-btn / .clear-icon 那几条)。桌面维持原尺寸:
     那边有鼠标,把它撑大只会让版面变松 */
  .chars-new,
  .chars-import {
    min-height: 40px;
  }
  /* 步骤条那三枚是这一页唯一的"跳步"入口,28px 太窄 */
  .wz-step {
    min-height: 40px;
  }

  /* 这一页上所有的实心/描边按钮(向导的进退、详情的 Edit/Export、
     嗓音那两排选项)桌面都是 36px。手机上一律抬到 40px ——
     它们在同一屏里成排出现,只抬一半会显得一高一低,手指也更容易点错 */
  .ed-btn,
  .voice-seg button {
    min-height: 40px;
  }
  /* 手机上这张浮卡改成一整屏的页:**上下两条边都钉住**,高度不再由 vh/dvh 算。

     为什么非改不可:卡片是 position:fixed 的,高度一旦超过可视区,
     多出来的那一截**没有任何办法滚到** —— 底下那排进退按钮就"看不到"了。
     而"可视高度"在手机上恰恰是最不稳的一个数:地址栏收放会实时改它,
     软键盘弹起时布局视口甚至可以完全不动(那时 dvh 算出来的仍是原值),
     个别 webview 里 dvh 还会退回 vh —— 而移动端的 vh 指的是**地址栏收起时**
     那个更大的高度,按它算出来的卡,底边正好压在地址栏底下。
     钉住 top/bottom 之后,高度只由这两条边决定,与上面这些全不相干。

     桌面端不这么改:那边浮卡的高度由内容决定是优点(第 2 步短、
     第 1 步长,卡跟着变),而手机上内容本来就满屏,没有这个取舍 */
  .wizard {
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    transform: none;
    width: auto;
    /* 双保险:上下两条边已经把它框住了,这里再用 dvh 兜一道 ——
       个别 webview 里 fixed 的包含块比真正看得见的那一块大(Android 上
       地址栏是浮在页面上方的,布局视口并不跟着缩),那种环境下 bottom:0
       会落在那条地址栏底下,而 max-height 认得 dvh,仍然卡得住 */
    max-height: calc(100dvh - 2 * var(--sp-2));
    /* 高度已经由上下两条边定死,再留 min-height 只会在矮屏上把它顶出去 */
    min-height: 0;
    /* 刘海与底部横条:浏览器没开 viewport-fit=cover 时这两个值是 0,
       那时视口本身已经被系统让开了,不影响 */
    padding-top: max(var(--sp-2), env(safe-area-inset-top));
    padding-bottom: max(var(--sp-2), env(safe-area-inset-bottom));
    padding-left: var(--sp-2);
    padding-right: var(--sp-2);
    gap: var(--sp-2);
  }
  /* 页脚离屏幕底边再让开一段:这一排是手机上唯一要按的东西,
     贴着边缘不好按,也容易被系统的横条压住 */
  .wz-foot {
    padding-bottom: max(12px, env(safe-area-inset-bottom));
  }

  /* 窄屏时标签左、值右会挤不下(88 + 12 + 值那一列就顶到边了):
     标签回到值上面,行变成上下两段 */
  .wz-fields > .wz-field,
  .wz-basics > .wz-field {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  /* 标签在值上方,88px 那一列不复存在,自然拿到整行宽 */
  .wz-label {
    width: auto;
    padding-top: 0;
  }
  /* 值那一列也成整行宽,所以贴左排 */
  .wz-select {
    align-self: flex-start;
  }
  /* 列里不能让输入框 flex:1 —— 主轴变成竖的,flex-basis:0 会把文本域压没 */
  .wz-field > .ed-input {
    flex: none;
    width: 100%;
  }
  /* 16px 以下 iOS Safari 聚焦时会放大整页(与提示词库同一档处理)。
     名字那栏现在也用 .ed-input,所以一并覆盖到了。
     起稿那一栏得单独写一遍:它的选择器是 textarea.wz-idea(为了压过 .ed-input),
     那一条比这儿的 .ed-input 高一档,不重申就还是 15px */
  .ed-input,
  textarea.wz-idea {
    font-size: 16px;
  }
  /* 窄屏:提示与按钮各占一行(按钮满宽,触控目标也够大)——
     原来这一行是"输入框 + 按钮挤在一起",输入框只剩十来厘米宽 */
  .wz-draft-foot .wz-err,
  .wz-draft-foot .wz-draft-hint {
    width: 100%;
  }
  .wz-draft-foot .ed-btn {
    width: 100%;
    height: 44px;
  }
  /* 窄屏:三步的标签一起挤会先被截断的是第三段,
     所以把连接线收短、步间距压小 —— 圆点比标签更需要留在原地 */
  .wz-steps {
    gap: 6px;
    padding: 12px var(--sp-4);
  }
  .wz-line {
    flex: 0 0 10px;
  }
  .wz-step {
    min-width: 0;
    gap: 6px;
  }
  .wz-name {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--fs-xs);
  }
  /* 四张其余设定图两行两列:四格一排会把每格压到看不清 */
  .wz-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: var(--sp-2);
  }
  /* 窄屏并排会把图压到看不清:图上、事下 */
  .wz-hero {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-4);
  }
  .wz-hero-shot {
    width: min(288px, 100%);
    align-self: center;
  }
  /* 窄屏卡更小、一排两枚:auto-fill 自己退列,不用手写列数 */
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: var(--sp-3);
  }
  .hero {
    flex-wrap: wrap;
    padding: var(--sp-4);
    gap: var(--sp-4);
  }
  .hero-shot {
    width: 104px;
    border-radius: 16px;
  }
  /* 窄屏那一栏再竖着分:先"我是谁",再"能做什么"。
     动作排不成竖列了(横过来一行放得下),主按钮仍旧独占一行 */
  .hero-body {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-4);
  }
  .hero-id {
    max-width: none;
  }
  .hero-actions {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .hero-actions .ed-btn {
    flex: 1 1 auto;
  }
  .hero-cta {
    width: 100%;
  }
  /* 窄屏放不下"左四右一":竖幅那一列会被压成细条。
     改成方块自己 2×2,竖幅另起一行居中,并给它一个高度上限 ——
     2:3 的图占满整屏宽会长到屏幕外面去 */
  .sheet {
    grid-template-columns: 1fr 1fr;
  }
  .cell.is-portrait {
    grid-column: 1 / -1;
    grid-row: auto;
  }
  .cell.is-portrait :deep(.cell-img) {
    height: 46vh;
    width: auto;
    align-self: center;
  }
  /* 向导里那四格不跟这条:它一排两格、四格的形状本来就要一致
     (见 .wz-grid 的说明),所以仍旧是方框 + 竖幅完整放下,也不跨行。
     放在上面那两条之后 —— 特异性相同时靠先后定胜负 */
  .wz-grid .cell.is-portrait {
    grid-column: auto;
    grid-row: auto;
  }
  .wz-grid .cell.is-portrait :deep(.cell-img) {
    aspect-ratio: 1;
    width: 100%;
    height: auto;
    align-self: stretch;
  }
  .spec {
    grid-template-columns: 1fr;
    gap: 2px var(--sp-3);
  }
  .spec-v {
    margin-bottom: 8px;
  }
  /* 触控目标放大到 40px */
  .viewer-x,
  .viewer-nav {
    width: 40px;
    height: 40px;
  }
  /* 顶栏三枚动作在窄屏会挤:收一档内边距,别逼着它们换行 */
  .dt-act,
  .dt-del {
    padding: 6px 9px;
  }
}

</style>
