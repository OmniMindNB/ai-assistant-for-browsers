import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { clearConversationIdForTab, getConversationIdForTab, setConversationIdForTab } from './tab-conversation';

(globalThis as any).browser = fakeBrowser;

describe('tab-conversation', () => {
  const TAB_ID = 1;

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('has no conversation mapping for an untouched tab', async () => {
    expect(await getConversationIdForTab(TAB_ID)).toBeUndefined();
  });

  it('stores and reads back a conversation id', async () => {
    await setConversationIdForTab(TAB_ID, 'c-1');
    expect(await getConversationIdForTab(TAB_ID)).toBe('c-1');
  });

  it('overwrites the previous mapping when set again', async () => {
    await setConversationIdForTab(TAB_ID, 'c-1');
    await setConversationIdForTab(TAB_ID, 'c-2');
    expect(await getConversationIdForTab(TAB_ID)).toBe('c-2');
  });

  it('clears the mapping', async () => {
    await setConversationIdForTab(TAB_ID, 'c-1');
    await clearConversationIdForTab(TAB_ID);
    expect(await getConversationIdForTab(TAB_ID)).toBeUndefined();
  });

  it('reads a mapping back through a fresh module instance (proves it is not held in module-level state)', async () => {
    await setConversationIdForTab(TAB_ID, 'c-1');

    // 模拟侧边栏面板文档被销毁重建（切走 tab 再切回）：重置模块注册表后重新 import，
    // 得到全新的模块实例。fakeBrowser 的 storage.session 数据不受影响。
    vi.resetModules();
    const fresh = await import('./tab-conversation');

    expect(await fresh.getConversationIdForTab(TAB_ID)).toBe('c-1');
  });

  it('degrades silently when persisting fails (e.g. storage quota exceeded)', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await setConversationIdForTab(TAB_ID, 'c-1');
    expect(await getConversationIdForTab(TAB_ID)).toBeUndefined();
  });

  it('does not throw when clearing a mapping that was never set', async () => {
    await expect(clearConversationIdForTab(TAB_ID)).resolves.toBeUndefined();
  });
});
