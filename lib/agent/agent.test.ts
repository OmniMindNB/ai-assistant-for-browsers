// lib/agent/agent.test.ts
import { describe, expect, it, vi } from 'vitest';
import type {
  AfterToolCallContext,
  BeforeToolCallContext,
  PrepareNextTurnContext,
} from '@earendil-works/pi-agent-core';
import type { ProviderConfig } from '@/lib/settings';
import { createBrowserAgentOptions, createModel, selectStreamFn } from './agent';
import { browserOpenAIStream } from './openai-stream';
import { browserAnthropicStream } from './anthropic-stream';

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
      context: { tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);
    expect(next?.context?.tools).toEqual([]);
    expect(await hooks.shouldStopAfterTurn?.({} as never)).toBe(false);
    expect(await hooks.shouldStopAfterTurn?.({} as never)).toBe(true);
    expect(steer).toHaveBeenCalledOnce();
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
});
