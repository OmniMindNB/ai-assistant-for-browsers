import { type Message, type MessageResponse, type PageContent } from '@/lib/messaging';

// Content Script：页面交互层（ref: technical-plan.md §3.2、§4.1）
export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    browser.runtime.onMessage.addListener(
      (message: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
        if (message.type === 'EXTRACT_PAGE') {
          try {
            sendResponse({ id: message.id, ok: true, data: extractPage() });
          } catch (error) {
            sendResponse({
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return true;
        }
        return false;
      },
    );
  },
});

// 朴素正文提取（Phase 1 将替换为 Readability.js）
function extractPage(): PageContent {
  const text = (document.body?.innerText ?? '').replace(/\s+\n/g, '\n').trim();
  return {
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || 'unknown',
    text,
    length: text.length,
  };
}
