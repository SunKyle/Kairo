import { computed, ref, type Ref } from 'vue'
import { cloneVoice, emptyCharVoice, newVoiceId, TTS_AUDITION_TEXT } from '../api'
import { deleteVoiceSample, putVoiceSample } from '../lib/idb'
import { speak, speakingId, stopSpeaking } from '../lib/speech'
import type { ApiConfig, Character, CharacterVoice } from '../types'

/* ===== 嗓音：角色的声音本身 ==========================================
 *  「朗读时它听起来什么样」。与 persona 那组**文字**字段是两件事:
 *  那边管"话怎么说出来",这里管**声音**。
 *
 *  三种来源只在"voice 从哪来"上不同,合成请求的形状是一样的(见 api.ts 的
 *  synthesizeSpeech),所以界面上的分叉也只有那三行输入,底下走的是同一条路。
 *
 *  从 CharacterPage 抽出来(该页 5200 行,按 列表/详情/向导/嗓音 分块拆):
 *  这一块与页面其余部分只通过三样东西相连 —— 草稿里的 voice、正在编辑的角色 id、
 *  以及 TTS 配置。搬过来之后页面那侧只剩模板与几个调用点。
 *  ------------------------------------------------------------------ */

export interface CharacterVoiceDeps {
  /** 向导里正在编辑的那份草稿。这一块只碰它的 voice 一项 */
  draft: Ref<{ voice: CharacterVoice }>
  /** 正在编辑的角色 id。新建流程里它一开始是空的 ——
   *  试听走浏览器那条路时要拿它挑一个固定的嗓子(见 speak) */
  editingId: Ref<string>
  /* 这个角色设的语言(草稿里的 persona.language)。试听句是固定的中英各半,
     所以**必须**由外面告诉它这一栏是什么 —— 不然一个设成英语的角色,
     会照那句中文去挑一把中文嗓子。
     与 ttsConfig 一样给成取值函数,而不是把整份 persona 塞进来:
     这一块的边界是"只碰声音相关的那几项" */
  draftLanguage: () => string
  /* **惰性函数而不是值**:props 是可变的,传值等于把配置定格在 setup 那一刻;
     而"没配 TTS 时退回浏览器声音"这件事必须读当下的配置。
     (与 useCharacters 的 coverSize 同一条理由) */
  ttsConfig: () => ApiConfig | undefined
}

/** 三档的 hint 就是**选它之后要做什么** —— 用户站在这一排前面的问题只有一个:
 *  "我该选哪个、然后填什么"。所以每句都写成一句可执行的指路,不描述概念 */
export const VOICE_SOURCES = [
  {
    id: 'preset' as const,
    label: 'Built-in',
    hint: 'A stock voice from your provider. Paste its voice ID below — copy one from your provider’s voice library.'
  },
  {
    id: 'describe' as const,
    label: 'Describe',
    hint: 'No ID and no recording — write a line describing how it sounds and the model invents the voice. Nothing to prepare.'
  },
  {
    id: 'clone' as const,
    label: 'Clone',
    hint: 'A voice you made from a recording. Already have its ID? Paste it below. Don’t? Upload a recording instead.'
  }
]
export type VoiceSource = (typeof VOICE_SOURCES)[number]['id']

/** 样本上限与上游一致(10MB),这里收到 8MB。上限是对着 base64 定的 ——
 *  整份要过服务端那道 15mb 的 JSON 闸,而 base64 会涨到约 1.34 倍 */
const MAX_SAMPLE_BYTES = 8 * 1024 * 1024

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read that file'))
    reader.readAsDataURL(file)
  })
}

export function useCharacterVoice(deps: CharacterVoiceDeps) {
  function voiceSource(): VoiceSource {
    return deps.draft.value.voice.source || 'preset'
  }
  /* 当前那一档的指路语。以前这三个 hint 写好了却没接到界面上 */
  const voiceSourceHint = computed(
    () => VOICE_SOURCES.find((s) => s.id === voiceSource())?.hint || ''
  )
  function setVoiceSource(s: VoiceSource) {
    deps.draft.value.voice.source = s
  }
  /* 换引擎时把鉴权性质的那几个字段留着(改回来时不用重填),
     但**不自动建号**:该不该花钱是用户按下去的那一刻决定的,不是切一下开关就定的 */

  /* —— 试听 ——
     用的是**固定短句**(见 api.ts 的 TTS_AUDITION_TEXT)。用户每改一次描述都会点一次它,
     而每一次都是真请求 —— 同一句话配同一个音色在缓存里必然命中,所以从第二次起试听不花钱。
     这一条是整个功能里唯一能"边调边听"的入口,没有它音色就没法调 */
  const AUDITION_ID = 'voice-audition'
  const auditioning = computed(() => speakingId.value === AUDITION_ID)
  const voiceError = ref('')

  async function auditionVoice() {
    if (auditioning.value) {
      stopSpeaking()
      return
    }
    if (voiceSource() === 'preset' && !deps.draft.value.voice.vendorVoice?.trim()) {
      voiceError.value = 'Paste a voice ID from your provider console first.'
      return
    }
    /* 描述那一档只要一段描述 —— **不需要底子音色** */
    if (voiceSource() === 'describe' && !deps.draft.value.voice.describe?.trim()) {
      voiceError.value = 'Describe the voice first — that description is the whole voice.'
      return
    }
    if (voiceSource() === 'clone' && !deps.draft.value.voice.vendorVoice) {
      voiceError.value = 'Paste a cloned voice ID, or upload a recording to build one.'
      return
    }
    voiceError.value = ''
    const said = await speak(
      TTS_AUDITION_TEXT,
      // 没保存过的新角色拿一个临时的 charId:浏览器那条路要它来挑固定的嗓子
      {
        charId: deps.editingId.value || 'preview',
        voice: deps.draft.value.voice,
        // 试听句是固定的中英各半,所以**必须**告诉它这个角色设的是哪种语言 ——
        // 不然一个设成英语的角色会照那句中文去挑一把中文嗓子
        language: deps.draftLanguage(),
        cfg: deps.ttsConfig()
      },
      AUDITION_ID
    )
    // 退回浏览器声音是有原因的(没配、被拒、超时),那件事得说出来
    if (said) voiceError.value = said
  }

  /* —— 克隆 ——
     选一段录音,**顺手就把号建了**。为什么不拖到"保存"那一步:
     建号要几秒、还会被上游按套餐拒掉,放在保存里就变成"保存按钮卡几秒然后整份失败"。
     而按下文件那一刻建号,用户马上就能试听 —— 这才叫试。

     代价是"建了号又反悔":那段录音会留在库里没人认领(见 dropOrphanVoiceSample)。
     上游那个号留着不花钱 —— 上游是**首次拿它合成**才收音色槽位费 */
  const cloneBusy = ref(false)
  const cloneError = ref('')

  async function onVoiceSample(e: Event) {
    const el = e.target as HTMLInputElement
    const file = el.files?.[0]
    // 清空 input:同一个文件选第二次也要能触发 change
    el.value = ''
    if (!file) return
    if (!file.type.startsWith('audio/')) {
      cloneError.value = 'That file is not audio.'
      return
    }
    if (file.size > MAX_SAMPLE_BYTES) {
      cloneError.value = 'That recording is too large (max 8MB).'
      return
    }
    const cfg = deps.ttsConfig()
    if (!cfg) {
      cloneError.value = 'Add a Voice config in Settings first.'
      return
    }
    cloneBusy.value = true
    cloneError.value = ''
    try {
      const data = await readAsDataUrl(file)
      const id = newVoiceId()
      const out = await cloneVoice(cfg, data, id, file.name)
      /* 样本先落库、号后写进表单:号指着样本,反过来写的话,
         中途失败会留下一个指向不存在样本的号 */
      await putVoiceSample({
        id,
        name: file.name,
        blob: file,
        bytes: file.size,
        createdAt: Date.now()
      })
      const v = deps.draft.value.voice
      v.source = 'clone'
      v.vendorVoice = out.vendorVoice
      v.sampleId = id
      v.sampleName = file.name
    } catch (err) {
      cloneError.value = err instanceof Error ? err.message : 'Could not clone that voice'
    } finally {
      cloneBusy.value = false
    }
  }

  /* 这一轮里**已经存下去过**的样本 id。克隆是按下文件那一刻就落库的,
     所以"取消"必须分清两件事:这一段录音已经属于某个角色了,还是只是个草稿。
     光看 editingId 不够 —— 新建流程第一步存完之后 editingId 仍是空的 */
  let committedSampleId = ''

  /** 记下"这一段样本已经有主了"(保存表单时调用)。页面在 startEdit / submit /
   *  saveFromVoiceStep 三处调用它,语义都是"这份 voice 已经落到角色上了" */
  function markSampleCommitted(sampleId: string | undefined) {
    committedSampleId = sampleId || ''
  }

  /** 丢掉这一轮建出来、却没人认领的那段录音。
   *  留着它没有任何用处,而它是**用户的录音**,更该清掉 */
  async function dropOrphanVoiceSample() {
    const staged = deps.draft.value.voice.sampleId
    if (!staged || staged === committedSampleId) return
    deps.draft.value.voice.sampleId = undefined
    deps.draft.value.voice.sampleName = undefined
    await deleteVoiceSample(staged)
  }

  /** 手动改 Voice ID = 这个号是用户自己带进来的,与刚才可能上传过的那段录音无关。
   *  所以把指向样本的那两样撤掉:名字留着会显示成"这个号来自那段录音"(不实),
   *  而样本本身也没人认领了 —— 那是用户的录音,比占空间更该清掉。
   *
   *  已经保存过的样本不动(committedSampleId):编辑一个现有角色时,
   *  那份样本仍是它自己的,撤引用可以,删掉就越界了 */
  function onCloneIdTyped() {
    const v = deps.draft.value.voice
    if (!v.sampleId) return
    const stale = v.sampleId
    v.sampleId = undefined
    v.sampleName = undefined
    if (stale !== committedSampleId) void deleteVoiceSample(stale)
  }

  /** 详情页那份只读的嗓音摘要。空字段不摆出来 ——
   *  与 personaRows 同一条规矩,没填就是没填,不占一行 */
  function voiceRows(c: Character) {
    const v = { ...emptyCharVoice(), ...(c.voice || {}) }
    if (v.engine !== 'tts') return [{ label: 'Engine', value: 'Browser voice' }]
    const rows = [
      { label: 'Engine', value: 'Custom voice' },
      {
        label: 'Source',
        value:
          v.source === 'clone'
            ? v.sampleName
              ? 'Cloned from a recording'
              : 'Cloned voice'
            : v.source === 'describe'
              ? 'Described in words'
              : 'Built-in voice'
      }
    ]
    if (v.source === 'clone') {
      rows.push({ label: 'Voice ID', value: v.vendorVoice || '' })
      if (v.sampleName) rows.push({ label: 'Sample', value: v.sampleName })
    } else if (v.source === 'describe') {
      rows.push({ label: 'Description', value: v.describe || '' })
    } else {
      rows.push({ label: 'Voice ID', value: v.vendorVoice || '' })
    }
    return rows.filter((r) => r.value.trim())
  }

  /* 详情页也能试听:刚建好的角色,第一件想做的事就是听听它什么嗓子 */
  async function auditionChar(c: Character) {
    const id = `audition:${c.id}`
    if (speakingId.value === id) {
      stopSpeaking()
      return
    }
    const said = await speak(
      TTS_AUDITION_TEXT,
      { charId: c.id, voice: c.voice, language: c.persona?.language, cfg: deps.ttsConfig() },
      id
    )
    if (said) voiceError.value = said
  }

  return {
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
  }
}
