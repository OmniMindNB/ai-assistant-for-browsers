import type { ShortcutConfig } from '@/lib/shortcuts';
import { isUsableShortcutCommand, type ResolvedShortcutCommand } from '@/lib/workbench/presentation';
import { IconSparkles } from '../icons';
import { useTranslation } from '@/lib/i18n';

export interface WorkbenchEmptyStateProps {
  shortcuts: readonly ResolvedShortcutCommand[];
  busy: boolean;
  onRunShortcut(shortcut: ShortcutConfig): void;
}

export function WorkbenchEmptyState({ shortcuts, busy, onRunShortcut }: WorkbenchEmptyStateProps) {
  const { t } = useTranslation();
  const suggestions = shortcuts.filter(isUsableShortcutCommand).slice(0, 4);

  return (
    <div className="m-auto flex w-full max-w-md flex-col items-center text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 text-white dark:bg-neutral-800">
        <IconSparkles className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        {t('workbench.emptyTitle')}
      </h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {t('workbench.emptyDescription')}
      </p>
      {suggestions.length > 0 && (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {suggestions.map(({ config, resolved }) => (
            <button
              key={config.id}
              type="button"
              disabled={busy}
              onClick={() => onRunShortcut(config)}
              aria-label={resolved.name}
              title={resolved.name}
              className="inline-flex max-w-48 items-center rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              <span className="truncate">{resolved.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
