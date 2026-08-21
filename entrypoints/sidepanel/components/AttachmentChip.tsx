import { attachmentFailureLabel, type MessageAttachment, type PendingAttachment } from '@/lib/chat/attachments';
import { useTranslation } from '@/lib/i18n';
import { useId } from 'react';
import {
  IconAlertTriangle,
  IconCheck,
  IconClose,
  IconFileText,
  IconLoader,
} from '../icons';

export type AttachmentChipProps =
  | {
      pending: PendingAttachment;
      attachment?: never;
      onRemove(id: string): void;
      onRetry(id: string): void;
    }
  | {
      attachment: MessageAttachment;
      pending?: never;
      onRemove?: never;
      onRetry?: never;
    };

type ChipStatus = PendingAttachment['status'] | 'history';

function chipClass(status: ChipStatus): string {
  const base = 'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-xs';
  if (status === 'error') {
    return `${base} border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300`;
  }
  if (status === 'queued' || status === 'parsing') {
    return `${base} border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900/70 dark:bg-indigo-950/40 dark:text-indigo-300`;
  }
  return `${base} border-neutral-200 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300`;
}

function AttachmentStatusIcon({ status, truncated }: { status: ChipStatus; truncated: boolean }) {
  if (status === 'queued' || status === 'parsing') {
    return <IconLoader className="h-3.5 w-3.5 shrink-0 animate-spin" />;
  }
  if (status === 'error' || truncated) {
    return <IconAlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
  }
  if (status === 'ready') {
    return <IconCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
  }
  return <IconFileText className="h-3.5 w-3.5 shrink-0 text-neutral-400" />;
}

export function AttachmentChip(props: AttachmentChipProps) {
  const { t } = useTranslation();
  const truncationDescriptionId = useId();
  const pending = 'pending' in props ? props.pending : null;
  const historical = 'attachment' in props ? props.attachment : null;
  const status: ChipStatus = pending?.status ?? 'history';
  const name = pending?.name ?? historical!.name;
  const progress = pending?.status === 'parsing' && pending.pageCount
    ? Math.round(((pending.completedPages ?? 0) / pending.pageCount) * 100)
    : null;
  const readyAttachment = pending?.status === 'ready' ? pending.attachment : historical;
  const readyPdf = readyAttachment?.kind === 'pdf' ? readyAttachment : null;
  const error = pending?.status === 'error' ? pending : null;
  const onRetry = 'onRetry' in props ? props.onRetry : undefined;
  const onRemove = 'onRemove' in props ? props.onRemove : undefined;
  const truncated = readyPdf?.truncated
    ?? (readyAttachment?.kind === 'text' ? readyAttachment.truncated : false);
  const hasPdfTruncationDescription = readyPdf?.truncated ?? false;
  const stateLabel = status === 'queued'
    ? t('workbench.attachmentQueued')
    : status === 'parsing'
      ? t('workbench.attachmentParsing')
      : null;

  return (
    <div
      role={error ? 'alert' : undefined}
      aria-live={error ? undefined : 'polite'}
      aria-describedby={hasPdfTruncationDescription ? truncationDescriptionId : undefined}
      tabIndex={hasPdfTruncationDescription ? 0 : undefined}
      className={chipClass(status)}
    >
      {readyAttachment?.kind === 'image' && readyAttachment.dataUrl ? (
        <img src={readyAttachment.dataUrl} alt="" className="h-4 w-4 shrink-0 rounded object-cover" />
      ) : (
        <AttachmentStatusIcon status={status} truncated={truncated} />
      )}
      <span className="max-w-[120px] truncate">{name}</span>
      {stateLabel && <span className="shrink-0 text-current/80">{stateLabel}</span>}
      {progress !== null && (
        <span className="shrink-0 tabular-nums">{t('workbench.attachmentProgress', { progress })}</span>
      )}
      {readyPdf && (
        <span className="shrink-0 text-neutral-400 dark:text-neutral-500">
          {t('workbench.pdfPages', { count: readyPdf.pageCount })}
        </span>
      )}
      {truncated && (
        <span
          title={readyPdf ? t('workbench.pdfTruncatedDetail') : t('workbench.attachmentTruncatedBadge')}
          className="shrink-0 text-amber-700 dark:text-amber-300"
        >
          {t('workbench.attachmentTruncatedBadge')}
        </span>
      )}
      {hasPdfTruncationDescription && (
        <span id={truncationDescriptionId} className="sr-only">
          {t('workbench.pdfTruncatedDetail')}
        </span>
      )}
      {error && (
        <span className="min-w-0 max-w-48 truncate">
          {attachmentFailureLabel(error.reason, name, t, error.kind)}
        </span>
      )}
      {error?.retryable && (
        <button
          type="button"
          aria-label={t('workbench.retryNamedAttachment', { name })}
          onClick={() => onRetry?.(error.id)}
          className="shrink-0 rounded-full px-1 font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {t('common.retry')}
        </button>
      )}
      {onRemove && pending && (
        <button
          type="button"
          onClick={() => onRemove(pending.id)}
          aria-label={t('workbench.removeNamedAttachment', { name })}
          title={t('workbench.removeNamedAttachment', { name })}
          className="shrink-0 rounded-full p-0.5 text-current/60 transition-colors hover:bg-black/10 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-white/10"
        >
          <IconClose className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
