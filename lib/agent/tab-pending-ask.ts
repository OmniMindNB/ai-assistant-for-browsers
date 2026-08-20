// 每个标签页暂存"划词提问气泡刚提交的选中文字"，供侧边栏面板挂载时消费一次并预填输入框。
// 持久化到 browser.storage.session（而非模块级变量）：面板打开时 Chrome 可能刚把面板文档
// 重新加载，模块级变量活不过这次重建，只有 storage.session 能跨文档重建存活（同时不落盘，
// 浏览器重启后自动清空）。写法仿 lib/agent/tab-conversation.ts。

function storageKey(tabId: number): string {
  return `runi:tab-pending-ask:${tabId}`;
}

export async function getPendingAskForTab(tabId: number): Promise<string | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as string | undefined;
}

/** 写入失败（如配额超限）时静默降级：不抛出、不阻塞调用方，只是这次不会被记住。 */
export async function setPendingAskForTab(tabId: number, text: string): Promise<void> {
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: text });
  } catch {
    // 静默降级，见上方注释
  }
}

export async function clearPendingAskForTab(tabId: number): Promise<void> {
  await browser.storage.session.remove(storageKey(tabId));
}
