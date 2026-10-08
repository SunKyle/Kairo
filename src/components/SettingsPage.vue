<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  PhPlus,
  PhDotsThreeVertical,
  PhCaretRight,
  PhCheck,
  PhCheckCircle,
  PhWarningCircle,
  PhPlugsConnected,
  PhEye,
  PhEyeSlash
} from '@phosphor-icons/vue'
import BrandIcon from './BrandIcon.vue'
import { PROVIDERS, TEXT_PROVIDERS, VISION_PROVIDERS, TTS_GENERATIONS, TTS_MODELS, configKindOf, ttsGenerationOf, getProvider, inferVendor, testConnection } from '../api'
import type { ConfigKind, Provider, TextProvider, TestResult } from '../api'
import type { ApiConfig } from '../types'
// 浮层的公共行为(点外收起)
import { isInside, isInsideSelector } from '../lib/ui'

/* 接口设置:独立页面。
   骨架和提示词库、历史记录一致(标题行 → 内容),只是内容以表单为主。
   表单改的是自己的草稿副本,不直接写父级的「当前生效配置」——
   于是「返回列表」是真的放弃修改,而不是把半成品留在生效配置里。 */

const props = defineProps<{
  configs: ApiConfig[]
  /* 出图类别里当前生效那条的 id */
  activeId: string
  /* 提示词增强类别里当前生效那条的 id。与 activeId 各自独立:
     两类配置同在一个列表里,但「当前」是分开记的 */
  activeTextId: string
  /* 角色对话类别里当前生效那条的 id。它可能是空串 —— 没专配过对话模型时,
     对话借用改写那条(所以这一组在列表里也可能压根不出现) */
  activeChatId: string
  /* 识图类别里当前生效那条的 id。同理 —— 各类各记各的当前值 */
  activeVisionId: string
  /* 朗读类别里当前生效那条的 id。五类各记各的 */
  activeTtsId: string
  mode: 'list' | 'form'
  /* 编辑/复制的来源;null 表示新增空白 */
  seed: ApiConfig | null
  /* 当前生效接口的能力说明,由父级按生效配置算好传进来。
     不在这里按草稿算:参数栏的门控跟的是生效配置,说明文字必须跟它一致 */
  capabilityNote: string
}>()

const emit = defineEmits<{
  (e: 'activate', c: ApiConfig): void
  (e: 'activateText', c: ApiConfig): void
  (e: 'activateChat', c: ApiConfig): void
  (e: 'activateVision', c: ApiConfig): void
  (e: 'activateTts', c: ApiConfig): void
  (e: 'edit', c: ApiConfig): void
  (e: 'duplicate', c: ApiConfig): void
  (e: 'remove', c: ApiConfig): void
  /* seed 可选:空态里点某家厂商时带一份预填好的配置,标题行的「New config」不带 */
  (e: 'create', seed?: ApiConfig): void
  (e: 'cancel'): void
  (e: 'save', draft: ApiConfig): void
  (e: 'import', list: ApiConfig[]): void
}>()

/* 标题行那个导出/导入菜单的开关。和下面的行菜单是两件事:
   它不挂在某一行上,所以仍是一个布尔 */
const menuOpen = ref(false)
// 菜单展开后点别处收起:低频动作,不该逼用户再点一次 ⋮ 才能走
const menuEl = ref<HTMLElement | null>(null)

/* 行的溢出菜单:记住是哪一行开着,而不是一个布尔 ——
   列表里有很多行,一个布尔表达不了「这个菜单是给谁的」。
   同一时刻只开一个,切换行时旧的自动让位 */
const openRow = ref<string | null>(null)

// 密钥显隐:默认遮住。声明在灌草稿的 watch 之前 —— 那个 watch 是 immediate,会立刻用到它
const showKey = ref(false)

function onDocPointerDown(e: PointerEvent) {
  if (menuOpen.value && !isInside(e.target, menuEl.value)) menuOpen.value = false
  /* 行的菜单:点在菜单里、或点在触发它的 ⋮ 上都不收 —— 后者由那个按钮自己的点击去切换。
     这里按祖先类名判而不是拿一个 ref 存元素:菜单是随行渲染的,
     一个 ref 装不住多行,而类名判断天然只看当前这一棵子树 */
  if (openRow.value && !isInsideSelector(e.target, '.row-menu, .row-more')) {
    openRow.value = null
  }
}
onMounted(() => document.addEventListener('pointerdown', onDocPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown))

// 开/收某一行的菜单
function toggleRow(id: string) {
  openRow.value = openRow.value === id ? null : id
}

/* 删除:一次点击就删。原先要点两次是因为"删掉就没了",而现在删完有一条
   燃烧的撤销窗口兜着(见 UndoToast)—— 让它兜,比多一步确认更省事,也更可逆 */
function remove(c: ApiConfig) {
  openRow.value = null
  emit('remove', c)
}

// 换视图(列表 ↔ 表单)时收起行菜单:回到列表不该还开着上次那个菜单
watch(
  () => props.mode,
  () => {
    openRow.value = null
  }
)

function blank(): ApiConfig {
  // 新增默认做出图:绝大多数人的第一诉求是出图,文本配置是后来才补的
  return { id: '', name: '', baseUrl: '', apiKey: '', model: '', vendor: 'custom', kind: 'image' }
}

/* 表单校验:接口地址填错就完全发不出请求,所以提交前拦一下并说清原因。
   它在这份 setup 里声明得比较早,是因为下面那个灌草稿的 watch 会立刻跑一次
   (immediate),而它要顺手把上一条配置留下的红字清掉 */
const urlError = ref('')

// 灌草稿:seed 一变就重置一次,编辑、复制、新增都走这里
const draft = ref<ApiConfig>(blank())
watch(
  () => props.seed,
  (v) => {
    draft.value = v ? { ...v } : blank()
    /* 朗读档的 model 只认固定的两个值。"自由输入框"时代存下来的脏值在这里归零:
       留着它那排键一个都不亮(看起来像坏了),而它发出去只会换回一句 InvalidModel
       (服务端另有一道白名单兜底,见那边的 TTS_MODEL_VARIANTS) */
    if (draft.value.kind === 'tts' && !TTS_MODELS.some((m) => m.id === draft.value.model)) {
      draft.value.model = ''
    }
    // 换一条配置就把密钥收回去:上一条的显隐状态不该被带过来
    showKey.value = false
    /* 上一条的报错也跟着清掉:留着的话它会被挂在刚打开的这一条上,
       而那条配置本身没有任何问题(要等用户敲一下输入框才会消失) */
    urlError.value = ''
  },
  { immediate: true }
)

/* 草稿当前用途:老配置没有 kind 时按出图算。
   判断收到 api.ts 的 configKindOf 一处 —— 五类之后那串嵌套三元已经要数着缩进读,
   而"认不出来的算哪一类"本来就只该有一个答案 */
const purpose = computed<ConfigKind>(() => configKindOf(draft.value))

/* 模型名的归属:用途之间存在**同一条命名空间** ——
   改写 / 对话 / 识图都要一个能走 /chat/completions 的模型,同一个名字在这三者之间
   至少是个候选;而出图要的是图像模型名、朗读要的是固定的两个枚举值,
   跨过去必然是错的。所以"要不要清空模型"看的是这一层,不是用途本身。 */
function modelSpace(kind: ConfigKind): 'image' | 'chat' | 'tts' {
  return kind === 'image' ? 'image' : kind === 'tts' ? 'tts' : 'chat'
}

/* 切换用途:只切 kind 并换掉下面的预设行。
   已填的 baseUrl / apiKey 保留 —— 地址与密钥常常同源,用户可能刚填好,不该被清掉。

   模型名**只在换了命名空间时才清**:图像模型名拿去打 /chat/completions 必错,
   反过来也一样,留着只会让人以为还能用;而改写 ↔ 对话 ↔ 识图之间要填的是同一种东西,
   清掉它净是坑 —— 想"给对话单独配一条"的人,很自然的动作就是打开原来那条改写配置、
   把用途改成 Role chat,那时模型名被悄悄抹掉的话,存下来就是一条发不出请求的配置,
   而它在列表里照样顶着「Current」(报错还要等下一次开口才看得见)。
   跨了界就照旧清空:那种名字留在那儿才是真的误导 */
function setPurpose(kind: ConfigKind) {
  if (draft.value.kind === kind) return
  const from = modelSpace(purpose.value)
  draft.value.kind = kind
  if (modelSpace(kind) !== from) draft.value.model = ''
}

/* Provider 下面那一句说明。每一类打的端点不一样,而这是用户唯一能一眼看到
   "它会走哪条路"的地方,所以逐类写清楚。收成一处而不是模板里那串嵌套三元 ——
   五类之后那串已经要数着缩进读,而 capabilityNote 是父级按生效配置算好的 */
const purposeNote = computed(() => {
  switch (purpose.value) {
    case 'image':
      return props.capabilityNote
    case 'chat':
      return 'Chat models are called through /chat/completions — for the replies and for compressing long-term memory. For Bailian, pick the compatible-mode address.'
    case 'vision':
      return 'Vision models are called through /chat/completions with the image attached. For Bailian, pick the compatible-mode address.'
    case 'tts':
      return 'Speech is called through /api/v3/tts/… with an X-Api-Key header. It is billed per character, so the app caches every line it synthesises.'
    default:
      return 'Text models are called through /chat/completions. For Bailian, pick the compatible-mode address.'
  }
})

/* 对话模型预设:地址照写(高亮比的就是地址,它在这里是身份),模型只补空 ——
   已填的模型名常常是对着某家中转写的别名,不该被预设冲掉。
   vendor 也要写下去:它本来只在出图那条路上被写,于是文本配置的 vendor 一直
   是 add() 给的 'custom',从 DeepSeek 换成 OpenAI 也照样顶着「接线」图标。
   改写、对话、识图三类同构,共用这一个函数(预设行不同,填法一样) */
function applyTextProvider(p: TextProvider) {
  draft.value.vendor = p.id
  draft.value.baseUrl = p.baseUrl
  if (!draft.value.model.trim() && p.model) draft.value.model = p.model
}

/* 高亮当前地址命中哪个预设:草稿里没有 vendor 字段,直接比地址,
   省得为了高亮再存一个状态。尾斜杠与大小写不该影响判断。
   文本与识图两份预设各查各的 —— 同一条地址(如 OpenAI)在两张表里都有,
   比地址就够了,不必区分是谁调用的 */
function presetOn(p: TextProvider) {
  const norm = (u: string) => (u || '').trim().replace(/\/+$/, '').toLowerCase()
  return norm(draft.value.baseUrl) === norm(p.baseUrl)
}

/* 选厂商:只写身份字段(vendor),已填的地址与模型一律不动 ——
   换厂商常常只是想换个能力表或协议,而地址多半是自己粘的中转或自建接口,
   被预设顺手覆盖掉就得重新找一遍。
   空着的字段才用预设补上("只补空,不覆盖"),这样新开一张空白表单仍然少填两格。
   注意与"新增配置"空态那四条入口区分:那条路走 seedFor,直接给一张填好的表,
   是"从零开始"的语义,不受这里约束。 */
function applyProvider(p: Provider) {
  draft.value.vendor = p.id
  if (!draft.value.baseUrl.trim() && p.baseUrl) draft.value.baseUrl = p.baseUrl
  if (!draft.value.model.trim() && p.model) draft.value.model = p.model
}

/* 朗读目前只接了一家:火山引擎(豆包语音)。它**不是** OpenAI 兼容那套 ——
   路径是 /api/v3/tts/...,鉴权走 X-Api-Key,而且还要一个 Resource-Id,
   所以它自成一档,不并进上面那几张预设表。
   地址只补空,和别处的规矩一样:用户可能已经粘了自己那条中转 */
const TTS_PRESET = {
  id: 'volc',
  label: 'Volcano Engine (Doubao)',
  baseUrl: 'https://openspeech.bytedance.com/api/v3',
  // 存的是**代际**,不是商品 —— 商品由角色那边按档位决定(见 api.ts 的 TTS_GENERATIONS)
  resourceId: '2.0'
}

function applyTtsPreset() {
  draft.value.vendor = TTS_PRESET.id
  if (!draft.value.baseUrl.trim()) draft.value.baseUrl = TTS_PRESET.baseUrl
  if (!draft.value.resourceId) draft.value.resourceId = TTS_PRESET.resourceId
}

/* 代际那一排的选中判断。配置里存的是"2.0",但老配置留下的是完整 ID
   (seed-tts-1.0 之类)—— 两种都要能对上,否则打开旧配置时那一排一个都不亮,
   看起来像坏了(见 api.ts 的 ttsGenerationOf) */
function generationOn(id: string) {
  return ttsGenerationOf(draft.value.resourceId) === id
}

function submit() {
  const url = draft.value.baseUrl.trim()
  if (!url) {
    // 只说「必填」用户还是不知道填什么,所以原因和建议一起给
    urlError.value = 'No Base URL yet — paste the endpoint your provider gave you, e.g. https://api.openai.com/v1'
    return
  }
  let ok = false
  try {
    const u = new URL(url)
    ok = (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    ok = false
  }
  if (!ok) {
    urlError.value = 'This is not a valid http(s) URL — it must start with http:// or https://'
    return
  }
  urlError.value = ''
  /* 密钥与模型名也顺手去掉首尾空白 —— 手机键盘在粘贴 / 自动补全之后
     很容易留下一截空格或换行,肉眼看不见,而上游只会回一个 401。
     这一下不动内容,只剪掉那两条看不见的边 */
  emit('save', {
    ...draft.value,
    baseUrl: url,
    apiKey: draft.value.apiKey.trim(),
    model: draft.value.model.trim()
  })
}

/* 连通性测试。结果只对"当前这一版草稿"有效:改任何一个字段它都可能不再成立,
   所以草稿一动就清掉 —— 留着上一次的 "Connected" 会让人以为新地址也验过了 */
const testing = ref(false)
const testResult = ref<{ ok: boolean; text: string; detail?: string } | null>(null)
watch(
  () => [draft.value.baseUrl, draft.value.apiKey, draft.value.model, draft.value.vendor, draft.value.kind],
  () => {
    testResult.value = null
  }
)

/* 判决翻成人话。服务端只回 ok / code / status 这些机器可读的东西,
   怎么说由这里定 —— 与生图那条路同一套分工 */
function testMessage(r: TestResult, model: string): { text: string; detail?: string } {
  // 局域网或本地中转常常几十毫秒就回来了,写成 "0.0s" 会显得没测一样
  const took = r.ms < 1000 ? `${r.ms} ms` : `${(r.ms / 1000).toFixed(1)}s`
  if (r.ok) {
    /* 走 /models 那次能多说一句:模型在不在它的清单里。
       不在也不算失败 —— 清单常常是列不全的,所以只在中性色里提一句,
       并写明生成仍然可能可用,免得用户跑去改一个本来没问题的配置 */
    if (r.via === 'models' && r.modelListed === true) {
      return { text: `Connected in ${took} · ${model} is available` }
    }
    if (r.via === 'models' && r.modelListed === false) {
      return {
        text: `Connected in ${took} · the key works, but the list has no ${model}`,
        detail:
          'Some endpoints publish only part of their catalog. Generation can still work — this is just what /models reported.'
      }
    }
    return { text: `Connected in ${took}` }
  }
  if (r.code === 'auth') return { text: `The endpoint rejected the key (${r.status})`, detail: r.detail }
  if (r.code === 'endpoint')
    return { text: `No such endpoint at this address (${r.status})`, detail: r.detail }
  if (r.code === 'timeout') return { text: 'No response within 15s', detail: r.detail }
  if (r.code === 'server') {
    /* 200 也走到这里:地址少了 /v1 这类前缀时,网站会把首页当作 200 回给你。
       那时说 "answered 200" 只会让人困惑 */
    return {
      text:
        r.status && r.status < 400
          ? 'Answered with a web page instead of an API response'
          : `Reachable, but it answered ${r.status}`,
      detail: r.detail
    }
  }
  return { text: 'Could not reach the endpoint', detail: r.detail }
}

/* 表单是否还是发起测试时那一份。比的就是上面那个 watch 盯着的几项 ——
   它们任意一项变了,这次测试的结论就不再对应当前表单 */
function sameDraft(snap: ApiConfig) {
  const d = draft.value
  return (
    d.baseUrl.trim() === snap.baseUrl.trim() &&
    d.apiKey === snap.apiKey &&
    d.model === snap.model &&
    d.vendor === snap.vendor &&
    d.kind === snap.kind
  )
}

/* 测试请求的代次。用户可能在等待中改了草稿、切到另一条配置、
   或干脆再点一次 —— 那几次的结论混在一起,就会出现"测的是 A,提示却说 B 可用"。
   只认最后一次发起的那个结果 */
let testSeq = 0

async function runTest() {
  const url = draft.value.baseUrl.trim()
  // 地址是测试的前提,空着就没必要往后走 —— 与保存同一句提示
  if (!url) {
    urlError.value =
      'No Base URL yet — paste the endpoint your provider gave you, e.g. https://api.openai.com/v1'
    return
  }
  urlError.value = ''
  const seq = ++testSeq
  testing.value = true
  testResult.value = null
  /* 快照这一趟测的到底是哪一份草稿:提示语与请求体都照它来,
     不能等回来的时候再读 draft —— 那时它可能已经是另一条配置了 */
  const snap = { ...draft.value, baseUrl: url }
  try {
    const r = await testConnection(snap)
    if (seq !== testSeq || !sameDraft(snap)) return
    testResult.value = { ok: r.ok, ...testMessage(r, (snap.model || '').trim()) }
  } finally {
    // 只有还是最后一次才放下 loading:新一轮已经在跑时别把它关掉
    if (seq === testSeq) testing.value = false
  }
}

/* 配置的厂商:老配置没写 vendor 就按域名猜,和主页面用的是同一套推断。
   文本与识图那两类配置多一步:那两条路以前不写 vendor(字段是后加的),
   旧数据里它是 'custom',直接信它的话,DeepSeek 那类配置会一直顶着「接线」图标 ——
   所以这种值不可信,按域名认一次。出图配置不动:那里的 custom 是用户明确选的 */
function vendorId(c: ApiConfig) {
  if (c.kind !== 'image' && c.kind && (!c.vendor || c.vendor === 'custom')) {
    const guess = inferVendor(c.baseUrl)
    if (guess !== 'custom') return guess
  }
  return c.vendor || inferVendor(c.baseUrl)
}

/* 厂商名。预设是三份表 —— 出图的 PROVIDERS、对话的 TEXT_PROVIDERS(改写与
   角色对话共用,两者要的就是同一种模型)与识图的 VISION_PROVIDERS,
   DeepSeek 只做对话所以不进第一份。
   三边都查一遍,再退回能力表兜底 */
function providerLabel(id: string) {
  const p =
    PROVIDERS.find((x) => x.id === id) ||
    TEXT_PROVIDERS.find((x) => x.id === id) ||
    VISION_PROVIDERS.find((x) => x.id === id)
  return (p || getProvider(id)).label
}
function vendorLabel(c: ApiConfig) {
  return providerLabel(vendorId(c))
}

/* 模型在前、厂商在后合成一句。
   顺序有讲究:截断只会发生在末尾,所以把更重要的放前面 ——
   模型是这条配置真正发出去的东西,厂商从模型名和地址基本能看出来。

   模型名空着时**把这件事写出来**(tts 例外:它那一档本来就是可选的 Auto)。
   不写的话这一行会只剩下厂商名,看上去和"配好了"没有区别 ——
   而"我明明配了,它却说没配"正是从这里开始的 */
function identLine(c: ApiConfig) {
  const missing = !c.model.trim() && configKindOf(c) !== 'tts'
  return [missing ? 'No model name' : c.model, vendorLabel(c)].filter(Boolean).join(' · ')
}

/* 地址只显示主机名 + 路径:https:// 这种前缀在窄行里最先被吃掉,
   而"这是哪个服务"靠的恰恰是后面那截。
   空态的入口也复用它渲染"会替你填好什么" */
function endpointLine(url: string) {
  try {
    const u = new URL(url)
    return u.host + u.pathname.replace(/\/$/, '')
  } catch {
    return url
  }
}

/* 列表按用途分五组渲染:各组各自判「当前」(出图比 activeId,改写比 activeTextId,
   对话比 activeChatId,识图比 activeVisionId,朗读比 activeTtsId),所以把组连同
   判据一起列成数据,模板里只写一份行。空组直接滤掉,不渲染。
   分组按用途正面认(configKindOf),不再写成一串 `!== ...` —— 那种写法每加一类
   就要补一笔,而漏掉的那一类会被并入出图那一组(tts 就这么漏过一次) */
const groups = computed(() =>
  [
    {
      key: 'image',
      label: 'Image generation',
      items: props.configs.filter((c) => configKindOf(c) === 'image'),
      activeId: props.activeId,
      on: (c: ApiConfig) => emit('activate', c)
    },
    /* 对话排在出图之后:它是这一站的第二条主线(造一个角色,然后跟它说话),
       而改写与识图都是围着出图转的辅助 */
    {
      key: 'chat',
      label: 'Role chat',
      items: props.configs.filter((c) => configKindOf(c) === 'chat'),
      activeId: props.activeChatId,
      on: (c: ApiConfig) => emit('activateChat', c)
    },
    {
      key: 'text',
      label: 'Prompt enhancing',
      items: props.configs.filter((c) => configKindOf(c) === 'text'),
      activeId: props.activeTextId,
      on: (c: ApiConfig) => emit('activateText', c)
    },
    {
      key: 'vision',
      label: 'Image recognition',
      items: props.configs.filter((c) => configKindOf(c) === 'vision'),
      activeId: props.activeVisionId,
      on: (c: ApiConfig) => emit('activateVision', c)
    },
    {
      key: 'tts',
      label: 'Voice',
      items: props.configs.filter((c) => configKindOf(c) === 'tts'),
      activeId: props.activeTtsId,
      on: (c: ApiConfig) => emit('activateTts', c)
    }
  ].filter((g) => g.items.length)
)

// 表单标题:新增还是编辑,保持英文文案
const section = computed(() => (draft.value.id ? 'Edit config' : 'New config'))

/* 空态的四条入口:前三条从厂商表里取(跳过兜底的 custom)。
   地址、模型、名称全部由它推导 —— 厂商表改地址时这里不会漏掉,
   也不该在界面里再抄一份地址 */
const quickPicks = PROVIDERS.filter((p) => p.id !== 'custom').slice(0, 3)

// 点某家厂商 = 开一张已经填好的表单,只差一个 key。id 留空,由父级落库时再生成
function seedFor(p: Provider): ApiConfig {
  return {
    id: '',
    name: p.label,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: '',
    vendor: p.id,
    kind: 'image'
  }
}

// 入口副标题:会替你填好的地址与模型
function quickHint(p: Provider) {
  return `Fills ${endpointLine(p.baseUrl)} · ${p.model}`
}

/* 识图的入口。空态也得给一条 —— 没有它,新用户会把出图那条当成全部,
   直到在角色页上传了参考图才发现"反填"用不了。
   与 seedFor 同一套,只是 kind 不同 */
function visionSeedFor(p: TextProvider): ApiConfig {
  return {
    id: '',
    name: p.label,
    baseUrl: p.baseUrl,
    model: p.model || '',
    apiKey: '',
    vendor: p.id,
    kind: 'vision'
  }
}

/* 导出把配置原样写成 JSON —— 包括 API Key。
   不带 Key 的备份没有意义(换台机器导回去还是要一条条补),
   所以菜单上直接把这件事写明白,别让人以为导出的是脱敏版本 */
function exportJson() {
  menuOpen.value = false
  const blob = new Blob([JSON.stringify(props.configs, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `kairo-configs-${Date.now()}.json`
  a.click()
  // 立刻 revoke 在 WebKit 下偶尔会把下载掐断,等浏览器把文件接走再撤
  setTimeout(() => URL.revokeObjectURL(a.href), 1500)
}

// 只负责读文件:内容是不是配置由主界面规整(它才知道现有 id 有哪些)
function onImportFile(e: Event) {
  menuOpen.value = false
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const arr = JSON.parse(String(reader.result))
      if (Array.isArray(arr)) emit('import', arr)
    } catch {
      /* 选错了文件就当作没选,不打断 */
    }
  }
  reader.readAsText(file)
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <section class="pg" aria-label="API settings">
    <header class="pg-head">
      <!-- 页面名不在这儿写第二遍:顶部横条的字标已经在说"Settings"。
           这里留的是这一页特有的说明 —— 它跟哪类接口配合、数据放在哪 -->
      <p class="pg-sub">Works with any OpenAI-compatible API. Configs are stored locally and never uploaded.</p>
      <div v-if="mode === 'list'" class="pg-ops">
        <button class="pg-new" @click="emit('create')">
          <PhPlus aria-hidden="true" />
          New config
        </button>
        <!-- 导入导出低频,收进菜单,不给标题行添按钮 -->
        <span ref="menuEl" class="menu-wrap">
          <button class="icon-ghost" :aria-expanded="menuOpen" aria-label="More" @click="menuOpen = !menuOpen">
            <PhDotsThreeVertical weight="bold" aria-hidden="true" />
          </button>
          <Transition name="po">
            <div v-if="menuOpen" class="menu">
              <!-- 导出不脱敏,菜单上就写明:这是给备份/迁移用的 -->
              <button class="mitem" @click="exportJson">Export JSON (includes key)</button>
              <label class="mitem file">
                Import configs
                <input type="file" accept=".json" hidden @change="onImportFile" />
              </label>
            </div>
          </Transition>
        </span>
      </div>
    </header>

    <!-- 列表铺满内容区:行内的 Current 徽标与行菜单因此贴到两缘,像一张完整的
         设置纸(历史页、提示词库页也都是铺满的)。表单另说 —— 单行输入拉到
         900px 宽会读得很散,所以它收窄并居中 -->
    <div class="pg-wrap" :class="{ 'is-form': mode === 'form' }">
      <!-- ===== 视图一:已保存的接口列表 ===== -->
      <template v-if="mode === 'list'">
        <!-- 一整张纸包住所有分组:主页的容器语言是「浮在纸上的柔光」,
             不再是一格一格的卡片。分组只用一条两端留空的细线分开。
             纸不设 overflow: hidden —— 行内的溢出菜单要能浮到纸外 -->
        <div v-if="groups.length" class="sheet">
          <div class="list">
            <div v-for="g in groups" :key="g.key" class="group">
              <div class="group-label"><b>{{ g.label }}</b> · {{ g.items.length }}</div>

              <div
                v-for="c in g.items"
                :key="c.id"
                class="row"
                :class="{ 'is-current': c.id === g.activeId, 'is-open': openRow === c.id }"
              >
                <!-- 行本体是 <button>:整行可点 = 把这条设为该类别的当前生效。
                     动作随组带着走(见 groups),不在这里按 key 再分一次类 ——
                     五类之后那串嵌套三元已经读不出谁是谁。
                     状态列定宽,于是所有行的名字都从同一条竖线起排 -->
                <button
                  class="row-main-btn"
                  :aria-current="c.id === g.activeId ? 'true' : undefined"
                  @click="g.on(c)"
                >
                  <span class="dot-col">
                    <span v-if="c.id === g.activeId" class="pill-current"><i aria-hidden="true"></i>Current</span>
                  </span>
                  <span class="row-main">
                    <span class="row-name">
                      <BrandIcon :brand="vendorId(c)" />
                      <span class="nm">{{ c.name || 'Untitled config' }}</span>
                    </span>
                    <!-- 地址不再出现在列表里:编辑表单里本来就有完整地址 -->
                    <span class="row-sub">{{ identLine(c) }}</span>
                  </span>
                </button>

                <!-- 常态隐去,行 hover / 聚焦时显形 ——
                     三个常驻的方形图标键正是「管理后台」味道的来源 -->
                <button
                  class="row-more"
                  :aria-label="`Actions for ${c.name || 'Untitled config'}`"
                  aria-haspopup="menu"
                  :aria-expanded="openRow === c.id"
                  @click="toggleRow(c.id)"
                >
                  <PhDotsThreeVertical weight="bold" aria-hidden="true" />
                </button>

                <Transition name="po">
                  <!-- 用 role=group 而不是 menu:menu 在 ARIA 里承诺方向键导航,
                       这里只有 Tab,声明成 menu 等于许了做不到的事 -->
                  <div
                    v-if="openRow === c.id"
                    class="row-menu"
                    role="group"
                    :aria-label="`Actions for ${c.name || 'Untitled config'}`"
                  >
                    <button class="mitem" @click="openRow = null; emit('edit', c)">Edit</button>
                    <button class="mitem" @click="openRow = null; emit('duplicate', c)">
                      Duplicate
                    </button>
                    <button class="mitem danger" @click="remove(c)">Delete</button>
                  </div>
                </Transition>
              </div>
            </div>
          </div>
        </div>

        <!-- 空态:不是「什么都没有」,而是四条能一键预填的入口 -->
        <div v-else class="sheet">
          <div class="empty">
            <h2>Add your first API</h2>
            <p class="empty-sub">
              Pick a provider and the address and model get filled in for you. You only need to paste your key.
            </p>

            <div class="quick">
              <button
                v-for="p in quickPicks"
                :key="p.id"
                class="quick-item"
                @click="emit('create', seedFor(p))"
              >
                <span class="qm">
                  <b>
                    <BrandIcon :brand="p.id" :size="15" />
                    {{ p.label }}
                  </b>
                  <span>{{ quickHint(p) }}</span>
                </span>
                <span class="go"><PhCaretRight aria-hidden="true" /></span>
              </button>
              <button class="quick-item" @click="emit('create')">
                <span class="qm">
                  <b>
                    <BrandIcon brand="custom" :size="15" />
                    My own endpoint
                  </b>
                  <span>Any OpenAI-compatible base URL</span>
                </span>
                <span class="go"><PhCaretRight aria-hidden="true" /></span>
              </button>
            </div>

            <!-- 识图那类单独起一排:它解决的是另一个问题(把上传的参考图读成角色设定),
                 与"出图用哪家"不是同一件事,混在同一排里会被当成又一个出图选项 -->
            <p class="quick-sep">
              Or add a vision model — it reads an uploaded reference image into a character spec.
            </p>
            <div class="quick">
              <button
                v-for="p in VISION_PROVIDERS"
                :key="p.id"
                class="quick-item"
                @click="emit('create', visionSeedFor(p))"
              >
                <span class="qm">
                  <b>
                    <BrandIcon :brand="p.id" :size="15" />
                    {{ p.label }}
                  </b>
                  <span>{{ endpointLine(p.baseUrl) }} · {{ p.model }}</span>
                </span>
                <span class="go"><PhCaretRight aria-hidden="true" /></span>
              </button>
            </div>

            <p class="empty-foot">Your key stays in this browser. Nothing is sent anywhere except your own API.</p>
          </div>
        </div>
      </template>

      <!-- ===== 视图二:新增/编辑接口表单 ===== -->
      <form v-else class="sheet" @submit.prevent="submit">
        <div class="form-head">
          <h2>{{ section }}</h2>
          <p>Only Base URL is required. Everything else can stay as the preset filled it.</p>
        </div>

        <div class="form-body">
          <div class="block">
            <!-- 用途:这条配置用来出图、跟角色对话、改写提示词还是识图。它决定后面所有
                 字段的含义,所以给几行带说明的选项,而不是一排只有名字的胶囊 -->
            <span class="block-label">What is this config for?</span>
            <div class="purpose" role="radiogroup" aria-label="Config purpose">
              <label class="purpose-opt">
                <input
                  type="radio"
                  name="purpose"
                  :checked="purpose === 'image'"
                  @change="setPurpose('image')"
                />
                <span class="pm">
                  <b>Image generation</b>
                  <span>Used when you press Generate. Fill in an image model.</span>
                </span>
                <span class="tick" aria-hidden="true"><PhCheck /></span>
              </label>
              <!-- 对话与改写用的是同一种模型(都走 /chat/completions),但**要分开配**:
                   改写那个是"怎么把一句话写得这家模型爱看",对话那个是"聊起来像不像个人",
                   两个诉求不同,合在一格就得彼此迁就。所以给这一条独立的用途 -->
              <label class="purpose-opt">
                <input
                  type="radio"
                  name="purpose"
                  :checked="purpose === 'chat'"
                  @change="setPurpose('chat')"
                />
                <span class="pm">
                  <b>Role chat</b>
                  <span>How characters reply, and how long-term memory gets compressed.</span>
                </span>
                <span class="tick" aria-hidden="true"><PhCheck /></span>
              </label>
              <label class="purpose-opt">
                <input
                  type="radio"
                  name="purpose"
                  :checked="purpose === 'text'"
                  @change="setPurpose('text')"
                />
                <span class="pm">
                  <b>Prompt enhancing</b>
                  <span>Used by Quick / Creative. Fill in a chat model.</span>
                </span>
                <span class="tick" aria-hidden="true"><PhCheck /></span>
              </label>
              <label class="purpose-opt">
                <input
                  type="radio"
                  name="purpose"
                  :checked="purpose === 'vision'"
                  @change="setPurpose('vision')"
                />
                <span class="pm">
                  <b>Image recognition</b>
                  <span>Fills a character spec from a reference image. Needs a vision model.</span>
                </span>
                <span class="tick" aria-hidden="true"><PhCheck /></span>
              </label>
              <label class="purpose-opt">
                <input
                  type="radio"
                  name="purpose"
                  :checked="purpose === 'tts'"
                  @change="setPurpose('tts')"
                />
                <span class="pm">
                  <b>Voice</b>
                  <span>Reads a character's replies out loud in its own voice. Not OpenAI-compatible.</span>
                </span>
                <span class="tick" aria-hidden="true"><PhCheck /></span>
              </label>
            </div>
          </div>

          <div class="block">
            <span class="block-label">Provider</span>
            <!-- 预设随用途切换数据源:出图用图像模型预设,对话与改写共用对话模型预设
                 (两者要的就是同一种模型),识图用视觉模型预设(后三份都是
                 /chat/completions,只是模型要求不同) -->
            <div class="presets" role="group" aria-label="Select provider">
              <template v-if="purpose === 'image'">
                <button
                  v-for="p in PROVIDERS"
                  :key="p.id"
                  type="button"
                  class="preset"
                  :class="{ on: (draft.vendor || 'custom') === p.id }"
                  @click="applyProvider(p)"
                >
                  <BrandIcon :brand="p.id" :size="14" />
                  {{ p.label }}
                </button>
              </template>
              <template v-else-if="purpose === 'vision'">
                <button
                  v-for="p in VISION_PROVIDERS"
                  :key="p.id"
                  type="button"
                  class="preset"
                  :class="{ on: presetOn(p) }"
                  @click="applyTextProvider(p)"
                >
                  <BrandIcon :brand="p.id" :size="14" />
                  {{ p.label }}
                </button>
              </template>
              <template v-else-if="purpose === 'tts'">
                <!-- 朗读只有一家,而且它不是 OpenAI 兼容那套,所以这里不放"厂商表",
                     就这一枚。点它是一种"从零开始"的填法,地址与 Resource-Id 一起补齐 -->
                <button
                  type="button"
                  class="preset"
                  :class="{ on: draft.vendor === TTS_PRESET.id }"
                  @click="applyTtsPreset"
                >
                  <BrandIcon :brand="TTS_PRESET.id" :size="14" />
                  {{ TTS_PRESET.label }}
                </button>
              </template>
              <template v-else>
                <button
                  v-for="p in TEXT_PROVIDERS"
                  :key="p.id"
                  type="button"
                  class="preset"
                  :class="{ on: presetOn(p) }"
                  @click="applyTextProvider(p)"
                >
                  <BrandIcon :brand="p.id" :size="14" />
                  {{ p.label }}
                </button>
              </template>
            </div>
            <p class="note">{{ purposeNote }}</p>

            <label class="field">
              <span class="flabel">Name <em>— optional</em></span>
              <span class="input-wrap">
                <input
                  v-model="draft.name"
                  placeholder="e.g. Doubao primary / Tongyi backup"
                  spellcheck="false"
                />
              </span>
            </label>

            <label class="field" :class="{ 'has-err': urlError }">
              <span class="flabel">Base URL</span>
              <span class="input-wrap">
                <input
                  v-model="draft.baseUrl"
                  placeholder="https://example.com/api/v3"
                  autocapitalize="off" autocorrect="off" spellcheck="false"
                  :aria-invalid="!!urlError"
                  :aria-describedby="urlError ? 'cfg-url-err' : undefined"
                  @input="urlError = ''"
                />
              </span>
              <!-- 报错顶掉说明行,不叠成两段小字:错误已经把该填什么说清楚了。
                   role="alert":它是异步判定出来的(提交时才出现),读屏要主动念出来 -->
              <span v-if="urlError" id="cfg-url-err" class="field-err" role="alert">{{ urlError }}</span>
              <span v-else-if="purpose === 'tts'" class="note">
                Stop at the version segment — <code>…/api/v3</code>. Pasting the full endpoint URL
                from the docs works too.
              </span>
              <span v-else class="note">
                Include everything up to and including the version segment, e.g. <code>/api/v3</code>. No trailing
                slash needed.
              </span>
            </label>

            <label class="field field-key">
              <span class="flabel">API Key</span>
              <span class="input-wrap">
                <input
                  v-model="draft.apiKey"
                  :type="showKey ? 'text' : 'password'"
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  placeholder="sk-…  (optional for local services)"
                />
                <button
                  type="button"
                  class="reveal"
                  :aria-label="showKey ? 'Hide key' : 'Show key'"
                  :aria-pressed="showKey"
                  @click="showKey = !showKey"
                >
                  <PhEyeSlash v-if="showKey" aria-hidden="true" />
                  <PhEye v-else aria-hidden="true" />
                </button>
              </span>
              <span class="note">Stored in this browser only. Check your provider's console for where to create one.</span>
            </label>

            <!-- 音色代际。它决定两件事:**去哪一本音色列表里挑 ID**,以及那笔请求算在
                 哪个商品上 —— 而"商品"那一半其实由角色那边的档位定死了(内置音色必然
                 走语音合成、复刻音色必然走声音复刻),所以这里只需要选代际,
                 完整的 X-Api-Resource-Id 由代码拼(见 api.ts 的 resourceIdOf)。
                 以前这一格叫 Resource ID、让用户直接挑商品,于是同一格里塞了两件事,
                 界面上摆四个选项而其中两个对 Clone 档根本不起作用 -->
            <div v-if="purpose === 'tts'" class="field">
              <span class="flabel">Voice generation</span>
              <div class="presets" role="group" aria-label="Select generation">
                <button
                  v-for="g in TTS_GENERATIONS"
                  :key="g.id"
                  type="button"
                  class="preset"
                  :class="{ on: generationOn(g.id) }"
                  @click="draft.resourceId = g.id"
                >
                  {{ g.label }}
                </button>
              </div>
              <span class="note">
                Which generation of voices you use. Built-in voices then go out as
                <code>seed-tts-*</code> and cloned ones as <code>seed-icl-*</code> — that
                half is decided by the voice source on the character, not here. Voices are
                not interchangeable across generations: a 2.0 voice with 1.0 selected is
                refused by the provider.
              </span>
            </div>

            <!-- 朗读这一档的 Model **不是自由字段**:上游只认两个取值,填别的
                 会被回一句 InvalidModel —— 而那句话既不说是哪个字段、也不说合法值
                 (见 api.ts 的 TTS_MODELS)。所以照 Resource ID 那样做成一排可点的键 -->
            <div v-if="purpose === 'tts'" class="field">
              <span class="flabel">Model <em>— optional</em></span>
              <div class="presets" role="group" aria-label="Select model">
                <button
                  v-for="m in TTS_MODELS"
                  :key="m.label"
                  type="button"
                  class="preset"
                  :class="{ on: draft.model === m.id }"
                  @click="draft.model = m.id"
                >
                  {{ m.label }}
                </button>
              </div>
              <span class="note">
                Only cloned voices use this — Standard or Expressive. Auto leaves it to the
                provider. Nothing else is accepted here.
              </span>
            </div>

            <label v-else class="field">
              <span class="flabel">Model</span>
              <span class="input-wrap">
                <input
                  v-model="draft.model"
                  :placeholder="
                    purpose === 'image' ? 'doubao-seedream-3-0-t2i' : 'gpt-4o-mini'
                  "
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                />
              </span>
              <!-- 空着模型名时**当场说清后果**。它仍然可以存(本地服务或自建中转
                   未必用得上这个名字,所以不拦提交),但存下去等于存了一条发不出请求的
                   配置 —— 而它在列表里照样顶着「Current」,用户要到下次开口问它才撞上。
                   那一下撞出来的还是上游/服务端的一句话,跟"是我这儿填漏了"对不上号 -->
              <span v-if="!draft.model.trim()" class="field-warn">
                Without a model name this config cannot send anything — paste the model ID
                your provider gave you.
              </span>
              <span v-else class="note">
                The model ID your API expects — for some providers this is an endpoint ID like ep-2024….
              </span>
            </label>
          </div>

          <div class="form-foot">
            <button class="btn-ink" type="submit">Save</button>
            <!-- 朗读这条不给"测试":测试要知道打哪个端点、发什么请求,
                 而合成的最小请求必须带一个音色 —— 音色是角色的东西,不在这一页。
                 硬测只会打一条不存在的 /chat/completions,回一句误导人的错。
                 真正该验的时候是角色页那枚"试听",那才是端到端 -->
            <button
              v-if="purpose !== 'tts'"
              class="btn-line"
              type="button"
              :disabled="testing"
              @click="runTest"
            >
              <PhPlugsConnected aria-hidden="true" />
              {{ testing ? 'Testing…' : 'Test' }}
            </button>
            <button class="btn-line" type="button" @click="emit('cancel')">Cancel</button>
            <!-- 测出来的结果顶掉常驻那行提示:它更要紧,而且草稿一改就消失,
                 不会长期占着位置。role="status":结果是几秒后才回来的,
                 写在原地读屏不会知道 —— 这一句让它被念出来 -->
            <span
              v-if="testResult"
              class="test-line"
              :class="testResult.ok ? 'ok' : 'bad'"
              role="status"
            >
              <PhCheckCircle v-if="testResult.ok" aria-hidden="true" />
              <PhWarningCircle v-else aria-hidden="true" />
              <b>{{ testResult.text }}</b>
              <i v-if="testResult.detail" :title="testResult.detail">{{ testResult.detail }}</i>
            </span>
            <span v-else class="hint">Saved configs appear in the list — one click to make one current.</span>
          </div>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
/* 页面骨架:与提示词库、历史记录同一套规格 */
.pg-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  padding-top: var(--sp-2);
}
.pg-sub {
  margin-top: 6px;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
/* 与提示词库的「New prompt」同款:黑药丸,标题行主操作 */
.pg-new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
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
.pg-new svg {
  width: 16px;
  height: 16px;
}
.pg-new:hover {
  background: var(--cta-hover);
}
.pg-ops {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 标题行上的次要动作:和提示词库的 ⋮ 按钮同一套 */
.icon-ghost {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  background: var(--surface);
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.icon-ghost svg {
  width: 15px;
  height: 15px;
}
.icon-ghost:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
/* 导入导出低频,收进菜单,不给标题行添按钮 */
.menu-wrap {
  position: relative;
  display: inline-flex;
}
.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 6;
  /* 比提示词库那个略宽:这一项要把「含 Key」写进去 */
  min-width: 172px;
  padding: var(--sp-1);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: var(--sh-md);
}
.mitem {
  padding: 8px 10px;
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text-2);
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.mitem:hover {
  background: var(--bg-elev);
  color: var(--text);
}
/* 行菜单里的删除:中性色里唯一的红,和编辑/复制区分开 */
.mitem.danger {
  color: var(--danger);
}
.file {
  display: block;
}
.po-enter-active,
.po-leave-active {
  transition: opacity 140ms var(--ease), transform 140ms var(--ease);
}
.po-enter-from,
.po-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.pg-wrap {
  margin-top: var(--sp-5);
}
/* 表单收窄并居中。列表不设上限:它是「一行一项 + 行尾操作」的清单,
   铺满时两侧的徽标与菜单正好互为对边,收窄反而在右边留出一块空白 */
.pg-wrap.is-form {
  max-width: 720px;
  margin-inline: auto;
}

/* —— 一张纸,不是一组卡片 ——
   主页的容器语言是「浮在纸上的柔光」:大圆角 + 弥散投影。
   原来那种 16px 方角 + 1px 描边的卡片网格是另一套语言。
   刻意不设 overflow: hidden —— 行内的溢出菜单要能浮到纸外 */
.sheet {
  border-radius: var(--r-lg);
  background: var(--surface);
  box-shadow: var(--sh-float);
}
.list {
  padding: var(--sp-2);
}
/* 分组:一个小标签 + 一条细线,不做卡片 */
.group-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: var(--sp-1) var(--sp-3) 10px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.group-label b {
  font-weight: 500;
  color: var(--text-2);
}
.group + .group {
  position: relative;
  margin-top: var(--sp-1);
  padding-top: 14px;
}
/* 分组分隔线两端各留 12px:一条横贯整张纸的线会把纸切成两半,
   和主页那种「有呼吸感」的分隔语言不搭 */
.group + .group::before {
  content: '';
  position: absolute;
  top: 0;
  left: var(--sp-3);
  right: var(--sp-3);
  height: 1px;
  background: var(--line);
}

/* —— 行 ——
   三段:状态列(定宽) / 主体 / 溢出菜单(仅 hover 与键盘聚焦时出现)。
   行本体是 <button>,所以整行可点又天然可 Tab 到;
   ⋮ 是它的兄弟节点(按钮不能嵌套),靠 flex 排在最后 */
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 11px 12px;
  border-radius: var(--r-sm);
  transition: background var(--dur) var(--ease);
}
.row:hover,
.row:focus-within,
.row.is-open {
  background: var(--bg-elev);
}
.row-main-btn {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 68px 1fr;
  align-items: center;
  gap: var(--sp-3);
}
/* 状态列:定宽 + 左对齐,于是所有行的名字都从同一条竖线起排。
   当前生效那条在这一列放一个墨色实心药丸,其余留空 ——
   「现在走的是哪条」不用读名字就能扫到 */
.dot-col {
  display: flex;
  align-items: center;
}
.pill-current {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 2px 8px 2px 7px;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-micro);
  font-weight: 500;
  white-space: nowrap;
}
.pill-current i {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.55;
}
.row-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.row-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-2);
  transition: color var(--dur) var(--ease);
}
/* 截断写在名字自己这层:上面的 flex 容器里文字是 flex item,
   容器的 text-overflow 对它是无效的 */
.row-name .nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 当前那条用正文色,其余退一档:靠字色而不是整行铺色块表达「最实」 */
.row.is-current .row-name {
  color: var(--text);
}
/* 模型 · 厂商:比名字轻、比正文轻,地址不再出现在列表里 */
.row-sub {
  font-size: var(--fs-xs);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-more {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--text-3);
  /* 常态隐去:三个常驻图标键正是「管理后台」的味道。
     用 opacity 而不是 display —— 键盘 Tab 仍能聚焦,聚焦后自动显形 */
  opacity: 0;
  transition: opacity var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.row:hover .row-more,
.row:focus-within .row-more,
.row.is-open .row-more,
.row-more:focus-visible {
  opacity: 1;
}
.row-more:hover {
  color: var(--text);
  background: var(--surface);
}
/* 触屏没有 hover:⋮ 会一直隐形,行菜单就点不到。
   这类设备上让它常驻 —— 常驻一个 32px 的圆键,比"三个方形图标键"轻得多 */
@media (hover: none) {
  .row-more {
    opacity: 1;
  }
}
.row-more svg {
  width: 16px;
  height: 16px;
}
/* 菜单挂在行上(行是定位锚点),浮到纸外也不被裁 —— 纸本身没有 overflow: hidden。
   祖先链(.shell / .frame / .page-in / .pg)也都没有裁剪容器 */
.row-menu {
  position: absolute;
  top: calc(100% - 6px);
  right: 6px;
  z-index: 5;
  min-width: 168px;
  padding: var(--sp-1);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: var(--sh-float);
}

/* —— 空态 ——
   不再是「什么都没有」,而是能一键预填的入口 */
.empty {
  padding: var(--sp-6) var(--sp-5) var(--sp-5);
  text-align: center;
}
.empty h2 {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
}
.empty-sub {
  margin: var(--sp-2) auto 0;
  max-width: 46ch;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.quick {
  margin-top: var(--sp-5);
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 外层的居中到入口这一层收住:入口里是左对齐的两行字 */
  text-align: left;
}
/* 两组入口之间的说明。夹在两个 .quick 之间,不跟着左对齐 —— 它是空态正文的一部分 */
.quick-sep {
  margin-top: var(--sp-5);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-3);
}
.quick-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) 14px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.quick-item:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.qm {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.qm b {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-base);
  font-weight: 600;
}
/* 品牌标比标题浅一档,不跟文字抢 */
.qm b :deep(.v-ic) {
  color: var(--text-3);
}
.qm span {
  font-size: var(--fs-xs);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.quick-item .go {
  margin-left: auto;
  color: var(--text-3);
  flex-shrink: 0;
}
.quick-item .go svg {
  width: 15px;
  height: 15px;
  display: block;
}
.empty-foot {
  margin-top: 18px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

/* —— 表单 —— */
.form-head {
  padding: var(--sp-5) var(--sp-5) 0;
}
.form-head h2 {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
}
.form-head p {
  margin-top: var(--sp-1);
  font-size: var(--fs-xs);
  color: var(--text-2);
}
.form-body {
  padding: var(--sp-5);
}
.block + .block {
  margin-top: var(--sp-5);
}
/* 块标题(Provider / What is this config for?)。它原来是 13px 浅灰,
   而下面紧跟的就是一排同样 13px、同样灰的按钮 —— "Provider" 看上去
   就像其中一枚没被选中的按钮。
   抬到满墨 + 600:块标题首先要压得住自己管的那一整块。
   它与字段名(.flabel,11px 全大写灰)**不同形**是有意的 ——
   一个是"这一整块是什么",一个是"这一个参数叫什么",两者差一级;
   同形的话就得靠颜色去分,而颜色这一维在浅色面上本来就很挤 */
.block-label {
  display: block;
  margin-bottom: var(--sp-2);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}

/* 用途二选一:它决定后面所有字段的含义,所以给两行带说明的选项,
   而不是一排只有名字的胶囊 */
.purpose {
  display: grid;
  /* 三档并排:每一档都带一句说明,太窄会挤成读不动的一坨,所以给一个下限,
     放不下时自己折行(表单本身也是收窄居中的) */
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.purpose-opt {
  /* 隐藏的原生 radio 是绝对定位的,得有个定位锚点收住它 */
  position: relative;
  display: flex;
  gap: 10px;
  padding: var(--sp-3) 14px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.purpose-opt:hover {
  border-color: var(--line-strong);
}
.purpose-opt input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.pm {
  min-width: 0;
  color: var(--text-2);
}
.pm b {
  display: block;
  font-size: var(--fs-base);
  font-weight: 600;
}
.pm span {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}
.tick {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: transparent;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.tick svg {
  width: 11px;
  height: 11px;
}
.purpose-opt input:checked ~ .pm {
  color: var(--text);
}
.purpose-opt input:checked ~ .pm + .tick {
  background: var(--cta);
  border-color: var(--cta);
  color: var(--cta-text);
}
/* 选中的那行:墨色描边 + 抬高一点,不用紫色 */
.purpose-opt:has(input:checked) {
  border-color: var(--text);
  background: var(--surface);
  box-shadow: var(--sh-sm);
}

/* 厂商预设:999px 药丸,选中 = 墨色实心(与主页的参数胶囊同一套) */
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.preset {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 13px;
  font-size: var(--fs-sm);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  background: var(--surface);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.preset:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
.preset.on {
  background: var(--cta);
  border-color: var(--cta);
  color: var(--cta-text);
}
.preset.on:hover {
  background: var(--cta-hover);
  border-color: var(--cta-hover);
  color: var(--cta-text);
}
/* 厂商能力说明:紧贴在厂商按钮下方,说明界面为何只露出这些参数 */
.note {
  margin-top: var(--sp-2);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-3);
}
/* 说明里的字面值(地址片段、模型 ID)用等宽,和正文区分开 */
.note code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.94em;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--bg-elev);
}

.field {
  display: block;
  margin-top: var(--sp-4);
}
/* 参数名(Name / Base URL / API Key / …)。与块标题(.block-label)同一套:
   13px / 600 / 满墨 —— 这一页里凡是"给某个东西起的名字"都长一样。
   它和框里那行提示(14px / 400 / --text-3)的差别**不靠字号**:只差 1px,
   靠的是轻重与明暗 —— 一边是 600 的墨,一边是 400 的浅灰。
   (更早那两版分别是"13px 浅灰对 14px 浅灰"(灰度 6B6B6B 对 727272,几乎同色)
   和"11px 全大写",前者分不出、后者与本页其余的名字不同形,
   都被换掉了 —— 记在这里是为了别再绕回去) */
.flabel {
  display: block;
  margin-bottom: var(--sp-2);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
/* 标签里的附注(“— optional”这种)。跟着 600 的标签走会显得像正文,
   所以压回 400、退一档灰 —— 它是一句旁白,不是参数名的一部分 */
.flabel em {
  font-style: normal;
  font-weight: 400;
  color: var(--text-3);
}
.input-wrap {
  position: relative;
  display: flex;
}
.field input {
  width: 100%;
  padding: 11px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: var(--fs-base);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
/* 占位提示显式定色。浏览器默认那一档灰在浅色面上过不了 4.5:1,
   而它又没法再浅 —— 所以"提示"与"标签"的区分交给字号与字重(见 .flabel),
   颜色这一维只负责让两者都达标 */
.field input::placeholder,
.field textarea::placeholder {
  color: var(--text-3);
  font-weight: 400;
}
.field input:focus {
  border-color: var(--accent);
  box-shadow: 0 6px 22px -8px color-mix(in oklch, var(--accent) 40%, transparent);
}
.field input:disabled {
  color: var(--text-3);
  background: var(--bg-elev);
  cursor: not-allowed;
}
.field.has-err input {
  border-color: var(--danger);
}
/* 显隐键压在输入框右端,正文得让出来 */
.field-key input {
  padding-right: 44px;
}
.field-err {
  display: block;
  margin-top: 6px;
  font-size: var(--fs-xs);
  color: var(--danger);
}
/* 填漏了的后果提示。与 .field-err 同一档颜色:它虽然**不拦提交**
   (本地服务或自建中转未必看这个字段,所以不越权替用户判定),
   但存下去就是一条发不出请求的配置 —— 该和"地址写错了"一样显眼 */
.field-warn {
  display: block;
  margin-top: 6px;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--danger);
}
.reveal {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--text-3);
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.reveal:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.reveal svg {
  width: 15px;
  height: 15px;
}

.form-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: var(--sp-5);
  padding-top: var(--sp-5);
  border-top: 1px solid var(--line);
}
.form-foot .hint {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
/* 连通性测试的结果。成功也走中性色 —— 这一页只有一个墨色主行动(保存),
   绿色勾会跟它抢注意力;真出问题时才用红,并且只有那一句是红的,
   上游原文仍退到次要色 */
.form-foot .test-line {
  margin-left: auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  color: var(--text-2);
}
.form-foot .test-line svg {
  flex: none;
  width: 14px;
  height: 14px;
}
.form-foot .test-line b {
  /* 带上模型名后这句会变长,让它也能被挤掉而不是把按钮顶出去 */
  min-width: 0;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.form-foot .test-line i {
  /* 上游原文可能很长,让它先被挤掉而不是把按钮顶出去 */
  min-width: 0;
  font-style: normal;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.form-foot .test-line.bad {
  color: var(--danger);
}
/* 主行动:墨色药丸,与主页的生成键同一套 */
.btn-ink {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 var(--sp-4);
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-sm);
  font-weight: 500;
  transition: background var(--dur) var(--ease);
}
.btn-ink:hover:not(:disabled) {
  background: var(--cta-hover);
}
.btn-ink:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 放弃修改:描边药丸,比主行动轻 */
.btn-line {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 var(--sp-4);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  font-size: var(--fs-sm);
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.btn-line svg {
  flex: none;
  width: 15px;
  height: 15px;
}
.btn-line:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.btn-line:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 窄屏:输入框提到 16px,防止 iOS Safari 聚焦时放大整页 */
@media (max-width: 640px) {
  /* 手机上把这一排的触控目标抬到 40px —— 站内对触屏的底线
     (见 App.vue 里 .param-btn / .clear-icon 那几条)。桌面维持原尺寸:
     那边有鼠标,把它撑大只会让版面变松 */
  .pg-new,
  .icon-ghost {
    min-height: 40px;
  }

  .field input {
    font-size: var(--fs-lg);
  }
  /* 用途改单列;状态列不再定宽,名字多拿 68px 的横向空间 */
  .purpose {
    grid-template-columns: 1fr;
  }
  .pm b {
    font-size: var(--fs-lg);
  }
  .row-main-btn {
    grid-template-columns: auto 1fr;
  }
  /* 三个按钮加一行结果在一行里放不下:让结果独占一行(它有 margin-left: auto,
     换行后要摆回左边) */
  .form-foot {
    flex-wrap: wrap;
  }
  .form-foot .hint,
  .form-foot .test-line {
    flex-basis: 100%;
    margin-left: 0;
  }
}
</style>
