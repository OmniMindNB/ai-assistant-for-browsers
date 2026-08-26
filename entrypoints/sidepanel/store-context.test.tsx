import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  createBrowserAgent: vi.fn(),
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

vi.mock('@/lib/messaging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/messaging')>()),
  sendMessage: mocks.sendMessage,
}));

vi.mock('@/lib/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/settings')>()),
  ensureDevProvider: vi.fn(),
  getActiveProvider: mocks.getActiveProvider,
}));

vi.mock('@/lib/agent/agent', () => ({
  createBrowserAgent: mocks.createBrowserAgent,
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

let agentEventListener: ((event: any) => void) | undefined;

function makeAgent() {
  return {
    subscribe: vi.fn((listener) => { agentEventListener = listener; return () => undefined; }),
    abort: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    state: {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          stopReason: 'stop',
        },
      ],
    },
  };
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
    mocks.createBrowserAgent.mockReset();
    mocks.getActiveProvider.mockReset().mockResolvedValue(provider);
    mocks.replaceConversationMessages.mockReset().mockResolvedValue(undefined);
    mocks.getConversationMessages.mockReset().mockResolvedValue([]);
    mocks.deleteConversation.mockReset().mockResolvedValue(undefined);
    mocks.listConversations.mockReset().mockResolvedValue([]);
    mocks.extractPdfAttachment.mockReset().mockResolvedValue({ ok: false, reason: 'parse-failed' });
    mocks.createBrowserAgent.mockReturnValue(makeAgent());
    agentEventListener = undefined;
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({});
    useChat.setState({
      messages: [],
      input: '',
      busy: false,
      error: null,
      providers: [],
      selectedProviderId: null,
      selectedModel: '',
    });
  });

  // clear() cancels any module-level slow-activity timers (real setTimeouts) and resets
  // activitySteps. Without this, a real timer armed by one test (e.g. via
  // tool_execution_start, which schedules a 6s slow-escalation timer) can outlive that
  // test and fire during a later, unrelated test — mutating the shared store singleton out
  // from under it. Runs after every test, not just timer-related ones, since any test could
  // leave a pending running step behind.
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

  it('keeps a newly opened conversation and its record untouched when a previous agent settles late', async () => {
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML',
        'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT',
        'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    useChat.setState({ conversationId: 'completed-run', messages: [] });

    const running = useChat.getState().send('Message for A');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalledOnce());

    mocks.getConversationMessages.mockResolvedValueOnce([{ role: 'user', content: 'Message for B', createdAt: 1 }]);
    await expect(useChat.getState().openConversation('B')).resolves.toBe(true);
    agentEventListener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late A text' } });
    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'late-tool', toolName: 'browser_click' });
    resolvePrompt();
    await running;

    expect(useChat.getState()).toMatchObject({
      conversationId: 'B',
      messages: [{ role: 'user', content: 'Message for B' }],
      activitySteps: [],
      busy: false,
    });
    expect(mocks.replaceConversationMessages).not.toHaveBeenCalledWith('B', expect.anything(), expect.anything());
  });

  it('aborts a run started while opening B waits for storage before B becomes current', async () => {
    let resolveOpen!: (value: any[]) => void;
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
        'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
        'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    useChat.setState({ conversationId: 'persistence-window', messages: [] });
    mocks.getConversationMessages.mockReturnValueOnce(new Promise((resolve) => { resolveOpen = resolve; }));

    const opening = useChat.getState().openConversation('B');
    const running = useChat.getState().send('Gap run for A');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalledOnce());
    resolveOpen([{ role: 'user', content: 'Message for B', createdAt: 1 }]);
    await expect(opening).resolves.toBe(true);
    expect(agent.abort).toHaveBeenCalledOnce();
    agentEventListener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late gap text' } });
    resolvePrompt();
    await running;

    expect(useChat.getState()).toMatchObject({ conversationId: 'B', messages: [{ content: 'Message for B' }], busy: false });
    expect(mocks.replaceConversationMessages).not.toHaveBeenCalledWith('B', expect.anything(), expect.anything());
  });

  it('does not resurrect A when deletion waits while a new A run starts', async () => {
    let resolveDelete!: () => void;
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.deleteConversation.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
        'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
        'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    useChat.setState({ conversationId: 'A', messages: [] });

    const removing = useChat.getState().removeConversation('A');
    const running = useChat.getState().send('Gap run for deleted A');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalledOnce());
    resolveDelete();
    await removing;
    expect(agent.abort).toHaveBeenCalledOnce();
    resolvePrompt();
    await running;

    expect(useChat.getState().conversationId).not.toBe('A');
    expect(useChat.getState().messages).toEqual([]);
    expect(mocks.replaceConversationMessages).not.toHaveBeenCalledWith('A', expect.anything(), expect.anything());
  });

  it('clears completed-run registration so later navigation neither aborts nor persists it again', async () => {
    const agent = makeAgent();
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
        'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
        'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    useChat.setState({ conversationId: 'completed-run', messages: [] });

    await useChat.getState().send('Completed A');
    expect(mocks.replaceConversationMessages).toHaveBeenCalledTimes(1);
    mocks.getConversationMessages.mockResolvedValueOnce([{ role: 'user', content: 'B', createdAt: 1 }]);
    await useChat.getState().openConversation('B');
    useChat.getState().clear();

    expect(agent.abort).not.toHaveBeenCalled();
    expect(mocks.replaceConversationMessages).toHaveBeenCalledTimes(1);
  });

  it('settles a completed run before its deferred persistence can be interrupted by navigation', async () => {
    let resolveSave!: () => void;
    const agent = makeAgent();
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.replaceConversationMessages.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'persistence-window', messages: [] });

    const send = useChat.getState().send('Completed A');
    await vi.waitFor(() => expect(mocks.replaceConversationMessages).toHaveBeenCalledOnce());
    mocks.getConversationMessages.mockResolvedValueOnce([{ role: 'user', content: 'B', createdAt: 1 }]);
    await useChat.getState().openConversation('B');
    useChat.getState().clear();
    resolveSave();
    await send;

    expect(agent.abort).not.toHaveBeenCalled();
    expect(mocks.replaceConversationMessages).toHaveBeenCalledOnce();
    expect(useChat.getState()).toMatchObject({ messages: [], busy: false, pendingConfirmation: null });
  });

  it('evicts B if deleting non-active B completes after B becomes active and starts a run', async () => {
    let resolveDelete!: () => void;
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.deleteConversation.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
        'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
        'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    useChat.setState({ conversationId: 'A', messages: [] });
    const deleting = useChat.getState().removeConversation('B');
    mocks.getConversationMessages.mockResolvedValueOnce([{ role: 'user', content: 'B history', createdAt: 1 }]);
    await useChat.getState().openConversation('B');
    const running = useChat.getState().send('B run');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalledOnce());
    resolveDelete();
    await deleting;
    expect(agent.abort).toHaveBeenCalledOnce();
    resolvePrompt();
    await running;

    expect(useChat.getState().conversationId).not.toBe('B');
    expect(useChat.getState().messages).toEqual([]);
    expect(mocks.replaceConversationMessages).not.toHaveBeenCalledWith('B', expect.anything(), expect.anything());
  });

  it('does not enqueue a B snapshot after deletion intent while B finishes before deletion commits', async () => {
    let resolveDelete!: () => void;
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.deleteConversation.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: ['GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE'] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    useChat.setState({ conversationId: 'A', messages: [] });
    const deleting = useChat.getState().removeConversation('B');
    mocks.getConversationMessages.mockResolvedValueOnce([{ role: 'user', content: 'B history', createdAt: 1 }]);
    await useChat.getState().openConversation('B');
    const running = useChat.getState().send('B finishes before delete');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalledOnce());
    resolvePrompt();
    await running;
    expect(mocks.replaceConversationMessages).not.toHaveBeenCalledWith('B', expect.anything(), expect.anything());
    resolveDelete();
    await deleting;
    expect(mocks.deleteConversation).toHaveBeenCalledWith('B');
    expect(useChat.getState().conversationId).not.toBe('B');
  });

  it('serializes a real completed snapshot before the authoritative delete and blocks a later snapshot', async () => {
    let resolveSave!: () => void;
    const operations: string[] = [];
    const id = 'ordered-delete';
    mocks.replaceConversationMessages.mockImplementationOnce(() => new Promise<void>((resolve) => {
      operations.push('save');
      resolveSave = () => { operations.push('save-complete'); resolve(); };
    }));
    mocks.deleteConversation.mockImplementationOnce(async () => { operations.push('delete'); });
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: id, messages: [] });
    const first = useChat.getState().send('persist before delete');
    await vi.waitFor(() => expect(mocks.replaceConversationMessages).toHaveBeenCalledOnce());
    const deleting = useChat.getState().removeConversation(id);
    expect(mocks.deleteConversation).not.toHaveBeenCalled();
    resolveSave();
    await first;
    await deleting;
    expect(operations).toEqual(['save', 'save-complete', 'delete']);

    useChat.setState({ conversationId: id, messages: [] });
    await useChat.getState().send('late snapshot');
    expect(mocks.replaceConversationMessages).toHaveBeenCalledOnce();
  });

  it('keeps a successful first delete tombstone when a newer same-id delete fails', async () => {
    let resolveFirstDelete!: () => void;
    const id = 'concurrent-delete';
    mocks.deleteConversation
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirstDelete = resolve; }))
      .mockRejectedValueOnce(new Error('second delete failed'));
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'A', messages: [] });

    const first = useChat.getState().removeConversation(id);
    const second = useChat.getState().removeConversation(id);
    await vi.waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledOnce());
    resolveFirstDelete();
    await Promise.all([first, second]);

    useChat.setState({ conversationId: id, messages: [] });
    await useChat.getState().send('late snapshot after delete failure');
    expect(mocks.replaceConversationMessages).not.toHaveBeenCalledWith(id, expect.anything(), expect.anything());
    expect(mocks.deleteConversation).toHaveBeenCalledTimes(2);
  });

  it('allows legitimate persistence after a lone failed delete clears its pending generation', async () => {
    const id = 'failed-delete-recovery';
    mocks.deleteConversation.mockRejectedValueOnce(new Error('delete failed'));
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'A', messages: [] });
    await useChat.getState().removeConversation(id);
    useChat.setState({ conversationId: id, messages: [] });
    await useChat.getState().send('persist after failed delete');
    expect(mocks.replaceConversationMessages).toHaveBeenCalledWith(id, expect.anything(), expect.anything());
  });

  it('keeps newer pending deletion active when an older delete fails, then recovers after the newer failure', async () => {
    let rejectFirst!: (error: Error) => void;
    let rejectSecond!: (error: Error) => void;
    const id = 'overlapping-failed-deletes';
    mocks.deleteConversation
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSecond = reject; }));
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'A', messages: [] });
    const first = useChat.getState().removeConversation(id);
    const second = useChat.getState().removeConversation(id);
    await vi.waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledOnce());
    rejectFirst(new Error('first failed'));
    await vi.waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledTimes(2));
    useChat.setState({ conversationId: id, messages: [] });
    await useChat.getState().send('blocked by second pending delete');
    expect(mocks.replaceConversationMessages).not.toHaveBeenCalledWith(id, expect.anything(), expect.anything());
    rejectSecond(new Error('second failed'));
    await Promise.all([first, second]);
    await useChat.getState().send('allowed after both failures');
    expect(mocks.replaceConversationMessages).toHaveBeenCalledWith(id, expect.anything(), expect.anything());
  });

  it('does not block C persistence while B deletion is pending', async () => {
    let resolveDelete!: () => void;
    mocks.deleteConversation.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'A', messages: [] });
    const deleting = useChat.getState().removeConversation('isolated-B');
    await vi.waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledOnce());
    useChat.setState({ conversationId: 'isolated-C', messages: [] });
    await useChat.getState().send('C remains writable');
    expect(mocks.replaceConversationMessages).toHaveBeenCalledWith('isolated-C', expect.anything(), expect.anything());
    resolveDelete();
    await deleting;
  });

  it('allows C persistence after B deletion fails without poisoning another conversation lane', async () => {
    mocks.deleteConversation.mockRejectedValueOnce(new Error('B deletion failed'));
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    useChat.setState({ conversationId: 'A', messages: [] });
    await useChat.getState().removeConversation('failed-B');
    expect(useChat.getState().error).toBeNull();

    useChat.setState({ conversationId: 'recovered-C', messages: [] });
    await useChat.getState().send('C writes after B failure');
    expect(mocks.replaceConversationMessages).toHaveBeenCalledWith('recovered-C', expect.anything(), expect.anything());
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

    expect(mocks.createBrowserAgent).not.toHaveBeenCalled();
    expect(useChat.getState()).toMatchObject({ conversationId: replacementId, messages: [], busy: false });
  });

  it.each(['clear', 'delete'] as const)('keeps the replacement conversation untouched when an agent settles after %s', async (action) => {
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML',
        'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT',
        'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    useChat.setState({ conversationId: 'A', messages: [] });
    const running = useChat.getState().send('Message for A');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalledOnce());

    if (action === 'clear') useChat.getState().clear();
    else await useChat.getState().removeConversation('A');
    const replacementId = useChat.getState().conversationId;
    agentEventListener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late A text' } });
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'late-tool', toolName: 'browser_click', isError: false, result: 'late' });
    resolvePrompt();
    await running;

    expect(useChat.getState()).toMatchObject({ conversationId: replacementId, messages: [], activitySteps: [], busy: false });
    expect(mocks.replaceConversationMessages).not.toHaveBeenCalledWith(replacementId, expect.anything(), expect.anything());
    if (action === 'delete') expect(mocks.replaceConversationMessages).not.toHaveBeenCalledWith('A', expect.anything(), expect.anything());
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

  it('creates an agent without browser tools when a normal send requests it', async () => {
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'GET_ACTIVE_TAB') {
        return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      }
      if (type === 'PING') {
        return Promise.resolve({
          ok: true,
          data: {
            supportedTypes: [
              'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML',
              'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT',
              'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    await useChat.getState().send('hello', { withoutBrowserTools: true });

    expect(mocks.createBrowserAgent).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
    // 该轮明确不读取当前页面，因此不能把页面标题/地址注入系统提示词。
    const { systemPrompt } = mocks.createBrowserAgent.mock.calls[0][0];
    expect(systemPrompt).not.toContain('https://example.com/');
    expect(systemPrompt).not.toContain('id=7');
  });

  it('injects the pinned tab and current time into the system prompt on a normal send', async () => {
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'GET_ACTIVE_TAB') {
        return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      }
      if (type === 'PING') {
        return Promise.resolve({
          ok: true,
          data: {
            supportedTypes: [
              'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML',
              'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT',
              'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    await useChat.getState().send('hello');

    const { systemPrompt } = mocks.createBrowserAgent.mock.calls[0][0];
    expect(systemPrompt).toContain('<runtime_context>');
    expect(systemPrompt).toContain('id=7');
    expect(systemPrompt).toContain('title: "Example"');
    expect(systemPrompt).toContain('url: "https://example.com/"');
    expect(systemPrompt).toMatch(/当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 星期./);
  });

  it('marks a rejected confirmation as a failed activity and ignores a late error event for it', async () => {
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
        'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
        'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    const send = useChat.getState().send('write');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());
    const confirm = mocks.createBrowserAgent.mock.calls[0][0].onConfirm as (id: string, name: string, args: unknown, reason: string) => Promise<boolean>;
    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_click', args: { selector: 'button.buy' } });
    const decision = confirm('call-1', 'browser_click', { selector: 'button.buy' }, 'confirm');
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'running' }]);
    expect(useChat.getState().activitySteps[0]?.description).toContain('button.buy');
    useChat.getState().respondToConfirmation(false);
    await expect(decision).resolves.toBe(false);
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'failed' }]);
    expect(useChat.getState().activitySteps[0]?.description).toContain('button.buy');
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: true, result: 'late error' });
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'failed' }]);
    expect(useChat.getState().activitySteps[0]?.description).toContain('button.buy');
    resolvePrompt();
    await send;
  });

  it('projects an ask_user question to pendingQuestion and resolves it with the user answer', async () => {
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
        'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
        'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    const send = useChat.getState().send('which account should I use');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());
    const onAskUser = mocks.createBrowserAgent.mock.calls[0][0].onAskUser as (
      toolCallId: string,
      question: string,
      signal?: AbortSignal,
    ) => Promise<string>;

    expect(useChat.getState().pendingQuestion).toBeNull();
    const pending = onAskUser('call-ask-1', '用哪个账号登录？');
    await vi.waitFor(() => expect(useChat.getState().pendingQuestion).toEqual({
      toolCallId: 'call-ask-1',
      question: '用哪个账号登录？',
    }));

    useChat.getState().respondToQuestion('用工作账号');
    await expect(pending).resolves.toBe('用工作账号');
    expect(useChat.getState().pendingQuestion).toBeNull();

    resolvePrompt();
    await send;
  });

  it('resolves a pending ask_user question when the run is stopped, instead of leaving it hanging', async () => {
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
        'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
        'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    const send = useChat.getState().send('which account should I use');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());
    const onAskUser = mocks.createBrowserAgent.mock.calls[0][0].onAskUser as (
      toolCallId: string,
      question: string,
      signal?: AbortSignal,
    ) => Promise<string>;

    const pending = onAskUser('call-ask-2', '用哪个账号登录？');
    await vi.waitFor(() => expect(useChat.getState().pendingQuestion).not.toBeNull());

    useChat.getState().stop();
    await expect(pending).resolves.toBe('');
    expect(useChat.getState().pendingQuestion).toBeNull();

    resolvePrompt();
    await send;
  });

  it('logs a failed tool call to the console without exposing the raw result in the activity description', async () => {
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
        'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
        'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = useChat.getState().send('read the page');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());
    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_read_page', args: {} });
    agentEventListener?.({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'browser_read_page',
      isError: true,
      result: 'Could not establish connection. Receiving end does not exist.',
    });
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'failed' }]);
    expect(useChat.getState().activitySteps[0]?.description).not.toContain('Could not establish connection');
    expect(consoleError).toHaveBeenCalledWith(
      '[Runi] tool execution failed',
      'browser_read_page',
      'Could not establish connection. Receiving end does not exist.',
    );
    consoleError.mockRestore();
    resolvePrompt();
    await send;
  });

  it('clears activity steps on stop and ignores late events for the stopped call', async () => {
    let rejectAbort!: (reason: Error) => void;
    const agent = makeAgent();
    agent.abort.mockImplementation(() => rejectAbort(new Error('aborted')));
    agent.prompt.mockImplementation(() => new Promise<never>((_resolve, reject) => { rejectAbort = reject; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: ['GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE'] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    const send = useChat.getState().send('write');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());
    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'running', toolName: 'browser_click', args: { selector: 'button' } });
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'running', status: 'running' }]);
    useChat.getState().stop();
    expect(agent.abort).toHaveBeenCalledOnce();
    expect(useChat.getState().activitySteps).toEqual([]);
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'running', toolName: 'browser_click', isError: false, result: 'late' });
    expect(useChat.getState().activitySteps).toEqual([]);
    await send;
  });

  it('accumulates completed and failed steps in the activity log instead of overwriting them', async () => {
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: ['GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE'] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    const send = useChat.getState().send('write');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());

    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_click', args: { selector: 'a' } });
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: true, result: 'boom' });
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'failed' }]);

    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'browser_click', args: { selector: 'b' } });
    expect(useChat.getState().activitySteps).toMatchObject([
      { id: 'call-1', status: 'failed' },
      { id: 'call-2', status: 'running' },
    ]);

    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'browser_click', isError: false, result: 'ok' });
    expect(useChat.getState().activitySteps).toMatchObject([
      { id: 'call-1', status: 'failed' },
      { id: 'call-2', status: 'done' },
    ]);

    resolvePrompt();
    await send;
    expect(useChat.getState().activitySteps).toEqual([]);
  });

  it('marks a running step slow after 6s and clears the timer once it ends', async () => {
    vi.useFakeTimers();
    try {
      let resolvePrompt!: () => void;
      const agent = makeAgent();
      agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
      mocks.createBrowserAgent.mockReturnValue(agent);
      mocks.sendMessage.mockImplementation((type: string) => {
        if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: ['GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE'] } });
        return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      });
      const send = useChat.getState().send('write');
      await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());

      agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_click', args: { selector: 'a' } });
      expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'running' }]);
      expect(useChat.getState().activitySteps[0]?.slow).toBeFalsy();

      await vi.advanceTimersByTimeAsync(6000);
      expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'running', slow: true }]);

      agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: false, result: 'ok' });
      expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'done', slow: false }]);

      resolvePrompt();
      await send;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not mark a step slow if it finishes before the 6s threshold', async () => {
    vi.useFakeTimers();
    try {
      let resolvePrompt!: () => void;
      const agent = makeAgent();
      agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
      mocks.createBrowserAgent.mockReturnValue(agent);
      mocks.sendMessage.mockImplementation((type: string) => {
        if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: ['GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE'] } });
        return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      });
      const send = useChat.getState().send('write');
      await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());

      agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_click', args: { selector: 'a' } });
      agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: false, result: 'ok' });
      await vi.advanceTimersByTimeAsync(6000);
      expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'done', slow: false }]);

      resolvePrompt();
      await send;
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the slow flag when a tool_execution_update arrives for an already-slow step', async () => {
    vi.useFakeTimers();
    try {
      let resolvePrompt!: () => void;
      const agent = makeAgent();
      agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
      mocks.createBrowserAgent.mockReturnValue(agent);
      mocks.sendMessage.mockImplementation((type: string) => {
        if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: ['GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE'] } });
        return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      });
      const send = useChat.getState().send('write');
      await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());

      agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_click', args: { selector: 'a' } });
      await vi.advanceTimersByTimeAsync(6000);
      expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'running', slow: true }]);

      agentEventListener?.({ type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'browser_click', args: { selector: 'a' } });
      expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'running', slow: true }]);

      agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: false, result: 'ok' });
      resolvePrompt();
      await send;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports that a normal send did not start for empty input or a busy store', async () => {
    await expect(useChat.getState().send('   ', { withoutBrowserTools: true })).resolves.toBe(false);
    expect(mocks.createBrowserAgent).not.toHaveBeenCalled();

    useChat.setState({ input: 'Hello', busy: true });
    await expect(useChat.getState().send(undefined, { withoutBrowserTools: true })).resolves.toBe(false);
    expect(mocks.createBrowserAgent).not.toHaveBeenCalled();
  });

  describe('restoreTabConversation pending ask', () => {
    beforeEach(() => {
      (globalThis as any).browser.tabs = { query: vi.fn().mockResolvedValue([{ id: 42 }]) };
      (globalThis as any).browser.storage.session = {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      useChat.setState({ input: '', quotedSelection: null, pendingFocusToken: 0 });
    });

    it('sets quotedSelection and bumps the focus token when a pending ask exists for this tab, without touching input', async () => {
      const key = 'runi:tab-pending-ask:42';
      (globalThis as any).browser.storage.session.get = vi.fn().mockResolvedValue({ [key]: 'selected text' });

      await useChat.getState().restoreTabConversation();

      expect(useChat.getState().quotedSelection).toBe('selected text');
      expect(useChat.getState().input).toBe('');
      expect(useChat.getState().pendingFocusToken).toBeGreaterThan(0);
      expect((globalThis as any).browser.storage.session.remove).toHaveBeenCalledWith(key);
    });

    it('leaves the composer untouched when there is no pending ask for this tab', async () => {
      await useChat.getState().restoreTabConversation();

      expect(useChat.getState().input).toBe('');
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
    beforeEach(() => {
      mocks.createBrowserAgent.mockReturnValue(makeAgent());
      mocks.sendMessage.mockImplementation((type: string) => {
        if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
          'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
          'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
          'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
        ] } });
        return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      });
      useChat.setState({ input: '', quotedSelection: null });
    });

    it('sends the quote-formatted template plus the question to the agent, but stores only the question as the displayed message', async () => {
      useChat.setState({ quotedSelection: 'the selected text' });

      await useChat.getState().send('what does this mean?');

      const agent = mocks.createBrowserAgent.mock.results[0].value;
      expect(agent.prompt).toHaveBeenCalledWith(expect.stringContaining('the selected text'));
      expect(agent.prompt).toHaveBeenCalledWith(expect.stringContaining('what does this mean?'));

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

      const agent = mocks.createBrowserAgent.mock.results[0].value;
      expect(agent.prompt).toHaveBeenCalledWith('a plain question');

      const userMessage = useChat.getState().messages.find((m) => m.role === 'user')!;
      expect(userMessage.quotedText).toBeUndefined();
    });

    it('clearQuotedSelection clears the pending quote without sending anything', () => {
      useChat.setState({ quotedSelection: 'the selected text' });

      useChat.getState().clearQuotedSelection();

      expect(useChat.getState().quotedSelection).toBeNull();
      expect(mocks.createBrowserAgent).not.toHaveBeenCalled();
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

    expect(mocks.createBrowserAgent).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('does not submit a message edit while an attachment is parsing', async () => {
    const message = { id: 'editable', role: 'user' as const, content: 'old', createdAt: 1, kind: 'input' as const };
    useChat.setState({
      messages: [message],
      pendingAttachments: [parsingPdfAttachment()],
    });

    await expect(useChat.getState().editMessage(message.id, 'new')).resolves.toBe(false);

    expect(mocks.createBrowserAgent).not.toHaveBeenCalled();
    expect(mocks.getActiveProvider).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(useChat.getState().messages).toEqual([message]);
  });

  describe('attachment composition on send', () => {
    beforeEach(() => {
      mocks.createBrowserAgent.mockReturnValue(makeAgent());
      mocks.sendMessage.mockImplementation((type: string) => {
        if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
          'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
          'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
          'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
        ] } });
        return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      });
      useChat.setState({ input: '', pendingAttachments: [] });
    });

    it('folds a text attachment into the prompt text, clears pendingAttachments, and stores it on the message', async () => {
      await useChat.getState().addAttachmentFiles([new File(['secret notes'], 'notes.txt', { type: 'text/plain' })]);

      await useChat.getState().send('summarize this');

      const agent = mocks.createBrowserAgent.mock.results[0].value;
      expect(agent.prompt).toHaveBeenCalledWith(expect.stringContaining('secret notes'));
      expect(agent.prompt).toHaveBeenCalledWith(expect.stringContaining('summarize this'));
      expect(useChat.getState().pendingAttachments).toHaveLength(0);

      const userMessage = useChat.getState().messages.find((m) => m.role === 'user')!;
      expect(userMessage.content).toBe('summarize this');
      expect(userMessage.attachments).toHaveLength(1);
      expect(userMessage.attachments![0].name).toBe('notes.txt');
    });

    it('passes an image attachment to agent.prompt as the second argument', async () => {
      await useChat.getState().addAttachmentFiles([
        new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }),
      ]);

      await useChat.getState().send('what is this?');

      const agent = mocks.createBrowserAgent.mock.results[0].value;
      expect(agent.prompt).toHaveBeenCalledWith(
        expect.any(String),
        [expect.objectContaining({ type: 'image', mimeType: 'image/png' })],
      );
    });

    it('sends PDF text once but keeps only metadata on the displayed and persisted message', async () => {
      mocks.extractPdfAttachment.mockResolvedValue({
        ok: true,
        value: { text: 'private PDF text', pageCount: 2, extractedChars: 16, truncated: false },
      });
      await useChat.getState().addAttachmentFiles([
        new File(['%PDF-x'], 'a.pdf', { type: 'application/pdf' }),
      ]);

      await useChat.getState().send('summarize');

      const agent = mocks.createBrowserAgent.mock.results[0].value;
      expect(agent.prompt.mock.calls[0][0]).toContain('private PDF text');
      const userMessage = useChat.getState().messages.find((message) => message.role === 'user')!;
      expect(userMessage.attachments?.[0]).toMatchObject({ kind: 'pdf', pageCount: 2 });
      expect(JSON.stringify(userMessage)).not.toContain('private PDF text');
      expect(JSON.stringify(mocks.replaceConversationMessages.mock.calls)).not.toContain('private PDF text');
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

      await expect(useChat.getState().send()).resolves.toBe(false);
    });

    it('uses the localized default prompt for attachment-only send', async () => {
      mocks.extractPdfAttachment.mockResolvedValue({
        ok: true,
        value: { text: 'pdf text', pageCount: 1, extractedChars: 8, truncated: false },
      });
      await useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf')]);

      await expect(useChat.getState().send()).resolves.toBe(true);

      const agent = mocks.createBrowserAgent.mock.results[0].value;
      expect(agent.prompt.mock.calls[0][0]).toContain('Analyze the attached file.');
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

    it('does not send or persist a ready PDF removed during send preflight', async () => {
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
      const agent = mocks.createBrowserAgent.mock.results[0].value;
      expect(agent.prompt).toHaveBeenCalledWith('continue without removed file');
      const userMessage = useChat.getState().messages.find((message) => message.role === 'user')!;
      expect(userMessage.attachments).toBeUndefined();
      expect(JSON.stringify(mocks.replaceConversationMessages.mock.calls)).not.toContain('removed private text');
    });

    it('does not send or persist a ready PDF disposed during send preflight', async () => {
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
      const agent = mocks.createBrowserAgent.mock.results[0].value;
      expect(agent.prompt).toHaveBeenCalledWith('continue after disposal');
      const userMessage = useChat.getState().messages.find((message) => message.role === 'user')!;
      expect(userMessage.attachments).toBeUndefined();
      expect(JSON.stringify(mocks.replaceConversationMessages.mock.calls)).not.toContain('disposed private text');
    });
  });
});
