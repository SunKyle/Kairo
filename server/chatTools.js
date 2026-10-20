/* ===== 消息元数据的唯一通道：tool calling ==============================
   一轮回复除了正文，还带着两样**用户不该在正文里看见**的东西：
   它此刻的心情词，以及它想发的那张图。以前这两样写在正文末尾的
   `[mood:]` / `[photo:]` 标签里，由 chatTags.js 从文本上剪下来 ——
   那是"文本信道"，做法再稳也一直要跟半截标签、代码围栏、引号写坏打交道。

   2026-10-20 起改成 tool calling：模型在正文之外调用
   `emit_message_meta`，参数走 `tool_calls` 这个独立字段。正文从第一帧起
   就可以原样流给前端，不需要扣尾、不需要剥离 —— 两条信道真的分开了。

   这个文件只管三件事：
   1. 工具的形状（metaTool）—— 它同时就是"该报什么"的说明书；
   2. 流式分片的累加（newToolCalls / takeToolCallDeltas）——
      OpenAI 兼容协议的 arguments 是一个**逐片拼起来**的 JSON 字符串；
   3. 收到的参数 → 旧的扁平字段（toolMetaFromCalls）——
      mood/photoSelf/photoShot/photoFrame 的语义与以前一字不差，
      所以前端与消息存储都不用改。

   **不支持的模型不静默降级。** 上游明确拒绝 tools 时由
   looksLikeToolUnsupported 认出来，chat.js 把它翻成一句能操作的话；
   模型只是没调用时，done 事件带 metaIssue，前端给一次提示。
   -------------------------------------------------------------------- */

import { PHOTO_SCENE_CHARS, cleanScene, parsePhotoIntent } from './chatTags.js'

/** 工具名。System Prompt、探针、这里三处必须逐字一致 */
export const META_TOOL_NAME = 'emit_message_meta'

/* 枚举值归一化：大小写、空格、连字符、下划线都不该影响判断。
   `third-person` / `third_person` / `Third Person` 是同一样东西 */
function token(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

const SHOT = {
  selfie: 'selfie',
  selfportrait: 'selfie',
  mirror: 'selfie',
  mirrorselfie: 'selfie',
  third: 'third',
  thirdperson: 'third'
}
const FRAME = {
  close: 'close',
  closeup: 'close',
  macro: 'close',
  detail: 'close',
  medium: 'medium',
  halfbody: 'medium',
  mediumshot: 'medium',
  full: 'full',
  fullbody: 'full',
  fulllength: 'full',
  wide: 'full',
  wideshot: 'full'
}

/** mood 的形状：一个小写英文词，连字符可有。不符合就当没给 ——
 *  但**不影响同一份参数里的 photo**，反之亦然 */
function parseMood(v) {
  if (typeof v !== 'string') return ''
  const s = v.trim().toLowerCase()
  return /^[a-z][a-z-]{1,19}$/.test(s) ? s : ''
}

/**
 * 把工具参数里的 photo 归一化成旧的扁平字段。
 *
 * 支持对象 `{ scene, shot, frame, self }`（协议教的）与字符串（只当 scene，
 * 模型偷懒时也认）。`self` 不要求模型写：给了 shot 就说明它在画面里；
 * 两者都没有时用 parsePhotoIntent 从描述里兜底（点名的身体部位、旧前缀、角色名）。
 * 这样模型若把 `selfie:` 写进了 scene，也不会画成陌生人。
 */
function normalizePhoto(v, charName) {
  let src = v
  if (typeof src === 'string') src = { scene: src }
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null
  const raw =
    typeof src.scene === 'string'
      ? src.scene
      : typeof src.description === 'string'
        ? src.description
        : ''
  const scene = cleanScene(raw)
  if (!scene) return null

  const inferred = parsePhotoIntent(scene, charName)
  /* 旧前缀若被写进了描述，parsePhotoIntent 会把它剪掉；用剪过的版本，
     免得 "selfie: me on the balcony" 整句被喂给出图模型 */
  const cleaned = inferred.scene || scene

  let self = null
  if (typeof src.self === 'boolean') self = src.self
  else if (src.self === 'true') self = true
  else if (src.self === 'false') self = false

  const shot = SHOT[token(src.shot)] || ''
  const frame = FRAME[token(src.frame)] || ''
  if (self === null) self = shot ? true : inferred.self

  return {
    scene: cleaned,
    self,
    shot: self ? shot || inferred.shot : '',
    frame: frame || inferred.frame
  }
}

/** 一个已通过 JSON.parse 的参数对象 → 旧的扁平结果 */
export function normalizeMeta(obj, charName = '') {
  const photo = normalizePhoto(obj?.photo, charName)
  return {
    mood: parseMood(obj?.mood),
    photo: photo ? photo.scene : '',
    photoSelf: photo ? photo.self : false,
    photoShot: photo ? photo.shot : '',
    photoFrame: photo ? photo.frame : ''
  }
}

/**
 * 工具定义。`canDraw` 为假时**连 photo 字段都不出现** ——
 * 配不出图的角色不该被引着去报一个画不出来的画面（与旧版
 * canDraw 门控 photoRules 是同一条理由）。
 */
export function metaTool(canDraw = true) {
  const properties = {
    mood: {
      type: 'string',
      description:
        'One lowercase English word for how you feel as you send this message: amused, tired, warm, wary, bored, angry, proud, uneasy. Never a phrase, never more than one word.'
    }
  }
  if (canDraw) {
    properties.photo = {
      type: 'object',
      description:
        'The picture you are sending with this message. Omit it entirely when you are not sending one. Most messages have no picture.',
      properties: {
        scene: {
          type: 'string',
          description: `The whole frame, described for someone who cannot see this conversation: the time and the light, the weather, what is around you, and what you are doing right now. Up to ${PHOTO_SCENE_CHARS} characters. Write a description, never an instruction.`
        },
        shot: {
          type: 'string',
          enum: ['selfie', 'third'],
          description:
            'Who is holding the phone. "selfie" when it is your own phone in your hand (arm\'s length, a mirror). "third" when somebody else took the picture of you. Leave this out when you are not in the picture.'
        },
        frame: {
          type: 'string',
          enum: ['close', 'medium', 'full'],
          description:
            'How close the picture is, only when the distance is unusual. "close" for one thing or one part of you, "medium" around the waist, "full" for the whole of you and the room. The usual distance needs no word.'
        }
      },
      required: ['scene'],
      additionalProperties: false
    }
  }
  return {
    type: 'function',
    function: {
      name: META_TOOL_NAME,
      description:
        'Record the private metadata for the message you are sending. Call this exactly once after you finish writing your reply. Never write this metadata into the reply text, and never mention the call to the user.',
      parameters: {
        type: 'object',
        properties,
        required: ['mood'],
        additionalProperties: false
      }
    }
  }
}

/** 流式累加用的容器。key 是上游给的 tool_call index */
export function newToolCalls() {
  return new Map()
}

/**
 * 吃掉一帧 `delta.tool_calls`。
 *
 * OpenAI 兼容协议的流式形状：第一个分片带 `id` / `type` / `function.name`，
 * 后面的分片**只带 `function.arguments` 的一段字符串**。所以这里必须按
 * index 攒，不能一帧一帧地 parse —— 单看任何一帧，arguments 都不是完整 JSON。
 */
export function takeToolCallDeltas(calls, deltas) {
  if (!Array.isArray(deltas)) return calls
  for (const d of deltas) {
    if (!d || typeof d !== 'object') continue
    const idx = Number.isInteger(d.index) ? d.index : 0
    let cur = calls.get(idx)
    if (!cur) {
      cur = { id: '', name: '', args: '' }
      calls.set(idx, cur)
    }
    if (typeof d.id === 'string' && d.id) cur.id = d.id
    const fn = d.function && typeof d.function === 'object' ? d.function : null
    if (fn) {
      if (typeof fn.name === 'string' && fn.name && !cur.name) cur.name = fn.name
      if (typeof fn.arguments === 'string') cur.args += fn.arguments
      else if (fn.arguments && typeof fn.arguments === 'object') {
        /* 少数中转会把 arguments 直接给成对象。照收，不逼它改协议 */
        cur.args = JSON.stringify(fn.arguments)
      }
    }
  }
  return calls
}

/**
 * 把攒下来的 tool calls 收成扁平元数据 + 一个可选的 issue。
 *
 * `issue` 只描述"这一轮为什么没有元数据"，供前端提示：
 * - not_called        模型一个工具都没调用（多半是不支持，或没照着做）
 * - unknown_tool      调了，但不是 emit_message_meta
 * - invalid_arguments 调了，arguments 不是合法 JSON / 不是对象
 * - empty_metadata    参数合法，但 mood 与 photo 都为空
 * 合法且至少有一项时 issue 是空串。
 */
export function toolMetaFromCalls(calls, charName = '') {
  const empty = {
    mood: '',
    photo: '',
    photoSelf: false,
    photoShot: '',
    photoFrame: ''
  }
  if (!calls || calls.size === 0) return { meta: empty, issue: 'not_called' }

  const ours = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c)
    .filter((c) => c.name === META_TOOL_NAME)
  if (!ours.length) return { meta: empty, issue: 'unknown_tool' }

  const parsed = []
  for (const call of ours) {
    const raw = typeof call.args === 'string' ? call.args.trim() : ''
    if (!raw) continue
    try {
      const obj = JSON.parse(raw)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed.push(obj)
    } catch {
      /* 这一枚坏了，下一枚可能还是好的 */
    }
  }
  if (!parsed.length) return { meta: empty, issue: 'invalid_arguments' }

  /* 多次调用时按 index 顺序浅合并；photo 单独深一层，
     免得后一枚只补了 shot 就把前一枚的 scene 整块顶掉 */
  const merged = {}
  for (const obj of parsed) {
    for (const [k, v] of Object.entries(obj)) {
      if (
        k === 'photo' &&
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        merged.photo &&
        typeof merged.photo === 'object'
      ) {
        merged.photo = { ...merged.photo, ...v }
      } else {
        merged[k] = v
      }
    }
  }

  const meta = normalizeMeta(merged, charName)
  if (!meta.mood && !meta.photo) return { meta, issue: 'empty_metadata' }
  return { meta, issue: '' }
}

/* 上游拒绝 tools 时的常见说法。**不把 "invalid" 当成主判据** ——
   "invalid tool call arguments" 是模型参数坏了，不是模型不支持工具，
   混在一起会把一条可以重试的回复说成"换模型"。 */
const TOOL_UNSUPPORTED = [
  /\b(?:tools|tool_choice)\b[^.\n]{0,60}\b(?:not supported|unsupported|not available|unknown|unrecognized|invalid)\b/i,
  /\b(?:not supported|unsupported|not available|unknown|unrecognized|invalid)\b[^.\n]{0,60}\b(?:tools|tool_choice)\b/i,
  /\bdoes(?: not|n't) support\b[^.\n]{0,60}\b(?:tools|tool calls|tool calling|function calling)\b/i,
  /\b(?:tools|tool calls|tool calling|function calling)\b[^.\n]{0,60}\b(?:not supported|unsupported|not available)\b/i,
  /\bfunction calling\b[^.\n]{0,60}\b(?:not supported|unsupported|not available)\b/i
]

/** 这句上游报错是不是在说"本模型不支持工具调用" */
export function looksLikeToolUnsupported(text) {
  const s = String(text || '')
  return TOOL_UNSUPPORTED.some((re) => re.test(s))
}
