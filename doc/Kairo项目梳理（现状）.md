# Kairo 项目梳理（现状）

> 快照：`main` @ `f3a759a`（2026-10-12）。
> 本文是「读代码 + 跑测试 + 读既有文档」得出的**当前状态**梳理。
> 旧版三篇文档（`项目梳理.md`、`优化建议.md`、`优化计划.md`，均以 **「KImage」** 命名、描述 7 页旧结构）**已于 2026-10-12 删除**（git 可恢复）。本文是当前唯一的现状梳理。

> ⚠️ **此后已漂移（2026-10-15 补记）** —— 本文是 `f3a759a` 的快照，正文里的数字**当时是对的**，不要为了「对齐」去改它们（改了就等于伪造快照）。读到时请以代码为准：
> - `DB_VERSION` **13 → 14**（新增 `memories` 表，`covers` 表不再新建）。受影响处：§1 对照表、§4.2、§9、§10、§12。
> - 测试规模 **624 / 19 文件 → 706 / 25 文件**；§9 那条「`vue-tsc` 零报错」在快照当天**并不成立**（工作区实测有 4 处编译错误，其中 `idb.ts` 的 `onupgradeneeded` 仍在引用已删的 `COVER_STORE`，会在升级事务里抛异常）。已全部修掉，见路线图 §7.2。
> - 页面从 **4 页变 5 页**（新增 `memory` 记忆中心）；设置页从「一张接口配置页」变成「用户向设置 + 接口配置」的分区容器。
> - 进展明细见 `doc/PRD对齐与后续路线图.md` §7。

---

## 0. 一句话定位

**Kairo 是一个「本地优先」的超拟人对话工作台**：前端是纯 Vue 3 SPA，后端只是一层自建 Node/Express 代理（把多家对话 / 识图 / 朗读 / 出图厂商统一成一套接口）。**没有账号、没有云存储**，全部数据留在浏览器（IndexedDB + localStorage），API Key 也只存在本机。

它由原有的生图工作台 **KImage 裁剪而来**：**只留下「跟角色说话」这件事**。Studio 出图工作台、自由画布、提示词库三块没有带过来——出图能力本身保留，但只剩**对话驱动的两条路**（角色在对话里发一张照片、沉浸页铺一张背景图）。

产品名、标题、favicon 均已改成 Kairo（`index.html` 标题 `Kairo · AI Companion`）。

---

## 1. 与旧文档相比，到底变了什么

| 维度 | 旧文档（KImage）描述的 | 当前代码（Kairo）实际 |
| --- | --- | --- |
| 产品名 | KImage | **Kairo** |
| 页面 | 7 页：home / chars / chat / canvas / lib / history / settings | **4 页**：`chat` / `chars` / `history` / `settings`（`src/lib/nav.ts`） |
| 路由 | 无，刷新回首页、无法深链 | **自带 hash 路由**（`src/lib/router.ts`，`#/chat/:id` 等深链） |
| 后端 | 单文件 `server/index.js`（~2299 行） | **68 行装配 + `server/routes/` 五模块**（chat/enhance/generate/test/tts，共 ~2042 行） |
| 状态管理 | `App.vue` 单文件充当 store（5412 行） | `App.vue` 缩到 **2783 行**，状态按域抽到 composables |
| 测试 | 无 | **19 个测试文件、624 个用例，全过**（`npm test`，vitest） |
| 类型检查 | 通过 | **`vue-tsc --noEmit` 零报错**（本次实跑确认） |
| 代码复用 | 同构逻辑散落多文件 | 抽出 `lib/ui.ts`（焦点陷阱/点外收起/Esc 分层）、`pickActiveByKind` 等 |
| 连接缓存 / prune 节流 | 缺失 | 已落地（`lib/idb.ts` 缓存连接 + 节流体检） |
| IndexedDB 版本 | 文档写 v9 / v11 | **代码实到 v13**（`lib/idb.ts` 的 `DB_VERSION`） |

**没有变（仍是设计核心、仍然有效）**：本地优先的隐私卖点、轻目录进 localStorage / 字节进 IndexedDB 的分层、五类接口配置共用一份列表、NDJSON 流式对话、长期记忆压缩、TTS 朗读与回退、四套独立 AbortController、删除即撤销、错误中文化与 SSRF 防护、整体设计语言（克制 · Editorial · 内容优先）。

---

## 2. 技术栈与工程结构

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（`<script setup>` + TS 5.6） | **无 vue-router**（自写 hash 路由）、**无 Pinia**（状态用 composables） |
| 构建 | Vite 5 | `manualChunks` 拆 vue / icons / motion 三块（`vite.config.ts`） |
| 后端 | Express 4 + undici + dotenv | `server/index.js` 仅做 app 装配 + `express.static` + SPA fallback；路由分散到 `server/routes/` |
| 图标/字体 | `@phosphor-icons/vue`、`simple-icons`、自托管 Poppins + Pacifico（只引 latin） | 见 `src/main.ts` |
| 其他 | `motion`（动效）、`fflate`（角色 zip 打包，动态引入） | |

### 2.1 目录与体量（当前）

```
Kairo/
├── index.html              # 首屏内联同步定主题，避免深色用户看到一帧白
├── vite.config.ts          # dev 端口 5181；/api 代理到 :3101；localhost only（LAN=1 才开）
├── vercel.json             # /api/:path* → api/index.js，其余 → index.html
├── api/index.js            # Vercel 函数入口（复用 server 的 app）
├── server/
│   ├── index.js     68 行   # 装配 + static + SPA fallback
│   └── routes/
│       ├── chat.js   566 行  # 角色对话，NDJSON 流式
│       ├── tts.js    592 行  # 火山语音合成（preset/describe/clone）
│       ├── generate.js 380 行 # 文生图 / 图生图（角色设定图、对话发图、背景图都走它）
│       ├── enhance.js 248 行 # 改写 / 识图 / 记忆摘要 / 角色起稿
│       └── test.js   188 行  # 连通性测试
├── src/
│   ├── App.vue     2783 行  # 唯一容器/编排层：装配 composables + 模板 + 样式
│   ├── api.ts     112KB    # 厂商能力表、所有后端调用、导入导出、IndexedDB 门面、pickActiveByKind
│   ├── types.ts     33KB    # 全部数据结构（注释即设计文档）
│   ├── style.css    18KB    # Design System 的 token 与全局样式（:root 单点定义）
│   ├── components/           # ChatPage / CharacterPage / HistoryPage / SettingsPage + 通用小组件
│   ├── composables/          # 11 个：useConfigs / useHistory / useCharacters / useChat / useChatFlow / useGeneration / useCharacter* (Draft/Wizard/Detail/List/Voice)
│   └── lib/                  # idb / providers / chatPhoto / photoDirector / characterSpec / chatMood / chatTags / speech / theme / prefs / ui / crossTab / router / nav / payload / text / grow / chat* 等 + 19 个 .test.ts
└── doc/                     # 14 篇设计/梳理文档（多数仍以 KImage 命名，见 §8）
```

### 2.2 运行与部署

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | concurrently 起 Express(3101) + Vite(5181)，Vite 把 `/api` 代理到后端 |
| `npm run dev:lan` | `LAN=1` 开放 0.0.0.0（同网段才能连，默认不开以免把本机代理借出去） |
| `npm run typecheck` | `vue-tsc --noEmit`（**本次实跑：零报错**） |
| `npm test` | `vitest run`（**本次实跑：19 文件 / 624 用例全过**） |
| `npm run build` | 先 typecheck 再 `vite build` → `dist/` |
| `npm run check:server` / `smoke:api` / `probe:chat-photo` | 三个本地探针脚本（`scripts/`） |

- **本地**：`server/index.js` 发现 `dist/` 存在就托管 + SPA fallback（排除 `/api/`），生产形态是「一个进程端前端 + 代理」。
- **Vercel**：`api/index.js` 只做 `export { app as default}`，同一个 Express app 被当 Serverless 函数复用。
- **`.env` 只有一个键**：`UPSTREAM_PROXY`（Node 的 fetch 不读系统代理）。`NO_PROXY` 默认含 `volces.com` / `bytedance.com` / `aliyuncs.com`。

---

## 3. 前端架构

### 3.1 四个页面 + 自建 hash 路由

页面唯一清单定义在 `src/lib/nav.ts`（`Page = 'chat' | 'chars' | 'memory' | 'history' | 'settings'`），导航分段控件、顶栏字标共用它。`src/lib/router.ts` 把 `page` 与 `id` 映射到 `location.hash`（`#/chat/:id`、`#/chars/:id`、`#/history/:id`），刷新与深链不再丢失位置——这直接修掉了旧文档 §9.5 列的「无法深链」痛点。三类 id 都由 `App.vue` 的 `applyRouteId` 分发：对话页认 `chatCharId`，角色页走 `openDetail`，历史页按 id 开预览（S-21 前非 chat 页的 id 解析出来即被丢弃）。

- 顶栏三段式常驻（字标 / 居中 `NavSegment` / 主题开关），滚动后加毛玻璃与发丝线。
- 主区是一条 `<Transition>` 包住的 `v-if` 链按 `page` 切换。
- 四个全局浮层：`ImagePreview`、`notice` 中性提示条、`UndoToast` 删除撤销条、角色悬停卡。
- **已知取舍（S-23）**：应用内导航一律 `history.replaceState`（不用 `pushState`），所以每一步切页 / 换对话对象都不进历史栈——好处是按一次「后退」直接回上一个站点（而不是在 tab 间来回弹），代价是浏览器后退键无法做站内回退。要站内分层回退需改 `pushState` 并自行管理栈，暂不做。

### 3.2 状态已按域抽到 composables（旧文档 §9 P1#5 已落地）

`App.vue` 现在只做**装配 + 模板 + 样式**，业务状态收进 11 个 composable：

| composable | 负责的域 |
| --- | --- |
| `useFeedback` | 错误 / 中性提示 / 删除撤销（三通道，所有域共用） |
| `useConfigs` | 接口配置列表、五类当前生效、能力派生、增删改导入导出 |
| `useHistory` | 历史记录读取、标记、清理 |
| `useCharacters` | 角色目录、设定图、导入导出、跨标签页同步 |
| `useChat` | 单场对话的消息状态、流式写入、朗读 |
| `useChatFlow` | 对话编排：发消息 → 调后端 → 情绪/记忆/发图决策（最大，~40KB） |
| `useGeneration` | 角色设定图生成、对话发图、背景图生成（出图能力收口） |
| `useCharacter{Draft,Wizard,Detail,List,Voice}` | 角色创建向导四段 + 列表 + 详情 + 嗓音 |

子组件仍只做展示，字节与状态在主容器/composable 里——这是沿用的旧约定。

### 3.3 通用机制（全站一致）

- **四套独立 AbortController**：设定图（`charViewControllers`）/ 对话流（`chatControllers`）/ 提示词改写（`enhancePrompt` 内部）/ 对话发图与背景图（`lib/imageJobs` 登记表，可被清对话、删角色掐掉）；`AbortError` 一律记为 `stopped` 而非失败。
- **按 key 忙等守卫（无全局并发闸）**：同一个目标已在跑时拒绝第二次 —— 对话流按 `chatBusy[charId]`、角色发图按 `chatPhotoBusy[replyId]`、背景图按 `backdropBusy[charId]`、设定图按 `charViewBusy[charId]`（数组，同角色可多张并行）。**没有** `runWithLimit` 这类全局限流器（旧文档此处失实，2026-10-12 更正）；跨角色 / 跨张数并不设上限。
- **落盘约定**：IndexedDB 不接受 Vue 响应式代理，写盘前 `toRaw`；新老图片载荷（Blob / data URL）读取侧都认。
- **删除即撤销**：全站删除都是「立刻生效 + 4.5s 撤销窗 + purge 才真删」。
- **能力表门控**：`getProvider(vendor, model)` / `inferVendor(baseUrl)` / `allowedSizes` 决定「发哪些扩展参数、尺寸手填还是枚举、走哪条端点」。
- **沉浸式对话**：`immersive`（用户偏好，存盘）× `immersiveOn`（仅 chat 页生效）两态（`App.vue` 顶部），沉浸态隐藏顶栏、台词用衬线体、全屏背景图。

---

## 4. 数据与存储分层

原则不变：**轻目录进 localStorage，字节进 IndexedDB**。

### 4.1 localStorage（`kimage.*`）

`kimage.apiConfigs`（接口配置列表）、`kimage.apiActive*` 五类各记一个当前生效、`kimage.characters`（角色目录）、`kimage.theme`、`kimage.immersive`（沉浸偏好）；旧键 `kimage.apiConfig` 保留迁移逻辑。

> 「同一列表、五个当前值」：出图 / 改写 / 对话 / 识图 / 朗读五类配置共用一个 `ApiConfig[]`，各自记 `activeId`。挑法统一在 `src/api.ts` 的 `pickActiveByKind`（已有单测）。

### 4.2 IndexedDB：`kimage.db` **v13**，10 张表（`src/lib/idb.ts`）

| 表 | 存什么 |
| --- | --- |
| `history` | 生成记录（Blob 图、缩略图、配方） |
| `covers` | 提示词库卡片封面（注：提示词库页面已移除，此表可能已弃用） |
| `chars` | 角色图：`{id}{SEP}{kind}` → 封面/底图/五张设定图 |
| `chat_messages` | 对话消息 |
| `chat_images` | 聊天里用户附的图（与消息分开存） |
| `chat_summaries` | 每个角色一条长期记忆 |
| `tts_cache` | 合成音频片段（按文本+音色指纹） |
| `voice_samples` | 克隆用本地录音样本 |
| `chat_backdrops` | 对话全屏背景剧照（v12 新增，keyPath = charId，一个角色一张） |

连接走缓存的 `dbPromise`；`versionchange` 时关闭并清缓存。`DB_VERSION` 只能加不能减（号比库里小会 `VersionError`，调用方 catch 成「读不出来」= 用户以为数据没了）。

### 4.3 存储治理

- `ensurePersisted()` 主动申请持久化配额。
- 写入即体检：`addHistoryRecord → pruneHistory()`，占用超 **80%** 水位清最旧 **30%**（`MIN_KEEP=20`，拿不到配额时 `HARD_LIMIT=500`）；作品集下的记录免清理。体检已加节流（距上次 ≥30s 或新增 ≥20 条），连接已缓存。
- 旧文档 P0#1 提的「`prune` 会吃掉 `marked` 标记图」问题：需核对 `pruneHistory` 当前是否已把 `marked` 并入避让集合（代码侧未逐一确认，建议回归）。

---

## 5. 后端：一层「翻译 + 归一化」代理（已模块化）

### 5.1 路由（`server/routes/`）

| 路由 | 文件:行 | 职责 |
| --- | --- | --- |
| `POST /api/generate` | generate.js | 文生图 / 图生图：角色设定图、对话发图、背景图都走它；按 `protocol` 走 OpenAI 兼容或 Gemini 原生 |
| `POST /api/enhance` | enhance.js | 一个端点四种档：改写 / 拆角色 / 识图 / 记忆摘要 |
| `POST /api/chat` | chat.js | 角色对话，**NDJSON 流式**（把上游 `data:` 帧重打包成 `{delta}`/`{done,finish,mood}`/`{error}`，设 `X-Accel-Buffering: no`） |
| `POST /api/tts` | tts.js | 火山语音合成（preset/clone → `/tts/unidirectional`，describe → `/tts/create`） |
| `POST /api/test` | test.js | 连通性测试（先 `GET /models`，再用空 JSON 探缺参） |
| static + SPA fallback | index.js | 托管 `dist/` |

### 5.2 厂商适配（前端 `api.ts` 能力表 + 服务端按 `vendor+protocol` 分流）

| 厂商 | Base URL | 特点 |
| --- | --- | --- |
| openai | `api.openai.com/v1` | 唯一支持 quality/background；无 seed；多图；`/images/edits` |
| ark（豆包 Seedream） | `ark.cn-beijing.volces.com/api/v3` | 尺寸自由但不认 `auto`；单参考图 |
| dashscope（通义万相） | `dashscope.aliyuncs.com/api/v1` | 同 ark 形状 |
| gemini | `generativelanguage.googleapis.com` | 原生协议；无 mask 字段（mask 当第二张图并在文字说明） |
| custom | 用户填 | 兜底；模型名含 gemini/banana 时按 Gemini 协议走 |

文本 / 识图另有 `TEXT_PROVIDERS` / `VISION_PROVIDERS`（含 DeepSeek、百炼 compatible-mode）。

### 5.3 错误中文化 + 安全（沿用旧设计，仍是强项）

- `CONNECT_HINTS` 把 `ENOTFOUND/ECONNREFUSED/ETIMEDOUT/UND_ERR_*` 与 TLS 错误译成排查方向；`looksLikeHtml + htmlTitle` 认出「上游回了一整页 HTML」并抽 `<title>`；再有一层关键词翻译。
- **无服务端密钥**：baseUrl/apiKey 全由前端随请求带；不挂 `cors` 是故意的。
- **SSRF 防护**：`assertSafeTarget + isBlockedAddress`，生产默认拒私网，DNS 解析后再校验。
- **限流**：内存滑窗 60s/30 次（Serverless 下按实例生效，非全局配额——仍是已知短板）。
- **超时/重试**：总超时 120s；流式与 TTS 用「静默超时」；仅配置了代理时才换跳重试，且仅对连接层异常重试；TTS 按字符计费全程不重试。

---

## 6. 核心链路（Kairo 专属）

### 6.1 角色（Character）

一个角色 = **五张设定图 + 一段结构化设定 + 名字 + 一张底图**。核心设计：**参考图管「形状」，设定管「语义」**。

- **正脸是唯一的锚**：`front` 之外的四张（Angles / Full body / Details / Body）一律以正脸为参考图生成。
- **字段结构化**：`CharacterFields` 前九项是「面貌特征」，拼进每张出图提示词（`characterFaceDesc`）；`outfit/marks` 只喂设定图；性格拆进 `CharacterPersona`——混进去会污染像素级约束。
- **新建向导三步**：Basics（AI 起稿 / 上传参考图识图 / 四栏设定）→ Voice（browser/TTS，可试听）→ Views（正脸先出，再四张）。
- **导入导出**：一个 zip 带走设定 + 五张图 + **对话与长期记忆**；导入换新 id 防撞车；上限 64MB。
- 提示词组装逻辑详见 `doc/角色生图提示词组装逻辑.md`、`doc/角色配图构图与光影设计.md`。

### 6.2 角色对话（Chat）

- **人格**：`persona` 六栏（language / traits / voice / address / boundaries / samples）拼成 system prompt，**刻意不喂** face/hair 等像素级字段；规则写死「禁 markdown、1–3 句、不要每轮反问、可以不配合、禁元叙述」；温度 0.9、max_tokens 1500。
- **流式**：NDJSON（非 SSE），前端按行切、留半行缓冲，增量写回响应式消息。
- **三条不同的「没说完」**：用户 Stop（`stopped`，不给 Regenerate）/ 上游报错（`failure`）/ 撞 `max_tokens`（服务端 `finish=length` → `truncated`，显示 "Cut off at the length limit"）。
- **情绪**：模型末行写 `[mood:word]`，服务端 `CHAT_MOOD_RE` 剪掉并单独下发，界面渲染成角色名旁小药丸（见 `doc/角色情感系统设计.md`、`src/lib/chatMood.ts`）。
- **长期记忆**：窗口 20 条（服务端再拦 40 条），滑出窗口的消息压成简报存 `chat_summaries`；提示词要求「合并重写、绝不追加、<200 词、第三人称」；游标 `upToId/upToAt/covered` 决定该不该再压。记忆可见、可改、可忘。
- **朗读**：`browser`（哈希稳定挑音色）与 `tts`（IndexedDB 缓存 → `/api/tts`）两档；TTS 失败**一定退回浏览器音色**并说明原因。

### 6.3 对话里「角色发一张图」（Chat Photo）—— 新版核心能力

角色在对话中可以发来一张照片，由 `src/lib/chatPhoto.ts`（~75KB）+ `src/lib/photoDirector.ts`（~16KB）驱动，规则详见 `doc/对话角色发图-六层拼装详解.md`、`doc/角色配图设计.md`。要点：

- **六层拼装**：语气/场景/构图/光影/参考图/后处理多层拼成出图提示词，正脸设定图作为锁脸参考。
- 发图是**对话驱动的出图**，走 `useGeneration` → `/api/generate`，结果以消息附件形式出现，不是独立的生图工作台。
- 已有 **182 + 47 个单测**覆盖 `chatPhoto` / `photoDirector`，是测试最重的模块之一。

### 6.4 沉浸式对话（Immersive）—— 新版

`doc/对话沉浸感设计.md` / `doc/沉浸式对话页面设计.md` 描述：对话页可切沉浸态，隐藏 chrome、台词用衬线体、全屏铺一张 `chat_backdrops` 背景剧照（v12 新增表，一个角色一张，由对话触发生成）。偏好存 `kimage.immersive`，仅 chat 页生效。

---

## 7. 设计系统

规范见 `doc/整体设计风格.md`（可复用版），落地在 `src/style.css` 的 `:root`（全站字号/颜色/间距只在那里定义一处）。要点：

- **理念**：克制 · Editorial · 内容优先——让能力隐藏，让过程自然。
- **色彩**：暖白/暖黑打底，完整灰度阶梯 + 四级文字灰；**全站只有一个强调色（墨色）**，深色反相；彩色严格分工——金（`--ai-halo`）只报「机器在跑」，红只用于危险，粉紫渐变只标画布 AI 入口（注：画布已移除，该语义可能已无载体）。
- **排版**：系统字体栈；字标自托管 Poppins + Pacifico（只引 latin）；字阶按角色命名；输入框 ≥16px；全大写微标签加宽字距。
- **组件**：卡片无边框 + 圆角 + 接触影、图片全出血；按钮主/次/图标三档，一屏一个实心；在途有呼吸光晕；破坏性给 4.5s 撤销条；结果提示挂全局层。
- **布局/响应式**：统一栏宽、毛玻璃顶栏、明暗面分层不靠边框；三档语义断点 **860 / 720 / 640px**。
- **动效/无障碍**：一套主缓动 + 时长分层，只动 `opacity/transform`；全站 `:focus-visible` 兜底、浮层焦点陷阱与归还、`prefers-reduced-motion` 下取消位移；最弱文字约 4.6:1。

---

## 8. 现存文档的遗留不一致（值得修）

旧版三篇「KImage」文档（`项目梳理` / `优化建议` / `优化计划`）**已于 2026-10-12 删除**。现存 10 篇 Kairo 专属功能设计文档（角色 / 对话 / 发图 / 沉浸 / 情感 / 提示词组装 / 配图构图 / API 配置 / 整体风格）是当前的设计依据；以下是它们与代码之间仍存在、值得修的不一致：

1. **IndexedDB 版本**：文档散见 v9 / v11 / v12 的说法，代码实到 **v13**（`lib/idb.ts` 的 `DB_VERSION`）。
2. **`covers` 表**：提示词库页面已移除，但该表仍在 `idb.ts` 中——需确认是否可清掉或标注弃用。
3. **`sourceRef` 注释**：`types.ts` 注释称 `sourceRef`「也含从作品提升为参考的那一张」，但作品提升功能全仓不存在，仍未修。
4. **`--ai-halo` 粉紫渐变语义**：设计系统写「只标画布 AI 入口」，但画布已移除，该语义已无载体，需重新指派或删除。
5. **「这个站没有路由」的旧前提**：`沉浸式对话页面设计.md` 曾以「无路由」论证返回键行为；hash 路由（`lib/router.ts`）已落地，该前提失效，相关段落需复核。
6. **引用方式**：文档大量用「文件 + 行号」引用，行号随代码漂移，建议改为「符号名」（函数 / 常量）。

> 已删除的三篇旧文档里仍然成立的内容（数据分层、后端协议与厂商适配、NDJSON 流式、长期记忆、TTS 回退、四套 AbortController、删除即撤销、错误中文化、SSRF 防护、设计系统），已并入本文相应章节，可继续作为依据。

---

## 9. 健康度（本次实测）

| 项 | 状态 |
| --- | --- |
| `vue-tsc --noEmit` | ✅ **零报错**（实跑） |
| `vitest run` | ✅ **19 文件 / 624 用例全过**（实跑） |
| 构建产物 | ✅ `dist/` 可生成 |
| 本地探针脚本 | ✅ `check:server` / `smoke:api` / `probe:chat-photo` |
| 单测 / E2E | ✅ 纯逻辑单测已补全（idb/providers/chatPhoto/photoDirector/ui/payload/router 等） |
| Lint / 格式化 | ❌ 无配置 |
| CI | ❌ 无 `.github/` |
| README | ❌ 无（`doc/` 多份中文设计文档 + `types.ts` 注释承担入门角色，但缺一份「怎么跑 / 数据在哪 / 密钥在哪」的入口） |
| 文档准确性 | ⚠️ 现存 10 篇 Kairo 设计文档，仍有若干遗留不一致（见 §8） |

---

## 10. 观察与建议（优先级）

**P0 · 数据安全（仍要核）**
1. 回归 `pruneHistory` 是否保护 `marked` 标记图（未确认已修）；若未修，标记图会在空间紧张时被静默删。
2. 确认 `covers` 表与提示词库相关代码确已无引用，避免死表与误导。

**P1 · 文档与真相对齐（最高性价比）**
3. ~~把三篇旧 KImage 文档标记为历史档案~~ —— 已于 2026-10-12 直接删除；本文即现状入口。
4. 修掉 §8 列的具体不一致：DB 版本（v13）、`sourceRef` 注释、粉紫渐变语义。
5. 文档引用从「文件+行号」改为「符号名」（函数/常量），行号只当辅助——代码每天都在动，行号必然漂移。

**P2 · 工程健康**
6. 加 README（只需「怎么跑、需要什么、数据存在哪、密钥在哪、本地优先的信任边界」）+ 最小 CI（跑 `typecheck + test + build`）。这两项今天就能补，收益高。
7. 补 Lint/格式化（项目已 2.7 万行量级，无 lint 会持续累积风格债；先 `eslint --no-fix` 摸底）。
8. 超大组件仍可拆：`CharacterPage.vue`（~148KB）、`ChatPage.vue`（~143KB）、`SettingsPage.vue`（~66KB）、`HistoryPage.vue`（~48KB）—— 但优先级低于文档与 CI，因为状态已抽 composables，组件主要是模板+样式，风险可控。

**P3 · 安全与部署（按需）**
9. 公开部署 = 无鉴权的开放代理：若上公网，需加共享密钥 / 上游域名白名单 / 默认仅本机。
10. 限流是内存滑窗，Serverless 下等于无全局配额；真要防滥用需外部存储。
11. API Key 明文在 localStorage：设置页应明说「本地优先意味着 Key 在浏览器里」，并可选「仅本次会话保存」。

**P4 · 产品与体验**
12. 界面文案全英文、注释与文档全中文：若面向中文用户，建议统一或引入轻量 i18n。
13. 历史页无虚拟滚动、首屏一次性读全库、老记录 `backfillThumbs` 占 CPU——老库大了会有感知，但非阻塞，排期靠后。

---

## 11. 一页速查（现状）

| 维度 | 结论 |
| --- | --- |
| 是什么 | 本地优先的超拟人**对话**工作台（对话 / 角色 / 历史 / 设置）；由生图工作台 KImage 裁剪而来 |
| 架构 | Vue 3 SPA（无路由库、无 Pinia；自建 hash 路由 + composables）+ Express 代理（68 行装配 + `routes/` 五模块） |
| 数据 | localStorage 存目录；IndexedDB `kimage.db` v13 多表存字节；80% 水位自动清理 |
| 后端 | 5 类路由（generate/enhance/chat/tts/test），统一多家厂商；错误中文化、SSRF 防护、无服务端密钥 |
| 核心链路 | 角色（正脸为锚 + 五张设定图）；对话（NDJSON 流式 + 长期记忆 + 情绪 + 朗读）；**对话发图**（六层拼装）；**沉浸式对话**（全屏背景） |
| 设计 | 一个强调色、字阶按角色、三档断点、在途有呼吸、删除可撤销 |
| 健康 | typecheck 零报错、624 用例全过；**无 CI / 无 README / 无 lint**；三篇旧文档已过时 |
| 首要动作 | 标记旧文档为历史 + 用本文作入口 → 补 README/CI → 核 prune 是否保护 marked |
