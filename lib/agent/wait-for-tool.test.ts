import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTabSession } from './tab-session';

const sendMessage = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessage(...args) };
});

const { createBrowserTools } = await import('./tools');
const { READ_ONLY_TOOL_NAMES, AUTO_APPROVE_TOOL_NAMES, decideToolPermission } = await import('./permissions');

function getWaitForTool() {
  const tool = createBrowserTools(createTabSession(1)).find((candidate) => candidate.name === 'browser_wait_for');
  if (!tool) throw new Error('browser_wait_for 未注册');
  return tool;
}

beforeEach(() => {
  sendMessage.mockReset();
});

describe('browser_wait_for 工具', () => {
  it('已注册', () => {
    expect(getWaitForTool().name).toBe('browser_wait_for');
  });

  it('把解析后的条件发给当前操作 tab', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { met: true, elapsedMs: 300, matched: 2 } });
    await getWaitForTool().execute('call-1', { kind: 'appear', selector: '.result' });

    expect(sendMessage).toHaveBeenCalledWith(
      'WAIT_FOR',
      { kind: 'appear', selector: '.result', idleMs: 500, timeoutMs: 5000 },
      1,
    );
  });

  it('命中时回报匹配数量与耗时', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { met: true, elapsedMs: 300, matched: 2 } });
    const output = await getWaitForTool().execute('call-1', { kind: 'appear', selector: '.result' });
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain('.result');
    expect(text).toContain('2');
  });

  // 超时是一个正常结果，不是异常：模型需要知道"等过了、没等到"才能改变策略。
  it('超时不抛异常，而是返回劝阻重试的文案', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { met: false, elapsedMs: 5000 } });
    const output = await getWaitForTool().execute('call-1', { kind: 'appear', selector: '.never' });
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain('超时');
    expect(text).toContain('不要原样重试');
  });

  it('参数非法时在发消息之前就抛出', async () => {
    await expect(getWaitForTool().execute('call-1', { kind: 'appear' })).rejects.toThrow('selector');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('页面报告非法选择器时抛出，让模型修正', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { met: false, elapsedMs: 5, error: '选择器非法' } });
    await expect(
      getWaitForTool().execute('call-1', { kind: 'appear', selector: ':::bad' }),
    ).rejects.toThrow('选择器非法');
  });
});

describe('browser_wait_for 的权限分级', () => {
  it('属于只读工具，不属于写工具', () => {
    expect(READ_ONLY_TOOL_NAMES.has('browser_wait_for')).toBe(true);
    expect(AUTO_APPROVE_TOOL_NAMES.has('browser_wait_for')).toBe(false);
  });

  it('按只读工具直接放行', () => {
    expect(decideToolPermission('browser_wait_for', { kind: 'domIdle' })).toEqual({ level: 'always_allow' });
  });
});
