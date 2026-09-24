import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from '@/lib/i18n';
import { planStatusUpdate } from '@/lib/workbench/status-throttle';
import { IconGear, IconMenu, IconPlus, IconStop } from '../icons';

export interface WorkbenchHeaderProps {
  historyOpen: boolean;
  /**
   * 运行中要显示的一句状态文案；null 表示空闲。
   * 有值时它取代品牌名占住 header 的中间——运行期间"它在干什么"比"这个产品叫什么"重要得多。
   */
  runStatus?: string | null;
  onStop?(): void;
  onToggleHistory(): void;
  onNewChat(): void;
  onOpenSettings(): void;
  historyTriggerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * 节流后的状态文案 + 一个"刚换过字"的标记（用来做淡入）。
 * 为什么要节流见 lib/workbench/status-throttle.ts。
 */
function useThrottledStatus(value: string | null): { text: string | null; justChanged: boolean } {
  const [text, setText] = useState<string | null>(value);
  const [justChanged, setJustChanged] = useState(false);
  // 初值取挂载时刻而不是 0：初始文案是通过 useState 直接落下去的，不走下面的 swap 分支，
  // 若 lastChangeAt 停在 0，紧接着的第一次变化会算出"已经等了几十年"从而绕过节流。
  const lastChangeAtRef = useRef(Date.now());
  // 定时器回调里比对的必须是"此刻显示的是什么"，而不是注册那一轮闭包捕获的 text——
  // 等待期间可能又来了新值，用过期的显示值比对会漏掉一次换字。
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const apply = () => {
      const plan = planStatusUpdate(textRef.current, value, Date.now(), lastChangeAtRef.current);
      if (plan.action === 'hold') return;
      if (plan.action === 'wait') {
        timer = setTimeout(apply, plan.afterMs);
        return;
      }
      lastChangeAtRef.current = Date.now();
      setText(value);
      setJustChanged(true);
    };

    apply();
    return () => clearTimeout(timer);
  }, [value]);

  // 淡入：换字那一帧先渲染成透明，下一帧再翻回不透明，浏览器才会真的跑 transition
  // （同一帧内从 opacity-0 直接改成 opacity-100 会被合并，看不到过渡）。
  // 用 rAF 而不是 setTimeout：只需要"下一帧"，不需要额外的等待时间。
  useEffect(() => {
    if (!justChanged) return;
    const frame = requestAnimationFrame(() => setJustChanged(false));
    return () => cancelAnimationFrame(frame);
  }, [justChanged, text]);

  return { text, justChanged };
}

export function WorkbenchHeader({
  historyOpen,
  runStatus = null,
  onStop,
  onToggleHistory,
  onNewChat,
  onOpenSettings,
  historyTriggerRef,
}: WorkbenchHeaderProps) {
  const { t } = useTranslation();
  const { text: statusText, justChanged } = useThrottledStatus(runStatus);

  return (
    <header className="relative z-30 flex items-center gap-1 border-b border-neutral-200 bg-neutral-50/80 px-2 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
      <button
        ref={historyTriggerRef}
        type="button"
        aria-label={t('workbench.history')}
        aria-expanded={historyOpen}
        aria-haspopup="dialog"
        onClick={onToggleHistory}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
      >
        <IconMenu className="h-5 w-5" />
      </button>
      {/* 运行期间状态取代品牌名占住中间：用户往上翻历史时，页面上的遮罩看不见、
          消息流底部的步骤条被滚走，此前 header 里没有任何东西能告诉他"还在跑"。
          停止按钮一并挪进来，不必先滚到底才够得着。 */}
      {statusText ? (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-500 motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span
            role="status"
            aria-live="polite"
            title={statusText}
            className={`min-w-0 flex-1 truncate text-xs text-neutral-600 transition-opacity duration-200 motion-reduce:transition-none dark:text-neutral-300 ${
              justChanged ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {statusText}
          </span>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-2 px-1">
          <span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">Runi</span>
        </div>
      )}
      <div className="ml-auto flex items-center gap-1">
        {statusText && onStop && (
          <button
            type="button"
            onClick={onStop}
            aria-label={t('chat.stopGenerating')}
            title={t('chat.stopGenerating')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <IconStop className="h-5 w-5" />
          </button>
        )}
        <button
          type="button"
          onClick={onNewChat}
          aria-label={t('common.newChat')}
          title={t('common.newChat')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        >
          <IconPlus className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t('common.settings')}
          title={t('common.settings')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        >
          <IconGear className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}
