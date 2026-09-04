import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTabSession } from './tab-session';

const sendMessage = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessage(...args) };
});

const { createBrowserTools } = await import('./tools');

beforeEach(() => {
  sendMessage.mockReset();
});

describe('browser_screenshot 的按能力注册', () => {
  it('vision 为假（默认）时不注册', () => {
    const names = createBrowserTools(createTabSession(1)).map((tool) => tool.name);
    expect(names).not.toContain('browser_screenshot');
  });

  it('vision 为真时注册', () => {
    const names = createBrowserTools(createTabSession(1), { vision: true }).map((tool) => tool.name);
    expect(names).toContain('browser_screenshot');
  });
});

describe('browser_screenshot 的结果', () => {
  function getTool() {
    const tool = createBrowserTools(createTabSession(1), { vision: true })
      .find((candidate) => candidate.name === 'browser_screenshot');
    if (!tool) throw new Error('browser_screenshot 未注册');
    return tool;
  }

  it('把图片作为 image part 交给模型', async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      data: { dataUrl: 'data:image/jpeg;base64,AAAA', base64: 'AAAA', mimeType: 'image/jpeg', width: 1280, height: 800 },
    });
    const output = await getTool().execute('call-1', {});

    expect(output.content).toHaveLength(2);
    expect(output.content[0]).toMatchObject({ type: 'text' });
    expect((output.content[0] as { text: string }).text).toContain('untrusted page content');
    expect(output.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
  });

  it('文字部分报告实际尺寸，而不是 dataUrl 长度', async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      data: { dataUrl: 'data:image/jpeg;base64,AAAA', base64: 'AAAA', mimeType: 'image/jpeg', width: 1280, height: 800 },
    });
    const output = await getTool().execute('call-1', {});
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain('1280');
    expect(text).toContain('800');
    expect(text).not.toContain('dataUrl');
  });
});
