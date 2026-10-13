// 浏览器"加载失败页"（chrome-error://，断网、域名/端口不可达、证书错误等）的识别与文案。
// 这类页面上任何 scripting.executeScript / tabs.sendMessage 都会以
// "Frame with ID 0 is showing error page" 失败。以前这句英文原样（或被包成"内容脚本未就绪，
// 可能是 chrome:// 受限页"）交给模型，模型看不出是地址打不开，会换着参数反复读同一个错误页。

const CHROME_ERROR_PAGE_MARKER = 'showing error page';

export function isErrorPageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(CHROME_ERROR_PAGE_MARKER);
}

export const TAB_SHOWS_ERROR_PAGE_ERROR =
  '该标签页当前显示的是浏览器的加载失败页（网址打不开：断网、域名或端口不可达、证书错误等），页面里没有任何可读内容。'
  + '不要再对这个标签页换参数重复读取或查找；请换一个地址重新打开或跳转，或用 browser_switch_tab 回到其他标签页。';

/** background 统一出口：把错误页导致的底层报错换成模型看得懂的说明，其余错误原样返回。 */
export function normalizeTabError(error: unknown): unknown {
  return isErrorPageError(error) ? new Error(TAB_SHOWS_ERROR_PAGE_ERROR) : error;
}

/** open/navigate 落在错误页时报错文案里的固定短语，也用来从工具结果里认出这类失败。 */
const ERROR_PAGE_PHRASE = '浏览器显示的是错误页';

/** 在已知停在错误页的标签页上仍然放行的工具：它们正是离开错误页的办法。 */
const ERROR_PAGE_ESCAPE_TOOLS: ReadonlySet<string> = new Set(['browser_navigate', 'browser_go_back']);

export function describeErrorPageBlock(tabId: number): string {
  return `标签页 ${tabId} 停在浏览器加载失败页上，前面的调用已经确认它没有任何页面内容，这次调用未执行。`
    + '请用 browser_navigate 换一个地址（确认页面已恢复时也可以用它重新加载）、browser_go_back 返回上一页，'
    + '或用 browser_switch_tab 切回其他标签页；如果现有信息已经够用，直接作答。';
}

/**
 * 停在错误页上的标签页记一笔，之后对它的读写调用直接拦下。连续失败拦截按"工具+参数"认重复，
 * 模型把 maxChars 从 40000 换成 20000、把查找词从 E2B 换成"沙箱"就绕过去了
 * （ref: 2026-10-13 导出日志，同一个错误页上换着参数读了 8 次）。错误页是标签页级的状态，
 * 不管换什么工具、什么参数结果都一样，所以按标签页记。被拦下的调用走 recordPreExecutionBlock，
 * 连续两次会触发收尾轮。
 * 只看依赖目标页的工具：open_tab 失败时新标签页已经关掉、当前目标没变，不能记到当前目标头上。
 */
export interface ErrorPageGuard {
  preflight(toolName: string, tabId: number, targetIndependent: boolean): string | undefined;
  record(tabId: number, targetIndependent: boolean, isError: boolean, resultText: string): void;
}

export function createErrorPageGuard(): ErrorPageGuard {
  const errorPageTabs = new Set<number>();
  return {
    preflight(toolName, tabId, targetIndependent) {
      if (targetIndependent || ERROR_PAGE_ESCAPE_TOOLS.has(toolName) || !errorPageTabs.has(tabId)) return undefined;
      return describeErrorPageBlock(tabId);
    },
    record(tabId, targetIndependent, isError, resultText) {
      if (targetIndependent) return;
      // 在这个标签页上有任何调用成功，说明它已经不在错误页上了（跳走了或页面恢复了）。
      if (!isError) {
        errorPageTabs.delete(tabId);
        return;
      }
      if (resultText.includes(TAB_SHOWS_ERROR_PAGE_ERROR) || resultText.includes(ERROR_PAGE_PHRASE)) {
        errorPageTabs.add(tabId);
      }
    },
  };
}

function describeLanding(requestedUrl: string, landedUrl: string): string {
  return landedUrl && landedUrl !== requestedUrl ? `${requestedUrl}（经重定向到 ${landedUrl}）` : requestedUrl;
}

export function describeOpenTabErrorPage(requestedUrl: string, landedUrl: string): string {
  return `网址打不开：${describeLanding(requestedUrl, landedUrl)} 加载后${ERROR_PAGE_PHRASE}`
    + '（断网、域名或端口不可达、证书错误等），没有页面内容，已关闭这个新标签页。'
    + '不要重复打开同一地址；可以换一个地址（如站内其他入口、补全或去掉末尾斜杠），或直接根据已有页面内容作答。';
}

export function describeNavigateErrorPage(requestedUrl: string, landedUrl: string): string {
  return `跳转失败：${describeLanding(requestedUrl, landedUrl)} 加载后${ERROR_PAGE_PHRASE}`
    + '（断网、域名或端口不可达、证书错误等），没有页面内容。该标签页现在停在错误页上；'
    + '可以用 browser_go_back 回到上一页，或换一个地址再跳转，不要重复跳转同一地址。';
}
