import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useChat } from './store';

export default function App() {
  const {
    messages,
    input,
    busy,
    error,
    provider,
    setInput,
    refreshProvider,
    send,
    summarizePage,
    explainSelection,
    stop,
    clear,
  } = useChat();

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    refreshProvider();
  }, [refreshProvider]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function openOptions() {
    browser.runtime.openOptionsPage();
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3">
        <div className="h-6 w-6 rounded bg-neutral-900 text-center text-sm font-bold leading-6 text-white">
          Al
        </div>
        <h1 className="text-sm font-semibold">Aluminum</h1>
        <span className="ml-auto text-xs text-neutral-400">
          {provider ? provider.name : '未配置'}
        </span>
        <button
          onClick={clear}
          title="新对话"
          className="rounded border border-neutral-300 px-2 py-0.5 text-xs"
        >
          清空
        </button>
        <button
          onClick={openOptions}
          title="设置"
          className="rounded border border-neutral-300 px-2 py-0.5 text-xs"
        >
          设置
        </button>
      </header>

      {!provider && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          未检测到模型 Provider。请在
          <button onClick={openOptions} className="mx-1 underline">
            设置
          </button>
          中填入 API Key，或在 lib/dev-config.ts 中填入测试 Key。
        </div>
      )}

      <div className="flex gap-2 border-b border-neutral-200 px-4 py-2">
        <button
          onClick={summarizePage}
          disabled={busy}
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs disabled:opacity-50"
        >
          📄 总结本页
        </button>
        <button
          onClick={explainSelection}
          disabled={busy}
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs disabled:opacity-50"
        >
          💬 解释划词
        </button>
      </div>

      <main ref={scrollRef} className="flex-1 space-y-3 overflow-auto p-4">
        {messages.length === 0 ? (
          <p className="mt-8 text-center text-xs text-neutral-400">
            开始对话，或点击上方「总结本页 / 解释划词」。
          </p>
        ) : (
          messages.map((m, i) => <Bubble key={i} role={m.role} content={m.content} busy={busy} />)
        )}
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            {error}
          </div>
        )}
      </main>

      <footer className="border-t border-neutral-200 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            className="flex-1 resize-none rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
          />
          {busy ? (
            <button
              onClick={stop}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            >
              停止
            </button>
          ) : (
            <button
              onClick={() => send()}
              disabled={!input.trim()}
              className="rounded-md bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              发送
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function Bubble({
  role,
  content,
  busy,
}: {
  role: 'user' | 'assistant';
  content: string;
  busy: boolean;
}) {
  const isUser = role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          isUser
            ? 'max-w-[85%] whitespace-pre-wrap rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white'
            : 'max-w-[85%] whitespace-pre-wrap rounded-lg bg-white px-3 py-2 text-sm shadow-sm'
        }
      >
        {content || (busy ? <span className="text-neutral-400">▍</span> : '')}
      </div>
    </div>
  );
}
