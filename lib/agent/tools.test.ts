import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from './tools';
import * as messaging from '@/lib/messaging';

describe('browser_inject_script wait/retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function getInjectTool() {
    const tool = createBrowserTools(7).find((t) => t.name === 'browser_inject_script');
    if (!tool) throw new Error('browser_inject_script tool not found');
    return tool;
  }

  it('succeeds immediately when the toggle is already on', async () => {
    vi.spyOn(messaging, 'sendMessage').mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { result: 'ok', snapshotSaved: true },
    });

    const tool = getInjectTool();
    const result = await tool.execute('call-1', { code: '1+1' });

    expect(messaging.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('已注入并执行脚本') });
  });

  it('retries every 2.5s while the toggle is off, then succeeds and reports progress via onUpdate', async () => {
    const send = vi.spyOn(messaging, 'sendMessage');
    send.mockResolvedValueOnce({ id: '1', ok: false, error: '脚本注入失败：不允许。请开启「允许用户脚本」开关后重试。' });
    send.mockResolvedValueOnce({ id: '2', ok: false, error: '脚本注入失败：不允许。请开启「允许用户脚本」开关后重试。' });
    send.mockResolvedValueOnce({ id: '3', ok: true, data: { result: '', snapshotSaved: true } });

    const tool = getInjectTool();
    const onUpdate = vi.fn();
    const promise = tool.execute('call-1', { code: 'x' }, undefined, onUpdate);

    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;

    expect(send).toHaveBeenCalledTimes(3);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[0][0].details).toMatchObject({ waitingForUserScriptsToggle: true, attempts: 1 });
    expect(onUpdate.mock.calls[1][0].details).toMatchObject({ waitingForUserScriptsToggle: true, attempts: 2 });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('已注入并执行脚本') });
  });

  it('throws immediately for a non-toggle failure without entering the wait loop', async () => {
    vi.spyOn(messaging, 'sendMessage').mockResolvedValueOnce({
      id: '1',
      ok: false,
      error: '脚本语法错误：Unexpected token',
    });

    const tool = getInjectTool();
    await expect(tool.execute('call-1', { code: 'x(' })).rejects.toThrow('脚本语法错误');
    expect(messaging.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('stops waiting and throws an AbortError when the signal is aborted mid-wait', async () => {
    const send = vi.spyOn(messaging, 'sendMessage');
    send.mockResolvedValue({ id: '1', ok: false, error: '请开启「允许用户脚本」开关后重试。' });

    const tool = getInjectTool();
    const controller = new AbortController();
    const promise = tool.execute('call-1', { code: 'x' }, controller.signal);
    const expectation = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2500);

    await expectation;
  });

  it('gives up with a timeout error after 3 minutes of retrying', async () => {
    const send = vi.spyOn(messaging, 'sendMessage');
    send.mockResolvedValue({ id: '1', ok: false, error: '请开启「允许用户脚本」开关后重试。' });

    const tool = getInjectTool();
    const promise = tool.execute('call-1', { code: 'x' });
    const expectation = expect(promise).rejects.toThrow('超时');

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 2500);

    await expectation;
  });
});
