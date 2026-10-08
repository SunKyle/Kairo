import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ON_SERVERLESS, assertSafeTarget, safeFetch, isBlockedAddress } from './core.js'
import { registerGenerateRoute } from './routes/generate.js'
import { registerEnhanceRoute } from './routes/enhance.js'
import { registerChatRoute } from './routes/chat.js'
import { registerTtsRoutes } from './routes/tts.js'
import { registerTestRoutes } from './routes/test.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '../dist')

const app = express()
if (ON_SERVERLESS) {
  app.set('trust proxy', 1)
}

// 单次请求体的上限。别只改这一处,下面还有一条把它翻成人话的错误处理
const JSON_LIMIT = '15mb'
// 不挂 cors():前端与 /api 同源(本地走 vite 代理),不需要 CORS;
// 挂着反而会让任意网站都能借用这个代理发请求
app.use(express.json({ limit: JSON_LIMIT }))

// 注册各业务领域模块化路由
registerGenerateRoute(app)
registerEnhanceRoute(app)
registerChatRoute(app)
registerTtsRoutes(app)
registerTestRoutes(app)

// 兜底错误处理
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'The request body is too large',
      detail:
        `Payload exceeded ${JSON_LIMIT}. For local editing, use an image under 2560px on the longest edge, ` +
        'or export as JPEG instead of PNG to stay within limits.'
    })
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'The request body is not valid JSON' })
  }
  return next(err)
})

// 生产模式：托管构建后的前端静态文件（dist 存在时）
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(DIST, 'index.html'))
  })
  console.log('[Kairo] 已托管前端静态文件:', DIST)
}

// Vercel：导出 app 供 serverless 使用
export { app, assertSafeTarget, safeFetch, isBlockedAddress }

// 本地直接运行时才监听端口（Vercel 场景会被 import，不监听）
const isEntry =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isEntry) {
  const port = process.env.PORT || 3100
  app.listen(port, () => {
    console.log(`[Kairo] 后端已启动: http://localhost:${port}`)
  })
}