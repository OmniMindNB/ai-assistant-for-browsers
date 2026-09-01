// 运行中状态（activitySteps/pendingConfirmation/pendingQuestion/busy）的跨上下文持久化。
// 写法镜像 lib/agent/tab-session-storage.ts：存 browser.storage.session（而非模块级变量），
// 因为 service worker 会被 Chrome 回收，模块级变量活不过这次回收；storage.session 是
// session 级、不落盘，能跨这次回收存活，浏览器重启后自动清空
// （ref: docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md §5）。
import type { RunSnapshot } from './run-port-protocol';

const KEY_PREFIX = 'runi:agent-run:';

function storageKey(tabId: number): string {
  return `${KEY_PREFIX}${tabId}`;
}

export async function loadRunStateSnapshot(tabId: number): Promise<RunSnapshot | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as RunSnapshot | undefined;
}

/** 写入失败（如配额超限）时静默降级：不抛出、不阻塞调用方，这一次状态就当没同步。 */
export async function saveRunStateSnapshot(tabId: number, snapshot: RunSnapshot): Promise<void> {
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: snapshot });
  } catch {
    // 静默降级，见上方注释
  }
}

export async function clearRunStateSnapshot(tabId: number): Promise<void> {
  await browser.storage.session.remove(storageKey(tabId));
}

/** 冷启动孤儿扫描用：枚举所有仍留有运行态快照的 tabId。 */
export async function listOrphanRunTabIds(): Promise<number[]> {
  const all = await browser.storage.session.get(null);
  return Object.keys(all)
    .filter((key) => key.startsWith(KEY_PREFIX))
    .map((key) => Number(key.slice(KEY_PREFIX.length)))
    .filter((tabId) => Number.isFinite(tabId));
}
