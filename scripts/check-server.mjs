#!/usr/bin/env node
/* ===== 服务端模块的"接线"检查 ==========================================
   为什么需要单独一条:`tsconfig.json` 的 include 只有 `src/**`,
   `server/*.js` 平时**不过任何类型检查**;而 `node --check` 只查语法。
   于是"拆分模块时漏了一个 import"这种错两条路都看不见 ——
   它只在真的打到那个端点时,以"整个 Node 进程退出"的形式暴露
   (2026-10-06:tts.js 引用本该属于它的 normalizeResourceId,一次语音请求
   就让后端死掉,前端只看到 500 → ECONNREFUSED)。

   所以这里只盯一件事:**用到的名字有没有出处**(TS2304 / TS2552)。
   其余错误一概不管,它们不是这条检查要回答的问题:
   - TS2307(node: 内置模块)、TS2580(process 这类全局)—— 项目没装
     @types/node,这两类是必然的噪声;
   - 其它 checkJs 对无类型 JS 的推断噪声(例如 Gemini 请求体的字面量收窄)。

   用法:npm run check:server
   -------------------------------------------------------------------- */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TSC = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

/* 只挑真正参与运行的模块:index 是入口,core 是共享层,routes/* 是各业务域 */
const routes = readdirSync(path.join(root, 'server', 'routes'))
  .filter((f) => f.endsWith('.js'))
  .sort()
  .map((f) => path.join('server', 'routes', f))
const files = ['server/index.js', 'server/core.js', ...routes]

const res = spawnSync(
  process.execPath,
  [
    TSC,
    '--noEmit',
    '--allowJs',
    '--checkJs',
    '--target', 'es2022',
    '--module', 'node16',
    '--moduleResolution', 'node16',
    '--skipLibCheck',
    ...files
  ],
  { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
)

const out = `${res.stdout || ''}${res.stderr || ''}`
const lines = out.split('\n').filter((l) => l.includes('error TS'))

/* 这两条码就是"这个名字没有出处"。TS2552 是它的"你是不是想写…"变体 */
const MISSING = /error TS(2304|2552):/
const bad = lines.filter((l) => MISSING.test(l))
const rest = lines.filter((l) => !MISSING.test(l))

console.log(`检查 ${files.length} 个文件（${files.join(', ')}）`)
console.log(`  未定义的名字: ${bad.length} 处`)
console.log(`  其它(与本次检查无关，已忽略): ${rest.length} 处`)

if (bad.length) {
  console.log('\n未定义的名字 —— 用到却没 import / 没定义：')
  for (const l of bad) console.log('  ✗ ' + l.replace(root + '/', ''))
  console.log('\n这类错会在**请求打到那一行时**让整个进程退出，而不是只错那一条路。')
  process.exit(1)
}
console.log('\n✅ 所有用到的名字都有出处')
