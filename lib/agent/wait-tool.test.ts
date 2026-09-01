import { describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from './tools';
import { createTabSession } from './tab-session';

function getWaitTool() {
  const tool = createBrowserTools(createTabSession(1)).find((candidate) => candidate.name === 'wait');
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

  // 对标 alibaba/page-agent 的 wait 工具：不能实打实睡满请求的秒数，要扣掉这次调用
  // 之前已经经过的时间（主要是模型生成这次 tool call 本身花掉的 LLM 往返延迟），
  // 否则等待会无谓地叠加在这段延迟之上。
  it('deducts time already elapsed since the tools were created before sleeping', async () => {
    vi.useFakeTimers();
    try {
      const tool = getWaitTool();
      await vi.advanceTimersByTimeAsync(1000); // 模拟工具创建后到这次调用之间流逝的 1s
      const promise = tool.execute('call-1', { seconds: 3 });

      await vi.advanceTimersByTimeAsync(1999); // 3s 请求 - 1s 已流逝 = 2s 应该睡；差 1ms
      let settled = false;
      promise.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('deducts time elapsed since the previous tool call finished, not just since tool creation', async () => {
    vi.useFakeTimers();
    try {
      const tool = getWaitTool();
      const first = tool.execute('call-1', { seconds: 1 }); // 建立一个"上一次工具调用完成"的时间点
      await vi.advanceTimersByTimeAsync(1000);
      await first;

      await vi.advanceTimersByTimeAsync(4000); // 模拟这次调用之前又流逝了 4s
      const promise = tool.execute('call-2', { seconds: 5 });

      await vi.advanceTimersByTimeAsync(999); // 5s 请求 - 4s 已流逝 = 1s 应该睡；差 1ms
      let settled = false;
      promise.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('sleeps for zero time (resolves without waiting) when elapsed time already exceeds the request', async () => {
    vi.useFakeTimers();
    try {
      const tool = getWaitTool();
      await vi.advanceTimersByTimeAsync(5000); // 比即将请求的 2s 更多
      const promise = tool.execute('call-1', { seconds: 2 });

      await vi.advanceTimersByTimeAsync(0);
      let settled = false;
      promise.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(true);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reports the originally requested seconds, not the reduced sleep duration', async () => {
    vi.useFakeTimers();
    try {
      const tool = getWaitTool();
      await vi.advanceTimersByTimeAsync(5000); // 比请求的 2s 更多，实际睡眠会被压到 0
      const promise = tool.execute('call-1', { seconds: 2 });
      await vi.advanceTimersByTimeAsync(0);
      const output = await promise;
      expect(output.details).toEqual({ seconds: 2 });
      expect((output.content[0] as { text: string }).text).toContain('2');
    } finally {
      vi.useRealTimers();
    }
  });
});
