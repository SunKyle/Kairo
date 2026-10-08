# API 配置管理设计

> 本文总结 KImage 中「接口配置（ApiConfig）」的管理设计。
> 相关实现集中在这几处：
> - [SettingsPage.vue](../src/components/SettingsPage.vue) —— 设置页：列表、表单、连通性测试
> - [useConfigs.ts](../src/composables/useConfigs.ts) —— 五类配置的状态、挑选、激活、增删改与导入
> - [App.vue](../src/App.vue) —— 参数面板、对比出图、出图侧的接线
> - [api.ts](../src/api.ts) —— 厂商能力表、读写、域名推断、连通性测试
> - [server/index.js](../server/index.js) —— `/api/test` 探活、按厂商/协议转发
> - [types.ts](../src/types.ts) —— `ApiConfig`

---

## 1. 核心设计原则

1. **一个列表，五种用途。** 所有配置放在同一个 `configs[]` 里，靠 `kind` 区分用途：`image`（出图）/ `text`（提示词改写）/ `chat`（角色对话）/ `vision`（识图）/ `tts`（朗读）。它们要填的模型不是一回事，但地址与密钥常常同源 —— 所以同列表、分区展示。
2. **五类各记各的「当前生效」。** 出图、改写、对话、识图、朗读各有独立的 active id 与生效快照，**存一条不该把别类的当前项顶掉**。唯一的例外是对话那一类：**没专配时借用改写那条**（见 §5.4）—— 借用是活的，那边换了模型这边立刻跟着换。
3. **草稿与生效值分离。** 设置页表单改的是自己的草稿副本，不直接写父级的生效配置 —— 于是「返回列表」是真正的放弃修改，而不是把半成品留在生效配置里。
4. **能力表驱动界面。** 支持哪些参数、尺寸候选、图生图端点、走哪套协议，全部由 [PROVIDERS](../src/api.ts#L130-L183) 声明，界面按它决定显示什么、代理按它决定打哪个端点。加厂商只改一处。
5. **数据只在本机。** 配置存 localStorage，不上传（密钥也一样）。

---

## 2. 数据模型

`ApiConfig`（[types.ts](../src/types.ts#L1-L16)）：

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `name` | 显示名。空着时落库按域名推导（`cfgNameFromUrl`） |
| `baseUrl` | 如 `https://ark.cn-beijing.volces.com/api/v3`。**只有它是必填** |
| `apiKey` | 密钥。本地服务可留空 |
| `model` | 模型名 / 推理接入点 id（如 `ep-2024…`） |
| `vendor` | 厂商 id，决定能力表与协议。可选是为了兼容加字段之前的老配置，读取时按域名回填 |
| `kind` | `'image' \| 'text' \| 'chat' \| 'vision' \| 'tts'`。可选，读取时一律按 `image` 兜底（见 §3.2 的白名单） |

---

## 3. 存储与读写

### 3.1 localStorage 键

| 键 | 内容 |
| --- | --- |
| `kimage.apiConfigs` | 全部配置列表（JSON） |
| `kimage.apiActive` | 出图类别当前生效配置 id |
| `kimage.apiActiveText` | 改写类别当前生效配置 id |
| `kimage.apiActiveChat` | 对话类别当前生效配置 id。**空串是常态** —— 没专配过对话模型时，角色对话借用改写那条 |
| `kimage.apiActiveVision` | 识图类别当前生效配置 id |
| `kimage.apiActiveTts` | 朗读类别当前生效配置 id |
| `kimage.apiConfig` | **旧键**（单份配置格式），迁移后删除 |

### 3.2 读写（[api.ts#L336-L410](../src/api.ts#L336-L410)）

- `loadConfigs()`：读列表，逐条过 `normalizeConfig`；读不到新键时回退读**旧键**，搬成列表后写回新键，并**把旧键删掉** —— 一份密钥在站点上存两处不该是长期状态。删除单独兜一层：它失败不该把这次迁移一起判死。
- `saveConfigs(list)`：整表覆盖写。
- `normalizeConfig()`：补 `vendor`（没有就按域名猜）、规整 `kind`。用途**从四处长到五处之后不再写成一串嵌套三元**，而是收成一张白名单 `KNOWN_KINDS` + `asConfigKind()`：认得出的原样返回，其余（缺字段、外部文件里的脏数据、以后降级回来的写法）一律 `image` —— 加字段之前存的都是出图配置，而不认识的值既不该让配置错类，也不该让它消失。导入那一侧（`importConfigs`）走同一个函数。

五个 active id 各有 `loadActiveXxxId` / `saveActiveXxxId`。

---

## 4. 厂商能力表

### 4.1 Provider 与 Cap（[api.ts#L31-L128](../src/api.ts#L31-L128)）

`Cap = 'yes' | 'no' | 'unknown'` —— `unknown` 表示"填了就发"，既不假装支持也不假装不支持；**只拦明确知道的**（如 OpenAI Images API 没有 `seed`）。

| 字段 | 作用 |
| --- | --- |
| `quality` / `background` / `seed` / `multiImage` | 能力开关，界面据此决定给不给控件 |
| `sizes` / `autoSize` | 尺寸候选 / 有没有"模型自决"这一档 |
| `edit` | 图生图打 `generations` 还是 `edits` |
| `protocol` | `openai`（/images/generations）或 `gemini`（原生 `:generateContent`） |

各厂商要点：
- **OpenAI**：`quality/background` 支持；`seed` 不支持；`multiImage` 支持；尺寸随模型代次细分。
- **Doubao Seedream (Ark) / 通义万相 (DashScope)**：参数大多不支持；**单图**（`multiImage: 'no'`）；`sizes: 'free'` 且 **无 auto 档**。
- **Gemini**：走原生协议；`quality/background` 不支持（多给未知字段会被 Google 拒）；`multiImage` 支持（parts 里并列多段 inlineData）。
- **Custom**：兜底项，未知一律按"不确定"处理，照常展示但不静默丢弃。

### 4.2 按 (厂商, 模型) 解析

`getProvider(id, model)`：能力表**不只看厂商还看模型** —— 中转站自己就是看模型名决定后端的，我们必须跟它一致（同一个地址上 OpenAI 系走 `/images/generations`，Gemini 系走原生 `:generateContent`，判错会打到对方不实现的那条路）。`custom` + 模型名命中 `GEMINI_IMAGE_RE`（`gemini|imagen|banana|nano-banana`）时改判 Gemini。

### 4.3 域名推断（`inferVendor`）

老配置没有 `vendor` 时按域名猜。**`gemini` 必须排在 `openai` 前面**：Gemini 的 OpenAI 兼容层地址是 `…/v1beta/openai`，含 "openai"，顺序反了会把尺寸候选、门控、协议全按错的那家来。只认 `generativelanguage`（AI Studio），**故意不认 `aiplatform.googleapis.com`**（那是 Vertex，鉴权与模型名都不是一套）。

### 4.4 三份预设表

| 表 | 服务于 | 内容 |
| --- | --- | --- |
| `PROVIDERS` | 出图 | 含完整能力表与协议 |
| `TEXT_PROVIDERS` | 改写 **+ 角色对话** | 只要 `id / label / baseUrl / model?`。DeepSeek 只在这份里（它没有出图模型，给出图那行放它等于骗人） |
| `VISION_PROVIDERS` | 识图 | 同上；要的是"能看图的对话模型"，百炼同样走 compatible-mode |

> 百炼要单列一条：它的 `/api/v1` 是原生协议，对话得走 `/compatible-mode/v1`，填错会 404。
> **改写与对话共用一张表**：它们要的就是同一种东西（一个能走 `/chat/completions` 的对话模型），地址也同源；分成两张一样的表只会让同一条地址抄两遍、改一处漏一处。"两者该分开配"是**用途**上的判断（改写的模型按"哪家出的图更好看"挑，对话的模型按"聊起来像不像个人"挑），不是预设内容上的差别。
> 改写、对话、识图共用同一个回填函数 `applyTextProvider`（预设行不同，填法一样）。
> 朗读自成一档（`TTS_PRESET`，只有火山一家）：它连协议都不是 OpenAI 兼容那套。

---

## 5. 五类用途与「当前生效」

### 5.1 状态（[useConfigs.ts](../src/composables/useConfigs.ts)）

| 状态 | 含义 |
| --- | --- |
| `configs: ApiConfig[]` | 全部配置 |
| `config` | 出图当前生效的**副本**（生成请求照它发） |
| `activeId` | 出图当前生效 id |
| `textConfig \| null` | 改写当前生效副本；`null` = 列表里还没有文本配置 |
| `chatOwnConfig \| null` | **专配的**对话配置（`kind = 'chat'`）。它没有才借改写那条 |
| `chatConfig` | 对话实际要发出去的那条 = `chatOwnConfig ?? textConfig` |
| `chatBorrowed` | 现在用的是不是借来的。对话页那枚模型药丸据此说清来源 |
| `activeTextId` / `activeChatId` / `activeVisionId` / `activeTtsId` | 各类当前 id |
| `cfgView` / `cfgSeed` | 设置页视图（list/form）与表单种子 |

拷贝而不是引用：改设置页表单不会动生效值，只有存下 / 设当前才会。

### 5.2 启动挑选（onMounted）

每类各一套"按存的 id 找 → 落空退第一条 → 都没有则保持空/`null`"：
- 出图：`pickActiveByKind(list, 'image', activeId)` → 落空退第一条同类；回填 `activeId`（存着的 id 可能指向已删的配置，不同步的话设置页一条都不会亮）；
- 改写 / 识图 / 朗读：同构，没有则 `null`（增强按钮 / 角色向导 / 朗读会各自降级或提示）；
- 对话：挑不到时**什么都不做** —— `chatConfig` 自己退回改写那条。这里不能像别类那样"没有就置空"：要置空的是"专配的那一条"，而借用的那一截跟着 `textConfig` 走。

> 挑选的谓词一律是 `configKindOf(c) === kind`，**不写 `kind !== 'text'` 那类否定式**。否定式每加一类就要补一笔，漏掉的那一类会被并进出图那一组（`tts` 就这么漏过一次，`chat` 差点第二次）。

### 5.3 重挑（repickActive*）

删除、改用途、另一个标签页动了配置三条路共用。**不收拾的话生效值会悬空** —— 界面显示着它，它却已经发不出请求：
- `repickActiveImage`：按用途取第一条，没有就清空并写回空 id；
- `repickActiveText` / `repickActiveVision` / `repickActiveTts`：同构，没有则置 `null`；
- `repickActiveChat`：挑不到就清掉 `chatOwnConfig` 并写回空 id —— **不是 null**，而是回到"借改写那条"。

### 5.4 对话为什么可以借

角色对话与提示词改写在这次拆分之前**本来就是同一条配置**（都是 `/chat/completions` 上的一个对话模型）。直接断开，等于让每一个存量用户下次进对话页都被拦一句"去配一条" —— 而他要的只是"接着说"。

所以定成：**专配的优先，没有就借改写那条**，并且：

| 决定 | 为什么 |
| --- | --- |
| `chatConfig` 是 computed，不是与 `textConfig` 并列的 ref | 借必须是**活的**：用户在设置页把改写换了个模型，对话这边不必再挑一次就跟着变 |
| 界面要说出来（对话页药丸上的 `from enhancing`） | 不说的话用户会以为它已经独立配过了 —— 而"它到底走的哪个模型"正是这次拆分要解决的问题本身 |
| 导入配置时只在本地还没专配过才认一条对话配置 | 判断依据是 `chatOwnConfig` 而不是 `chatConfig`（后者永远不为空）。借用状态下随手认一条现成的，等于把用户自己挑的模型换掉 |
| 借用状态**不写盘** | 写下去就成了一份快照，改写那边再变它就不跟了 —— 那正是"借"要避免的 |

---

## 6. 设置页

骨架与提示词库、历史页一致（标题行 → 内容），两个视图：

### 6.1 列表视图

- **一张纸，不是一组卡片**：大圆角 + 弥散投影；分组只用一条两端各留 12px 的细线分开（横贯整张纸的线会把纸切成两半，与"有呼吸感"的分隔语言不搭）。
- **按用途分五组**（`groups`）：`Image generation` / `Role chat` / `Prompt enhancing` / `Image recognition` / `Voice`，空组直接滤掉。每组各自比自己的 activeId 判「Current」。对话排在出图之后：它是这一站的第二条主线（造一个角色，然后跟它说话），而改写与识图都是围着出图转的辅助。
- **行本体是 `<button>`**：整行可点 = 把这条设为该类的当前生效。**动作随组带着走**（`groups` 里每项一个 `on(c)`），模板里只写一份行 —— 五类之后那串"按 key 再分一次类"的嵌套三元已经读不出谁是谁。状态列定宽 68px，所有行的名字从同一条竖线起排。
- **Current 徽标**：当前生效那条在状态列放一枚墨色实心药丸；其余留空 —— "现在走的是哪条"不读名字就能扫到。
- **行内副标题 = 模型 · 厂商**（`identLine`），地址不再出现在列表里（编辑表单里本来就有）。
- **⋮ 溢出菜单**（Edit / Duplicate / Delete）：常态 `opacity: 0`，行 hover / 聚焦 / 展开时显形 —— 三个常驻方形图标键正是"管理后台"味道的来源。触屏没有 hover，用 `@media (hover: none)` 让它常驻。菜单用 `role="group"` 而非 `menu`（`menu` 承诺方向键导航，这里只有 Tab，声明成 `menu` 等于许了做不到的事）。
- **删除一次点击即删**：删完有一条燃烧的撤销窗口兜着，比多一步确认更可逆。
- 标题行：**New config**（黑药丸）+ 一个 ⋮ 菜单（**Export JSON (includes key)** / **Import configs**，低频动作不给标题行添按钮）。

### 6.2 空态：四条能一键预填的入口

- 第一排：`PROVIDERS` 前三条（跳过 custom）+ **My own endpoint**；
- 第二排（单独起一排）：`VISION_PROVIDERS` —— 它解决的是另一个问题（把上传的参考图读成角色设定），混在第一排里会被当成又一个出图选项；
- 副标题写清"会替你填好的地址与模型"（`quickHint` / `endpointLine`），地址与模型由厂商表推导，界面不抄第二份。

> **对话与改写不给空态入口**，这不是漏了：它们与出图是同一条路上的后续（先出图，才谈得上改写与开聊），而且**一条都没有时对话会借改写那条**，所以新用户不必先配两条才能说话。真正需要专配的人会在对话页头部看见那枚写着 `from enhancing` 的药丸，点它直接落到一张"用途 = 对话"的表单上（见 [角色对话功能设计.md](角色对话功能设计.md) 的"模型药丸"一节）。

### 6.3 表单视图（新增 / 编辑）

字段顺序即决策顺序：

1. **What is this config for?** —— 五个带说明的单选项（Image generation / Role chat / Prompt enhancing / Image recognition / Voice）。用途决定后面所有字段的含义，所以给几行说明而不是一排只有名字的胶囊。
2. **Provider 预设行** —— 随用途切换数据源（图像 / 对话 / 视觉 / 语音）。**对话与改写共用 `TEXT_PROVIDERS`**：它们要的就是同一种东西（一个能走 `/chat/completions` 的对话模型），地址也同源；分成两张一样的表只会让同一条地址抄两遍、改一处漏一处。
3. **Name**（可选，空着按域名推导）
4. **Base URL**（唯一的必填，提交前校验）
5. **API Key**（默认 `password`，右侧有显隐键）
6. **Model**（placeholder 随用途变）

用途那一排下面那句说明（`purposeNote`）逐类写清它会被发到哪条路上（`/images/generations` / `/chat/completions` / `/api/v3/tts/…`）—— 这是用户唯一能一眼看到"它会走哪条路"的地方。写成一处 `switch`，不是模板里那串嵌套三元：五类之后那串已经要数着缩进读。

表单**收窄并居中**（`max-width: 720px`）：单行输入拉到 900px 宽会读得很散。列表则铺满（两侧徽标与菜单正好互为对边）。

### 6.4 草稿与预设回填（[SettingsPage.vue#L112-L174](../src/components/SettingsPage.vue#L112-L174)）

- `watch(props.seed)`（immediate）灌草稿：seed 变了就重置一次；顺手**收回密钥显隐**（上一条的状态不该带过来）并**清掉上一条的报错**（留着会被挂在刚打开的那条配置上）。
- `setPurpose(kind)`：只切 `kind` 并换预设行。**保留已填的 `baseUrl` / `apiKey`**（地址与密钥常常同源，用户可能刚填好）；`model` **只在与新用途不在同一个"模型命名空间"时才清空**（`modelSpace()`，见 §6.6）—— 图像模型名拿去打 `/chat/completions` 必错，反过来也一样，所以跨界要清；而改写 / 对话 / 识图之间要填的是同一种东西，清掉净是坑。
- `applyProvider(p)`：**只补空，不覆盖** —— 换厂商常常只是想换个能力表或协议，而地址多半是自己粘的中转或自建接口，被预设覆盖掉就得重新找一遍。空着的字段才用预设补上。
- `applyTextProvider(p)`：地址照写（高亮比的就是地址，它是身份），模型只补空，**`vendor` 也要写下去** —— 它本来只在出图那条路上被写，于是文本配置的 `vendor` 一直是 `custom`，从 DeepSeek 换成 OpenAI 也照样顶着「接线」图标。**改写 / 对话 / 识图三类共用这一个函数**（预设行不同，填法一样）。
- 预设高亮 `presetOn`：直接比地址（忽略尾斜杠与大小写），不为了高亮再存一个状态。

> 与"新增配置"空态那四条入口区分：那条路走 `seedFor`，直接给一张填好的表（"从零开始"的语义），不受"只补空"约束。

### 6.5 提交校验

- 必填只有 `baseUrl`；空 → "paste the endpoint your provider gave you, e.g. …"；
- 必须能 `new URL()` 且协议为 `http(s)`；
- 报错**顶掉说明行**，不叠成两段小字；`role="alert"`（异步判定出来的，读屏要主动念）。
- **模型名空着只警告、不拦**（`.field-warn`）：本地服务或自建中转未必看这个字段，替用户判定是越权；但后果是确定的（这条配置发不出任何请求），所以用与 `.field-err` 同一档的颜色当场说清。
- 列表里同样把它写出来：`identLine` 在这种配置上渲染成 `No model name · OpenAI`（`tts` 例外 —— 它那一档本来就是可选的 `Auto`）。原先那一行会只剩下厂商名，和"配好了"长得一模一样 —— 用户"明明配了、它却说没配"的第一现场就在这里。

### 6.6 切换用途时模型名怎么处理（`modelSpace`）

"要不要清空模型名"看的是**命名空间**，不是用途本身：

| 空间 | 用途 | 说明 |
| --- | --- | --- |
| `image` | 出图 | 图像模型名 |
| `chat` | 改写 / **对话** / 识图 | 三者的请求都是 `/chat/completions`，同一个名字在它们之间至少是个候选 |
| `tts` | 朗读 | 上游只认那两个枚举值 |

跨空间 ⇒ 清空（留着必然误导）；同一空间内 ⇒ 留着。

这条改过一次，记下原因：起初的写法是"任何一次用途变更都清空"，理由是"改写与对话要的虽然同类，但用户多半想换一个"。**那个理由站不住**：一个很自然的动作是打开原来那条改写配置、把用途改成 `Role chat`（就像"给对话单独配一条"的字面意思），这时模型名被悄悄抹掉，存下来就是一条 `model: ""` 却带着「Current」的配置 —— 报错要到下一次开口才出现，而且回的是服务端那句 "Set a text model in API settings first"，与用户看到的界面直接矛盾。用一个"看起来更干净"的默认值换一次静默的坏数据，不划算。

---

## 7. 连通性测试

[testConnection](../src/api.ts#L426-L462) → `POST /api/test`。

### 7.1 服务端策略（[server/index.js#L1086-L1216](../server/index.js#L1086-L1216)）

按顺序两条：
1. **GET /models** —— 顺带回答"目标模型在不在它的清单里"。两条协议回法不同：OpenAI 是 `{ data: [{ id }] }`，Gemini 是 `{ models: [{ name: 'models/xxx' }] }`；
2. **缺参探测**（那家没有 `/models`）—— 发一个空请求打真实端点，上游因缺参数回 400/422，**400 恰好证明地址、路径与密钥这条链是通的**。不会真的生成图，所以点几次都不花钱。

探活的端点是真实的那个：出图打 `/images/generations`；**改写 / 对话 / 识图都打 `/chat/completions`**（三者都是对话模型，识图只是消息里多带一张图）；朗读另走 `/api/v3/tts/…`。前端只按"是不是出图"分了一次（`configKindOf(config) === 'image'` 之外一律按对话探），不逐个列举 —— 列举每加一类就要补一笔。

### 7.2 结果结构

`TestResult = { ok, code?, via?, modelListed?, status, ms, detail? }`
- `code`：`auth`（密钥被拒）/ `endpoint`（没有这个端点）/ `server`（上游自己出错）/ `network` / `timeout`；
- `via`：`models`（走 GET /models）或 `probe`（退回探测）。

### 7.3 文案翻译（`testMessage`）

服务端只回机器可读的 `code/status`，怎么说由前端定：
- 成功且 `via='models'` 时多说一句模型在不在清单里；**不在也不算失败**（清单常常列不全），只在中性色里提一句并写明生成仍可能可用；
- `server` 且 `status < 400` 时特判：地址少了 `/v1` 前缀时网站会把首页当 200 回，"answered 200"只会让人困惑 → 说成 "Answered with a web page instead of an API response"；
- 耗时 <1000ms 写 `xx ms`（局域网几十毫秒回来，写成 "0.0s" 会显得没测一样）。

### 7.4 前端一致性保护

- **草稿一动就清掉测试结果**：结果只对"当前这一版草稿"有效，留着上一次的 "Connected" 会让人以为新地址也验过了；
- **代次 + 快照**（`testSeq` + `sameDraft`）：用户可能在等待中改了草稿、切走或再点一次 —— 回来时对不上代次 / 快照就丢弃，避免"测的是 A，提示却说 B 可用"。

---

## 8. 增删改与导入导出

### 8.1 增 / 改（[saveSettings](../src/composables/useConfigs.ts)）

按 `id` 判断插入还是覆盖；`name` 空着按 `cfgNameFromUrl` 推导。要点：

- **改用途必须从原那一侧退场**：记下 `prevKind`，若与新的 `kind` 不同，原侧的「当前」要重挑 —— 否则那边还留着它改之前的快照，界面说"当前用它"，实际发出去的却已经不是一回事。出图侧还要把它从多选集合里摘掉。**从对话改成别的用途时，对话随即退回借改写那条**（`repickActiveChat`）。
- **按用途分派到各自的「当前」**：五类各自独立。同步的是**副本**（`{...cfg}`），之后改表单草稿不能再牵动生效值。
- 出图侧还要维护多选集合：新建一条时直接收敛成只选它；改一条已有的缺了才补上（不能把正在做的多模型对比打散），已选满则同样收敛。
- 留在列表视图：刚存下的那条会带「Current」标记，比直接跳走更容易确认。

### 8.2 新增 / 复制 / 编辑入口

| 入口 | 行为 |
| --- | --- |
| `newConfig(seed?)` | 进入表单；`seed` 为厂商预填（空态四条入口带）/ `null` 为空白 |
| `duplicateConfig(c)` | `{...c, id: '', name: 'xxx copy'}` → 表单 |
| `editConfig(c)` | `{...c}` → 表单 |
| `cancelConfig()` | 回列表（**真正的放弃修改**，草稿是页面自己持有的） |

### 8.3 删除（[removeConfig](../src/composables/useConfigs.ts)）

- 立即改列表 + 按用途重挑各类「当前」（删的可能是五类里任意一条）；
- 从多选集合摘掉它（留着会让长度算错：剩两条其实只剩一条，却仍被当成对比模式），摘完一个不剩就退回当前这条；
- 落盘推迟到撤销窗口结束；撤销时用**"当前列表 + 插回这一条"**而不是整份旧快照（窗口里万一改了别的配置，不该被一起回滚），并恢复「当前生效」指向。

### 8.4 导入（[importConfigs](../src/composables/useConfigs.ts)）

外部文件逐条规整：
- 没有 `baseUrl` 的丢掉（存下来也发不出请求）；
- **id 撞了就换新**，并维护一份"这次已用掉的 id"（只跟现有列表比不够：map 期间 `configs` 不变，同一文件里两条同 id 会双双通过）；
- `kind` 过 `asConfigKind`（与读入口同一张白名单），认不出的当 `image`；
- **追加而不是覆盖**（导入是补充）；
- 原本一条都没配时，顺手把导入里第一条出图配置设为当前（否则导完照样发不出请求）；文本 / 识图 / 对话两侧同理，缺哪条补哪条 —— 对话那条的判据是 `chatOwnConfig`（**专配的那一条**）而不是 `chatConfig`（它借了改写那条，永远不为空）。

### 8.5 导出 / 导入文件

- 导出（`exportJson`）：把 `configs` 原样写成 JSON，**包括 API Key**。菜单上直接写明 "includes key" —— 不带 Key 的备份没有意义（换台机器导回去还要一条条补），别让人以为导出的是脱敏版本。
- 导入（`onImportFile`）：只负责读文件、`Array.isArray` 校验，内容规整交给主界面（它才知道现有 id 有哪些）。选错文件就当作没选，不打断。

---

## 9. 参数面板与对比出图

### 9.1 面板分组（[App.vue#L2829-L2889](../src/App.vue#L2829-L2889)）

参数面板按用途分三组，各自标各自的"当前"：

| 组 | 交互 |
| --- | --- |
| Image model | **芯片即多选**：点一下加入/移出这次生成 |
| Text model | 单选（点了就设为当前）—— 它管的是提示词改写 |
| Vision model | 单选 —— 它不进"这次跑哪几个模型"的选择集合，只在角色向导里读参考图、以及对话里附了图的那一轮 |

> **对话模型刻意不进这块面板**。它原来就是这里的 "Text model"：想换个聊起来更像个人的模型，得跑到生图那一侧去动 —— 而那两件事的诉求本来不同。现在它在设置页的 `Role chat` 分组与**对话页头部那枚药丸**上（见 [角色对话功能设计.md](角色对话功能设计.md)）。朗读（`tts`）同样不在面板里，它归角色页的音色区。

### 9.2 多选即对比（Model Race）

- **没有单独的"对比"开关**：芯片本来就是多选，选一个 = 平时那样，选两个以上 = 对比模式（`compareMode`）；
- `RACE_MAX = 4`（花费线性增长，四个已经排满一屏）；选满后其余芯片禁用，`title` 说明原因；
- `toggleSelectedId`：**至少留一个**（一个都不选，生成键就无事可做）；卸掉的正好是主模型时，顺位给剩下的第一个 —— 尺寸候选、画质门控、改写风格都照主模型来，不能让"当前"指向一个已经不在选择里的配置。

### 9.3 能力表驱动的门控

- `provider`：按 `(vendor||inferVendor, model)` 解析能力表；
- `capabilityNote`：**描述的是当前生效的接口，不是表单里正在挑的** —— 参数栏的门控跟的是生效配置，说明文字要是跟着草稿走两者就对不上。Gemini 的图生图没有独立端点（参考图是同一个 `:generateContent` 里的另一段 parts），所以要特判；
- `sizeOptions`：候选随厂商（以及 OpenAI 模型代次）变化；**上游没有 auto 档就把这一项摘掉** —— 留着会让界面显示"自动"，而请求里根本带不了这个参数（带了就 400），看起来像"模型没按 prompt 定比例"，其实是我们自己把这一档抹掉了；
- `watch(sizeOptions)`（immediate）换厂商 / 换模型后自动回退到第一个合法尺寸。

### 9.4 状态胶囊

- `activeConfigName`：名字优先，未配置显示占位；
- `imagePillName`：多选时写成「主模型 +N」—— 点一下就从单模型变成多模型，加选一个会变成一次双倍花费，不写明就有意外；
- `selectionTip` / `selectionAria`：同时报出出图与文本两个当前模型。

---

## 10. 关键约定与易错点

1. **五类「当前」互不隶属**：`activeId` / `activeTextId` / `activeChatId` / `activeVisionId` / `activeTtsId` 各存各的，任何一条的读取、保存、删除、改用途都要按类别处理，不能一刀切。**唯一的例外是对话**：没有专配时它活借改写那条（`chatConfig = chatOwnConfig ?? textConfig`）。
2. **挑选的谓词一律正面认**（`configKindOf(c) === kind`），不写 `kind !== 'text'` 那类否定式：每加一类就要补一笔，漏掉的那一类会被并进出图（`tts` 漏过一次，`chat` 差点第二次）。分组、参数面板、历史配方的配置还原都照这一条。
3. **`inferVendor` 里 Gemini 必须排在 OpenAI 前面**（`/v1beta/openai` 含 "openai"，顺序反了会全按错的那家来）。
4. **非出图配置的 `vendor === 'custom'` 不可信**（字段是后加的，旧数据里都是 custom）——`vendorId()` 对这几类会按域名重新认一次；出图配置不动，那里的 custom 是用户明确选的。
5. **能力表按 (厂商, 模型) 解析**，不是只看厂商：中转站按模型名决定后端，我们必须跟它一致。
6. **`unknown` ≠ 不支持**：只拦明确知道的（如 OpenAI 的 seed、Ark/万泉的多图），其余"填了就发 / 能发就发"。
7. **导入 id 必须换新**，且要维护本次已用 id 集合。
8. **导出不脱敏**，这一点写在菜单文案里。
9. **生效值是副本**：表单草稿、多选集合、尺寸 / 画质 / 背景的门控都读生效配置，改草稿不应牵动它们。
10. **"有配置" ≠ "配全了"**：少了模型名（或地址）的配置发不出任何请求，而它在界面上处处像是配好了 —— 列表里顶着「Current」、参数胶囊写着名字。所以凡是"能不能开口 / 这一轮发不发"的判据一律看 `model && baseUrl`：对话页的输入区与重试门控、`runChat` / `regenerateChat`、以及后台的记忆压缩（那里还要多一层，否则每轮白花一次注定失败的调用）。别让请求走到服务端去撞那句 "Set a text model in API settings first" —— 那句话说不出是哪条配置，与用户手里的界面也直接矛盾。

---

## 11. 一句话回顾

> 一个列表装五类接口，各记各的「当前」（对话那类没专配时活借改写那条，并在界面上说出来）；能力表按 (厂商, 模型) 声明差异，界面按它决定露出什么、代理按它决定打哪个端点；表单管草稿、生效值用副本，于是"返回"就是真的放弃；连通性靠真实端点上的空请求验活，点几次都不花钱。
