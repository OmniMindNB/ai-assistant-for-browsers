import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerLocalDispatcher, sendMessage } from './messaging';

describe('sendMessage', () => {
  it('includes tabId in the posted message when provided', async () => {
    const sendSpy = vi.fn().mockResolvedValue({ id: 'x', ok: true, data: {} });
    (globalThis as any).browser = { runtime: { sendMessage: sendSpy } };

    await sendMessage('GET_HTML', { selector: 'body' }, 42);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const posted = sendSpy.mock.calls[0][0];
    expect(posted.type).toBe('GET_HTML');
    expect(posted.payload).toEqual({ selector: 'body' });
    expect(posted.tabId).toBe(42);
  });

  it('omits tabId when not provided', async () => {
    const sendSpy = vi.fn().mockResolvedValue({ id: 'x', ok: true, data: {} });
    (globalThis as any).browser = { runtime: { sendMessage: sendSpy } };

    await sendMessage('PING');

    const posted = sendSpy.mock.calls[0][0];
    expect(posted.tabId).toBeUndefined();
  });
});

// 回归用例：agent 主循环迁移进 background 后（ref: docs/superpowers/specs/
// 2026-09-01-agent-run-in-background-design.md §7），tools.ts/agent.ts 的 sendMessage()
// 调用和 handleMessage 的 onMessage 监听器同处一个执行上下文。按 WebExtensions 规范，
// runtime.onMessage 不会派发给发消息的那个 frame 自己，继续走 browser.runtime.sendMessage
// 会让这些调用永远等不到响应——这正是"总结本页"里 browser_get_active_tab/browser_read_page/
// browser_get_page_meta 全部失败的根因。这里验证注册了本地直连之后，sendMessage() 绕开
// browser.runtime.sendMessage，直接调用注册的 dispatcher。
describe('sendMessage with a registered local dispatcher', () => {
  afterEach(() => {
    registerLocalDispatcher(null);
  });

  it('bypasses browser.runtime.sendMessage and calls the dispatcher directly', async () => {
    const sendSpy = vi.fn();
    (globalThis as any).browser = { runtime: { sendMessage: sendSpy } };
    const dispatcher = vi.fn().mockResolvedValue({ title: 'Example' });
    registerLocalDispatcher(dispatcher);

    const response = await sendMessage('GET_ACTIVE_TAB');

    expect(sendSpy).not.toHaveBeenCalled();
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher.mock.calls[0][0]).toMatchObject({ type: 'GET_ACTIVE_TAB' });
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({ title: 'Example' });
  });

  it('reports dispatcher rejections as a normal failure response instead of throwing', async () => {
    (globalThis as any).browser = { runtime: { sendMessage: vi.fn() } };
    registerLocalDispatcher(vi.fn().mockRejectedValue(new Error('目标标签页已关闭。')));

    const response = await sendMessage('GET_PAGE_META', undefined, 7);

    expect(response.ok).toBe(false);
    expect(response.error).toBe('目标标签页已关闭。');
  });
});
