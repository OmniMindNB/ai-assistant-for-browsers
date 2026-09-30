import { describe, expect, it, vi } from 'vitest';
import { NAVIGATION_STAYED_ERROR, performNavigate, type NavigateDeps } from './navigate-tab';

function deps(before: string, after: { url?: string; title?: string } | undefined): NavigateDeps {
  let calls = 0;
  return {
    getTab: vi.fn().mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? { url: before, title: '原页面' } : after;
    }),
    update: vi.fn().mockResolvedValue(undefined),
    onceLoadComplete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('performNavigate', () => {
  it('reports the landed URL and title', async () => {
    const result = await performNavigate('https://a.test/docs', deps('https://a.test/', { url: 'https://a.test/docs', title: '文档' }));
    expect(result).toEqual({ url: 'https://a.test/docs', requestedUrl: 'https://a.test/docs', title: '文档' });
  });

  it('keeps reporting a genuine redirect to a different page', async () => {
    const result = await performNavigate('https://a.test/docs', deps('https://a.test/', { url: 'https://a.test/login', title: '登录' }));
    expect(result.url).toBe('https://a.test/login');
  });

  // 同一个 tab 里跳到 https://pi.dev/install.sh：Chrome 转成下载，页面原地不动。以前报成
  // "已跳转到 install.sh，经重定向最终停在 <原页面>"——模型会以为原页面就是脚本的"重定向目标"。
  it('fails when the tab never left the page it was on (URL became a download)', async () => {
    await expect(
      performNavigate('https://pi.dev/install.sh', deps('https://pi.dev/docs/latest', { url: 'https://pi.dev/docs/latest', title: '原页面' })),
    ).rejects.toThrow(NAVIGATION_STAYED_ERROR);
  });

  it('does not treat reloading the current URL as a failure', async () => {
    const result = await performNavigate('https://a.test', deps('https://a.test/', { url: 'https://a.test/', title: '首页' }));
    expect(result.url).toBe('https://a.test/');
  });

  it('fails when the tab disappeared during navigation', async () => {
    await expect(performNavigate('https://a.test/docs', deps('https://a.test/', undefined))).rejects.toThrow('目标标签页已关闭');
  });
});
