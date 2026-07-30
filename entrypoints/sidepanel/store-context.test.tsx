import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  createBrowserAgent: vi.fn(),
  getActiveProvider: vi.fn(),
  replaceConversationMessages: vi.fn(),
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
}));

import { useChat } from './store';

const provider = {
  id: 'test-provider',
  name: 'Test provider',
  baseURL: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

function makeAgent() {
  return {
    subscribe: vi.fn(() => () => undefined),
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
    mocks.createBrowserAgent.mockReturnValue(makeAgent());
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
      workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState().workbenchPreferences).toEqual({
      defaultMode: 'agent',
      attachPageByDefault: false,
    });
  });

  it('preserves an existing chat error when workbench preferences load successfully', async () => {
    useChat.setState({ error: 'The provider request failed.' });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'The provider request failed.',
      workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: false },
    });
  });

  it('preserves an existing chat error when workbench preference loading fails', async () => {
    useChat.setState({
      error: 'The agent request failed.',
      workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: false },
    });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { defaultMode: 'invalid', attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'The agent request failed.',
      workbenchPreferences: { defaultMode: 'ask', attachPageByDefault: true },
    });
  });

  it('restores safe defaults and publishes invalid preference errors when no chat error exists', async () => {
    useChat.setState({ workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: false } });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { defaultMode: 'invalid', attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'Invalid workbench preferences',
      workbenchPreferences: { defaultMode: 'ask', attachPageByDefault: true },
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
              'RESET_TURN_SNAPSHOT', 'REVERT_CHANGES',
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    await useChat.getState().send('hello', { withoutBrowserTools: true });

    expect(mocks.createBrowserAgent).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
  });

  it('reports that a normal send did not start for empty input or a busy store', async () => {
    await expect(useChat.getState().send('   ', { withoutBrowserTools: true })).resolves.toBe(false);
    expect(mocks.createBrowserAgent).not.toHaveBeenCalled();

    useChat.setState({ input: 'Hello', busy: true });
    await expect(useChat.getState().send(undefined, { withoutBrowserTools: true })).resolves.toBe(false);
    expect(mocks.createBrowserAgent).not.toHaveBeenCalled();
  });
});
