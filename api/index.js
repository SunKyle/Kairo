// Vercel Serverless 入口：复用 server/index.js 导出的 Express app
export { app as default } from '../server/index.js'