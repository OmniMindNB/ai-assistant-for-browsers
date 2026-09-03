import { useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '@/lib/db';
import type { PendingAttachment } from '@/lib/chat/attachments';
import { LocaleProvider } from '@/lib/i18n';
import { en } from '@/lib/i18n/locales/en';
import { zh } from '@/lib/i18n/locales/zh';
import type { ProviderConfig } from '@/lib/settings';
import type { ResolvedShortcutCommand } from '@/lib/workbench/presentation';
import { STATUS_MIN_INTERVAL_MS } from '@/lib/workbench/status-throttle';
import type { ActivityStep, PageContextState } from '../store';
import App from '../App';
import MessageEditor from '../MessageEditor';
import { ActivityStepList } from './ActivityStepList';
import { HistoryDrawer } from './HistoryDrawer';
import { WorkbenchEmptyState } from './WorkbenchEmptyState';
import { WorkbenchHeader } from './WorkbenchHeader';
import { WorkbenchComposer, type WorkbenchComposerProps } from './WorkbenchComposer';
import { AttachmentChip } from './AttachmentChip';

const chatStore = {
  messages: [],
  activitySteps: [],
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
  quotedSelection: null,
  // 必须和 store.ts 的初值一致：非 0 会让 composer 以为收到了划词提问，在挂载时抢走焦点。
  pendingFocusToken: 0,
  pendingAttachments: [],
  clearQuotedSelection: vi.fn(),
  addAttachmentFiles: vi.fn(),
  removeAttachment: vi.fn(),
  retryAttachment: vi.fn(),
  disposeAttachments: vi.fn(),
  refreshProvider: vi.fn(),
  refreshShortcuts: vi.fn(),
  refreshConversations: vi.fn(),
  refreshPageContext: vi.fn(),
  selectProviderAndModel: vi.fn(),
  send: vi.fn(),
  editMessage: vi.fn(),
  regenerate: vi.fn(),
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
  // jsdom 不实现 scrollIntoView，确认卡挂载时会调它。
  HTMLElement.prototype.scrollIntoView = vi.fn();
  (globalThis as any).browser.storage.onChanged = {
    addListener: vi.fn((listener) => { storageChangeListener = listener; }),
    removeListener: vi.fn(),
  };
  Object.assign(chatStore, {
    messages: [],
    activitySteps: [],
    busy: false,
    error: null,
    pendingConfirmation: null,
    pendingFocusToken: 0,
    pendingAttachments: [],
    shortcuts: [],
    pageContext: {
      status: 'available' as const,
      tabId: 1,
      title: 'Example article',
      url: 'https://example.com/article',
    },
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
  busy: false,
  pageContext: availableContext,
  providers: [],
  selectedProviderId: null,
  selectedModel: '',
  shortcuts: [readingShortcut],
  pendingFocusToken: 0,
  quotedSelection: null,
  onSend: vi.fn(),
  onStop: vi.fn(),
  onRetryPageContext: vi.fn(),
  onRunShortcut: vi.fn(),
  onSelectProviderModel: vi.fn(),
  onClearQuotedSelection: vi.fn(),
  attachments: [],
  onAddAttachmentFiles: vi.fn(),
  onRemoveAttachment: vi.fn(),
  onRetryAttachment: vi.fn(),
};

const configuredProvider: ProviderConfig = {
  id: 'provider-1',
  name: 'Configured provider',
  baseURL: 'https://example.com/v1',
  apiKey: 'test-key',
  model: 'model-one',
  models: ['model-one', 'model-two'],
};

const readyPdf: PendingAttachment = {
  id: 'ready-pdf',
  name: 'ready.pdf',
  mimeType: 'application/pdf',
  size: 10,
  kind: 'pdf',
  status: 'ready',
  attachment: {
    id: 'ready-pdf',
    name: 'ready.pdf',
    mimeType: 'application/pdf',
    size: 10,
    kind: 'pdf',
    pageCount: 2,
    extractedChars: 20,
    truncated: false,
  },
  transientText: 'ready text',
};

const retryablePdfError: PendingAttachment = {
  id: 'failed-pdf',
  name: 'report.pdf',
  mimeType: 'application/pdf',
  size: 10,
  kind: 'pdf',
  status: 'error',
  file: new File(['%PDF-x'], 'report.pdf'),
  reason: 'parse-failed',
  retryable: true,
};

const parsingPdf: PendingAttachment = {
  status: 'parsing',
  id: 'parsing-pdf',
  taskId: 'parsing-task',
  file: new File([], 'parsing.pdf'),
  name: 'parsing.pdf',
  mimeType: 'application/pdf',
  size: 10,
  kind: 'pdf',
  completedPages: 1,
  pageCount: 4,
};

function ComposerHarness(props: Partial<WorkbenchComposerProps>) {
  return (
    <LocaleProvider>
      <WorkbenchComposer {...composerProps} {...props} />
    </LocaleProvider>
  );
}

describe('workbench composer', () => {
  it('shows PDF progress and disables send while parsing', () => {
    render(
      <ComposerHarness
        attachments={[{
          status: 'parsing',
          id: 'a',
          taskId: 't',
          file: new File([], 'report.pdf'),
          name: 'report.pdf',
          mimeType: 'application/pdf',
          size: 10,
          kind: 'pdf',
          completedPages: 2,
          pageCount: 4,
        }]}
      />,
    );

    expect(screen.getByText('50%')).toBeVisible();
    expect(screen.getByText('Parsing')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('does not submit with Enter while an attachment is parsing', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <ComposerHarness
        attachments={[parsingPdf]}
        onSend={onSend}
      />,
    );

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');

    expect(onSend).not.toHaveBeenCalled();
  });

  it('enables attachment-only send for a ready PDF', () => {
    render(<ComposerHarness attachments={[readyPdf]} />);

    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    expect(screen.getByText('2 pages')).toBeVisible();
  });

  it('shows retry only for retryable errors', async () => {
    const user = userEvent.setup();
    const onRetryAttachment = vi.fn();
    const nonRetryableError: PendingAttachment = {
      ...retryablePdfError,
      id: 'no-text-pdf',
      name: 'scan.pdf',
      reason: 'no-extractable-text',
      retryable: false,
    };
    render(
      <ComposerHarness
        attachments={[retryablePdfError, nonRetryableError]}
        onRetryAttachment={onRetryAttachment}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Retry report.pdf' }));
    expect(onRetryAttachment).toHaveBeenCalledWith(retryablePdfError.id);
    expect(screen.queryByRole('button', { name: 'Retry scan.pdf' })).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('lets valid text bypass an error attachment but will not send the error alone', async () => {
    const user = userEvent.setup();
    render(<ComposerHarness attachments={[retryablePdfError]} />);
    const textbox = screen.getByRole('textbox');

    await user.type(textbox, 'summarize');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();

    await user.clear(textbox);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('shows queued and truncated PDF states with accessible per-file removal', async () => {
    const user = userEvent.setup();
    const onRemoveAttachment = vi.fn();
    const queued: PendingAttachment = {
      status: 'queued',
      id: 'queued-pdf',
      taskId: 'queued-task',
      file: new File([], 'queued.pdf'),
      name: 'queued.pdf',
      mimeType: 'application/pdf',
      size: 10,
      kind: 'pdf',
    };
    const truncated: PendingAttachment = {
      id: 'truncated-pdf',
      name: 'long.pdf',
      mimeType: 'application/pdf',
      size: 10,
      kind: 'pdf',
      status: 'ready',
      attachment: {
        id: 'truncated-pdf',
        name: 'long.pdf',
        mimeType: 'application/pdf',
        size: 10,
        kind: 'pdf',
        pageCount: 2,
        extractedChars: 60_000,
        truncated: true,
      },
      transientText: 'ready text',
    };
    render(
      <ComposerHarness
        attachments={[queued, truncated]}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );

    expect(screen.getByText('Waiting to parse')).toBeVisible();
    expect(screen.getByText('Truncated (too long)')).toHaveAttribute(
      'title',
      'Limited to the first 60,000 extracted characters',
    );
    await user.click(screen.getByRole('button', { name: 'Remove queued.pdf' }));
    expect(onRemoveAttachment).toHaveBeenCalledWith('queued-pdf');
  });

  it('renders historical PDF chips as read-only', () => {
    render(
      <LocaleProvider>
        <AttachmentChip attachment={readyPdf.attachment} />
      </LocaleProvider>,
    );

    expect(screen.getByText('ready.pdf')).toBeVisible();
    expect(screen.getByText('2 pages')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('highlights file drag without intercepting text drag and submits dropped files', () => {
    const onAddAttachmentFiles = vi.fn();
    render(<ComposerHarness onAddAttachmentFiles={onAddAttachmentFiles} />);
    const zone = screen.getByTestId('composer-drop-zone');
    const textPreventDefault = vi.fn();
    fireEvent.dragEnter(zone, {
      dataTransfer: { types: ['text/plain'] },
      preventDefault: textPreventDefault,
    });
    expect(screen.queryByText('Drop to add PDF')).toBeNull();
    expect(textPreventDefault).not.toHaveBeenCalled();

    const pdf = new File(['%PDF-x'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'], files: [pdf] } });
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Drop to add PDF');
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [pdf] } });
    expect(onAddAttachmentFiles).toHaveBeenCalledWith([pdf]);
    expect(screen.getByRole('textbox')).not.toHaveAttribute('placeholder', 'Drop to add PDF');
  });

  it('keeps the drop highlight while file drag moves across child controls', () => {
    render(<ComposerHarness />);
    const zone = screen.getByTestId('composer-drop-zone');

    fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'] } });
    fireEvent.dragEnter(screen.getByRole('textbox'), { dataTransfer: { types: ['Files'] } });
    fireEvent.dragLeave(screen.getByRole('textbox'), { dataTransfer: { types: ['Files'] } });
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Drop to add PDF');
    fireEvent.dragLeave(zone, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByRole('textbox')).not.toHaveAttribute('placeholder', 'Drop to add PDF');
  });

  it('offers PDF files through the attachment picker', () => {
    const { container } = render(<ComposerHarness />);

    expect(container.querySelector('input[type="file"]')).toHaveAttribute(
      'accept',
      expect.stringContaining('.pdf,application/pdf'),
    );
  });

  it('does not intercept or submit file drops while generation is busy', () => {
    const onAddAttachmentFiles = vi.fn();
    render(<ComposerHarness busy onAddAttachmentFiles={onAddAttachmentFiles} />);
    const zone = screen.getByTestId('composer-drop-zone');
    const pdf = new File(['%PDF-x'], 'report.pdf', { type: 'application/pdf' });

    expect(fireEvent.dragEnter(zone, {
      dataTransfer: { types: ['Files'], files: [pdf] },
    })).toBe(true);
    expect(screen.getByRole('textbox')).not.toHaveAttribute('placeholder', 'Drop to add PDF');
    expect(fireEvent.drop(zone, {
      dataTransfer: { types: ['Files'], files: [pdf] },
    })).toBe(true);
    expect(onAddAttachmentFiles).not.toHaveBeenCalled();
  });

  it('exposes the PDF truncation limit as a keyboard-accessible description', () => {
    const truncated: PendingAttachment = {
      id: 'accessible-truncated-pdf',
      name: 'accessible.pdf',
      mimeType: 'application/pdf',
      size: 10,
      kind: 'pdf',
      status: 'ready',
      attachment: {
        id: 'accessible-truncated-pdf',
        name: 'accessible.pdf',
        mimeType: 'application/pdf',
        size: 10,
        kind: 'pdf',
        pageCount: 2,
        extractedChars: 60_000,
        truncated: true,
      },
      transientText: 'ready text',
    };
    render(
      <LocaleProvider>
        <AttachmentChip pending={truncated} onRemove={vi.fn()} onRetry={vi.fn()} />
      </LocaleProvider>,
    );

    const chip = screen.getByText('accessible.pdf').closest('div');
    expect(chip).toHaveAttribute('tabindex', '0');
    expect(chip).toHaveAccessibleDescription('Limited to the first 60,000 extracted characters');
  });

  it('focuses the textarea and moves the cursor to the end when pendingFocusToken advances', async () => {
    const { rerender } = render(
      <LocaleProvider>
        <WorkbenchComposer {...composerProps} pendingFocusToken={0} />
      </LocaleProvider>,
    );
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    // fireEvent.change (unlike userEvent.type) does not focus the element, matching the scenario
    // this guards: text already sitting in the draft (e.g. restored across a panel remount)
    // before pendingFocusToken tells the composer to focus and place the cursor.
    fireEvent.change(textarea, { target: { value: 'quoted selection' } });
    expect(textarea).not.toHaveFocus();

    rerender(
      <LocaleProvider>
        <WorkbenchComposer {...composerProps} pendingFocusToken={12345} />
      </LocaleProvider>,
    );

    await waitFor(() => expect(textarea).toHaveFocus());
    expect(textarea.selectionStart).toBe('quoted selection'.length);
    expect(textarea.selectionEnd).toBe('quoted selection'.length);
  });

  it('renders the quoted selection as a dismissible card, separate from the (empty) textarea', () => {
    render(
      <LocaleProvider>
        <WorkbenchComposer {...composerProps} quotedSelection="the selected text" />
      </LocaleProvider>,
    );

    expect(screen.getByText('the selected text')).toBeInTheDocument();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('does not render a quote card when there is no quoted selection', () => {
    render(
      <LocaleProvider>
        <WorkbenchComposer {...composerProps} quotedSelection={null} />
      </LocaleProvider>,
    );

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('calls onClearQuotedSelection when the quote card dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const onClearQuotedSelection = vi.fn();
    render(
      <LocaleProvider>
        <WorkbenchComposer
          {...composerProps}
          quotedSelection="the selected text"
          onClearQuotedSelection={onClearQuotedSelection}
        />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: en['workbench.clearQuotedSelection'] }));

    expect(onClearQuotedSelection).toHaveBeenCalledOnce();
  });

  it('opens slash commands, filters, and runs the selected command', async () => {
    const user = userEvent.setup();
    const onRunShortcut = vi.fn();
    render(<ComposerHarness onRunShortcut={onRunShortcut} />);

    await user.type(screen.getByRole('textbox'), '/阅读');
    expect(screen.getByRole('menu')).toBeVisible();
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onRunShortcut).toHaveBeenCalledWith(readingShortcut.config);
  });

  it('blocks slash-command submission while an attachment is parsing', async () => {
    const user = userEvent.setup();
    const onRunShortcut = vi.fn();
    render(<ComposerHarness attachments={[parsingPdf]} onRunShortcut={onRunShortcut} />);

    await user.type(screen.getByRole('textbox'), '/阅读');
    await user.keyboard('{Enter}');

    expect(onRunShortcut).not.toHaveBeenCalled();
  });

  it('disables composer quick shortcuts while an attachment is parsing', async () => {
    const user = userEvent.setup();
    const onRunShortcut = vi.fn();
    render(<ComposerHarness attachments={[parsingPdf]} onRunShortcut={onRunShortcut} />);

    const shortcut = screen.getByRole('button', { name: '阅读页面' });
    expect(shortcut).toBeDisabled();
    await user.click(shortcut);
    expect(onRunShortcut).not.toHaveBeenCalled();
  });

  it('sends on Enter and inserts a newline on Shift+Enter', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} />);

    await user.type(screen.getByRole('textbox'), 'hello');
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledOnce();
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(onSend).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox')).toHaveValue('hello\n');
  });

  it('does not send while composing with an IME', () => {
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} />);
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: '你好' } });

    fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('opens the slash-command menu via the merged insert menu and keeps focus on the textarea for keyboard nav', async () => {
    const user = userEvent.setup();
    const onRunShortcut = vi.fn();
    render(<ComposerHarness onRunShortcut={onRunShortcut} />);

    const trigger = screen.getByRole('button', { name: 'Add content' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const insertMenu = screen.getByRole('menu', { name: 'Add content' });
    await user.click(within(insertMenu).getByRole('menuitem', { name: 'Slash commands' }));

    const menu = screen.getByRole('menu', { name: 'Slash commands' });
    expect(within(menu).getByText('阅读页面')).toBeVisible();
    expect(screen.getByRole('textbox')).toHaveValue('');
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());

    // 焦点回到输入框，说明键盘导航（这里是直接 Enter 选中高亮的第一项）照常可用。
    await user.keyboard('{Enter}');
    expect(onRunShortcut).toHaveBeenCalledWith(readingShortcut.config);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('toggles the insert menu closed on a second click of the trigger button', async () => {
    const user = userEvent.setup();
    render(<ComposerHarness />);

    const trigger = screen.getByRole('button', { name: 'Add content' });
    await user.click(trigger);
    expect(screen.getByRole('menu', { name: 'Add content' })).toBeVisible();

    await user.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
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
    render(<ComposerHarness onSend={onSend} />);

    await user.type(screen.getByRole('textbox'), '   ');
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

describe('activity step list', () => {
  const steps: ActivityStep[] = [
    { id: 'call-1', description: 'Clicked "button.buy"', status: 'done' },
    { id: 'call-2', description: 'Failed to click "button.confirm"', status: 'failed' },
    { id: 'call-3', description: 'Typing into "input.name"', status: 'running' },
  ];

  it('renders one row per step with a shared status container', () => {
    render(
      <LocaleProvider>
        <ActivityStepList steps={steps} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('list', { name: 'Execution steps' })).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Clicked "button.buy"')).toBeVisible();
    expect(screen.getByText('Failed to click "button.confirm"')).toBeVisible();
    expect(screen.getByText('Typing into "input.name"')).toBeVisible();
  });

  it('gives the failed row distinct (red) styling', () => {
    render(
      <LocaleProvider>
        <ActivityStepList steps={steps} />
      </LocaleProvider>,
    );
    const failedText = screen.getByText('Failed to click "button.confirm"');
    expect(failedText.closest('li')?.className).toContain('text-red-700');
  });

  // 完成行是写操作事后唯一的追溯入口，正文字号 12px 必须过 AA 4.5:1：
  // 亮色下 neutral-400 只有约 2.4:1，暗色下 neutral-500 只有约 4.2:1，两边都得抬一档。
  it('gives the done row muted-but-AA-contrast styling in both themes', () => {
    render(
      <LocaleProvider>
        <ActivityStepList steps={steps} />
      </LocaleProvider>,
    );
    const className = screen.getByText('Clicked "button.buy"').closest('li')?.className ?? '';
    expect(className).toContain('text-neutral-600');
    expect(className).toContain('dark:text-neutral-400');
    expect(className).not.toContain(' text-neutral-400');
  });

  // 进行中必须比已完成更醒目，而不是更淡——这是列表里唯一“现在在发生”的一行。
  it('gives the running row accent styling stronger than the done row', () => {
    render(
      <LocaleProvider>
        <ActivityStepList steps={steps} />
      </LocaleProvider>,
    );
    const running = screen.getByText('Typing into "input.name"').closest('li')?.className ?? '';
    expect(running).toContain('text-indigo-700');
    expect(running).toContain('dark:text-indigo-300');
    expect(running).toContain('font-medium');
  });

  it('gives a running list more height than an all-done (archived) one', () => {
    const { rerender } = render(
      <LocaleProvider>
        <ActivityStepList steps={steps} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('list').className).toContain('max-h-48');

    rerender(
      <LocaleProvider>
        <ActivityStepList steps={steps.map((step) => ({ ...step, status: 'done' as const }))} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('list').className).toContain('max-h-32');
  });

  // 每新增一步整个列表都会重排，挂 aria-live 会让读屏反复重播大段内容。
  // 播报改由 header 那条经过节流的常驻状态行承担，这里只保留视觉与事后回看。
  it('不再是 live region，避免与 header 状态行重复播报', () => {
    render(
      <LocaleProvider>
        <ActivityStepList steps={steps} />
      </LocaleProvider>,
    );
    const list = screen.getByRole('list');
    expect(list).not.toHaveAttribute('aria-live');
    expect(list).not.toHaveAttribute('role', 'status');
  });

  it('把合并后的重试次数显示出来', () => {
    render(
      <LocaleProvider>
        <ActivityStepList
          steps={[{ id: 'call-3', description: 'Failed to click "#pay"', status: 'failed', attempt: 3 }]}
        />
      </LocaleProvider>,
    );
    expect(screen.getByText('Failed to click "#pay"（attempt 3）')).toBeVisible();
  });

  it('第一次尝试不显示次数后缀', () => {
    render(
      <LocaleProvider>
        <ActivityStepList steps={[{ id: 'call-1', description: 'Clicking "#pay"', status: 'running' }]} />
      </LocaleProvider>,
    );
    expect(screen.getByText('Clicking "#pay"')).toBeVisible();
  });

  // 序号给滚动列表位置感：24+ 步的写任务里，没有它用户不知道已经走了多远。
  it('给工具步骤编号，但跳过流程提示和接管痕迹', () => {
    render(
      <LocaleProvider>
        <ActivityStepList
          steps={[
            { id: 'c1', description: 'Read page', status: 'done', signature: 'browser_read_page:{}' },
            { id: 'takeover-c1', description: 'You took over', status: 'done' },
            { id: 'c2', description: 'Clicked "#pay"', status: 'done', signature: 'browser_click:{}' },
            { id: 'tool-phase-end', description: 'Step limit reached', status: 'notice' },
          ]}
        />
      </LocaleProvider>,
    );

    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('1.');
    expect(rows[1]).not.toHaveTextContent('2.');
    // 接管痕迹没占号，所以下一个工具步骤仍然是 2——编号数的是实际操作次数。
    expect(rows[2]).toHaveTextContent('2.');
    expect(rows[3]).not.toHaveTextContent('3.');
  });

  // notice 不是一次工具调用，拿 done 的 ✓ 冒充会读成"这件事成功了"。
  it('notice 步骤用告警样式而不是完成样式', () => {
    render(
      <LocaleProvider>
        <ActivityStepList
          steps={[{ id: 'tool-phase-end', description: 'Step limit reached', status: 'notice' }]}
        />
      </LocaleProvider>,
    );
    const row = screen.getByText('Step limit reached').closest('li');
    expect(row?.className).toContain('text-amber-700');
  });

  it('renders a running step description verbatim', () => {
    render(
      <LocaleProvider>
        <ActivityStepList steps={[{ id: 'call-1', description: 'Reading page', status: 'running' }]} />
      </LocaleProvider>,
    );
    expect(screen.getByText('Reading page')).toBeVisible();
  });

  it('shows a persistent current-tab banner taken from the last step, and omits it when operating on the panel tab', () => {
    const { rerender } = render(
      <LocaleProvider>
        <ActivityStepList
          steps={[{ id: 'call-1', description: 'Clicking "#pay"', status: 'running', tabLabel: '网上银行' }]}
        />
      </LocaleProvider>,
    );
    expect(screen.getByText('Currently operating on "网上银行"')).toBeVisible();

    rerender(
      <LocaleProvider>
        <ActivityStepList steps={[{ id: 'call-1', description: 'Reading page', status: 'running' }]} />
      </LocaleProvider>,
    );
    expect(screen.queryByText(/Currently operating on/)).not.toBeInTheDocument();
  });

  it('only prefixes a row with the tab label when it differs from the previous row', () => {
    render(
      <LocaleProvider>
        <ActivityStepList
          steps={[
            { id: 'call-1', description: 'Clicking "#a"', status: 'done', tabLabel: '网上银行' },
            { id: 'call-2', description: 'Clicking "#b"', status: 'done', tabLabel: '网上银行' },
            { id: 'call-3', description: 'Reading page', status: 'done' },
          ]}
        />
      </LocaleProvider>,
    );
    expect(screen.getByText('《网上银行》Clicking "#a"')).toBeVisible();
    expect(screen.getByText('Clicking "#b"')).toBeVisible();
    expect(screen.queryByText('《网上银行》Clicking "#b"')).not.toBeInTheDocument();
    expect(screen.getByText('Reading page')).toBeVisible();
  });

  it('expands a truncated row to full text on click, and collapses again on a second click', async () => {
    const user = userEvent.setup();
    const long = 'Filled "input[name=account-number-really-long-selector]" with "1234567890123456"';
    render(
      <LocaleProvider>
        <ActivityStepList steps={[{ id: 'call-1', description: long, status: 'done' }]} />
      </LocaleProvider>,
    );

    const row = screen.getByRole('button', { name: long });
    expect(row.className).toContain('truncate');
    expect(row).toHaveAttribute('aria-expanded', 'false');

    await user.click(row);
    expect(row.className).not.toContain('truncate');
    expect(row.className).toContain('whitespace-pre-wrap');
    expect(row).toHaveAttribute('aria-expanded', 'true');

    await user.click(row);
    expect(row.className).toContain('truncate');
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  it('hides the activity step list while a confirmation is pending, but keeps approval working', async () => {
    const user = userEvent.setup();
    (chatStore as any).activitySteps = [{ id: 'call-1', description: 'Clicking "button.buy"', status: 'running' }];
    (chatStore as any).pendingConfirmation = {
      toolCallId: 'call-1',
      toolName: 'browser_type',
      summary: 'AI wants to type a value.',
    };
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.queryByText('Clicking "button.buy"')).toBeNull();
    expect(screen.getByText(/Confirm form submission/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Submit form' }));
    expect(chatStore.respondToConfirmation).toHaveBeenCalledWith(true);
  });

  it('shows a trailing thinking indicator on the last message while busy with no running step', () => {
    (chatStore as any).messages = [
      { id: 'm1', role: 'user', content: 'Do something', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Working on it', createdAt: 2 },
    ];
    (chatStore as any).busy = true;
    (chatStore as any).activitySteps = [];
    (chatStore as any).pendingConfirmation = null;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getByLabelText('Generating')).toBeVisible();
  });

  it('does not show the trailing thinking indicator while a tool step is running', () => {
    (chatStore as any).messages = [
      { id: 'm1', role: 'user', content: 'Do something', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Working on it', createdAt: 2 },
    ];
    (chatStore as any).busy = true;
    (chatStore as any).activitySteps = [{ id: 'call-1', description: 'Clicking "button.buy"', status: 'running' }];
    (chatStore as any).pendingConfirmation = null;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.queryByLabelText('Generating')).toBeNull();
  });

  it('renders a success badge with the reported reason as a tooltip', () => {
    (chatStore as any).messages = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Done',
        createdAt: 1,
        taskOutcome: { outcome: 'success', reason: 'Filled and submitted the form.' },
      },
    ];
    (chatStore as any).busy = false;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getByText('Task completed')).toBeVisible();
    expect(screen.getByTitle('Filled and submitted the form.')).toBeVisible();
  });

  it('renders partial and failure badges with distinct labels', () => {
    (chatStore as any).messages = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Partly done',
        createdAt: 1,
        taskOutcome: { outcome: 'partial', reason: 'Filled 2 of 3 fields.' },
      },
      {
        id: 'm2',
        role: 'user',
        content: 'try again',
        createdAt: 2,
      },
      {
        id: 'm3',
        role: 'assistant',
        content: 'Could not finish',
        createdAt: 3,
        taskOutcome: { outcome: 'failure', reason: 'Submit button was never found.' },
      },
    ];
    (chatStore as any).busy = false;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getByText('Partially completed')).toBeVisible();
    expect(screen.getByText('Task not completed')).toBeVisible();
  });

  it('copies an assistant message to the clipboard and shows transient "Copied" feedback', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    (chatStore as any).messages = [
      { id: 'm1', role: 'user', content: 'Do something', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Here is the answer', createdAt: 2 },
    ];
    (chatStore as any).busy = false;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Copy message' }));

    expect(writeText).toHaveBeenCalledWith('Here is the answer');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
  });

  it('offers regenerate only on the last assistant message, and calls regenerate(id) on click', async () => {
    const user = userEvent.setup();
    (chatStore as any).messages = [
      { id: 'm1', role: 'user', content: 'first', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'first answer', createdAt: 2 },
      { id: 'm3', role: 'user', content: 'second', createdAt: 3 },
      { id: 'm4', role: 'assistant', content: 'second answer', createdAt: 4 },
    ];
    (chatStore as any).busy = false;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getAllByRole('button', { name: 'Regenerate response' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Regenerate response' }));
    expect(chatStore.regenerate).toHaveBeenCalledWith('m4');
  });

  // 快捷操作的回复同样能重新生成——按消息上带的重放配方重跑，而不是原样重发标签文本。
  it('offers regenerate on a shortcut reply that carries a rerun recipe', async () => {
    const user = userEvent.setup();
    (chatStore as any).messages = [
      {
        id: 'm1',
        role: 'user',
        content: '📄 总结当前网页',
        createdAt: 1,
        kind: 'action',
        rerun: {
          shortcut: { id: 'builtin:summarize', origin: 'builtin', scope: 'page', customized: false, name: '总结当前网页', prompt: '总结这个页面' },
        },
      },
      { id: 'm2', role: 'assistant', content: 'summary answer', createdAt: 2 },
    ];
    (chatStore as any).busy = false;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Regenerate response' }));
    expect(chatStore.regenerate).toHaveBeenCalledWith('m2');
  });

  // 存量历史里的快捷操作消息没有配方，重跑不出来——展示一个点了没反应的按钮比不展示更糟。
  it('hides regenerate on a legacy shortcut reply with no rerun recipe', () => {
    (chatStore as any).messages = [
      { id: 'm1', role: 'user', content: '📄 总结当前网页', createdAt: 1, kind: 'action' },
      { id: 'm2', role: 'assistant', content: 'summary answer', createdAt: 2 },
    ];
    (chatStore as any).busy = false;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Regenerate response' })).not.toBeInTheDocument();
  });

  it('hides regenerate while a request is in flight', () => {
    (chatStore as any).messages = [
      { id: 'm1', role: 'user', content: 'first', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'first answer', createdAt: 2 },
    ];
    (chatStore as any).busy = false;
    (chatStore as any).pendingAttachments = [parsingPdf];
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Regenerate response' })).not.toBeInTheDocument();
  });

  it('does not render a badge when the message has no taskOutcome', () => {
    (chatStore as any).messages = [
      { id: 'm1', role: 'user', content: 'Do something', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Working on it', createdAt: 2 },
    ];
    (chatStore as any).busy = false;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.queryByText('Task completed')).toBeNull();
    expect(screen.queryByText('Partially completed')).toBeNull();
    expect(screen.queryByText('Task not completed')).toBeNull();
  });
});

// 确认卡是全流程唯一真正停下来等人的交互，却渲染在滚动流里，很可能落在视口外。
// 它必须自己把用户带过来（滚动 + 焦点 + 可播报的角色），否则表现出来就是「agent 卡住了」。
describe('confirmation card', () => {
  const pendingConfirmation = {
    toolCallId: 'call-1',
    toolName: 'browser_click',
    summary: 'AI wants to submit the login form.',
  };

  it('exposes itself as an alertdialog labelled by its title and summary', () => {
    (chatStore as any).pendingConfirmation = pendingConfirmation;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('🔒 Confirm form submission');
    expect(dialog).toHaveAccessibleDescription('AI wants to submit the login form.');
  });

  it('scrolls itself into view and takes focus when it appears', () => {
    (chatStore as any).pendingConfirmation = pendingConfirmation;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.scrollIntoView).toHaveBeenCalled();
    // 焦点落在卡片本身而不是「确认提交」按钮上：读屏能读到完整标题+摘要，
    // 且用户随手一个回车不会直接把表单发出去。
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveAttribute('tabindex', '-1');
  });

  it('denies on Escape', async () => {
    const user = userEvent.setup();
    (chatStore as any).pendingConfirmation = pendingConfirmation;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.keyboard('{Escape}');
    expect(chatStore.respondToConfirmation).toHaveBeenCalledWith(false);
  });

  // 提交表单不可撤销，不该被画成一个绿色的「安全放行」按钮。
  it('does not style the irreversible approval as a safe/go action', () => {
    (chatStore as any).pendingConfirmation = pendingConfirmation;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    const approve = screen.getByRole('button', { name: 'Submit form' });
    const deny = screen.getByRole('button', { name: 'Deny' });
    expect(approve.className).not.toContain('emerald');
    expect(approve.className).toContain('amber');
    // 两颗按钮同权重：拒绝不是一个需要费劲才找得到的次要选项。
    expect(deny.className).toContain('px-3');
    expect(approve.className).toContain('px-3');
  });

  // 接管暂停复用同一条应答通道，但问的是完全不同的问题：不是"这次提交放不放行"，
  // 而是"人已经插手了，还接着做吗"。文案和按钮必须跟着换，否则用户会以为要提交表单。
  it('以接管变体呈现 kind=takeover，而不是表单提交文案', () => {
    (chatStore as any).pendingConfirmation = { ...pendingConfirmation, kind: 'takeover' };
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('✋ You took over this page');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop here' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Submit form' })).not.toBeInTheDocument();
  });

  it('接管变体同样会滚动到可见并取焦', () => {
    (chatStore as any).pendingConfirmation = { ...pendingConfirmation, kind: 'takeover' };
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.scrollIntoView).toHaveBeenCalled();
    expect(dialog).toHaveFocus();
  });

  it('“到此为止”走的是拒绝那条应答', async () => {
    const user = userEvent.setup();
    (chatStore as any).pendingConfirmation = { ...pendingConfirmation, kind: 'takeover' };
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Stop here' }));
    expect(chatStore.respondToConfirmation).toHaveBeenCalledWith(false);
  });

  // kind 缺省必须按表单提交处理：已经落盘的旧快照里没有这个字段。
  it('缺少 kind 的旧快照仍按表单提交呈现', () => {
    (chatStore as any).pendingConfirmation = pendingConfirmation;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('🔒 Confirm form submission');
  });
});

describe('workbench context controls', () => {
  it('disables empty-state shortcuts while an attachment is parsing', async () => {
    const user = userEvent.setup();
    (chatStore as any).shortcuts = emptyStateShortcuts.map(({ config }) => config);
    (chatStore as any).pendingAttachments = [parsingPdf];
    render(<LocaleProvider><App /></LocaleProvider>);

    const shortcut = within(screen.getByRole('main')).getByRole('button', { name: 'Shortcut 1' });
    expect(shortcut).toBeDisabled();
    await user.click(shortcut);
    expect(chatStore.runShortcut).not.toHaveBeenCalled();
  });

  it('disables an open message editor while an attachment is parsing', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <LocaleProvider>
        <MessageEditor
          initialContent="updated question"
          discardCount={0}
          disabled
          onCancel={vi.fn()}
          onSubmit={onSubmit}
        />
      </LocaleProvider>,
    );

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(screen.getByRole('textbox', { name: 'Edit message' }));
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('routes attachment retries from the compact chip to the store', async () => {
    const user = userEvent.setup();
    (chatStore as any).pendingAttachments = [retryablePdfError];
    render(<LocaleProvider><App /></LocaleProvider>);

    await user.click(screen.getByRole('button', { name: 'Retry report.pdf' }));

    expect(chatStore.retryAttachment).toHaveBeenCalledWith('failed-pdf');
  });

  it('disposes transient attachments when the sidepanel unmounts', () => {
    const { unmount } = render(<LocaleProvider><App /></LocaleProvider>);

    unmount();

    expect(chatStore.disposeAttachments).toHaveBeenCalledOnce();
  });

  it('refreshes providers when browser storage changes externally', () => {
    render(<LocaleProvider><App /></LocaleProvider>);
    storageChangeListener?.({
      'runi:settings': { newValue: {} },
    }, 'local');
    expect(chatStore.refreshProvider).toHaveBeenCalled();
  });
  it('sends with browser tools on an available page by default', async () => {
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Summarize this');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith('Summarize this', { withoutBrowserTools: false }));
  });

  it('automatically sends restricted-page messages without browser tools, with no click required', async () => {
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

    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Open settings');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith('Open settings', { withoutBrowserTools: true }));
  });

  it('automatically sends error-status messages without browser tools, with no click required', async () => {
    const user = userEvent.setup();
    chatStore.pageContext = { status: 'error', message: 'Offline' };
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getByText('Page context unavailable: Offline')).toBeVisible();

    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Open settings');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith('Open settings', { withoutBrowserTools: true }));
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

  it('limits empty-state shortcuts to four entries', () => {
    render(
      <LocaleProvider>
        <WorkbenchEmptyState shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getAllByRole('button', { name: /Shortcut/ })).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Shortcut 5' })).not.toBeInTheDocument();
  });

  // 三个内置快捷指令全是读操作，只摆它们会把产品定位成"页面问答"，
  // 代填表单 / 改页面这些真正的差异化能力用户根本发现不了。
  it('展示写操作示例，让空状态不止有读操作', () => {
    render(
      <LocaleProvider>
        <WorkbenchEmptyState
          shortcuts={emptyStateShortcuts}
          busy={false}
          onRunShortcut={vi.fn()}
          onPickExample={vi.fn()}
        />
      </LocaleProvider>,
    );

    expect(screen.getByRole('button', { name: 'Fill in the form on this page for me' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Make the article readable — strip the distractions' })).toBeVisible();
  });

  // 一次误点就动了用户的页面是不可接受的，所以示例只填进输入框、不发送。
  it('点击示例是交给调用方填进输入框，而不是直接执行', async () => {
    const user = userEvent.setup();
    const onPickExample = vi.fn();
    const onRunShortcut = vi.fn();
    render(
      <LocaleProvider>
        <WorkbenchEmptyState
          shortcuts={emptyStateShortcuts}
          busy={false}
          onRunShortcut={onRunShortcut}
          onPickExample={onPickExample}
        />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Fill in the form on this page for me' }));
    expect(onPickExample).toHaveBeenCalledWith('Fill in the form on this page for me');
    expect(onRunShortcut).not.toHaveBeenCalled();
  });

  it('不传 onPickExample 时不展示示例区', () => {
    render(
      <LocaleProvider>
        <WorkbenchEmptyState shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />
      </LocaleProvider>,
    );
    expect(screen.queryByText('Or have me act on the page:')).not.toBeInTheDocument();
  });
});

describe('composer draftSeed', () => {
  it('token 变化时把文字填进输入框，但不发送', () => {
    const onSend = vi.fn();
    const { rerender } = render(<ComposerHarness onSend={onSend} draftSeed={{ text: '', token: 0 }} />);
    const textarea = screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');

    rerender(<ComposerHarness onSend={onSend} draftSeed={{ text: '帮我填好这个表单', token: 1 }} />);

    expect(textarea.value).toBe('帮我填好这个表单');
    expect(onSend).not.toHaveBeenCalled();
  });

  // token 为 0 表示"从未发生过"，不能在挂载时就把 text 灌进去（同 pendingFocusToken 的约定）。
  it('token 为 0 时不动输入框', () => {
    render(<ComposerHarness draftSeed={{ text: '不该出现', token: 0 }} />);
    expect((screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('填入后用户仍可正常编辑', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ComposerHarness draftSeed={{ text: '前缀', token: 0 }} />);
    rerender(<ComposerHarness draftSeed={{ text: '前缀', token: 2 }} />);

    const textarea = screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement;
    await user.type(textarea, '后缀');
    expect(textarea.value).toBe('前缀后缀');
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

  it('only removes a conversation after a second confirming click, not the first', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    renderDrawer(onRemove);

    await user.click(screen.getByRole('button', { name: 'Delete conversation Shopping comparison' }));
    expect(onRemove).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm delete conversation Shopping comparison? Click again to delete.' }));
    expect(onRemove).toHaveBeenCalledWith('shopping');
  });

  it('齿轮按钮直接打开设置，不再经过"更多"菜单', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <LocaleProvider>
        <WorkbenchHeader
          historyOpen={false}
          onToggleHistory={vi.fn()}
          onNewChat={vi.fn()}
          onOpenSettings={onOpenSettings}
        />
      </LocaleProvider>,
    );

    expect(screen.queryByRole('button', { name: 'More options' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  // 用户往上翻历史时，页面遮罩看不见、消息流底部的步骤条被滚走，此前 header 里
  // 没有任何东西能告诉他"还在跑"，停止按钮也只在最底下的输入区里。
  describe('运行状态行', () => {
    function renderHeader(props: Partial<React.ComponentProps<typeof WorkbenchHeader>> = {}) {
      return render(
        <LocaleProvider>
          <WorkbenchHeader
            historyOpen={false}
            onToggleHistory={vi.fn()}
            onNewChat={vi.fn()}
            onOpenSettings={vi.fn()}
            {...props}
          />
        </LocaleProvider>,
      );
    }

    it('空闲时显示品牌名，没有状态行也没有停止按钮', () => {
      renderHeader();
      expect(screen.getByText('Runi')).toBeVisible();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument();
    });

    it('运行时状态行取代品牌名，并给出停止按钮', () => {
      renderHeader({ runStatus: 'Clicking "#pay"', onStop: vi.fn() });
      expect(screen.getByRole('status')).toHaveTextContent('Clicking "#pay"');
      expect(screen.queryByText('Runi')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop generating' })).toBeVisible();
    });

    it('停止按钮转发 onStop', async () => {
      const user = userEvent.setup();
      const onStop = vi.fn();
      renderHeader({ runStatus: 'Reading page', onStop });

      await user.click(screen.getByRole('button', { name: 'Stop generating' }));
      expect(onStop).toHaveBeenCalledOnce();
    });

    // 状态文案跟着工具调用走，一次调用至少两次变化；不节流的话快工具连成一串时会一路抖动。
    it('最小驻留时间内不换字，之后补上最新的一句', async () => {
      vi.useFakeTimers();
      try {
        const { rerender } = renderHeader({ runStatus: '第一步' });
        expect(screen.getByRole('status')).toHaveTextContent('第一步');

        rerender(
          <LocaleProvider>
            <WorkbenchHeader
              historyOpen={false}
              runStatus="第二步"
              onToggleHistory={vi.fn()}
              onNewChat={vi.fn()}
              onOpenSettings={vi.fn()}
            />
          </LocaleProvider>,
        );
        expect(screen.getByRole('status')).toHaveTextContent('第一步');

        // 定时器回调里的 setState 发生在 React 之外，必须包进 act 才会被冲刷到 DOM。
        await act(async () => {
          await vi.advanceTimersByTimeAsync(STATUS_MIN_INTERVAL_MS);
        });
        expect(screen.getByRole('status')).toHaveTextContent('第二步');
      } finally {
        vi.useRealTimers();
      }
    });
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

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Settings' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open Settings. Please try again.');
  });
});
