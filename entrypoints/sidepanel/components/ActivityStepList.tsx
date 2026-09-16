import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from '@/lib/i18n';
import type { TranslationKey } from '@/lib/i18n';
import type { ToolCategory } from '@/lib/agent/activity-category';
import { summarizeActivity } from '@/lib/agent/activity-summary';
import {
  IconAlertTriangle,
  IconCamera,
  IconChevronDown,
  IconCheck,
  IconClock,
  IconClose,
  IconEye,
  IconGlobe,
  IconHelpCircle,
  IconMessage,
  IconPencil,
  IconPointer,
} from '../icons';
import type { ActivityStep } from '../store';

const CATEGORY_ICON: Record<ToolCategory, (props: { className?: string }) => ReactElement> = {
  read: IconEye,
  screenshot: IconCamera,
  write: IconPencil,
  interact: IconPointer,
  navigate: IconGlobe,
  wait: IconClock,
  ask: IconHelpCircle,
  report: IconCheck,
};

const CATEGORY_LABEL: Record<ToolCategory, TranslationKey> = {
  read: 'agentActivity.category.read',
  screenshot: 'agentActivity.category.screenshot',
  write: 'agentActivity.category.write',
  interact: 'agentActivity.category.interact',
  navigate: 'agentActivity.category.navigate',
  wait: 'agentActivity.category.wait',
  ask: 'agentActivity.category.ask',
  report: 'agentActivity.category.report',
};

export function ActivityStepList({ steps }: { steps: ActivityStep[] }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLUListElement>(null);
  const running = steps.some((step) => step.status === 'running');
  const summary = summarizeActivity(steps);
  // 结束后默认收起，但这一轮有失败就保持展开——那恰恰是最该被看见的（写操作既无确认卡
  // 也无撤销，这条时间线是唯一能看清它做了什么的地方）。
  const [manuallyExpanded, setManuallyExpanded] = useState<boolean | null>(null);
  const expanded = manuallyExpanded ?? (running || summary.hasFailure);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps]);

  // 常驻提示条取最后一步的目标标签——不随滚动消失，让用户不用翻步骤记录就知道"现在在哪"。
  // 在面板自己的 tab 上操作时 tabLabel 为空，不显示（跟逐行前缀同一条规则）。
  const currentTabLabel = steps.at(-1)?.tabLabel;

  const categoryNames = summary.categories.map((category) => t(CATEGORY_LABEL[category]));
  const summaryText = running
    ? t('agentActivity.summary.running', { count: String(summary.toolStepCount) })
    : categoryNames.length > 0
      ? t('agentActivity.summary.line', {
          categories: categoryNames.join(t('agentActivity.summary.separator')),
          count: String(summary.toolStepCount),
        })
      : t('agentActivity.summary.countOnly', { count: String(summary.toolStepCount) });

  return (
    <div className="flex flex-col gap-1">
      {/* 折叠头：收起时它就是这一轮活动的全部交代，所以摘要句要能独立读懂。 */}
      <button
        type="button"
        onClick={() => setManuallyExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={expanded ? t('agentActivity.summary.collapse') : t('agentActivity.summary.expand')}
        className="flex w-full items-center gap-1 rounded-sm px-1 text-left text-xs text-neutral-500 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        <span className="min-w-0 flex-1 truncate">{summaryText}</span>
        <IconChevronDown
          className={`h-3 w-3 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
        />
      </button>
      {expanded && currentTabLabel && (
        <div className="px-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t('agentActivity.currentTab', { target: currentTabLabel })}
        </div>
      )}
      {/* 这里**不是** live region。曾经挂着 role="status" aria-live="polite"，但每新增一步
          整个列表都会重排，读屏会把大段内容反复重播。现在由 header 的常驻状态行承担播报——
          一句、经过节流、说的正是"此刻在做什么"；这份明细留给视觉阅读和事后回看。 */}
      {expanded && (
        <ul
          ref={containerRef}
          aria-label={t('agentActivity.stepsLabel')}
          // 运行中限高内滚（40 步的写任务不限高会把输入框顶出视野）；跑完之后列表不再增长，
          // 让它自然铺开，读起来就是一条完整的时间线。
          className={`flex list-none flex-col overflow-y-auto px-1 text-xs ${running ? 'max-h-48' : ''}`}
        >
          {steps.map((step, index) => (
            <ActivityStepRow
              key={step.id}
              step={step}
              isLast={index === steps.length - 1}
              showTabLabel={step.tabLabel !== undefined && step.tabLabel !== steps[index - 1]?.tabLabel}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// 每行默认单行截断（title 悬浮兜底），点击可展开成多行显示完整文字——这是当前唯一能
// 看到写操作具体做了什么的入口（auto_allow 的写工具没有确认卡也没有撤销，是有意为之的
// 产品决定，见 [[decision_write_tools_no_confirm]]），所以不能只靠“精确悬停某一行”才能看全。
function ActivityStepRow({
  step,
  isLast,
  showTabLabel,
}: {
  step: ActivityStep;
  isLast: boolean;
  showTabLabel: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const labelled = showTabLabel ? `《${step.tabLabel}》${step.description}` : step.description;
  // 重试合并后的行要说清是第几次：只显示合并前的最后一次会让用户以为它只试了一次就放弃。
  const text = step.attempt && step.attempt > 1
    ? `${labelled}（${t('agentActivity.attempt', { count: String(step.attempt) })}）`
    : labelled;

  // 成功的一步不再画 ✓：图标位现在标的是"做哪类事"，成败交给颜色，只有失败才额外画 ✗。
  // 三档非灰色都必须过 WCAG AA 4.5:1（12px 正文按普通文本算）。
  const colorClass =
    step.status === 'failed'
      ? 'text-red-700 dark:text-red-300'
      : step.status === 'running'
        ? 'font-medium text-indigo-700 dark:text-indigo-300'
        : step.status === 'notice'
          ? 'font-medium text-amber-700 dark:text-amber-300'
          : step.status === 'narration'
            ? 'italic text-neutral-600 dark:text-neutral-400'
            : 'text-neutral-600 dark:text-neutral-400';

  const CategoryIcon = step.category ? CATEGORY_ICON[step.category] : undefined;

  return (
    <li className={`flex gap-2 ${colorClass}`}>
      {/* 图标列自带一截竖线，把相邻两步串成一条时间线；最后一行不画，否则线会悬空。 */}
      <div className="flex shrink-0 flex-col items-center">
        <span className="flex h-4 w-3 items-center justify-center">
          {step.status === 'failed' ? (
            <IconClose className="h-3 w-3" />
          ) : step.status === 'running' ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" aria-hidden="true" />
          ) : step.status === 'notice' ? (
            // 流程提示不是一次工具调用，画类别图标会读成"它做了这件事"。
            <IconAlertTriangle className="h-3 w-3" />
          ) : step.status === 'narration' ? (
            // 对话气泡：这一行是模型说的话，不是它做的事。
            <IconMessage className="h-3 w-3" />
          ) : CategoryIcon ? (
            <CategoryIcon className="h-3 w-3" />
          ) : (
            <span className="h-1 w-1 rounded-full bg-current opacity-60" aria-hidden="true" />
          )}
        </span>
        {!isLast && <span className="w-px flex-1 bg-neutral-200 dark:bg-neutral-700" aria-hidden="true" />}
      </div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        title={expanded ? undefined : text}
        aria-expanded={expanded}
        className={`min-w-0 flex-1 rounded-sm pb-1.5 text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
          expanded ? 'whitespace-pre-wrap break-words' : 'truncate'
        }`}
      >
        {text}
      </button>
      {/* 结果计数右对齐，跟描述文字拉开：它是补充信息，不该参与左边那列的阅读节奏。 */}
      {step.resultNote && (
        <span className="shrink-0 pb-1.5 tabular-nums text-neutral-400 dark:text-neutral-500">
          {step.resultNote}
        </span>
      )}
    </li>
  );
}
