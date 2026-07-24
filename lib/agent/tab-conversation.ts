// 每个标签页记录"当前面板正在展示哪个会话"，用于按-tab 侧边栏文档被销毁重建后
// （见 entrypoints/background.ts 的按-tab sidePanel 绑定）恢复上一次的对话。
//
// 持久化到 browser.storage.session（而非模块级变量）：面板切到别的 tab 时 Chrome 会
// 整个销毁面板文档，切回时重新加载——任何模块级变量都会被清空，只有 storage.session
// 能跨这次"文档重建"存活（同时不落盘，浏览器重启后自动清空）。

function storageKey(tabId: number): string {
  return `tabConversation:${tabId}`;
}

export async function getConversationIdForTab(tabId: number): Promise<string | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as string | undefined;
}

/** 写入失败（如配额超限）时静默降级：不抛出、不阻塞调用方，只是这次不会被记住。 */
export async function setConversationIdForTab(tabId: number, conversationId: string): Promise<void> {
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: conversationId });
  } catch {
    // 静默降级，见上方注释
  }
}

export async function clearConversationIdForTab(tabId: number): Promise<void> {
  await browser.storage.session.remove(storageKey(tabId));
}
