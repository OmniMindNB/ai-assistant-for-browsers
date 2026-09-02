import { useEffect, useRef } from 'react';
import { useTranslation } from '@/lib/i18n';
import { IconCheck, IconClose } from '../icons';
import type { ActivityStep } from '../store';

export function ActivityStepList({ steps }: { steps: ActivityStep[] }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps]);

  // 常驻提示条取最后一步的目标标签——不随滚动消失，让用户不用翻步骤记录就知道"现在在哪"。
  // 在面板自己的 tab 上操作时 tabLabel 为空，不显示（跟逐行前缀同一条规则）。
  const currentTabLabel = steps.at(-1)?.tabLabel;

  return (
    <div className="flex flex-col gap-1">
      {currentTabLabel && (
        <div className="px-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t('agentActivity.currentTab', { target: currentTabLabel })}
        </div>
      )}
      <div
        ref={containerRef}
        role="status"
        aria-live="polite"
        className="flex max-h-32 flex-col gap-1 overflow-y-auto px-1 text-xs"
      >
        {steps.map((step, index) => (
          <ActivityStepRow
            key={step.id}
            step={step}
            showTabLabel={step.tabLabel !== undefined && step.tabLabel !== steps[index - 1]?.tabLabel}
          />
        ))}
      </div>
    </div>
  );
}

function ActivityStepRow({ step, showTabLabel }: { step: ActivityStep; showTabLabel: boolean }) {
  const text = showTabLabel ? `《${step.tabLabel}》${step.description}` : step.description;

  if (step.status === 'running') {
    return (
      <div className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>
      </div>
    );
  }

  if (step.status === 'failed') {
    return (
      <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
        <IconClose className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-neutral-400 dark:text-neutral-500">
      <IconCheck className="h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>
    </div>
  );
}
