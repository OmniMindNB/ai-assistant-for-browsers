import { useTranslation } from '@/lib/i18n';
import type { MessageAttachment } from '@/lib/chat/attachments';
import { IconClose, IconFileText } from '../icons';

export interface AttachmentChipProps {
  attachment: MessageAttachment;
  /** 不传时为只读展示（历史消息里的附件） */
  onRemove?: () => void;
}

export function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      {attachment.kind === 'image' && attachment.dataUrl ? (
        <img src={attachment.dataUrl} alt="" className="h-4 w-4 shrink-0 rounded object-cover" />
      ) : (
        <IconFileText className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
      )}
      <span className="max-w-[120px] truncate">{attachment.name}</span>
      {attachment.kind !== 'image' && attachment.truncated && (
        <span title={t('workbench.attachmentTruncatedBadge')} className="text-neutral-400">
          …
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('workbench.removeAttachmentLabel')}
          className="shrink-0 rounded-full p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-800"
        >
          <IconClose className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
