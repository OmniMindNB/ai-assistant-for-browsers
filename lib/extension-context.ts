// 扩展被重载/更新（`pnpm dev` 热重载、chrome://extensions 的重新加载、线上版本更新）后，
// Chrome 不会刷新已打开的页面：旧实例注入的内容脚本仍留在页面里继续跑事件监听器，
// 但它的 chrome.runtime / chrome.storage 通道已随旧上下文一起销毁。此后任何一次扩展 API
// 调用都会以下面这句原样报错。它和 content-script-messaging.ts 里的 “Receiving end does
// not exist” 是相反的两种情况：那个是内容脚本还没跑起来（注入后可重试），这个是内容脚本
// 已经成了孤儿（无论重试多少次都不会恢复，只能让它安静下来，等用户刷新页面）。
const INVALIDATED_MESSAGE = 'Extension context invalidated';

export function isExtensionContextInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(INVALIDATED_MESSAGE);
}
