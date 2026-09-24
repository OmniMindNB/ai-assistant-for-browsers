import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessageRecord } from '@/lib/db';

const mocks = vi.hoisted(() => {
  const sessionCache = new Map<number, any>();

  return {
    createBrowserAgent: vi.fn(),
    replaceConversationMessages: vi.fn(
      async (_conversationId: string, _records: ChatMessageRecord[], _title: string) => undefined,
    ),
    loadTabSession: vi.fn(async (tabId: number) => {
      if (!sessionCache.has(tabId)) {
        const session = { panelTabId: tabId, currentTabId: tabId, trackedTabs: [{ id: tabId }] as any[], snapshot: () => ({}) };
        (session as any).reference = (tabs: any[]) => {
          // 全量同步 read-only 项（简化版本，供测试用）
          const keep = new Set(tabs.map((tab) => tab.id));
          // 保留 full-access 的 tabs（包括面板 tab）和新引用的 tabs
          session.trackedTabs = session.trackedTabs.filter(
            (tab) => (tab.access === undefined) || keep.has(tab.id),
          );
          for (const tab of tabs) {
            const entry = { ...tab, access: 'read' as const };
            const index = session.trackedTabs.findIndex((tracked) => tracked.id === tab.id);
            if (index >= 0) session.trackedTabs[index] = entry;
            else session.trackedTabs.push(entry);
          }
        };
        sessionCache.set(tabId, session);
      }
      return sessionCache.get(tabId)!;
    }),
    saveTabSession: vi.fn(async () => undefined),
    clearOverlayForTab: vi.fn(async () => undefined),
    setOverlayForTab: vi.fn(async () => undefined),
    clearTakeoverForTab: vi.fn(async () => undefined),
    getFormFieldsForTab: vi.fn(async () => ({
      url: 'https://example.com/form',
      fields: { f1: { path: [], expect: { tag: 'input', label: '邮箱' }, sensitive: false, kind: 'text' } },
    })),
  };
});

vi.mock('./agent', () => ({ createBrowserAgent: mocks.createBrowserAgent }));
vi.mock('./tab-form-fields', () => ({ getFormFieldsForTab: mocks.getFormFieldsForTab }));
vi.mock('@/lib/db', () => ({ replaceConversationMessages: mocks.replaceConversationMessages }));
vi.mock('./tab-session-storage', () => ({
  loadTabSession: mocks.loadTabSession,
  saveTabSession: mocks.saveTabSession,
}));
vi.mock('./tab-overlay-state', () => ({
  clearOverlayForTab: mocks.clearOverlayForTab,
  setOverlayForTab: mocks.setOverlayForTab,
}));
vi.mock('./tab-takeover', () => ({
  clearTakeoverForTab: mocks.clearTakeoverForTab,
}));
vi.mock('./run-state-storage', () => ({
  saveRunStateSnapshot: vi.fn(async () => undefined),
  clearRunStateSnapshot: vi.fn(async () => undefined),
  loadRunStateSnapshot: vi.fn(async () => undefined),
  listOrphanRunTabIds: vi.fn(async () => []),
}));

import {
  startRun,
  getRunState,
  respondConfirm,
  respondQuestion,
  stopRun,
  attachPort,
  detachPort,
  markConversationDeleted,
  unmarkConversationDeleted,
} from './run-registry';
import type { StartRunRequest } from './run-port-protocol';

/** 大部分用例并不关心 alarms，但 startRun/scanForOrphans 都会碰它；统一装一份可断言的替身。 */
function installAlarmsStub(): void {
  (globalThis as any).browser = {
    ...(globalThis as any).browser,
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: vi.fn() },
    },
  };
}

/** startRun 现在要查目标 tab 的真实地址来判断句柄表是否过期；全局替身里没有 tabs。 */
function installTabsStub(url = 'https://example.com/form'): void {
  (globalThis as any).browser = {
    ...(globalThis as any).browser,
    tabs: { get: vi.fn(async () => ({ id: 7, url })) },
  };
}

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

function makeOrphanSnapshot(tabId: number, conversationId: string) {
  return {
    tabId,
    conversationId,
    busy: true,
    messages: [{ id: 'u1', role: 'user' as const, content: 'hi', createdAt: 1 }],
    activitySteps: [],
    pendingConfirmation: null,
    pendingQuestion: null,
  };
}

beforeEach(() => {
  mocks.createBrowserAgent.mockReset();
  mocks.replaceConversationMessages.mockClear();
  mocks.clearOverlayForTab.mockClear();
  mocks.setOverlayForTab.mockClear();
  // startRun 现在无条件调用一次 browser.tabs.get（collectTurnHandoff 里的 fetchTargetUrl），
  // 不再只在 onConfirm/onTakeover 真正触发时才调用。几个既有用例把 browser.tabs.get 换成
  // "调用后挂起、靠用例自己手动 resolve" 的替身（如 currentMainOrigin 的竞态用例），resolve
  // 只发生一次；不清掉的话，后面完全不关心 tabs 的用例会复用同一个替身，拿到一个再也没人
  // resolve 的新 promise，整个用例挂死到超时。
  (globalThis as any).browser = { ...(globalThis as any).browser, tabs: undefined };
});

describe('run-registry startRun', () => {
  it('creates a RunState, persists the initial history immediately, and streams text into the last assistant message', async () => {
    const agent = makeFakeAgent([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'lo' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
    ]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    const posted: unknown[] = [];
    attachPort(7, { postMessage: (m) => posted.push(m) });

    await startRun(makeRequest());
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
    expect(posted.length).toBeGreaterThan(0);
  });

  it('marks the final assistant message contextTruncated when the agent reports its context window was recut', async () => {
    const agent = makeFakeAgent([]);
    agent.prompt = vi.fn(async () => {
      const options = mocks.createBrowserAgent.mock.calls.at(-1)?.[0] as { onContextTruncated?: () => void };
      options.onContextTruncated?.();
    });
    mocks.createBrowserAgent.mockReturnValue(agent);

    await startRun(makeRequest({ tabId: 9 }));
    await vi.waitFor(() => expect(getRunState(9)?.busy).toBe(false));

    const state = getRunState(9);
    const lastMessage = state?.messages[state.messages.length - 1];
    expect(lastMessage?.contextTruncated).toBe(true);
  });

  it('leaves contextTruncated unset when the agent never reports a context recut', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);

    await startRun(makeRequest({ tabId: 10 }));
    await vi.waitFor(() => expect(getRunState(10)?.busy).toBe(false));

    const state = getRunState(10);
    const lastMessage = state?.messages[state.messages.length - 1];
    expect(lastMessage?.contextTruncated).toBeUndefined();
  });

  it('aborts an existing run for the same tab before starting a new one', async () => {
    const firstAgent = makeFakeAgent([]);
    const secondAgent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValueOnce(firstAgent).mockReturnValueOnce(secondAgent);

    await startRun(makeRequest());
    await startRun(makeRequest({ conversationId: 'conv-2', displayMessage: { id: 'u2', role: 'user', content: 'again', createdAt: 2 } }));

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

      await startRun(makeRequest({ tabId: 8 }));
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

    const tabId = 9;

    // Start first run
    await startRun(makeRequest({ tabId }));

    // Start second run (aborts the first)
    mocks.replaceConversationMessages.mockClear();
    await startRun(
      makeRequest({
        tabId,
        conversationId: 'conv-2',
        displayMessage: { id: 'u2', role: 'user', content: 'second', createdAt: 2 },
      })
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

  /** 最后一条推给面板的快照。 */
  function lastSnapshot(posted: unknown[]): { busy: boolean; messages: Array<Record<string, unknown>> } {
    const snapshots = posted.filter((m) => (m as { type?: string }).type === 'snapshot');
    return snapshots.at(-1) as { busy: boolean; messages: Array<Record<string, unknown>> };
  }

  it('segments reasoning by LLM turn and archives it on the final assistant message', async () => {
    const agent = makeFakeAgent([
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '先' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '想' } },
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '再想' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '答案' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '答案' }] } },
    ]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    const posted: unknown[] = [];
    attachPort(21, { postMessage: (m) => posted.push(m) });

    await startRun(makeRequest({ tabId: 21 }));
    await vi.waitFor(() => expect(lastSnapshot(posted)?.busy).toBe(false));

    const last = lastSnapshot(posted).messages.at(-1);
    expect(last?.content).toBe('答案');
    expect(last?.reasoning).toEqual(['先想', '再想']);
    expect(last).not.toHaveProperty('reasoningOmittedChars');

    // 同一份字段也落进了 Dexie。
    const persisted = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1] as Array<{ reasoning?: string[] }>;
    expect(persisted.at(-1)?.reasoning).toEqual(['先想', '再想']);
  });

  // Review Focus #1：思考到一半点停止，没有正文、也没等到 message_end。
  it('keeps reasoning streamed before the user stopped the run', async () => {
    const agent = makeFakeAgent([]);
    agent.prompt = vi.fn(async () => {
      const listener = agent.subscribe.mock.calls[0]?.[0] as (event: unknown) => void;
      listener({ type: 'turn_start' });
      listener({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '想到一半' } });
      stopRun(22);
    });
    mocks.createBrowserAgent.mockReturnValue(agent);
    const posted: unknown[] = [];
    attachPort(22, { postMessage: (m) => posted.push(m) });

    await startRun(makeRequest({ tabId: 22 }));
    await vi.waitFor(() => expect(lastSnapshot(posted)?.busy).toBe(false));

    const last = lastSnapshot(posted).messages.at(-1);
    expect(last?.stopped).toBe(true);
    expect(last?.reasoning).toEqual(['想到一半']);
  });

  // 终审 Important #1：20k 上限是按条算的，而快照每 48ms 带上整段历史——运行中的快照
  // 只保留当前这条的推理，历史推理留在 state.messages 里照常落库，收尾快照再完整带上。
  // 设计稿 §3.5：段数变化那一帧带全，平时只带正在增长的那一段。
  it('sends every segment on the frame a new segment appears and only the growing one otherwise', async () => {
    const agent = makeFakeAgent([]);
    let listener: (event: unknown) => void = () => undefined;
    let release: () => void = () => undefined;
    agent.prompt = vi.fn(async () => {
      listener = agent.subscribe.mock.calls[0]?.[0] as (event: unknown) => void;
      listener({ type: 'turn_start' });
      listener({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '一' } });
      listener({ type: 'message_end', message: { role: 'assistant', content: [] } });
      listener({ type: 'turn_start' });
      listener({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '二' } });
      listener({ type: 'message_end', message: { role: 'assistant', content: [] } });
      listener({ type: 'turn_start' });
      listener({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '三' } });
      await new Promise<void>((resolve) => { release = resolve; });
    });
    mocks.createBrowserAgent.mockReturnValue(agent);
    const posted: unknown[] = [];
    attachPort(25, { postMessage: (m) => posted.push(m) });

    await startRun(makeRequest({ tabId: 25 }));
    // 等 48ms flush 把第三段首次刷出去（段数 2 → 3，这一帧带全）。
    await vi.waitFor(() => expect(lastSnapshot(posted).messages.at(-1)?.reasoning).toEqual(['一', '二', '三']));
    // 同一段继续增长：再一帧只带这一段。
    listener({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '续' } });
    await vi.waitFor(() => expect(lastSnapshot(posted).messages.at(-1)?.reasoning).toEqual(['三续']));
    expect(lastSnapshot(posted).messages.at(-1)?.reasoningUnsentSegments).toBe(2);

    // Review Focus #2：面板中途挂上来，拿到的是完整一帧。
    const attached = attachPort(25, { postMessage: (m) => posted.push(m) });
    expect(attached?.messages.at(-1)?.reasoning).toEqual(['一', '二', '三续']);
    expect(attached?.messages.at(-1)).not.toHaveProperty('reasoningUnsentSegments');

    release();
    await vi.waitFor(() => expect(lastSnapshot(posted)?.busy).toBe(false));
    const final = lastSnapshot(posted).messages.at(-1);
    expect(final?.reasoning).toEqual(['一', '二', '三续']);
    expect(final).not.toHaveProperty('reasoningUnsentSegments');
  });

  it('strips history reasoning from in-flight snapshots but keeps it for persistence and the final snapshot', async () => {
    const agent = makeFakeAgent([
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '新推理' } },
      { type: 'message_end', message: { role: 'assistant', content: [] } },
    ]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    const posted: unknown[] = [];
    attachPort(24, { postMessage: (m) => posted.push(m) });
    const oldAnswer = { id: 'a0', role: 'assistant' as const, content: '旧答', createdAt: 0, reasoning: ['旧推理'] };

    await startRun(makeRequest({ tabId: 24, historyMessages: [oldAnswer] }));
    await vi.waitFor(() => expect(lastSnapshot(posted)?.busy).toBe(false));

    const snapshots = posted.filter((m) => (m as { type?: string }).type === 'snapshot') as Array<{ busy: boolean; messages: Array<Record<string, unknown>> }>;
    const inFlight = snapshots.filter((s) => s.busy);
    expect(inFlight.length).toBeGreaterThan(0);
    for (const snapshot of inFlight) {
      expect(snapshot.messages.find((m) => m.id === 'a0')).not.toHaveProperty('reasoning');
    }
    expect(inFlight.some((s) => (s.messages.at(-1)?.reasoning as string[] | undefined)?.[0] === '新推理')).toBe(true);

    expect(lastSnapshot(posted).messages.find((m) => m.id === 'a0')?.reasoning).toEqual(['旧推理']);
    const persisted = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1] as Array<{ reasoning?: string[] }>;
    expect(persisted[0]?.reasoning).toEqual(['旧推理']);
  });

  it('writes no reasoning fields when the model produced none', async () => {
    const agent = makeFakeAgent([
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    const posted: unknown[] = [];
    attachPort(23, { postMessage: (m) => posted.push(m) });

    await startRun(makeRequest({ tabId: 23 }));
    await vi.waitFor(() => expect(lastSnapshot(posted)?.busy).toBe(false));

    const last = lastSnapshot(posted).messages.at(-1);
    expect(last).not.toHaveProperty('reasoning');
  });
});

describe('run-registry confirm/question/stop/port', () => {
  it('resolves a pending confirmation and clears it from the snapshot', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    await startRun(makeRequest({ tabId: 20 }));
    const state = getRunState(20)!;
    let resolved: boolean | undefined;
    // 真实场景下这个字段是 agent.ts 内部调用 onConfirm 时设置的；makeFakeAgent 的
    // prompt() 不模拟 beforeToolCall/onConfirm 那条路径（agent.ts 本身已经有测试覆盖
    // onConfirm 何时被调用），这里直接摆好"正在等待确认"这个前置状态来测 respondConfirm
    // 自己的行为。
    state.pendingConfirmation = { toolCallId: 'call-1', toolName: 'browser_click', summary: 'x' };
    state.resolveConfirmation = (approved) => { resolved = approved; };

    respondConfirm(20, 'call-1', true);

    expect(resolved).toBe(true);
    expect(getRunState(20)?.pendingConfirmation).toBeNull();
  });

  it('resolves a pending question', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    await startRun(makeRequest({ tabId: 21 }));
    const state = getRunState(21)!;
    let answered: string | undefined;
    state.pendingQuestion = { toolCallId: 'ask-1', question: 'which one?' };
    state.resolveQuestion = (answer) => { answered = answer; };

    respondQuestion(21, 'ask-1', 'the first one');

    expect(answered).toBe('the first one');
    expect(getRunState(21)?.pendingQuestion).toBeNull();
  });

  // 步骤收尾时必须把工具结果一起交给 describeToolActivity：只凭调用参数的话，一次重定向
  // 之后面板会指着模型请求的地址说"已跳转到"，而标签页其实在登录页上。
  it('describes a finished step from the tool result, not just the call arguments', async () => {
    mocks.createBrowserAgent.mockReturnValue(
      makeFakeAgent([
        { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_navigate', args: { url: 'https://example.com/order' } },
        {
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'browser_navigate',
          isError: false,
          result: { details: { url: 'https://example.com/login?next=/order' } },
        },
      ]),
    );
    const posted: any[] = [];
    attachPort(23, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 23 }));

    const steps = posted.map((message) => message?.activitySteps).filter(Boolean).flat();
    const finished = steps.filter((step: any) => step.id === 'call-1' && step.status === 'done').at(-1);
    expect(finished?.description).toContain('https://example.com/login?next=/order');
  });

  it('stores a redacted errorText on a failed step, and none on a successful one', async () => {
    mocks.createBrowserAgent.mockReturnValue(
      makeFakeAgent([
        { type: 'turn_start' },
        { type: 'tool_execution_start', toolCallId: 'ok-1', toolName: 'browser_get_form', args: {} },
        { type: 'tool_execution_end', toolCallId: 'ok-1', toolName: 'browser_get_form', isError: false, result: { content: [{ type: 'text', text: '表单' }], details: {} } },
        { type: 'tool_execution_start', toolCallId: 'bad-1', toolName: 'browser_click', args: { selector: '#go' } },
        { type: 'tool_execution_end', toolCallId: 'bad-1', toolName: 'browser_click', isError: true, result: { content: [{ type: 'text', text: '联系 13812345678 失败' }], details: {} } },
      ]),
    );

    await startRun(makeRequest({ tabId: 90 }));
    await vi.waitFor(() => expect(getRunState(90)).toBeUndefined());

    const lastRecord = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1].at(-1);
    const ok = lastRecord?.activitySteps?.find((step) => step.id === 'ok-1');
    const bad = lastRecord?.activitySteps?.find((step) => step.id === 'bad-1');
    expect(ok).not.toHaveProperty('errorText');
    expect(bad?.errorText).toBeDefined();
    expect(bad?.errorText).not.toContain('13812345678');
  });

  it('attaches runDiagnostics to the final assistant message without the api key', async () => {
    mocks.createBrowserAgent.mockReturnValue(
      makeFakeAgent([
        { type: 'turn_start' },
        { type: 'tool_execution_start', toolCallId: 'c-1', toolName: 'browser_get_form', args: {} },
        { type: 'tool_execution_end', toolCallId: 'c-1', toolName: 'browser_get_form', isError: false, result: { content: [], details: {} } },
        { type: 'turn_start' },
      ]),
    );

    await startRun(makeRequest({
      tabId: 91,
      provider: { id: 'p1', name: 'Local', baseURL: 'http://localhost:11434/v1', apiKey: 'sk-secret', model: 'qwen' } as never,
    }));
    await vi.waitFor(() => expect(getRunState(91)).toBeUndefined());

    const lastRecord = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1].at(-1);
    expect(lastRecord?.role).toBe('assistant');
    expect(lastRecord?.runDiagnostics).toMatchObject({
      providerName: 'Local',
      baseUrlHost: 'localhost:11434',
      modelId: 'qwen',
      llmTurns: 2,
      toolCalls: 1,
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      withoutBrowserTools: false,
    });
    expect(JSON.stringify(lastRecord?.runDiagnostics)).not.toContain('sk-secret');
  });

  it('attaches runDiagnostics even when the user stopped the run', async () => {
    const agent = makeFakeAgent([]);
    let rejectPrompt!: (e: unknown) => void;
    agent.prompt = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPrompt = reject; }));
    mocks.createBrowserAgent.mockReturnValue(agent);

    await startRun(makeRequest({ tabId: 92 }));
    stopRun(92);
    rejectPrompt(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await vi.waitFor(() => expect(getRunState(92)).toBeUndefined());

    const lastRecord = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1].at(-1);
    expect(lastRecord?.stopped).toBe(true);
    expect(lastRecord?.runDiagnostics?.providerName).toBe('p1');
  });

  it('stop aborts the agent and clears pending confirmation/question', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    await startRun(makeRequest({ tabId: 22 }));
    const state = getRunState(22)!;
    state.pendingConfirmation = { toolCallId: 'call-2', toolName: 'browser_click', summary: 'x' };

    stopRun(22);

    expect(agent.abort).toHaveBeenCalledOnce();
    expect(getRunState(22)?.pendingConfirmation).toBeNull();
  });

  it('archives activity steps and marks the message stopped once the aborted run settles', async () => {
    const agent = makeFakeAgent([]);
    let rejectPrompt!: (e: unknown) => void;
    // makeFakeAgent 默认的 prompt() 同步跑完 events 就 resolve，不会真的被 abort() 打断；
    // 这里换成一个受控 promise，好让 stopRun() 之后再手动模拟 agent.prompt() 因为
    // AbortError 而 reject，从而真正跑到 startRun 里 isUserAbortError 那条分支。
    agent.prompt = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPrompt = reject; }));
    mocks.createBrowserAgent.mockReturnValue(agent);

    // startRun() 本身不等待 agent.prompt() 的 fire-and-forget IIFE（同 keepalive 测试里的
    // 注释），所以可以放心 await：它只会等到 runs.set(...) 等同步设置完成为止。
    await startRun(makeRequest({ tabId: 41 }));
    const state = getRunState(41)!;
    // 模拟"点击提交按钮"这个工具调用在被打断时仍处于 running：真实场景下它是
    // tool_execution_start 事件写进去的，这里直接摆好前置状态，跟上面 respondConfirm
    // 测试摆 pendingConfirmation 前置状态是同一种做法。
    state.activitySteps = [{ id: 'call-5', description: '点击了提交按钮', status: 'running' }];

    stopRun(41);
    expect(agent.abort).toHaveBeenCalledOnce();
    // stopRun 为了让 UI 立即反馈，会同步清空 state.activitySteps；存档快照必须在这之前已经拍下。
    expect(getRunState(41)?.activitySteps).toEqual([]);

    rejectPrompt(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await vi.waitFor(() => expect(getRunState(41)).toBeUndefined());

    const persistedRecords = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1];
    const lastRecord = persistedRecords?.at(-1);
    expect(lastRecord?.stopped).toBe(true);
    // 被打断时仍是 running 的步骤要降级成 failed，不能让存档里永远停着一个"进行中"的步骤。
    expect(lastRecord?.activitySteps).toEqual([
      { id: 'call-5', description: '点击了提交按钮', status: 'failed' },
    ]);
  });

  it('clears the operating tab\'s agent overlay once a stopped run settles', async () => {
    const agent = makeFakeAgent([]);
    let rejectPrompt!: (e: unknown) => void;
    agent.prompt = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPrompt = reject; }));
    mocks.createBrowserAgent.mockReturnValue(agent);

    await startRun(makeRequest({ tabId: 42 }));
    expect(mocks.clearOverlayForTab).not.toHaveBeenCalled();

    stopRun(42);
    rejectPrompt(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await vi.waitFor(() => expect(getRunState(42)).toBeUndefined());

    // 用户中途停止后，操作过的标签页不该继续挂着一个陈旧的执行期遮罩——它既不会
    // 自己消失，页面刷新时 background 的 tabs.onUpdated 监听器还会把它重新推回去
    // （根因：storage.session 里的遮罩状态从没被清过，见 tab-overlay-state.ts）。
    expect(mocks.clearOverlayForTab).toHaveBeenCalledWith(42);
  });

  it('clears the operating tab\'s agent overlay once a normally-completed run settles', async () => {
    const agent = makeFakeAgent([
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ]);
    mocks.createBrowserAgent.mockReturnValue(agent);

    await startRun(makeRequest({ tabId: 43 }));
    await vi.waitFor(() => expect(getRunState(43)).toBeUndefined());

    expect(mocks.clearOverlayForTab).toHaveBeenCalledWith(43);
  });

  it('attachPort replies with the current snapshot for a live run, and detachPort never cancels the run', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    await startRun(makeRequest({ tabId: 23 }));

    const snapshot = attachPort(23, { postMessage: () => undefined });
    expect(snapshot?.tabId).toBe(23);

    detachPort(23, { postMessage: () => undefined });
    expect(agent.abort).not.toHaveBeenCalled();
    expect(getRunState(23)).toBeDefined();
  });

  it('attachPort returns undefined when there is no live run for the tab', () => {
    expect(attachPort(999, { postMessage: () => undefined })).toBeUndefined();
  });
});

describe('run-registry keepalive alarm', () => {
  beforeEach(installAlarmsStub);

  it('registers a keepalive alarm while a run is in-flight and clears it when the run settles', async () => {
    const agent = makeFakeAgent([]);
    let resolvePrompt!: () => void;
    agent.prompt = vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);

    const runPromise = startRun(makeRequest({ tabId: 30 }));
    await vi.waitFor(() => expect((globalThis as any).browser.alarms.create).toHaveBeenCalled());
    expect((globalThis as any).browser.alarms.create.mock.calls[0][0]).toBe('runi:agent-keepalive:30');

    resolvePrompt();
    await runPromise;
    // startRun() itself resolves right after kicking off the fire-and-forget
    // agent.prompt() IIFE, well before that IIFE's own finally block (which calls
    // stopKeepalive) has actually run — so, like the db-persistence assertions
    // elsewhere in this file, waiting on the alarm clear must poll rather than
    // assume `await runPromise` already covered it.
    await vi.waitFor(() => expect((globalThis as any).browser.alarms.clear).toHaveBeenCalledWith('runi:agent-keepalive:30'));
  });
});

describe('run-registry orphan scan', () => {
  it('marks a stale storage.session run-state entry as failure and clears it, without touching live runs', async () => {
    const { listOrphanRunTabIds, loadRunStateSnapshot } = await import('./run-state-storage');
    vi.mocked(listOrphanRunTabIds).mockResolvedValueOnce([99]);
    vi.mocked(loadRunStateSnapshot).mockResolvedValueOnce({
      tabId: 99,
      conversationId: 'conv-1',
      busy: true,
      messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: 1 }],
      activitySteps: [],
      pendingConfirmation: null,
      pendingQuestion: null,
    });
    // 冷启动场景：内存里的 runs Map 对 tabId 99 必然是空的（这正是 orphan 的定义）。
    expect(getRunState(99)).toBeUndefined();

    const { scanForOrphans } = await import('./run-registry');
    const resolved = await scanForOrphans();

    expect(resolved).toHaveLength(1);
    expect(resolved[0].tabId).toBe(99);
    expect(resolved[0].messages.at(-1)?.role).toBe('assistant');
    expect(mocks.replaceConversationMessages).toHaveBeenCalled();
    expect(mocks.replaceConversationMessages).toHaveBeenCalledWith('conv-1', expect.any(Array), expect.any(String));
  });

  // Review Focus #3：storage.session 里是瘦身快照，写库前要把没发的段并进丢弃计数。
  it('folds unsent reasoning segments into the dropped count before persisting an orphan', async () => {
    const { listOrphanRunTabIds, loadRunStateSnapshot } = await import('./run-state-storage');
    vi.mocked(listOrphanRunTabIds).mockResolvedValueOnce([97]);
    const snapshot = makeOrphanSnapshot(97, 'conv-slim');
    vi.mocked(loadRunStateSnapshot).mockResolvedValueOnce({
      ...snapshot,
      messages: [
        ...snapshot.messages,
        { id: 'a1', role: 'assistant' as const, content: '', createdAt: 2, reasoning: ['三'], reasoningUnsentSegments: 2, reasoningOmittedChars: 5 },
      ],
    });

    const { scanForOrphans } = await import('./run-registry');
    await scanForOrphans();

    const persisted = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1] as Array<{ reasoning?: string[]; reasoningDroppedSegments?: number; reasoningOmittedChars?: number }>;
    expect(persisted.at(-1)).toMatchObject({ reasoning: ['三'], reasoningDroppedSegments: 2 });
    expect(persisted.at(-1)?.reasoningOmittedChars).toBeUndefined();
  });

  it('does nothing when there is no stale storage.session entry', async () => {
    const { listOrphanRunTabIds } = await import('./run-state-storage');
    vi.mocked(listOrphanRunTabIds).mockResolvedValueOnce([]);
    const { scanForOrphans } = await import('./run-registry');
    expect(await scanForOrphans()).toEqual([]);
  });

  // service worker 中途死掉时 startRun 的 finally 从没跑过，那个 20s 周期的保活 alarm
  // 会一直留在 chrome.alarms 里空转，冷启动后没有任何代码再去清它。
  it('clears the leaked keepalive alarm belonging to each orphan tab', async () => {
    installAlarmsStub();
    const { listOrphanRunTabIds, loadRunStateSnapshot } = await import('./run-state-storage');
    vi.mocked(listOrphanRunTabIds).mockResolvedValueOnce([98]);
    vi.mocked(loadRunStateSnapshot).mockResolvedValueOnce(makeOrphanSnapshot(98, 'conv-orphan'));

    const { scanForOrphans } = await import('./run-registry');
    await scanForOrphans();

    expect((globalThis as any).browser.alarms.clear).toHaveBeenCalledWith('runi:agent-keepalive:98');
  });

  // 写失败时如果照样把 storage.session 里的快照清掉，用户既看不到失败消息（写没落盘），
  // 也永久失去了重试的依据——这一轮的历史静默消失。
  it('keeps the storage.session snapshot when the Dexie recovery write fails, so a later cold start can retry', async () => {
    installAlarmsStub();
    const { listOrphanRunTabIds, loadRunStateSnapshot, clearRunStateSnapshot } = await import('./run-state-storage');
    vi.mocked(listOrphanRunTabIds).mockResolvedValueOnce([97]);
    vi.mocked(loadRunStateSnapshot).mockResolvedValueOnce(makeOrphanSnapshot(97, 'conv-write-fails'));
    vi.mocked(clearRunStateSnapshot).mockClear();
    mocks.replaceConversationMessages.mockRejectedValueOnce(new Error('IndexedDB is unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const { scanForOrphans } = await import('./run-registry');
      await scanForOrphans();
    } finally {
      consoleError.mockRestore();
    }

    expect(vi.mocked(clearRunStateSnapshot)).not.toHaveBeenCalledWith(97);
  });

  it('still clears the snapshot when the recovery write succeeds', async () => {
    installAlarmsStub();
    const { listOrphanRunTabIds, loadRunStateSnapshot, clearRunStateSnapshot } = await import('./run-state-storage');
    vi.mocked(listOrphanRunTabIds).mockResolvedValueOnce([96]);
    vi.mocked(loadRunStateSnapshot).mockResolvedValueOnce(makeOrphanSnapshot(96, 'conv-write-ok'));
    vi.mocked(clearRunStateSnapshot).mockClear();

    const { scanForOrphans } = await import('./run-registry');
    await scanForOrphans();

    expect(vi.mocked(clearRunStateSnapshot)).toHaveBeenCalledWith(96);
  });
});

// 会话删除的墓碑约束（CLAUDE.md：迟到的快照不能复活已删除会话）在迁移前完全活在
// store.ts 的 persistConversationSnapshot 里；落盘搬到 background 之后，那份检查必须
// 跟着搬过来，否则用户删掉一个正在跑的会话，run 结束时会把它整行写回 Dexie。
describe('run-registry deleted-conversation tombstone', () => {
  beforeEach(installAlarmsStub);

  it('skips the settle-time Dexie write for a conversation deleted mid-run', async () => {
    let resolvePrompt!: () => void;
    const agent = makeFakeAgent([]);
    agent.prompt = vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);

    await startRun(makeRequest({ tabId: 60, conversationId: 'deleted-mid-run' }));
    // 开轮时的那次落盘照常发生（用户消息不能等到轮次结束才写）。
    expect(mocks.replaceConversationMessages).toHaveBeenCalledWith(
      'deleted-mid-run', expect.any(Array), expect.any(String),
    );

    // 用户在 run 还在飞的时候从历史抽屉里删掉了这个会话。
    markConversationDeleted('deleted-mid-run');
    mocks.replaceConversationMessages.mockClear();

    resolvePrompt();
    await vi.waitFor(() => expect(getRunState(60)).toBeUndefined());

    expect(mocks.replaceConversationMessages).not.toHaveBeenCalled();
    unmarkConversationDeleted('deleted-mid-run');
  });

  it('resumes writing after the mark is withdrawn (the delete itself failed)', async () => {
    markConversationDeleted('delete-failed');
    unmarkConversationDeleted('delete-failed');
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);

    await startRun(makeRequest({ tabId: 61, conversationId: 'delete-failed' }));

    expect(mocks.replaceConversationMessages).toHaveBeenCalledWith(
      'delete-failed', expect.any(Array), expect.any(String),
    );
  });

  it('skips the orphan recovery write for a conversation that was deleted', async () => {
    installAlarmsStub();
    const { listOrphanRunTabIds, loadRunStateSnapshot, clearRunStateSnapshot } = await import('./run-state-storage');
    vi.mocked(listOrphanRunTabIds).mockResolvedValueOnce([95]);
    vi.mocked(loadRunStateSnapshot).mockResolvedValueOnce(makeOrphanSnapshot(95, 'orphan-deleted'));
    vi.mocked(clearRunStateSnapshot).mockClear();
    markConversationDeleted('orphan-deleted');
    mocks.replaceConversationMessages.mockClear();

    const { scanForOrphans } = await import('./run-registry');
    await scanForOrphans();

    expect(mocks.replaceConversationMessages).not.toHaveBeenCalled();
    // 快照仍然要清掉：没有可写的目标了，留着只会让每次冷启动重复处理同一条孤儿。
    expect(vi.mocked(clearRunStateSnapshot)).toHaveBeenCalledWith(95);
    unmarkConversationDeleted('orphan-deleted');
  });
});

describe('run-registry surfaces a thrown agent.prompt error', () => {
  beforeEach(installAlarmsStub);

  it('writes user-visible error text into the assistant message instead of leaving it empty', async () => {
    const agent = makeFakeAgent([]);
    agent.prompt = vi.fn(async () => { throw new Error('boom from the provider'); });
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.replaceConversationMessages.mockClear();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await startRun(makeRequest({ tabId: 62, conversationId: 'conv-throws' }));
      await vi.waitFor(() => expect(getRunState(62)).toBeUndefined());
    } finally {
      consoleError.mockRestore();
    }

    const lastCall = mocks.replaceConversationMessages.mock.calls.at(-1) as unknown[];
    const persisted = lastCall[1] as { role: string; content: string }[];
    const assistant = persisted.filter((message) => message.role === 'assistant').at(-1);
    expect(assistant?.content).toBeTruthy();
    expect(assistant?.content).toContain('boom from the provider');
  });

  it('keeps already-streamed text and appends the error rather than replacing it', async () => {
    let listener: ((event: unknown) => void) | undefined;
    const agent = {
      subscribe: vi.fn((fn: (event: unknown) => void) => { listener = fn; return () => { listener = undefined; }; }),
      prompt: vi.fn(async () => {
        listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '第一步已完成，' } });
        throw new Error('connection reset');
      }),
      abort: vi.fn(),
      state: { messages: [] },
    };
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.replaceConversationMessages.mockClear();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await startRun(makeRequest({ tabId: 63, conversationId: 'conv-partial' }));
      await vi.waitFor(() => expect(getRunState(63)).toBeUndefined());
    } finally {
      consoleError.mockRestore();
    }

    const lastCall = mocks.replaceConversationMessages.mock.calls.at(-1) as unknown[];
    const persisted = lastCall[1] as { role: string; content: string }[];
    const assistant = persisted.filter((message) => message.role === 'assistant').at(-1);
    expect(assistant?.content).toContain('第一步已完成，');
    expect(assistant?.content).toContain('connection reset');
  });

  // 用户点"停止"时 agent.abort() 会让 prompt() 抛 AbortError；那不是故障，
  // 迁移前的 store.ts 对这条路径就是"保留已生成内容、不报错"。
  it('treats a user abort as a stop rather than a model failure', async () => {
    const agent = makeFakeAgent([]);
    agent.prompt = vi.fn(async () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    });
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.replaceConversationMessages.mockClear();

    await startRun(makeRequest({ tabId: 64, conversationId: 'conv-aborted' }));
    await vi.waitFor(() => expect(getRunState(64)).toBeUndefined());

    const lastCall = mocks.replaceConversationMessages.mock.calls.at(-1) as unknown[];
    const persisted = lastCall[1] as { role: string; content: string }[];
    const assistant = persisted.filter((message) => message.role === 'assistant').at(-1);
    expect(assistant?.content).toBeTruthy();
    expect(assistant?.content).not.toContain('The operation was aborted.');
  });

  // 真实的"思考中点暂停"走的不是上面那条抛错路径：被 abort 的 fetch 让流式层以一条
  // stopReason:'error' 的 assistant 消息收尾，pi-agent-core 的 agent-loop 见到 'error'
  // 就正常结束循环，prompt() resolve 而不是 reject。于是 isUserAbortError 永远不成立，
  // describeEmptyAgentRun 按"模型报错"处理，用户看到的是
  // 「模型调用失败：signal is aborted without reason / 请检查 Base URL、API Key…」。
  it('treats a stop that ends the run without throwing as a user stop, not a model failure', async () => {
    const agent = makeFakeAgent([]);
    let resolvePrompt!: () => void;
    agent.prompt = vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.replaceConversationMessages.mockClear();

    await startRun(makeRequest({ tabId: 65, conversationId: 'conv-stopped-ok' }));
    stopRun(65);
    // 流式层被打断后写进 agent.state.messages 的那条收尾消息。
    agent.state.messages = [
      { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'signal is aborted without reason' },
    ] as never;
    resolvePrompt();
    await vi.waitFor(() => expect(getRunState(65)).toBeUndefined());

    const persisted = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1] as ChatMessageRecord[];
    const assistant = persisted.filter((message) => message.role === 'assistant').at(-1);
    expect(assistant?.content).not.toContain('signal is aborted without reason');
    expect(assistant?.content).not.toContain('Base URL');
    expect(assistant?.stopped).toBe(true);
  });
});

describe('run-registry confirmation summary target tab', () => {
  beforeEach(installAlarmsStub);

  function lastOnConfirm(): (toolCallId: string, toolName: string, args: unknown) => Promise<boolean> {
    const options = (mocks.createBrowserAgent.mock.calls.at(-1) as unknown[])[0] as {
      onConfirm: (toolCallId: string, toolName: string, args: unknown) => Promise<boolean>;
    };
    return options.onConfirm;
  }

  function lastPendingConfirmation(posted: any[]): any {
    return posted.map((message) => message?.pendingConfirmation).filter(Boolean).at(-1);
  }

  it('annotates the summary with the operating tab when it is not the panel tab', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    const customSession: any = {
      panelTabId: 70,
      currentTabId: 88,
      trackedTabs: [{ id: 70 }, { id: 88, title: '网上银行', url: 'https://bank.example/pay' }],
      reference: () => {}, // 空实现，这个测试用例不关心引用
    };
    mocks.loadTabSession.mockResolvedValueOnce(customSession);
    const posted: any[] = [];
    attachPort(70, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 70 }));
    void lastOnConfirm()('call-cross-tab', 'browser_click', { selector: '#pay' });

    // onConfirm 现在会先 await 一次 currentMainOrigin()（browser.tabs.get 查询），
    // pendingConfirmation 不再是同步落地的，需要等它出现。
    await vi.waitFor(() => expect(lastPendingConfirmation(posted)).toBeDefined());
    const pending = lastPendingConfirmation(posted);
    expect(pending.summary).toContain('将操作标签页：《网上银行》(https://bank.example/pay)');
    expect(pending.summary).toContain('AI 想要点击 "#pay"。');
  });

  it('omits the annotation when the operating tab is the panel tab itself', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    const posted: any[] = [];
    attachPort(71, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 71 }));
    void lastOnConfirm()('call-same-tab', 'browser_click', { selector: '#pay' });

    await vi.waitFor(() => expect(lastPendingConfirmation(posted)).toBeDefined());
    const pending = lastPendingConfirmation(posted);
    expect(pending.summary).toBe('AI 想要点击 "#pay"。');
  });

  it('threads mainOrigin from a live browser.tabs.get lookup into the confirmation summary', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    (globalThis as any).browser = {
      ...(globalThis as any).browser,
      tabs: { get: vi.fn(async () => ({ url: 'https://shop.example.com/checkout' })) },
    };
    const posted: any[] = [];
    attachPort(72, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 72 }));
    void lastOnConfirm()('call-frame-origin', 'browser_fill_form', {
      fields: [{ fieldId: 'f1', value: '4111' }],
      submit: { fieldId: 'f2' },
      frameOrigin: 'https://pay.example.com',
    });

    await vi.waitFor(() => expect(lastPendingConfirmation(posted)).toBeDefined());
    const pending = lastPendingConfirmation(posted);
    expect(pending.summary).toContain('pay.example.com');
  });

  it('falls back to no mainOrigin when browser.tabs.get rejects, without throwing', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    (globalThis as any).browser = {
      ...(globalThis as any).browser,
      tabs: { get: vi.fn(async () => { throw new Error('no such tab'); }) },
    };
    const posted: any[] = [];
    attachPort(73, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 73 }));
    void lastOnConfirm()('call-frame-origin-2', 'browser_fill_form', {
      fields: [{ fieldId: 'f1', value: '4111' }],
      submit: { fieldId: 'f2' },
      frameOrigin: 'https://pay.example.com',
    });

    // mainOrigin 解析失败时按「未知」处理：frameOrigin 与 undefined 必然不相等，
    // 因此仍然会带上嵌入框架提示——宁可多提示，也不能在解析失败时静默吞掉风险信号。
    await vi.waitFor(() => expect(lastPendingConfirmation(posted)).toBeDefined());
    const pending = lastPendingConfirmation(posted);
    expect(pending.summary).toContain('pay.example.com');
  });

  it('does not resurrect a stopped run with a fresh pendingConfirmation once the suspended mainOrigin lookup resolves', async () => {
    const agent = makeFakeAgent([]);
    let rejectPrompt!: (e: unknown) => void;
    // 同上面 "archives activity steps..." 用例：默认的 fake prompt() 同步跑完就
    // resolve，不会真的被 abort() 打断；这里换成受控 promise，好在 stopRun() 之后
    // 手动模拟 agent.prompt() 因 AbortError 而 reject，让 startRun 的 finally 真正
    // 把这个 run 从 runs 里摘掉——onConfirm 恢复时正是靠这个来判断自己是否还"当前"。
    agent.prompt = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPrompt = reject; }));
    mocks.createBrowserAgent.mockReturnValue(agent);

    // browser.tabs.get 挂起不返回，制造 onConfirm 悬在 currentMainOrigin() 里的那个窗口。
    // startRun 自己现在也会先调一次 browser.tabs.get（collectTurnHandoff 里的
    // fetchTargetUrl）：第一次调用立即返回，只有 onConfirm 触发的那一次（第二次）才挂起，
    // 否则 startRun 自己就卡死在这个窗口打开之前。
    let resolveTabsGet!: (tab: unknown) => void;
    let tabsGetCalls = 0;
    (globalThis as any).browser = {
      ...(globalThis as any).browser,
      tabs: {
        get: vi.fn(() => {
          tabsGetCalls += 1;
          if (tabsGetCalls === 1) return Promise.resolve({ url: 'https://shop.example.com/checkout' });
          return new Promise((resolve) => { resolveTabsGet = resolve; });
        }),
      },
    };

    const posted: any[] = [];
    attachPort(74, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 74 }));

    let resolvedValue: boolean | undefined;
    void lastOnConfirm()('call-race', 'browser_click', { selector: '#pay' }).then((v) => { resolvedValue = v; });

    // 用户此时点了"停止"：pendingConfirmation 还没落地，stopRun 看不到这条在途的确认，
    // 只能 abort agent——这正是本用例要验证的竞态本身。
    stopRun(74);
    expect(agent.abort).toHaveBeenCalledOnce();

    // 模拟真实的 abort 让 agent.prompt() 以 AbortError reject，走到 startRun 的
    // finally，把这条 run 从 runs 里摘掉。
    rejectPrompt(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await vi.waitFor(() => expect(getRunState(74)).toBeUndefined());

    // 现在才放行悬挂的 browser.tabs.get()——onConfirm 恢复执行。
    resolveTabsGet({ url: 'https://shop.example.com/checkout' });

    await vi.waitFor(() => expect(resolvedValue).toBe(false));
    // 全程不应该有任何一次广播带上非空的 pendingConfirmation：run 已经不是当前的了。
    expect(lastPendingConfirmation(posted)).toBeUndefined();
  });
});

// 用户接管：与提交确认共用 pendingConfirmation 通道，靠 kind 区分。
describe('用户接管暂停', () => {
  function lastOnTakeover(): (toolCallId: string, toolName: string, args: unknown, tabId: number) => Promise<boolean> {
    const options = (mocks.createBrowserAgent.mock.calls.at(-1) as unknown[])[0] as {
      onTakeover: (toolCallId: string, toolName: string, args: unknown, tabId: number) => Promise<boolean>;
    };
    return options.onTakeover;
  }

  function lastPending(posted: any[]): any {
    return posted.map((message) => message?.pendingConfirmation).filter(Boolean).at(-1);
  }

  function lastSteps(posted: any[]): any[] {
    return posted.map((message) => message?.activitySteps).filter(Boolean).at(-1) ?? [];
  }

  it('标记为 takeover，让面板能换一套文案而不是问"要不要提交表单"', async () => {
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));
    const posted: any[] = [];
    attachPort(80, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 80 }));
    void lastOnTakeover()('call-takeover', 'browser_click', { selector: '#pay' }, 80);

    const pending = lastPending(posted);
    expect(pending.kind).toBe('takeover');
    expect(pending.summary).toBe('AI 想要点击 "#pay"。');
  });

  // 这是原先缺的那一环：接管发生过，事后却无迹可寻。
  it('用户选择继续后留下一条接管痕迹', async () => {
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));
    const posted: any[] = [];
    attachPort(81, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 81 }));
    void lastOnTakeover()('call-takeover', 'browser_click', {}, 81);
    respondConfirm(81, 'call-takeover', true);

    const steps = lastSteps(posted);
    const trace = steps.find((step) => step.id === 'takeover-call-takeover');
    expect(trace?.status).toBe('done');
    // 步骤文案走 i18n，测试环境解析出的是英文；这里断的是"说的是接管这件事"，
    // 与本文件其它断言里的中文不同——那些来自 confirm-summary.ts 的硬编码中文。
    expect(trace?.description).toContain('took over');
  });

  it('用户选择到此为止时痕迹记为失败，并终止该工具调用', async () => {
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));
    const posted: any[] = [];
    attachPort(82, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 82 }));
    const decision = lastOnTakeover()('call-takeover', 'browser_click', {}, 82);
    respondConfirm(82, 'call-takeover', false);

    await expect(decision).resolves.toBe(false);
    const trace = lastSteps(posted).find((step) => step.id === 'takeover-call-takeover');
    expect(trace?.status).toBe('failed');
  });

  // 工具阶段结束此前对用户完全不可见：工具被摘掉、模型突然改口给结论，看起来像它自己放弃了。
  it('预算耗尽进入收尾轮时，在步骤列表末尾留一条 notice', async () => {
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));
    const posted: any[] = [];
    attachPort(84, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 84 }));
    const options = (mocks.createBrowserAgent.mock.calls.at(-1) as unknown[])[0] as {
      onToolPhaseEnd: (reason: 'budget_exhausted' | 'repeatedly_blocked') => void;
    };
    options.onToolPhaseEnd('budget_exhausted');

    const steps = posted.map((message) => message?.activitySteps).filter(Boolean).at(-1) ?? [];
    const notice = steps.find((step: any) => step.id === 'tool-phase-end');
    // notice 单独一档：拿 done 冒充会在旁边画一个 ✓，读起来像"这件事成功了"。
    expect(notice?.status).toBe('notice');
    expect(notice?.description).toContain('Step limit reached');
  });

  // 软提醒此前只发给模型，用户那边完全没有预期，收尾来得毫无征兆。
  it('接近步骤上限时也告诉用户，并带上还剩几步', async () => {
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));
    const posted: any[] = [];
    attachPort(86, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 86 }));
    const options = (mocks.createBrowserAgent.mock.calls.at(-1) as unknown[])[0] as {
      onBudgetLow: (remaining: number) => void;
    };
    options.onBudgetLow(5);

    const steps = posted.map((message) => message?.activitySteps).filter(Boolean).at(-1) ?? [];
    const notice = steps.find((step: any) => step.id === 'budget-low');
    expect(notice?.status).toBe('notice');
    expect(notice?.description).toContain('5');
  });

  // 两个阈值（剩 5 / 剩 2）各触发一次，后一次覆盖前一次而不是再堆一行。
  it('第二次软提醒覆盖同一行', async () => {
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));
    const posted: any[] = [];
    attachPort(87, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 87 }));
    const options = (mocks.createBrowserAgent.mock.calls.at(-1) as unknown[])[0] as {
      onBudgetLow: (remaining: number) => void;
    };
    options.onBudgetLow(5);
    options.onBudgetLow(2);

    const steps = posted.map((message) => message?.activitySteps).filter(Boolean).at(-1) ?? [];
    expect(steps.filter((step: any) => step.id === 'budget-low')).toHaveLength(1);
    expect(steps.find((step: any) => step.id === 'budget-low')?.description).toContain('2');
  });

  it('连续被阻断和预算耗尽给的是不同说法', async () => {
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));
    const posted: any[] = [];
    attachPort(85, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 85 }));
    const options = (mocks.createBrowserAgent.mock.calls.at(-1) as unknown[])[0] as {
      onToolPhaseEnd: (reason: 'budget_exhausted' | 'repeatedly_blocked') => void;
    };
    options.onToolPhaseEnd('repeatedly_blocked');

    const steps = posted.map((message) => message?.activitySteps).filter(Boolean).at(-1) ?? [];
    expect(steps.find((step: any) => step.id === 'tool-phase-end')?.description).toContain('could not run');
  });

  // 上一轮的接管记录不能带进新一轮，否则新任务第一个写操作就会莫名其妙停下来问。
  it('开新一轮时清掉遗留的接管记录', async () => {
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));
    attachPort(83, { postMessage: () => {} });

    await startRun(makeRequest({ tabId: 83 }));

    expect(mocks.clearTakeoverForTab).toHaveBeenCalledWith(83);
  });
});

describe('run-registry referenced tabs', () => {
  it('registers referenced tabs as read-only on the tab session', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    await startRun(makeRequest({
      tabId: 1,
      referencedTabs: [{ id: 7, title: 'Docs', url: 'https://docs.example.com' }],
    }));
    const session = await mocks.loadTabSession(1);
    expect(session.trackedTabs).toContainEqual({
      id: 7,
      title: 'Docs',
      url: 'https://docs.example.com',
      access: 'read',
    });
    expect(session.currentTabId).toBe(1);
  });

  it('drops a reference the panel no longer sends', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    await startRun(makeRequest({ tabId: 1, referencedTabs: [{ id: 7 }] }));
    await startRun(makeRequest({ tabId: 1, referencedTabs: [] }));
    const session = await mocks.loadTabSession(1);
    expect(session.trackedTabs.map((tab: any) => tab.id)).toEqual([1]);
  });
});

describe('run-registry 轮次交接块', () => {
  beforeEach(() => {
    mocks.getFormFieldsForTab.mockClear();
  });

  function historyWithSteps() {
    return [
      { id: 'u0', role: 'user' as const, content: '填一下表单', createdAt: 1 },
      {
        id: 'a0',
        role: 'assistant' as const,
        content: '已经读取了表单。',
        createdAt: 2,
        activitySteps: [{ id: 's0', description: '读取了表单结构', status: 'done' as const }],
      },
    ];
  }

  it('把足迹与句柄作为一条 [系统观察] 消息追加在历史末尾', async () => {
    installAlarmsStub();
    installTabsStub();
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));

    await startRun(makeRequest({ tabId: 7, historyMessages: historyWithSteps() }));
    await vi.waitFor(() => expect(getRunState(7)?.busy).toBe(false));

    const options = mocks.createBrowserAgent.mock.calls.at(-1)?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const last = options.messages[options.messages.length - 1];
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('[系统观察]');
    expect(String(last.content)).toContain('读取了表单结构');
    expect(String(last.content)).toContain('f1：邮箱');
  });

  it('withoutBrowserTools 的轮次不追加交接块', async () => {
    installAlarmsStub();
    installTabsStub();
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));

    await startRun(makeRequest({ tabId: 8, historyMessages: historyWithSteps(), withoutBrowserTools: true }));
    await vi.waitFor(() => expect(getRunState(8)?.busy).toBe(false));

    const options = mocks.createBrowserAgent.mock.calls.at(-1)?.[0] as { messages: Array<{ content: unknown }> };
    expect(options.messages.some((message) => String(message.content).includes('[系统观察]'))).toBe(false);
  });

  it('没有足迹也没有句柄时不追加空消息', async () => {
    installAlarmsStub();
    installTabsStub();
    mocks.getFormFieldsForTab.mockResolvedValueOnce(undefined as never);
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));

    await startRun(makeRequest({ tabId: 11, historyMessages: [] }));
    await vi.waitFor(() => expect(getRunState(11)?.busy).toBe(false));

    const options = mocks.createBrowserAgent.mock.calls.at(-1)?.[0] as { messages: unknown[] };
    expect(options.messages).toHaveLength(0);
  });

  // 查不到 URL 属于降级而不是失败：整轮照常开跑，只是这一轮没有句柄段。
  it('tabs.get 抛错时照常开跑，只少句柄段', async () => {
    installAlarmsStub();
    (globalThis as any).browser = {
      ...(globalThis as any).browser,
      tabs: {
        get: vi.fn(async () => {
          throw new Error('no such tab');
        }),
      },
    };
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));

    await startRun(makeRequest({ tabId: 12, historyMessages: historyWithSteps() }));
    await vi.waitFor(() => expect(getRunState(12)?.busy).toBe(false));

    const options = mocks.createBrowserAgent.mock.calls.at(-1)?.[0] as { messages: Array<{ content: unknown }> };
    const joined = options.messages.map((message) => String(message.content)).join('\n');
    expect(joined).toContain('读取了表单结构');
    expect(joined).not.toContain('f1：邮箱');
  });

  // buildTurnHandoff 是纯函数、没有自己的 try/catch；storage.session 里的句柄表一旦是
  // 旧版/畸形形状（比如缺了 fields），Object.entries(table.fields) 会直接抛出。这一步
  // 发生在 agent 真正创建之前，一旦不兜底就会让这个 tab 永远卡在 busy: true——
  // 这里验证 collectTurnHandoff 外层的 .catch() 能把它降级为"没有交接块"而不是让整个
  // run 挂死。
  it('句柄表形状畸形导致 buildTurnHandoff 抛错时，run 仍照常开跑而不是卡死', async () => {
    installAlarmsStub();
    installTabsStub();
    mocks.getFormFieldsForTab.mockResolvedValueOnce({
      url: 'https://example.com/form',
      fields: undefined,
    } as never);
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));

    await startRun(makeRequest({ tabId: 13, historyMessages: historyWithSteps() }));
    await vi.waitFor(() => expect(getRunState(13)?.busy).toBe(false));

    const options = mocks.createBrowserAgent.mock.calls.at(-1)?.[0] as { messages: Array<{ content: unknown }> };
    // buildTurnHandoff 是单次调用、单个返回值：句柄段拼接时抛出会连带丢掉同一次调用里
    // 已经算好的足迹段——两者一起被 .catch(() => undefined) 降级掉，不是各自独立兜底。
    expect(options.messages.some((message) => String(message.content).includes('[系统观察]'))).toBe(false);
  });
});

describe('run-registry trajectory recording', () => {
  beforeEach(() => {
    installAlarmsStub();
  });

  // busy:false 只是收尾过程中一闪而过的瞬时态：本文件其余用例（startRun/confirm/question/stop
  // 等描述块）里 finally 块紧接着就会把这次运行整个从 runs 里摘掉（runs.delete(state.tabId)），
  // 所以等的是终态本身——run 从 runs 里彻底消失，之后不会再变；这也是文件里其它场景（"archives
  // activity steps..."等用例）一贯采用的等待方式。落盘内容与 state.messages 在删除前完全一致
  // （finally 删除前必定先 persistMessages(state)），从持久化记录读没有任何信息损失。
  async function settledReply(tabId: number): Promise<any> {
    await vi.waitFor(() => expect(getRunState(tabId)).toBeUndefined());
    return lastPersistedMessage();
  }

  function lastPersistedMessage(): any {
    return mocks.replaceConversationMessages.mock.calls.at(-1)?.[1]?.at(-1);
  }

  // toMessageRecords 会丢掉末尾内容为空的 assistant 占位，所以要落库的用例得先流一段文字进去。
  const replyText = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];

  it('records a successful write with its label and archives it on the reply', async () => {
    installTabsStub('https://example.com/form?token=abc');
    mocks.createBrowserAgent.mockReturnValue(
      makeFakeAgent([
        { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'browser_fill_form', args: { fields: [{ fieldId: 'f1', value: 'hello' }] } },
        { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'browser_fill_form', isError: false, result: {} },
        ...replyText,
      ]),
    );

    await startRun(makeRequest({ tabId: 61 }));
    const expected = [
      { tool: 'browser_fill_form', values: [{ target: '「邮箱」', value: 'hello' }] },
    ];
    expect((await settledReply(61)).trajectory).toEqual(expected);
    await vi.waitFor(() => expect(lastPersistedMessage()?.trajectory).toEqual(expected));
  });

  it('does not record failed calls or read-only tools', async () => {
    installTabsStub();
    mocks.createBrowserAgent.mockReturnValue(
      makeFakeAgent([
        { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'browser_click', args: { fieldId: 'f1' } },
        { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'browser_click', isError: true, result: {} },
        { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'browser_read_page', args: {} },
        { type: 'tool_execution_end', toolCallId: 'c2', toolName: 'browser_read_page', isError: false, result: {} },
      ]),
    );

    await startRun(makeRequest({ tabId: 62 }));

    // 落盘记录（ChatMessageRecord）总是显式带着 trajectory 这个键（值可能是 undefined）——
    // 不同于内存里的 ChatMessage，后者没有录制到东西时干脆不带这个键。两者语义一致（都表示
    // "这条消息没有轨迹"），这里断言值而不是键是否存在，就不会被这个形状差异误伤。
    expect((await settledReply(62)).trajectory).toBeUndefined();
  });

  it('passes the tool result into the recorder so fields that did not land are dropped', async () => {
    installTabsStub();
    const original = mocks.getFormFieldsForTab.getMockImplementation()!;
    mocks.getFormFieldsForTab.mockImplementation(async () => ({
      url: 'https://example.com/form',
      fields: {
        f1: { path: [], expect: { tag: 'input', label: '邮箱' }, sensitive: false, kind: 'text' },
        f2: { path: [], expect: { tag: 'input', label: '日期' }, sensitive: false, kind: 'text' },
      },
    }) as never);
    try {
      mocks.createBrowserAgent.mockReturnValue(
        makeFakeAgent([
          {
            type: 'tool_execution_start', toolCallId: 'c1', toolName: 'browser_fill_form',
            args: { fields: [{ fieldId: 'f1', value: 'a@b.c' }, { fieldId: 'f2', value: 'bad' }] },
          },
          {
            type: 'tool_execution_end', toolCallId: 'c1', toolName: 'browser_fill_form', isError: false,
            result: { details: { outcomes: [{ fieldId: 'f1', status: 'ok' }, { fieldId: 'f2', status: 'invalid_value' }] } },
          },
          ...replyText,
        ]),
      );

      await startRun(makeRequest({ tabId: 67 }));

      expect((await settledReply(67)).trajectory?.[0]?.values).toEqual([{ target: '「邮箱」', value: 'a@b.c' }]);
    } finally {
      mocks.getFormFieldsForTab.mockImplementation(original);
    }
  });

  it('does not record a tool call that was terminated by stop, even if it later ends without error', async () => {
    installTabsStub();
    const agent = makeFakeAgent([]);
    agent.prompt = vi.fn(async () => {
      const listener = agent.subscribe.mock.calls[0][0] as (event: unknown) => void;
      listener({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'browser_click', args: { fieldId: 'f1' } });
      // 用户在工具执行中途点了停止：这一步被标成 terminated，结果晚到也不能进轨迹。
      stopRun(68);
      listener({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'browser_click', isError: false, result: {} });
    });
    mocks.createBrowserAgent.mockReturnValue(agent);

    await startRun(makeRequest({ tabId: 68 }));

    expect((await settledReply(68))?.trajectory).toBeUndefined();
  });

  it('resolves the label from the handle table as it was before the tool ran', async () => {
    installTabsStub();
    const original = mocks.getFormFieldsForTab.getMockImplementation()!;
    let replaced = false;
    mocks.getFormFieldsForTab.mockImplementation(async () => ({
      url: 'https://example.com/form',
      fields: { f1: { path: [], expect: { tag: 'button', text: replaced ? '返回首页' : '下一步' }, sensitive: false, kind: 'button' } },
    }) as never);
    try {
      const agent = makeFakeAgent([]);
      agent.prompt = vi.fn(async () => {
        const listener = agent.subscribe.mock.calls[0][0] as (event: unknown) => void;
        listener({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'browser_click', args: { fieldId: 'f1' } });
        // 点击把页面带走了：background 用新页面重建了句柄表，同一个 f1 现在指向别的东西。
        replaced = true;
        listener({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'browser_click', isError: false, result: {} });
      });
      mocks.createBrowserAgent.mockReturnValue(agent);

      await startRun(makeRequest({ tabId: 63 }));

      expect((await settledReply(63)).trajectory?.[0]?.target).toBe('「下一步」');
    } finally {
      mocks.getFormFieldsForTab.mockImplementation(original);
    }
  });

  it('records the action taken on the page, not the tab switch that led there', async () => {
    const agent = makeFakeAgent([]);
    agent.prompt = vi.fn(async () => {
      const listener = agent.subscribe.mock.calls[0][0] as (event: unknown) => void;
      listener({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'browser_switch_tab', args: { tabId: 99 } });
      getRunState(64)!.session.currentTabId = 99;
      listener({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'browser_switch_tab', isError: false, result: {} });
      listener({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'browser_press_key', args: { key: 'Enter' } });
      listener({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'browser_press_key', isError: false, result: {} });
    });
    mocks.createBrowserAgent.mockReturnValue(agent);

    await startRun(makeRequest({ tabId: 64 }));

    // 保存的指令不绑定具体页面：切换标签页不录，每步也不带网址。
    expect((await settledReply(64)).trajectory).toEqual([{ tool: 'browser_press_key', detail: 'Enter' }]);
  });
});
