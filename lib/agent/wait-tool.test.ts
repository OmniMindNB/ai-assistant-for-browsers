import { describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from './tools';

function getWaitTool() {
  const tool = createBrowserTools(1).find((candidate) => candidate.name === 'wait');
  if (!tool) throw new Error('wait 未注册');
  return tool;
}

describe('wait', () => {
  it('is registered as a tool', () => {
    expect(getWaitTool().name).toBe('wait');
  });

  it('waits for the requested number of seconds', async () => {
    vi.useFakeTimers();
    try {
      const promise = getWaitTool().execute('call-1', { seconds: 3 });
      await vi.advanceTimersByTimeAsync(2999);
      let settled = false;
      promise.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const output = await promise;
      expect((output.content[0] as { text: string }).text).toContain('3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps seconds into the 1-15 range', async () => {
    vi.useFakeTimers();
    try {
      const promise = getWaitTool().execute('call-1', { seconds: 999 });
      await vi.advanceTimersByTimeAsync(15000);
      const output = await promise;
      expect(output.details).toEqual({ seconds: 15 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts early when the signal fires', async () => {
    const controller = new AbortController();
    const promise = getWaitTool().execute('call-1', { seconds: 10 }, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow('中止');
  });
});
