import { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '@/lib/db';
import { LocaleProvider } from '@/lib/i18n';
import App from '../App';
import { HistoryDrawer } from './HistoryDrawer';
import { WorkbenchHeader } from './WorkbenchHeader';

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
  setInput: vi.fn(),
  refreshProvider: vi.fn(),
  refreshShortcuts: vi.fn(),
  refreshConversations: vi.fn(),
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

afterEach(() => vi.restoreAllMocks());

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
