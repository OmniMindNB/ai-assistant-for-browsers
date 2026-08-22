import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['lib/**/*.test.ts'],
          exclude: ['lib/**/*.dom.test.ts'],
          setupFiles: ['lib/test-setup.ts'],
          alias: { '@': path.resolve(__dirname) },
        },
      },
      {
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['entrypoints/**/*.test.tsx', 'components/**/*.test.tsx', 'lib/**/*.test.tsx'],
          setupFiles: ['lib/test-setup.ts', 'lib/test-setup-ui.ts'],
          alias: { '@': path.resolve(__dirname) },
        },
      },
      {
        // 注入页面的 DOM 函数：不是 UI 组件（没有 JSX），但需要真实 DOM。
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['lib/**/*.dom.test.ts'],
          setupFiles: ['lib/test-setup.ts'],
          alias: { '@': path.resolve(__dirname) },
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
