# System Prompt 分层与运行时状态设计（方向 memo）

> 状态：**memo，运行时状态那部分仍不动手**。这份文件存在的意义是把 2026-10-19 删除驱动量三栏时想清楚的东西
> 存下来，等下一个数据点（真实需要"此刻状态"的功能需求）出现时直接消费，不必从零再想一遍。
> 当前结构的权威快照与逐块来源标注，见姊妹篇《System Prompt最终结构与信息来源.md》。
> 在此之前，任何"把 Situation/Want/History 加回角色卡"的提议，先拿来对着 §4 的三个问题过。
>
> **2026-10-20 更新**：本 memo 里标"缺口/待拆"的多数条目已落地（A/B/C/E）——photo 协议已
> 拆成 `photoRules()` 条件注入、mood 已独立成块、layerRules 已去重、摘要已补 fallible 声明、
> 记忆注入已补 sortMemories。**只有 §4 的运行时状态（模块 07 Dynamic State）仍未动、也仍是
> 本 memo 继续存在的理由**；§2 现状列与 §6 已按落地情况更新，读时以代码为准。

## 1. 起因：一次删除，和一个病根

角色卡的人格区曾有四个字段（`server/charSpec.js` 行定义、`character.persona`）：

- `present`（UI 名 Situation）——"此刻正在干嘛"
- `drive`（UI 名 Want）——"此刻想从用户得到什么"
- `shared`（UI 名 History）——"你们之间已经有什么"
- （对照用：`samples` 说话样本，**没删**）

前三栏于 2026-10-19 整体删除（types.ts / characterSpec.ts / charSpec.js /
enhancePrompts.js / routes/chat.js 五处，共 8 个文件含测试，net -84 行）。

病根一句话：**语义是"此刻"，存储是"建角色那天填死的一句话"**。每轮装配时它们被冠以
"What's going on with you **right now**" 注入，可没有任何东西负责更新——一张永不换新的
过期说明书。两篇外部评审（《超拟真陪伴角色Prompt骨架评审与优化建议》
《Kairo_角色System_Prompt示例评审与优化建议》）里 drive 陈旧、场景跳变、
present/summary/shared 职责重叠，全部是这一个错位的症状。

原设计那句话本身没有错——"状态与动因会生成话，形容词不会"。**错的是供给的地方**：
静态的角色卡养不活"此刻"的语义。删掉的不是功能，是一个兑现不了的承诺。

## 2. 目标结构（15 模块，带所有权）

外部评审给过一版 15 模块的排列图。采纳它作为**代码与数据层的分类图**；
装配顺序仍归装配代码管（§5 有几处现状不能照它改）。
每个模块必须带三个所有权字段，否则它只是又一个空槽：

| # | 模块 | 来源 | 更新方式 | 生效范围 | 现状 |
|---|------|------|----------|----------|------|
| 01 | Role Contract | 写死 | 改代码 | 永久 | ✅ 有 |
| 02 | Identity（身份+固定外貌） | 角色卡 | 人工编辑 | 永久 | ✅ 有（Who you are） |
| 03 | Personality（traits/boundaries） | 角色卡 | 人工编辑 | 永久 | ✅ 有（并入 How you behave） |
| 04 | Voice（language/voice/address） | 角色卡 | 人工编辑 | 永久 | ✅ 有（同上，暂未拆两块） |
| 05 | Voice Samples | 角色卡 | 人工编辑 | 永久（只仿语气不仿事实） | ✅ 有 |
| 06 | Current Context（真实时间/上次互动） | 前端算、服务端拼 | **每轮自动** | 本轮 | ✅ 有（chatTime） |
| 07 | Dynamic State（Scene/Mood/Intent） | **待定——见 §4** | 待定 | 待定 | ⚠️ 仅 Mood 有；Scene/Intent 已删 |
| 08 | Relationship | 前端三轴计算 | 评估后写入（白名单注入） | 跨轮持久 | ✅ 有 |
| 09 | User Guidance | 用户显言/抽取 | 筛选后写入 | 长期偏好 vs 本轮要求须区分 | ✅ 有（区分是缺口，见 §6） |
| 10 | Shared History | **随 07 一起悬空** | 原为角色卡静态（已删） | 应为沉淀后自动/可确认 | ❌ 已删 |
| 11 | Memory Facts | 记忆系统 | 提取/更正/失效 | 按 status | ✅ 有（更正与失效机制缺失，见 §6） |
| 12 | Memory Summary | chat_summaries | 滑窗压缩 | 是"可错的过去"非事实 | ✅ 有（**已补 fallible 声明**，memoryBriefSection，2026-10-20） |
| 13 | Core Rules | 写死 | 改代码 | 常驻 | ✅ 有（CHAT_RULES，photo/mood 已拆出） |
| 14 | Conditional Rules（**Photo Rules**） | 写死+条件注入 | 改代码 | 能力开启才注入 | ✅ **已落地**：拆成 `photoRules()`，canDraw 条件注入（块 13） |
| 15 | Output Contract（think/act/mood/photo） | 写死+条件注入 | 改代码 | 版本化、单一规格 | 🟡 主体已落：mood/photo/think/act 各成块、layerRules 已去重；**仍缺**标签语法单一规格总表（chatTags.js 遗留别名），见 §6 |

"现状"列就是工作量清单。

## 3. 现状 → 目标的映射（server/routes/chat.js 的 chatSystemPrompt，15 块）

```text
现状                                    → 目标模块
01 "You are roleplaying…"              → 01
02 How to weigh it（priorityRules ★新）  → 13 的"地板"层（权威顺序显式化，2026-10-20）
03 Who you are（name/identity/Wearing/marks）→ 02（Wearing 长期看归 07 的 outfit 槽，前提同 §4）
04 How you behave（language/traits/voice/address/boundaries）→ 03+04（合并块，可暂不拆）
05 How you actually type（samples ≤600）→ 05
06 time（Right now/last spoke ≤200）    → 06
07 mood（上一轮 [mood:] 回喂，6h 窗口）   → 07 里唯一活着的 Mood
08 What you remember（summary ≤8000，★带 fallible）→ 12
09 Facts（memorySection，'- ' 白名单 ≤12行）→ 11（注入前 sortMemories 预排）
10 Relationship（relationshipSection 三轴）→ 08
11 Guidance（guidanceSection 白名单）    → 09
12 CHAT_RULES（13 条）                   → 13
13 photoRules()（★条件注入 canDraw）      → 14
14 CHAT_MOOD_RULE（[mood:] 输出格式 ★新）  → 15（mood 那半）
15 layerRules(sceneMode)                → 15（think/act 那半，已去重、不再重排标签顺序）
```

已删净、不在树里的：原 03.5 "What's going on with you right now"（present+drive）
与原 08.5 "What's already between you two"（shared）。

## 4. 07 Dynamic State 的入场券（三个问题，答不出就不许建槽位）

1. **谁来写**：用户手改（对话页一个"此刻在干嘛"的输入）？模型每轮建议、规则/用户确认后
   落库（`[mood:]` 的"只回喂一轮 + 带出口"先例可以直接抄）？还是纯规则（时间×场景推导）？
2. **什么时候变**：每轮？事件驱动（换场景的标记）？超时衰减（6h 先例）？
3. **过期怎么办**：整块不注入（空就不出现的老手法），还是回落中性值？

本地优先的约束在这里钉死：**没有服务器帮你存状态，"后端更新"在 Kairo 里只能是前端
`src/lib/*.ts` 纯函数 + localStorage/IndexedDB**。这条不认清，任何"运行时状态"方案
都会画成服务端状态机然后落不了地。

存储形态建议：状态挂**对话（chat）**而不是角色卡——"此刻"本来就该是每条聊天各自的当下，
角色卡继续只放永久属性。Character 可选字段 additive 的老规矩（不升 DB_VERSION、
coerce 空即删）同样适用于 Chat 的新字段。

## 5. 不照 15 模块图改的事（三条，都有硬理由）

- **summary 在前、facts 在后**：成篇叙述不能被清单切碎（chat.js 注释写死了这条理由），
  15 图里 Facts(11)→Summary(12) 的顺序反过来才对，装配时维持现状。
- **Guidance 紧贴 Core Rules 之前**：它是最后一条软指令，离硬规则最近跟着走的可能性最高
  （chat.js 注释），不能被挪进 Runtime 区。
- **"think 详细内部推理"不许进 15**：评审建议过要求输出详细推理过程——明确拒绝，
  `[think]` 是角色表达层的一行内心，不是模型的推理链（消息心理层次设计 §7 的稀缺原则）。

## 6. 与 07 无关、但评审点着的真缺口（可独立排期）

**2026-10-20 更新**：标 ~~删除线~~ 的已随 A/B/C/E 落地，其余仍开放。

- ~~**Photo Rules 拆出常驻**（14）~~ → **已落地**：`server/chatPhoto.js` 的 `photoRules()`，
  `chat.js` 按 `canDraw` 条件注入；发不出图时整块不出现（块 13）。
- **Output Contract 单一规格**（15）：**部分落地**——mood/photo/think/act 已各成一块、
  layerRules 已去重（不再重排标签顺序、不再无条件点 `[photo:]`）。**仍开放**：标签语法的真相
  还散在两处（chatPhoto.js 教学文本、chatTags.js 解析正则），解析器仍认 `self:/myself:` 等
  遗留别名并归一化成三态。合一张总表，顺带与 doc/标签层通用化设计.md 的 extractTags 方向并轨。
- **Memory 生命周期**：~~摘要注入一句 fallible~~ → **已落地**（memoryBriefSection："compressed
  recollection, not a transcript…"）；~~消费侧两个 bug~~ → **已落地**（注入前过 `sortMemories`、
  memoryBrief 截断留痕）。**仍开放**：条目要有更正/失效的去处（现在只有删除）。
- **Guidance 区分临时要求**（未动）："今天别安慰我"不该被抽成永久偏好——抽取提示词与
  chat_guidance 的沉淀规则要加这条边界。

## 7. 触发条件（什么时候从这份 memo 回到动工）

任一出现即值得重新评估 §4：

- 用户主动要求"角色根据时间/事件自己改变正在做的事"（主动性需求，见
  doc/关系与主动联系设计.md 的本地优先边界）；
- 生图侧需要权威的场景状态（照片连续性现在只靠"上一张的描述"，标签层通用化会撞上它）;
- 沉浸模式/场景模式要扩展到"多场景切换"（现在 sceneMode 只是输出开关，没有场景本体）。

反触发（明确不做）：把三栏原样加回角色卡，无论叫什么新名字。
