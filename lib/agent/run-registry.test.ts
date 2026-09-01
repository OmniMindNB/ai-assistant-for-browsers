import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBrowserAgent: vi.fn(),
  replaceConversationMessages: vi.fn(async () => undefined),
  loadTabSession: vi.fn(async (tabId: number) => ({ panelTabId: tabId, currentTabId: tabId, trackedTabs: [], snapshot: () => ({}) })),
  saveTabSession: vi.fn(async () => undefined),
}));

vi.mock('./agent', () => ({ createBrowserAgent: mocks.createBrowserAgent }));
vi.mock('@/lib/db', () => ({ replaceConversationMessages: mocks.replaceConversationMessages }));
vi.mock('./tab-session-storage', () => ({
  loadTabSession: mocks.loadTabSession,
  saveTabSession: mocks.saveTabSession,
}));
vi.mock('./run-state-storage', () => ({
  saveRunStateSnapshot: vi.fn(async () => undefined),
  clearRunStateSnapshot: vi.fn(async () => undefined),
  loadRunStateSnapshot: vi.fn(async () => undefined),
  listOrphanRunTabIds: vi.fn(async () => []),
}));

import { startRun, getRunState } from './run-registry';
import type { StartRunRequest } from './run-port-protocol';

function makeFakeAgent(events: unknown[]) {
  let listener: ((event: unknown) => void) | undefined;
  return {
    subscribe: vi.fn((fn: (event: unknown) => void) => {
      listener = fn;
      return () => { listener = undefined; };
    }),
    prompt: vi.fn(async () => {
      for (const event of events) listener?.(event);
    }),
    abort: vi.fn(),
    state: { messages: [] },
  };
}

function makeRequest(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    type: 'startRun',
    tabId: 7,
    conversationId: 'conv-1',
    provider: { id: 'p1', name: 'p1', baseURL: 'https://x', apiKey: 'k', model: 'm' } as never,
    systemPrompt: 'sys',
    historyMessages: [],
    displayMessage: { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
    agentUserContent: 'hi',
    readToolCallBudget: 12,
    writeToolCallBudget: 24,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.createBrowserAgent.mockReset();
  mocks.replaceConversationMessages.mockClear();
});

describe('run-registry startRun', () => {
  it('creates a RunState, persists the initial history immediately, and streams text into the last assistant message', async () => {
    const agent = makeFakeAgent([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'lo' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
    ]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    const pushed: unknown[] = [];
    const ports = { push: (_tabId: number, snapshot: unknown) => pushed.push(snapshot) };

    await startRun(makeRequest(), ports);
    // startRun 不等待 agent.prompt() 跑完再返回；这里等一次微任务队列排空，
    // 让 fire-and-forget 的 prompt() 内部同步触发的事件先落地。
    await vi.waitFor(() => expect(mocks.replaceConversationMessages).toHaveBeenCalled());

    // 第一次落盘（startRun 内，agent.prompt 之前）必须已经包含用户消息，
    // 这正是本次迁移要修的 bug：用户消息不能只等到轮次结束才落盘。
    const firstCallMessages = (mocks.replaceConversationMessages.mock.calls[0] as unknown[])?.[1] as unknown[];
    expect(firstCallMessages).toBeDefined();
    expect(firstCallMessages.some((m: unknown) => (m as { role: string; content: string })?.role === 'user' && (m as { role: string; content: string })?.content === 'hi')).toBe(true);

    const state = getRunState(7);
    expect(state?.busy).toBe(false);
    const lastMessage = state?.messages[state.messages.length - 1];
    expect(lastMessage?.content).toBe('Hello');
  });

  it('aborts an existing run for the same tab before starting a new one', async () => {
    const firstAgent = makeFakeAgent([]);
    const secondAgent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValueOnce(firstAgent).mockReturnValueOnce(secondAgent);
    const ports = { push: () => undefined };

    await startRun(makeRequest(), ports);
    await startRun(makeRequest({ conversationId: 'conv-2', displayMessage: { id: 'u2', role: 'user', content: 'again', createdAt: 2 } }), ports);

    expect(firstAgent.abort).toHaveBeenCalledOnce();
  });

  it('message_end persists complete text even if flush debounce timer has not fired yet', async () => {
    vi.useFakeTimers();
    try {
      let listener: ((event: unknown) => void) | undefined;
      const agent = {
        subscribe: vi.fn((fn: (event: unknown) => void) => {
          listener = fn;
          return () => { listener = undefined; };
        }),
        prompt: vi.fn(async () => {
          // Fire a single text_delta followed immediately by message_end
          // (without advancing time, so the 48ms flush timer hasn't fired)
          listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } });
          listener?.({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
        }),
        abort: vi.fn(),
        state: { messages: [] },
      };
      mocks.createBrowserAgent.mockReturnValue(agent);
      mocks.replaceConversationMessages.mockClear();
      const ports = { push: () => undefined };

      await startRun(makeRequest({ tabId: 8 }), ports);
      // Let the fire-and-forget prompt() run
      await vi.runAllTimersAsync();

      // When message_end fires, it should persist the full text even though
      // the flush timer hasn't fired yet
      const callsToDb = mocks.replaceConversationMessages.mock.calls;
      expect(callsToDb.length).toBeGreaterThan(0);

      // Find the call that includes the assistant message (not the initial one)
      const messagesPersisted = callsToDb.filter(
        (call: unknown[]) => {
          const messages = call[1] as unknown[];
          return Array.isArray(messages) && messages.some(
            (m: unknown) => (m as { role: string; content?: string })?.role === 'assistant' && (m as { role: string; content?: string })?.content
          );
        }
      );

      expect(messagesPersisted.length).toBeGreaterThan(0);
      const lastCall = messagesPersisted[messagesPersisted.length - 1] as unknown[];
      const lastCallMessages = lastCall?.[1] as unknown[];
      expect(lastCallMessages).toBeDefined();
      const assistantMsg = lastCallMessages.find((m: unknown) => (m as { role: string })?.role === 'assistant');
      expect((assistantMsg as { content: string })?.content).toBe('Hello');
    } finally {
      vi.useRealTimers();
    }
  });

  it('old run\'s finally block does not clobber new run\'s state when old run settles after new run starts', async () => {
    let firstPromptResolve: (() => void) | undefined;
    let secondPromptResolve: (() => void) | undefined;

    const firstAgent = {
      subscribe: vi.fn((_fn: (event: unknown) => void) => {
        return () => {};
      }),
      prompt: vi.fn(async () => {
        // Don't resolve/reject until after the test tells us to
        await new Promise<void>((resolve) => { firstPromptResolve = resolve; });
      }),
      abort: vi.fn(),
      state: { messages: [] },
    };

    let secondListener: ((event: unknown) => void) | undefined;
    const secondAgent = {
      subscribe: vi.fn((fn: (event: unknown) => void) => {
        secondListener = fn;
        return () => { secondListener = undefined; };
      }),
      prompt: vi.fn(async () => {
        // Don't resolve until test tells us to, so the second run stays busy
        await new Promise<void>((resolve) => { secondPromptResolve = resolve; });
      }),
      abort: vi.fn(),
      state: { messages: [] },
    };

    mocks.createBrowserAgent.mockReturnValueOnce(firstAgent).mockReturnValueOnce(secondAgent);

    const ports = { push: () => undefined };
    const tabId = 9;

    // Start first run
    await startRun(makeRequest({ tabId }), ports);

    // Start second run (aborts the first)
    mocks.replaceConversationMessages.mockClear();
    await startRun(
      makeRequest({
        tabId,
        conversationId: 'conv-2',
        displayMessage: { id: 'u2', role: 'user', content: 'second', createdAt: 2 },
      }),
      ports
    );

    // Give the second run's async prompt a microtask to start
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify second run's state is in the registry and is busy
    const stateAfterSecond = getRunState(tabId);
    expect(stateAfterSecond?.conversationId).toBe('conv-2');
    expect(stateAfterSecond?.busy).toBe(true);

    // Now let the first run's prompt settle (while second run is still busy)
    firstPromptResolve?.();
    // Give the first run's finally block time to execute
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The state for tabId should still be the second run's, even though the first run's
    // finally block has executed
    const stateAfterFirstFinally = getRunState(tabId);
    expect(stateAfterFirstFinally?.conversationId).toBe('conv-2');
    expect(stateAfterFirstFinally?.busy).toBe(true);

    // Clean up: let the second run finish
    secondPromptResolve?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
