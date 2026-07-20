// 每个标签页一份"本轮"快照，用于"撤销本轮更改"。
// 快照只在本轮第一次写操作时创建（beginSnapshotIfNeeded），
// RESET_TURN_SNAPSHOT（新一轮开始）或 REVERT_CHANGES（撤销后）会清空它。

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

const snapshots = new Map<number, TurnSnapshot>();

export function hasSnapshot(tabId: number): boolean {
  return snapshots.has(tabId);
}

export function getSnapshot(tabId: number): TurnSnapshot | undefined {
  return snapshots.get(tabId);
}

/** 若该 tab 本轮还没有快照，用给定的页面状态创建一份；已存在则原样返回，不覆盖。 */
export function beginSnapshotIfNeeded(tabId: number, capture: CapturePageState): TurnSnapshot {
  const existing = snapshots.get(tabId);
  if (existing) return existing;
  const created: TurnSnapshot = { ...capture, storageEntries: [] };
  snapshots.set(tabId, created);
  return created;
}

/** 记录某个 storage key 本轮修改前的值；同一个 key 本轮只记录一次（保留最早的原值）。 */
export function recordStorageEntryIfAbsent(tabId: number, entry: StorageSnapshotEntry): void {
  const snapshot = snapshots.get(tabId);
  if (!snapshot) return;
  const exists = snapshot.storageEntries.some((e) => e.area === entry.area && e.key === entry.key);
  if (!exists) snapshot.storageEntries.push(entry);
}

export function clearSnapshot(tabId: number): void {
  snapshots.delete(tabId);
}
