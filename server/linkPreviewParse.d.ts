/* 服务端纯 JS 模块的声明,好让单测带着类型引用它
   (与 chatTags.d.ts / chatAttachments.d.ts 同一条理由) */

export interface LinkPreviewData {
  title: string
  description: string
  siteName: string
}

/** 从 HTML 里读 og / twitter / title / description;url 只用于兜底站点名 */
export declare function parseLinkPreview(html: string, url: string): LinkPreviewData
