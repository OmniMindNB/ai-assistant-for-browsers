import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** 确认按钮的文案，直接用动作本身的名字（「恢复预设」而不是「确定」）。 */
  confirmLabel: string;
  cancelLabel?: string;
  /** 确认后的异步操作还在进行时，两个按钮都禁用，避免重复提交。 */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const focusableSelector = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * 应用内确认弹窗。替代原生 window.confirm：后者没有暗色模式、无法走 Tab 焦点环，
 * 样式也跟扩展其余 UI 割裂（ref: 2026-09-08 快捷方式确认弹窗改造）。
 *
 * 只用于「会删数据且需要一段说明文字」的破坏性操作；逐条删除这类轻量确认继续用
 * RedactionSettings.tsx / HistoryDrawer.tsx 的行内二次点击模式。
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // 打开的第一帧先按"关闭态"渲染，下一帧翻到"打开态"，靠 transition-* 类过渡出现。
  // 关闭不做退场动画——直接卸载，焦点立刻还给触发按钮（同 HistoryDrawer.tsx）。
  const [entered, setEntered] = useState(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) {
      setEntered(false);
      const returnTo = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnTo?.isConnected) returnTo.focus();
      return;
    }
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 破坏性操作：初始焦点给「取消」，直接回车不会触发确认按钮。
    cancelRef.current?.focus();
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        data-testid="confirm-dialog-backdrop"
        aria-hidden="true"
        onMouseDown={onCancel}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-150 ${entered ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={`relative w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-neutral-200 bg-white p-4 shadow-xl transition duration-150 ease-out dark:border-neutral-800 dark:bg-neutral-900 ${
          entered ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
        }`}
      >
        <h2 id={titleId} className="text-sm font-semibold text-neutral-900 dark:text-white">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="mt-2 text-xs leading-5 text-neutral-600 dark:text-neutral-400">
            {description}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
