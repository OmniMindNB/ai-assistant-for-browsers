import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ConversationRecord } from '@/lib/db';
import { useTranslation } from '@/lib/i18n';
import { groupConversationsByDay, type ConversationGroupKey } from '@/lib/workbench/presentation';
import { IconClose, IconPlus, IconTrash } from '../icons';

export interface HistoryDrawerProps {
  open: boolean;
  conversations: ConversationRecord[];
  activeConversationId: string;
  now?: Date;
  onClose(): void;
  onNewChat(): void;
  onPick(id: string): void;
  onRemove(id: string): void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

const groupLabels: Record<ConversationGroupKey, 'workbench.today' | 'workbench.yesterday' | 'workbench.earlier'> = {
  today: 'workbench.today',
  yesterday: 'workbench.yesterday',
  earlier: 'workbench.earlier',
};

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function HistoryDrawer({
  open,
  conversations,
  activeConversationId,
  now = new Date(),
  onClose,
  onNewChat,
  onPick,
  onRemove,
  returnFocusRef,
}: HistoryDrawerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const confirmTimeoutRef = useRef<number | null>(null);
  // 打开的第一帧先按"关闭态"（透明/偏移）渲染，下一帧翻到"打开态"，靠 transition-* 类
  // 过渡出滑入效果。关闭不做退场动画——直接卸载，保持"焦点立刻还给触发按钮、对话框
  // 立刻从 DOM 消失"的既有行为（测试对此有强断言，退场动画得配合延迟卸载会破坏它）。
  const [entered, setEntered] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleConversations = normalizedQuery
    ? conversations.filter((conversation) => conversation.title.toLocaleLowerCase().includes(normalizedQuery))
    : conversations;
  const groups = groupConversationsByDay(visibleConversations, now);

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) returnFocusRef?.current?.focus();
      wasOpenRef.current = false;
      setEntered(false);
      return;
    }
    wasOpenRef.current = true;
    searchRef.current?.focus();
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open, returnFocusRef]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current !== null) window.clearTimeout(confirmTimeoutRef.current);
    };
  }, []);

  // 原生 window.confirm 弹窗与其余自定义 UI 风格割裂（无暗色模式、无法 Tab 走查焦点环），
  // 换成组件内的二次点击确认——跟 ProviderSettings.tsx 删除 Provider 用的是同一套模式。
  function requestDelete(id: string) {
    if (confirmTimeoutRef.current !== null) window.clearTimeout(confirmTimeoutRef.current);
    setConfirmingId(id);
    confirmTimeoutRef.current = window.setTimeout(() => {
      setConfirmingId(null);
      confirmTimeoutRef.current = null;
    }, 3000);
  }

  function removeConversation(conversation: ConversationRecord) {
    if (confirmTimeoutRef.current !== null) {
      window.clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    setConfirmingId(null);
    onRemove(conversation.id);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${entered ? 'opacity-100' : 'opacity-0'}`}
        aria-hidden="true"
      />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench.history')}
        onMouseDown={(event) => event.stopPropagation()}
        className={`relative flex h-full w-[min(22rem,calc(100vw-2rem))] flex-col bg-white text-neutral-700 shadow-xl transition-transform duration-200 ease-out dark:bg-neutral-900 dark:text-neutral-300 ${
          entered ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">{t('workbench.history')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <IconClose className="h-5 w-5" />
          </button>
        </div>
        <div className="border-b border-neutral-200 p-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={onNewChat}
            className="flex w-full items-center gap-2 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
          >
            <IconPlus className="h-4 w-4" /> {t('common.newChat')}
          </button>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('workbench.searchHistory')}
            aria-label={t('workbench.searchHistory')}
            className="mt-3 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
        </div>
        <nav aria-label={t('sidebar.historyLabel')} className="flex-1 overflow-y-auto p-2">
          {groups.length === 0 ? (
            <p className="px-2 py-4 text-xs text-neutral-400 dark:text-neutral-600">{t('sidebar.noHistory')}</p>
          ) : (
            groups.map((group) => (
              <section key={group.key} className="mb-3">
                <h3 className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {t(groupLabels[group.key])}
                </h3>
                <ul className="space-y-0.5">
                  {group.records.map((conversation) => (
                    <li key={conversation.id}>
                      <div className="group flex items-center gap-1 rounded-lg px-2 py-2 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800">
                        <button
                          type="button"
                          aria-current={conversation.id === activeConversationId ? 'page' : undefined}
                          onClick={() => onPick(conversation.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="truncate text-sm text-neutral-800 dark:text-neutral-200">
                            {conversation.title || t('sidebar.untitledConversation')}
                          </div>
                          <div className="truncate text-xs text-neutral-400 dark:text-neutral-500">
                            {new Date(conversation.updatedAt).toLocaleString()}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            confirmingId === conversation.id
                              ? removeConversation(conversation)
                              : requestDelete(conversation.id)
                          }
                          aria-label={
                            confirmingId === conversation.id
                              ? t('sidebar.confirmDeleteConversationAriaLabel', { title: conversation.title || '' })
                              : t('sidebar.deleteConversationAriaLabel', { title: conversation.title || '' })
                          }
                          className={
                            confirmingId === conversation.id
                              ? 'inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-red-600 px-2 text-xs font-medium text-white opacity-100 transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500'
                              : 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-red-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 group-hover:opacity-100 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-red-400'
                          }
                        >
                          <IconTrash className="h-4 w-4 shrink-0" />
                          {confirmingId === conversation.id && (
                            <span className="whitespace-nowrap">{t('provider.confirmDelete')}</span>
                          )}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </nav>
      </aside>
    </div>
  );
}
