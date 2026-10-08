/* ===== 送出去编辑的载荷有多大 ==========================================
   局部编辑(画布那条链路)是本站**唯一**会把整幅位图放进请求体的地方,
   而它走的是 JSON + data URL —— base64 再把体积放大三分之一。

   实测(见 doc/优化计划.md 的 T1.1,数据由 Pillow 生成同类内容测得):
   | 内容      | 3840×2160 PNG | 2560×1440 PNG | 2560×1440 JPEG |
   | 照片类    | 27.8 MB       | 12.4 MB       | 2.7 MB         |
   | 截图类    |  0.04 MB      |  0.02 MB      | 1.1 MB         |

   两个结论直接决定了这里的常量:
   1. 4K 全分辨率 PNG 是 27.8MB,而服务端的请求体上限是 15MB —— 必然失败;
      而厂商的编辑结果本身有上限(gpt-image-1 最大 1536,本站给的档位最大
      2560),送 4K 进去换不到更大的结果,只是把这次编辑撑失败。
   2. PNG 与 JPEG 谁更省**取决于内容**:照片类 JPEG 省 4.6 倍,
      截图类 PNG 省 50 倍。所以不能一刀切换格式,得按内容选(见 CanvasEditor
      的 encodeAt:带透明的只能 PNG,其余按预算挑)。
   -------------------------------------------------------------------- */

/** 编辑载荷的长边上限。取本站给的档位里的最大值 —— 再大也换不到更大的结果 */
export const EDIT_PAYLOAD_EDGE = 2560

/**
 * 喂给模型的**参考图**统一长边上限(图生图、"照此再创作"、角色识图都走它)。
 *
 * 为什么与编辑载荷差这么多(1024 对 2560):参考图只是"告诉模型长什么样/是什么",
 * 它不需要还原细节,缩小几乎不影响结果;而编辑载荷是"要在这一块上动手"的底图,
 * 缩小会直接体现在成品上。两者的取舍不同,所以是两个数,不是一个。
 *
 * 这个数以前在四处各写了一遍(首页参考图、画布的 REF_EDGE、角色识图的
 * VISION_MAX_EDGE、compressImage 的默认参数),改一处不会带动其余三处。
 */
export const REF_IMAGE_EDGE = 1024

/** 只作"当时用了哪张参考图"的复现凭据、或列表缩略图时用的尺寸。
 *  它进 IndexedDB,体积直接影响能存多少条历史,所以比 REF_IMAGE_EDGE 更省 */
export const REF_ARCHIVE_EDGE = 512

/** 载荷预算:两份 data URL 加起来的字节数超过它就换更省的格式/再缩一档。
 *  留出足够余量:服务端上限 15MB,预算 8MB 让任何情况下都不会贴边 */
export const EDIT_PAYLOAD_BUDGET = 8 * 1024 * 1024

/** 两段载荷都编完之后,还允许再缩几档(每档 ×0.7) */
export const PAYLOAD_SHRINK_FACTOR = 0.7

/** 缩到多小就不缩了。再小等于把用户的图糊掉,宁可让他知道这次没成 */
export const PAYLOAD_SHRINK_FLOOR = 0.25

/**
 * 一个 data URL 实际占多少字节。
 *
 * 只算正文、按 base64 的 3/4 折算 —— 头部那几十字节不影响判断,而这个数会被
 * 用在"要不要再编一次"的循环条件里,所以它必须便宜。
 * 退化输入(没有逗号)一律当作"整串都是 base64 正文"来估,不抛异常。
 */
export function dataUrlBytes(url: string): number {
  const comma = url.indexOf(',')
  const body = comma < 0 ? url.length : url.length - comma - 1
  // base64 每 4 个字符还原 3 字节;结尾的 '=' 填充会略微高估,方向是安全的
  return Math.floor((body * 3) / 4)
}

/** 长边超过上限时该按多大比例缩。不放大(比例绝不超过 1) */
export function payloadScaleFor(
  width: number,
  height: number,
  maxEdge = EDIT_PAYLOAD_EDGE
): number {
  const longest = Math.max(width, height)
  if (!Number.isFinite(longest) || longest <= maxEdge) return 1
  return maxEdge / longest
}

/** 还太大时再退一档。退到下限之下就返回 null,表示"不再缩了" */
export function shrinkScaleFor(
  scale: number,
  factor = PAYLOAD_SHRINK_FACTOR,
  floor = PAYLOAD_SHRINK_FLOOR
): number | null {
  const next = scale * factor
  return next < floor ? null : next
}

/** 这几段载荷加起来是否超预算 */
export function payloadOverBudget(urls: string[], budget = EDIT_PAYLOAD_BUDGET): boolean {
  let total = 0
  for (const u of urls) total += dataUrlBytes(u)
  return total > budget
}
