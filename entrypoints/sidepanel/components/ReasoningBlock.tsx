import { useEffect, useId, useRef, useState } from 'react';
import { REASONING_SEGMENT_HEAD_CHARS } from '@/lib/agent/reasoning';
import { useTranslation } from '@/lib/i18n';

// 推理过程折叠块（ref: docs/superpowers/specs/2026-09-24-reasoning-display-design.md §3.4，
// 按段限量的修订见 2026-09-24-reasoning-per-segment-budget-design.md §3.6）。
// 纯文本渲染、不走 Markdown：流式期间每 48ms 重渲一次，Markdown 解析成本太高，推理文本也不依赖排版。
// 内容区不是 live region——状态播报只交给 header 那一行（沿用 2026-09-03 走查 P2-9 的约定）。
export function ReasoningBlock({
  segments,
  trimmedChars,
  droppedSegments = 0,
  omittedChars,
  running,
  autoExpand,
}: {
  segments: string[];
  /** 与 segments 等长：每段中间省略的字数，截断点固定在 REASONING_SEGMENT_HEAD_CHARS。 */
  trimmedChars?: number[];
  /** 最前面不在 segments 里的段数；段数与编号都从它往后数。 */
  droppedSegments?: number;
  omittedChars?: number;
  /** 本轮最后一条消息且运行中：标题保持进行时，与有没有正文无关。 */
  running: boolean;
  /** 运行中且还没有正文：默认展开并自动滚到底。 */
  autoExpand: boolean;
}) {
  const { t } = useTranslation();
  // null = 跟随自动状态；用户点过之后记住选择，自动状态不再覆盖（不持久化）。
  const [manual, setManual] = useState<boolean | null>(null);
  const contentId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const expanded = manual ?? autoExpand;
  const totalChars = segments.reduce((sum, segment) => sum + segment.length, 0);
  const totalSegments = droppedSegments + segments.length;

  useEffect(() => {
    if (!running || !expanded) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [running, expanded, totalChars]);

  if (segments.length === 0) return null;

  const title = running
    ? totalSegments > 1
      ? t('chat.reasoning.liveSegment', { n: totalSegments })
      : t('chat.reasoning.live')
    : totalSegments > 1
      ? t('chat.reasoning.doneSegments', { count: totalSegments })
      : t('chat.reasoning.done');

  // 新记录用段数；存量记录只有 omittedChars（旧滑动窗口删掉的字数），沿用原文案。
  const omittedNotice = droppedSegments > 0
    ? omittedChars
      ? t('chat.reasoning.droppedSegmentsWithChars', { count: droppedSegments, chars: omittedChars })
      : t('chat.reasoning.droppedSegments', { count: droppedSegments })
    : omittedChars
      ? t('chat.reasoning.omitted', { count: omittedChars })
      : null;

  return (
    <div className="mb-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? contentId : undefined}
        onClick={() => setManual(!expanded)}
        className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-neutral-500 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        <span aria-hidden="true" className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>
          ›
        </span>
        <span className={running ? 'animate-pulse' : undefined}>{title}</span>
      </button>
      {expanded && (
        <div
          id={contentId}
          ref={scrollRef}
          className={`mt-1.5 overflow-y-auto border-l-2 border-neutral-200 pl-3 text-xs leading-relaxed text-neutral-500 dark:border-neutral-700 dark:text-neutral-400 ${
            autoExpand ? 'max-h-40' : 'max-h-80'
          }`}
        >
          {omittedNotice ? (
            <p className="mb-1 italic text-neutral-400 dark:text-neutral-500">{omittedNotice}</p>
          ) : null}
          {segments.map((segment, index) => {
            const trimmed = trimmedChars?.[index] ?? 0;
            return (
              <div key={droppedSegments + index} className={index > 0 ? 'mt-2' : undefined}>
                {totalSegments > 1 && (
                  <p className="mb-0.5 font-medium text-neutral-400 dark:text-neutral-500">
                    {t('chat.reasoning.segment', { n: droppedSegments + index + 1 })}
                  </p>
                )}
                {trimmed > 0 ? (
                  <>
                    <p className="whitespace-pre-wrap break-words">{segment.slice(0, REASONING_SEGMENT_HEAD_CHARS)}</p>
                    <p className="my-0.5 italic text-neutral-400 dark:text-neutral-500">
                      {t('chat.reasoning.trimmed', { count: trimmed })}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{segment.slice(REASONING_SEGMENT_HEAD_CHARS)}</p>
                  </>
                ) : (
                  <p className="whitespace-pre-wrap break-words">{segment}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
