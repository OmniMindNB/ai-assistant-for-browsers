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

function describeLanding(requestedUrl: string, landedUrl: string): string {
  return landedUrl && landedUrl !== requestedUrl ? `${requestedUrl}（经重定向到 ${landedUrl}）` : requestedUrl;
}

export function describeOpenTabErrorPage(requestedUrl: string, landedUrl: string): string {
  return `网址打不开：${describeLanding(requestedUrl, landedUrl)} 加载后浏览器显示的是错误页`
    + '（断网、域名或端口不可达、证书错误等），没有页面内容，已关闭这个新标签页。'
    + '不要重复打开同一地址；可以换一个地址（如站内其他入口、补全或去掉末尾斜杠），或直接根据已有页面内容作答。';
}

export function describeNavigateErrorPage(requestedUrl: string, landedUrl: string): string {
  return `跳转失败：${describeLanding(requestedUrl, landedUrl)} 加载后浏览器显示的是错误页`
    + '（断网、域名或端口不可达、证书错误等），没有页面内容。该标签页现在停在错误页上；'
    + '可以用 browser_go_back 回到上一页，或换一个地址再跳转，不要重复跳转同一地址。';
}
