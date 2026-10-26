<script setup lang="ts">
import { SETTINGS_SECTIONS, type SettingsSection } from '../lib/settingsNav'

/* ===== 设置页的骨架(PRD §5.6 / §11.12) ===============================
   左边一条分区导航,右边是当前那一区的内容。**内容走插槽** ——
   这一层不认识任何一个分区长什么样。

   —— 为什么是插槽而不是在这里 v-if 各分区 ——

   分区的内容各要各的数据:外观要主题与沉浸,相处偏好要角色目录,
   记忆与隐私要全部记忆,接口配置要九份 props 加十二个事件。
   如果这些由这一层收下来再转发,它就凭空长出一张五十行的转发表:
   每一行只是把名字抄一遍,而且以后任何一区加一个 props,这里忘了跟
   就会**静默丢掉**(丢的是 props,不报错)。
   交给插槽之后,各分区由主界面直接装配 —— 那一层本来就在做这件事
   (页面与各页的 props 都在那儿接),类型也一路是通的。
   -------------------------------------------------------------------- */

const props = defineProps<{
  /* 当前在哪一区。由主界面持有而不是本组件的 ref ——
     "先配一个模型"那些引导入口要能直接跳到接口那一区
     (见 App 的 openChatConfig) */
  section: SettingsSection
}>()

const emit = defineEmits<{
  (e: 'section', v: SettingsSection): void
}>()
</script>

<template>
  <section class="set" aria-label="Settings">
    <!-- 分区导航。**不用 role="tab"**:那套语义在 ARIA 里承诺方向键导航,
         而这里只有 Tab 键 —— 声明成 tab 等于许了做不到的事
         (与 ApiSettingsPanel 里那个 role="group" 的说明同一条理由)。
         说明文字挂在 title 上:导航条目只放名字,一列短词才扫得动 -->
    <nav class="set-rail" aria-label="Settings sections">
      <button
        v-for="s in SETTINGS_SECTIONS"
        :key="s.key"
        type="button"
        class="rail-item"
        :class="{ on: props.section === s.key }"
        :aria-current="props.section === s.key ? 'true' : undefined"
        :title="s.hint"
        @click="emit('section', s.key)"
      >
        {{ s.label }}
      </button>
    </nav>

    <div class="set-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
/* 宽屏:左侧一条竖导航 + 右侧内容。两栏而不是上下一叠 ——
   设置项是"分类浏览"的,一列名字竖着排才扫得动;
   窄屏落到上面一排横向 chip(见下面的断点) */
.set {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: var(--sp-6);
  align-items: start;
}

.set-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 跟着内容滚,不跟着页面滚:设置页比一屏长,导航不该滚出去 */
  position: sticky;
  top: var(--sp-4);
}
.rail-item {
  position: relative;
  display: block;
  width: 100%;
  padding: 9px 12px 9px 16px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
/* 当前分区左边探出一根强调条:淡底 + 加粗已经在说"在哪",这根条再补一个
   明确却不刺眼的锚点。切区时它按回弹曲线"长出来",而不是硬跳一下。 */
.rail-item::before {
  content: '';
  position: absolute;
  left: 6px;
  top: 50%;
  width: 2px;
  height: 0;
  border-radius: 2px;
  background: var(--accent);
  transform: translateY(-50%);
  transition:
    height var(--dur-spring) var(--spring),
    background var(--dur) var(--ease);
}
.rail-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}
/* 选中态用淡底 + 墨色字(与各面板里的档位按钮同一套语言)。
   不用实心墨底:一列里立起一块黑,会把"当前在哪"喊得比内容还响 */
.rail-item.on {
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 500;
}
.rail-item.on::before {
  height: 16px;
}
.rail-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.set-body {
  min-width: 0;
}

/* 窄屏:导航落到内容上面一排。860 而不是 640 ——
   200px 的侧栏 + 面板正文在平板上会把正文挤到读不下去 */
@media (max-width: 860px) {
  .set {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-4);
  }
  .set-rail {
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--sp-2);
    position: static;
  }
  .rail-item {
    width: auto;
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    text-align: center;
    font-size: var(--fs-xs);
    line-height: 32px;
  }
  .rail-item.on {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-contrast);
  }
  /* 横排药丸里没有左侧那一列,强调条在这种形态下没有落脚处,收掉它 ——
     当前项已经由实心墨底说清了 */
  .rail-item::before {
    display: none;
  }
}
@media (max-width: 640px) {
  /* 触屏目标抬到 40px */
  .rail-item {
    height: 40px;
    line-height: 40px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .rail-item::before {
    transition: none;
  }
}
</style>
