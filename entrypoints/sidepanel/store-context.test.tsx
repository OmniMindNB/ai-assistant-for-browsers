import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  createBrowserAgent: vi.fn(),
  getActiveProvider: vi.fn(),
  replaceConversationMessages: vi.fn(),
  getConversationMessages: vi.fn(),
  deleteConversation: vi.fn(),
  listConversations: vi.fn(),
}));

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

describe('chat store page context', () => {
  beforeEach(() => {
    mocks.sendMessage.mockReset();
    mocks.createBrowserAgent.mockReset();
    mocks.getActiveProvider.mockReset().mockResolvedValue(provider);
    mocks.replaceConversationMessages.mockReset().mockResolvedValue(undefined);
    mocks.getConversationMessages.mockReset().mockResolvedValue([]);
    mocks.deleteConversation.mockReset().mockResolvedValue(undefined);
    mocks.listConversations.mockReset().mockResolvedValue([]);
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

  it('loads workbench preferences into store state', async () => {
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState().workbenchPreferences).toEqual({
      attachPageByDefault: false,
    });
  });

  it('keeps the newest provider and preference refresh when older reads resolve or reject late', async () => {
    let resolveOld!: (value: Record<string, unknown>) => void;
    let resolveNew!: (value: Record<string, unknown>) => void;
    const old = new Promise<Record<string, unknown>>((resolve) => { resolveOld = resolve; });
    const newest = new Promise<Record<string, unknown>>((resolve) => { resolveNew = resolve; });
    (globalThis as any).browser.storage.local.get = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(newest)
      .mockResolvedValue({ workbenchPreferences: { attachPageByDefault: true } });
    const first = useChat.getState().refreshProvider();
    const second = useChat.getState().refreshProvider();
    resolveNew({ 'aluminum:settings': { activeProviderId: 'new', providers: [{ ...provider, id: 'new', model: 'new-model' }] } });
    await second;
    resolveOld({ 'aluminum:settings': { activeProviderId: 'old', providers: [{ ...provider, id: 'old', model: 'old-model' }] } });
    await first;
    expect(useChat.getState().selectedProviderId).toBe('new');

    const oldPrefs = Promise.reject(new Error('old failure'));
    const newPrefs = Promise.resolve({ workbenchPreferences: { attachPageByDefault: false } });
    (globalThis as any).browser.storage.local.get = vi.fn().mockReturnValueOnce(oldPrefs).mockReturnValueOnce(newPrefs);
    await Promise.all([useChat.getState().refreshWorkbenchPreferences(), useChat.getState().refreshWorkbenchPreferences()]);
    expect(useChat.getState().workbenchPreferences).toEqual({ attachPageByDefault: false });
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
      toolActivities: [],
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

    expect(useChat.getState()).toMatchObject({ conversationId: replacementId, messages: [], toolActivities: [], busy: false });
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

  it('preserves an existing chat error when workbench preferences load successfully', async () => {
    useChat.setState({ error: 'The provider request failed.' });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'The provider request failed.',
      workbenchPreferences: { attachPageByDefault: false },
    });
  });

  it('preserves an existing chat error when workbench preference loading fails', async () => {
    useChat.setState({
      error: 'The agent request failed.',
      workbenchPreferences: { attachPageByDefault: false },
    });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { attachPageByDefault: 'not-a-boolean' },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'The agent request failed.',
      workbenchPreferences: { attachPageByDefault: true },
    });
  });

  it('restores safe defaults and publishes invalid preference errors when no chat error exists', async () => {
    useChat.setState({ workbenchPreferences: { attachPageByDefault: false } });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { attachPageByDefault: 'not-a-boolean' },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'Invalid workbench preferences',
      workbenchPreferences: { attachPageByDefault: true },
    });
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

  it('marks a rejected confirmation denied and preserves it against a late error event', async () => {
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
    const decision = confirm('call-1', 'browser_click', {}, 'confirm');
    expect(useChat.getState().toolActivities).toMatchObject([{ id: 'call-1', status: 'confirming' }]);
    useChat.getState().respondToConfirmation(false);
    await expect(decision).resolves.toBe(false);
    expect(useChat.getState().toolActivities).toMatchObject([{ id: 'call-1', status: 'denied' }]);
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: true, result: 'late error' });
    expect(useChat.getState().toolActivities).toMatchObject([{ id: 'call-1', status: 'denied' }]);
    resolvePrompt();
    await send;
  });

  it('logs a failed tool call to the console without exposing the raw result on tool activity state', async () => {
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
    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_read_page' });
    agentEventListener?.({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'browser_read_page',
      isError: true,
      result: 'Could not establish connection. Receiving end does not exist.',
    });
    expect(useChat.getState().toolActivities).toMatchObject([{ id: 'call-1', status: 'error' }]);
    expect(useChat.getState().toolActivities[0]).not.toHaveProperty('detail');
    expect(consoleError).toHaveBeenCalledWith(
      '[Aluminum] tool execution failed',
      'browser_read_page',
      'Could not establish connection. Receiving end does not exist.',
    );
    consoleError.mockRestore();
    resolvePrompt();
    await send;
  });

  it('stops running and confirming agent activities and preserves them against late errors', async () => {
    let rejectAbort!: (reason: Error) => void;
    let releaseConfirmation!: () => void;
    let confirmDecision!: Promise<boolean>;
    const confirmationReady = new Promise<void>((resolve) => { releaseConfirmation = resolve; });
    const agent = makeAgent();
    agent.abort.mockImplementation(() => rejectAbort(new Error('aborted')));
    agent.prompt.mockImplementation(() => Promise.race([
      confirmationReady.then(() => confirmDecision),
      new Promise<never>((_resolve, reject) => { rejectAbort = reject; }),
    ]));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: ['GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE'] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    const send = useChat.getState().send('write');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());
    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'running', toolName: 'browser_click' });
    const confirm = mocks.createBrowserAgent.mock.calls[0][0].onConfirm as (id: string, name: string, args: unknown, reason: string) => Promise<boolean>;
    confirmDecision = confirm('confirming', 'browser_type', {}, 'confirm');
    releaseConfirmation();
    useChat.getState().stop();
    expect(agent.abort).toHaveBeenCalledOnce();
    await expect(confirmDecision).resolves.toBe(false);
    expect(useChat.getState().toolActivities.map((activity) => activity.status)).toEqual(['stopped', 'stopped']);
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'running', toolName: 'browser_click', isError: false, result: 'late' });
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'confirming', toolName: 'browser_type', isError: true, result: 'late' });
    expect(useChat.getState().toolActivities.map((activity) => activity.status)).toEqual(['stopped', 'stopped']);
    await send;
    expect(useChat.getState().pendingConfirmation).toBeNull();
  });

  it('reports that a normal send did not start for empty input or a busy store', async () => {
    await expect(useChat.getState().send('   ', { withoutBrowserTools: true })).resolves.toBe(false);
    expect(mocks.createBrowserAgent).not.toHaveBeenCalled();

    useChat.setState({ input: 'Hello', busy: true });
    await expect(useChat.getState().send(undefined, { withoutBrowserTools: true })).resolves.toBe(false);
    expect(mocks.createBrowserAgent).not.toHaveBeenCalled();
  });
});
