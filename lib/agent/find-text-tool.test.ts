import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTabSession } from './tab-session';

const sendMessage = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessage(...args) };
});

const { createBrowserTools } = await import('./tools');

function findTextTool() {
  const tool = createBrowserTools(createTabSession(1)).find((candidate) => candidate.name === 'browser_find_text');
  if (!tool) throw new Error('browser_find_text 未注册');
  return tool;
}

function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content.map((part) => part.text).join('\n');
}

beforeEach(() => {
  sendMessage.mockReset();
});

// 主页面里的脚本出错时，背景页只拿得到 iframe 的结果，0 个命中会被模型当成「页面上没有这段文字」
// ——2026-10-07 四份开端口导出里它就是这样连续数次「找不到 6000」，规则其实已经在列表里。
describe('browser_find_text 的主页面不可用提示', () => {
  it('主页面没返回结果时明确告诉模型：0 命中不代表页面上没有', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { matches: [], truncated: false, mainFrameUnavailable: true } });
    const result = await findTextTool().execute('id', { text: '6000' });
    expect(text(result)).toContain('主页面');
    expect(text(result)).toContain('不代表页面上没有');
  });

  it('主页面正常时不加这条提示', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { matches: [], truncated: false } });
    const result = await findTextTool().execute('id', { text: '6000' });
    expect(text(result)).not.toContain('不代表页面上没有');
  });
});
