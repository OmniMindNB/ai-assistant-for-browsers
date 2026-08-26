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
  it('expands to the write budget only after confirmation succeeds', async () => {
    const hooks = runtimeOptions({ onConfirm: async () => true });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#save' }))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#save' }, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({
      block: true,
      reason: expect.stringContaining('2'),
    });
  });

  it('keeps the read budget when confirmation is denied', async () => {
    const hooks = runtimeOptions({ onConfirm: async () => false });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#save' }))).toMatchObject({
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

  it('counts an initial and cached permission denial toward bounded block termination', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => false,
    });
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#save' }))).toMatchObject({
      block: true,
    });
    expect(
      await hooks.prepareNextTurnWithContext?.({ context: { messages: [], tools: [] } } as unknown as PrepareNextTurnContext),
    ).toBeUndefined();
    expect(await hooks.beforeToolCall?.(beforeContext('browser_type', { selector: '#name', text: 'Ada' }))).toMatchObject({
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

describe('执行期遮罩', () => {
  const overlayOptions = (onOverlay: () => void, approve: boolean) =>
    createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      steer: () => {},
      onConfirm: async () => approve,
      onOverlay,
    });

  it('写工具获批时通知一次遮罩打开', async () => {
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(beforeContext('browser_click', { selector: '#a', index: 0 }), undefined);

    expect(onOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, label: expect.any(String) }),
      1,
    );
  });

  it('只读工具不触发遮罩', async () => {
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(beforeContext('browser_read_page', {}), undefined);

    expect(onOverlay).not.toHaveBeenCalled();
  });

  it('用户拒绝确认时不打开遮罩', async () => {
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, false);

    await options.beforeToolCall!(beforeContext('browser_click', { selector: '#a', index: 0 }), undefined);

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
    await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#a' }));
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
});
