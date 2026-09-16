import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import { IconAlertTriangle, IconCheck, IconClose } from '../icons';
import type { ActivityStep } from '../store';

export function ActivityStepList({ steps }: { steps: ActivityStep[] }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps]);

  // 常驻提示条取最后一步的目标标签——不随滚动消失，让用户不用翻步骤记录就知道"现在在哪"。
  // 在面板自己的 tab 上操作时 tabLabel 为空，不显示（跟逐行前缀同一条规则）。
  const currentTabLabel = steps.at(-1)?.tabLabel;

  // 运行期给更多行数：写任务的工具预算是 40 步（system-prompt.ts），128px 只露 5~6 行，
  // 用户想看清刚才改了什么得在一个小滚动区里翻。已经全部结束的列表（含消息里的存档版）
  // 保持紧凑，不占版面。
  const running = steps.some((step) => step.status === 'running');

  // 序号只给真正的工具调用（有 signature 的行）。流程提示和接管痕迹不是"第几步"，
  // 给它们编号会让计数看起来比实际操作次数多。
  let toolStepIndex = 0;
  const numbering = steps.map((step) => (step.signature === undefined ? undefined : (toolStepIndex += 1)));

  return (
    <div className="flex flex-col gap-1">
      {currentTabLabel && (
        <div className="px-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t('agentActivity.currentTab', { target: currentTabLabel })}
        </div>
      )}
      {/* 这里**不是** live region。曾经挂着 role="status" aria-live="polite"，但每新增一步
          整个列表都会重排，读屏会把大段内容反复重播。现在由 header 的常驻状态行承担播报——
          一句、经过节流、说的正是"此刻在做什么"；这份明细留给视觉阅读和事后回看。 */}
      <ul
        ref={containerRef}
        aria-label={t('agentActivity.stepsLabel')}
        className={`flex list-none flex-col gap-1 overflow-y-auto px-1 text-xs ${running ? 'max-h-48' : 'max-h-32'}`}
      >
        {steps.map((step, index) => (
          <ActivityStepRow
            key={step.id}
            step={step}
            ordinal={numbering[index]}
            showTabLabel={step.tabLabel !== undefined && step.tabLabel !== steps[index - 1]?.tabLabel}
          />
        ))}
      </ul>
    </div>
  );
}

// 每行默认单行截断（title 悬浮兜底），点击可展开成多行显示完整文字——这是当前唯一能
// 看到写操作具体做了什么的入口（auto_allow 的写工具没有确认卡也没有撤销，是有意为之的
// 产品决定，见 [[decision_write_tools_no_confirm]]），所以不能只靠“精确悬停某一行”才能看全。
function ActivityStepRow({
  step,
  ordinal,
  showTabLabel,
}: {
  step: ActivityStep;
  ordinal: number | undefined;
  showTabLabel: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const labelled = showTabLabel ? `《${step.tabLabel}》${step.description}` : step.description;
  // 重试合并后的行要说清是第几次：只显示合并前的最后一次会让用户以为它只试了一次就放弃。
  const text = step.attempt && step.attempt > 1
    ? `${labelled}（${t('agentActivity.attempt', { count: String(step.attempt) })}）`
    : labelled;
  // 三档都必须过 WCAG AA 4.5:1（12px 正文按普通文本算），并且“进行中”要比“已完成”更重——
  // 之前 done=neutral-400（亮色约 2.4:1）比 running=neutral-500 还淡，整条列表读起来在褪色。
  const colorClass =
    step.status === 'failed'
      ? 'text-red-700 dark:text-red-300'
      : step.status === 'running'
        ? 'font-medium text-indigo-700 dark:text-indigo-300'
        : step.status === 'notice'
          ? 'font-medium text-amber-700 dark:text-amber-300'
          : 'text-neutral-600 dark:text-neutral-400';

  return (
    <li className={`flex gap-2 ${expanded ? 'items-start' : 'items-center'} ${colorClass}`}>
      <span className="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center">
        {step.status === 'running' ? (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" aria-hidden="true" />
        ) : step.status === 'failed' ? (
          <IconClose className="h-3 w-3" />
        ) : step.status === 'notice' ? (
          // 流程提示不是一次工具调用，画 ✓ 会读成"这件事成功了"。
          <IconAlertTriangle className="h-3 w-3" />
        ) : (
          <IconCheck className="h-3 w-3" />
        )}
      </span>
      {/* 序号给滚动列表一个位置感：24+ 步的写任务里，没有它用户既不知道已经走了多远，
          也认不出合并后的重试行到底是第几步。tabular-nums 让数字不抖。 */}
      {ordinal !== undefined && (
        <span className="shrink-0 tabular-nums text-neutral-400 dark:text-neutral-500" aria-hidden="true">
          {ordinal}.
        </span>
      )}
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
    </li>
  );
}
