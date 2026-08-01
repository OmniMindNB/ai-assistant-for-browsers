import { useRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '@/lib/db';
import { LocaleProvider } from '@/lib/i18n';
import { en } from '@/lib/i18n/locales/en';
import { zh } from '@/lib/i18n/locales/zh';
import type { ProviderConfig } from '@/lib/settings';
import type { ResolvedShortcutCommand } from '@/lib/workbench/presentation';
import type { PageContextState, ToolActivity } from '../store';
import App from '../App';
import { AgentActivityCard } from './AgentActivityCard';
import { HistoryDrawer } from './HistoryDrawer';
import { WorkbenchEmptyState } from './WorkbenchEmptyState';
import { WorkbenchHeader } from './WorkbenchHeader';
import { WorkbenchComposer, type WorkbenchComposerProps } from './WorkbenchComposer';

const chatStore = {
  messages: [],
  toolActivities: [],
  input: '',
  busy: false,
  error: null,
  pendingConfirmation: null,
  providers: [],
  selectedProviderId: null,
  selectedModel: '',
  conversations: [],
  conversationId: 'active',
  shortcuts: [],
  shortcutErrors: [],
  pageContext: {
    status: 'available' as const,
    tabId: 1,
    title: 'Example article',
    url: 'https://example.com/article',
  } as PageContextState,
  workbenchPreferences: { attachPageByDefault: true },
  setInput: vi.fn(),
  refreshProvider: vi.fn(),
  refreshShortcuts: vi.fn(),
  refreshConversations: vi.fn(),
  refreshPageContext: vi.fn(),
  refreshWorkbenchPreferences: vi.fn(),
  selectProviderAndModel: vi.fn(),
  send: vi.fn(),
  editMessage: vi.fn(),
  runShortcut: vi.fn(),
  stop: vi.fn(),
  clear: vi.fn(),
  openConversation: vi.fn(),
  removeConversation: vi.fn(),
  respondToConfirmation: vi.fn(),
  restoreTabConversation: vi.fn(),
};
let storageChangeListener: ((changes: Record<string, unknown>, areaName: string) => void) | undefined;

vi.mock('../store', () => ({ useChat: () => chatStore }));

const now = new Date(2026, 6, 30, 12, 0, 0);
const records: ConversationRecord[] = [
  {
    id: 'google',
    title: 'Google page summary',
    createdAt: new Date(2026, 6, 30, 8, 0, 0).getTime(),
    updatedAt: new Date(2026, 6, 30, 9, 0, 0).getTime(),
  },
  {
    id: 'shopping',
    title: 'Shopping comparison',
    createdAt: new Date(2026, 6, 29, 8, 0, 0).getTime(),
    updatedAt: new Date(2026, 6, 29, 9, 0, 0).getTime(),
  },
];

function Harness() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <LocaleProvider>
      <WorkbenchHeader
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((open) => !open)}
        onNewChat={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleTheme={vi.fn()}
        historyTriggerRef={triggerRef}
      />
      <HistoryDrawer
        open={historyOpen}
        conversations={records}
        activeConversationId="google"
        now={now}
        onClose={() => setHistoryOpen(false)}
        onNewChat={vi.fn()}
        onPick={vi.fn()}
        onRemove={vi.fn()}
        returnFocusRef={triggerRef}
      />
    </LocaleProvider>
  );
}

function renderDrawer(onRemove = vi.fn()) {
  return render(
    <LocaleProvider>
      <HistoryDrawer
        open
        conversations={records}
        activeConversationId="google"
        now={now}
        onClose={vi.fn()}
        onNewChat={vi.fn()}
        onPick={vi.fn()}
        onRemove={onRemove}
      />
    </LocaleProvider>,
  );
}

function renderDrawerWithBackground() {
  return render(
    <LocaleProvider>
      <button type="button">Background control</button>
      <HistoryDrawer
        open
        conversations={records}
        activeConversationId="google"
        now={now}
        onClose={vi.fn()}
        onNewChat={vi.fn()}
        onPick={vi.fn()}
        onRemove={vi.fn()}
      />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi.fn().mockReturnValue({ addEventListener: vi.fn(), removeEventListener: vi.fn(), matches: false });
  HTMLElement.prototype.scrollTo = vi.fn();
  (globalThis as any).browser.storage.onChanged = {
    addListener: vi.fn((listener) => { storageChangeListener = listener; }),
    removeListener: vi.fn(),
  };
  Object.assign(chatStore, {
    messages: [],
    toolActivities: [],
    input: '',
    busy: false,
    error: null,
    pendingConfirmation: null,
    pageContext: {
      status: 'available' as const,
      tabId: 1,
      title: 'Example article',
      url: 'https://example.com/article',
    },
    workbenchPreferences: { attachPageByDefault: true },
  });
  chatStore.send.mockResolvedValue(true);
  storageChangeListener = undefined;
});

afterEach(() => vi.restoreAllMocks());

const availableContext: PageContextState = {
  status: 'available',
  tabId: 1,
  title: 'Example article',
  url: 'https://example.com/article',
};

const emptyStateShortcuts: ResolvedShortcutCommand[] = Array.from({ length: 5 }, (_, index) => ({
  config: {
    id: `shortcut-${index + 1}`,
    origin: 'custom',
    scope: 'none',
    customized: true,
    name: `Shortcut ${index + 1}`,
    prompt: `Prompt ${index + 1}`,
  },
  resolved: {
    id: `shortcut-${index + 1}`,
    origin: 'custom',
    scope: 'none',
    customized: true,
    name: `Shortcut ${index + 1}`,
    prompt: `Prompt ${index + 1}`,
  },
}));

function activity(status: ToolActivity['status']): ToolActivity {
  return {
    id: `tool-${status}`,
    name: 'browser_read_page',
    status,
  };
}

const activities: ToolActivity[] = [
  { id: 'read', name: 'browser_read_page', status: 'done' },
  { id: 'style', name: 'browser_set_style', status: 'running' },
];

const readingShortcut: ResolvedShortcutCommand = {
  config: {
    id: 'reading',
    origin: 'builtin',
    scope: 'page',
    customized: false,
    name: 'Reading',
    prompt: 'Read the page',
  },
  resolved: {
    id: 'reading',
    origin: 'builtin',
    scope: 'page',
    customized: false,
    name: '阅读页面',
    prompt: 'Read the page',
  },
};

const composerProps: WorkbenchComposerProps = {
  input: '',
  busy: false,
  pageContext: availableContext,
  providers: [],
  selectedProviderId: null,
  selectedModel: '',
  shortcuts: [readingShortcut],
  onInput: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  onRetryPageContext: vi.fn(),
  onRunShortcut: vi.fn(),
  onSelectProviderModel: vi.fn(),
};

const configuredProvider: ProviderConfig = {
  id: 'provider-1',
  name: 'Configured provider',
  baseURL: 'https://example.com/v1',
  apiKey: 'test-key',
  model: 'model-one',
  models: ['model-one', 'model-two'],
};

function ComposerHarness({ initialInput = '', ...props }: Partial<WorkbenchComposerProps> & { initialInput?: string }) {
  const [input, setInput] = useState(initialInput);
  return (
    <LocaleProvider>
      <WorkbenchComposer
        {...composerProps}
        {...props}
        input={input}
        onInput={(value) => {
          setInput(value);
          props.onInput?.(value);
        }}
      />
    </LocaleProvider>
  );
}

describe('workbench composer', () => {
  it('opens slash commands, filters, and runs the selected command', async () => {
    const user = userEvent.setup();
    const onRunShortcut = vi.fn();
    render(<ComposerHarness onRunShortcut={onRunShortcut} />);

    await user.type(screen.getByRole('textbox'), '/阅读');
    expect(screen.getByRole('menu')).toBeVisible();
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onRunShortcut).toHaveBeenCalledWith(readingShortcut.config);
  });

  it('sends on Enter and inserts a newline on Shift+Enter', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ComposerHarness initialInput="hello" onSend={onSend} />);

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledOnce();
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(onSend).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox')).toHaveValue('hello\n');
  });

  it('does not send while composing with an IME', () => {
    const onSend = vi.fn();
    render(<ComposerHarness initialInput="你好" onSend={onSend} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('closes slash commands with Escape without clearing the input', async () => {
    const user = userEvent.setup();
    render(<ComposerHarness />);

    await user.type(screen.getByRole('textbox'), '/阅读');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('/阅读');
  });

  it('does not send a slash query when no command matches', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} />);

    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/missing');
    expect(textbox).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('No matching commands');
    await user.keyboard('{Enter}');

    expect(onSend).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(textbox).toHaveValue('/missing');
  });

  it('does not invoke sending for an empty input', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ComposerHarness initialInput="   " onSend={onSend} />);

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');

    expect(onSend).not.toHaveBeenCalled();
  });

  it('connects the model trigger to its menu and supports keyboard selection', async () => {
    const user = userEvent.setup();
    const onSelectProviderModel = vi.fn();
    render(
      <ComposerHarness
        providers={[configuredProvider]}
        selectedProviderId={configuredProvider.id}
        selectedModel="model-one"
        onSelectProviderModel={onSelectProviderModel}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Select provider and model' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', 'workbench-model-menu');
    expect(screen.getByRole('menu', { name: 'Model selection' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'model-one' })).toHaveFocus());
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onSelectProviderModel).toHaveBeenCalledWith(configuredProvider.id, 'model-two');
  });

  it('anchors the model menu to the full composer width at narrow sidepanel sizes', async () => {
    const user = userEvent.setup();
    render(<ComposerHarness providers={[configuredProvider]} selectedProviderId={configuredProvider.id} selectedModel="model-one" />);
    await user.click(screen.getByRole('button', { name: 'Select provider and model' }));
    expect(screen.getByRole('menu', { name: 'Model selection' })).toHaveClass('left-3', 'right-3', 'w-auto', 'max-w-[calc(100%-1.5rem)]');
  });

  it('closes an open model menu when focus leaves the composer', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ComposerHarness providers={[configuredProvider]} selectedProviderId={configuredProvider.id} selectedModel="model-one" />
        <button type="button">Outside composer</button>
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Select provider and model' }));
    expect(screen.getByRole('menu', { name: 'Model selection' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Outside composer' }));

    expect(screen.queryByRole('menu', { name: 'Model selection' })).not.toBeInTheDocument();
  });

  it('closes the model menu with Escape and after Tab leaves the composer', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ComposerHarness providers={[configuredProvider]} selectedProviderId={configuredProvider.id} selectedModel="model-one" />
        <button type="button">Outside composer</button>
      </>,
    );

    const trigger = screen.getByRole('button', { name: 'Select provider and model' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Model selection' })).not.toBeInTheDocument();

    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'model-one' })).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'model-two' })).toHaveFocus());
    await user.tab();
    await user.tab();
    await user.tab();

    expect(screen.getByRole('button', { name: 'Outside composer' })).toHaveFocus();
    expect(screen.queryByRole('menu', { name: 'Model selection' })).not.toBeInTheDocument();
  });

  it('uses one popover for slash commands and model selection', async () => {
    const user = userEvent.setup();
    render(
      <ComposerHarness providers={[configuredProvider]} selectedProviderId={configuredProvider.id} selectedModel="model-one" />,
    );

    await user.type(screen.getByRole('textbox'), '/阅读');
    expect(screen.getByRole('menu', { name: 'Slash commands' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Select provider and model' }));

    expect(screen.queryByRole('menu', { name: 'Slash commands' })).not.toBeInTheDocument();
    expect(screen.getByRole('menu', { name: 'Model selection' })).toBeVisible();
  });

  it('only shows a page-context notice for errored tabs, not restricted ones', () => {
    const { rerender } = render(<ComposerHarness pageContext={availableContext} />);
    expect(screen.queryByText('This page cannot be read.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry page context' })).not.toBeInTheDocument();

    rerender(<ComposerHarness pageContext={{ status: 'loading' }} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    rerender(<ComposerHarness pageContext={{ status: 'restricted', tabId: 2, title: 'Extensions', url: 'chrome://extensions/' }} />);
    expect(screen.queryByText('This page cannot be read.')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    const onRetryPageContext = vi.fn();
    rerender(<ComposerHarness pageContext={{ status: 'error', message: 'Offline' }} onRetryPageContext={onRetryPageContext} />);
    expect(screen.getByText('Page context unavailable: Offline')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveClass('flex-wrap', 'items-center', 'gap-2');
    expect(screen.getByRole('button', { name: 'Retry page context' })).toHaveClass('shrink-0');
    fireEvent.click(screen.getByRole('button', { name: 'Retry page context' }));
    expect(onRetryPageContext).toHaveBeenCalledOnce();
  });

  it('keeps English and Chinese composer labels in sync', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    expect(en['chat.noMatchingSlashCommands']).toBe('No matching commands');
    expect(zh['chat.noMatchingSlashCommands']).toBe('没有匹配的快捷指令');
  });

  it('shows stop instead of send while busy', () => {
    render(<ComposerHarness busy />);

    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeVisible();
  });
});

describe('agent activity timeline', () => {
  it.each([
    ['running', 'Running browser task'],
    ['confirming', 'Waiting for approval'],
    ['blocked', 'Blocked'],
    ['error', 'Task failed'],
    ['done', 'Task complete'],
  ] as const)('renders %s tool state with text', (status, label) => {
    render(
      <LocaleProvider>
        <AgentActivityCard activities={[activity(status)]} />
      </LocaleProvider>,
    );

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByRole('button').textContent).toContain(status === 'done' ? '1 / 1' : '0 / 1');
  });

  it('announces only the localized summary status when activity state changes', () => {
    const { rerender } = render(
      <LocaleProvider>
        <AgentActivityCard activities={[activity('running')]} />
      </LocaleProvider>,
    );

    const status = screen.getByRole('status', { name: 'Agent activity' });
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Agent status: Running browser task');
    expect(screen.getByRole('region', { name: 'Agent activity' })).toBeVisible();

    rerender(
      <LocaleProvider>
        <AgentActivityCard activities={[activity('confirming')]} />
      </LocaleProvider>,
    );

    expect(screen.getByRole('status', { name: 'Agent activity' })).toHaveTextContent('Agent status: Waiting for approval');
  });

  it('expands ordered tool details', async () => {
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <AgentActivityCard activities={activities} />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Show task details' }));
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Read pageCompletedDone',
      'Set styleIn progressRunning',
    ]);
  });

  it('does not expose raw tool payloads in expanded details', async () => {
    const user = userEvent.setup();
    const rawPayload = '{"selector":"body","css":"body { color: red; }"}';
    const unsafeActivity = { ...activity('running'), detail: rawPayload } as unknown as ToolActivity;
    render(
      <LocaleProvider>
        <AgentActivityCard activities={[unsafeActivity]} />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Show task details' }));
    expect(screen.queryByText(rawPayload)).not.toBeInTheDocument();
  });

  it('does not expose value-bearing confirmation summaries or non-JSON tool results', async () => {
    const user = userEvent.setup();
    const sensitiveDetails = [
      'AI wants to type "customer-secret".',
      'AI wants to write storage value "session-secret".',
      'AI wants to replace HTML with <script>steal()</script>.',
      'Tool result: completed for private-result.',
    ];
    const unsafeActivities = sensitiveDetails.map((detail, index) => ({
      id: `unsafe-${index}`,
      name: 'browser_type',
      status: 'confirming',
      detail,
    })) as unknown as ToolActivity[];
    render(
      <LocaleProvider>
        <AgentActivityCard activities={unsafeActivities} />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Show task details' }));
    for (const detail of sensitiveDetails) {
      expect(screen.queryByText(detail)).not.toBeInTheDocument();
    }
  });

  it('updates aria-expanded and its accessible action when details are toggled', async () => {
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <AgentActivityCard activities={activities} />
      </LocaleProvider>,
    );

    const toggle = screen.getByRole('button', { name: 'Show task details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide task details' })).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Hide task details' }));
    expect(screen.getByRole('button', { name: 'Show task details' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('places the activity card before the confirmation card without changing callbacks', async () => {
    const user = userEvent.setup();
    (chatStore as any).toolActivities = [activity('confirming')];
    (chatStore as any).pendingConfirmation = {
      toolName: 'browser_type',
      summary: 'AI wants to type a value.',
    };
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    const activityStatus = screen.getByText('Waiting for approval');
    const confirmationTitle = screen.getByText(/Please confirm before modifying the page/);
    expect(activityStatus.compareDocumentPosition(confirmationTitle) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await user.click(screen.getByRole('button', { name: 'Approve this turn' }));
    expect(chatStore.respondToConfirmation).toHaveBeenCalledWith(true);
  });
});

describe('workbench context controls', () => {
  it('refreshes providers and defaults when browser storage changes externally', () => {
    render(<LocaleProvider><App /></LocaleProvider>);
    storageChangeListener?.({
      'aluminum:settings': { newValue: {} },
      workbenchPreferences: { newValue: {} },
    }, 'local');
    expect(chatStore.refreshProvider).toHaveBeenCalled();
    expect(chatStore.refreshWorkbenchPreferences).toHaveBeenCalled();
  });
  it('sends with browser tools on an available page by default', async () => {
    const user = userEvent.setup();
    chatStore.input = 'Summarize this';
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('textbox', { name: 'Message input' }));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(undefined, { withoutBrowserTools: false }));
  });

  it('sends without browser tools when attachPageByDefault is off', async () => {
    const user = userEvent.setup();
    chatStore.workbenchPreferences = { attachPageByDefault: false };
    chatStore.input = 'Summarize this';
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('textbox', { name: 'Message input' }));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(undefined, { withoutBrowserTools: true }));
  });

  it('automatically sends restricted-page messages without browser tools, with no click required', async () => {
    const user = userEvent.setup();
    chatStore.pageContext = {
      status: 'restricted',
      tabId: 4,
      title: 'Extensions',
      url: 'chrome://extensions/',
    };
    chatStore.input = 'Open settings';
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('textbox', { name: 'Message input' }));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(undefined, { withoutBrowserTools: true }));
  });

  it('automatically sends error-status messages without browser tools, with no click required', async () => {
    const user = userEvent.setup();
    chatStore.pageContext = { status: 'error', message: 'Offline' };
    chatStore.input = 'Open settings';
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getByText('Page context unavailable: Offline')).toBeVisible();

    await user.click(screen.getByRole('textbox', { name: 'Message input' }));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(undefined, { withoutBrowserTools: true }));
  });

  it('shows a single unified empty-state message regardless of intent', () => {
    render(
      <LocaleProvider>
        <WorkbenchEmptyState shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByText('Ready when you are')).toBeVisible();
    expect(
      screen.getByText('Ask about the current page, or describe a browser task you want me to complete.'),
    ).toBeVisible();
  });

  it.each([
    ['denied', 'Action denied', 'You denied this action'],
    ['stopped', 'Task stopped', 'Stopped'],
  ] as const)('renders %s Agent activity as an explicit terminal state', async (status, summary, detail) => {
    const user = userEvent.setup();
    render(<LocaleProvider><AgentActivityCard activities={[{ id: status, name: 'browser_click', status }]} /></LocaleProvider>);
    expect(screen.getByText(summary)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show task details' }));
    expect(screen.getAllByText(detail).length).toBeGreaterThan(0);
  });

  it('limits empty-state shortcuts to four entries', () => {
    render(
      <LocaleProvider>
        <WorkbenchEmptyState shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getAllByRole('button', { name: /Shortcut/ })).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Shortcut 5' })).not.toBeInTheDocument();
  });
});

describe('workbench history', () => {
  it('opens and closes history with accessible state and returns focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Conversation history' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Conversation history' })).toBeVisible();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Conversation history' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('returns focus to the history trigger when closed with its close button', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Conversation history' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('filters local conversation titles while retaining their date group', async () => {
    const user = userEvent.setup();
    renderDrawer();

    expect(screen.getByRole('heading', { name: 'Today' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Yesterday' })).toBeVisible();
    await user.type(screen.getByRole('searchbox'), 'Google');

    expect(screen.getByText('Google page summary')).toBeVisible();
    expect(screen.queryByText('Shopping comparison')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Yesterday' })).not.toBeInTheDocument();
  });

  it('only removes a conversation after the deletion confirmation', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDrawer(onRemove);

    await user.click(screen.getByRole('button', { name: 'Delete conversation Shopping comparison' }));

    expect(confirm).toHaveBeenCalledWith('Delete this conversation?');
    expect(onRemove).toHaveBeenCalledWith('shopping');
  });

  it('closes the more menu with Escape, outside clicks, and opening history', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.getByRole('menu')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More options' }));
    await user.click(screen.getByText('Aluminum'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More options' }));
    await user.click(screen.getByRole('button', { name: 'Conversation history' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('returns focus to the more-menu trigger after Escape closes the menu', async () => {
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <WorkbenchHeader
          historyOpen={false}
          onToggleHistory={vi.fn()}
          onNewChat={vi.fn()}
          onOpenSettings={vi.fn()}
          onToggleTheme={vi.fn()}
        />
      </LocaleProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'More options' });
    await user.click(trigger);
    await user.tab();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps Tab and Shift+Tab focus inside the open drawer', async () => {
    const user = userEvent.setup();
    renderDrawerWithBackground();

    const search = screen.getByRole('searchbox');
    const close = screen.getByRole('button', { name: 'Close' });
    const lastDrawerControl = screen.getByRole('button', { name: 'Delete conversation Shopping comparison' });
    const background = screen.getByRole('button', { name: 'Background control' });

    await waitFor(() => expect(search).toHaveFocus());
    close.focus();
    await user.tab({ shift: true });
    expect(lastDrawerControl).toHaveFocus();
    expect(background).not.toHaveFocus();

    await user.tab();
    expect(close).toHaveFocus();
    expect(background).not.toHaveFocus();
  });

  it('shows an alert when opening the options page fails', async () => {
    const user = userEvent.setup();
    (globalThis as any).browser.storage.onChanged = {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    };
    (globalThis as any).browser.runtime.openOptionsPage = vi
      .fn()
      .mockRejectedValue(new Error('blocked'));
    window.matchMedia = vi.fn().mockReturnValue({ addEventListener: vi.fn(), removeEventListener: vi.fn(), matches: false });
    HTMLElement.prototype.scrollTo = vi.fn();
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Settings' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open Settings. Please try again.');
  });
});
