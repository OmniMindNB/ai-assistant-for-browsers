import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from '@/lib/i18n';
import { planStatusUpdate } from '@/lib/workbench/status-throttle';
import { IconGear, IconMenu, IconPlus } from '../icons';

/**
 * header 运行状态。label 是看得见的那句短进度（"执行中 · 第 3 步"），detail 是此刻那一步的完整描述。
 *
 * 两者分开是为了不和步骤列表重复：运行中那一行已经用同样的颜色和闪烁圆点写着完整描述，
 * header 再原样抄一遍，视线范围内就有两句一模一样的话。所以 header 只给进度，完整描述退到
 * title 和读屏播报里——读屏用户看不到步骤列表（它刻意不是 live region），这一句仍然要说全。
 */
export interface RunStatus {
  label: string;
  detail: string;
}

export interface WorkbenchHeaderProps {
  historyOpen: boolean;
  /** 运行中的状态；null 表示空闲。有值时它取代品牌名占住 header 的中间。 */
  runStatus?: RunStatus | null;
  onToggleHistory(): void;
  onNewChat(): void;
  onOpenSettings(): void;
  historyTriggerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * 节流后的状态文案 + 一个"刚换过字"的标记（用来做淡入）。
 * 为什么要节流见 lib/workbench/status-throttle.ts。
 */
function useThrottledStatus(value: RunStatus | null): { status: RunStatus | null; justChanged: boolean } {
  // 节流按"label + detail"这一对比较：只看 label 的话，同一步数里描述变了读屏不会播报；
  // 只看 detail 的话，label 和 detail 又可能来自不同的两次更新。
  const text = value ? `${value.label}\n${value.detail}` : null;
  const [status, setStatus] = useState<RunStatus | null>(value);
  const valueRef = useRef(value);
  valueRef.current = value;
  const shownKeyRef = useRef<string | null>(text);
  const [justChanged, setJustChanged] = useState(false);
  // 初值取挂载时刻而不是 0：初始文案是通过 useState 直接落下去的，不走下面的 swap 分支，
  // 若 lastChangeAt 停在 0，紧接着的第一次变化会算出"已经等了几十年"从而绕过节流。
  const lastChangeAtRef = useRef(Date.now());
  // 定时器回调里比对的必须是"此刻显示的是什么"（shownKeyRef），换上去的也必须是最新的值
  // （valueRef）——等待期间可能又来了新值，用注册那一轮闭包捕获的旧值会漏掉一次换字。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const apply = () => {
      const plan = planStatusUpdate(shownKeyRef.current, text, Date.now(), lastChangeAtRef.current);
      if (plan.action === 'hold') return;
      if (plan.action === 'wait') {
        timer = setTimeout(apply, plan.afterMs);
        return;
      }
      lastChangeAtRef.current = Date.now();
      shownKeyRef.current = text;
      setStatus(valueRef.current);
      setJustChanged(true);
    };

    apply();
    return () => clearTimeout(timer);
  }, [text]);

  // 淡入：换字那一帧先渲染成透明，下一帧再翻回不透明，浏览器才会真的跑 transition
  // （同一帧内从 opacity-0 直接改成 opacity-100 会被合并，看不到过渡）。
  // 用 rAF 而不是 setTimeout：只需要"下一帧"，不需要额外的等待时间。
  useEffect(() => {
    if (!justChanged) return;
    const frame = requestAnimationFrame(() => setJustChanged(false));
    return () => cancelAnimationFrame(frame);
  }, [justChanged, status]);

  return { status, justChanged };
}

export function WorkbenchHeader({
  historyOpen,
  runStatus = null,
  onToggleHistory,
  onNewChat,
  onOpenSettings,
  historyTriggerRef,
}: WorkbenchHeaderProps) {
  const { t } = useTranslation();
  const { status, justChanged } = useThrottledStatus(runStatus);

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
          消息里的步骤列表被滚走，header 得能告诉他"还在跑、跑到第几步"。
          停止按钮不放这里：输入区不在滚动区里，它的停止按钮始终可见，两个停止按钮只是重复。 */}
      {status ? (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-500 motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span
            role="status"
            aria-live="polite"
            title={status.detail}
            className={`min-w-0 flex-1 truncate text-xs text-neutral-600 transition-opacity duration-200 motion-reduce:transition-none dark:text-neutral-300 ${
              justChanged ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {status.label === status.detail ? (
              status.label
            ) : (
              <>
                <span aria-hidden="true">{status.label}</span>
                <span className="sr-only">{status.detail}</span>
              </>
            )}
          </span>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-2 px-1">
          <span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">Runi</span>
        </div>
      )}
      <div className="ml-auto flex items-center gap-1">
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
