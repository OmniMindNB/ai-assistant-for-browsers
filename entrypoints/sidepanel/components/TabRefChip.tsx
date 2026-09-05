import { useTranslation } from '@/lib/i18n';
import type { TabReference } from '../store';

interface TabRefChipProps {
  reference: TabReference;
  onRemove(id: number): void;
}

/**
 * 引用标签页的 chip。与 AttachmentChip 分开而不是复用：附件有上传/解析/失败的生命周期，
 * 引用只有"在或不在"，塞进同一个组件只会让两边都变复杂。
 *
 * chip 必须常驻可见——授权持续到用户移除，看不见的授权就是隐形授权
 * （ref: 2026-09-05-cross-tab-context-design.md §11）。
 */
export function TabRefChip({ reference, onRemove }: TabRefChipProps) {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-neutral-300 bg-neutral-50 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800"
      title={reference.url}
    >
      {reference.favIconUrl && (
        <img src={reference.favIconUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" />
      )}
      <span className="truncate">{reference.title}</span>
      <button
        type="button"
        aria-label={t('workbench.removeTabReference', { title: reference.title })}
        className="shrink-0 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        onClick={() => onRemove(reference.id)}
      >
        ×
      </button>
    </span>
  );
}
