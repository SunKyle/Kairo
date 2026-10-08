<script setup lang="ts">
import { computed } from 'vue'
import {
  PhArrowsClockwise,
  PhArrowsOutSimple,
  PhEye,
  PhLockSimple
} from '@phosphor-icons/vue'
import { coverSrc } from '../api'
import type { CharacterView } from '../types'

/* 设定图格子:一张图 + 它的名字,四种状态(生成中 / 已有图 / 空格 / 锁着)。
 *
 *  **它只做展示与动作上报** —— 哪张图、跑没跑、锁没锁、点下去该做什么,
 *  全由父组件交进来;按下只是把"按了哪一下"报回去。
 *
 *  为什么要收成一个组件:同一套格子现在有三处 ——
 *  详情页那一排、向导的主视图、向导的其余四张。它们逐字重复,
 *  而差别只有四样:有图时点它是"看大图"还是"重出"、要不要显示主视图的眼睛标、
 *  空格子上有没有锁、以及正脸那格要不要强调。这四样各由一个 prop 说清,
 *  其余的(停止位、暗幕、放大镜、眉标)三处一字不差。
 *
 *  图与标签都按"这一格是什么"命名 —— 它不认识角色 id,也不发请求;
 *  连 stopView 要带的 id 与 kind 都由父组件在 @stop 里补上。 */
const props = defineProps<{
  /** 这一格叫什么(Front / 3/4 left / Full body …)。
   *  它既是格子下面那行可视标签,也是读屏句子里的主语 */
  label: string
  /** 已有的那张图。没有 = 空格子,中间摆一枚 "+" */
  view?: CharacterView
  /** 正在跑(初次生成或重跑)。有值即这一格换成停止位 */
  busy?: boolean
  /** 正脸还没出:这一格锁着,点不动(只有详情页那一排用得上) */
  locked?: boolean
  /** 主视图还没出:其余四张点不动(它是派生图,没有基准就没有依据) */
  blocked?: boolean
  /** 主视图就是这一格:详情页在右上角多一枚眼睛标,标签也转成 accent 色 */
  isMain?: boolean
  /** 正脸那一格:空态用 accent 淡底的 "+"(整条流水线的起点,该被一眼看见) */
  start?: boolean
  /** 竖幅(2:3)。详情页那一排靠它跨两行,向导那一排则被按回方框 */
  portrait?: boolean
  /** 有图时点它做什么:open = 看大图(详情页),generate = 重出(向导) */
  action: 'open' | 'generate'
  /** 读屏里这一格的称呼短语,跟在 "Stop generating" / "Regenerate" 后面。
   *  默认 "the {label} view"。
   *  向导主视图那一处原文写死的是 "the main view" —— 与它的可视标签 "Front"
   *  并不是同一个词,所以留这个口子,不在这儿顺手把无障碍文案改掉 */
  noun?: string
}>()

const emit = defineEmits<{
  /* 停止这一格正在跑的那次生成 */
  (e: 'stop'): void
  /* 空格子点一下 = 生成;有图时按 action 走这条路 = 重出 */
  (e: 'generate'): void
  /* 有图且 action 为 open:点开看大图 */
  (e: 'open'): void
}>()

const noun = computed(() => props.noun || `the ${props.label} view`)

/** 生成中对任何一格都说得通:停止位不看它是什么图 */
const busyAria = computed(() => `Stop generating ${noun.value}`)

/** 已经有图时那一下。详情页是"看",向导是"再画一张" */
const shotAria = computed(() =>
  props.action === 'open' ? `View ${props.label}` : `Regenerate ${noun.value}`
)

/** 空格子那一下。三态文案不一样,是因为它们**点不动的原因**不一样:
 *  还没轮到它(锁着)、还缺基准(等主视图)、或者本来就能点。
 *  这两句里说的"next step"必须是用户真能做的下一步 ——
 *  一句笼统的"不可用"会让人去别处找原因 */
const emptyAria = computed(() => {
  if (props.locked) return `${props.label} view — generate the front view first`
  if (props.blocked) return `${props.label} view — waiting for the main view`
  /* 详情页那一处原文是 "Generate Front view"(不带 the),
     向导那两处是 "Generate the Front view" —— 差一个冠词,原样保留 */
  return props.action === 'open' ? `Generate ${props.label} view` : `Generate ${noun.value}`
})
</script>

<template>
  <!-- 单根:父组件的网格按它排(.sheet 左四右一 / .wz-grid 一排四格),
     竖幅跨不跨行也由父组件那两条规则决定 -->
  <div class="cell" :class="{ 'is-portrait': portrait, 'is-ref': isMain }">
    <!-- 正在跑的那一张(含重跑):整格换成"停止"入口。
         旧写法只给空格子加个呼吸,重跑一张已有的图时格子毫无变化 ——
         看不出在跑,也没地方停 -->
    <button
      v-if="busy"
      class="cell-img is-busy"
      :class="{ 'has-img': !!view }"
      :aria-label="busyAria"
      @click="emit('stop')"
    >
      <img v-if="view" :src="coverSrc(view.data)" alt="" />
      <span class="cell-busy" aria-hidden="true">
        <span class="cell-busy-stop"></span>
      </span>
    </button>
    <button
      v-else-if="view"
      class="cell-img has-img"
      :disabled="blocked"
      :aria-label="shotAria"
      @click="action === 'open' ? emit('open') : emit('generate')"
    >
      <img :src="coverSrc(view.data)" alt="" />
      <!-- 放大镜还是重画:同一枚角标,说的是这一下会做什么。
           详情页点开看大图,向导里点它就是再画一张 -->
      <span class="cell-zoom" aria-hidden="true">
        <PhArrowsOutSimple v-if="action === 'open'" />
        <PhArrowsClockwise v-else />
      </span>
      <span v-if="isMain" class="cell-mark" title="Main view">
        <PhEye weight="fill" aria-hidden="true" />
      </span>
    </button>
    <button
      v-else
      class="cell-img"
      :class="{ locked, start }"
      :disabled="locked || blocked"
      :aria-label="emptyAria"
      @click="emit('generate')"
    >
      <PhLockSimple v-if="locked" class="cell-lock" aria-hidden="true" />
      <span v-else class="cell-ph" aria-hidden="true">+</span>
    </button>

    <span class="cell-label">{{ busy ? 'Generating…' : label }}</span>
  </div>
</template>

<style scoped>
.cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
/* 设定图格子:和角色海报卡同一套"照片优先"的语言 —— 圆角 + 一道极淡的接触影,
   有图的靠图本身撑住,没图的靠一块淡底。
   刻意不用"虚线框 → 实线框":那是线框稿的写法,读起来像待填的表单,
   而不是一个已经有设计的产品界面 */
.cell-img {
  position: relative;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: none;
  /* 比 --r-sm(8px)大一档:海报卡是 24px,这里取中间值,
     一排小片才不会显得比卡片"硬" */
  border-radius: 12px;
  background: var(--bg-elev);
  color: var(--text-3);
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
/* 有图:照片优先。底换成图片画布色,再压一道接触影把它从页面上托起来 */
.cell-img.has-img {
  background: var(--image-bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.cell-img.has-img:hover {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
}
/* 竖幅的输出只有 Full body 一张(见 api.ts 的 framing)。
   它按 2:3 生成(App 的 PORTRAIT_RATIO),塞进 1:1 的格子会被 cover 上下各切掉约 1/6 ——
   头和脚都没了。所以这一格改用同一个 2:3 装它:比例对齐,cover 一点不裁;
   方块图仍用 1:1,它们的输出本来就是方的 */
.cell.is-portrait .cell-img {
  aspect-ratio: 2 / 3;
}
/* 空格子上的"+"做成一枚圆形按钮:说的是"这里可以生成",
   而不是"这里缺一件东西"。悬停时它转成墨色实心 ——
   反馈落在按钮自己身上,不必再给整格描一圈边 */
.cell-ph {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  font-size: var(--fs-lg);
  line-height: 1;
  color: var(--text-2);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.cell-img:not(.has-img):hover:not(:disabled) .cell-ph {
  background: var(--accent);
  color: var(--accent-contrast);
}
/* 该停用的入口要看得出来,否则和平时长得一样、点了却没反应。
   只有一种情况会停用:正脸正在重跑 —— 那时其余几张拿到的会是上一版正脸。
   别的组合都允许同时跑,各自有自己的进度与停止位 ——
   正在跑的那一格不走这里,它换成了停止位,是可点的 */
.cell-img:disabled {
  cursor: default;
  opacity: 0.4;
}
/* 正在跑的那一张(含重跑):整格换成"停止"入口 */
.cell-img.is-busy {
  cursor: pointer;
  box-shadow: none;
}
/* 暗幕把底下的旧图压住:一是说明"这一格正被占用",
   二是让中间的停止钮在亮图上也有对比 */
.cell-busy {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(24, 24, 22, 0.5);
}
/* 停止:一枚玻璃圆 + 中间一个方块(停止的通用符号,不必再引一个图标)。
   呼吸做在这枚圆的外圈上 —— 让它一直在"动",而按钮本身保持清晰 */
.cell-busy-stop {
  position: relative;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(252, 251, 249, 0.22);
  animation: charBusy 1.6s var(--ease) infinite;
}
.cell-busy-stop::after {
  content: '';
  width: 11px;
  height: 11px;
  border-radius: 2px;
  background: #fbfaf7;
}
.cell-img.is-busy:hover .cell-busy-stop {
  background: rgba(252, 251, 249, 0.36);
}
@keyframes charBusy {
  50% {
    box-shadow: 0 0 0 7px rgba(252, 251, 249, 0.1);
  }
}
.cell-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 700ms var(--ease);
}
.cell-img.has-img:hover img {
  transform: scale(1.05);
}
/* 锁住的那几格:先有正脸才轮得到它们。
   图标比 "+" 小一档 —— 它说的是"还不能点",不该和可点的格子抢注意力 */
.cell-lock {
  width: 34px;
  height: 34px;
  padding: 10px;
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-4);
}
/* 整条流水线的起点:正脸格是这一屏唯一该被点的东西 ——
   给它一枚 accent 淡底的 "+"(比描边含蓄,又比旁人醒目) */
.cell-img.start:not(.has-img) .cell-ph {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
/* 悬停铺一层柔幕 + 一枚圆形放大按钮:说清"这张点得开",而不是点下去才知道。
   遮罩必须与主题无关(它盖在照片上,不盖在界面上),所以这里是全站少数
   刻意不走 token 的地方 —— 但仍按暖白纸的调子避开纯黑纯白 */
.cell-zoom {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(24, 24, 22, 0.3);
  color: #fbfaf7;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
/* 图标外面套一枚玻璃圆:裸图标浮在照片上会显得没落点 */
.cell-zoom svg {
  width: 36px;
  height: 36px;
  padding: 9px;
  border-radius: 50%;
  background: rgba(252, 251, 249, 0.2);
}
.cell-img:hover .cell-zoom {
  opacity: 1;
}
/* 主视图:右上角一枚眼睛。星标是"收藏"的语言,眼睛才是"就是这张" ——
   比在格子下面挂一行小字醒目得多 */
.cell-mark {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-contrast);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
}
.cell-mark svg {
  width: 14px;
  height: 14px;
}
/* 标签做成 editor 式小眉标:全大写 + 拉开字距。
   它本来是"Front""3/4 left"这种短语,放大写加字距之后
   就从"说明文字"变成了"排版的一部分" */
.cell-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-size: var(--fs-micro);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: var(--text-3);
}
/* 主视图那一格的标签转成 accent:那一排里它是基准,标签也该跟着重一档 */
.cell.is-ref .cell-label {
  color: var(--accent-strong);
}
</style>
