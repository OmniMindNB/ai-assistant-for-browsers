import { useEffect } from 'react';
import { useTranslation } from '@/lib/i18n';
import { IconAlertTriangle, IconCheck, IconClose } from '../icons';

export interface ToastMessage {
  /** 每次弹出都换一个新值：同一句话连着出现两次时，自动消失的计时要重新开始。 */
  id: number;
  kind: 'success' | 'error';
  text: string;
}

/** 成功提示的停留时长，跟其余一次性反馈（如复制成功）同一量级。 */
export const TOAST_SUCCESS_MS = 4000;

/**
 * 一次性操作反馈（保存成功、打开设置失败）的唯一出口：浮在输入区正上方，
 * 也就是用户刚刚操作的地方，而不是面板顶端——人在底部点了按钮，结果却出现在视线另一头。
 *
 * 成功自动消失；失败留着，直到用户关掉或被下一条替换——错误一闪而过等于没说。
 * 需要先处理才能继续的状态（没配置模型）和运行错误（带重试、属于这段对话）不走这里。
 */
export function Toast({ toast, onDismiss }: { toast: ToastMessage; onDismiss(): void }) {
  const { t } = useTranslation();
  const error = toast.kind === 'error';

  useEffect(() => {
    if (error) return;
    const timer = window.setTimeout(onDismiss, TOAST_SUCCESS_MS);
    return () => window.clearTimeout(timer);
    // 不依赖 onDismiss：它每次渲染都是新引用，计时只该跟着"换了一条提示"重来。
  }, [toast.id, error]);

  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg ${
        error
          ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950 dark:text-red-300'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950 dark:text-emerald-300'
      }`}
    >
      {error ? (
        <IconAlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
      ) : (
        <IconCheck className="mt-px h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 break-words">{toast.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('common.close')}
        title={t('common.close')}
        className="-m-0.5 shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <IconClose className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
