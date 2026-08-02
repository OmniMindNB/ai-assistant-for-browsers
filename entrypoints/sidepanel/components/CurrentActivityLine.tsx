import type { ToolActivity } from '../store';

export function CurrentActivityLine({ activity }: { activity: ToolActivity }) {
  const isFailed = activity.status === 'failed';
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 px-1 text-xs ${
        isFailed ? 'text-red-700 dark:text-red-300' : 'text-neutral-500 dark:text-neutral-400'
      }`}
    >
      {!isFailed && (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate">{activity.description}</span>
    </div>
  );
}
