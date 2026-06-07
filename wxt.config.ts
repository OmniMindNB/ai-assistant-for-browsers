import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Aluminum',
    description: 'AI 助手侧边栏：总结、理解、改造与自动化当前网页',
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab', 'tabs', 'contextMenus'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Aluminum',
    },
  },
});
