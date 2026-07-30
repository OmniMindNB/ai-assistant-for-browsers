import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useChat } from './store';

// react-markdown + rehype-highlight 拉入较大的解析/高亮代码，单独分包，
// 避免其阻塞侧边栏首次渲染（消息为空时完全不需要加载）。
const Markdown = lazy(() => import('./Markdown'));
import { useTheme } from '@/lib/theme';
import { useTranslation, type Translate } from '@/lib/i18n';
import { providerModels, type ProviderConfig } from '@/lib/settings';
import { discardedCount, isEditableMessage } from '@/lib/chat/messages';
import { isNearBottom } from '@/lib/scroll';
import {
  resolveShortcut,
  SHORTCUTS_STORAGE_KEY,
  splitShortcutList,
  type ResolvedShortcut,
  type ShortcutConfig,
} from '@/lib/shortcuts';
import MessageEditor from './MessageEditor';
import { HistoryDrawer } from './components/HistoryDrawer';
import { ModeSwitch } from './components/ModeSwitch';
import { PageContextBar } from './components/PageContextBar';
import { WorkbenchEmptyState } from './components/WorkbenchEmptyState';
import { WorkbenchHeader } from './components/WorkbenchHeader';
import type { PendingConfirmation, ToolActivity, UIMessage } from './store';
import type { WorkbenchMode } from '@/lib/workbench/preferences';
import type { ResolvedShortcutCommand } from '@/lib/workbench/presentation';
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconPencil,
  IconSend,
  IconSparkles,
  IconStop,
} from './icons';

export default function App() {
  const {
    messages,
    toolActivities,
    input,
    busy,
    error,
    pendingConfirmation,
    turnHasChanges,
    providers,
    selectedProviderId,
    selectedModel,
    conversations,
    conversationId,
    shortcuts,
    shortcutErrors,
    pageContext,
    workbenchPreferences,
    setInput,
    refreshProvider,
    refreshShortcuts,
    refreshConversations,
    refreshPageContext,
    refreshWorkbenchPreferences,
    selectProviderAndModel,
    send,
    editMessage,
    runShortcut,
    stop,
    clear,
    openConversation,
    removeConversation,
    respondToConfirmation,
    revertTurnChanges,
    restoreTabConversation,
  } = useChat();

  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const { t } = useTranslation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mode, setMode] = useState<WorkbenchMode>('ask');
  const [pageAttached, setPageAttached] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  // 是否仍处于“跟随最新内容”状态；用户向上滚动后置 false，直到手动回到底部或发起新一轮。
  const atBottomRef = useRef(true);
  const busyRef = useRef(busy);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const resolvedShortcuts: ResolvedShortcutCommand[] = shortcuts.map((config) => ({
    config,
    resolved: resolveShortcut(config, t),
  }));

  useEffect(() => {
    refreshProvider();
    refreshShortcuts();
    refreshConversations();
    refreshPageContext();
    refreshWorkbenchPreferences();
    restoreTabConversation();
  }, [
    refreshProvider,
    refreshShortcuts,
    refreshConversations,
    refreshPageContext,
    refreshWorkbenchPreferences,
    restoreTabConversation,
  ]);

  useEffect(() => {
    const isNewEmptyConversation =
      messages.length === 0 && input.trim().length === 0 && !busy && !pendingConfirmation && toolActivities.length === 0;
    if (!isNewEmptyConversation) return;
    setMode(workbenchPreferences.defaultMode);
    setPageAttached(workbenchPreferences.attachPageByDefault);
  }, [busy, input, messages.length, pendingConfirmation, toolActivities.length, workbenchPreferences]);

  useEffect(() => {
    const listener = (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName === 'local' && SHORTCUTS_STORAGE_KEY in changes) {
        refreshShortcuts();
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [refreshShortcuts]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = isNearBottom(el);
      atBottomRef.current = atBottom;
      setShowJumpToBottom(!atBottom && busyRef.current);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 切换会话 / 新建会话 / 删除当前会话时，关闭尚未提交的编辑框，并回到“跟随最新内容”状态。
  useEffect(() => {
    setEditingId(null);
    resetToFollowing();
  }, [conversationId]);

  async function submitEdit(id: string, content: string) {
    // 只有 editMessage 真正成功发起（截断+提交）才关闭编辑框；busy / id 未命中 /
    // 不可编辑 / 空内容 / Provider 未配置 / API Key 缺失 / 标签页解析失败等前置失败
    // 都会返回 false，此时编辑框保持打开、用户刚敲的内容原样保留，页面上方的
    // error 提示负责说明失败原因，不在编辑框里再加一套错误 UI。
    resetToFollowing();
    const ok = await editMessage(id, content);
    if (ok) setEditingId(null);
  }

  useEffect(() => {
    if (atBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages, toolActivities]);

  function resetToFollowing() {
    atBottomRef.current = true;
    setShowJumpToBottom(false);
  }

  function jumpToBottom() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    atBottomRef.current = true;
    setShowJumpToBottom(false);
  }

  async function submitMessage() {
    resetToFollowing();
    await send(undefined, pageAttached ? undefined : { withoutBrowserTools: true });
    if (!pageAttached) setPageAttached(workbenchPreferences.attachPageByDefault);
  }

  function executeShortcut(shortcut: ShortcutConfig) {
    resetToFollowing();
    runShortcut(shortcut);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  }

  function toggleHistory() {
    setHistoryOpen((prev) => {
      const next = !prev;
      if (next) refreshConversations();
      return next;
    });
  }

  async function openSettings() {
    try {
      await browser.runtime.openOptionsPage();
      setSettingsError(null);
    } catch {
      setSettingsError(t('settings.openOptionsFailed'));
    }
  }

  function toggleTheme() {
    const next = themeMode === 'auto' ? 'light' : themeMode === 'light' ? 'dark' : 'auto';
    setThemeMode(next);
  }

  function newChat() {
    clear();
    setHistoryOpen(false);
    setMode(workbenchPreferences.defaultMode);
    setPageAttached(workbenchPreferences.attachPageByDefault);
  }

  function pickConversation(id: string) {
    openConversation(id);
    setHistoryOpen(false);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <HistoryDrawer
        open={historyOpen}
        conversations={conversations}
        activeConversationId={conversationId}
        onClose={() => setHistoryOpen(false)}
        onNewChat={newChat}
        onPick={pickConversation}
        onRemove={removeConversation}
        returnFocusRef={historyTriggerRef}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
          <WorkbenchHeader
            historyOpen={historyOpen}
            onToggleHistory={toggleHistory}
            onNewChat={newChat}
            onOpenSettings={openSettings}
            onToggleTheme={toggleTheme}
            historyTriggerRef={historyTriggerRef}
          />

          {settingsError && (
            <div
              role="alert"
              className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
            >
              {settingsError}
            </div>
          )}

          {providers.length === 0 && <ProviderBanner onOpenSettings={openSettings} />}

          <PageContextBar
            context={pageContext}
            attached={pageAttached}
            onToggleAttached={() => setPageAttached((attached) => !attached)}
            onRetry={refreshPageContext}
          />

          <div className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
            <ModeSwitch mode={mode} onChange={setMode} />
          </div>

          <div className="relative flex-1 overflow-hidden">
            <main ref={scrollRef} className="h-full overflow-y-auto">
              <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-6 px-4 py-6">
                {messages.length === 0 ? (
                  <WorkbenchEmptyState
                    mode={mode}
                    shortcuts={resolvedShortcuts}
                    busy={busy}
                    onRunShortcut={executeShortcut}
                  />
                ) : (
                  messages.map((m) => (
                    <Message
                      key={m.id}
                      message={m}
                      busy={busy}
                      editing={editingId === m.id}
                      discardCount={editingId === m.id ? discardedCount(messages, m.id) : 0}
                      onBeginEdit={() => setEditingId(m.id)}
                      onCancelEdit={() => setEditingId(null)}
                      onSubmitEdit={(content) => submitEdit(m.id, content)}
                    />
                  ))
                )}
                {toolActivities.length > 0 && <ToolActivityList activities={toolActivities} />}
                {pendingConfirmation && (
                  <ConfirmationCard
                    confirmation={pendingConfirmation}
                    onApprove={() => respondToConfirmation(true)}
                    onDeny={() => respondToConfirmation(false)}
                  />
                )}
                {!busy && !pendingConfirmation && turnHasChanges && <UndoBar onRevert={revertTurnChanges} />}
                {error && (
                  <div
                    role="alert"
                    className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
                  >
                    {error}
                  </div>
                )}
                {shortcutErrors.length > 0 && (
                  <div
                    role="alert"
                    className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
                  >
                    {t('chat.shortcutConfigError')}
                  </div>
                )}
              </div>
            </main>
            {busy && showJumpToBottom && (
              <button
                type="button"
                onClick={jumpToBottom}
                className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-lg transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <IconChevronDown className="h-3.5 w-3.5" />
                {t('chat.jumpToBottom')}
              </button>
            )}
          </div>

          <Composer
            input={input}
            busy={busy}
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            setInput={setInput}
            onKeyDown={onKeyDown}
            onSend={() => submitMessage()}
            onStop={stop}
            shortcuts={resolvedShortcuts}
            onRunShortcut={executeShortcut}
            onSelectProviderModel={selectProviderAndModel}
          />
      </div>
    </div>
  );
}

function ProviderBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
      <span>{t('banner.noProviderPrefix')}</span>
      <button
        onClick={onOpenSettings}
        className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
      >
        {t('common.settings')}
      </button>
      <span>{t('banner.noProviderSuffix')}</span>
    </div>
  );
}

/* ---------------- 消息区 ---------------- */

function Message({
  message,
  busy,
  editing,
  discardCount,
  onBeginEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: UIMessage;
  busy: boolean;
  editing: boolean;
  discardCount: number;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (content: string) => void;
}) {
  const { t } = useTranslation();
  const { role, content } = message;

  if (role === 'user') {
    if (editing) {
      return (
        <div className="flex justify-end">
          <div className="w-full max-w-[85%]">
            <MessageEditor
              initialContent={content}
              discardCount={discardCount}
              onCancel={onCancelEdit}
              onSubmit={onSubmitEdit}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="group flex items-center justify-end gap-1.5">
        {!busy && isEditableMessage(message) && (
          <button
            type="button"
            onClick={onBeginEdit}
            aria-label={t('chat.editMessageAriaLabel')}
            title={t('chat.editMessageAriaLabel')}
            // 只挂 hover 会让这个功能对键盘用户不存在，因此同时响应 focus-visible。
            className="shrink-0 rounded-md p-1.5 text-neutral-400 opacity-0 transition-opacity hover:text-neutral-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 group-hover:opacity-100 dark:hover:text-neutral-200"
          >
            <IconPencil className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-neutral-900 px-4 py-2.5 text-sm text-white dark:bg-neutral-700">
          {content}
        </div>
      </div>
    );
  }
  // 会话中段的空 assistant 占位（例如第一个 token 到达前中止了一轮，随后又发了新消息）
  // 是 toMessageRecords 设计明确要保留的（承载轮次结构），但渲染层没有理由把它画出来：
  // 非 busy 且无内容时整行都不渲染，避免出现「一个头像 + 一张空卡片」。
  // busy && !content（当前这一轮还没收到首个 token）必须继续走下面的 TypingDots 分支。
  if (!busy && !content) return null;
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-neutral-900 text-[11px] font-bold text-white dark:bg-neutral-800">
        Al
      </div>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-white px-4 py-3 shadow-sm ring-1 ring-neutral-200/70 dark:bg-neutral-900 dark:ring-neutral-800">
        {content ? (
          <Suspense fallback={<span className="whitespace-pre-wrap">{content}</span>}>
            <Markdown content={content} />
          </Suspense>
        ) : busy ? (
          <TypingDots />
        ) : null}
      </div>
    </div>
  );
}

function TypingDots() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label={t('chat.generatingAriaLabel')}>
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.3s] motion-reduce:animate-none dark:bg-neutral-500" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.15s] motion-reduce:animate-none dark:bg-neutral-500" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 motion-reduce:animate-none dark:bg-neutral-500" />
    </span>
  );
}

function ToolActivityList({ activities }: { activities: ToolActivity[] }) {
  const { t } = useTranslation();
  const running = activities.filter((a) => a.status === 'running' || a.status === 'confirming').length;
  return (
    <details className="group rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-300">
        <IconChevronRight className="h-3.5 w-3.5 text-neutral-400 transition-transform group-open:rotate-90 dark:text-neutral-500" />
        <span className="font-medium text-neutral-700 dark:text-neutral-200">{t('chat.toolCallsLabel')}</span>
        <span className="text-neutral-400 dark:text-neutral-500">
          · {activities.length}
          {running ? t('chat.toolCallsRunningSuffix', { count: running }) : ''}
        </span>
      </summary>
      <ul className="space-y-1 border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
        {activities.map((a) => (
          <li key={a.id} className="flex items-start gap-2 text-xs">
            <span className={statusColor(a.status)}>{statusLabel(a.status, t)}</span>
            <span className="min-w-0 flex-1">
              <span className="font-mono text-[11px] text-neutral-700 dark:text-neutral-300">{a.name}</span>
              {a.detail && (
                <span className="ml-1 break-all text-neutral-400 dark:text-neutral-500">{a.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ConfirmationCard({
  confirmation,
  onApprove,
  onDeny,
}: {
  confirmation: PendingConfirmation;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="mb-2 flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
        {t('confirm.title')}
      </div>
      <p className="mb-2 text-amber-900/90 dark:text-amber-200/90">{confirmation.summary}</p>
      {confirmation.codePreview && (
        <pre className="mb-2 max-h-40 overflow-auto rounded-lg bg-neutral-900/90 p-2 text-[11px] text-neutral-100">
          {confirmation.codePreview}
        </pre>
      )}
      <div className="flex gap-2">
        <button
          onClick={onApprove}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {t('confirm.approve')}
        </button>
        <button
          onClick={onDeny}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('confirm.deny')}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-amber-800/70 dark:text-amber-300/60">
        {t('confirm.approveHint')}
      </p>
    </div>
  );
}

function UndoBar({ onRevert }: { onRevert: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <span className="text-emerald-600 dark:text-emerald-400">{t('confirm.undoBarStatus')}</span>
      <button
        onClick={onRevert}
        className="font-medium text-red-600 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-red-400"
      >
        {t('confirm.undoBarButton')}
      </button>
    </div>
  );
}

function statusLabel(status: ToolActivity['status'], t: Translate): string {
  switch (status) {
    case 'running':
      return t('status.running');
    case 'confirming':
      return t('status.confirming');
    case 'blocked':
      return t('status.blocked');
    case 'error':
      return t('status.error');
    default:
      return t('status.done');
  }
}

function statusColor(status: ToolActivity['status']): string {
  switch (status) {
    case 'running':
      return 'text-blue-500';
    case 'confirming':
      return 'text-amber-600 dark:text-amber-500';
    case 'blocked':
      return 'text-amber-600 dark:text-amber-500';
    case 'error':
      return 'text-red-500';
    default:
      return 'text-emerald-600 dark:text-emerald-400';
  }
}

/* ---------------- 输入区 ---------------- */

function Composer({
  input,
  busy,
  providers,
  selectedProviderId,
  selectedModel,
  setInput,
  onKeyDown,
  onSend,
  onStop,
  shortcuts,
  onRunShortcut,
  onSelectProviderModel,
}: {
  input: string;
  busy: boolean;
  providers: ProviderConfig[];
  selectedProviderId: string | null;
  selectedModel: string;
  setInput: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  shortcuts: Array<{ config: ShortcutConfig; resolved: ResolvedShortcut }>;
  onRunShortcut: (shortcut: ShortcutConfig) => void;
  onSelectProviderModel: (providerId: string, model: string) => void;
}) {
  const { t } = useTranslation();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const canSend = input.trim().length > 0 && !busy;

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  return (
    <div className="border-t border-neutral-200 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {providers.length > 0 && (
            <ModelPicker
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              onSelect={onSelectProviderModel}
            />
          )}
          <ShortcutBar shortcuts={shortcuts} busy={busy} onRun={onRunShortcut} />
        </div>
        <div className="flex items-end gap-2 rounded-2xl border border-neutral-300 bg-white p-2 shadow-sm transition-colors focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/30 dark:border-neutral-700 dark:bg-neutral-900">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            aria-label={t('chat.composerAriaLabel')}
            placeholder={t('chat.composerPlaceholder')}
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-100 dark:placeholder:text-neutral-600"
          />
          {busy ? (
            <button
              onClick={onStop}
              aria-label={t('chat.stopGenerating')}
              title={t('chat.stopGenerating')}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-white transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-neutral-700 dark:hover:bg-neutral-600"
            >
              <IconStop className="h-5 w-5" />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!canSend}
              aria-label={t('chat.sendMessage')}
              title={t('chat.sendMessage')}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-600"
            >
              <IconSend className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ShortcutBar({
  shortcuts,
  busy,
  onRun,
}: {
  shortcuts: Array<{ config: ShortcutConfig; resolved: ResolvedShortcut }>;
  busy: boolean;
  onRun: (shortcut: ShortcutConfig) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { visible, overflow } = splitShortcutList(shortcuts, 3);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (overflow.length === 0 || busy) setOpen(false);
  }, [busy, overflow.length]);

  function openAndFocus(index: number) {
    setOpen(true);
    requestAnimationFrame(() => itemRefs.current[index]?.focus());
  }

  function moveMenuFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = (index + 1) % overflow.length;
    if (event.key === 'ArrowUp') nextIndex = (index - 1 + overflow.length) % overflow.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = overflow.length - 1;
    if (nextIndex !== undefined) {
      event.preventDefault();
      itemRefs.current[nextIndex]?.focus();
    }
  }

  if (shortcuts.length === 0) return null;

  return (
    <div ref={ref} className="relative flex flex-wrap items-center gap-2">
      {visible.map(({ config, resolved }) => (
        <Chip
          key={config.id}
          onClick={() => onRun(config)}
          disabled={busy}
          icon={<IconSparkles className="h-3.5 w-3.5" />}
          label={resolved.name}
        />
      ))}
      {overflow.length > 0 && (
        <>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                openAndFocus(0);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                openAndFocus(overflow.length - 1);
              }
            }}
            disabled={busy}
            aria-label={t('chat.moreShortcutsAriaLabel', { count: overflow.length })}
            aria-haspopup="menu"
            aria-expanded={open}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <span className="text-neutral-500 dark:text-neutral-400">
              <IconChevronDown className="h-3.5 w-3.5" />
            </span>
            {t('chat.moreShortcuts', { count: overflow.length })}
          </button>
          {open && (
            <div
              role="menu"
              className="absolute bottom-full left-0 z-20 mb-2 w-64 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
            >
              {overflow.map(({ config, resolved }, index) => (
                <button
                  key={config.id}
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  title={resolved.name}
                  aria-label={resolved.name}
                  onKeyDown={(event) => moveMenuFocus(event, index)}
                  onClick={() => {
                    setOpen(false);
                    onRun(config);
                  }}
                  className="block w-full truncate rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-neutral-800"
                >
                  {resolved.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ModelPicker({
  providers,
  selectedProviderId,
  selectedModel,
  onSelect,
}: {
  providers: ProviderConfig[];
  selectedProviderId: string | null;
  selectedModel: string;
  onSelect: (providerId: string, model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const { t } = useTranslation();
  const selected = providers.find((p) => p.id === selectedProviderId);
  const currentModel = selectedModel || selected?.model || '';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('chat.selectProviderModelAriaLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex max-w-[60vw] items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
      >
        {selected && <span className="shrink-0 text-neutral-400 dark:text-neutral-500">{selected.name}</span>}
        <span className="truncate font-medium text-neutral-700 dark:text-neutral-200">{currentModel || t('chat.noModelSelected')}</span>
        <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-20 mb-2 max-h-72 w-64 overflow-auto rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          {providers.map((p) => {
            const models = providerModels(p);
            return (
              <div key={p.id} className="py-1">
                <div className="px-2 py-1 text-xs font-medium text-neutral-400 dark:text-neutral-500">
                  {p.name}
                </div>
                {models.map((m) => {
                  const active = p.id === selectedProviderId && m === currentModel;
                  return (
                    <button
                      key={m}
                      role="menuitem"
                      onClick={() => {
                        onSelect(p.id, m);
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {active && <IconCheck className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />}
                      </span>
                      <span className="truncate">{m}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chip({
  onClick,
  disabled,
  icon,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex max-w-[10rem] cursor-pointer items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
    >
      <span className="shrink-0 text-neutral-500 dark:text-neutral-400">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
