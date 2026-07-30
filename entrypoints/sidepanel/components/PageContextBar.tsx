import type { PageContextState } from '../store';
import { useTranslation } from '@/lib/i18n';

export interface PageContextBarProps {
  context: PageContextState;
  attached: boolean;
  onToggleAttached(): void;
  onRetry(): void;
}

export function PageContextBar({ context, attached, onToggleAttached, onRetry }: PageContextBarProps) {
  const { t } = useTranslation();

  if (context.status === 'loading') {
    return (
      <div role="status" aria-live="polite" className="min-w-0 break-words border-b border-neutral-200 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        {t('workbench.pageContextLoading')}
      </div>
    );
  }

  if (context.status === 'error') {
    return (
      <div role="alert" className="flex min-w-0 flex-col items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 sm:flex-row sm:items-center sm:justify-between dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
        <span className="min-w-0 break-words">{t('workbench.pageContextUnavailable', { message: context.message })}</span>
        <button
          type="button"
          onClick={onRetry}
          className="max-w-full min-w-0 whitespace-normal text-left font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 sm:shrink-0"
        >
          {t('workbench.retryPageContext')}
        </button>
      </div>
    );
  }

  if (context.status === 'restricted') {
    return (
      <div className="flex min-w-0 flex-col items-start gap-2 border-b border-neutral-200 bg-neutral-100 px-4 py-2 text-xs text-neutral-600 sm:flex-row sm:items-center dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
        <div className="min-w-0 flex-1">
          <span className="font-medium">{t('workbench.restrictedPage')}</span>
          <span aria-label={context.title} title={context.title} className="mt-1 block min-w-0 break-words text-neutral-500 sm:truncate dark:text-neutral-400">
            {context.title}
          </span>
        </div>
        <button
          type="button"
          disabled={!attached}
          onClick={onToggleAttached}
          aria-label={t('workbench.continueWithoutPageContext')}
          title={t('workbench.continueWithoutPageContext')}
          className="max-w-full min-w-0 whitespace-normal rounded-md px-2 py-1 text-left font-medium text-indigo-700 transition-colors hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 sm:shrink-0 dark:text-indigo-300 dark:hover:bg-indigo-950/50"
        >
          {t('workbench.continueWithoutPageContext')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-950">
      <span className="shrink-0 text-neutral-500 dark:text-neutral-400">{t('workbench.pageContext')}</span>
      <span aria-label={context.title} title={context.title} className="min-w-0 flex-1 truncate font-medium text-neutral-700 dark:text-neutral-200">
        {context.title}
      </span>
      <button
        type="button"
        onClick={onToggleAttached}
        aria-pressed={attached}
        aria-label={attached ? t('workbench.removePageContext') : t('workbench.addPageContext')}
        title={attached ? t('workbench.removePageContext') : t('workbench.addPageContext')}
        className="shrink-0 rounded-md px-2 py-1 font-medium text-indigo-700 transition-colors hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300 dark:hover:bg-indigo-950/50"
      >
        {attached ? t('workbench.pageContextAttached') : t('workbench.pageContextDetached')}
      </button>
    </div>
  );
}
