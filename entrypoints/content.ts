import { Readability } from '@mozilla/readability';
import {
  type Message,
  type MessageResponse,
  type PageContent,
  type PageSelection,
} from '@/lib/messaging';

// Content Script：页面交互层（ref: technical-plan.md §3.2、§4.1）
export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
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
        return false;
      },
    );
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
