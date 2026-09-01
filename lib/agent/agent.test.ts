// lib/agent/agent.test.ts
const sendMessageSpy = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessageSpy(...args) };
});

import { describe, expect, it, vi } from 'vitest';
import type {
  AfterToolCallContext,
  AgentMessage,
  BeforeToolCallContext,
  PrepareNextTurnContext,
} from '@earendil-works/pi-agent-core';
import type { ProviderConfig } from '@/lib/settings';
import {
  buildSubmitIntentProbePayload,
  createBrowserAgentOptions,
  createModel,
  selectStreamFn,
  CONTEXT_RECUT_TARGET,
  MAX_CONTEXT_MESSAGES,
} from './agent';
import { DEFAULT_WRITE_TOOL_CALL_BUDGET } from './system-prompt';
import { browserOpenAIStream } from './openai-stream';
import { browserAnthropicStream } from './anthropic-stream';
import { createTabSession } from './tab-session';
import { describeToolActivity } from './activity-description';
import type { BrowserAgentTool } from './tools';

const baseProvider: ProviderConfig = {
  id: 'p-1',
  name: 'Test',
  baseURL: 'https://example.com/v1',
  apiKey: 'key',
  model: 'test-model',
};

function beforeContext(name: string, args: unknown): BeforeToolCallContext {
  return {
    toolCall: { id: `${name}-id`, name, arguments: args },
    args,
    assistantMessage: {},
    context: {},
  } as unknown as BeforeToolCallContext;
}

function afterContext(
  name: string,
  args: unknown,
  isError: boolean,
  details: Record<string, unknown> = {},
): AfterToolCallContext {
  return {
    toolCall: { id: `${name}-id`, name, arguments: args },
    args,
    assistantMessage: {},
    context: {},
    result: { content: [{ type: 'text', text: isError ? 'failed' : 'ok' }], details },
    isError,
  } as unknown as AfterToolCallContext;
}

function textOnlyMessage(text: string) {
  return { content: [{ type: 'text', text }] };
}

function toolCallStillPendingMessage(name: string) {
  return { content: [{ type: 'toolCall', id: `${name}-id`, name, arguments: {} }] };
}

function runtimeOptions(overrides: { onConfirm?: () => Promise<boolean> } = {}) {
  return createBrowserAgentOptions({
    provider: baseProvider,
    tabId: 1,
    tools: [],
    readToolCallBudget: 1,
    writeToolCallBudget: 2,
    steer: vi.fn(),
    ...overrides,
  });
}

describe('createBrowserAgentOptions tool policy hooks', () => {
  it('expands to the write budget when an auto-allowed write starts', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: false } });
    const hooks = runtimeOptions();
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#menu' }))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#menu' }, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({
      block: true,
      reason: expect.stringContaining('2'),
    });
  });

  it('expands to the write budget only after confirmation succeeds', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: true } });
    const hooks = runtimeOptions({ onConfirm: async () => true });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit' }))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#submit' }, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({
      block: true,
      reason: expect.stringContaining('2'),
    });
  });

  it('keeps the read budget when confirmation is denied', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: true } });
    const hooks = runtimeOptions({ onConfirm: async () => false });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit' }))).toMatchObject({
      block: true,
    });
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({
      block: true,
      reason: expect.stringContaining('1'),
    });
  });

  it('removes tools for one final turn and then stops', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 1,
      writeToolCallBudget: 2,
      steer,
    });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);
    expect(next?.context?.tools).toEqual([]);
    expect(next?.context?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('工具调用预算已经用完'),
    });
    expect(await hooks.shouldStopAfterTurn?.({} as never)).toBe(false);
    expect(await hooks.shouldStopAfterTurn?.({} as never)).toBe(true);
    expect(steer).not.toHaveBeenCalled();
  });

  it('blocks a third identical failed execution before permission or execution', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_query_dom', { selector: '.x', limit: 2 }, true));
    await hooks.afterToolCall?.(afterContext('browser_query_dom', { limit: 2, selector: '.x' }, true));
    expect(
      await hooks.beforeToolCall?.(beforeContext('browser_query_dom', { selector: '.x', limit: 2 })),
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining('连续失败两次'),
    });
  });

  it('counts two detected-submit denials toward bounded block termination', async () => {
    sendMessageSpy
      .mockResolvedValueOnce({ ok: true, data: { isSubmit: true } })
      .mockResolvedValueOnce({ ok: true, data: { isSubmit: true } });
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => false,
    });
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-a' }))).toMatchObject({
      block: true,
    });
    expect(
      await hooks.prepareNextTurnWithContext?.({ context: { messages: [], tools: [] } } as unknown as PrepareNextTurnContext),
    ).toBeUndefined();
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-b' }))).toMatchObject({
      block: true,
    });
    expect(
      await hooks.prepareNextTurnWithContext?.({ context: { messages: [], tools: [{}] } } as unknown as PrepareNextTurnContext),
    ).toMatchObject({ context: { tools: [] } });
  });

  it('counts dossier guard blocks toward bounded block termination', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_inspect_page_implementation', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({ block: true });
    expect(
      await hooks.prepareNextTurnWithContext?.({ context: { messages: [], tools: [] } } as unknown as PrepareNextTurnContext),
    ).toBeUndefined();
    expect(await hooks.beforeToolCall?.(beforeContext('browser_get_page_meta', {}))).toMatchObject({ block: true });
    expect(
      await hooks.prepareNextTurnWithContext?.({ context: { messages: [], tools: [{}] } } as unknown as PrepareNextTurnContext),
    ).toMatchObject({ context: { tools: [] } });
  });
});

describe('createBrowserAgentOptions task outcome forcing', () => {
  const reportTaskOutcomeTool = { name: 'report_task_outcome' } as unknown as BrowserAgentTool;

  function hooksWithTool(overrides: { onTaskOutcome?: (outcome: unknown) => void; steer?: (m: AgentMessage) => void } = {}) {
    return createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: overrides.steer ?? vi.fn(),
      onTaskOutcome: overrides.onTaskOutcome,
    });
  }

  it('does not force a closing turn when no write tool ran this run', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('does not force a closing turn while the model still has pending tool calls', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_click'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('forces exactly one closing turn restricted to report_task_outcome after a write with no outcome reported', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));

    const first = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(first?.context?.tools).toEqual([reportTaskOutcomeTool]);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0][0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('report_task_outcome'),
    });

    // 模型在被强制的这一轮仍然没有调用，也只补一次，不会无限重试。
    const second = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('still nothing'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(second).toBeUndefined();
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it('does not force a closing turn once report_task_outcome has already been called', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    await hooks.afterToolCall?.(afterContext('report_task_outcome', { outcome: 'success', reason: 'ok' }, false));

    const next = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('does not force a closing turn when report_task_outcome is not among the available tools', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer,
    });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  // 预算耗尽的那一轮恰恰是最需要 failure 徽标的一轮：既有分支原来无条件返回 tools: []，
  // 模型在唯一一次收尾轮里根本没有 report_task_outcome 可调（ref: 最终审查 Important）。
  it('offers report_task_outcome during the final turn when the budget is exhausted and a report is still owed', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 1,
      steer,
    });
    // 写工具跑过一次，预算随即耗尽（读=写预算=1）。
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_click'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);

    expect(next?.context?.tools).toEqual([reportTaskOutcomeTool]);
    const content = (next?.context?.messages.at(-1) as { content: string }).content;
    expect(content).toContain('工具调用预算已经用完');
    expect(content).toContain('report_task_outcome');
  });

  // 单次触发：预算分支已经把 outcomeForceAttempted 置位，之后 else if 分支不会再补一次。
  it('does not force a second closing turn after the budget branch already offered the tool', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 1,
      steer,
    });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_click'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);

    // 阶段机已经离开 active，prepareFinalResponse 不会再返回 true；此时若 outcomeForceAttempted
    // 没被置位，下面这次调用会走 else if 分支再补一轮 steer。
    const second = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('still nothing'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(second).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('keeps the budget-exhaustion branch byte-identical when no report is owed', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 2,
      steer,
    });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false)); // 只读，没有写工具跑过
    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_read_page'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);

    expect(next?.context?.tools).toEqual([]);
    expect((next?.context?.messages.at(-1) as { content: string }).content).toBe(
      '工具调用预算已经用完。不要再调用任何工具，请立即基于已有结果给出最终回答，并明确说明仍不确定的部分。',
    );
  });

  it('keeps the budget-exhaustion branch byte-identical when the outcome was already reported', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 1,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    await hooks.afterToolCall?.(afterContext('report_task_outcome', { outcome: 'success', reason: 'ok' }, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_click'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);

    expect(next?.context?.tools).toEqual([]);
    expect((next?.context?.messages.at(-1) as { content: string }).content).toBe(
      '工具调用预算已经用完。不要再调用任何工具，请立即基于已有结果给出最终回答，并明确说明仍不确定的部分。',
    );
  });

  // 连续被阻断的收尾分支走的是同一段代码，同样要在欠汇报时把工具递回去。
  it('offers report_task_outcome on the consecutive-block final turn when a report is still owed', async () => {
    sendMessageSpy
      .mockResolvedValueOnce({ ok: true, data: { isSubmit: true } })
      .mockResolvedValueOnce({ ok: true, data: { isSubmit: true } });
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => false,
    });
    // 先成功跑一次写工具，这样确实欠一次汇报。
    await hooks.afterToolCall?.(afterContext('browser_modify_dom', { selector: '#a' }, false));
    // 再连续两次被拒绝（pre-execution block），触发「连续被阻止」收尾。
    await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-a' }));
    await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-b' }));

    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_click'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);

    expect(next?.context?.tools).toEqual([reportTaskOutcomeTool]);
    const content = (next?.context?.messages.at(-1) as { content: string }).content;
    expect(content).toContain('工具调用连续被阻止');
    expect(content).toContain('report_task_outcome');
  });

  it('never blocks report_task_outcome on an exhausted budget', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 1,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false)); // 预算耗尽
    // 对照组：普通只读工具此时确实被硬阻断。
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({ block: true });
    // report_task_outcome 完全豁免预算 preflight。
    expect(
      await hooks.beforeToolCall?.(beforeContext('report_task_outcome', { outcome: 'failure', reason: '预算用尽。' })),
    ).toBeUndefined();
  });

  it('does not consume a budget slot when report_task_outcome executes', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 2,
      writeToolCallBudget: 2,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false)); // 1/2
    await hooks.afterToolCall?.(afterContext('report_task_outcome', { outcome: 'success', reason: 'ok' }, false));
    // 如果上面那次算进了预算，这里就是 2/2 已耗尽，只读工具会被阻断。
    expect(await hooks.beforeToolCall?.(beforeContext('browser_query_dom', { selector: '.x' }))).toBeUndefined();
  });

  it('threads onTaskOutcome through to the default report_task_outcome tool', async () => {
    const onTaskOutcome = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onTaskOutcome,
    });
    const tool = (hooks.initialState!.tools as BrowserAgentTool[]).find((t) => t.name === 'report_task_outcome');
    expect(tool).toBeDefined();
    await tool!.execute('call-1', { outcome: 'partial', reason: '只完成了一半。' });
    expect(onTaskOutcome).toHaveBeenCalledWith({ outcome: 'partial', reason: '只完成了一半。' });
  });
});

describe('执行期遮罩', () => {
  const overlayOptions = (onOverlay: () => void, approve: boolean) =>
    createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      steer: () => {},
      onConfirm: async () => approve,
      onOverlay,
    });

  it('自动导航会通知一次遮罩打开', async () => {
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(beforeContext('browser_navigate', { url: 'https://example.com/next' }), undefined);

    expect(onOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, label: expect.any(String) }),
      1,
    );
  });

  it('非提交自动点击不弹确认并打开遮罩', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: false } });
    const onConfirm = vi.fn();
    const onOverlay = vi.fn();
    const options = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      steer: () => {},
      onConfirm,
      onOverlay,
    });

    await options.beforeToolCall!(beforeContext('browser_click', { selector: '#menu', index: 0 }), undefined);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOverlay).toHaveBeenCalledWith(expect.objectContaining({ active: true }), 1);
  });

  it('只读工具不触发遮罩', async () => {
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(beforeContext('browser_read_page', {}), undefined);

    expect(onOverlay).not.toHaveBeenCalled();
  });

  it('用户拒绝确认时不打开遮罩', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: true } });
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, false);

    await options.beforeToolCall!(beforeContext('browser_click', { selector: '#submit', index: 0 }), undefined);

    expect(onOverlay).not.toHaveBeenCalled();
  });
});

// ref: docs/superpowers/specs/2026-08-31-page-agent-benchmark.md §3.2 —
// browser_navigate/browser_open_tab 自己的结果文案已经告诉模型跳到哪了；这里只补
// browser_click / browser_fill_form / browser_type 隐式触发的导航，此前对模型完全不可见。
describe('隐式导航的 <sys> 观察通道', () => {
  function hooksWithSteer(steer: (m: AgentMessage) => void = vi.fn()) {
    return createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer,
    });
  }

  it('browser_navigate 从自身结果里静默记录基线，不额外查询 URL 也不发观察消息', async () => {
    sendMessageSpy.mockClear();
    const steer = vi.fn();
    const hooks = hooksWithSteer(steer);

    await hooks.afterToolCall?.(
      afterContext('browser_navigate', { url: 'https://example.com/a' }, false, { url: 'https://example.com/a' }),
    );

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it('该 tab 还没有基线时，隐式点击只静默记录，不误报"已跳转"', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/first' } });
    const steer = vi.fn();
    const hooks = hooksWithSteer(steer);

    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));

    expect(steer).not.toHaveBeenCalled();
  });

  it('隐式点击导致 URL 变化时，追加一句观察消息并等待页面稳定后才把控制权交还给模型', async () => {
    vi.useFakeTimers();
    try {
      const steer = vi.fn();
      const hooks = hooksWithSteer(steer);
      await hooks.afterToolCall?.(
        afterContext('browser_navigate', { url: 'https://example.com/a' }, false, { url: 'https://example.com/a' }),
      );
      sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/b' } });

      let settled = false;
      const pending = hooks.afterToolCall
        ?.(afterContext('browser_click', { selector: '#a' }, false))
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(steer).toHaveBeenCalledTimes(1);
      expect(steer.mock.calls[0][0]).toMatchObject({
        role: 'user',
        content: expect.stringContaining('https://example.com/a'),
      });
      expect((steer.mock.calls[0][0] as { content: string }).content).toContain('https://example.com/b');

      await vi.advanceTimersByTimeAsync(500);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('隐式点击后 URL 未变化则不发观察消息也不等待', async () => {
    const steer = vi.fn();
    const hooks = hooksWithSteer(steer);
    await hooks.afterToolCall?.(
      afterContext('browser_navigate', { url: 'https://example.com/a' }, false, { url: 'https://example.com/a' }),
    );
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/a' } });

    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));

    expect(steer).not.toHaveBeenCalled();
  });

  it('browser_fill_form 与 browser_type 同样纳入隐式导航监听', async () => {
    const steer = vi.fn();
    const hooks = hooksWithSteer(steer);
    await hooks.afterToolCall?.(
      afterContext('browser_navigate', { url: 'https://example.com/a' }, false, { url: 'https://example.com/a' }),
    );

    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/submitted' } });
    await hooks.afterToolCall?.(afterContext('browser_fill_form', { fields: [] }, false));
    expect(steer).toHaveBeenCalledTimes(1);

    steer.mockClear();
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/typed' } });
    await hooks.afterToolCall?.(afterContext('browser_type', { fieldId: 'f1', text: 'x' }, false));
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it('工具执行失败时不查询 URL、也不产生观察消息', async () => {
    sendMessageSpy.mockClear();
    const steer = vi.fn();
    const hooks = hooksWithSteer(steer);

    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, true));

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });
});

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantToolCallMessage(id: string, name: string, args: Record<string, unknown>): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
  } as unknown as AgentMessage;
}

function toolResultMessage(toolCallId: string, toolName: string, text: string, isError = false): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function resultText(message: AgentMessage): string {
  return ((message as unknown as { content: { type: string; text: string }[] }).content[0]).text;
}

// ref: docs/superpowers/specs/2026-08-31-page-agent-benchmark.md §3.1 —
// 对方每步从 history 重建 prompt，只挂当前这一份浏览器状态；旧的 DOM/HTML dump 完全不进
// 上下文。我们没有强制自评字段，改用已有的 describeToolActivity 一句话摘要作为压缩来源。
describe('上下文压缩：只读工具的历史结果压成一句话摘要', () => {
  it('把更早的只读工具结果压成一句话摘要，只保留最新一份完整内容', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_read_page', {}),
      toolResultMessage('call-1', 'browser_read_page', 'PAGE TEXT A'.repeat(50)),
      assistantToolCallMessage('call-2', 'browser_click', { selector: '#a' }),
      toolResultMessage('call-2', 'browser_click', '已点击 "#a"。'),
      assistantToolCallMessage('call-3', 'browser_read_page', {}),
      toolResultMessage('call-3', 'browser_read_page', 'PAGE TEXT B (current)'),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1])).toBe(describeToolActivity('browser_read_page', {}, 'done'));
    expect(resultText(compacted[3])).toBe('已点击 "#a"。');
    expect(resultText(compacted[5])).toBe('PAGE TEXT B (current)');
  });

  it('用工具调用当时的参数生成摘要文案', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_query_dom', { selector: '.old-target' }),
      toolResultMessage('call-1', 'browser_query_dom', 'huge dom dump'),
      assistantToolCallMessage('call-2', 'browser_read_page', {}),
      toolResultMessage('call-2', 'browser_read_page', 'latest page text'),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1])).toBe(
      describeToolActivity('browser_query_dom', { selector: '.old-target' }, 'done'),
    );
  });

  it('压缩失败的旧读取结果时保留失败状态', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_get_html', { selector: '#x' }),
      toolResultMessage('call-1', 'browser_get_html', 'error: not found', true),
      assistantToolCallMessage('call-2', 'browser_read_page', {}),
      toolResultMessage('call-2', 'browser_read_page', 'latest'),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1])).toBe(describeToolActivity('browser_get_html', { selector: '#x' }, 'failed'));
  });

  it('browser_get_form 的旧结果有专门的摘要文案，不落入通用兜底', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_get_form', {}),
      toolResultMessage('call-1', 'browser_get_form', 'huge form structure dump'),
      assistantToolCallMessage('call-2', 'browser_read_page', {}),
      toolResultMessage('call-2', 'browser_read_page', 'latest'),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1])).not.toBe(describeToolActivity('browser_unknown_tool', {}, 'done'));
    expect(resultText(compacted[1])).toBe(describeToolActivity('browser_get_form', {}, 'done'));
  });

  it('非只读工具的历史结果原样保留，不参与摘要压缩', async () => {
    const hooks = runtimeOptions();
    const longWriteText = 'X'.repeat(500);
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_fill_form', { fields: [] }),
      toolResultMessage('call-1', 'browser_fill_form', longWriteText),
      assistantToolCallMessage('call-2', 'browser_read_page', {}),
      toolResultMessage('call-2', 'browser_read_page', 'latest'),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1])).toBe(longWriteText);
  });

  it('最新一份读取结果超长时仍按 MAX_TOOL_RESULT_CHARS 截断（安全网保留）', async () => {
    const hooks = runtimeOptions();
    const hugeText = 'A'.repeat(40000);
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_read_page', {}),
      toolResultMessage('call-1', 'browser_read_page', hugeText),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1]).length).toBeLessThan(hugeText.length);
    expect(resultText(compacted[1])).toContain('已截断');
  });
});

describe('selectStreamFn', () => {
  it('returns browserOpenAIStream when api is undefined (default)', () => {
    expect(selectStreamFn(baseProvider)).toBe(browserOpenAIStream);
  });

  it('returns browserOpenAIStream when api is openai-completions', () => {
    expect(selectStreamFn({ ...baseProvider, api: 'openai-completions' })).toBe(browserOpenAIStream);
  });

  it('returns browserAnthropicStream when api is anthropic-messages', () => {
    expect(selectStreamFn({ ...baseProvider, api: 'anthropic-messages' })).toBe(browserAnthropicStream);
  });
});

describe('createModel', () => {
  it('sets api to openai-completions by default', () => {
    expect(createModel(baseProvider).api).toBe('openai-completions');
  });

  it('sets api to anthropic-messages when configured', () => {
    expect(createModel({ ...baseProvider, api: 'anthropic-messages' }).api).toBe('anthropic-messages');
  });

  it('keeps id/provider/baseUrl derived from the ProviderConfig', () => {
    const model = createModel(baseProvider);
    expect(model.id).toBe('test-model');
    expect(model.provider).toBe('p-1');
    expect(model.baseUrl).toBe('https://example.com/v1');
  });

  it('declares both text and image input support', () => {
    expect(createModel(baseProvider).input).toEqual(['text', 'image']);
  });
});

describe('buildSubmitIntentProbePayload', () => {
  it('builds a fieldId probe payload for browser_click with a fieldId', () => {
    expect(buildSubmitIntentProbePayload('browser_click', { fieldId: 'f7' })).toEqual({
      submitFieldId: 'f7',
      fieldIds: ['f7'],
    });
  });

  it('falls back to selector/index for browser_click without a fieldId', () => {
    expect(buildSubmitIntentProbePayload('browser_click', { selector: '#save', index: 2 })).toEqual({
      selector: '#save',
      index: 2,
    });
  });

  it('keeps the existing fill_form payload shape', () => {
    expect(
      buildSubmitIntentProbePayload('browser_fill_form', {
        fields: [{ fieldId: 'f1' }, { fieldId: 'f2' }],
        submit: { fieldId: 'f9' },
      }),
    ).toEqual({ submitFieldId: 'f9', fieldIds: ['f1', 'f2'] });
  });
});

// 修复前预算是纯硬阻断：模型毫无预警地被挡下。这里在跌到阈值时先软提醒一次，
// 给它自己收尾的机会（ref: lib/agent/tool-policy.ts 的 budgetWarning）。
describe('createBrowserAgentOptions budget warnings', () => {
  function withBudget(steer: (message: AgentMessage) => void, readToolCallBudget: number) {
    return createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget,
      writeToolCallBudget: readToolCallBudget,
      steer,
    });
  }

  // 预算 8：第 2 次调用后还剩 6（不提醒），第 3 次后剩 5，命中阈值。
  it('steers a warning once the remaining budget hits the threshold', async () => {
    const steer = vi.fn<(message: AgentMessage) => void>();
    const hooks = withBudget(steer, 8);
    for (let i = 0; i < 2; i += 1) await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(steer).not.toHaveBeenCalled();

    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0][0]).toMatchObject({ role: 'user', content: expect.stringContaining('5 次') });
  });

  it('does not repeat the same warning on the next tool call', async () => {
    const steer = vi.fn<(message: AgentMessage) => void>();
    const hooks = withBudget(steer, 8);
    for (let i = 0; i < 4; i += 1) await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(steer).toHaveBeenCalledTimes(1);
  });
});

describe('多标签页：session 可选，且遮罩跟随当前操作目标', () => {
  it('未传 session 时退化为单 tab，行为与改动前一致', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => true,
    });
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#a' }))).toBeUndefined();
  });

  it('切换当前操作 tab 后，遮罩先关旧目标再开新目标', async () => {
    const session = createTabSession(1);
    const onOverlay = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      session,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => true,
      onOverlay,
    });

    // 先批准一次写操作，遮罩在 tab 1 上打开
    await hooks.beforeToolCall?.(beforeContext('browser_navigate', { url: 'https://example.com/a' }));
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    expect(onOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }), 1);

    // browser_open_tab 执行后 session.currentTabId 变成 2（工具自己会调用 session.openAndSwitch；
    // 这里手动模拟工具执行完成后的状态，因为 tools 数组是空的 [] ）
    session.openAndSwitch({ id: 2, title: 'Example' });
    await hooks.afterToolCall?.(afterContext('browser_open_tab', { url: 'https://example.com' }, false));

    expect(onOverlay).toHaveBeenCalledWith(expect.objectContaining({ active: false }), 1);
    expect(onOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }), 2);
  });

  it('PROBE_CLICK_TARGET 探测使用 session.currentTabId，不是面板绑定的 tabId', async () => {
    sendMessageSpy.mockClear();
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2 });
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      session,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => true,
    });

    await hooks.beforeToolCall?.(beforeContext('browser_click', { fieldId: 'f1' }), undefined);

    expect(sendMessageSpy).toHaveBeenCalledWith(
      'PROBE_CLICK_TARGET',
      expect.objectContaining({ submitFieldId: 'f1' }),
      2,
    );
  });

  it('表单提交意图探测失败时按普通已知操作自动执行', async () => {
    sendMessageSpy.mockRejectedValueOnce(new Error('message channel unavailable'));
    const onConfirm = vi.fn().mockResolvedValue(true);
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm,
    });

    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#continue' }))).toBeUndefined();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('检测到的表单提交每次确认，不受目标 tab 或既有批准影响', async () => {
    sendMessageSpy
      .mockResolvedValueOnce({ ok: true, data: { isSubmit: true } })
      .mockResolvedValueOnce({ ok: true, data: { isSubmit: true } })
      .mockResolvedValueOnce({ ok: true, data: { isSubmit: true } });
    const session = createTabSession(1);
    const onConfirm = vi.fn().mockResolvedValue(true);
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      session,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm,
    });

    // 在 tab 1 上批准一次检测到的提交。
    await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-a' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // browser_open_tab 把当前操作目标切到 tab 2（模拟工具执行后的效果）。
    session.openAndSwitch({ id: 2, title: 'Example' });

    // 同一轮里对 tab 2 的提交仍然必须确认。
    await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-b' }));
    expect(onConfirm).toHaveBeenCalledTimes(2);

    // 切回 tab 1 后再次提交也必须确认；confirm_always 从不复用决定。
    session.switchTo(1);
    await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-c' }));
    expect(onConfirm).toHaveBeenCalledTimes(3);
  });

  it('onSessionChange 在 open/switch/close 成功后立即触发，不等回合结束才存（最终审查 Important #4）', async () => {
    const session = createTabSession(1);
    const onSessionChange = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      session,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => true,
      onSessionChange,
    });

    // browser_open_tab 成功执行后（工具自己会调用 session.openAndSwitch；这里手动模拟）。
    session.openAndSwitch({ id: 2, title: 'Example' });
    await hooks.afterToolCall?.(afterContext('browser_open_tab', { url: 'https://example.com' }, false));
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenLastCalledWith(session);

    // 关掉一个非当前 tracked tab：currentTabId 不变，但 trackedTabs 变了，也要通知。
    session.openAndSwitch({ id: 3, title: 'Other' });
    session.switchTo(2); // 2 是当前目标，3 不是
    await hooks.afterToolCall?.(afterContext('browser_open_tab', { url: 'https://other.example.com' }, false));
    onSessionChange.mockClear();
    session.close(3);
    await hooks.afterToolCall?.(afterContext('browser_close_tab', { tabId: 3 }, false));
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenLastCalledWith(session);

    // 失败的调用不触发。
    onSessionChange.mockClear();
    await hooks.afterToolCall?.(afterContext('browser_switch_tab', { tabId: 2 }, true));
    expect(onSessionChange).not.toHaveBeenCalled();
  });
});

// 实测复现（2026-09-01 侧边栏 perf 采样）：一次 19 轮的运行在最后一轮收到
// DeepSeek 400 —— "Messages with role 'tool' must be a response to a preceding
// message with 'tool_calls'"，整轮运行没有产出任何回答。原因是 slice(-MAX_CONTEXT_MESSAGES)
// 是按条数盲切的，切点可能落在「带 tool_calls 的 assistant 消息」和它的 toolResult 之间，
// 于是窗口以一条无主的 toolResult 开头，OpenAI 兼容协议一律判 400。
describe('上下文压缩：窗口边界不得切出无主的 toolResult', () => {
  // 严格 A/R 交替时 slice(-24) 永远落在 assistant 上；真正打破奇偶、让切点落到
  // toolResult 上的是中途插入的单条 user 消息——正是 afterToolCall 里 [系统观察]
  // 导航通知和预算软提醒这两处 steer 干的事。下面按真实形态构造。
  // 长度取 MAX_CONTEXT_MESSAGES + 2，保证一定触发重切；前半段 12 对之后插入一条 steer
  // user 消息打破奇偶，使重切点 length - CONTEXT_RECUT_TARGET 正好落在一条 toolResult 上。
  // 下面的前置断言会在常量改动导致夹具失效时直接报错，而不是让测试悄悄空转。
  const FIRST_BLOCK_PAIRS = 12;

  function conversationWithSteer(): AgentMessage[] {
    const total = MAX_CONTEXT_MESSAGES + 2;
    const secondBlockPairs = (total - 2 - FIRST_BLOCK_PAIRS * 2) / 2;
    const messages: AgentMessage[] = [userMessage('开始')];
    for (let index = 0; index < FIRST_BLOCK_PAIRS; index += 1) {
      messages.push(assistantToolCallMessage(`call-a${index}`, 'browser_type', { text: `a${index}` }));
      messages.push(toolResultMessage(`call-a${index}`, 'browser_type', `已输入 a${index}。`));
    }
    messages.push(userMessage('[系统观察] 页面地址已变化。'));
    for (let index = 0; index < secondBlockPairs; index += 1) {
      messages.push(assistantToolCallMessage(`call-b${index}`, 'browser_type', { text: `b${index}` }));
      messages.push(toolResultMessage(`call-b${index}`, 'browser_type', `已输入 b${index}。`));
    }
    return messages;
  }

  it('切点落在 assistant(tool_calls) 与它的 toolResult 之间时，不把这条 toolResult 单独留在窗口开头', async () => {
    const hooks = runtimeOptions();
    const messages = conversationWithSteer();
    // 前置条件：重切点确实落在一条 toolResult 上，盲切会把它对应的 assistant 丢在窗口外。
    const recutIndex = messages.length - CONTEXT_RECUT_TARGET;
    expect(messages.length).toBeGreaterThan(MAX_CONTEXT_MESSAGES);
    expect((messages[recutIndex] as unknown as { role: string }).role).toBe('toolResult');

    const compacted = await hooks.transformContext!(messages);
    const first = compacted[0] as unknown as { role: string };

    expect(first.role).not.toBe('toolResult');
  });

  it('每一条 toolResult 在窗口内都能找到它对应的 tool_calls', async () => {
    const hooks = runtimeOptions();
    const messages = conversationWithSteer();

    const compacted = await hooks.transformContext!(messages);
    const announced = new Set<string>();
    for (const message of compacted as unknown as {
      role: string;
      toolCallId?: string;
      content?: { type: string; id?: string }[];
    }[]) {
      if (message.role === 'assistant') {
        for (const part of message.content ?? []) {
          if (part.type === 'toolCall' && part.id) announced.add(part.id);
        }
      }
      if (message.role === 'toolResult') {
        expect(announced.has(message.toolCallId!)).toBe(true);
      }
    }
  });
});

// 实测（2026-09-01 perf 采样，DeepSeek 前缀缓存）：消息数一撞到窗口上限，命中 token 数
// 就从逐轮增长变成死死钉在 4224——那正好是静态系统提示词的大小，意味着整段对话每轮都在
// 重新处理。原因是 slice(-N) 每轮都把窗口往前挪两条，请求前缀逐轮都不一样，缓存必然全失效。
// 修法是给窗口加迟滞：只在超过高水位时重切一次到低水位，两次重切之间起点固定不动，
// 请求前缀只增不改，缓存才有得命中。
describe('上下文窗口：迟滞重切，保证前缀在两次重切之间只增不改', () => {
  function pairs(count: number, prefix: string): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (let index = 0; index < count; index += 1) {
      messages.push(assistantToolCallMessage(`${prefix}-${index}`, 'browser_type', { text: `${index}` }));
      messages.push(toolResultMessage(`${prefix}-${index}`, 'browser_type', `已输入 ${index}。`));
    }
    return messages;
  }

  function firstText(message: AgentMessage): string {
    return JSON.stringify((message as unknown as { content: unknown }).content);
  }

  it('未超过高水位时一条都不切', async () => {
    const hooks = runtimeOptions();
    const messages = pairs(MAX_CONTEXT_MESSAGES / 2, 'call');

    const compacted = await hooks.transformContext!(messages);

    expect(compacted).toHaveLength(messages.length);
  });

  it('超过高水位后重切到低水位，而不是只切掉溢出的那两条', async () => {
    const hooks = runtimeOptions();
    const messages = pairs(MAX_CONTEXT_MESSAGES, 'call'); // 2×MAX 条，远超高水位

    const compacted = await hooks.transformContext!(messages);

    expect(compacted.length).toBeLessThanOrEqual(CONTEXT_RECUT_TARGET);
  });

  it('重切之后连续多轮追加消息，窗口起点保持不动（前缀只增不改）', async () => {
    const hooks = runtimeOptions();
    const messages = pairs(MAX_CONTEXT_MESSAGES, 'call');

    const firstWindow = await hooks.transformContext!(messages);
    const anchor = firstText(firstWindow[0]);

    // 再追加若干轮，只要没再次撞到高水位，窗口开头必须还是同一条消息。
    for (let round = 0; round < 3; round += 1) {
      messages.push(...pairs(1, `later-${round}`));
      const next = await hooks.transformContext!(messages);
      expect(firstText(next[0])).toBe(anchor);
      // 而且是纯追加：旧窗口的每一条都还在，位置不变。
      expect(next.length).toBeGreaterThan(firstWindow.length);
    }
  });

  it('高水位与写入预算匹配，不会让长任务后半程一直待在滑动窗口里', () => {
    // 写入预算 40 次工具调用 ≈ 80 条消息；窗口高水位至少要能覆盖预算的一半，
    // 否则任务刚过半就进入逐轮重切、缓存全失效的状态。
    expect(MAX_CONTEXT_MESSAGES).toBeGreaterThanOrEqual(DEFAULT_WRITE_TOOL_CALL_BUDGET);
    expect(CONTEXT_RECUT_TARGET).toBeLessThan(MAX_CONTEXT_MESSAGES);
  });
});
