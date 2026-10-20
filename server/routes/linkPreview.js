import { rateLimit } from '../core.js'
import { normalizeHttpUrl } from '../chatAttachments.js'
import { previewLink } from '../linkPreview.js'

/* 链接卡片的预览。它是**异步补全**，不是聊天完成的必经之路：
   前端先把模型给的标题画出来，这一条回来了再把描述补上；
   失败也只是卡片少一行字，绝不该让一条已经收到的回复变成错误。 */
export function registerLinkPreviewRoute(app) {
  app.post('/api/link-preview', rateLimit, async (req, res) => {
    const url = normalizeHttpUrl(req.body?.url)
    if (!url) {
      return res.status(400).json({ error: 'Not a valid public http(s) link' })
    }
    try {
      const data = await previewLink(url)
      return res.json(data)
    } catch (e) {
      return res.status(502).json({
        error: 'Could not preview this link',
        detail: e instanceof Error ? e.message : String(e)
      })
    }
  })
}
