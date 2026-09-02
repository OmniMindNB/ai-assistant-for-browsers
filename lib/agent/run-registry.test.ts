import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessageRecord } from '@/lib/db';

const mocks = vi.hoisted(() => ({
  createBrowserAgent: vi.fn(),
  replaceConversationMessages: vi.fn(
    async (_conversationId: string, _records: ChatMessageRecord[], _title: string) => undefined,
  ),
  loadTabSession: vi.fn(async (tabId: number) => ({ panelTabId: tabId, currentTabId: tabId, trackedTabs: [], snapshot: () => ({}) })),
  saveTabSession: vi.fn(async () => undefined),
  clearOverlayForTab: vi.fn(async () => undefined),
  setOverlayForTab: vi.fn(async () => undefined),
}));

vi.mock('./agent', () => ({ createBrowserAgent: mocks.createBrowserAgent }));
vi.mock('@/lib/db', () => ({ replaceConversationMessages: mocks.replaceConversationMessages }));
vi.mock('./tab-session-storage', () => ({
  loadTabSession: mocks.loadTabSession,
  saveTabSession: mocks.saveTabSession,
}));
vi.mock('./tab-overlay-state', () => ({
  clearOverlayForTab: mocks.clearOverlayForTab,
  setOverlayForTab: mocks.setOverlayForTab,
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
    mocks.loadTabSession.mockResolvedValueOnce({
      panelTabId: 70,
      currentTabId: 88,
      trackedTabs: [{ id: 70 }, { id: 88, title: '网上银行', url: 'https://bank.example/pay' }],
    } as never);
    const posted: any[] = [];
    attachPort(70, { postMessage: (message) => posted.push(message) });

    await startRun(makeRequest({ tabId: 70 }));
    void lastOnConfirm()('call-cross-tab', 'browser_click', { selector: '#pay' });

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

    const pending = lastPendingConfirmation(posted);
    expect(pending.summary).toBe('AI 想要点击 "#pay"。');
  });
});
