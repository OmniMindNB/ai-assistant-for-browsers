import { Readability } from '@mozilla/readability';
import {
  sendMessage,
  type AgentTakeoverPayload,
  type AskSelectionPayload,
  type Message,
  type MessageResponse,
  type PageContent,
  type PageSelection,
  type SetAgentOverlayPayload,
  type SetAgentOverlayResult,
} from '@/lib/messaging';
import { shouldReportTakeover } from '@/lib/agent/takeover-detect';
import {
  getOverlayState,
  mountOverlay,
  moveOverlayCursor,
  pulseOverlayCursor,
  unmountOverlay,
} from '@/lib/agent/agent-overlay';
import {
  isExtensionContextInvalidatedError,
  runIgnoringOrphanContext,
} from '@/lib/extension-context';
import { loadLocale, resolveLocale } from '@/lib/i18n/core';
import { SELECTION_ASK_BUBBLE_LABEL } from '@/lib/i18n/locales/selection-ask-bubble-label';
import {
  SELECTION_ASK_ENABLED_KEY,
  clampBubblePosition,
  loadSelectionAskEnabled,
} from '@/lib/selection-ask';

// Content Script：页面交互层（ref: technical-plan.md §3.2、§4.1）
export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // 启动体整个包一层：WXT 的入口是 `(async () => await main(ctx))()`，一个没人 catch 的
    // Promise，所以这里任何一次同步抛错都会变成用户网站控制台里的 Uncaught (in promise)。
    // 注入落在已失效的上下文里时，下面第一句 addListener 就是这样一条报错（见该函数注释）。
    runIgnoringOrphanContext(() => {
      browser.runtime.onMessage.addListener(
        (message: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
          if (message.type === 'EXTRACT_PAGE') {
            respond(message.id, sendResponse, extractPage);
            return true;
          }
          if (message.type === 'GET_SELECTION') {
            respond(message.id, sendResponse, getSelection);
            return true;
          }
          if (message.type === 'SET_AGENT_OVERLAY') {
            const payload = message.payload as SetAgentOverlayPayload;
            respond(message.id, sendResponse, (): SetAgentOverlayResult => {
              if (payload.active) {
                mountOverlay(payload.label ?? '', payload.cursor ?? true);
              } else {
                unmountOverlay();
              }
              return { active: payload.active };
            });
            return true;
          }
          return false;
        },
      );

      // 不能让这个 Promise 裸奔：内容脚本跑在用户访问的每一个页面里，一次 unhandled rejection
      // 就会在人家网站的控制台留一条红色报错。里面的 storage/i18n 读取都会在扩展重载后失败。
      void initSelectionAskBubble().catch(handleAsyncFailure);
      initAgentCursorBridge();
      initTakeoverWatch();
    });
  },
});

function respond<T>(
  id: string,
  sendResponse: (r: MessageResponse) => void,
  fn: () => T,
): void {
  try {
    sendResponse({ id, ok: true, data: fn() });
  } catch (error) {
    sendResponse({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// 使用 Readability 提取正文，失败时回退到 innerText（ref: technical-plan.md §4.1）
function extractPage(): PageContent {
  let text = '';
  try {
    const docClone = document.cloneNode(true) as Document;
    const article = new Readability(docClone).parse();
    text = (article?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    // 忽略，走回退方案
  }
  if (!text) {
    text = (document.body?.innerText ?? '').replace(/\s+\n/g, '\n').trim();
  }
  return {
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || 'unknown',
    text,
    length: text.length,
  };
}

function getSelection(): PageSelection {
  return { text: (window.getSelection()?.toString() ?? '').trim() };
}

// ---- 划词提问悬浮气泡 ----
// 不能用 lib/i18n 的 t()/applyLocale()：applyLocale() 会写 document.documentElement.lang，
// 在内容脚本里调用会篡改被访问网页本身的 lang 属性。这里只解析一次 locale，
// 直接从 SELECTION_ASK_BUBBLE_LABEL（只含这一个文案的极小模块，见其头部注释）取值——
// 内容脚本跑在每个页面里，不能为一句按钮文案把完整字典和 React 运行时打进产物。
let bubbleLabel = 'Ask Runi';
let bubbleHost: HTMLElement | null = null;
let bubbleSelectionText = '';
let selectionAskEnabled = false;

const BUBBLE_SIZE = { width: 88, height: 32 };
const BUBBLE_BUTTON_STYLE =
  'all: initial; display: inline-flex; align-items: center; justify-content: center; ' +
  'width: 88px; height: 32px; border-radius: 9999px; border: none; cursor: pointer; ' +
  'background: #4f46e5; color: #ffffff; ' +
  'font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; ' +
  'box-shadow: 0 2px 8px rgba(0,0,0,0.24);';

async function initSelectionAskBubble(): Promise<void> {
  const locale = resolveLocale(await loadLocale());
  bubbleLabel = SELECTION_ASK_BUBBLE_LABEL[locale];

  selectionAskEnabled = await loadSelectionAskEnabled();
  if (selectionAskEnabled) attachSelectionAskListeners();

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(SELECTION_ASK_ENABLED_KEY in changes)) return;
    const next = (changes[SELECTION_ASK_ENABLED_KEY].newValue as boolean | undefined) ?? true;
    if (next === selectionAskEnabled) return;
    selectionAskEnabled = next;
    if (selectionAskEnabled) {
      attachSelectionAskListeners();
    } else {
      detachSelectionAskListeners();
      removeBubble();
    }
  });
}

function attachSelectionAskListeners(): void {
  document.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('mousedown', handleOutsideMouseDown, true);
  document.addEventListener('scroll', handleScrollAway, true);
  document.addEventListener('keydown', handleEscapeKey);
}

function detachSelectionAskListeners(): void {
  document.removeEventListener('mouseup', handleMouseUp);
  document.removeEventListener('mousedown', handleOutsideMouseDown, true);
  document.removeEventListener('scroll', handleScrollAway, true);
  document.removeEventListener('keydown', handleEscapeKey);
}

function handleMouseUp(event: MouseEvent): void {
  if (bubbleHost && event.composedPath().includes(bubbleHost)) return;
  removeBubble();
  const selection = window.getSelection();
  const text = (selection?.toString() ?? '').trim();
  if (!text || !selection || selection.rangeCount === 0) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  bubbleSelectionText = text;
  showBubble(rect);
}

function showBubble(rect: DOMRect): void {
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  const { top, left } = clampBubblePosition(
    { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
    { width: window.innerWidth, height: window.innerHeight },
    BUBBLE_SIZE,
  );
  host.style.top = `${top}px`;
  host.style.left = `${left}px`;

  const shadow = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = bubbleLabel;
  button.style.cssText = BUBBLE_BUTTON_STYLE;
  button.addEventListener('click', handleBubbleClick);
  shadow.appendChild(button);

  document.documentElement.appendChild(host);
  bubbleHost = host;
}

function handleBubbleClick(): void {
  const text = bubbleSelectionText;
  removeBubble();
  if (!text) return;
  // addEventListener 不会接住回调返回的 Promise，所以这里必须自己收尾。
  void sendMessage('ASK_SELECTION', { text } satisfies AskSelectionPayload).catch(
    handleAsyncFailure,
  );
}

// 孤儿内容脚本（扩展已重载、这个页面还没刷新）唯一正确的反应是安静下来：重试没有意义，
// 它的 runtime 通道不会再恢复。继续挂着监听器只会让用户每点一次气泡就多一条控制台报错，
// 而且气泡看起来能点、点了却什么都不发生。摘掉监听器后划词不再冒气泡，与「扩展未启用」
// 的表现一致，用户刷新页面即可恢复（新页面会由新扩展实例重新注入内容脚本）。
function handleAsyncFailure(error: unknown): void {
  if (isExtensionContextInvalidatedError(error)) {
    detachSelectionAskListeners();
    removeBubble();
    return;
  }
  console.error('[Runi] content script error:', error);
}

function handleOutsideMouseDown(event: MouseEvent): void {
  if (!bubbleHost) return;
  if (event.composedPath().includes(bubbleHost)) return;
  removeBubble();
}

function handleScrollAway(): void {
  removeBubble();
}

function handleEscapeKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') removeBubble();
}

function removeBubble(): void {
  bubbleHost?.remove();
  bubbleHost = null;
  bubbleSelectionText = '';
}

// ---- 模拟光标的跨 world 桥 ----
// 点击是在 MAIN world 的注入函数里派发的，光标却由这个 ISOLATED world 的内容脚本持有。
// 让注入函数自己算完 rect 后直接派发事件、再 await 250ms，好处是光标停的位置与事件
// 派发的位置必然是同一个值；若改成 background 两段式（先探针取 rect、再下发移动、
// 再注入点击），目标要解析两次，两次之间元素可能已经变了——光标指着 A、实际点了 B，
// 这个功能就从建立信任变成破坏信任（ref: 2026-08-25-execution-overlay-design.md §3.4）。
function initAgentCursorBridge(): void {
  window.addEventListener('runi:cursor-move', (event) => {
    const detail = (event as CustomEvent<{ x?: unknown; y?: unknown }>).detail;
    const x = Number(detail?.x);
    const y = Number(detail?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    moveOverlayCursor(x, y);
  });

  // 点击涟漪走同一条桥：注入函数在真正派发 click 的那一刻发这个事件，所以涟漪与
  // 事件派发是同一个时刻、同一个落点，不会出现"涟漪在 A、点击在 B"。
  window.addEventListener('runi:cursor-click', () => pulseOverlayCursor());
}

// ---- 用户接管检测 ----
// 遮罩全程不拦输入（这是有意的：侧边栏形态下用户随时接管是正常预期），但"不阻断"不等于
// "当没发生"。这里只观察、不拦截：捕获阶段 + passive，绝不 preventDefault，绝不 stopPropagation。
// 判定条件与理由都在 lib/agent/takeover-detect.ts。
function initTakeoverWatch(): void {
  let lastReportedAt = -Infinity;

  const observe = (via: 'click' | 'keydown') => (event: Event) => {
    if (!shouldReportTakeover(event, getOverlayState().mounted, Date.now(), lastReportedAt)) return;
    lastReportedAt = Date.now();
    // addEventListener 不接住回调返回的 Promise，必须自己收尾（同 handleBubbleClick）。
    void sendMessage('AGENT_TAKEOVER', { via } satisfies AgentTakeoverPayload).catch(handleAsyncFailure);
  };

  window.addEventListener('click', observe('click'), { capture: true, passive: true });
  window.addEventListener('keydown', observe('keydown'), { capture: true, passive: true });
}
