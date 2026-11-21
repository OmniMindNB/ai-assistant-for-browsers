import { isExtensionContextInvalidatedError } from './extension-context';
import { loadLocale, resolveLocale } from './i18n/core';
import { SELECTION_ASK_BUBBLE_LABEL } from './i18n/locales/selection-ask-bubble-label';
import { sendMessage, type AskSelectionPayload } from './messaging';
import {
  SELECTION_ASK_ENABLED_KEY,
  clampBubblePosition,
  clipSelectionContext,
  loadSelectionAskEnabled,
  truncateSelectionText,
} from './selection-ask';

const BUBBLE_SIZE = { width: 88, height: 32 };
const BUBBLE_BUTTON_STYLE =
  'all: initial; display: inline-flex; align-items: center; justify-content: center; ' +
  'width: 88px; height: 32px; border-radius: 9999px; border: none; cursor: pointer; ' +
  'background: #4f46e5; color: #ffffff; ' +
  'font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; ' +
  'box-shadow: 0 2px 8px rgba(0,0,0,0.24);';

interface BubbleOptions {
  label: string;
  onAsk: (payload: AskSelectionPayload) => void;
  acceptsRange?: (range: Range) => boolean;
  getContext?: (range: Range, text: string) => string | undefined;
}

export function mountSelectionAskBubble(options: BubbleOptions): () => void {
  let host: HTMLElement | null = null;
  const listeners = new AbortController();

  function removeBubble() {
    host?.remove();
    host = null;
  }

  function onMouseUp(event: MouseEvent) {
    if (host && event.composedPath().includes(host)) return;
    removeBubble();

    const selection = window.getSelection();
    const text = truncateSelectionText(selection?.toString() ?? '');
    if (!text || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (options.acceptsRange && !options.acceptsRange(range)) return;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    // 点击气泡时浏览器可能已清除选区，提前克隆 Range。
    const snapshot = range.cloneRange();

    const { top, left } = clampBubblePosition(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      BUBBLE_SIZE,
    );
    host = document.createElement('div');
    host.style.cssText = `position: fixed; z-index: 2147483647; top: ${top}px; left: ${left}px;`;
    const shadow = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = options.label;
    button.style.cssText = BUBBLE_BUTTON_STYLE;
    button.addEventListener('click', () => {
      removeBubble();
      const context = options.getContext?.(snapshot, text);
      options.onAsk(context ? { text, context } : { text });
    });
    shadow.appendChild(button);
    document.documentElement.appendChild(host);
  }

  const { signal } = listeners;
  document.addEventListener('mouseup', onMouseUp, { signal });
  document.addEventListener('mousedown', (event) => {
    if (host && !event.composedPath().includes(host)) removeBubble();
  }, { capture: true, signal });
  document.addEventListener('scroll', removeBubble, { capture: true, signal });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') removeBubble();
  }, { signal });

  return () => {
    listeners.abort();
    removeBubble();
  };
}

/** 在网页与 PDF 阅读器中应用同一个开关和气泡样式。 */
export async function initSelectionAskBubble(
  { acceptsRange, includeContext = true }: { acceptsRange?: BubbleOptions['acceptsRange']; includeContext?: boolean } = {},
): Promise<void> {
  let unmount: (() => void) | undefined;
  const onError = (error: unknown) => {
    if (isExtensionContextInvalidatedError(error)) {
      unmount?.();
      return;
    }
    console.error('[Runi] selection ask:', error);
  };

  try {
    const locale = resolveLocale(await loadLocale());
    const setEnabled = (enabled: boolean) => {
      if (enabled === Boolean(unmount)) return;
      if (enabled) {
        unmount = mountSelectionAskBubble({
          label: SELECTION_ASK_BUBBLE_LABEL[locale],
          acceptsRange,
          getContext: includeContext ? selectionContextOf : undefined,
          onAsk: (payload) => { void sendMessage('ASK_SELECTION', payload).catch(onError); },
        });
      } else {
        unmount?.();
        unmount = undefined;
      }
    };
    setEnabled(await loadSelectionAskEnabled());
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !(SELECTION_ASK_ENABLED_KEY in changes)) return;
      setEnabled((changes[SELECTION_ASK_ENABLED_KEY].newValue as boolean | undefined) ?? true);
    });
  } catch (error) {
    onError(error);
  }
}
/** 往上找几层就够了：再往上通常是整栏、整页，开窗后也只剩选区附近那一截。 */
const MAX_CONTEXT_ANCESTOR_DEPTH = 8;

/**
 * 选区所在段落：从选区的公共祖先往上找第一个文字比选区多出一截的块级元素，取它的可见文字，
 * 再交给 clipSelectionContext 开窗。取不到（或段落就是选区本身）时返回 undefined，
 * 划词提问照常只带选区。
 */
function selectionContextOf(range: Range, selection: string): string | undefined {
  try {
    const ancestor = range.commonAncestorContainer;
    let element: Element | null = ancestor instanceof Element ? ancestor : ancestor.parentElement;
    for (let depth = 0; element && element !== document.documentElement && depth < MAX_CONTEXT_ANCESTOR_DEPTH; depth += 1) {
      const display = getComputedStyle(element).display;
      if (element instanceof HTMLElement && !display.startsWith('inline') && display !== 'contents') {
        const context = clipSelectionContext(element.innerText, selection);
        if (context) return context;
      }
      element = element.parentElement;
    }
  } catch {
    // 取上下文只是锦上添花，任何异常都退回只带选区。
  }
  return undefined;
}
