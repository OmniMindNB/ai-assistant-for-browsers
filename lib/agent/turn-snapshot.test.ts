import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginSnapshotIfNeeded,
  clearSnapshot,
  getSnapshot,
  hasSnapshot,
  recordStorageEntryIfAbsent,
} from './turn-snapshot';

describe('turn-snapshot', () => {
  const TAB_ID = 1;

  beforeEach(() => {
    clearSnapshot(TAB_ID);
  });

  it('has no snapshot for an untouched tab', () => {
    expect(hasSnapshot(TAB_ID)).toBe(false);
    expect(getSnapshot(TAB_ID)).toBeUndefined();
  });

  it('creates a snapshot on first call and keeps it on later calls', () => {
    const first = beginSnapshotIfNeeded(TAB_ID, {
      url: 'https://a.example',
      bodyHTML: '<p>a</p>',
      scrollX: 0,
      scrollY: 0,
    });
    const second = beginSnapshotIfNeeded(TAB_ID, {
      url: 'https://b.example',
      bodyHTML: '<p>b</p>',
      scrollX: 10,
      scrollY: 20,
    });
    expect(first).toBe(second);
    expect(getSnapshot(TAB_ID)?.url).toBe('https://a.example');
  });

  it('records a storage entry only once per key', () => {
    beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '', scrollX: 0, scrollY: 0 });
    recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'light' });
    recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'dark' });
    expect(getSnapshot(TAB_ID)?.storageEntries).toEqual([
      { area: 'local', key: 'theme', previousValue: 'light' },
    ]);
  });

  it('does nothing when recording a storage entry without an existing snapshot', () => {
    recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'light' });
    expect(hasSnapshot(TAB_ID)).toBe(false);
  });

  it('clears the snapshot', () => {
    beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '', scrollX: 0, scrollY: 0 });
    clearSnapshot(TAB_ID);
    expect(hasSnapshot(TAB_ID)).toBe(false);
  });
});
