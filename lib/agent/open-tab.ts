// browser_open_tab 的等待编排：entrypoints/background.ts 只做原始 I/O
// （browser.tabs.create / browser.tabs.get），"开出来的到底是不是一个还活着的网页"这层判断
// 放在这里，沿用 history-nav.ts 的依赖注入做法，好让它能用普通 mock 测。
import { describeOpenTabErrorPage } from './error-page';
import { sanitizePageText } from './form-schema';
import type { OpenNewTabResult } from '@/lib/messaging';

const MAX_PAGE_TITLE_CHARS = 120;

/**
 * 新标签页在加载期间消失了。最常见的原因是这个地址被浏览器当成文件下载（服务器按
 * application/x-sh、application/zip 之类返回，如 https://pi.dev/install.sh）：Chrome 会把
 * 专为这次导航新建的标签页自动关掉。文案要让模型明白"浏览器工具读不到这个文件"，
 * 否则它会换着法子反复打开同一个地址。
 */
export const TAB_CLOSED_WHILE_OPENING_ERROR =
  '新标签页在加载过程中被关闭了——这个地址很可能触发的是文件下载（如 .sh/.zip/.exe 等非网页内容），'
  + '浏览器下载后会自动关掉专为它新建的标签页。浏览器工具读不到下载文件的内容；'
  + '请改从引用它的网页或文档页获取说明，或如实告诉用户无法直接查看该文件。';

export interface OpenTabDeps {
  /** 在后台创建标签页并开始加载 url。 */
  createTab: (url: string) => Promise<{ id?: number }>;
  /** 等到页面加载完成、标签页被关闭或超时；恒 resolve，不抛异常。 */
  onceLoadComplete: (tabId: number) => Promise<void>;
  /** 读取标签页当前状态；标签页已关闭时解析为 undefined，不抛异常。 */
  getTab: (tabId: number) => Promise<{ url?: string; title?: string } | undefined>;
  /** 主框架是否停在浏览器加载失败页上；探测本身出错时解析为 false，不抛异常。 */
  isShowingErrorPage: (tabId: number) => Promise<boolean>;
  /** 关掉标签页；失败也不抛异常。 */
  closeTab: (tabId: number) => Promise<void>;
}

export async function performOpenTab(url: string, deps: OpenTabDeps): Promise<OpenNewTabResult> {
  const created = await deps.createTab(url);
  if (typeof created.id !== 'number') throw new Error('新标签页创建失败。');

  await deps.onceLoadComplete(created.id);

  // 不能把一个已经不存在的 tabId 报成"已打开"：工具层会把它设为当前操作目标，
  // 之后每个工具调用都会撞上"目标标签页已关闭"。
  const settled = await deps.getTab(created.id);
  if (!settled) throw new Error(TAB_CLOSED_WHILE_OPENING_ERROR);

  // 地址打不开时 Chrome 照样留下一个"加载完成"的标签页，只是显示错误页。报成"已打开"的话
  // 它会成为操作目标，之后每个读工具都撞 "showing error page"，模型换着参数白烧十几步。
  // 失败的标签页不会被纳入跟踪，留着只是一个谁也用不到的孤儿，所以顺手关掉。
  if (await deps.isShowingErrorPage(created.id)) {
    await deps.closeTab(created.id);
    throw new Error(describeOpenTabErrorPage(url, settled.url ?? ''));
  }

  return {
    id: created.id,
    url: settled.url || url,
    title: settled.title ? sanitizePageText(settled.title, MAX_PAGE_TITLE_CHARS) : undefined,
  };
}
