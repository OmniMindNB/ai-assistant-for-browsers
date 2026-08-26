// TabSessionController 的跨轮持久化。持久化到 browser.storage.session（而非模块级变量）：
// MV3 service worker 会被回收，模块级变量活不过这次回收；storage.session 是 session 级、
// 不落盘，跨这次回收依然存活。写法仿 lib/agent/tab-form-fields.ts。
import { TabSessionController, type TabSessionSnapshot } from './tab-session';

function storageKey(panelTabId: number): string {
  return `runi:tab-session:${panelTabId}`;
}

export async function loadTabSession(panelTabId: number): Promise<TabSessionController> {
  const key = storageKey(panelTabId);
  const result = await browser.storage.session.get(key);
  const snapshot = result[key] as TabSessionSnapshot | undefined;
  return new TabSessionController(panelTabId, snapshot);
}

/** 写入失败（如配额超限）时静默降级：不抛出、不阻塞调用方，这一轮的追踪状态就当没保存。 */
export async function saveTabSession(session: TabSessionController): Promise<void> {
  try {
    await browser.storage.session.set({ [storageKey(session.panelTabId)]: session.snapshot() });
  } catch {
    // 静默降级，见上方注释
  }
}
