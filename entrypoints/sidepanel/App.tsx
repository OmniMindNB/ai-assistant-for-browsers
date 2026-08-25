import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useChat } from './store';

// react-markdown + rehype-highlight 拉入较大的解析/高亮代码，单独分包，
// 避免其阻塞侧边栏首次渲染（消息为空时完全不需要加载）。
const Markdown = lazy(() => import('./Markdown'));
import { nextThemeMode, useTheme } from '@/lib/theme';
import { useTranslation } from '@/lib/i18n';
import { discardedCount, isEditableMessage } from '@/lib/chat/messages';
import { hasBusyAttachments } from '@/lib/chat/attachments';
import { isNearBottom } from '@/lib/scroll';
import {
  resolveShortcut,
  SHORTCUTS_STORAGE_KEY,
  type ShortcutConfig,
} from '@/lib/shortcuts';
import { STORAGE_KEY } from '@/lib/settings';
import MessageEditor from './MessageEditor';
import { HistoryDrawer } from './components/HistoryDrawer';
import { WorkbenchEmptyState } from './components/WorkbenchEmptyState';
import { WorkbenchHeader } from './components/WorkbenchHeader';
import { ActivityStepList } from './components/ActivityStepList';
import { WorkbenchComposer } from './components/WorkbenchComposer';
import { AttachmentChip } from './components/AttachmentChip';
import type { PendingConfirmation, PendingQuestion, UIMessage } from './store';
import { resolvePageAttached, type ResolvedShortcutCommand } from '@/lib/workbench/presentation';
import {
  IconChevronDown,
  IconPencil,
} from './icons';

export default function App() {
  const {
    messages,
    activitySteps,
    input,
    pendingFocusToken,
    quotedSelection,
    pendingAttachments,
    busy,
    error,
    pendingConfirmation,
    pendingQuestion,
    providers,
    selectedProviderId,
    selectedModel,
    conversations,
    conversationId,
    shortcuts,
    shortcutErrors,
    pageContext,
    setInput,
    clearQuotedSelection,
    addAttachmentFiles,
    removeAttachment,
    retryAttachment,
    disposeAttachments,
    refreshProvider,
    refreshShortcuts,
    refreshConversations,
    refreshPageContext,
    selectProviderAndModel,
    send,
    editMessage,
    runShortcut,
    stop,
    clear,
    openConversation,
    removeConversation,
    respondToConfirmation,
    respondToQuestion,
    restoreTabConversation,
  } = useChat();

  const { mode: themeMode, resolved: themeResolved, setMode: setThemeMode } = useTheme();
  const { t } = useTranslation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
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
  const requestBlocked = busy || hasBusyAttachments(pendingAttachments);

  useEffect(() => {
    refreshProvider();
    refreshShortcuts();
    refreshConversations();
    refreshPageContext();
    restoreTabConversation();
  }, [
    refreshProvider,
    refreshShortcuts,
    refreshConversations,
    refreshPageContext,
    restoreTabConversation,
  ]);

  useEffect(() => () => disposeAttachments(), [disposeAttachments]);

  useEffect(() => {
    const listener = (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      if (SHORTCUTS_STORAGE_KEY in changes) void refreshShortcuts();
      if (STORAGE_KEY in changes) void refreshProvider();
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
    if (requestBlocked) return;
    resetToFollowing();
    const ok = await editMessage(id, content);
    if (ok) setEditingId(null);
  }

  useEffect(() => {
    if (atBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages, activitySteps]);

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
    const attached = resolvePageAttached(pageContext.status);
    await send(undefined, { withoutBrowserTools: !attached });
  }

  function executeShortcut(shortcut: ShortcutConfig) {
    if (requestBlocked) return;
    resetToFollowing();
    runShortcut(shortcut);
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
    setThemeMode(nextThemeMode(themeMode, themeResolved));
  }

  function newChat() {
    clear();
    setHistoryOpen(false);
  }

  async function pickConversation(id: string) {
    if (await openConversation(id)) {
      setHistoryOpen(false);
    }
  }

  const hasRunningActivityStep = activitySteps.some((step) => step.status === 'running');

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

          <div className="relative flex-1 overflow-hidden">
            <main ref={scrollRef} className="h-full overflow-y-auto">
              <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-6 px-4 py-6">
                {messages.length === 0 ? (
                  <WorkbenchEmptyState
                    shortcuts={resolvedShortcuts}
                    busy={requestBlocked}
                    onRunShortcut={executeShortcut}
                  />
                ) : (
                  messages.map((m, i) => (
                    <Message
                      key={m.id}
                      message={m}
                      busy={busy}
                      requestBlocked={requestBlocked}
                      showThinkingIndicator={
                        i === messages.length - 1 &&
                        busy &&
                        !pendingConfirmation &&
                        !pendingQuestion &&
                        !hasRunningActivityStep
                      }
                      editing={editingId === m.id}
                      discardCount={editingId === m.id ? discardedCount(messages, m.id) : 0}
                      onBeginEdit={() => setEditingId(m.id)}
                      onCancelEdit={() => setEditingId(null)}
                      onSubmitEdit={(content) => submitEdit(m.id, content)}
                    />
                  ))
                )}
                {activitySteps.length > 0 && !pendingConfirmation && !pendingQuestion && (
                  <ActivityStepList steps={activitySteps} />
                )}
                {pendingConfirmation && (
                  <ConfirmationCard
                    confirmation={pendingConfirmation}
                    onApprove={() => respondToConfirmation(true)}
                    onDeny={() => respondToConfirmation(false)}
                  />
                )}
                {pendingQuestion && (
                  <QuestionCard question={pendingQuestion} onSubmit={respondToQuestion} />
                )}
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

          <WorkbenchComposer
            input={input}
            busy={busy}
            pageContext={pageContext}
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            pendingFocusToken={pendingFocusToken}
            quotedSelection={quotedSelection}
            attachments={pendingAttachments}
            onInput={setInput}
            onSend={submitMessage}
            onStop={stop}
            shortcuts={resolvedShortcuts}
            onRetryPageContext={refreshPageContext}
            onRunShortcut={executeShortcut}
            onSelectProviderModel={selectProviderAndModel}
            onClearQuotedSelection={clearQuotedSelection}
            onAddAttachmentFiles={addAttachmentFiles}
            onRemoveAttachment={removeAttachment}
            onRetryAttachment={retryAttachment}
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
  requestBlocked,
  showThinkingIndicator,
  editing,
  discardCount,
  onBeginEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: UIMessage;
  busy: boolean;
  requestBlocked: boolean;
  showThinkingIndicator: boolean;
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
              disabled={requestBlocked}
              onCancel={onCancelEdit}
              onSubmit={onSubmitEdit}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-end gap-1">
        {message.quotedText && (
          <div
            role="note"
            aria-label={t('workbench.quotedSelectionLabel')}
            className="max-w-[85%] rounded-xl border-l-2 border-indigo-400 bg-neutral-100 px-3 py-1.5 dark:border-indigo-500 dark:bg-neutral-900"
          >
            <p className="line-clamp-3 text-xs text-neutral-500 dark:text-neutral-400">{message.quotedText}</p>
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {message.attachments.map((attachment) => (
              <AttachmentChip key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}
        <div className="group flex items-center gap-1.5">
          {!requestBlocked && isEditableMessage(message) && (
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
        R
      </div>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-white px-4 py-3 shadow-sm ring-1 ring-neutral-200/70 dark:bg-neutral-900 dark:ring-neutral-800">
        {content ? (
          <Suspense fallback={<span className="whitespace-pre-wrap">{content}</span>}>
            <Markdown content={content} />
          </Suspense>
        ) : busy ? (
          <TypingDots />
        ) : null}
        {content && showThinkingIndicator && (
          <div className="mt-1">
            <TypingDots />
          </div>
        )}
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
      <p className="mb-2 whitespace-pre-line text-amber-900/90 dark:text-amber-200/90">{confirmation.summary}</p>
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

function QuestionCard({
  question,
  onSubmit,
}: {
  question: PendingQuestion;
  onSubmit: (answer: string) => void;
}) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState('');

  const submit = () => {
    const trimmed = answer.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setAnswer('');
  };

  return (
    <div className="rounded-xl border border-indigo-300 bg-indigo-50 p-3 text-sm dark:border-indigo-900/60 dark:bg-indigo-950/30">
      <div className="mb-2 flex items-center gap-2 font-medium text-indigo-900 dark:text-indigo-200">
        {t('askUser.title')}
      </div>
      <p className="mb-2 whitespace-pre-line text-indigo-900/90 dark:text-indigo-200/90">{question.question}</p>
      <div className="flex gap-2">
        <input
          autoFocus
          type="text"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder={t('askUser.placeholder')}
          className="min-w-0 flex-1 rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-xs text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-indigo-800 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <button
          onClick={submit}
          disabled={!answer.trim()}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {t('askUser.submit')}
        </button>
      </div>
    </div>
  );
}
