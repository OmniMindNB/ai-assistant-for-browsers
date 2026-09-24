import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n';

// 推理过程折叠块（ref: docs/superpowers/specs/2026-09-24-reasoning-display-design.md §3.4）。
// 纯文本渲染、不走 Markdown：流式期间每 48ms 重渲一次，Markdown 解析成本太高，推理文本也不依赖排版。
// 内容区不是 live region——状态播报只交给 header 那一行（沿用 2026-09-03 走查 P2-9 的约定）。
export function ReasoningBlock({
  segments,
  omittedChars,
  live,
}: {
  segments: string[];
  omittedChars?: number;
  /** 本轮最后一条消息、运行中、且还没有正文：此时默认展开并自动滚到底。 */
  live: boolean;
}) {
  const { t } = useTranslation();
  // null = 跟随自动状态；用户点过之后记住选择，自动状态不再覆盖（不持久化）。
  const [manual, setManual] = useState<boolean | null>(null);
  const contentId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const expanded = manual ?? live;
  const totalChars = segments.reduce((sum, segment) => sum + segment.length, 0);

  useEffect(() => {
    if (!live || !expanded) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [live, expanded, totalChars]);

  if (segments.length === 0) return null;

  const title = live
    ? t('chat.reasoning.live')
    : segments.length > 1
      ? t('chat.reasoning.doneSegments', { count: segments.length })
      : t('chat.reasoning.done');

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
        <span className={live ? 'animate-pulse' : undefined}>{title}</span>
      </button>
      {expanded && (
        <div
          id={contentId}
          ref={scrollRef}
          className={`mt-1.5 overflow-y-auto border-l-2 border-neutral-200 pl-3 text-xs leading-relaxed text-neutral-500 dark:border-neutral-700 dark:text-neutral-400 ${
            live ? 'max-h-40' : 'max-h-80'
          }`}
        >
          {omittedChars ? (
            <p className="mb-1 italic text-neutral-400 dark:text-neutral-500">
              {t('chat.reasoning.omitted', { count: omittedChars })}
            </p>
          ) : null}
          {segments.map((segment, index) => (
            <div key={index} className={index > 0 ? 'mt-2' : undefined}>
              {segments.length > 1 && (
                <p className="mb-0.5 font-medium text-neutral-400 dark:text-neutral-500">
                  {t('chat.reasoning.segment', { n: index + 1 })}
                </p>
              )}
              <p className="whitespace-pre-wrap break-words">{segment}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
