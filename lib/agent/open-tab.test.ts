import { describe, expect, it, vi } from 'vitest';
import { performOpenTab, TAB_CLOSED_WHILE_OPENING_ERROR, type OpenTabDeps } from './open-tab';

function deps(overrides: Partial<OpenTabDeps> = {}): OpenTabDeps {
  return {
    createTab: vi.fn().mockResolvedValue({ id: 42 }),
    onceLoadComplete: vi.fn().mockResolvedValue(undefined),
    getTab: vi.fn().mockResolvedValue({ url: 'https://a.test/docs', title: '文档' }),
    ...overrides,
  };
}

describe('performOpenTab', () => {
  it('reports the landed URL and title of the new tab', async () => {
    const result = await performOpenTab('https://a.test/start', deps());
    expect(result).toEqual({ id: 42, url: 'https://a.test/docs', title: '文档' });
  });

  it('falls back to the requested URL when the tab has no URL yet', async () => {
    const result = await performOpenTab('https://a.test/start', deps({ getTab: vi.fn().mockResolvedValue({}) }));
    expect(result).toEqual({ id: 42, url: 'https://a.test/start', title: undefined });
  });

  // 服务器以 application/x-sh 之类返回的地址（https://pi.dev/install.sh）会被 Chrome 当下载处理，
  // 专为这次导航新建的标签页随即自动关掉。以前照样报"已打开"并把死掉的 tabId 设为操作目标，
  // 后面每个工具都撞"目标标签页已关闭"，模型连烧好几步才想到另开一个。
  it('fails instead of reporting a tab that vanished while loading (URL was a download)', async () => {
    await expect(
      performOpenTab('https://a.test/install.sh', deps({ getTab: vi.fn().mockResolvedValue(undefined) })),
    ).rejects.toThrow(TAB_CLOSED_WHILE_OPENING_ERROR);
  });
});
