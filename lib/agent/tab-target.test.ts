import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { resolveTargetTab } from './tab-target';

// 和 turn-snapshot.test.ts 一样：vitest.config.ts 没接 WXT 的 unimport 插件，
// 手动把 fakeBrowser 挂到全局 browser 标识符上。
(globalThis as any).browser = fakeBrowser;

describe('resolveTargetTab', () => {
  let windowId: number;

  beforeEach(async () => {
    fakeBrowser.reset();
    const window = await fakeBrowser.windows.create();
    windowId = window.id!;
  });

  it('resolves an existing tab by id', async () => {
    const created = await fakeBrowser.tabs.create({ url: 'https://a.example', windowId });
    const resolved = await resolveTargetTab(created.id!);
    expect(resolved).toEqual({ id: created.id, windowId: created.windowId, active: created.active ?? false });
  });

  it('throws a clear error when the target tab was closed', async () => {
    const created = await fakeBrowser.tabs.create({ url: 'https://a.example', windowId });
    await fakeBrowser.tabs.remove(created.id!);
    await expect(resolveTargetTab(created.id!)).rejects.toThrow('目标标签页已关闭。');
  });

  it('throws for a tabId that never existed', async () => {
    await expect(resolveTargetTab(999999)).rejects.toThrow('目标标签页已关闭。');
  });

  it('resolves the pinned tab even when a different tab is the active one', async () => {
    const pinned = await fakeBrowser.tabs.create({ url: 'https://pinned.example', windowId, active: false });
    await fakeBrowser.tabs.create({ url: 'chrome://extensions', windowId, active: true });
    const resolved = await resolveTargetTab(pinned.id!);
    expect(resolved.id).toBe(pinned.id);
    expect(resolved.active).toBe(false);
  });
});
