// 每个标签页一份"本轮"快照，用于"撤销本轮更改"。
// 快照只在本轮第一次写操作时创建（beginSnapshotIfNeeded），
// RESET_TURN_SNAPSHOT（新一轮开始）或 REVERT_CHANGES（撤销后）会清空它。
//
// 持久化到 browser.storage.session（而非模块级 Map）：MV3 service worker 空闲
// ~30s 后会被终止、下次事件时重启，这会清空任何模块级变量，导致"撤销"静默失效。
// storage.session 是浏览器进程内的存储，专为"跨 SW 重启存活"设计，不落盘。

export interface StorageSnapshotEntry {
  area: 'local' | 'session';
  key: string;
  previousValue: string | null;
}

export interface CapturePageState {
  url: string;
  bodyHTML: string;
  scrollX: number;
  scrollY: number;
}

export interface TurnSnapshot extends CapturePageState {
  storageEntries: StorageSnapshotEntry[];
}

function storageKey(tabId: number): string {
  return `turnSnapshot:${tabId}`;
}

export async function hasSnapshot(tabId: number): Promise<boolean> {
  return (await getSnapshot(tabId)) !== undefined;
}

export async function getSnapshot(tabId: number): Promise<TurnSnapshot | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as TurnSnapshot | undefined;
}

/**
 * 若该 tab 本轮还没有快照，用给定的页面状态创建一份并持久化；已存在则原样返回，不覆盖。
 * 持久化失败（如配额超限）时静默降级：不抛出、不阻塞调用方，只是这次不会被记住——
 * 后续 hasSnapshot 仍会是 false，撤销时会走"本轮没有可撤销的改动"这条已有路径。
 */
export async function beginSnapshotIfNeeded(tabId: number, capture: CapturePageState): Promise<TurnSnapshot> {
  const existing = await getSnapshot(tabId);
  if (existing) return existing;
  const created: TurnSnapshot = { ...capture, storageEntries: [] };
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: created });
  } catch {
    // 静默降级，见上方注释
  }
  return created;
}

/** 记录某个 storage key 本轮修改前的值；同一个 key 本轮只记录一次（保留最早的原值）。 */
export async function recordStorageEntryIfAbsent(tabId: number, entry: StorageSnapshotEntry): Promise<void> {
  const snapshot = await getSnapshot(tabId);
  if (!snapshot) return;
  const exists = snapshot.storageEntries.some((e) => e.area === entry.area && e.key === entry.key);
  if (exists) return;
  const updated: TurnSnapshot = { ...snapshot, storageEntries: [...snapshot.storageEntries, entry] };
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: updated });
  } catch {
    // 静默降级，见 beginSnapshotIfNeeded 注释
  }
}

export async function clearSnapshot(tabId: number): Promise<void> {
  await browser.storage.session.remove(storageKey(tabId));
}
