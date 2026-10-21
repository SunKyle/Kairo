<script setup lang="ts">
import { computed } from 'vue'
import { PhArrowUpRight, PhLinkSimple, PhMusicNote } from '@phosphor-icons/vue'
import type { ChatAttachment } from '../types'
import { attachmentHost } from '../lib/chatAttachments'

/* 一条消息转过来的那张卡片。目前两种:link(一个网页)与 music(一首歌)。
 *
 *  link **整张卡就是一个 <a>** —— 点哪儿都打开,不用先瞄准一行字。链接卡片
 *  常见的毛病是把标题做成链接、把其余部分做成死区,手指在手机上总会点空。
 *  music 常常**没有地址**(纯分享一首它在放的歌),那就成一张不能点的卡:
 *  去掉 <a>、去掉外链箭头,只留曲名与歌手 —— 一张点不开的卡不该假装能点。
 *
 *  两种卡的"身份"不共用同一枚图标:link 左上是那个小方块里的链条,music 则是
 *  **一张画出来的黑胶**——槽纹、中心贴纸、贴纸上的音符都在 CSS 里,不引封面图。
 *  一张歌卡如果只把音符塞进同一个方块,读起来仍是"又一个链接";唱片是能一眼认出的
 *  "这是一首歌"的物件。不拉第三方封面还有一层好处:打开对话不会顺带把请求送到
 *  那个音乐站(与下面不拉 og:image 同一条理由),离线也照常成立。
 *
 *  卡片上的字有**两个来源**,先后有别:
 *  - 模型给的 title / subtitle —— 发出去那一刻就有,所以卡片当场就能画;
 *  - 服务端读回的 preview(页面标题、og:description、站点名)—— 晚一步到,
 *    比模型那句更准,到了就盖在上面(见 useChatFlow 的 fillAttachmentPreview)。
 *  preview 只对 link 走:music 的曲名歌手本就是模型给的,不该被网页标题盖掉。
 *  预览没到/取不到时 link 卡仍完整:标题 + 域名 + 能点的地址。
 *
 *  这里**不拉 og:image**:一张外部图片会让"打开对话"顺带把浏览痕迹送给
 *  对方站点,而这一站是本地优先的。卡的重量靠排版与那张画出来的唱片,
 *  不靠一张缩略图。
 *
 *  歌卡整张是**磨砂玻璃**:半透明底 + backdrop blur。普通对话的底是一块平色,
 *  它只会比实白面暖一档;到了沉浸页(底是一张照片)才真正透出后面的光。
 *  link 卡仍走实底 —— 它的任务是把一个网页的标题与描述说清楚,不该让底下的
 *  照片干扰阅读。玻璃只在歌卡上,是这张卡"轻"的那一面。
 */
const props = defineProps<{ attachment: ChatAttachment }>()

const isLink = computed(() => props.attachment.kind === 'link')
const url = computed(() => props.attachment.url || '')
/** 有地址才可点。music 没地址时退化成一张分享卡 */
const clickable = computed(() => url.value !== '')
const host = computed(() => attachmentHost(url.value))

/* 主标题:link 优先用读回来的页面标题(更准),music 只用模型给的那句曲名 */
const title = computed(() =>
  isLink.value ? props.attachment.preview?.title || props.attachment.title : props.attachment.title
)
/* 顶部那行"这是哪儿"只属于 link:站点名/域名 */
const eyebrow = computed(() => {
  const site = props.attachment.preview?.siteName || host.value
  return site && site.toLowerCase() !== host.value.toLowerCase() ? `${site} · ${host.value}` : host.value
})
/* 标题下面那行:link 是页面描述/模型副标题;music 是歌手(subtitle) */
const subline = computed(() =>
  isLink.value
    ? props.attachment.preview?.description || props.attachment.subtitle || ''
    : props.attachment.subtitle || ''
)
</script>

<template>
  <component
    :is="clickable ? 'a' : 'div'"
    class="msg-link"
    :class="{ 'is-plain': !clickable, 'is-music': !isLink }"
    :href="clickable ? url : undefined"
    :target="clickable ? '_blank' : undefined"
    :rel="clickable ? 'noopener noreferrer' : undefined"
  >
    <span v-if="isLink" class="link-ico" aria-hidden="true">
      <PhLinkSimple />
    </span>
    <!-- 黑胶:槽纹是底色上的一圈圈细线,中心贴纸压在上面,音符印在贴纸里。
         全部用主题 token 画,深浅两套各自反相,不需要第二张图 -->
    <span v-else class="music-disc" aria-hidden="true">
      <PhMusicNote class="music-disc-note" />
    </span>
    <span class="link-body">
      <span v-if="isLink && eyebrow" class="link-site">{{ eyebrow }}</span>
      <span class="link-title">{{ title }}</span>
      <span v-if="subline" class="link-desc">{{ subline }}</span>
    </span>
    <PhArrowUpRight v-if="clickable" class="link-out" aria-hidden="true" />
  </component>
</template>

<style scoped>
/* 与角色那条气泡同一条左边线、同一档宽度上限(320px / 76%)——
   它挂在同一条消息下面,不该比那句话宽出一截,也不该另起一列 */
.msg-link {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  max-width: min(320px, 76%);
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  /* 实底而不是透明的:沉浸页底下是一张照片,透明卡片会散在画面里读不出来 */
  background: var(--surface);
  color: var(--text);
  text-decoration: none;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
a.msg-link:hover {
  background: var(--surface-hover);
  border-color: var(--line-strong);
}
a.msg-link:focus-visible {
  outline: 2px solid var(--line-strong);
  outline-offset: 2px;
}
/* 不能点的分享卡(music 没地址):不抢 hover 反馈,也不给手指样光标 */
.msg-link.is-plain {
  cursor: default;
}
/* 歌卡比链接卡松半档:左边换成一张 46px 的唱片,文字那一列垂直居中。
   曲名与歌手的落差靠字号,不再靠"同一枚小图标"糊在一起。
   卡面是磨砂玻璃:半透明底 + 背景虚化,而不是又一块实白板 ——
   普通对话里它只是比白面略暖一档,到了沉浸页(底是一张照片)才真正透出光来。
   贴纸那张盘仍是实心:玻璃上得有一个实的物件压住,不然整张卡会飘 */
.msg-link.is-music {
  align-items: center;
  gap: 12px;
  padding: 11px 13px 11px 12px;
  background: color-mix(in srgb, var(--surface) 66%, transparent);
  border-color: color-mix(in srgb, var(--line-strong) 42%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--surface) 72%, transparent),
    0 8px 24px color-mix(in srgb, var(--accent) 7%, transparent);
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
}
/* 不能虚化的浏览器退回实底:宁可没有玻璃感,也不能让字直接落在照片上 */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .msg-link.is-music {
    background: var(--surface);
  }
}
/* 悬停时玻璃更实一点、边更清楚一点:它要说明"这张卡能点",
   而不是把底下的照片擦得更亮 */
a.msg-link.is-music:hover {
  background: color-mix(in srgb, var(--surface) 78%, transparent);
  border-color: color-mix(in srgb, var(--line-strong) 58%, transparent);
}
/* 左边一枚小方块:给这张卡一个"这是转来的东西"的锚点,
   与消息里的图、气泡一样是站内已有的抬高语言 */
.link-ico {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
  color: var(--text-3);
}
.link-ico svg {
  width: 15px;
  height: 15px;
}
/* 画出来的黑胶。底色是 --accent,槽纹是 --surface 兑出来的一圈圈细线 ——
   深浅两套主题里两者正好反相,所以暗色下自然变成"浅色盘 + 深色贴纸",
   不用为它单独写一套 dark 规则。
   inset 那圈极淡的亮边把唱片从卡片底上"切"出来,不然暗色下盘缘会糊掉 */
.music-disc {
  position: relative;
  flex: none;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background:
    repeating-radial-gradient(
      circle at 50% 50%,
      transparent 0 2.2px,
      color-mix(in srgb, var(--surface) 18%, transparent) 2.2px 2.9px
    ),
    var(--accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--surface) 12%, transparent);
  transition: transform var(--dur) var(--ease);
}
/* 中心贴纸:比整张盘小一圈,留出槽纹的宽度 */
.music-disc::before {
  content: "";
  position: absolute;
  inset: 14px;
  border-radius: 50%;
  background: var(--surface);
}
/* 贴纸上的音符。它跟着贴纸反相:浅色主题是白贴纸印黑音符,
   暗色主题是深贴纸印白音符 */
.music-disc-note {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 11px;
  height: 11px;
  color: var(--accent);
  transform: translate(-50%, -50%);
}
/* 能点的歌卡,悬停/聚焦时唱片轻轻抬一点 —— 盘面是同心圆,转起来看不见;
   缩放才是这枚物件唯一读得出来的"它醒了"。不能点的卡不给这个反馈 */
a.msg-link.is-music:hover .music-disc,
a.msg-link.is-music:focus-visible .music-disc {
  transform: scale(1.05);
}
.link-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  /* 没有它,长标题会把卡片撑出上限而不是省略 */
  min-width: 0;
  /* 右上角那枚箭头的位置 */
  padding-right: 12px;
}
/* 站点那一行是"这是哪儿",字号最小、颜色最弱 —— 与消息里的时间戳同一档 */
.link-site {
  overflow: hidden;
  color: var(--text-3);
  font-size: var(--fs-micro);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 标题是这张卡的主句:最多两行。卡片的宽是固定的,三行会把一条消息拉得很长 */
.link-title {
  display: -webkit-box;
  overflow: hidden;
  font-size: var(--fs-sm);
  font-weight: 600;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
/* 描述比标题再弱一档,同样封两行 —— 它只是"点进去大概会看到什么" */
.link-desc {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-2);
  font-size: var(--fs-xs);
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
/* 曲名比链接卡的标题大半档:一张歌卡只有曲名与歌手两行内容,
   标题还压在同一档 13px 上,整张卡就只剩那枚唱片在撑 */
.msg-link.is-music .link-title {
  font-size: var(--fs-md);
  line-height: 1.35;
}
/* 歌手只封一行:它是"谁唱的",不是一段描述。长名字省略,不把卡片撑高 */
.msg-link.is-music .link-desc {
  line-height: 1.4;
  -webkit-line-clamp: 1;
}
/* 外链箭头:静止时很淡,悬停才实 —— 它只是提示"会离开这一页",
   不是第二枚可点的东西(整张卡都是那个链接) */
.link-out {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 13px;
  height: 13px;
  color: var(--text-3);
  transition: color var(--dur) var(--ease);
}
.msg-link:hover .link-out {
  color: var(--text);
}
/* 触屏没有悬停,给的是一按就有的反馈;这里只留底色那一档。
   唱片那一下 1.05 的缩放是卡上唯一的位移,减弱动效时一并收掉 */
@media (prefers-reduced-motion: reduce) {
  .msg-link,
  .link-out,
  .music-disc {
    transition: none;
  }
  a.msg-link.is-music:hover .music-disc,
  a.msg-link.is-music:focus-visible .music-disc {
    transform: none;
  }
}
</style>
