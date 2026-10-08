/* ===== 摄影指导 =======================================================
 *  对话出图那条路的"第三层"(见 doc/角色配图构图与光影设计.md 的 §四):
 *  在标签剪下来之后、真正发图之前,把一句短场景描述交给一次文本模型调用,
 *  由它写出**这个场景**该怎么拍 —— 机位、镜头、光、环境纵深。
 *
 *  —— 为什么需要它 ——
 *
 *  lib/chatPhoto.ts 里的 TEMPLATES 是查表:同一位空着时,烛光晚餐和雨夜巷口
 *  拿到的是同一句 "directional light with a clear source"。它有用(图像模型确实
 *  缺这些构图词汇),但它不知道你这张图具体该是什么光。模型才知道。
 *
 *  —— 为什么补上的字不能直接信 ——
 *
 *  一次自由文本生成会以三种方式破坏已经拼好的提示词,这三种都不能靠
 *  "在提示词里多叮嘱一句"解决:
 *
 *  1. **它顺手把场景改写一遍**。那等于把主体换掉了 —— 而主体是用户的意图,
 *     不是它可以优化的东西。所以**场景原文永远不由它提供**,它只写字。
 *  2. **它编时间/天气**。场景没说几点,它写一句 "at dusk" 就可能和对话里
 *     正在值夜班的它矛盾。这是"新事实",比留空更糟。
 *  3. **它写焦段**。`85mm f/1.4` 是最容易被编出来的一项,而它与这个场景
 *     毫无关系,乱写的焦段只会把构图带偏。
 *
 *  所以这个模块的职责不是"解析模型输出",而是**在解析之后逐项验收**:
 *  带时间词的整行丢掉、带焦段的整行丢掉、场景已经说过的那一位不接受覆盖、
 *  超长的截断、破坏行结构的字符抹掉。任何一项没过 → 该位退回模板。
 *  这一层与 chatPhoto 的"失败只降级、绝不 reject"是同一条纪律:
 *  摄影指导挂了,这张图照样得出得来。
 *
 *  —— 它不判视角,也不判景别 ——
 *
 *  视角(自拍 / 他拍 / 空镜)曾经也归它判,现在不归了:它只看得到一句场景,
 *  而"谁拿的相机"是聊天模型在标签里说的话(见 server/chatTags.js)。
 *  让它判的结果是大多数图落成他拍 —— 用户报的正是这个。现在它是**被告知**
 *  这件事,然后只负责在这个视角下把机位写准。
 *
 *  景别(特写 / 半身 / 全身)是 2026-10-06 加进来的**第二件被告知的事**,
 *  理由一模一样:它写的就是 `Camera:` 那一行,而"推多近"是那一行的内容 ——
 *  不告诉它,它就只能按场景猜,而 `applyDirector` 是**整句替换**:
 *  它猜出来的那个距离会把模板里那句正确的机位句一个字不剩地顶掉。
 *
 *  抽成纯函数是为了能直接断言 —— 上面每一条护栏都是"出错时画面会变形、
 *  但不会报错"的那类问题,而真正的出图要花钱、要联网,靠手测试不全。
 */

import type { ChatFrame, ChatLayer, ChatPhotoPlan, ChatShot } from './chatPhoto'
import { composeChatPrompt, missingSlots } from './chatPhoto'

/** 摄影指导能补的四位。**它不许碰 medium / 场景 / 锚点 / 负面约束,也不许碰
 *  pin 与 frame** —— 那几样分别是"媒介""内容""这个人是谁""挡什么",
 *  以及"谁拿的相机 / 离得多近"这两条不可让渡的事实,都不是"怎么拍" */
export const DIRECTOR_SLOTS = ['camera', 'lens', 'light', 'env'] as const
export type DirectorSlot = (typeof DIRECTOR_SLOTS)[number]

/** 每一行的长度上限。提示词里写的是"under 20 words",这里按字符收口 ——
 *  字数它不总数得清,而一行写到 400 字符就开始喧宾夺主 */
export const DIRECTOR_LINE_CHARS = 220

/* 时间词。命中就丢整行:那条规则("不要编时间")是最容易破的一条,
   而破了之后画面与对话矛盾是**看不出来**的 —— 用户只会觉得"这图不对味" */
const TIME_WORD_RE =
  /\b(dawn|sunrise|sunset|dusk|midnight|noon|midday|afternoon|evening|tonight|golden hour|blue hour|morning|night)\b/i

/* 焦段与光圈。同上,命中就丢整行 —— 它不是"不准确",是"和场景无关的噪声" */
const FOCAL_RE = /\b\d{1,3}\s*mm\b|\bf\/\d/i

/* 行结构的破坏者。`:()` 会与标签语法打架,句号/引号/markdown 会把一句短语
   变成一段话。**逗号不在此列** —— 四条规则里明说了要逗号分隔的短语 */
const STRUCTURE_RE = /[:：;；。！？!?"'`*#\r\n\t]/g

/**
 * 把摄影指导的原始输出解析成四位(机位 / 镜头 / 光 / 环境)。
 *
 * 认的是固定几行标签(`Camera: …` / `Light: …`),不是散文 —— 散文没法逐位合并
 * (已经说过的那一位要拒绝覆盖,而那需要知道每一句属于哪一位)。
 *
 * **它不再判视角**(见下面 applyDirector 的说明):`Shot:` 那一行如果写了,
 * 在这里会被当成认不出的位丢掉 —— 视角已经由标签定死了,不由它改。
 *
 * @returns 只含**解析成功且通过验收**的位。没提到的位、以及被丢掉的位,
 *          都不出现在结果里 —— 调用方据此逐位退回模板
 */
export function parseDirector(raw: string): Partial<Record<DirectorSlot, string>> {
  const out: Partial<Record<DirectorSlot, string>> = {}
  const text = String(raw || '')
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z ]{3,15})\s*[:：]\s*(.*)$/.exec(line)
    if (!m) continue
    /* 标签本身大小写与空格都不计较(模型会写 "Camera" 也会写 "camera ") */
    const label = m[1].trim().toLowerCase()
    const slot = label === 'environment' ? 'env' : (label as DirectorSlot)
    if (!DIRECTOR_SLOTS.includes(slot)) continue
    const value = lineValue(m[2])
    if (value) out[slot] = value
  }
  return out
}

/** 单行的验收与清洗。空串 = 这一位不要 */
function lineValue(raw: string): string {
  let v = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!v) return ''
  /* 模型偶尔会写 "Camera:" 然后跟一句 "n/a" / "none" / "-" 表示这一位它没写 */
  if (/^(n\/?a|none|same|unchanged|-{1,2}|—)$/i.test(v)) return ''
  /* 时间词与焦段:丢整行而不是删掉那个词 —— 删完剩半句更糟 */
  if (TIME_WORD_RE.test(v)) return ''
  if (FOCAL_RE.test(v)) return ''
  v = v.replace(STRUCTURE_RE, ' ').replace(/\s+/g, ' ').trim()
  v = v.replace(/^[,，\s]+|[,，\s]+$/g, '')
  if (!v) return ''
  return v.slice(0, DIRECTOR_LINE_CHARS).trim()
}

/**
 * 摄影指导的结果并进方案。**它只补那四位,视角与景别不归它管**(2026-10-05 / 10-06)。
 *
 * 五条不变量(每一条都有单测):
 * 1. **视角它一个字都改不了** —— 它只收到"这一张是自拍 / 他拍 / 空镜"这个事实,
 *    并据此写机位。理由见下面那段;
 * 2. **景别同样一个字都改不了**(2026-10-06)—— `frame` 槽不在 DIRECTOR_SLOTS 里,
 *    所以它那句 `Camera:` 即便写了个别的距离,也顶不掉那一层。理由是同一个:
 *    "推多近"是意图,它看不到对话、判不出来;
 * 3. **场景已经说过的那一位不接受覆盖** —— 场景里写了光,模型再写一句光就是
 *    自相矛盾,而模型会挑一处当噪声丢掉、或者把两者硬凑成一张谁都不像的图;
 * 4. **没被补上或验收不过的位退回模板** —— 降级是逐位的,不是整层;
 * 5. **只换那四位**。medium / 场景 / 锚点 / pin / frame / 动作 / 负面约束一律不动。
 *
 * —— 为什么把视角从它手里收回来 ——
 *
 * 它拿到的是**一句场景**,看不到对话、也看不到聊天模型写标签时的意图,
 * 所以"谁拿的相机"这件事它的信息**比聊天模型少**。让它判的后果实测有两条:
 * 场景写着"自拍"时它可能判成 third(把唯一的硬证据覆盖掉),
 * 场景只写"我在阳台"时它又只能猜 —— 而它猜出来的是他拍。
 * 用户的原话是"对于自拍的理解总是不好,老是会生成他拍视角的图片"。
 *
 * 现在分工是:聊天模型在标签里说(`selfie:` / `self:`),`planChatPhoto` 定死模板,
 * 摄影指导**被告知**这个事实,只负责"在这个视角下这句机位怎么写"。
 * 这也是这个模块一开始的原则("一位归谁管"就写在层名上)推到底的样子。
 *
 * @param patch parseDirector 的结果(只含通过验收的位)
 */
export function applyDirector(
  plan: ChatPhotoPlan,
  patch: Partial<Record<DirectorSlot, string>>
): ChatPhotoPlan {
  /* 场景已经覆盖的位:即便模型写了也不采用(见不变量 2)。
     判据与模板同一处 —— missingSlots 是"这一位空着吗"的唯一权威 */
  const miss = missingSlots(plan.scene)
  const allowed: Record<DirectorSlot, boolean> = {
    /* 机位与纵深是无条件补的(见 missingSlots 的说明),所以永远接受 */
    camera: true,
    env: true,
    lens: miss.lens,
    light: miss.light
  }

  const layers: ChatLayer[] = plan.layers.map(([slot, value]) => {
    if (!DIRECTOR_SLOTS.includes(slot as DirectorSlot)) return [slot, value] as ChatLayer
    const s = slot as DirectorSlot
    const written = patch[s]
    if (!allowed[s] || !written) return [slot, value] as ChatLayer
    return [slot, written] as ChatLayer
  })

  return { ...plan, prompt: composeChatPrompt(layers), layers }
}

/** 给摄影指导模型的那段活。**纯字符串**,所以能直接断言口径。
 *
 *  —— 交代给它的两件事实:谁拿的相机、以及推得多近 ——
 *
 *  这两件都不是它的判断,是它写机位的前提(2026-10-05 视角 / 2026-10-06 景别)。
 *  它拿到的只有一句场景,看不到对话,所以这两件它都判不出来 —— 让它判就是让它猜,
 *  而猜出来的默认是他拍(用户报的那个毛病)、以及一个它自己挑的距离。
 *
 *  另外三件它推不出来的事实:画面里有没有人(`photoSelf`)、
 *  以及哪几位场景已经有着落了(由 missingSlots 算)。
 *
 *  "do not change it" 那一句管的是**场景**。 */
export function directorTask(plan: ChatPhotoPlan): string {
  const subject = plan.self
    ? 'The character is in this image.'
    : 'There is no character in this image — it is a shot of the place itself, and nobody may appear in it.'
  return [
    'Scene, exactly as it must appear in the image, do not rewrite it and do not change it:',
    plan.scene,
    '',
    subject,
    shotBrief(plan.shot),
    frameBrief(plan.frame, plan.self),
    directorBrief(plan),
    '',
    'Now write the four lines.'
  ].join('\n')
}

/** 这一张的视角,以**事实**的口吻告诉它 —— 附一句"机位那句要与之相符"。
 *
 *  之所以还要说清"是谁拿的相机",是因为它要写 `Camera:` 那一行:
 *  同样是"拍一个人",自拍与他拍的机位句完全不是一回事。
 *  但**它不能改这件事** —— 那句 "do not switch" 就是这条不变量在提示词里的写法,
 *  而结构上的保证是 `applyDirector` 里它根本没有入口。 */
export function shotBrief(shot: ChatShot): string {
  if (shot === 'selfie') {
    return 'The camera is in the character\u2019s own hand \u2014 their own phone, at arm\u2019s length or in a mirror. Write the camera line so it matches that, and do not switch to a third-person view.'
  }
  if (shot === 'third') {
    return 'Somebody else is holding the phone \u2014 this is a snapshot another person took of the character, not a selfie. Write the camera line so it matches that casual hand-held look, and do not turn it into a selfie or a posed studio portrait.'
  }
  return 'The camera is set down or held steady on the place itself.'
}

/** 这一张**离得多近**,同样以**事实**的口吻告诉它(2026-10-06 新增)。
 *
 *  它与 shotBrief 是同一条推理的产物:景别也是"用户要什么",不是"怎么拍"。
 *  它写的是 `Camera:` 那一行,而"推多近"正是那一行的内容 —— 不告诉它,
 *  它就只能按场景猜;猜错的那一刻,`applyDirector` 会把模板里那句正确的
 *  机位句整句换掉,而它连"这是特写"都不知道。
 *
 *  结构上的保证与视角一样:景别进的是 `frame` 槽,而它不在 DIRECTOR_SLOTS 里
 *  —— **它一个字都改不了,只被告知**。
 *
 *  人与空镜分开写是有意的:空镜里没有"整个人"这回事(见 chatPhoto 的 frameLine)。 */
export function frameBrief(frame: ChatFrame, self: boolean): string {
  if (!self) {
    if (frame === 'close') {
      return 'This picture is a tight close-up of one detail of the place, and nobody is in it. Write the camera line so it stays that close, and do not pull back to show the whole place.'
    }
    if (frame === 'full') {
      return 'This picture takes in the whole place at once, and nobody is in it. Write the camera line so it stays that wide, and do not push in on one detail.'
    }
    return 'This picture is an ordinary mid-distance view of the place, and nobody is in it. Write the camera line to match that distance.'
  }
  if (frame === 'close') {
    return 'This picture is a tight close-up: one detail of the character fills the frame and the rest of them is cropped out. Write the camera line so it stays that close, and do not pull back to show their face, their body, or the room.'
  }
  if (frame === 'full') {
    return 'This picture is a full-figure shot: the whole character, head to feet, is inside the frame. Write the camera line to match that distance, and do not push in to a close-up.'
  }
  return 'This picture is a half-body shot: the face and upper body, not the whole figure. Write the camera line to match that distance, and do not pull back to a full figure.'
}

/** 哪些位场景已经有着落了。**判据必须与 applyDirector 同一处**(missingSlots)——
 *  告诉模型"这几位留空"、却在合并时接受了一位,或者反过来,都会让模型白写一句 */
export function directorBrief(plan: ChatPhotoPlan): string {
  const miss = missingSlots(plan.scene)
  const covered: string[] = []
  if (!miss.lens) covered.push('Lens')
  if (!miss.light) covered.push('Light')
  return covered.length
    ? `The scene already covers: ${covered.join(', ')}. Leave those lines empty.`
    : 'The scene covers none of the four.'
}

