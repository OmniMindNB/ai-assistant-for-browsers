import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

// 用户消息的就地编辑框。提交后由 store 的 editMessage 截断历史并重跑
// （ref: docs/superpowers/specs/2026-07-26-edit-history-message-design.md §5）。
export default function MessageEditor({
  initialContent,
  discardCount,
  onCancel,
  onSubmit,
}: {
  initialContent: string;
  discardCount: number;
  onCancel: () => void;
  onSubmit: (content: string) => void;
}) {
  const [text, setText] = useState(initialContent);
  const ref = useRef<HTMLTextAreaElement>(null);

  // 挂载时聚焦并把光标置于末尾；setSelectionRange 必须在 focus 之后调用。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // 随内容自动调整高度：先归零再读 scrollHeight，否则删字时高度只增不减。
  // 封顶到视口高度的 40%：粘贴超长内容时不会把 textarea 撑出视口
  // （超出部分交给下面的 max-h-[40vh] overflow-y-auto 内部滚动）。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const cap = window.innerHeight * 0.4;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [text]);

  const canSubmit = text.trim().length > 0;

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    // 与 Composer 的快捷键保持一致：Enter 提交，Shift+Enter 换行。
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSubmit) onSubmit(text);
    }
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="编辑消息"
        className="max-h-[40vh] w-full resize-none overflow-y-auto rounded-2xl border border-neutral-300 bg-white px-4 py-2.5 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      />
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-xs text-neutral-500 dark:text-neutral-400">
          {discardCount > 0 ? `提交后将丢弃后续 ${discardCount} 条消息` : ''}
        </span>
        <span className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onSubmit(text)}
            className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-neutral-700"
          >
            发送
          </button>
        </span>
      </div>
    </div>
  );
}
