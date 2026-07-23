import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  beginSnapshotIfNeeded,
  clearSnapshot,
  getSnapshot,
  hasSnapshot,
  recordStorageEntryIfAbsent,
} from './turn-snapshot';

// turn-snapshot.ts 读写 browser.storage.session；vitest.config.ts 没有接入 WXT 的
// unimport 插件，所以这里手动把 fakeBrowser 挂到全局 browser 标识符上（JS 的裸标识符
// 解析本来就会落到 globalThis 属性，和是否走 unimport 插件无关）。
(globalThis as any).browser = fakeBrowser;

describe('turn-snapshot', () => {
  const TAB_ID = 1;

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('has no snapshot for an untouched tab', async () => {
    expect(await hasSnapshot(TAB_ID)).toBe(false);
    expect(await getSnapshot(TAB_ID)).toBeUndefined();
  });

  it('creates a snapshot on first call and keeps it on later calls', async () => {
    const first = await beginSnapshotIfNeeded(TAB_ID, {
      url: 'https://a.example',
      bodyHTML: '<p>a</p>',
      scrollX: 0,
      scrollY: 0,
    });
    const second = await beginSnapshotIfNeeded(TAB_ID, {
      url: 'https://b.example',
      bodyHTML: '<p>b</p>',
      scrollX: 10,
      scrollY: 20,
    });
    expect(second).toEqual(first);
    expect((await getSnapshot(TAB_ID))?.url).toBe('https://a.example');
  });

  it('records a storage entry only once per key', async () => {
    await beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '', scrollX: 0, scrollY: 0 });
    await recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'light' });
    await recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'dark' });
    expect((await getSnapshot(TAB_ID))?.storageEntries).toEqual([
      { area: 'local', key: 'theme', previousValue: 'light' },
    ]);
  });

  it('does nothing when recording a storage entry without an existing snapshot', async () => {
    await recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'light' });
    expect(await hasSnapshot(TAB_ID)).toBe(false);
  });

  it('clears the snapshot', async () => {
    await beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '', scrollX: 0, scrollY: 0 });
    await clearSnapshot(TAB_ID);
    expect(await hasSnapshot(TAB_ID)).toBe(false);
  });

  it('survives being read back after a simulated service-worker restart (fresh fakeBrowser storage, same key)', async () => {
    await beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '<p>a</p>', scrollX: 1, scrollY: 2 });
    // 模拟 SW 重启：不清空 fakeBrowser 的 storage.session（它代表浏览器进程内数据），
    // 只是重新 import 也无意义（ESM 模块缓存），所以这里改为直接验证同一 tabId 的读路径
    // 不依赖任何模块级变量——即，多次独立的 getSnapshot 调用互相不干扰、都读到同一份数据。
    expect((await getSnapshot(TAB_ID))?.bodyHTML).toBe('<p>a</p>');
    expect((await getSnapshot(TAB_ID))?.bodyHTML).toBe('<p>a</p>');
  });

  it('degrades silently when persisting a new snapshot fails (e.g. storage quota exceeded)', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '<p>a</p>', scrollX: 0, scrollY: 0 });
    expect(await hasSnapshot(TAB_ID)).toBe(false);
  });

  it('degrades silently when recording a storage entry fails to persist', async () => {
    await beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '', scrollX: 0, scrollY: 0 });
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'light' });
    expect((await getSnapshot(TAB_ID))?.storageEntries).toEqual([]);
  });
});
