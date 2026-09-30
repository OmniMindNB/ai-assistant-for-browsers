// browser_navigate 的等待编排：entrypoints/background.ts 只做原始 I/O
// （browser.tabs.update / browser.tabs.get），"到底跳没跳走、报什么"放在这里，
// 沿用 history-nav.ts / open-tab.ts 的依赖注入做法。
import { sanitizePageText } from './form-schema';
import type { NavigateTabResult } from '@/lib/messaging';

const MAX_PAGE_TITLE_CHARS = 120;

/**
 * 跳转结束后标签页仍停在原地址。最常见的是目标地址被浏览器当成文件下载（服务器按
 * application/x-sh、application/zip 之类返回）：已有页面的标签页不会被关，只是原地不动。
 * 以前这种情况被报成"经重定向最终停在 <原页面>"，模型会把原页面当成目标地址的内容。
 */
export const NAVIGATION_STAYED_ERROR =
  '跳转没有生效，标签页仍停在原页面。这个地址很可能触发的是文件下载（如 .sh/.zip/.exe 等非网页内容），'
  + '也可能返回了无内容响应，或经重定向又回到了原页面。浏览器工具读不到下载文件的内容；'
  + '不要重复跳转同一个地址，请改从引用它的网页或文档页获取说明，或如实告诉用户无法直接查看该文件。';

export interface NavigateDeps {
  /** 读取标签页当前状态；标签页已关闭时解析为 undefined，不抛异常。 */
  getTab: () => Promise<{ url?: string; title?: string } | undefined>;
  /** 让标签页开始加载 url。 */
  update: (url: string) => Promise<void>;
  /** 等到页面加载完成、标签页被关闭或超时；恒 resolve，不抛异常。 */
  onceLoadComplete: () => Promise<void>;
}

/** 按浏览器的方式规范化（补尾部斜杠、小写主机名），解析失败时原样比较。 */
function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

export async function performNavigate(requestedUrl: string, deps: NavigateDeps): Promise<NavigateTabResult> {
  const before = await deps.getTab();

  await deps.update(requestedUrl);
  // 等落地再回读：不等的话最终地址永远等于请求地址，重定向（典型如被踢到登录页）
  // 对模型完全不可见，它会以为自己已经站在目标页上。
  await deps.onceLoadComplete();

  const settled = await deps.getTab();
  if (!settled) throw new Error('目标标签页已关闭。');

  const landed = settled.url || requestedUrl;
  const beforeUrl = before?.url ? normalizeUrl(before.url) : undefined;
  // 请求的就是当前地址（刷新）时，停在原地是预期结果，不算失败。
  if (beforeUrl !== undefined && normalizeUrl(landed) === beforeUrl && normalizeUrl(requestedUrl) !== beforeUrl) {
    throw new Error(NAVIGATION_STAYED_ERROR);
  }

  return {
    url: landed,
    requestedUrl,
    // 标题由网页控制，属于不可信数据，按纯文本净化并截断后才交给模型。
    title: settled.title ? sanitizePageText(settled.title, MAX_PAGE_TITLE_CHARS) : undefined,
  };
}
