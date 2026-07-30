import type { PageContextState } from '../store';

export interface PageContextBarProps {
  context: PageContextState;
  attached: boolean;
  onToggleAttached(): void;
  onRetry(): void;
}

export function PageContextBar({ context, attached, onToggleAttached, onRetry }: PageContextBarProps) {
  if (context.status === 'loading') {
    return <div className="border-b border-neutral-200 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">Checking page context…</div>;
  }

  if (context.status === 'error') {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
        <span className="min-w-0 truncate">Page context unavailable: {context.message}</span>
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          Retry page context
        </button>
      </div>
    );
  }

  if (context.status === 'restricted') {
    return (
      <div className="flex min-w-0 items-center gap-2 border-b border-neutral-200 bg-neutral-100 px-4 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
        <span className="shrink-0">This page cannot be read.</span>
        <span aria-label={context.title} title={context.title} className="min-w-0 truncate text-neutral-500 dark:text-neutral-400">
          {context.title}
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-950">
      <span className="shrink-0 text-neutral-500 dark:text-neutral-400">Page context</span>
      <span aria-label={context.title} title={context.title} className="min-w-0 flex-1 truncate font-medium text-neutral-700 dark:text-neutral-200">
        {context.title}
      </span>
      <button
        type="button"
        onClick={onToggleAttached}
        aria-pressed={attached}
        aria-label={attached ? 'Remove page context' : 'Add page context'}
        title={attached ? 'Remove page context' : 'Add page context'}
        className="shrink-0 rounded-md px-2 py-1 font-medium text-indigo-700 transition-colors hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300 dark:hover:bg-indigo-950/50"
      >
        {attached ? 'Attached' : 'Not attached'}
      </button>
    </div>
  );
}
