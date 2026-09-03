// 记录每个标签页上"用户在 agent 执行期间自己动了手"这件事。
// 用 browser.storage.session 而非模块级变量：MV3 service worker 会被回收，模块级变量活不过
// 一次回收；写法与 lib/agent/tab-pending-ask.ts、lib/agent/tab-overlay-state.ts 一致。
//
// 存的是时间戳而不是布尔：接管可能发生多次，网关要能区分"这次接管我问过了"和"用户又动了一次"。

export function takeoverStorageKey(tabId: number): string {
  return `runi:tab-takeover:${tabId}`;
}

export async function getTakeoverForTab(tabId: number): Promise<number | undefined> {
  const key = takeoverStorageKey(tabId);
  try {
    const result = await browser.storage.session.get(key);
    const at = result[key];
    return typeof at === 'number' ? at : undefined;
  } catch {
    // 读不到就当没接管过：这是一个提醒性质的功能，不该因为存储异常挡住整轮任务。
    return undefined;
  }
}

export async function setTakeoverForTab(tabId: number, at: number): Promise<void> {
  try {
    await browser.storage.session.set({ [takeoverStorageKey(tabId)]: at });
  } catch {
    // 忽略：同上，失败时静默降级成"没检测到接管"。
  }
}

export async function clearTakeoverForTab(tabId: number): Promise<void> {
  try {
    await browser.storage.session.remove(takeoverStorageKey(tabId));
  } catch {
    // 忽略
  }
}
