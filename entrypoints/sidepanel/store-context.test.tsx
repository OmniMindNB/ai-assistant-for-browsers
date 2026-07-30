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
});
