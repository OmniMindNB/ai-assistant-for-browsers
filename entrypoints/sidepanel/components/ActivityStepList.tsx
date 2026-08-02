import { useTranslation } from '@/lib/i18n';
import { IconCheck, IconClose } from '../icons';
import type { ActivityStep } from '../store';

export function ActivityStepList({ steps }: { steps: ActivityStep[] }) {
  const { t } = useTranslation();
  const slowSuffix = t('agentActivity.slowSuffix');

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex max-h-32 flex-col gap-1 overflow-y-auto px-1 text-xs"
    >
      {steps.map((step) => (
        <ActivityStepRow key={step.id} step={step} slowSuffix={slowSuffix} />
      ))}
    </div>
  );
}

function ActivityStepRow({ step, slowSuffix }: { step: ActivityStep; slowSuffix: string }) {
  const text = step.status === 'running' && step.slow ? `${step.description}${slowSuffix}` : step.description;

  if (step.status === 'running') {
    return (
      <div className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{text}</span>
      </div>
    );
  }

  if (step.status === 'failed') {
    return (
      <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
        <IconClose className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{text}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-neutral-400 dark:text-neutral-500">
      <IconCheck className="h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
    </div>
  );
}
