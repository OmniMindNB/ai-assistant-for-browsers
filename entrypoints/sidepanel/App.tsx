import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useChat } from './store';

// react-markdown + rehype-highlight 拉入较大的解析/高亮代码，单独分包，
// 避免其阻塞侧边栏首次渲染（消息为空时完全不需要加载）。
const Markdown = lazy(() => import('./Markdown'));
import ProviderSettings from '@/components/ProviderSettings';
import AppearanceSettings from '@/components/AppearanceSettings';
import { useTheme, type ThemeMode } from '@/lib/theme';
import { providerModels, type ProviderConfig } from '@/lib/settings';
import type { ConversationRecord } from '@/lib/db';
import type { PendingConfirmation, ToolActivity } from './store';
import {
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconFileText,
  IconGear,
  IconMenu,
  IconMessage,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconSend,
  IconSparkles,
  IconStop,
  IconSun,
  IconTrash,
} from './icons';

const SIDEBAR_BREAKPOINT = 768; // md；窄屏侧边栏改为抽屉覆盖

type View = 'chat' | 'settings';

export default function App() {
  const {
    messages,
    toolActivities,
    input,
    busy,
    error,
    pendingConfirmation,
    turnHasChanges,
    userScriptsWait,
    providers,
    selectedProviderId,
    selectedModel,
    conversations,
    setInput,
    refreshProvider,
    refreshConversations,
    selectProviderAndModel,
    send,
    summarizePage,
    explainSelection,
    stop,
    clear,
    openConversation,
    removeConversation,
    respondToConfirmation,
    revertTurnChanges,
    restoreTabConversation,
  } = useChat();

  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const [view, setView] = useState<View>('chat');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= SIDEBAR_BREAKPOINT : false,
  );
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < SIDEBAR_BREAKPOINT : false,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const selectedProvider =
    providers.find((p) => p.id === selectedProviderId) ?? providers[0] ?? null;

  useEffect(() => {
    refreshProvider();
    refreshConversations();
    restoreTabConversation();
  }, [refreshProvider, refreshConversations, restoreTabConversation]);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < SIDEBAR_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, toolActivities]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function toggleSidebar() {
    setSidebarOpen((prev) => {
      const next = !prev;
      if (next) refreshConversations();
      return next;
    });
  }

  function openSettings() {
    setView('settings');
    refreshProvider();
    if (narrow) setSidebarOpen(false);
  }

  function newChat() {
    clear();
    setView('chat');
    if (narrow) setSidebarOpen(false);
  }

  function pickConversation(id: string) {
    openConversation(id);
    setView('chat');
    if (narrow) setSidebarOpen(false);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {sidebarOpen && narrow && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <Sidebar
        open={sidebarOpen}
        conversations={conversations}
        provider={selectedProvider}
        themeMode={themeMode}
        onSetTheme={setThemeMode}
        onClose={() => setSidebarOpen(false)}
        onNewChat={newChat}
        onPick={pickConversation}
        onRemove={removeConversation}
        onOpenSettings={openSettings}
      />

      {view === 'settings' ? (
        <SettingsView
          themeMode={themeMode}
          onSetTheme={setThemeMode}
          onBack={() => setView('chat')}
          onChange={refreshProvider}
        />
      ) : (
        <div className="relative flex min-w-0 flex-1 flex-col">
          <TopBar
            provider={selectedProvider}
            selectedModel={selectedModel}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={toggleSidebar}
            onNewChat={newChat}
          />

          {providers.length === 0 && <ProviderBanner onOpenSettings={openSettings} />}

          <main ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-6 px-4 py-6">
              {messages.length === 0 ? (
                <EmptyState busy={busy} onSummarize={summarizePage} onExplain={explainSelection} />
              ) : (
                messages.map((m, i) => (
                  <Message key={i} role={m.role} content={m.content} busy={busy} />
                ))
              )}
              {toolActivities.length > 0 && <ToolActivityList activities={toolActivities} />}
              {userScriptsWait && (
                <UserScriptsBlockedNotice
                  attempts={userScriptsWait.attempts}
                  elapsedSeconds={userScriptsWait.elapsedSeconds}
                  onOpenSettings={() =>
                    browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` })
                  }
                  onCancelWait={stop}
                />
              )}
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
            </div>
          </main>

          <Composer
            input={input}
            busy={busy}
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            setInput={setInput}
            onKeyDown={onKeyDown}
            onSend={() => send()}
            onStop={stop}
            onSummarize={summarizePage}
            onExplain={explainSelection}
            onSelectProviderModel={selectProviderAndModel}
          />
        </div>
      )}
    </div>
  );
}

/* ---------------- 侧边栏 ---------------- */

function Sidebar({
  open,
  conversations,
  provider,
  themeMode,
  onSetTheme,
  onClose,
  onNewChat,
  onPick,
  onRemove,
  onOpenSettings,
}: {
  open: boolean;
  conversations: ConversationRecord[];
  provider: ProviderConfig | null;
  themeMode: ThemeMode;
  onSetTheme: (m: ThemeMode) => void;
  onClose: () => void;
  onNewChat: () => void;
  onPick: (id: string) => void;
  onRemove: (id: string) => void;
  onOpenSettings: () => void;
}) {
  return (
    <aside
      aria-label="会话与设置"
      className={[
        'z-40 flex h-full flex-col overflow-hidden bg-white text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300',
        'transition-[width,transform] duration-200 ease-out motion-reduce:transition-none',
        'fixed inset-y-0 left-0 md:static',
        open ? 'translate-x-0 md:w-72' : '-translate-x-full md:w-0',
      ].join(' ')}
    >
      <div className="flex h-full w-72 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900 text-xs font-bold text-white dark:bg-neutral-800">
            Al
          </div>
          <span className="text-sm font-semibold text-neutral-900 dark:text-white">Aluminum</span>
          <button
            onClick={onClose}
            aria-label="收起侧边栏"
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white md:hidden"
          >
            <IconClose className="h-5 w-5" />
          </button>
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={onNewChat}
            className="flex w-full items-center gap-2 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
          >
            <IconPlus className="h-4 w-4" /> 新对话
          </button>
        </div>

        <nav aria-label="历史会话" className="flex-1 overflow-y-auto px-2 py-2">
          <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            历史会话
          </div>
          {conversations.length === 0 ? (
            <p className="px-2 py-4 text-xs text-neutral-400 dark:text-neutral-600">暂无历史会话</p>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((c) => (
                <ConversationItem key={c.id} c={c} onPick={onPick} onRemove={onRemove} />
              ))}
            </ul>
          )}
        </nav>

        <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
          <div className="mb-2 flex items-center gap-2 px-1 text-xs text-neutral-500 dark:text-neutral-400">
            <span
              className={[
                'h-2 w-2 shrink-0 rounded-full',
                provider?.apiKey ? 'bg-emerald-500' : 'bg-neutral-400 dark:bg-neutral-600',
              ].join(' ')}
            />
            <span className="truncate">{provider ? provider.name : '未配置 Provider'}</span>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle mode={themeMode} onSet={onSetTheme} />
            <button
              onClick={onOpenSettings}
              className="flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
            >
              <IconGear className="h-4 w-4" /> 设置
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function ThemeToggle({ mode, onSet }: { mode: ThemeMode; onSet: (m: ThemeMode) => void }) {
  const next: ThemeMode = mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
  const label = mode === 'auto' ? '跟随浏览器' : mode === 'light' ? '浅色' : '深色';
  return (
    <button
      onClick={() => onSet(next)}
      aria-label={`主题：${label}，点击切换`}
      title={`主题：${label}`}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
    >
      {mode === 'auto' ? (
        <IconMonitor className="h-5 w-5" />
      ) : mode === 'light' ? (
        <IconSun className="h-5 w-5" />
      ) : (
        <IconMoon className="h-5 w-5" />
      )}
    </button>
  );
}

function ConversationItem({
  c,
  onPick,
  onRemove,
}: {
  c: ConversationRecord;
  onPick: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <li>
      <div className="group flex items-center gap-1 rounded-lg px-2 py-2 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800">
        <button onClick={() => onPick(c.id)} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm text-neutral-800 dark:text-neutral-200">
            {c.title || '未命名会话'}
          </div>
          <div className="truncate text-xs text-neutral-400 dark:text-neutral-500">
            {new Date(c.updatedAt).toLocaleString()}
          </div>
        </button>
        <button
          onClick={() => onRemove(c.id)}
          aria-label={`删除会话 ${c.title || ''}`}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-red-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 group-hover:opacity-100 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-red-400"
        >
          <IconTrash className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}

/* ---------------- 顶栏 ---------------- */

function TopBar({
  provider,
  selectedModel,
  sidebarOpen,
  onToggleSidebar,
  onNewChat,
}: {
  provider: ProviderConfig | null;
  selectedModel: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
}) {
  return (
    <header className="flex items-center gap-1 border-b border-neutral-200 bg-neutral-50/80 px-2 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
      <button
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
      >
        <IconMenu className="h-5 w-5" />
      </button>
      <div className="flex min-w-0 items-center gap-2 px-1">
        <span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Aluminum
        </span>
        {provider && (
          <>
            <span className="hidden text-neutral-300 sm:inline dark:text-neutral-700">·</span>
            <span className="hidden truncate text-xs text-neutral-500 sm:inline dark:text-neutral-400">
              {selectedModel || provider.model}
            </span>
          </>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={onNewChat}
          aria-label="新对话"
          title="新对话"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        >
          <IconPlus className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}

function ProviderBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
      <span>未检测到模型 Provider，请前往</span>
      <button
        onClick={onOpenSettings}
        className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
      >
        设置
      </button>
      <span>填写 API Key。</span>
    </div>
  );
}

/* ---------------- 设置视图 ---------------- */

function SettingsView({
  themeMode,
  onSetTheme,
  onBack,
  onChange,
}: {
  themeMode: ThemeMode;
  onSetTheme: (m: ThemeMode) => void;
  onBack: () => void;
  onChange: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50/80 px-2 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
        <button
          onClick={onBack}
          aria-label="返回对话"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        >
          <IconArrowLeft className="h-5 w-5" />
        </button>
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">设置</span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-4 text-neutral-900 dark:text-neutral-100">
          <p className="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
            配置 OpenAI 兼容的模型 Provider。API Key 仅保存在本机
            <code className="mx-1 rounded bg-neutral-100 px-1 dark:bg-neutral-800">chrome.storage.local</code>
            ，不会上传或同步。
          </p>
          <AppearanceSettings mode={themeMode} onSet={onSetTheme} />
          <ProviderSettings onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

/* ---------------- 消息区 ---------------- */

function EmptyState({
  busy,
  onSummarize,
  onExplain,
}: {
  busy: boolean;
  onSummarize: () => void;
  onExplain: () => void;
}) {
  return (
    <div className="m-auto flex w-full max-w-md flex-col items-center text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 text-white dark:bg-neutral-800">
        <IconSparkles className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">和 Aluminum 对话</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        我可以总结当前网页、解释划词内容，或回答任何问题。
      </p>
      <div className="mt-5 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          onClick={onSummarize}
          disabled={busy}
          className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-3 text-left text-sm transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800/60"
        >
          <span className="text-neutral-500 dark:text-neutral-400">
            <IconFileText className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-neutral-900 dark:text-neutral-100">总结当前网页</span>
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">快速提炼要点</span>
          </span>
        </button>
        <button
          onClick={onExplain}
          disabled={busy}
          className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-3 text-left text-sm transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800/60"
        >
          <span className="text-neutral-500 dark:text-neutral-400">
            <IconMessage className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-neutral-900 dark:text-neutral-100">解释划词内容</span>
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">选中页面文本即可</span>
          </span>
        </button>
      </div>
    </div>
  );
}

function Message({
  role,
  content,
  busy,
}: {
  role: 'user' | 'assistant';
  content: string;
  busy: boolean;
}) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-neutral-900 px-4 py-2.5 text-sm text-white dark:bg-neutral-700">
          {content}
        </div>
      </div>
    );
  }
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
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="正在生成">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.3s] motion-reduce:animate-none dark:bg-neutral-500" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.15s] motion-reduce:animate-none dark:bg-neutral-500" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 motion-reduce:animate-none dark:bg-neutral-500" />
    </span>
  );
}

function ToolActivityList({ activities }: { activities: ToolActivity[] }) {
  const running = activities.filter((a) => a.status === 'running' || a.status === 'confirming').length;
  return (
    <details className="group rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-300">
        <IconChevronRight className="h-3.5 w-3.5 text-neutral-400 transition-transform group-open:rotate-90 dark:text-neutral-500" />
        <span className="font-medium text-neutral-700 dark:text-neutral-200">Agent 工具调用</span>
        <span className="text-neutral-400 dark:text-neutral-500">
          · {activities.length}
          {running ? `（${running} 运行中）` : ''}
        </span>
      </summary>
      <ul className="space-y-1 border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
        {activities.map((a) => (
          <li key={a.id} className="flex items-start gap-2 text-xs">
            <span className={statusColor(a.status)}>{statusLabel(a.status)}</span>
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
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="mb-2 flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
        🔒 修改页面前，先请你确认
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
          批准本轮操作
        </button>
        <button
          onClick={onDeny}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          拒绝
        </button>
      </div>
      <p className="mt-2 text-[11px] text-amber-800/70 dark:text-amber-300/60">
        批准后，本轮内后续的写操作会自动执行，无需逐条确认；这轮做的所有改动之后都能一键撤销。
      </p>
    </div>
  );
}

function UserScriptsBlockedNotice({
  attempts,
  elapsedSeconds,
  onOpenSettings,
  onCancelWait,
}: {
  attempts: number;
  elapsedSeconds: number;
  onOpenSettings: () => void;
  onCancelWait: () => void;
}) {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="mb-1 font-medium text-amber-900 dark:text-amber-200">
        ⏳ 等待开启「允许用户脚本」开关……
      </div>
      <p className="mb-2 text-amber-900/90 dark:text-amber-200/90">
        注入脚本需要先在本扩展详情页开启「允许用户脚本」开关；已等待 {elapsedLabel}，重试
        {attempts} 次。开启后会自动继续，无需重新提问。
      </p>
      <div className="flex gap-2">
        <button
          onClick={onOpenSettings}
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          🔧 前往开启
        </button>
        <button
          onClick={onCancelWait}
          className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-amber-800 dark:text-amber-200 dark:hover:bg-amber-900/40"
        >
          取消等待
        </button>
      </div>
    </div>
  );
}

function UndoBar({ onRevert }: { onRevert: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <span className="text-emerald-600 dark:text-emerald-400">● 本轮已修改页面</span>
      <button
        onClick={onRevert}
        className="font-medium text-red-600 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-red-400"
      >
        撤销本轮更改
      </button>
    </div>
  );
}

function statusLabel(status: ToolActivity['status']): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'confirming':
      return '待确认';
    case 'blocked':
      return '已拦截';
    case 'error':
      return '失败';
    default:
      return '完成';
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
  onSummarize,
  onExplain,
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
  onSummarize: () => void;
  onExplain: () => void;
  onSelectProviderModel: (providerId: string, model: string) => void;
}) {
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
          <Chip onClick={onSummarize} disabled={busy} icon={<IconFileText className="h-3.5 w-3.5" />} label="总结本页" />
          <Chip onClick={onExplain} disabled={busy} icon={<IconMessage className="h-3.5 w-3.5" />} label="解释划词" />
        </div>
        <div className="flex items-end gap-2 rounded-2xl border border-neutral-300 bg-white p-2 shadow-sm transition-colors focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/30 dark:border-neutral-700 dark:bg-neutral-900">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            aria-label="消息输入框"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-100 dark:placeholder:text-neutral-600"
          />
          {busy ? (
            <button
              onClick={onStop}
              aria-label="停止生成"
              title="停止生成"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-white transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-neutral-700 dark:hover:bg-neutral-600"
            >
              <IconStop className="h-5 w-5" />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!canSend}
              aria-label="发送消息"
              title="发送消息"
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

  const selected = providers.find((p) => p.id === selectedProviderId);
  const currentModel = selectedModel || selected?.model || '';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="选择 Provider 与模型"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex max-w-[60vw] items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
      >
        {selected && <span className="shrink-0 text-neutral-400 dark:text-neutral-500">{selected.name}</span>}
        <span className="truncate font-medium text-neutral-700 dark:text-neutral-200">{currentModel || '未选择'}</span>
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
      onClick={onClick}
      disabled={disabled}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
    >
      <span className="text-neutral-500 dark:text-neutral-400">{icon}</span>
      {label}
    </button>
  );
}
