import { useEffect, useRef, useState } from 'react';
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

// 每行默认单行截断（title 悬浮兜底），点击可展开成多行显示完整文字——这是当前唯一能
// 看到写操作具体做了什么的入口（auto_allow 的写工具没有确认卡也没有撤销，是有意为之的
// 产品决定，见 [[decision_write_tools_no_confirm]]），所以不能只靠“精确悬停某一行”才能看全。
function ActivityStepRow({ step, showTabLabel }: { step: ActivityStep; showTabLabel: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const text = showTabLabel ? `《${step.tabLabel}》${step.description}` : step.description;
  const colorClass =
    step.status === 'failed'
      ? 'text-red-700 dark:text-red-300'
      : step.status === 'running'
        ? 'text-neutral-500 dark:text-neutral-400'
        : 'text-neutral-400 dark:text-neutral-500';

  return (
    <div className={`flex gap-2 ${expanded ? 'items-start' : 'items-center'} ${colorClass}`}>
      <span className="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center">
        {step.status === 'running' ? (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
        ) : step.status === 'failed' ? (
          <IconClose className="h-3 w-3" />
        ) : (
          <IconCheck className="h-3 w-3" />
        )}
      </span>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        title={expanded ? undefined : text}
        aria-expanded={expanded}
        className={`min-w-0 flex-1 rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
          expanded ? 'whitespace-pre-wrap break-words' : 'truncate'
        }`}
      >
        {text}
      </button>
    </div>
  );
}
