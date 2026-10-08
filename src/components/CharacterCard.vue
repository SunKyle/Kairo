<script setup lang="ts">
import {
  PhArrowRight,
  PhCalendar,
  PhClockCounterClockwise,
  PhCopy,
  PhDotsThreeVertical,
  PhDownloadSimple,
  PhMaskHappy,
  PhPencilSimple,
  PhPushPin,
  PhSparkle,
  PhTrash
} from '@phosphor-icons/vue'
import type { Character } from '../types'

/* 角色海报卡:顶图全出血铺满整张卡,底部渐变暗幕托起白字;
 *  无边框、靠阴影浮起,圆角 24px。
 *
 *  **它只做展示与动作上报** —— 卡片排在哪、菜单开着没有、
 *  每格用量怎么算,全由角色页交进来;按下某一项也只是把"按了哪一项"报回去。
 *  真正的开详情、复制、导出、删除都留在父组件(与那一页其余部分同一条分工)。
 *
 *  卡里有两个动作:点空白处进详情(一张透明覆盖按钮),以及
 *  "Chat with this character" 直接拿这个角色进对话 ——
 *  按钮不能嵌在按钮里,所以整卡命中区改成覆盖式的一层,内容区透传点击。
 *  右上角那枚 ⋮ 是 .ctile-main 的兄弟节点(菜单朝上开时要靠它定位),
 *  所以它不动 .ctile-main 的悬停位移。 */
defineProps<{
  char: Character
  /** 封面图的可渲染 src(空字符串 = 这个角色还没有图,画占位图标) */
  cover: string
  /** 特征胶囊上的那几个词 */
  traits: string[]
  /** 用这个角色出过几张图 */
  imageCount: number
  /** 建卡那天、最后用它的那天(已经是给人看的那句) */
  createdLabel: string
  updatedLabel: string
  /** ⋮ 菜单开着没有(同一时刻只开一个,所以由父组件按 id 判) */
  menuOpen: boolean
  /** 菜单朝上开:末行的卡片用它,不然菜单会伸到视口外 */
  menuUp: boolean
}>()

const emit = defineEmits<{
  /* 点空白处进详情 */
  (e: 'open', id: string): void
  /* 拿这个角色进对话:跳到对话页并选中它,由父组件负责跳转 */
  (e: 'chat', id: string): void
  (e: 'pin', id: string): void
  (e: 'edit', id: string): void
  (e: 'duplicate', id: string): void
  (e: 'export', id: string): void
  (e: 'remove', id: string): void
  /* 开合由父组件按当前状态决定;要带上这一下的事件,菜单朝上还是朝下
     得按按钮当时在视口里的位置算(见父组件的 toggleCardMenu) */
  (e: 'toggle-menu', id: string, ev: MouseEvent): void
  /* 指针进出:菜单要给一点宽限才收起(鼠标从 ⋮ 挪到菜单上不该算离开)。
     离开那一下要把事件带出去 —— 父组件按 pointerType 判断是不是鼠标:
     触摸设备上手指抬起也会触发 pointerleave,那不是"移开" */
  (e: 'menu-enter'): void
  (e: 'menu-leave', ev: PointerEvent): void
}>()
</script>

<template>
  <article class="ctile">
    <div class="ctile-main">
      <!-- 顶图:绝对铺满,海报式取景 -->
      <span class="ctile-img">
        <img v-if="cover" :src="cover" alt="" loading="lazy" decoding="async" />
        <span v-else class="ctile-ph" aria-hidden="true">
          <PhMaskHappy />
        </span>
      </span>

      <!-- 文本贴底排列。毛玻璃与暗幕都是这一层自己的 ::before(见样式),
           所以玻璃永远贴着信息区,和卡片多大无关。
           pointer-events 由 CSS 透传,只有下面的 CTA 例外 -->
      <span class="ctile-content">
        <!-- 名字与快捷开画同一行:名字占满剩余,按钮靠右收在末尾 -->
        <span class="ctile-head">
          <span class="ctile-name">{{ char.name }}</span>
          <!-- 快捷进对话:拿这个角色直接跳到对话页,省掉"进详情→记住名字→
               切到对话页→再选一次"那条绕路。
               卡最窄只有 260px,一行里放不下整句,所以按钮上只写 Chat ——
               完整含义留在 aria-label 里,读屏拿得到 -->
          <button
            class="ctile-cta"
            :aria-label="`Chat with ${char.name}`"
            @click="emit('chat', char.id)"
          >
            <span>Chat</span>
            <PhArrowRight class="ctile-cta-ico" aria-hidden="true" />
          </button>
        </span>
        <span v-if="traits.length" class="ctile-chips">
          <span v-for="t in traits" :key="t" class="chip">{{ t }}</span>
        </span>

        <!-- 用量:三格 + 竖向分隔,白字压在暗幕上。
             全是真数(从历史记录按 characterId 聚合,见父组件的 charStats) -->
        <span class="ctile-stats">
          <span class="cstat">
            <span class="cstat-h">
              <PhSparkle class="cstat-ico" aria-hidden="true" />
              <span class="cstat-v">{{ imageCount }}</span>
            </span>
            <span class="cstat-k">images</span>
          </span>
          <span class="cstat">
            <span class="cstat-h">
              <PhCalendar class="cstat-ico" aria-hidden="true" />
              <span class="cstat-v">{{ createdLabel }}</span>
            </span>
            <span class="cstat-k">created</span>
          </span>
          <span class="cstat">
            <span class="cstat-h">
              <PhClockCounterClockwise class="cstat-ico" aria-hidden="true" />
              <span class="cstat-v">{{ updatedLabel }}</span>
            </span>
            <span class="cstat-k">updated</span>
          </span>
        </span>
      </span>

      <!-- 整卡命中区:透明,压在内容之下,点空白处进详情 -->
      <button
        class="ctile-open"
        :aria-label="`Open ${char.name}${char.pinned ? ' (pinned)' : ''}`"
        @click="emit('open', char.id)"
      ></button>
    </div>
    <!-- 置顶的角标常驻在左上角(右上角那枚是 ⋮)。
         它只说明状态,动作在 ⋮ 菜单里 —— 角标本身不做成按钮:
         卡片上已经有一层铺满的命中区,再叠一个可点的圆钮只会抢点击 -->
    <span v-if="char.pinned" class="ctile-pin" aria-hidden="true">
      <PhPushPin weight="fill" aria-hidden="true" />
    </span>
    <!-- 图右上角一枚 ⋮:复制 / 导出 / 删除都收在它后面。
         三枚圆钮常驻太吵,窄屏上还会占掉整条上沿(小卡只有约 176px 宽) -->
    <div
      class="ctile-menu menu-wrap"
      :class="{ open: menuOpen }"
      @pointerenter="emit('menu-enter')"
      @pointerleave="emit('menu-leave', $event)"
    >
      <button
        class="ctile-dots"
        :aria-label="`More actions for ${char.name}`"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        @click.stop="emit('toggle-menu', char.id, $event)"
      >
        <PhDotsThreeVertical aria-hidden="true" />
      </button>
      <div v-if="menuOpen" class="menu" :class="{ up: menuUp }" role="menu">
        <button class="mitem" role="menuitem" @click.stop="emit('pin', char.id)">
          <PhPushPin :weight="char.pinned ? 'fill' : 'regular'" aria-hidden="true" />{{
            char.pinned ? 'Unpin' : 'Pin'
          }}
        </button>
        <button class="mitem" role="menuitem" @click.stop="emit('edit', char.id)">
          <PhPencilSimple aria-hidden="true" />Edit
        </button>
        <button class="mitem" role="menuitem" @click.stop="emit('duplicate', char.id)">
          <PhCopy aria-hidden="true" />Duplicate
        </button>
        <button class="mitem" role="menuitem" @click.stop="emit('export', char.id)">
          <PhDownloadSimple aria-hidden="true" />Export
        </button>
        <button class="mitem danger" role="menuitem" @click.stop="emit('remove', char.id)">
          <PhTrash aria-hidden="true" />Delete
        </button>
      </div>
    </div>
  </article>
</template>

<style scoped>
/* 海报卡:固定 3:4 比例,无边框,圆角 24px,overflow 让图与暗幕切出弧形 */
.ctile {
  position: relative;
  min-width: 0;
  /* 悬停时整张卡抬起一点。位移必须挂在这一层,不能挂 .ctile-main:
     右上角那枚 ⋮ 菜单是 .ctile-main 的兄弟节点,挂在内层就只有卡片自己动、
     菜单原地不动。影子仍归 .ctile-main(它是那张有圆角的卡面),各归各。
     4px 是刚好看得见、又不至于跳出来的一档 */
  transition: transform var(--dur) var(--ease);
}
.ctile:hover {
  transform: translateY(-4px);
}
.ctile-main {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  padding: 0;
  border-radius: var(--r-lg);
  overflow: hidden;
  background: var(--image-bg);
  /* 卡片本身要有一点"浮在纸面上"的分量:
     一枚贴边的接触影让四边站得住 + 系统那道柔和弥散影。
     接触影用纯黑(与 --sh-* 同一套语言),深浅主题都成立 */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
  text-align: left;
  cursor: pointer;
  transition: box-shadow var(--dur) var(--ease);
}
/* 只换影子是"变重",不是"浮起来" —— 补一点位移才有离开纸面的分量 */
.ctile-main:hover {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-md);
}
/* 顶图:绝对铺满,object-fit cover;hover 轻微放大制造呼吸 */
.ctile-img {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.ctile-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 700ms var(--ease);
}
.ctile-main:hover .ctile-img img {
  transform: scale(1.045);
}
.ctile-ph svg {
  width: 34px;
  height: 34px;
}
/* —— 毛玻璃 + 暗幕 ——
   只有一层 ::before,挂在信息区自己身上,不是按卡片高度的百分比铺。
   卡片是 3:4 比例,一变宽就变高,而信息区的高度基本是固定的 ——
   按百分比铺的话,卡越大玻璃就越比文字高出几倍(之前几轮一直调不准就是这个)。
   锚在信息区上,玻璃就永远贴着文字那一块,卡片多大都一样。

   为什么必须是"一层":暗幕曾经拆成独立的 ::after(横跨整卡宽度的矩形),
   想靠两个元素的边界错位做出"模糊比变暗伸得更远"。
   结果就是露出一个淡淡的矩形 —— 两个矩形叠在一起,
   各自的收口位置不重合,轮廓就显出来了。

   正确做法是留在同一层里、但仍然让两者错开:
   让背景渐变(暗幕)在 80% 处就归零,而 mask 的羽化一直拉到 100%。
   于是暗幕自己先收干净、模糊继续往上化 —— 错位保住了,
   而且两者被同一个软 mask 裁,没有任何一条硬的矩形边。

   mask 下面 62% 全浓(正好盖住信息区),再往上 38%(约 90px)渐隐。
   backdrop-filter 只留 blur,不带 brightness/saturate:
   那两个改的是"整体色调",mask 羽化到半透明处会露出一块色调被平移的矩形;
   模糊只降低细节、不动平均色调,所以羽化处不会显形。 */
.ctile-content::before {
  content: '';
  position: absolute;
  inset: -90px 0 0 0;
  z-index: -1;
  pointer-events: none;
  /* 明暗的重心压在底部(参考稿是"上面透、下面沉"),且在 80% 就收干净 ——
     底部是小字(用量、标签),最难读所以要暗;名字是 20px 粗体,
     本身压得住,放在亮底上反而能让照片透出来 */
  background: linear-gradient(
    to top,
    rgba(24, 24, 22, 0.4) 0%,
    rgba(24, 24, 22, 0.34) 30%,
    rgba(24, 24, 22, 0.2) 55%,
    rgba(24, 24, 22, 0.06) 70%,
    transparent 80%
  );
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  -webkit-mask-image: linear-gradient(
    to top,
    #000 0%,
    #000 62%,
    rgba(0, 0, 0, 0.5) 82%,
    transparent 100%
  );
  mask-image: linear-gradient(
    to top,
    #000 0%,
    #000 62%,
    rgba(0, 0, 0, 0.5) 82%,
    transparent 100%
  );
}

/* 整卡命中区:透明按钮铺满卡片,压在文本之下 ——
   "点空白处进详情"的直觉还在,而 CTA 可以正常浮在它上面 */
.ctile-open {
  position: absolute;
  inset: 0;
  z-index: 2;
  cursor: pointer;
}
/* 焦点环全站关闭,见 style.css 的 :focus-visible */

/* 文本叠层:贴底,白字,左下 16px。
   只留三样:名字(+CTA)、特征、用量 ——
   简介那一行(身份/描述)与名字说的是同一件事,重复;分隔线是纯装饰。
   两者都删掉,卡片下方才不挤。
   补一道微弱投影,别让大名字压在亮图上糊掉。
   pointer-events:none 让点击穿到下面的整卡命中区,只有 CTA 自己收回来 */
.ctile-content {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 17px 17px 16px;
  pointer-events: none;
  /* 两道投影:贴边那道定字缘,大范围那道在字周围压出一圈局部对比 ——
     暗幕调轻之后,名字落在亮底上就得靠它撑住 */
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 2px 14px rgba(0, 0, 0, 0.45);
}
/* 名字 + 快捷开画同一行 */
.ctile-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ctile-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xl);
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: var(--ls-tight);
  color: #fff;
}
/* 特征胶囊:玻璃感白字,一行 */
.ctile-chips {
  display: flex;
  gap: 6px;
  overflow: hidden;
}
.chip {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  line-height: 1.2;
  font-size: var(--fs-xs);
  color: #fff;
}

/* 快捷开画:浅色药丸压在暗幕上,是卡上对比度最高的元素(与设计稿的 CTA 同位阶)。
   固定浅底深字,不走 token —— 它盖在照片上,亮/暗主题下都该是"浅底深字"。
   与名字同行,所以收成紧凑的一枚(flex:none 不参与拉伸,名字那边让位)。
   pointer-events 单独收回,否则会被 .ctile-content 的透传连累点不动 */
.ctile-cta {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 11px;
  border-radius: 999px;
  background: rgba(252, 251, 249, 0.94);
  color: #1a1a18;
  font-size: var(--fs-xs);
  font-weight: 600;
  white-space: nowrap;
  text-shadow: none;
  pointer-events: auto;
  cursor: pointer;
  transition: background var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.ctile-cta:hover {
  background: #fff;
  transform: translateY(-1px);
}
.ctile-cta:active {
  transform: translateY(0);
}
.ctile-cta-ico {
  width: 13px;
  height: 13px;
  flex: none;
  transition: transform var(--dur) var(--ease);
}
.ctile-cta:hover .ctile-cta-ico {
  transform: translateX(2px);
}

/* 用量三格 + 竖向分隔,白字压在暗幕上。
   上边距比常规段距再大一档(10px)—— 参考稿就是靠这段留白把
   "标签"和"数据"分成两段,不靠分隔线,也不显挤 */
.ctile-stats {
  display: flex;
  margin-top: 10px;
}
.cstat {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 0 10px;
  border-left: 1px solid rgba(255, 255, 255, 0.14);
}
.cstat:first-child {
  border-left: none;
  padding-left: 0;
}
.cstat:last-child {
  padding-right: 0;
}
.cstat-h {
  display: flex;
  align-items: center;
  gap: 4px;
}
.cstat-ico {
  width: 12px;
  height: 12px;
  flex: none;
  color: rgba(255, 255, 255, 0.7);
}
.cstat-v {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.cstat-k {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  font-size: var(--fs-micro);
  color: rgba(255, 255, 255, 0.6);
}

/* 图上角的管理入口:一枚 ⋮ 打开置顶 / 编辑 / 复制 / 导出 / 删除,压在照片上,
   刻意不走 token —— 仍按暖白纸调子避开纯黑纯白;加一道模糊让它"浮"住 */
.ctile-menu {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 4;
}
/* 置顶角标:与 ⋮ 同一枚深色药丸语言,只是它不吃点击(整卡命中区在下面)。
   放左上角,与右上的 ⋮ 各占一隅 —— 两枚都靠右上会挤在一起 */
.ctile-pin {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 4;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: rgba(24, 24, 22, 0.34);
  color: #fbfaf7;
  backdrop-filter: blur(8px);
  pointer-events: none;
}
.ctile-pin svg {
  width: 14px;
  height: 14px;
}
.ctile-dots {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(24, 24, 22, 0.34);
  color: #fbfaf7;
  backdrop-filter: blur(8px);
  cursor: pointer;
  transition: opacity var(--dur) var(--ease), background var(--dur) var(--ease);
}
.ctile-dots svg {
  width: 16px;
  height: 16px;
}
/* 能悬停的设备上才收起这枚钮:每张图右上角常驻一枚深色圆点太吵。
   触摸设备没有悬停,收起来就等于点不到 —— 所以用 hover 能力判断,而不是屏宽。
   菜单开着时(.open)必须留下:⋮ 点开之后鼠标一移开就淡掉,
   连同菜单一起看不见了(Safari 点按钮还不给焦点,focus-within 兜不住) */
@media (hover: hover) {
  .ctile-menu {
    opacity: 0;
  }
  .ctile:hover .ctile-menu,
  .ctile-menu:focus-within,
  .ctile-menu.open {
    opacity: 1;
  }
}
.ctile-dots:hover {
  background: rgba(24, 24, 22, 0.56);
}

/* ===== 卡上的下拉菜单(与 PromptLibrary 同一套外观) =====
   .ctile-menu 自己就是绝对定位的,不用再给 .menu-wrap 一条相对定位 ——
   两条同权重、谁在后面谁生效,那样会把入口从右上角拽回文档流。
   模板里那个 menu-wrap 只是给"点别处收起"用的识别标记(见父组件的 onDocPointerDown) */
.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 6;
  min-width: 152px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: var(--sh-md);
}
/* 下方放不下时朝上开:末行的卡片用它,不然菜单会伸到视口外 */
.menu.up {
  top: auto;
  bottom: calc(100% + 6px);
}
.mitem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  text-align: left;
  line-height: normal;
  font-size: var(--fs-sm);
  color: var(--text-2);
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.mitem svg {
  width: 14px;
  height: 14px;
}
.mitem:hover {
  background: var(--bg-elev);
  color: var(--text);
}
.mitem.danger:hover {
  color: var(--danger, #b4232a);
}

@media (max-width: 720px) {
  /* 手机上把触控目标抬到 40px —— 站内对触屏的底线
     (见 App.vue 里 .param-btn / .clear-icon 那几条)。桌面维持原尺寸:
     那边有鼠标,把它撑大只会让版面变松 */
  .ctile-cta {
    min-height: 40px;
  }
  /* 触控目标放大到 40px */
  .ctile-dots {
    width: 40px;
    height: 40px;
  }
  /* 海报卡在窄屏卡面更小:名字收一档,段距与内边距也各收一点,
     但留白仍比桌面端紧不了太多 —— 信息已经只剩三行了 */
  .ctile-name {
    font-size: var(--fs-lg);
  }
  .ctile-content {
    gap: 7px;
    padding: 13px 13px 12px;
  }
  /* 窄屏一行里要同时站住名字和 CTA:两边都收一档,给名字多留点位置 */
  .ctile-head {
    gap: 8px;
  }
  .ctile-cta {
    padding: 5px 9px;
    font-size: var(--fs-micro);
  }
  .ctile-cta-ico {
    width: 12px;
    height: 12px;
  }
}
</style>
