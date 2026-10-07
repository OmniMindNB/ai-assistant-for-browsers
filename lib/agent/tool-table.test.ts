// 工具表的整体约束：哪些工具对模型可见。按能力注册的单个工具（如 browser_screenshot）在各自的
// 测试文件里，这里放跨工具的决定。
import { describe, expect, it, vi } from 'vitest';
import { createTabSession } from './tab-session';
import { buildSystemPrompt } from './system-prompt';

vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: vi.fn() };
});

const { createBrowserTools } = await import('./tools');

describe('browser_get_active_tab 已退役', () => {
  // 有浏览器工具的运行一律在 <runtime_context> 里注入了当前页面的地址和标题，提示词也写了
  // 「不要再调用」——2026-10-07 开端口会话里 glm-5.3 照样第一轮就调它，白花一轮往返。
  // 地址的其它来源：写操作结果的 [页面位置]、browser_read_page 的标题/URL、browser_list_tabs。
  it('不在工具表里', () => {
    const names = createBrowserTools(createTabSession(1), { vision: true }).map((tool) => tool.name);
    expect(names).not.toContain('browser_get_active_tab');
  });

  it('提示词和任何工具描述都不再提它', () => {
    const prompt = buildSystemPrompt({ page: { tabId: 1, title: 'a', url: 'https://e.com' }, vision: true });
    expect(prompt).not.toContain('browser_get_active_tab');
    for (const tool of createBrowserTools(createTabSession(1), { vision: true })) {
      expect(tool.description, tool.name).not.toContain('browser_get_active_tab');
    }
  });
});
