import { Readability } from '@mozilla/readability';
import { collectOutline, type PageOutlineItem } from '@/lib/page-outline';
import {
  sendMessage,
  type AgentTakeoverPayload,
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
import { isExtensionContextInvalidatedError, runIgnoringOrphanContext } from '@/lib/extension-context';
import { initSelectionAskBubble } from '@/lib/selection-ask-bubble';

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

      void initSelectionAskBubble();
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

// 使用 Readability 提取正文，失败时回退到 innerText（ref: technical-plan.md §4.1）；
// 同时采集 h1-h3 标题骨架（collectOutline，ref: lib/page-outline.ts），两条路径扫的根不同——
// Readability 成功时只扫它解析出的正文容器，回退到 innerText 时没有正文容器可扫，
// 只能扫整个 document，见下方两处调用旁的注释。
function extractPage(): PageContent {
  let text = '';
  let outline: PageOutlineItem[] = [];
  try {
    const docClone = document.cloneNode(true) as Document;
    const article = new Readability(docClone).parse();
    text = (article?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
    if (text && article?.content) {
      // 只扫 Readability 认定的正文容器：直接扫 document 会把导航、侧栏、页脚的标题
      // 也算成小节，骨架就不再是「正文的骨架」。
      outline = collectOutline(new DOMParser().parseFromString(article.content, 'text/html'));
    }
  } catch {
    // 忽略，走回退方案
  }
  if (!text) {
    text = (document.body?.innerText ?? '').replace(/\s+\n/g, '\n').trim();
    // Readability 整体失败时没有正文容器可扫，只能退回整篇文档。
    outline = collectOutline(document);
  }
  return {
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || 'unknown',
    text,
    length: text.length,
    outline: outline.length > 0 ? outline : undefined,
  };
}

function getSelection(): PageSelection {
  return { text: (window.getSelection()?.toString() ?? '').trim() };
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
    void sendMessage('AGENT_TAKEOVER', { via } satisfies AgentTakeoverPayload).catch((error: unknown) => {
      if (!isExtensionContextInvalidatedError(error)) console.error('[Runi] content script error:', error);
    });
  };

  window.addEventListener('click', observe('click'), { capture: true, passive: true });
  window.addEventListener('keydown', observe('keydown'), { capture: true, passive: true });
}
