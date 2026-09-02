import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  runPortPostMessage: vi.fn(),
  getActiveProvider: vi.fn(),
  replaceConversationMessages: vi.fn(),
  getConversationMessages: vi.fn(),
  deleteConversation: vi.fn(),
  listConversations: vi.fn(),
  extractPdfAttachment: vi.fn(),
}));

// store.ts 在模块加载时就注册了一个 storage.onChanged 监听器（面板已打开时实时消费 pending ask）。
// lib/test-setup.ts 的默认 browser 替身里没有 storage.onChanged，而 vi.hoisted 会在本文件的
// import 求值之前运行——正好可以在 ./store 被导入前装好替身，并捕获它注册的那个回调。
const storageListeners = vi.hoisted(() => {
  const listeners: Array<(changes: Record<string, { newValue?: unknown }>, areaName: string) => void> = [];
  (globalThis as any).browser.storage.onChanged = {
    addListener: (listener: any) => { listeners.push(listener); },
    removeListener: () => undefined,
  };
  return listeners;
});

function emitStorageChange(changes: Record<string, { newValue?: unknown }>, areaName: string): void {
  for (const listener of storageListeners) listener(changes, areaName);
}

// store.ts 现在不再直接调用 createBrowserAgent；它改为通过 browser.runtime.connect(...) 建立的
// 持久 Port 发 startRun 消息，并靠 Port 推回来的 snapshot 消息驱动 UI（见 lib/agent/run-registry.ts）。
// 这里装一个最小的假 Port：onMessage 监听器存进 runPortListener，测试里可以手动调用它模拟
// background 推回来的 snapshot。connectRunPort 只在 restoreTabConversation() 里调用（不是模块
// 加载时的副作用），所以这段不需要像上面的 storageListeners 一样抢在 import 之前跑——
// 普通赋值就够了，只要排在 `import { useChat } from './store'` 之前即可。
let runPortListener: ((message: unknown) => void) | undefined;
let runPortDisconnectListener: (() => void) | undefined;
/** background 对 `hello` 的回包。默认"这个 tab 没有存活的 run"，个别用例改成一份
 * in-flight 快照，模拟面板重开时正好撞上一轮还在跑的任务。 */
let runPortHelloReply: unknown = null;

/**
 * 一个尽量贴近 chrome.runtime.Port 真实行为的替身——关键是**断开之后 postMessage 会抛**
 * （"Attempting to use a disconnected port object"）。用一个断开后依然乖乖收消息的假 Port，
 * "断线后用户动作丢失"这个 bug 在测试里根本不会显形。
 */
function makeFakeRunPort() {
  let disconnected = false;
  const port = {
    postMessage: (message: any) => {
      if (disconnected) throw new Error('Attempting to use a disconnected port object');
      mocks.runPortPostMessage(message);
      if (message?.type === 'hello') {
        const reply = runPortHelloReply ?? { type: 'noRun', tabId: message.tabId };
        runPortListener?.(reply);
      }
    },
    onMessage: { addListener: (fn: (message: unknown) => void) => { runPortListener = fn; } },
    onDisconnect: {
      addListener: (fn: () => void) => {
        runPortDisconnectListener = () => {
          disconnected = true;
          fn();
        };
      },
    },
  };
  return port;
}

(globalThis as any).browser.runtime = {
  ...(globalThis as any).browser.runtime,
  connect: vi.fn(() => makeFakeRunPort()),
};

vi.mock('@/lib/messaging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/messaging')>()),
  sendMessage: mocks.sendMessage,
}));

vi.mock('@/lib/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/settings')>()),
  ensureDevProvider: vi.fn(),
  getActiveProvider: mocks.getActiveProvider,
}));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  replaceConversationMessages: mocks.replaceConversationMessages,
  getConversationMessages: mocks.getConversationMessages,
  deleteConversation: mocks.deleteConversation,
  listConversations: mocks.listConversations,
}));

vi.mock('@/lib/chat/pdfjs-runtime', () => ({
  extractPdfAttachment: mocks.extractPdfAttachment,
}));

import { useChat } from './store';

const provider = {
  id: 'test-provider',
  name: 'Test provider',
  baseURL: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

const DEFAULT_TAB_ID = 7;

/** 建立面板 <-> background 的假 Port 连接（真实场景下面板挂载时 restoreTabConversation()
 * 会做这件事）。多数用例需要先连上 Port，runAgent 发的 startRun 消息才有地方可去——
 * 未连接时 postToRunPort 是静默 no-op（见 store.ts），这正是很多"不应该发起 agent 运行"
 * 场景无需特殊处理就能通过断言的原因。 */
async function connectPort(tabId = DEFAULT_TAB_ID): Promise<void> {
  (globalThis as any).browser.tabs = { query: vi.fn().mockResolvedValue([{ id: tabId }]) };
  (globalThis as any).browser.storage.session = {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  await useChat.getState().restoreTabConversation();
}

interface SnapshotOverrides {
  tabId: number;
  conversationId: string;
  busy: boolean;
  messages?: unknown[];
  activitySteps?: unknown[];
  pendingConfirmation?: unknown;
  pendingQuestion?: unknown;
}

/** 模拟 background 推回来的一份 snapshot——取代了原来通过 agentEventListener 逐个重放
 * agent 事件的做法。那套逐事件计算活动步骤/慢提示的逻辑现在整个在 background 的
 * run-registry.ts 里（已经在 Task 2/3 的 run-registry.test.ts 里覆盖），这里的 snapshot
 * 已经是算好的最终结果，store.ts 只管原样显示。 */
function emitSnapshot(overrides: SnapshotOverrides): void {
  runPortListener?.({
    type: 'snapshot',
    messages: [],
    activitySteps: [],
    pendingConfirmation: null,
    pendingQuestion: null,
    ...overrides,
  });
}

/** 取最近一次发起的 startRun 消息，配合 toEqual(expect.objectContaining(...)) 断言字段。 */
function lastStartRunCall(): any {
  const calls = mocks.runPortPostMessage.mock.calls.filter((call) => call[0]?.type === 'startRun');
  return calls[calls.length - 1]?.[0];
}

function parsingPdfAttachment() {
  return {
    status: 'parsing' as const,
    id: 'parsing-pdf',
    taskId: 'parsing-task',
    file: new File([], 'parsing.pdf'),
    name: 'parsing.pdf',
    mimeType: 'application/pdf',
    size: 10,
    kind: 'pdf' as const,
    completedPages: 1,
    pageCount: 4,
  };
}

describe('chat store page context', () => {
  beforeEach(() => {
    mocks.sendMessage.mockReset();
    mocks.runPortPostMessage.mockReset();
    mocks.getActiveProvider.mockReset().mockResolvedValue(provider);
    mocks.replaceConversationMessages.mockReset().mockResolvedValue(undefined);
    mocks.getConversationMessages.mockReset().mockResolvedValue([]);
    mocks.deleteConversation.mockReset().mockResolvedValue(undefined);
    mocks.listConversations.mockReset().mockResolvedValue([]);
    mocks.extractPdfAttachment.mockReset().mockResolvedValue({ ok: false, reason: 'parse-failed' });
    runPortListener = undefined;
    runPortDisconnectListener = undefined;
    runPortHelloReply = null;
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({});
    useChat.setState({
      messages: [],
      busy: false,
      error: null,
      providers: [],
      selectedProviderId: null,
      selectedModel: '',
    });
  });

  // clear() invalidates any activeRun and resets conversationId/messages/activitySteps,
  // so a leftover run or armed timer from one test can't leak state into the next.
  afterEach(() => {
    useChat.getState().clear();
  });

  it('publishes an available http tab', async () => {
    mocks.sendMessage.mockResolvedValue({
      ok: true,
      data: { id: 7, title: 'Example', url: 'https://example.com/' },
    });

    await useChat.getState().refreshPageContext();

    expect(useChat.getState().pageContext).toEqual({
      status: 'available',
      tabId: 7,
      title: 'Example',
      url: 'https://example.com/',
    });
  });

  it.each(['http://localhost:3000/', 'http://192.168.1.20/dashboard'])('keeps readable current HTTP tabs available even when external fetching would reject them: %s', async (url) => {
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Local app', url } });

    await useChat.getState().refreshPageContext();

    expect(useChat.getState().pageContext).toMatchObject({ status: 'available', url });
  });

  it('marks chrome pages as restricted', async () => {
    mocks.sendMessage.mockResolvedValue({
      ok: true,
      data: { id: 8, title: 'Extensions', url: 'chrome://extensions/' },
    });

    await useChat.getState().refreshPageContext();

    expect(useChat.getState().pageContext.status).toBe('restricted');
  });

  it.each([
    'https://chromewebstore.google.com/detail/example',
    'https://chrome.google.com/webstore/detail/example',
  ])('marks protected Chrome Web Store pages as restricted: %s', async (url) => {
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 8, title: 'Web Store', url } });
    await useChat.getState().refreshPageContext();
    expect(useChat.getState().pageContext.status).toBe('restricted');
  });

  it('enters loading while refreshing and ignores an older refresh result', async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    mocks.sendMessage
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    useChat.setState({ pageContext: { status: 'error', message: 'Previous failure' } });

    const first = useChat.getState().refreshPageContext();
    expect(useChat.getState().pageContext).toEqual({ status: 'loading' });

    const second = useChat.getState().refreshPageContext();
    resolveSecond({ ok: true, data: { id: 2, title: 'Newest tab', url: 'https://new.example/' } });
    await second;
    expect(useChat.getState().pageContext).toMatchObject({ status: 'available', title: 'Newest tab' });

    resolveFirst({ ok: true, data: { id: 1, title: 'Older tab', url: 'chrome://extensions/' } });
    await first;
    expect(useChat.getState().pageContext).toMatchObject({ status: 'available', title: 'Newest tab' });
  });

  it('uses the hostname when an available tab has no title', async () => {
    mocks.sendMessage.mockResolvedValue({
      ok: true,
      data: { id: 9, url: 'https://docs.example.com/guide' },
    });

    await useChat.getState().refreshPageContext();

    expect(useChat.getState().pageContext).toEqual({
      status: 'available',
      tabId: 9,
      title: 'docs.example.com',
      url: 'https://docs.example.com/guide',
    });
  });

  it('uses a page-specific untitled label for a restricted tab without a title', async () => {
    mocks.sendMessage.mockResolvedValue({
      ok: true,
      data: { id: 10, url: 'chrome://extensions/' },
    });

    await useChat.getState().refreshPageContext();

    expect(useChat.getState().pageContext).toEqual({
      status: 'restricted',
      tabId: 10,
      title: 'Untitled page',
      url: 'chrome://extensions/',
    });
  });

  it('reports a failed active-tab lookup as page-context error state', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: false, error: 'No active tab' });

    await useChat.getState().refreshPageContext();

    expect(useChat.getState().pageContext).toEqual({ status: 'error', message: 'No active tab' });
  });

  it('reports a missing active-tab URL as page-context error state', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 11, title: 'No URL' } });

    await useChat.getState().refreshPageContext();

    expect(useChat.getState().pageContext).toEqual({
      status: 'error',
      message: 'No active tab found. Make sure a webpage is open.',
    });
  });

  it('treats a malformed active-tab URL as restricted rather than available', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 12, title: 'Malformed', url: 'not a URL' } });

    await useChat.getState().refreshPageContext();

    expect(useChat.getState().pageContext).toEqual({
      status: 'restricted',
      tabId: 12,
      title: 'Malformed',
      url: 'not a URL',
    });
  });

  it('keeps the newest provider refresh when older reads resolve late', async () => {
    let resolveOld!: (value: Record<string, unknown>) => void;
    let resolveNew!: (value: Record<string, unknown>) => void;
    const old = new Promise<Record<string, unknown>>((resolve) => { resolveOld = resolve; });
    const newest = new Promise<Record<string, unknown>>((resolve) => { resolveNew = resolve; });
    (globalThis as any).browser.storage.local.get = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(newest)
      .mockResolvedValue({});
    const first = useChat.getState().refreshProvider();
    const second = useChat.getState().refreshProvider();
    resolveNew({ 'runi:settings': { activeProviderId: 'new', providers: [{ ...provider, id: 'new', model: 'new-model' }] } });
    await second;
    resolveOld({ 'runi:settings': { activeProviderId: 'old', providers: [{ ...provider, id: 'old', model: 'old-model' }] } });
    await first;
    expect(useChat.getState().selectedProviderId).toBe('new');
  });

  it('keeps the latest conversation selection when an earlier read resolves late', async () => {
    let resolveA!: (value: any[]) => void;
    let resolveB!: (value: any[]) => void;
    mocks.getConversationMessages
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }));
    const first = useChat.getState().openConversation('A');
    const second = useChat.getState().openConversation('B');
    resolveB([{ role: 'user', content: 'B', createdAt: 1 }]);
    await expect(second).resolves.toBe(true);
    resolveA([{ role: 'user', content: 'A', createdAt: 1 }]);
    await expect(first).resolves.toBe(false);
    expect(useChat.getState().conversationId).toBe('B');
    expect(useChat.getState().messages[0]?.content).toBe('B');
  });

  it('sends a startRun request without browser tools when a normal send requests it', async () => {
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });

    await useChat.getState().send('hello', { withoutBrowserTools: true });

    const startRun = lastStartRunCall();
    expect(startRun).toEqual(expect.objectContaining({ withoutBrowserTools: true }));
    // 该轮明确不读取当前页面，因此不能把页面标题/地址注入系统提示词。
    expect(startRun.systemPrompt).not.toContain('https://example.com/');
    expect(startRun.systemPrompt).not.toContain('id=7');
  });

  it('injects the pinned tab and current time into the system prompt on a normal send', async () => {
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });

    await useChat.getState().send('hello');

    const { systemPrompt } = lastStartRunCall();
    expect(systemPrompt).toContain('<runtime_context>');
    expect(systemPrompt).toContain('id=7');
    expect(systemPrompt).toContain('title: "Example"');
    expect(systemPrompt).toContain('url: "https://example.com/"');
    expect(systemPrompt).toMatch(/当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 星期./);
  });

  it('applySnapshot ignores a snapshot whose tabId does not match the active run, or that arrives after the client has navigated away', async () => {
    // applySnapshot 的过滤条件是 run.tabId === snapshot.tabId 且 isCurrentOrigin(run.origin, get)——
    // 后者比较的是"当前 store 的 conversationId 是否还等于这个 run 发起时捕获的 origin"，
    // 不是拿 snapshot 自带的 conversationId 字段做比对（那个字段目前只是信息性的，见
    // lib/agent/run-port-protocol.ts 的 RunSnapshot），所以这里分别覆盖这两条真实生效的分支。
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'A', messages: [] });
    await useChat.getState().send('run in A');

    // 错误的 tabId：必须忽略。
    emitSnapshot({ tabId: 999, conversationId: 'A', busy: false, messages: [{ id: 'wrong-tab', role: 'assistant', content: 'wrong tab', createdAt: 1 }] });
    expect(useChat.getState().messages.some((m) => m.content === 'wrong tab')).toBe(false);

    // 客户端已经导航到另一个会话（conversationId 变了，但没有经过 invalidateActiveRun）：
    // isCurrentOrigin 失败，必须忽略。
    useChat.setState({ conversationId: 'somewhere-else' });
    emitSnapshot({ tabId: 7, conversationId: 'A', busy: false, messages: [{ id: 'stale-origin', role: 'assistant', content: 'stale origin', createdAt: 1 }] });
    expect(useChat.getState().messages.some((m) => m.content === 'stale origin')).toBe(false);

    // tabId 和 origin 都对得上的 snapshot 才会生效。
    useChat.setState({ conversationId: 'A' });
    emitSnapshot({ tabId: 7, conversationId: 'A', busy: false, messages: [{ id: 'right', role: 'assistant', content: 'applied', createdAt: 1 }] });
    expect(useChat.getState().messages).toEqual([{ id: 'right', role: 'assistant', content: 'applied', createdAt: 1 }]);
  });

  // Chrome 会主动销毁侧边栏文档（切标签页、手动关闭），但 background 里的 run 继续跑。
  // 重开的面板是一份全新的模块状态：activeRun 是 null，conversationId 是新随机生成的。
  // 这两条用例覆盖的正是"重开后能不能重新接上那一轮"——本次迁移的第二个目标
  // （设计文档 §2："面板重开后重建出完整的当前状态"）。
  describe('reconnecting a freshly reopened panel to an in-flight background run', () => {
    const liveMessages = [
      { id: 'u1', role: 'user', content: '帮我填这个表单', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '正在填写…', createdAt: 2 },
    ];

    function armLiveRunHelloReply(): void {
      runPortHelloReply = {
        type: 'snapshot',
        tabId: DEFAULT_TAB_ID,
        conversationId: 'live-conv',
        busy: true,
        messages: liveMessages,
        activitySteps: [{ id: 'call-1', description: '正在填写表单', status: 'running' }],
        pendingConfirmation: { toolCallId: 'call-1', toolName: 'browser_fill_form', summary: '提交登录表单' },
        pendingQuestion: null,
      };
    }

    it('adopts the in-flight snapshot returned by the hello handshake instead of loading stale Dexie history', async () => {
      armLiveRunHelloReply();
      // 这一轮不是本面板发起的（本用例从头到尾没有调用 send()/runAgent）——正是"面板被销毁后
      // 重开"的场景：新文档里 activeRun 一开始就是 null。
      await connectPort();

      expect(useChat.getState()).toMatchObject({
        conversationId: 'live-conv',
        busy: true,
        messages: liveMessages,
        activitySteps: [{ id: 'call-1', status: 'running' }],
        pendingConfirmation: { toolCallId: 'call-1', toolName: 'browser_fill_form' },
      });
      // 走了快照这条路径就不该再去 Dexie 读历史——那份历史可能落后于还没落盘的流式增量，
      // 而且 openConversation 会顺手把 busy/activitySteps 清掉。
      expect(mocks.getConversationMessages).not.toHaveBeenCalled();
      // tabId -> conversationId 映射要跟着这份被采纳的会话走，否则下次重开又对不上。
      expect((globalThis as any).browser.storage.session.set)
        .toHaveBeenCalledWith({ [`runi:tab-conversation:${DEFAULT_TAB_ID}`]: 'live-conv' });
    });

    it('settles the reconnected run when its final non-busy snapshot arrives', async () => {
      armLiveRunHelloReply();
      await connectPort();

      const finalMessages = [
        ...liveMessages.slice(0, 1),
        { id: 'a1', role: 'assistant', content: '已填写并提交。', createdAt: 3 },
      ];
      emitSnapshot({
        tabId: DEFAULT_TAB_ID,
        conversationId: 'live-conv',
        busy: false,
        messages: finalMessages,
        activitySteps: [],
        pendingConfirmation: null,
      });

      expect(useChat.getState()).toMatchObject({
        busy: false,
        messages: finalMessages,
        activitySteps: [],
        pendingConfirmation: null,
      });

      // settleRun 已经把 activeRun 清空：此后的 stop() 不该再往 Port 上发东西。
      mocks.runPortPostMessage.mockClear();
      useChat.getState().stop();
      expect(mocks.runPortPostMessage).not.toHaveBeenCalled();
    });
  });

  it('reconnects and resends instead of losing a user action taken while the port is down', async () => {
    // MV3 会定期回收空闲的 service worker，连带断开每一条 Port。断开后面板手里那个 Port
    // 对象已经死了，postMessage 会抛 "Attempting to use a disconnected port object"。
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    await useChat.getState().send('long running task');
    expect(runPortDisconnectListener).toBeDefined();

    runPortDisconnectListener!();
    mocks.runPortPostMessage.mockClear();

    useChat.getState().stop();

    // 新连接上先补一次 hello（重新登记成这个 tab 的监听者），随后 stop 必须真的送达。
    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({ type: 'hello', tabId: 7 });
    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({ type: 'stop', tabId: 7 });
  });

  it('tells background a conversation was deleted so an in-flight run cannot resurrect it', async () => {
    await connectPort();

    await useChat.getState().removeConversation('doomed-conv');

    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({
      type: 'conversationDeleted', tabId: 7, conversationId: 'doomed-conv', deleted: true,
    });
  });

  it('withdraws the deletion notice when the delete itself fails, so the conversation stays writable', async () => {
    await connectPort();
    mocks.deleteConversation.mockRejectedValueOnce(new Error('db is on fire'));

    await useChat.getState().removeConversation('survivor-conv');

    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({
      type: 'conversationDeleted', tabId: 7, conversationId: 'survivor-conv', deleted: true,
    });
    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({
      type: 'conversationDeleted', tabId: 7, conversationId: 'survivor-conv', deleted: false,
    });
  });

  it('keeps a newly opened conversation untouched when the previous run in the old conversation later settles', async () => {
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'completed-run', messages: [] });

    await useChat.getState().send('Message for A');
    const aConversationId = lastStartRunCall().conversationId;

    mocks.getConversationMessages.mockResolvedValueOnce([{ role: 'user', content: 'Message for B', createdAt: 1 }]);
    await expect(useChat.getState().openConversation('B')).resolves.toBe(true);

    // A 的迟到 snapshot（conversationId 仍是 A 的）不能覆盖已经切到的 B。
    emitSnapshot({
      tabId: 7,
      conversationId: aConversationId,
      busy: false,
      messages: [{ id: 'late', role: 'assistant', content: 'late A text', createdAt: 1 }],
    });

    expect(useChat.getState()).toMatchObject({
      conversationId: 'B',
      messages: [{ role: 'user', content: 'Message for B' }],
      activitySteps: [],
      busy: false,
    });
  });

  it('sends a stop message for the run in the outgoing conversation, and ignores its stale snapshot, when a new run starts while opening another conversation is still pending', async () => {
    await connectPort();
    let resolveOpen!: (value: any[]) => void;
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'persistence-window', messages: [] });
    mocks.getConversationMessages.mockReturnValueOnce(new Promise((resolve) => { resolveOpen = resolve; }));

    const opening = useChat.getState().openConversation('B');
    await useChat.getState().send('Gap run for A');
    const aConversationId = lastStartRunCall().conversationId;
    mocks.runPortPostMessage.mockClear();

    resolveOpen([{ role: 'user', content: 'Message for B', createdAt: 1 }]);
    await expect(opening).resolves.toBe(true);
    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({ type: 'stop', tabId: 7 });

    emitSnapshot({
      tabId: 7,
      conversationId: aConversationId,
      busy: false,
      messages: [{ id: 'late', role: 'assistant', content: 'late gap text', createdAt: 1 }],
    });

    expect(useChat.getState()).toMatchObject({ conversationId: 'B', messages: [{ content: 'Message for B' }], busy: false });
  });

  it('sends a stop message and does not resurrect a conversation whose deletion is in flight when a new run for it starts', async () => {
    await connectPort();
    let resolveDelete!: () => void;
    mocks.deleteConversation.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'A', messages: [] });

    const removing = useChat.getState().removeConversation('A');
    await useChat.getState().send('Gap run for deleted A');
    mocks.runPortPostMessage.mockClear();

    resolveDelete();
    await removing;
    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({ type: 'stop', tabId: 7 });

    expect(useChat.getState().conversationId).not.toBe('A');
    expect(useChat.getState().messages).toEqual([]);
  });

  it('does not send a stray stop for a run that already settled before later navigation', async () => {
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'completed-run', messages: [] });

    await useChat.getState().send('Completed A');
    const conversationId = lastStartRunCall().conversationId;
    emitSnapshot({ tabId: 7, conversationId, busy: false, messages: [{ id: 'done', role: 'assistant', content: 'done', createdAt: 1 }] });
    mocks.runPortPostMessage.mockClear();

    mocks.getConversationMessages.mockResolvedValueOnce([{ role: 'user', content: 'B', createdAt: 1 }]);
    await useChat.getState().openConversation('B');
    useChat.getState().clear();

    expect(mocks.runPortPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stop' }));
  });

  it('evicts B if deleting non-active B completes after B becomes active and starts a run', async () => {
    await connectPort();
    let resolveDelete!: () => void;
    mocks.deleteConversation.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'A', messages: [] });
    const deleting = useChat.getState().removeConversation('B');
    mocks.getConversationMessages.mockResolvedValueOnce([{ role: 'user', content: 'B history', createdAt: 1 }]);
    await useChat.getState().openConversation('B');
    await useChat.getState().send('B run');
    mocks.runPortPostMessage.mockClear();

    resolveDelete();
    await deleting;
    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({ type: 'stop', tabId: 7 });

    expect(useChat.getState().conversationId).not.toBe('B');
    expect(useChat.getState().messages).toEqual([]);
  });

  it('does not start a selection shortcut after its active-tab preflight loses the conversation', async () => {
    let resolveTab!: (value: unknown) => void;
    mocks.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { resolveTab = resolve; }));
    useChat.setState({ conversationId: 'A', messages: [] });

    const shortcut = useChat.getState().runShortcut({
      id: 'builtin:explain-selection', origin: 'builtin', scope: 'selection', customized: false,
    });
    useChat.getState().clear();
    const replacementId = useChat.getState().conversationId;
    resolveTab({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    await shortcut;

    expect(mocks.runPortPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'startRun' }));
    expect(useChat.getState()).toMatchObject({ conversationId: replacementId, messages: [], busy: false });
  });

  it.each(['clear', 'delete'] as const)('sends a stop message and keeps the replacement conversation untouched when the previous run settles after %s', async (action) => {
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'A', messages: [] });

    await useChat.getState().send('Message for A');
    const aConversationId = lastStartRunCall().conversationId;
    mocks.runPortPostMessage.mockClear();

    if (action === 'clear') useChat.getState().clear();
    else await useChat.getState().removeConversation('A');
    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({ type: 'stop', tabId: 7 });
    const replacementId = useChat.getState().conversationId;

    emitSnapshot({
      tabId: 7,
      conversationId: aConversationId,
      busy: false,
      messages: [{ id: 'late', role: 'assistant', content: 'late A text', createdAt: 1 }],
    });

    expect(useChat.getState()).toMatchObject({ conversationId: replacementId, messages: [], activitySteps: [], busy: false });
  });

  it.each(['clear', 'remove'] as const)('keeps %s authoritative when a pending conversation open resolves late', async (action) => {
    let resolve!: (value: any[]) => void;
    mocks.getConversationMessages.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const open = useChat.getState().openConversation('old');
    if (action === 'clear') useChat.getState().clear();
    else await useChat.getState().removeConversation('old');
    const expectedId = useChat.getState().conversationId;
    resolve([{ role: 'user', content: 'stale', createdAt: 1 }]);
    await expect(open).resolves.toBe(false);
    expect(useChat.getState().conversationId).toBe(expectedId);
    expect(useChat.getState().messages).toEqual([]);
  });

  it('forwards a rejected confirmation decision over the port and reflects the resulting snapshot', async () => {
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    const conversationId = useChat.getState().conversationId;

    await useChat.getState().send('write');
    emitSnapshot({
      tabId: 7,
      conversationId,
      busy: true,
      activitySteps: [{ id: 'call-1', description: '点击「购买」按钮 button.buy', status: 'running' }],
      pendingConfirmation: { toolCallId: 'call-1', toolName: 'browser_click', summary: '点击「购买」按钮 button.buy' },
    });
    expect(useChat.getState().pendingConfirmation).toEqual({ toolCallId: 'call-1', toolName: 'browser_click', summary: '点击「购买」按钮 button.buy' });

    useChat.getState().respondToConfirmation(false);
    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({ type: 'respondConfirm', tabId: 7, toolCallId: 'call-1', approved: false });
    // optimistic local update happens immediately, before any snapshot round-trip.
    expect(useChat.getState().pendingConfirmation).toBeNull();

    // background 处理完 respondConfirm 后广播的 snapshot：activity step 标记失败，pendingConfirmation 清空。
    emitSnapshot({
      tabId: 7,
      conversationId,
      busy: true,
      activitySteps: [{ id: 'call-1', description: '点击「购买」按钮 button.buy', status: 'failed' }],
      pendingConfirmation: null,
    });
    expect(useChat.getState().pendingConfirmation).toBeNull();
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'failed' }]);
  });

  it('projects an ask_user question to pendingQuestion and forwards the answer over the port', async () => {
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    const conversationId = useChat.getState().conversationId;

    await useChat.getState().send('which account should I use');
    expect(useChat.getState().pendingQuestion).toBeNull();

    emitSnapshot({
      tabId: 7,
      conversationId,
      busy: true,
      pendingQuestion: { toolCallId: 'call-ask-1', question: '用哪个账号登录？' },
    });
    expect(useChat.getState().pendingQuestion).toEqual({ toolCallId: 'call-ask-1', question: '用哪个账号登录？' });

    useChat.getState().respondToQuestion('用工作账号');
    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({ type: 'respondQuestion', tabId: 7, toolCallId: 'call-ask-1', answer: '用工作账号' });
    // optimistic local update happens immediately, before any snapshot round-trip.
    expect(useChat.getState().pendingQuestion).toBeNull();

    emitSnapshot({ tabId: 7, conversationId, busy: true, pendingQuestion: null });
    expect(useChat.getState().pendingQuestion).toBeNull();
  });

  it('attaches a reported task outcome to the assistant message via the snapshot', async () => {
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    const conversationId = useChat.getState().conversationId;

    await useChat.getState().send('fill the form');
    emitSnapshot({
      tabId: 7,
      conversationId,
      busy: false,
      messages: [{ id: 'assistant-1', role: 'assistant', content: '已提交表单。', createdAt: 1, taskOutcome: { outcome: 'success', reason: '已提交表单。' } }],
    });

    const last = useChat.getState().messages.at(-1);
    expect(last?.taskOutcome).toEqual({ outcome: 'success', reason: '已提交表单。' });
  });

  it('does not attach a task outcome when none was reported', async () => {
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    const conversationId = useChat.getState().conversationId;

    await useChat.getState().send('what does this page say');
    emitSnapshot({
      tabId: 7,
      conversationId,
      busy: false,
      messages: [{ id: 'assistant-1', role: 'assistant', content: 'This page is about...', createdAt: 1 }],
    });

    const last = useChat.getState().messages.at(-1);
    expect(last?.taskOutcome).toBeUndefined();
  });

  it('restores a persisted task outcome when reopening a conversation', async () => {
    mocks.getConversationMessages.mockResolvedValueOnce([
      { role: 'assistant', content: '已完成', createdAt: 1, taskOutcome: { outcome: 'partial', reason: '只填了一半。' } },
    ]);
    await useChat.getState().openConversation('with-outcome');

    const restored = useChat.getState().messages.at(-1);
    expect(restored?.taskOutcome).toEqual({ outcome: 'partial', reason: '只填了一半。' });
  });

  it('sends a stop message when the user stops a run with a pending ask_user question, and clears it once background confirms', async () => {
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    const conversationId = useChat.getState().conversationId;

    await useChat.getState().send('which account should I use');
    emitSnapshot({ tabId: 7, conversationId, busy: true, pendingQuestion: { toolCallId: 'call-ask-2', question: '用哪个账号登录？' } });

    useChat.getState().stop();
    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({ type: 'stop', tabId: 7 });
    // optimistic local update happens immediately, before any snapshot round-trip.
    expect(useChat.getState().pendingQuestion).toBeNull();
    expect(useChat.getState().activitySteps).toEqual([]);

    emitSnapshot({ tabId: 7, conversationId, busy: false, pendingQuestion: null, activitySteps: [] });
    expect(useChat.getState().pendingQuestion).toBeNull();
    expect(useChat.getState().busy).toBe(false);
  });

  it('clears activity steps and busy state once background confirms a stop', async () => {
    await connectPort();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    const conversationId = useChat.getState().conversationId;

    await useChat.getState().send('write');
    emitSnapshot({
      tabId: 7,
      conversationId,
      busy: true,
      activitySteps: [{ id: 'running', description: '点击 button', status: 'running' }],
    });
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'running', status: 'running' }]);

    useChat.getState().stop();
    expect(mocks.runPortPostMessage).toHaveBeenCalledWith({ type: 'stop', tabId: 7 });
    // optimistic local update happens immediately, before any snapshot round-trip.
    expect(useChat.getState().activitySteps).toEqual([]);

    emitSnapshot({ tabId: 7, conversationId, busy: false, activitySteps: [] });
    expect(useChat.getState().activitySteps).toEqual([]);
    expect(useChat.getState().busy).toBe(false);
  });

  it('reports that a normal send did not start for empty input or a busy store', async () => {
    await expect(useChat.getState().send('   ', { withoutBrowserTools: true })).resolves.toBe(false);
    expect(mocks.runPortPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'startRun' }));

    useChat.setState({ busy: true });
    await expect(useChat.getState().send('Hello', { withoutBrowserTools: true })).resolves.toBe(false);
    expect(mocks.runPortPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'startRun' }));
  });

  describe('error banner retryAction', () => {
    it('exposes a retryAction when resolving the active tab fails on send, and it resends the same message', async () => {
      await connectPort();
      mocks.sendMessage.mockResolvedValueOnce({ ok: false, error: 'No active tab' });

      await expect(useChat.getState().send('hello')).resolves.toBe(false);

      expect(useChat.getState().error).toBe('No active tab');
      expect(useChat.getState().retryAction).toBeInstanceOf(Function);

      mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      useChat.getState().retryAction!();

      await vi.waitFor(() => expect(lastStartRunCall()).toEqual(expect.objectContaining({ type: 'startRun' })));
      expect(useChat.getState().error).toBeNull();
      expect(useChat.getState().retryAction).toBeNull();
    });

    it('clears a stale retryAction once a run starts successfully', async () => {
      await connectPort();
      mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      useChat.setState({ error: 'stale error', retryAction: () => undefined });

      await useChat.getState().send('hello');

      expect(useChat.getState().error).toBeNull();
      expect(useChat.getState().retryAction).toBeNull();
    });

    it('exposes a retryAction when a selection-scope shortcut fails to read the selection, and it re-runs the shortcut', async () => {
      mocks.sendMessage
        .mockResolvedValueOnce({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } })
        .mockResolvedValueOnce({ ok: false, error: 'no selection' });
      const shortcut = {
        id: 'builtin:explain-selection', origin: 'builtin' as const, scope: 'selection' as const, customized: false,
      };

      await useChat.getState().runShortcut(shortcut);

      expect(useChat.getState().error).toBe('no selection');
      expect(useChat.getState().retryAction).toBeInstanceOf(Function);

      useChat.getState().retryAction!();

      // runShortcut's selection-scope preflight clears error synchronously before its first await.
      expect(useChat.getState().error).toBeNull();
    });
  });

  describe('restoreTabConversation pending ask', () => {
    beforeEach(() => {
      (globalThis as any).browser.tabs = { query: vi.fn().mockResolvedValue([{ id: 42 }]) };
      (globalThis as any).browser.storage.session = {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      useChat.setState({ quotedSelection: null, pendingFocusToken: 0 });
    });

    it('sets quotedSelection and bumps the focus token when a pending ask exists for this tab', async () => {
      const key = 'runi:tab-pending-ask:42';
      (globalThis as any).browser.storage.session.get = vi.fn().mockResolvedValue({ [key]: 'selected text' });

      await useChat.getState().restoreTabConversation();

      expect(useChat.getState().quotedSelection).toBe('selected text');
      expect(useChat.getState().pendingFocusToken).toBeGreaterThan(0);
      expect((globalThis as any).browser.storage.session.remove).toHaveBeenCalledWith(key);
    });

    it('leaves the composer untouched when there is no pending ask for this tab', async () => {
      await useChat.getState().restoreTabConversation();

      expect(useChat.getState().quotedSelection).toBeNull();
      expect(useChat.getState().pendingFocusToken).toBe(0);
    });

    // sidePanel.open() 对已经打开的面板是 no-op，不会重新触发 restoreTabConversation，
    // 所以这一条刻意不再调用它——只靠 storage.onChanged 事件驱动消费。
    it('consumes a pending ask that arrives while the panel is already open, without a second restore', async () => {
      const key = 'runi:tab-pending-ask:42';
      await useChat.getState().restoreTabConversation();
      expect(useChat.getState().quotedSelection).toBeNull();
      expect(useChat.getState().pendingFocusToken).toBe(0);

      (globalThis as any).browser.storage.session.get = vi
        .fn()
        .mockResolvedValue({ [key]: 'freshly selected text' });
      emitStorageChange({ [key]: { newValue: 'freshly selected text' } }, 'session');

      await vi.waitFor(() => expect(useChat.getState().quotedSelection).toBe('freshly selected text'));
      expect(useChat.getState().pendingFocusToken).toBeGreaterThan(0);
      expect((globalThis as any).browser.storage.session.remove).toHaveBeenCalledWith(key);
    });

    it('ignores storage changes from another area, another tab, or a pending-ask deletion', async () => {
      const key = 'runi:tab-pending-ask:42';
      await useChat.getState().restoreTabConversation();
      (globalThis as any).browser.storage.session.get = vi
        .fn()
        .mockResolvedValue({ [key]: 'must not be consumed' });

      emitStorageChange({ [key]: { newValue: 'x' } }, 'local');
      emitStorageChange({ 'runi:tab-pending-ask:99': { newValue: 'x' } }, 'session');
      emitStorageChange({ [key]: {} }, 'session');

      await Promise.resolve();
      expect(useChat.getState().quotedSelection).toBeNull();
      expect(useChat.getState().pendingFocusToken).toBe(0);
    });
  });

  describe('restoreTabConversation does not wipe tab session on panel remount', () => {
    beforeEach(() => {
      (globalThis as any).browser.tabs = { query: vi.fn().mockResolvedValue([{ id: 42 }]) };
      (globalThis as any).browser.storage.session = {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };
    });

    function removedKeys(): string[] {
      return (globalThis as any).browser.storage.session.remove.mock.calls.map((args: unknown[]) => args[0]);
    }

    it('restoring the already-saved conversation for this tab does NOT clear the tab session', async () => {
      const convKey = 'runi:tab-conversation:42';
      (globalThis as any).browser.storage.session.get = vi.fn().mockImplementation((key: string) => {
        if (key === convKey) return Promise.resolve({ [convKey]: 'saved-convo' });
        return Promise.resolve({});
      });

      await useChat.getState().restoreTabConversation();

      expect(useChat.getState().conversationId).toBe('saved-convo');
      expect(removedKeys().some((key) => key.startsWith('runi:tab-session:'))).toBe(false);
    });

    it('an actual conversation switch after restore DOES clear the tab session', async () => {
      // First restore with nothing saved for this tab yet — just establishes panelTabId.
      await useChat.getState().restoreTabConversation();

      // A real conversation change (e.g. user picked a different one in the history drawer).
      await useChat.getState().openConversation('other-convo');

      expect(useChat.getState().conversationId).toBe('other-convo');
      expect(removedKeys()).toContain('runi:tab-session:42');
    });
  });

  describe('quoted selection composition on send', () => {
    beforeEach(async () => {
      mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      await connectPort();
      useChat.setState({ quotedSelection: null });
    });

    it('sends the quote-formatted template plus the question to background, but stores only the question as the displayed message', async () => {
      useChat.setState({ quotedSelection: 'the selected text' });

      await useChat.getState().send('what does this mean?');

      const startRun = lastStartRunCall();
      expect(startRun.agentUserContent).toContain('the selected text');
      expect(startRun.agentUserContent).toContain('what does this mean?');

      const userMessage = useChat.getState().messages.find((m) => m.role === 'user')!;
      expect(userMessage.content).toBe('what does this mean?');
      expect(userMessage.quotedText).toBe('the selected text');
    });

    it('clears quotedSelection once the message is committed', async () => {
      useChat.setState({ quotedSelection: 'the selected text' });

      await useChat.getState().send('a question');

      expect(useChat.getState().quotedSelection).toBeNull();
    });

    it('sends just the question, with no quotedText, when there is no pending quote', async () => {
      await useChat.getState().send('a plain question');

      const startRun = lastStartRunCall();
      expect(startRun.agentUserContent).toBe('a plain question');

      const userMessage = useChat.getState().messages.find((m) => m.role === 'user')!;
      expect(userMessage.quotedText).toBeUndefined();
    });

    it('clearQuotedSelection clears the pending quote without sending anything', () => {
      useChat.setState({ quotedSelection: 'the selected text' });

      useChat.getState().clearQuotedSelection();

      expect(useChat.getState().quotedSelection).toBeNull();
      expect(mocks.runPortPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'startRun' }));
    });
  });

  describe('pendingAttachments management', () => {
    beforeEach(() => {
      useChat.setState({ pendingAttachments: [], error: null });
    });

    it('adds a text file via addAttachmentFiles', async () => {
      const file = new File(['file contents'], 'notes.txt', { type: 'text/plain' });
      await useChat.getState().addAttachmentFiles([file]);
      expect(useChat.getState().pendingAttachments).toHaveLength(1);
      expect(useChat.getState().pendingAttachments[0]).toMatchObject({
        name: 'notes.txt', kind: 'text', status: 'ready',
        attachment: { kind: 'text', textContent: 'file contents' },
      });
    });

    it('rejects a file over the image size limit and reports which file', async () => {
      const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
      await useChat.getState().addAttachmentFiles([big]);
      expect(useChat.getState().pendingAttachments[0]).toMatchObject({
        status: 'error', name: 'big.png', reason: 'too-large', retryable: false,
      });
    });

    it('rejects an unsupported file type and reports which file', async () => {
      const file = new File(['x'], 'archive.zip', { type: 'application/zip' });
      await useChat.getState().addAttachmentFiles([file]);
      expect(useChat.getState().pendingAttachments[0]).toMatchObject({
        status: 'error', name: 'archive.zip', reason: 'unsupported-type', retryable: false,
      });
    });

    it('caps pending attachments at 5 and reports the limit', async () => {
      const files = Array.from({ length: 6 }, (_, i) => new File([`f${i}`], `f${i}.txt`, { type: 'text/plain' }));
      await useChat.getState().addAttachmentFiles(files);
      expect(useChat.getState().pendingAttachments).toHaveLength(5);
      expect(useChat.getState().error).toContain('5');
    });

    it('removeAttachment drops only the matching attachment', async () => {
      await useChat.getState().addAttachmentFiles([
        new File(['a'], 'a.txt', { type: 'text/plain' }),
        new File(['b'], 'b.txt', { type: 'text/plain' }),
      ]);
      const [first] = useChat.getState().pendingAttachments;
      useChat.getState().removeAttachment(first.id);
      expect(useChat.getState().pendingAttachments).toHaveLength(1);
      expect(useChat.getState().pendingAttachments[0].name).toBe('b.txt');
    });

    it('reserves a PDF chip immediately and blocks send until parsing completes', async () => {
      let finish!: (value: any) => void;
      mocks.extractPdfAttachment.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

      const adding = useChat.getState().addAttachmentFiles([
        new File(['%PDF-body'], 'report.pdf', { type: 'application/pdf' }),
      ]);

      expect(useChat.getState().pendingAttachments[0]).toMatchObject({ status: 'queued', name: 'report.pdf' });
      await expect(useChat.getState().send('summarize')).resolves.toBe(false);
      finish({ ok: true, value: { text: 'private text', pageCount: 3, extractedChars: 12, truncated: false } });
      await adding;
      expect(useChat.getState().pendingAttachments[0]).toMatchObject({
        status: 'ready',
        attachment: { kind: 'pdf', pageCount: 3, extractedChars: 12 },
        transientText: 'private text',
      });
    });

    it('cancels removed work and ignores a late result', async () => {
      let finish!: (value: any) => void;
      let signal!: AbortSignal;
      mocks.extractPdfAttachment.mockImplementation((_file, options) => new Promise((resolve) => {
        finish = resolve;
        signal = options.signal;
      }));
      const adding = useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf')]);
      const id = useChat.getState().pendingAttachments[0].id;
      await vi.waitFor(() => expect(signal).toBeDefined());

      useChat.getState().removeAttachment(id);

      expect(signal.aborted).toBe(true);
      finish({ ok: true, value: { text: 'late', pageCount: 1, extractedChars: 4, truncated: false } });
      await adding;
      expect(useChat.getState().pendingAttachments).toEqual([]);
    });

    it('reserves five slots across overlapping add calls', async () => {
      const first = useChat.getState().addAttachmentFiles([
        new File(['a'], '1.txt'), new File(['b'], '2.txt'), new File(['c'], '3.txt'),
      ]);
      const second = useChat.getState().addAttachmentFiles([
        new File(['d'], '4.txt'), new File(['e'], '5.txt'), new File(['f'], '6.txt'),
      ]);

      await Promise.all([first, second]);

      expect(useChat.getState().pendingAttachments).toHaveLength(5);
    });

    it('clears pending jobs when starting a new chat', async () => {
      mocks.extractPdfAttachment.mockImplementation((_file, options) => new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }));
      }));
      const adding = useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf')]);

      useChat.getState().clear();

      await adding;
      expect(useChat.getState().pendingAttachments).toEqual([]);
    });

    it('clears pending jobs after a conversation is opened successfully', async () => {
      mocks.extractPdfAttachment.mockImplementation((_file, options) => new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }));
      }));
      mocks.getConversationMessages.mockResolvedValue([]);
      const adding = useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf')]);

      await expect(useChat.getState().openConversation('saved')).resolves.toBe(true);

      await adding;
      expect(useChat.getState().pendingAttachments).toEqual([]);
    });

    it('disposes pending attachment jobs without changing the conversation', async () => {
      mocks.extractPdfAttachment.mockImplementation((_file, options) => new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }));
      }));
      const conversationId = useChat.getState().conversationId;
      const adding = useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf')]);

      useChat.getState().disposeAttachments();

      await adding;
      expect(useChat.getState().pendingAttachments).toEqual([]);
      expect(useChat.getState().conversationId).toBe(conversationId);
    });

    it('clears attachment work when a conversation becomes active during its deletion', async () => {
      let resolveDelete!: () => void;
      let finish!: (value: any) => void;
      let signal!: AbortSignal;
      mocks.deleteConversation.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }));
      mocks.extractPdfAttachment.mockImplementation((_file, options) => new Promise((resolve) => {
        finish = resolve;
        signal = options.signal;
      }));
      useChat.setState({ conversationId: 'A' });
      const removing = useChat.getState().removeConversation('B');
      await vi.waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledWith('B'));
      await useChat.getState().openConversation('B');
      const adding = useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'b.pdf')]);
      await vi.waitFor(() => expect(signal).toBeDefined());

      resolveDelete();
      await removing;
      const wasAborted = signal.aborted;
      finish({ ok: false, reason: 'cancelled' });
      await adding;

      expect(wasAborted).toBe(true);
      expect(useChat.getState().pendingAttachments).toEqual([]);
    });

    it('still clears an attachment when deleted conversation refresh fails after becoming active', async () => {
      let resolveDelete!: () => void;
      mocks.deleteConversation.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }));
      mocks.listConversations.mockRejectedValueOnce(new Error('refresh failed'));
      useChat.setState({ conversationId: 'A' });
      const removing = useChat.getState().removeConversation('B');
      await vi.waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledWith('B'));
      await useChat.getState().openConversation('B');
      useChat.setState({ pendingAttachments: [{
        status: 'ready', id: 'pdf-b', name: 'b.pdf', mimeType: 'application/pdf', size: 10, kind: 'pdf',
        attachment: {
          id: 'pdf-b', name: 'b.pdf', mimeType: 'application/pdf', size: 10, kind: 'pdf',
          pageCount: 1, extractedChars: 7, truncated: false,
        },
        transientText: 'private',
      }] });

      resolveDelete();

      await expect(removing).rejects.toThrow('refresh failed');
      expect(useChat.getState().conversationId).not.toBe('B');
      expect(useChat.getState().pendingAttachments).toEqual([]);
    });

    it('retries a parse failure with the same attachment ID', async () => {
      mocks.extractPdfAttachment
        .mockResolvedValueOnce({ ok: false, reason: 'parse-failed' })
        .mockResolvedValueOnce({
          ok: true,
          value: { text: 'ok', pageCount: 1, extractedChars: 2, truncated: false },
        });
      await useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf')]);
      const failed = useChat.getState().pendingAttachments[0];
      expect(failed).toMatchObject({ status: 'error', retryable: true });

      await useChat.getState().retryAttachment(failed.id);

      expect(useChat.getState().pendingAttachments[0]).toMatchObject({ status: 'ready', id: failed.id });
    });
  });

  it('does not start a shortcut while an attachment is parsing', async () => {
    useChat.setState({ pendingAttachments: [parsingPdfAttachment()] });

    await useChat.getState().runShortcut({
      id: 'custom:read',
      origin: 'custom',
      scope: 'none',
      customized: true,
      name: 'Read',
      prompt: 'Read the page',
    });

    expect(mocks.runPortPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'startRun' }));
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('does not submit a message edit while an attachment is parsing', async () => {
    const message = { id: 'editable', role: 'user' as const, content: 'old', createdAt: 1, kind: 'input' as const };
    useChat.setState({
      messages: [message],
      pendingAttachments: [parsingPdfAttachment()],
    });

    await expect(useChat.getState().editMessage(message.id, 'new')).resolves.toBe(false);

    expect(mocks.runPortPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'startRun' }));
    expect(mocks.getActiveProvider).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(useChat.getState().messages).toEqual([message]);
  });

  describe('attachment composition on send', () => {
    beforeEach(async () => {
      mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      await connectPort();
      useChat.setState({ pendingAttachments: [] });
    });

    it('folds a text attachment into the prompt text, clears pendingAttachments, and stores it on the message', async () => {
      await useChat.getState().addAttachmentFiles([new File(['secret notes'], 'notes.txt', { type: 'text/plain' })]);

      await useChat.getState().send('summarize this');

      const startRun = lastStartRunCall();
      expect(startRun.agentUserContent).toContain('secret notes');
      expect(startRun.agentUserContent).toContain('summarize this');
      expect(useChat.getState().pendingAttachments).toHaveLength(0);

      const userMessage = useChat.getState().messages.find((m) => m.role === 'user')!;
      expect(userMessage.content).toBe('summarize this');
      expect(userMessage.attachments).toHaveLength(1);
      expect(userMessage.attachments![0].name).toBe('notes.txt');
    });

    it('passes an image attachment as the images field of the startRun request', async () => {
      await useChat.getState().addAttachmentFiles([
        new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }),
      ]);

      await useChat.getState().send('what is this?');

      const startRun = lastStartRunCall();
      expect(startRun.images).toEqual([expect.objectContaining({ type: 'image', mimeType: 'image/png' })]);
    });

    it('sends PDF text once but keeps only metadata on the displayed message', async () => {
      mocks.extractPdfAttachment.mockResolvedValue({
        ok: true,
        value: { text: 'private PDF text', pageCount: 2, extractedChars: 16, truncated: false },
      });
      await useChat.getState().addAttachmentFiles([
        new File(['%PDF-x'], 'a.pdf', { type: 'application/pdf' }),
      ]);

      await useChat.getState().send('summarize');

      const startRun = lastStartRunCall();
      expect(startRun.agentUserContent).toContain('private PDF text');
      const userMessage = useChat.getState().messages.find((message) => message.role === 'user')!;
      expect(userMessage.attachments?.[0]).toMatchObject({ kind: 'pdf', pageCount: 2 });
      expect(JSON.stringify(userMessage)).not.toContain('private PDF text');
    });

    it('allows typed text to send while an error chip remains', async () => {
      useChat.setState({ pendingAttachments: [{
        status: 'error', id: 'bad', name: 'bad.pdf', mimeType: 'application/pdf', size: 10,
        kind: 'pdf', reason: 'invalid-pdf', retryable: false,
      }] });

      await expect(useChat.getState().send('continue without it')).resolves.toBe(true);
    });

    it('does not send when only an error chip remains', async () => {
      useChat.setState({ pendingAttachments: [{
        status: 'error', id: 'bad', name: 'bad.pdf', mimeType: 'application/pdf', size: 10,
        kind: 'pdf', reason: 'invalid-pdf', retryable: false,
      }] });

      await expect(useChat.getState().send('')).resolves.toBe(false);
    });

    it('uses the localized default prompt for attachment-only send', async () => {
      mocks.extractPdfAttachment.mockResolvedValue({
        ok: true,
        value: { text: 'pdf text', pageCount: 1, extractedChars: 8, truncated: false },
      });
      await useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf')]);

      await expect(useChat.getState().send('')).resolves.toBe(true);

      const startRun = lastStartRunCall();
      expect(startRun.agentUserContent).toContain('Analyze the attached file.');
    });

    it('cancels attachment work added while send preflight is still pending', async () => {
      let resolveProvider!: (value: typeof provider) => void;
      let finish!: (value: any) => void;
      let signal!: AbortSignal;
      mocks.getActiveProvider.mockReturnValueOnce(new Promise((resolve) => {
        resolveProvider = resolve;
      }));
      mocks.extractPdfAttachment.mockImplementation((_file, options) => new Promise((resolve) => {
        finish = resolve;
        signal = options.signal;
      }));
      const sending = useChat.getState().send('send now');
      const adding = useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'late.pdf')]);
      await vi.waitFor(() => expect(signal).toBeDefined());

      resolveProvider(provider);
      await expect(sending).resolves.toBe(true);
      const wasAborted = signal.aborted;
      finish({ ok: false, reason: 'cancelled' });
      await adding;

      expect(wasAborted).toBe(true);
      expect(useChat.getState().pendingAttachments).toEqual([]);
    });

    it('does not send a ready PDF removed during send preflight', async () => {
      mocks.extractPdfAttachment.mockResolvedValue({
        ok: true,
        value: { text: 'removed private text', pageCount: 1, extractedChars: 20, truncated: false },
      });
      await useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'removed.pdf')]);
      const id = useChat.getState().pendingAttachments[0].id;
      let resolveProvider!: (value: typeof provider) => void;
      mocks.getActiveProvider.mockReturnValueOnce(new Promise((resolve) => {
        resolveProvider = resolve;
      }));
      const sending = useChat.getState().send('continue without removed file');

      useChat.getState().removeAttachment(id);
      resolveProvider(provider);

      await expect(sending).resolves.toBe(true);
      const startRun = lastStartRunCall();
      expect(startRun.agentUserContent).toBe('continue without removed file');
      const userMessage = useChat.getState().messages.find((message) => message.role === 'user')!;
      expect(userMessage.attachments).toBeUndefined();
    });

    it('does not send a ready PDF disposed during send preflight', async () => {
      mocks.extractPdfAttachment.mockResolvedValue({
        ok: true,
        value: { text: 'disposed private text', pageCount: 1, extractedChars: 21, truncated: false },
      });
      await useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'disposed.pdf')]);
      let resolveProvider!: (value: typeof provider) => void;
      mocks.getActiveProvider.mockReturnValueOnce(new Promise((resolve) => {
        resolveProvider = resolve;
      }));
      const sending = useChat.getState().send('continue after disposal');

      useChat.getState().disposeAttachments();
      resolveProvider(provider);

      await expect(sending).resolves.toBe(true);
      const startRun = lastStartRunCall();
      expect(startRun.agentUserContent).toBe('continue after disposal');
      const userMessage = useChat.getState().messages.find((message) => message.role === 'user')!;
      expect(userMessage.attachments).toBeUndefined();
    });
  });
});
