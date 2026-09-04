// 记录每个标签页当前是否处在「执行期遮罩生效中」，以及状态条该显示哪句话。
// 用 browser.storage.session 而非模块级变量：MV3 service worker 会被回收，
// 模块级变量活不过这次回收。写法仿 lib/agent/tab-form-fields.ts。
//
// 注意：storage.session 默认只对扩展内可信上下文开放，content script 读不到。
// 因此跳转后的重建不是由 content script 自查，而是由 background 在 tabs.onUpdated
// 里查这张表并重新下发（ref: 2026-08-25-execution-overlay-design.md 的偏差说明）。

export interface TabOverlayState {
  label: string;
  /** 是否显示模拟光标动画；省略/undefined 等同 true。子帧写操作会存 false（见 agent.ts）。 */
  cursor?: boolean;
}

function storageKey(tabId: number): string {
  return `runi:tab-overlay:${tabId}`;
}

export async function getOverlayForTab(tabId: number): Promise<TabOverlayState | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as TabOverlayState | undefined;
}

/** 写入失败（如配额超限）时静默降级：遮罩是纯视觉功能，不值得让一次写入失败中断整个回合。 */
export async function setOverlayForTab(tabId: number, label: string, cursor?: boolean): Promise<void> {
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: { label, cursor } satisfies TabOverlayState });
  } catch {
    // 忽略
  }
}

export async function clearOverlayForTab(tabId: number): Promise<void> {
  try {
    await browser.storage.session.remove(storageKey(tabId));
  } catch {
    // 忽略
  }
}
