/* ===== ESLint 配置（flat config）======================================
   为什么现在才加:此前全仓没有 lint。类型检查管「类型对不对」,单测管
   「逻辑对不对」,两者都管不到「这行代码本身是不是坏味道」—— 声明了却没用的
   变量、永远走不到的分支、await 漏写,这三类都是它们看不见的。

   为什么只 lint src/ 与 server/:
   `scripts/` 下是开发工具(探针、冒烟、性能测量),它们没有类型、大量直接摸
   Node 全局,把噪声一起收进来只会淹没产品代码里的真问题。这一轮要的是**一份
   能拿来排期的报告**,不是一份最长的报告。同理排除 `.workbuddy-ai/`(工作记忆)
   与 `spark-output/`(草稿产出)。

   **为什么 Vue 用 flat/essential 而不是 flat/recommended**(2026-10-15 实测):
   用 recommended 跑出来 1915 个问题,其中 **1728 个是纯排版意见** ——
   `html-indent` 870、`max-attributes-per-line` 587、`singleline-html-element-
   content-newline` 172、`html-self-closing` 69、`attributes-order` 24。
   这个项目的模板是**手调过的**,不是没人管;把 1700 条排版意见铺进去,真正的
   23 个问题会被淹掉,而且没人会去修那 1700 条。
   essential 是**只管正确性**的那一档(会抓 `v-if` 配 `v-for`、computed 里写副作用
   这类真错),既拿到了想要的信号,又不对全仓风格下判断。
   将来若想统一排版,正确做法是引入 prettier(它管排版、lint 管正确性),
   而不是把 lint 调成 recommended —— 那是让一个工具干两件事。
   -------------------------------------------------------------------- */

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'scripts/**',
      '.workbuddy-ai/**',
      'spark-output/**'
    ]
  },

  js.configs.recommended,

  /* TS。用非类型感知的那一档(recommended 而非 recommendedTypeChecked):
     类型感知档要求配 parserOptions.project,会让 lint 慢一个量级,
     而「类型对不对」已经有 vue-tsc 在管 —— 不重复劳动 */
  ...tseslint.configs.recommended,

  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        /* .vue 里若是 <script lang="ts">,得交给 TS parser 解析,
           否则 template 中用到的类型会被当成未定义 */
        parser: tseslint.parser
      }
    }
  },

  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.browser
    }
  },

  /* `no-undef` 对 TS / Vue 是多余且会误报的:名字有没有出处由 tsc 判,
     而 ESLint 在**没有类型信息**时判不准(实测 160 条全是 window / document /
     HTMLElement 这类浏览器全局)。这是 typescript-eslint 官方建议的做法。
     **服务端那条不关** —— 见下面那一段,那里它是真有用的。 */
  {
    files: ['**/*.ts', '**/*.vue'],
    rules: {
      'no-undef': 'off'
    }
  },

  /* 服务端:纯 JS、不过 tsc。这里**保留** no-undef ——
     它和 `npm run check:server` 盯的是同一类错(名字没有出处),
     只是那条查 import 漏写,这条还查手滑拼错 */
  {
    files: ['server/**/*.js'],
    languageOptions: {
      globals: globals.node
    }
  },

  {
    rules: {
      /* 下划线开头 = **明确表示"我故意不用它"**。项目里真实存在的两处写法:
         `({ ref: _ref, sourceRef: _source, ...rest }) => rest`(摘掉字段再序列化,
         见 api.ts 的 saveCharacters)与回调里占位的 `(_req, res)`。
         不开这条的话,这两处会被判成"未使用",而它们恰恰是**故意**的 */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          /* 摘字段那种写法里,rest 兄弟本来就"没用"—— 忽略它们才不误报 */
          ignoreRestSiblings: true
        }
      ]
    }
  }
)
