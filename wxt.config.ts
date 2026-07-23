import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  vite: () => ({
    plugins: [tailwindcss()],
    build: {
      // pi-agent-core 传递依赖 pi-ai 的模型目录较大，属于死代码，不影响运行时开销，调高阈值消除构建噪音
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        // pi-ai 的 env-api-keys.js 用 runtime 检测守卫的动态 import 兼容 Node/Bun CLI 场景，
        // 浏览器扩展里这段永远不会执行；显式声明 external 消除“externalized”构建提示
        external: ['node:fs', 'node:os', 'node:path'],
      },
    },
  }),
  manifest: {
    name: 'Aluminum',
    description: 'AI 助手侧边栏：总结、理解、改造与自动化当前网页',
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab', 'tabs', 'userScripts'],
    host_permissions: ['<all_urls>'],
    minimum_chrome_version: '138',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: 'Aluminum',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
  },
});
