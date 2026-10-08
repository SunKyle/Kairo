import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: {
        /* 把几乎不随业务改动的几个依赖拆成独立的包:改业务只让主包失效,
           用户缓存里那几份大的(图标字库尤其)能留下来。
           fflate 不列在这里 —— 它是动态引入的,本来就自成一块 */
        manualChunks: {
          vue: ['vue'],
          icons: ['@phosphor-icons/vue', 'simple-icons'],
          motion: ['motion']
        }
      }
    }
  },
  server: {
    // 固定端口(前端):默认的 5173 被本机另一个项目长期占用,自动顺延会让地址一直漂
    port: 5180,
    // 端口被占时直接报错退出,而不是悄悄换一个端口
    strictPort: true,
    /* 默认只听 localhost —— 用手机连本机调试时要显式开:
     *   npm run dev:lan        然后手机开 http://<这台机器的局域网 IP>:5180
     * 不默认开有两个理由:一是它会把 /api 这条代理一并暴露给同网段的任何设备
     * (等于把本机那个上游代理也借出去),二是绝大多数时候根本用不着。
     * LAN=1 时探的是 0.0.0.0,vite 会顺手把可用的局域网地址打在启动日志里 */
    host: process.env.LAN === '1' ? true : undefined,
    proxy: {
      // 开发环境将 /api 转发给本地 Express 后端(后端固定 3100),避开跨域
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true
      }
    }
  }
})