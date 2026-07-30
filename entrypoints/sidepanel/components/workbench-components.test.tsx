import { useRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '@/lib/db';
import { LocaleProvider } from '@/lib/i18n';
import type { ResolvedShortcutCommand } from '@/lib/workbench/presentation';
import type { PageContextState, ToolActivity } from '../store';
import App from '../App';
import { AgentActivityCard } from './AgentActivityCard';
import { HistoryDrawer } from './HistoryDrawer';
import { ModeSwitch } from './ModeSwitch';
import { PageContextBar } from './PageContextBar';
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
  turnHasChanges: false,
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
  workbenchPreferences: { defaultMode: 'ask' as const, attachPageByDefault: true },
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
  revertTurnChanges: vi.fn(),
  restoreTabConversation: vi.fn(),
};

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
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
  Object.assign(chatStore, {
    messages: [],
    toolActivities: [],
    input: '',
    busy: false,
    error: null,
    pendingConfirmation: null,
    turnHasChanges: false,
    pageContext: {
      status: 'available' as const,
      tabId: 1,
      title: 'Example article',
      url: 'https://example.com/article',
    },
    workbenchPreferences: { defaultMode: 'ask' as const, attachPageByDefault: true },
  });
  chatStore.send.mockResolvedValue(true);
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
  pageAttached: true,
  pageContext: availableContext,
  providers: [],
  selectedProviderId: null,
  selectedModel: '',
  shortcuts: [readingShortcut],
  onInput: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  onTogglePageAttached: vi.fn(),
  onRunShortcut: vi.fn(),
  onSelectProviderModel: vi.fn(),
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

  it('places the activity card before confirmation and undo cards without changing callbacks', async () => {
    const user = userEvent.setup();
    (chatStore as any).toolActivities = [activity('confirming')];
    (chatStore as any).pendingConfirmation = {
      toolName: 'browser_type',
      summary: 'AI wants to type a value.',
    };
    const { rerender } = render(
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

    (chatStore as any).pendingConfirmation = null;
    chatStore.turnHasChanges = true;
    rerender(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    const undoStatus = screen.getByText('● Page modified this turn');
    expect(activityStatus.compareDocumentPosition(undoStatus) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await user.click(screen.getByRole('button', { name: 'Undo this turn' }));
    expect(chatStore.revertTurnChanges).toHaveBeenCalledOnce();
  });
});

describe('workbench context controls', () => {
  it('shows the active page title and allows one-turn detachment', async () => {
    const user = userEvent.setup();
    const toggle = vi.fn();
    render(
      <LocaleProvider>
        <PageContextBar context={availableContext} attached onToggleAttached={toggle} onRetry={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByText('Example article')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove page context' }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('shows a retry action for context errors', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(
      <LocaleProvider>
        <PageContextBar
          context={{ status: 'error', message: 'Unavailable' }}
          attached
          onToggleAttached={vi.fn()}
          onRetry={retry}
        />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Retry page context' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('offers a restricted tab an accessible no-page-context action', async () => {
    const user = userEvent.setup();
    const toggle = vi.fn();
    render(
      <LocaleProvider>
        <PageContextBar
          context={{ status: 'restricted', tabId: 3, title: 'Extensions', url: 'chrome://extensions/' }}
          attached
          onToggleAttached={toggle}
          onRetry={vi.fn()}
        />
      </LocaleProvider>,
    );

    expect(screen.getByText('This page cannot be read.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Continue without page context' }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('changes empty suggestions between ask and agent modes', () => {
    const { rerender } = render(
      <WorkbenchEmptyState mode="ask" shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />,
    );
    expect(screen.getByText('Ask about this page')).toBeVisible();

    rerender(
      <WorkbenchEmptyState mode="agent" shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />,
    );
    expect(screen.getByText('Describe a browser task')).toBeVisible();
  });

  it('exposes pressed state for the active mode', () => {
    render(<ModeSwitch mode="agent" onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Ask' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('limits empty-state shortcuts to four entries', () => {
    render(
      <WorkbenchEmptyState mode="ask" shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />,
    );

    expect(screen.getAllByRole('button', { name: /Shortcut/ })).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Shortcut 5' })).not.toBeInTheDocument();
  });

  it('does not consume one-turn detachment when an empty normal send does not start', async () => {
    const user = userEvent.setup();
    chatStore.send.mockResolvedValue(false);
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Remove page context' }));
    await user.click(screen.getByRole('textbox', { name: 'Message input' }));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(undefined, { withoutBrowserTools: true }));
    expect(screen.getByRole('button', { name: 'Add page context' })).toBeVisible();
  });

  it('runs an Agent-mode restricted-page message without browser tools and then resets detachment', async () => {
    const user = userEvent.setup();
    chatStore.pageContext = {
      status: 'restricted',
      tabId: 4,
      title: 'Extensions',
      url: 'chrome://extensions/',
    };
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Agent' }));
    await user.click(screen.getByRole('button', { name: 'Continue without page context' }));
    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Open settings');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(undefined, { withoutBrowserTools: true }));
    expect(screen.getByRole('button', { name: 'Continue without page context' })).toBeEnabled();
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
