// browser_go_back 的等待编排：entrypoints/background.ts 只做原始 I/O 调用
// （browser.tabs.goBack / browser.tabs.get），"怎么判断退没退、退到哪、标题怎么净化"
// 这套决策逻辑放在这里。
//
// browser.tabs.onUpdated 是 tab 级事件，不能像 wait-dom.ts 那样注入进页面执行，因此这里
// 不用 wait-condition.ts/wait-dom.ts 的"纯函数 + 注入函数"二分，改用依赖注入：
// performGoBack 把浏览器交互作为 GoBackDeps 传入，让"是否移动、报什么"这套判断能用
// 普通 mock 函数测试，不需要 fakeBrowser 或假定时器。
import { sanitizePageText } from './form-schema';
import type { NavigateHistoryResult } from '@/lib/messaging';

/**
 * 等待跳转落地的上限。与 entrypoints/background.ts 的 navigateTab 用的
 * NAVIGATE_SETTLE_TIMEOUT_MS 同值——两处独立定义（history-nav.ts 不从 entrypoints
 * 反向 import），改一处要同步另一处。
 */
export const NAVIGATE_HISTORY_SETTLE_TIMEOUT_MS = 10_000;
const MAX_PAGE_TITLE_CHARS = 120;

export interface GoBackDeps {
  /** 触发后退。无历史可退时部分实现会 reject——见下方 performGoBack 的处理方式。 */
  goBack: () => Promise<void>;
  /** 读取标签页当前状态；标签页已关闭等情况下解析为 undefined，不抛异常。 */
  getTab: () => Promise<{ url?: string; title?: string } | undefined>;
  /** 等到页面加载完成或超时；超时不是错误，恒 resolve，不抛异常。 */
  onceLoadComplete: () => Promise<void>;
}

/**
 * 后退的决策逻辑：触发 → （若触发成功）等待落定 → 比较前后 URL 判定是否真的移动了。
 *
 * webextension-polyfill 对 tabs.goBack 的类型声明只说"if available"，没有明确它在无历史
 * 可退时是 reject 还是静默 resolve 且不做任何事——这里两条路径都处理，且都不解析具体的
 * 错误文案（ref: 设计文档 §3.4："不要按猜测的字符串匹配"）：reject 时直接跳过等待（导航
 * 都没触发，没什么好等的）；resolve 时正常等待落定。两条路径最终都只看"前后 URL 是否
 * 不同"来决定 moved，因此哪种实现都能得出正确结论。
 */
export async function performGoBack(deps: GoBackDeps): Promise<NavigateHistoryResult> {
  const before = await deps.getTab();

  try {
    await deps.goBack();
    await deps.onceLoadComplete();
  } catch {
    // 见上方函数注释：无历史可退时的拒绝，统一收敛成"没有移动"，不解析错误文案。
  }

  const after = await deps.getTab();
  const moved = after?.url !== undefined && after.url !== before?.url;
  const url = after?.url ?? before?.url ?? '';
  const title = after?.title ? sanitizePageText(after.title, MAX_PAGE_TITLE_CHARS) : undefined;

  return { url, title, moved };
}

/**
 * onceLoadComplete 的生产实现：等 tabs.onUpdated 报告这个 tab 变成 complete，或超时静默返回。
 * 与 entrypoints/background.ts 的 navigateTab 用的 waitForTabLoad 是同一个模式，独立定义在
 * 这里（不从 entrypoints 反向 import）。
 */
export async function waitForTabLoadComplete(tabId: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedTabId: number, changeInfo: { status?: string }): void => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}
