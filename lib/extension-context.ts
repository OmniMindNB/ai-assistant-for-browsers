// 扩展被重载/更新（`pnpm dev` 热重载、chrome://extensions 的重新加载、线上版本更新）后，
// Chrome 不会刷新已打开的页面：旧实例注入的内容脚本仍留在页面里继续跑事件监听器，
// 但它的 chrome.runtime / chrome.storage 通道已随旧上下文一起销毁。它和
// content-script-messaging.ts 里的 “Receiving end does not exist” 是相反的两种情况：
// 那个是内容脚本还没跑起来（注入后可重试），这个是内容脚本已经成了孤儿（无论重试多少次
// 都不会恢复，只能让它安静下来，等用户刷新页面）。
//
// 孤儿上下文里的扩展 API 调用有两种报错形态，两种都必须认出来：
// 1. runtime 还挂着，调用时抛 “Extension context invalidated.”——文案可匹配；
// 2. Chrome 已把旧 chrome 对象上的 runtime 整个摘掉。WXT 的 `browser` 是模块加载时缓存的
//    chrome 引用，于是 `browser.runtime.sendMessage` 抛的是
//    “TypeError: Cannot read properties of undefined (reading 'sendMessage')”，
//    文案里没有任何孤儿特征，只能回头看上下文本身是否还活着。
const INVALIDATED_MESSAGE = 'Extension context invalidated';

interface ExtensionNamespace {
  runtime?: { id?: string };
}

/** 当前 JS 上下文的扩展通道是否仍然有效：runtime.id 在上下文失效后必然读不到。 */
export function isExtensionContextAlive(): boolean {
  const scope = globalThis as { chrome?: ExtensionNamespace; browser?: ExtensionNamespace };
  try {
    return Boolean(scope.chrome?.runtime?.id || scope.browser?.runtime?.id);
  } catch {
    return false;
  }
}

/**
 * 这次失败是否来自已失效的扩展上下文。
 *
 * 形态 2 只能靠 isAlive 判断，这仍然是「只吞孤儿错误」：上下文活着时同样的 TypeError
 * 照常判为 false，真 bug 不会被静音；上下文已死时这个脚本发出的任何扩展调用都注定失败，
 * 继续报错只是在用户网站控制台里刷屏。isAlive 可注入仅为测试。
 */
export function isExtensionContextInvalidatedError(
  error: unknown,
  isAlive: () => boolean = isExtensionContextAlive,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(INVALIDATED_MESSAGE)) return true;
  return error != null && !isAlive();
}

/**
 * 跑内容脚本的同步启动体，只吞掉「上下文已失效」这一种错误。
 *
 * 上面说的孤儿场景不止发生在脚本跑起来之后：注入本身就可能落在一个已经死掉的上下文里——
 * 按需注入（content-script-messaging.ts 的 scripting.executeScript）与扩展重载撞在一起，
 * 或页面加载正好跨过重载边界。这时启动体的第一句 browser.runtime.onMessage.addListener
 * 就会同步抛错，而 WXT 生成的入口是 `(async () => { ... await main(ctx) })()` —— 一个没人
 * catch 的 Promise，于是这次同步抛错原样变成用户可见的 “Uncaught (in promise) Error:
 * Extension context invalidated.”（栈指向 main 所在的 content.js 第 2 行）。
 *
 * 对策与已跑起来的孤儿脚本一致：安静退出。此时监听器一个都没挂上，不需要像
 * content.ts 的 handleAsyncFailure 那样反向清理，表现等同于「扩展未启用」，刷新页面即恢复。
 * 只吞这一种错误——启动体里真正的 bug 必须照常炸出来，否则等于把内容脚本的问题全部静音。
 */
export function runIgnoringOrphanContext(
  body: () => void,
  isAlive: () => boolean = isExtensionContextAlive,
): void {
  try {
    body();
  } catch (error) {
    if (isExtensionContextInvalidatedError(error, isAlive)) return;
    throw error;
  }
}
