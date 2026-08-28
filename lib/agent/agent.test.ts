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
import { buildSubmitIntentProbePayload, createBrowserAgentOptions, createModel, selectStreamFn } from './agent';
import { browserOpenAIStream } from './openai-stream';
import { browserAnthropicStream } from './anthropic-stream';
import { createTabSession } from './tab-session';
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

function afterContext(name: string, args: unknown, isError: boolean): AfterToolCallContext {
  return {
    toolCall: { id: `${name}-id`, name, arguments: args },
    args,
    assistantMessage: {},
    context: {},
    result: { content: [{ type: 'text', text: isError ? 'failed' : 'ok' }], details: {} },
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
