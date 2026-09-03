// 扩展更新/重载后，侧边栏这个长期打开的页面还挂着旧构建的 document，
// 而 lazy(() => import('../Markdown')) 要拉的 chunk 文件名带 hash，重建后旧文件已被删除，
// 于是 fetch 404 → React 在渲染期抛 TypeError。<Suspense> 只兜 pending 不兜 reject，
// 所以这里必须由错误边界兜住，回退到与 Suspense fallback 一致的纯文本。
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MarkdownBlock } from './MarkdownBlock';

// 模拟“chunk 文件已经不在了”：动态 import 直接 reject。
vi.mock('../Markdown', () => {
  throw new TypeError(
    'Failed to fetch dynamically imported module: chrome-extension://x/chunks/Markdown-CO2Pv_lb.js',
  );
});

describe('MarkdownBlock when the lazy chunk fails to load', () => {
  it('falls back to the plain text instead of crashing the message list', async () => {
    // React 的错误边界会把这次渲染错误原样 console.error 出来，测试里不需要这份噪音。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { container } = render(<MarkdownBlock content={'# 标题\n\n正文'} />);
      // 必须等 lazy 的 rejection 传播完再断言：render() 刚返回时 import 还是 pending，
      // 此时画面上是 <Suspense> 的 fallback——那说明不了错误边界有没有生效。
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // 内容一个字都不少……
      expect(container.textContent).toContain('# 标题');
      expect(container.textContent).toContain('正文');
      // ……只是没经过 markdown 解析（`#` 原样留着，没有变成 <h1>）。
      expect(container.querySelector('h1')).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });
});
