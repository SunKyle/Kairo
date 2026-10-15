# Kairo

本地优先的 AI 角色陪伴应用。角色有稳定的人格与视觉形象，能记住你说过的事，可以聊天、发图、出声。

**你的所有数据都在自己的浏览器里** —— 没有账号、没有云同步、没有服务端数据库。详见[信任边界](#信任边界)。

---

## 快速开始

需要 **Node 20+**（CI 跑的是 20）。

```bash
npm install
npm run dev
```

- 前端：<http://localhost:5181>
- 后端：<http://localhost:3101>

两个端口是固定的（`strictPort`，被占用直接报错退出，不会悄悄换一个）。vite 把 `/api` 代理到 3101，所以前端与接口同源、不需要 CORS。

首次打开是一个空库。**先去 `Settings → AI connections` 添一条接口配置**（选厂商 → 填 Key → 选模型），否则对话、生图、语音都发不出去。

### 可选：出站代理

访问被阻断的境外接口（OpenAI、Cloudflare 上的中转站等）时需要显式配代理——Node 的 `fetch` **不会**自动使用 macOS 的系统代理。

```bash
cp .env.example .env   # 若无此文件，直接新建 .env
```

```ini
UPSTREAM_PROXY=http://127.0.0.1:7890
```

这是**唯一**的环境变量，只影响出站请求。注意 `NO_PROXY` 有默认值（`localhost,127.0.0.1,volces.com,bytedance.com,aliyuncs.com`）——一旦你自己设了 `NO_PROXY`，就是**整份覆盖**，记得把国内域名带上，否则火山语音会被拉到境外节点绕一圈。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 同时起后端与前端 |
| `npm run dev:web` / `dev:server` | 只起其中一个（后端带 `--watch`） |
| `npm run dev:lan` | 允许局域网访问，手机调试用（**见下方警告**） |
| `npm run typecheck` | `vue-tsc --noEmit` |
| `npm test` | 全量单测（vitest） |
| `npm run test:watch` | 单测 watch 模式 |
| `npm run check:server` | 服务端「用到的名字有没有出处」——`tsconfig` 只覆盖 `src/**`，`server/**` 平时不过任何类型检查 |
| `npm run lint` | ESLint（只覆盖 `src/` 与 `server/`，理由见 `eslint.config.js`） |
| `npm run smoke:api` | 每个端点打一遍，并断言**进程仍然活着** |
| `npm run probe:chat-photo` | 对话出图端到端探针（假上游，不花钱、不联网） |
| `npm run build` | `typecheck` + `vite build` |
| `npm run preview` | 预览构建产物 |

## 数据在哪

全部在**当前这个浏览器 profile** 里，按用途分两层：

| 层 | 位置 | 装什么 |
| --- | --- | --- |
| 轻量目录 | `localStorage`，键前缀 `kimage.` | 角色档案、接口配置与当前启用项、集合、相处偏好、主题、沉浸开关 |
| 字节与记录 | `IndexedDB`，库名 `kimage.db`，当前版本 **v14** | 设定图与作品、对话消息、对话图片、记忆条目、长期简报、语音样本与缓存、聊天背景、角色心情 |

`kimage.db` 现有 10 张表：`history` / `chars` / `chat_messages` / `chat_images` / `chat_summaries` / `tts_cache` / `voice_samples` / `chat_backdrops` / `char_moods` / `memories`。

**要留意的三件事：**

1. **换浏览器、换设备、清站点数据 = 数据没了。** 没有云端兜底，这是本地优先的直接代价。
2. **存储占用超过 80% 时会自动清掉最旧的一批作品**（`lib/idb.ts` 的 `HIGH_WATER`）。这是防撑爆浏览器的兜底，不是 bug——重要作品请及时导出。
3. 应用会主动申请 `navigator.storage.persist()`，降低浏览器在磁盘紧张时清掉本站数据的概率，但**它不保证**。

### 怎么备份 / 迁移

- **单个角色**：角色卡右上角 `⋮` → 导出，得到一份 zip（含设定图与对话）。
- **接口配置**：`Settings → AI connections` → 导出 JSON。**这份不脱敏，里面就是明文 API Key** ——菜单上也是这么写的，因为不带 Key 的备份换台机器导回去还得一条条补。

## 密钥在哪

- API Key 存在**浏览器的 `localStorage`**（键 `kimage.apiConfigs`），**不在服务端、不进仓库**（`.env` 也已被 `.gitignore` 挡住）。
- 每次请求由前端把 Key 一并交给**本机的** Express 代理，代理转发给上游，用完不落盘。
- 所以：**这台机器上任何能打开 DevTools 的人都能看到 Key。** 共用电脑请留意。

## 信任边界

这一节是本项目的核心设计约束，不是免责声明。

**架构上**

- 无账号、无服务端数据库、无云同步。所有用户数据留在浏览器本地。
- 后端只是一个**本机代理**：浏览器直连上游模型 API 会撞 CORS，所以由它转发。
- **它没有鉴权。** 默认只监听 localhost（vite 不设 `host` 即为 localhost）。

> ⚠️ **不要把后端或 `npm run dev` 暴露到公网。** 挂上去等于把本机这个上游代理借给任何人——对方可以用你的 Key 打上游。
>
> `npm run dev:lan` 会把 `/api` 代理一并暴露给**同网段的任何设备**，只在可信网络里用，用完切回 `npm run dev`。

**服务端护栏**

- `assertSafeTarget` 在 production / serverless 环境下拒绝私有与保留地址（SSRF 防护）。开发环境默认放行私有目标（`ALLOW_PRIVATE_TARGETS`），因为要连本机服务。
- **故意不挂 CORS 中间件**：前端与 `/api` 同源，本来不需要；挂上反而会让任意网站借用这个代理。
- 请求体上限 15 MB，超限返回 413 并附「怎么把图压小」的说明。

**客户端**

- 需要一个支持 IndexedDB 的现代浏览器（Chrome / Edge / Safari 新版本）。
- 语音的浏览器音色回退依赖 Web Speech API，可用性随浏览器而异；TTS 失败会自动回退并说明。

## 测试与 CI

CI 在 `.github/workflows/ci.yml`，分两个 job，因为「对不对」和「有没有变慢变胖」红的意义完全不同：

**`check`** —— `typecheck` → `check:server` → `lint` → `test` → `build` → `probe:chat-photo` → 起后端 → `smoke:api`

其中 `check:server` 与 `smoke:api` 专门盯一类问题：模块化之后**一个漏掉的 import 不是「坏一条路」，而是整个 Node 进程退出**——那时所有端点都只回 `ECONNREFUSED`，从单个请求的返回码上根本看不出是这个原因。`lint` 管的是这两步都看不到的另一类：声明了却没用的变量、永远走不到的赋值。

**`perf`** —— 构建 → `vite preview` → `scripts/measure-history.mjs`，钉 DOM 节点数与铺完耗时，外加跨标签页 / 配置 / 画布 / 历史 / 角色 / 对话 / 参数面板的探针。

本地跑等价检查：

```bash
npm run typecheck && npm run check:server && npm run lint && npm test && npm run probe:chat-photo && npm run build
```

## 目录结构

```
src/
  lib/          纯逻辑层（无 Vue 依赖，必须有单测）
  composables/  状态编排（useXxx(deps) → refs + 函数）
  components/   视图
  App.vue       只做装配
server/
  routes/       chat / enhance / generate / tts / test
  core.js       SSRF 护栏、safeFetch、代理
scripts/        探针与冒烟脚本
doc/            设计文档与路线图
```

约定：**纯逻辑进 `src/lib/` 且必须有单测**；composable 只做状态编排；`App.vue` 只做装配，不写业务。

## 文档

`doc/` 下按主题分：产品需求对齐与路线图（`PRD对齐与后续路线图.md`）、架构设计与评审、角色创建 / 对话 / 情感系统 / 配图等设计文档。**路线图是排期的唯一依据**，涉及产品口径的争议回 PRD 原文核对。
