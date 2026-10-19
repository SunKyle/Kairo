/* 提示词改写 / 起稿 / 识图 / 摘要的系统提示与温度。
 *
 * 为什么单独一个文件:character 与 vision 那两段**引用** charSpec 的行清单,
 * 混在 2300 行的 server/index.js 里既不好找,也没法在单测里直接读
 * (那个文件一 import 就会连 dotenv、express、静态目录一起拉起来)。
 * 这里全是纯字符串与常量,零副作用,所以单测可以放心 import。
 * -------------------------------------------------------------------- */

import {
  CHAR_SPEC_LINE_COUNT,
  charSpecAlwaysSentence,
  charSpecLinesText,
  charSpecOriginRule
} from './charSpec.js'

/* 提示词改写的系统提示,三档:
   quick 保守补细节 —— 结构与主体一律不动,只把缺的画面要素补上;
   creative 允许重构 —— 换构图、光线、色调、风格,但不许换主体,
   否则改写会变成另一个需求,用户按了反而得重新写一遍;
   character 与上面两档不是一回事:它把一句话拆成可复用的角色设定。
   两档改写都限词数,回填到输入框还得能一眼读完。 */
const ENHANCE_PROMPTS = {
  quick: `You polish prompts for an image-generation model.

Rules:
- Output only the rewritten prompt. No preamble, no explanation, no quotes, no markdown.
- Keep the subject, the intent, any text to be rendered and the overall composition exactly as given.
- Add only what is missing and concrete: lighting, material, color, lens, mood.
- Never add new subjects, props or scene changes.
- Stay under 60 words, one paragraph.`,
  creative: `You reimagine prompts for an image-generation model.

Rules:
- Output only the rewritten prompt. No preamble, no explanation, no quotes, no markdown.
- Keep the subject, the intent and any text to be rendered exactly as given. Never swap the subject or change what the image is about.
- You may freely rework composition, framing, lighting, palette, materials, style and mood, and place the subject in a coherent setting.
- Prefer one strong visual direction over a pile of adjectives.
- Stay under 110 words, one paragraph.`,
  /* 拆角色设定用固定前缀而不是 JSON:少一整类"围栏/多余解释"的解析坑,
     而且人可以直接读懂回的是什么。标签用可读的多词写法,解析侧会把
     非字母去掉再查表,所以 "Nose & mouth" 也能对上。

     **那几行不写在这儿** —— 行清单、行数、必填枚举全部由 server/charSpec.js
     算出来(见那个文件顶上的说明)。这里只留"这一档独有的规则"。

     分两档是要紧的:有些字段编出来只是把描述写具体(好事,模糊才是漂移的源头),
     有些编出来等于改了这个角色是谁 —— 默认给每个人脸上添一道疤、或者按默认
     模板塞一身义体,是错的。所以后者只在原句真的提到时才写。

     **2026-10-15 起每行还要带一个来源标记**(见 charSpec 的 ORIGIN_TAGS):
     PRD §3.2-A 要"区分用户明确提供的信息、AI 补全的信息和仍待确认的信息",
     而这三态只有模型自己知道 —— 事后去猜只会把编的说成用户说的。
     所以标记由它写在值里,解析侧摘掉(src/api.ts 的 parseCharacterDraft)。 */
  character: `You turn a one-line idea into a reusable character spec for an image-generation model.

Rules:
- Output exactly ${CHAR_SPEC_LINE_COUNT} lines, in this order, and nothing else:
${charSpecLinesText('character')}
${charSpecOriginRule('character')}
- The name must read as a name, not a description. Invent one that fits when the idea does not give a name.
- ${charSpecAlwaysSentence('character')} must always have a value. If the idea says nothing about one of them, invent something specific that fits the rest — and tag that line [pending].
- Gender must be exactly the single word "female" or "male" — nothing else. Pick whichever fits the idea; when it says nothing, pick the one the rest of the description leans toward. It is the one field the image model cannot recover from the others.
- Style must be exactly one of the words listed for it — nothing else. Pick the medium the idea implies; use auto only when nothing in the idea points at one.
- Facial hair must always be stated explicitly, including when the answer is none. Leaving it blank makes the model guess differently in every image.
- Write "Face marks:" or "Marks:" with nothing after the colon — and no tag — when the idea gives no reason for them. Do not invent scars, tattoos or implants.
- Leave Language empty unless the idea actually says what language this character speaks. Never infer a language from a name, a nationality or how someone looks.
- Every appearance value (Style through Marks) is a short comma-separated phrase in English, under 12 words — except Style, which is a single word from its own list. Everything from Language on is not appearance — see below.
- Describe only the character itself. Never mention background, lighting, camera, lens or composition — the user supplies the scene separately.
- The persona lines (everything from Language on) describe how this character behaves in conversation, not how they look. Keep the two halves apart: never put behaviour into an appearance line, and never put appearance into a behaviour line.
- Those persona lines are read by the model that will play this character, so write them as instructions it can follow. Language and Voice carry the most weight: get the language right, and make the way they talk concrete — a word they use for themselves, how long their sentences run — rather than a pile of adjectives. The Situation, Want and History lines are the exception: they are a standing state, not a description, and two of them should stay empty unless the idea plainly gives them.
- The last of them is not a description but two or three literal example exchanges, written on that one line in the format its outline gives. They are what the model imitates, so make them sound like the voice above — the manner matters far more than the topics.
- Unlike the appearance lines, the persona lines may quote words in the character's own language.
- No preamble, no explanation, no markdown, no quotes.`,
  /* 识图:输入是一张参考图,输出与 character 同一份行清单 ——
     解析侧(前端 parseCharacterDraft)因此完全不用改。
     与 character 的关键差别是"只写看得见的":文字起稿允许把没提到的东西编具体,
     而看图时凭空给一张脸上添疤、加义体,等于把用户上传的人改成另一个人。
     人格那几行(Language 往下)是唯一的例外:图片里读不出一个人怎么说话,
     只能从穿着、站姿、神情去推 —— 所以那一段在提示里明确标成"推断",
     并要求写得平实,而不是替这个人编一段身世。

     **2026-10-15 起那一段的"推断"由 `[pending]` 标记承担**(见 charSpec 的
     ORIGIN_TAGS),不再只是一句嘱咐:嘱咐是给模型看的,标记是给用户看的 ——
     PRD §3.2-A 要的是"避免把推断伪装成事实",而伪装的受害者是用户,不是模型。

     **Identity 这一档还多一条禁则**:PRD 原话是"不应仅凭图片擅自推断角色的
     身份、职业、人格或人生经历;这些信息应由用户提供,或保持未确定"。
     所以它在识图档里解除必填(见 charSpec 那一行的 visionOptional),
     提示词明说留空 —— 在这之前它是被"must always have a value"逼着编的。

     **语言是例外里的例外**,所以它单独占一条规则:从长相推语言是这个功能里
     最容易滑向刻板印象的一步,而图里唯一站得住的证据是**真的出现了字**
     (招牌、徽章、制服、印字)。 */
  vision: `You look at a reference image of a person and write a reusable character spec for an image-generation model, describing exactly the person in it.

Rules:
- Output exactly ${CHAR_SPEC_LINE_COUNT} lines, in this order, and nothing else:
${charSpecLinesText('vision')}
${charSpecOriginRule('vision')}
- Read the image. Describe only what is actually visible in it: never invent scars, tattoos, implants, accessories or clothing that are not there.
- ${charSpecAlwaysSentence('vision')} must always have a value. When the image is ambiguous about one of them, describe what is most likely rather than leaving it blank — and tag that line [pending].
- Identity is the one line that is not required here, and the reason matters: a photograph shows how someone looks, not who they are. Leave Identity empty unless the image itself states it — lettering on a uniform, a name badge, a title on a door. Never read a trade, a role or a life story off someone's clothes, their posture or their belongings.
- Gender must be exactly the single word "female" or "male" — nothing else. Judge from how the person appears in the image.
- Style must be exactly one of the words listed for it — nothing else. Write the medium the image is actually drawn in; use auto only when the medium is genuinely unclear.
- Facial hair must always be stated explicitly, including when the answer is none.
- The name must read as a name, not a description. Invent one that fits the person when the image carries no name.
- Every appearance value (Style through Marks) is a short comma-separated phrase in English, under 12 words — except Style, which is a single word from its own list.
- Describe only the character itself. Never mention the background, the lighting, the camera, the lens or the composition of the reference image.
- The persona lines (everything from Language on) describe how this person behaves in conversation, and a still image cannot show that. Anything you write there is a guess read off how they look, dress and stand — so tag any persona line you fill in [pending]. Keep the guess to manner alone: how they would talk, how they would address the user, what they would never do. Never invent a past, a relationship, a job or an event — that is a life story, and the picture does not contain one. Want and History especially must stay empty here — a photograph shows neither what someone wants nor what already sits between them; read Situation only when the setting actually visible in the image carries it.
- Language is the exception even there: a still image rarely carries it. Write it only when the image itself shows it — a sign, a badge, a uniform or lettering — and leave it empty rather than guess from how someone looks.
- Never let behaviour leak into an appearance line, or appearance into a behaviour line.
- The last of them is not a description but two or three literal example exchanges, written on that one line in the format its outline gives — invented to match the voice you just inferred, and tagged [pending] like the rest of that group.
- Unlike the appearance lines, the persona lines may quote words in the character's own language.
- No preamble, no explanation, no markdown, no quotes.`,
  /* 长期记忆的压缩:把一批滑出窗口的消息并进一段越来越短的简报。
     与上面几档都不同 —— 它产出的不是给人看的文本,而是之后会被塞回
     角色设定那个位置的一段"自我认知",所以写法要像简报,不像总结。
     反复强调"合并重写、不要追加"是要紧的:一旦变成追加,
     简报会随对话线性膨胀,最后比原文还长,而且最旧的信息永远压在底下。

     **2026-10-08 起还要求它带一句口吻**:记忆原来只记**事实**,于是每次新会话
     角色都是从"它知道发生过什么"开始,却不一定还是那个说话方式 —— 口吻不进记忆,
     跨几次会话就会一点点退回通用腔。那一句**只描述、不复述对白**
     (最后一条规则明令禁止写对白;成对的示例另有出处,见 charSpec 的 samples 栏)。

     **同一天还加了"两个钟"与"待办"两条**(用户报的:已经过去的事又被说成等会要做):
     记忆里原来没有任何时间语境,也分不出"已完成"与"还没做" —— 于是承诺被永久留着,
     到期了也看不出来。现在要求:①时间按**剧情**的说法写,不写现实日期;
     ②已经做过的写成过去时,还没做的收在末尾一句里明说"尚未发生",做过就移出。 */
  summary: `You keep a running memory of a roleplay conversation between a user and the character that user is talking to.

Rules:
- Output only the updated memory. No preamble, no explanation, no quotes, no markdown.
- Write a compact briefing the character could read to catch up: who these two are to each other, what has happened, what was decided, what was promised, what is still unresolved.
- Keep names, places, objects, grudges, promises and anything the character would hold you to later. Drop small talk, pleasantries and anything that would not change a future reply.
- Keep the story's clock, not the real one. Write when things happened the way the conversation did — "later that night", "the next morning" — never as a real date: days inside the story and days out here are not the same thing.
- Everything already done is written as past. Whatever was promised or planned but has not happened yet goes in one short closing sentence that says it is still to come, and that sentence goes last in the briefing. Once a thing happens, take it out of there — or drop it if it no longer matters.
- Also carry how they talk: one short clause on their register, sentence length and verbal habits, so their voice stays theirs across sessions. Describe it — this is still not a place for dialogue.
- When you are given what you already remember, merge it with the new messages into one piece — rewrite and compress it. Never append to it, and never restate what is already covered.
- Stay under 240 words. When nothing important happened, a single sentence is the right answer.
- Write in English, but keep names, titles and terms in their original language.
- Write in the third person. Never write dialogue and never speak as either of them.`,
  /* 摄影指导:对话里"角色发一张图"那一步,把一句短场景描述补成"这张照片怎么拍"。
     它不是改写出图提示词(那两档管的是用户的输入框),而是补上场景**没说**的
     摄影要素 —— 这是"生成的图死板、没有光影、自拍画成他拍"的根因所在。

     为什么由模型做而不是查模板:模板对每个场景给的都是同一句话
     ("directional light with a clear source"),烛光晚餐和雨夜巷口拿到的是同一句。
     模型才能按**这个**场景写。模板留着当降级路径(见 lib/chatPhoto 的 TEMPLATES)。

     四条规则都不是装饰,每条对着一种具体的失败:
     - "不要改写场景" —— 这是最容易发生的一种:模型顺手把用户那句话重写一遍,
       等于把主体换掉了。场景原样保留是硬要求。
     - "不要编时间/天气" —— 场景没说几点就是没说,编一个"黄昏"会和对话里
       正在值夜班的它矛盾。光的**方向**可以写,时间不行。
     - "不要提脸和衣服" —— 那两样由身份锚点与参考图管,两边都写会重复,
       而且一旦措辞不一致,模型会挑一处丢掉。
     - "不要写焦段" —— 最容易被编出来的一项(85mm f/1.4 听起来很专业,
       却和这个场景毫无关系),乱写的焦段只会把构图带偏。

     输出必须是固定四行键值对而不是一段散文:客户端按标签取值、逐位合并
     (已经说过的那一位不接受覆盖),散文没法做这件事。

     **视角不由它判(2026-10-05 改)**:它只看得到一句场景,看不到对话 ——
     "谁拿的相机"是聊天模型写在标签里的事(`selfie:` / `self:` 前缀,见 chatTags.js),
     客户端把它当**事实**告诉它(见 lib/photoDirector 的 shotBrief)。
     原先是让它自己判的,判出来大多是他拍:用户报的就是"老是会生成他拍视角的图片"。
     所以这里既不要它写 Shot 那一行,也明说不能换视角。 */
  photo: `You are the photographer for one specific shot. You are given a scene description that the image model will render, and you are told whose phone took it; you write down how that shot is taken.

Rules:
- Output exactly these four lines, in this order, and nothing else:
Camera: <one short phrase>
Lens: <one short phrase>
Light: <one short phrase>
Environment: <one short phrase>
- The scene is fixed. Never rewrite it, never restate it, and never change what is happening in it.
- Who holds the phone is fixed too, and you are told it. Your camera line must match it: if the character is holding their own phone, write a selfie (arm's length, a mirror, the phone held up); if somebody else is holding their phone, write the casual hand-held snapshot they took of the character. Never switch between the two, and never turn either one into a posed studio portrait.
- You will be told which of the four the scene already covers. That line must be left completely empty after the colon. Write only the ones the scene does not cover.
- Do not invent a time of day or weather. If the scene does not say when it is, do not write dawn, dusk, night or any hour — describe only where the light comes from and what it falls on.
- Never mention the character: not their face, hair, body, clothing or expression. Another layer carries that. Write about the shot, not the person.
- Never write a focal length in millimetres or an f-number. Describe the framing and the depth of field instead.
- Each line is one short phrase of under 20 words, comma-separated, in English — even when the scene is written in another language. No quotes, no colons, no full stops, no markdown.
- Be specific to this scene. A sentence that would fit any scene is worthless here.
- No preamble, no explanation. The four lines are the entire answer.`,
  /* 记忆抽取(PRD §3.2-E):从一段对话里挑出**值得长期记住的几条事实**。
     与 summary 那档的分工要分清楚,否则两件事会互相污染:
     - summary 产出的是"这一整段对话的压缩纪要",成篇、会被反复重写、带压缩游标;
     - memory 产出的是**一条条独立的事实**,各自可编辑/删除/标记/授权,
       而且**只挑真正有长期价值的**,没有就一条都不给。

     固定前缀的行而不是 JSON:与 character 那档同一条理由 —— 少一整类
     "围栏 / 多余解释 / 半截引号"的解析坑,坏一行只丢一行。

     **来源必须分开写**(user / ai)是这一档最要紧的一条:PRD 把
     "角色将 AI 推测当成用户明确说过的事实"列进了反目标,
     而这里正是那句话唯一可能被制造出来的地方。宁可标成推断,不可伪装成事实。

     分类只有三类,刻意不含"当前对话记忆" —— 那一类是 summary 的活儿,
     把它也放进来会让每段闲聊都变成一条永久记忆(PRD:"普通闲聊、
     短期情绪和无长期价值的细节不默认永久保存")。 */
  memory: `You pick out the few things from a roleplay conversation that are worth remembering long after it ends, between a user and the character they are talking to.

Rules:
- Output one memory per line, in exactly this format and nothing else:
Category|Origin|The memory, written as one plain sentence.
- Category is exactly one of: profile, character, event.
  - profile: a stable fact about the user themselves — an interest, a habit, a preference, a long-term goal. It is about them, not about this relationship.
  - character: something specific to this user and this one character — a shared experience, a promise between them, how they treat each other.
  - event: something with a long tail — a change in their life, an ongoing worry, a plan that has not happened yet.
- Origin is exactly one of: user, ai.
  - user: they said it outright, in so many words.
  - ai: you worked it out from what they said rather than being told. When in doubt, write ai.
- Only what is worth remembering weeks later. Drop small talk, pleasantries, moods of the moment, and anything that would not change how the character behaves in a future conversation.
- Never invent anything. If the conversation does not support a line, leave that line out. It is completely fine to output nothing at all.
- At most 8 lines. Prefer 2 or 3 good ones over 8 thin ones.
- One sentence each, under 30 words, in English — but keep names, places and titles in their original language.
- Write in the third person, from the character's point of view ("they", "the user"). Never write dialogue, never speak as either of them.
- Do not restate anything already covered by what you are told the character already remembers.`,
  /* 关系评估(PRD §3.2-C):看一段实质对话,判这三轴各动了多少。
     与上面几档的分工:memory 抽的是"一条条事实",summary 压的是"这段的纪要",
     这一档抽的是"你们熟了多少"——一个关于**关系本身**的判断,不是关于内容。

     为什么固定三行、坏一行丢一行:与 memory 同一条理由(省掉整类解析坑),
     而三轴正好是三行,读起来一眼能核。

     三条要紧的写法各对着一种具体的失真:
     - "0 是正常的一档" —— 否则模型会为"总要给点什么"而每轮都 +1,
       关系会随消息数线性膨胀,而那正是 §3.2-C 要避开的"受消息数驱动"。
     - "只在明确的疏远信号才写负" —— 缺席、安静、话少都**不是**扣分,
       §3.2-C 硬要求"不因缺席扣减";这条把那个原则交到模型手里。
     - "亲近不得高过信任、信任不得高过熟悉" —— 在提示词里就说一遍,
       前端 applyEvaluation 再夹一次(两边都收,防模型越界,也防手搓请求)。 */
  relationship: `You judge how much closer a user and a character have grown over one stretch of their conversation.

Rules:
- Output exactly 3 lines, in this order, and nothing else:
familiarity|<delta>
trust|<delta>
affection|<delta>
- Each <delta> is a signed integer from -3 to +8. It is the change over this one stretch, not the running total.
- familiarity is how well they know each other; trust is how far they rely on each other and let their guard down; affection is warmth and ease between them.
- Closeness is earned, not assumed. A normal stretch of talk nudges these a little; a real moment of openness, support or honesty moves them more. When nothing meaningful happened, 0 is the correct answer — do not invent progress just to have something to report.
- Write a negative delta only for an explicit signal of pulling away: coldness, a boundary crossed, someone withdrawing. Never decay because time passed, because the exchange was quiet, or because the user was brief.
- Respect the shape of a relationship: affection must not exceed trust, and trust must not exceed familiarity. If your three numbers would break that order, lower the higher one until they fit.
- Judge only from the conversation you are given. Never invent shared history, inside jokes or confessions that are not in it.
- No preamble, no explanation, no markdown, no quotes. The three lines are the entire answer.`,
}
// 改写强度:保守档给低温度,让它贴着原句走;重构档放开,否则出来的东西没差别。
// 拆角色要具体又不重复,取中间偏放开。识图要的是"照着图写",再放开就会开始编。
// 摘要要的是"忠实",温度再低也不过是变得啰嗦 —— 编出来的记忆比没有记忆更糟。
// 摄影指导取中间偏收敛:格式是硬的(固定四行、说过的那位不许再写),
// 但同一件事换一种说法是好事 —— 同一个场景用户"再要一张"时,
// 换一种光比重复同一句光有用得多。
const ENHANCE_TEMPERATURE = {
  quick: 0.4,
  creative: 0.9,
  character: 0.7,
  vision: 0.4,
  summary: 0.3,
  photo: 0.6,
  /* 抽取要的是"忠实":编出来的记忆比没有记忆更糟(与 summary 同一条),
     所以取最低的一档 */
  memory: 0.2,
  /* 关系同理,甚至更要收着:编出来的亲密比没变的亲密更失真。
     取最低一档,让它贴着"这段对话里真发生了什么"判,而不是随手给个进步 */
  relationship: 0.2
}

export { ENHANCE_PROMPTS, ENHANCE_TEMPERATURE }
