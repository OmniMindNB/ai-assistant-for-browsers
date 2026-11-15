import { IconFileText } from '../icons';

export interface PageContextChipProps {
  /** 悬停 tooltip：解释这类页面为什么读不了。 */
  title: string;
  /** chip 的可见文字：页面标题。 */
  pageTitle: string;
  favIconUrl?: string;
  /** sr-only 状态文本（「当前页面不可用」）。 */
  label: string;
  /** sr-only 状态文本的 id：输入框的 aria-describedby 指到这里。 */
  descriptionId: string;
}

/**
 * 受限页（chrome:// 等）的说明 chip。它不是"引用"——可读的当前页默认进上下文，不需要
 * 任何常驻指示（ref: docs/superpowers/specs/2026-11-15-composer-page-context-chip-design.md）；
 * 这枚 chip 回答的是另一个问题：「这轮为什么读不了页面」。所以只在少数页面上出现、
 * 整体弱化为灰色、没有 ×——受限不是用户能摘掉的状态。
 */
export function PageContextChip({
  title,
  pageTitle,
  favIconUrl,
  label,
  descriptionId,
}: PageContextChipProps) {
  return (
    <span
      data-testid="composer-page-context"
      title={title}
      className="inline-flex max-w-[14rem] shrink-0 items-center gap-1 rounded-full border border-neutral-300 bg-neutral-50 px-2 py-1 text-xs text-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-500"
    >
      <span id={descriptionId} className="sr-only">{label}</span>
      {favIconUrl ? (
        <img src={favIconUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" />
      ) : (
        <IconFileText className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="truncate">{pageTitle}</span>
    </span>
  );
}
