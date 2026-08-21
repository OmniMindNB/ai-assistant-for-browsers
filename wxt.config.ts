import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  vite: () => ({
    plugins: [
      tailwindcss(),
      viteStaticCopy({
        targets: [
          { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'pdfjs/cmaps' },
          { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'pdfjs/standard_fonts' },
          { src: 'node_modules/pdfjs-dist/wasm/*', dest: 'pdfjs/wasm' },
        ],
      }),
    ],
    build: {
      // pi-agent-core 传递依赖 pi-ai 的模型目录较大，属于死代码，不影响运行时开销，调高阈值消除构建噪音
      chunkSizeWarningLimit: 1000,
      // 扩展页面的资源都随包本地打包，没有网络往返可省；modulepreload 反而会因为跨 world
      // 资源分区触发 Chrome 的 "cross-world extension resource mismatch" 控制台警告，直接关闭
      modulePreload: false,
      rollupOptions: {
        // pi-ai 的 env-api-keys.js 用 runtime 检测守卫的动态 import 兼容 Node/Bun CLI 场景，
        // 浏览器扩展里这段永远不会执行；显式声明 external 消除“externalized”构建提示
        external: ['node:fs', 'node:os', 'node:path'],
      },
    },
  }),
  manifest: {
    default_locale: 'en',
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab', 'tabs'],
    host_permissions: ['<all_urls>'],
    minimum_chrome_version: '138',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: '__MSG_extName__',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
  },
});
