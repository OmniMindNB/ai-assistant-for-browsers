import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from '@/lib/i18n';
import { clampBubblePosition } from '@/lib/selection-ask';
import { IconMessage } from '../icons';

/** 选区停止变化多久后才出按钮：拖选过程中 selectionchange 连发，按钮跟着跳会很晃。 */
export const REPLY_QUOTE_SETTLE_MS = 150;

/** 定位用的按钮尺寸估计；首帧还没量到真实尺寸时用它，偏差只影响几像素的避让。 */
const FALLBACK_BUBBLE_SIZE = { width: 96, height: 28 };

interface Pending {
  text: string;
  top: number;
  left: number;
}

function replyBodyOf(node: Node | null): Element | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest('[data-reply-body]') ?? null;
}

/**
 * 在侧边栏里选中一段助手回复时，浮出"追问"按钮；点下去把选区交给 onQuote 当作引用。
 * 只认 containerRef 内、落在同一个 [data-reply-body] 里的选区——用户消息、思考过程、
 * 步骤列表都不挂这个标记，跨两条回复的选区也不算（引用的应该是一处具体的话）。
 */
export function ReplyQuoteBubble({
  containerRef,
  onQuote,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onQuote(text: string): void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const evaluate = useCallback(() => {
    const selection = window.getSelection();
    const container = containerRef.current;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container) {
      setPending(null);
      return;
    }
    const body = replyBodyOf(selection.anchorNode);
    const text = selection.toString().trim();
    if (!body || body !== replyBodyOf(selection.focusNode) || !container.contains(body) || !text) {
      setPending(null);
      return;
    }
    const range = selection.getRangeAt(0);
    // jsdom 等环境没有 Range.getBoundingClientRect，退回整条回复的位置。
    const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : body.getBoundingClientRect();
    const measured = buttonRef.current?.getBoundingClientRect();
    const size = measured && measured.width > 0 ? { width: measured.width, height: measured.height } : FALLBACK_BUBBLE_SIZE;
    setPending({ text, ...clampBubblePosition(rect, { width: window.innerWidth, height: window.innerHeight }, size) });
  }, [containerRef]);

  useEffect(() => {
    let timer: number | undefined;
    const onSelectionChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(evaluate, REPLY_QUOTE_SETTLE_MS);
    };
    // 滚动时按钮会和选区脱节；先藏起来，停下后由用户重新选或继续 selectionchange 再出。
    const hide = () => setPending(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    const container = containerRef.current;
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeyDown);
    container?.addEventListener('scroll', hide, { passive: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown);
      container?.removeEventListener('scroll', hide);
    };
  }, [containerRef, evaluate]);

  if (!pending) return null;
  return (
    <button
      ref={buttonRef}
      type="button"
      style={{ position: 'fixed', top: pending.top, left: pending.left }}
      // 按下时不抢焦点：否则选区先被清掉，用户看到高亮消失却还没点成。
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onQuote(pending.text);
        window.getSelection()?.removeAllRanges();
        setPending(null);
      }}
      className="z-30 flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 shadow-lg transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
    >
      <IconMessage className="h-3.5 w-3.5" />
      {t('workbench.quoteReplyButton')}
    </button>
  );
}
