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
 *  卡片上的字有**两个来源**,先后有别:
 *  - 模型给的 title / subtitle —— 发出去那一刻就有,所以卡片当场就能画;
 *  - 服务端读回的 preview(页面标题、og:description、站点名)—— 晚一步到,
 *    比模型那句更准,到了就盖在上面(见 useChatFlow 的 fillAttachmentPreview)。
 *  preview 只对 link 走:music 的曲名歌手本就是模型给的,不该被网页标题盖掉。
 *  预览没到/取不到时 link 卡仍完整:标题 + 域名 + 能点的地址。
 *
 *  这里**不拉 og:image**:一张外部图片会让"打开对话"顺带把浏览痕迹送给
 *  对方站点,而这一站是本地优先的。卡的重量靠排版与站内既有的边框语言,
 *  不靠一张缩略图。
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
/* 顶部那行"这是哪儿":link 用站点名/域名;music 只在带地址时露出平台域名 */
const eyebrow = computed(() => {
  if (!isLink.value) return host.value
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
    :class="{ 'is-plain': !clickable }"
    :href="clickable ? url : undefined"
    :target="clickable ? '_blank' : undefined"
    :rel="clickable ? 'noopener noreferrer' : undefined"
  >
    <span class="link-ico" aria-hidden="true">
      <component :is="isLink ? PhLinkSimple : PhMusicNote" />
    </span>
    <span class="link-body">
      <span v-if="eyebrow" class="link-site">{{ eyebrow }}</span>
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
/* 触屏没有悬停,给的是一按就有的反馈;这里只留底色那一档,不加位移动画 */
@media (prefers-reduced-motion: reduce) {
  .msg-link,
  .link-out {
    transition: none;
  }
}
</style>
