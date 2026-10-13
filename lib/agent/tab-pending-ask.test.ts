import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { clearPendingAskForTab, getPendingAskForTab, setPendingAskForTab } from './tab-pending-ask';

(globalThis as any).browser = fakeBrowser;

describe('tab-pending-ask', () => {
  const TAB_ID = 1;

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('has no pending ask for an untouched tab', async () => {
    expect(await getPendingAskForTab(TAB_ID)).toBeUndefined();
  });

  it('stores and reads back a pending ask', async () => {
    await setPendingAskForTab(TAB_ID, { text: 'selected text' });
    expect(await getPendingAskForTab(TAB_ID)).toEqual({ text: 'selected text' });
  });

  it('overwrites the previous pending ask when set again', async () => {
    await setPendingAskForTab(TAB_ID, { text: 'first' });
    await setPendingAskForTab(TAB_ID, { text: 'second' });
    expect(await getPendingAskForTab(TAB_ID)).toEqual({ text: 'second' });
  });

  it('clears the pending ask', async () => {
    await setPendingAskForTab(TAB_ID, { text: 'selected text' });
    await clearPendingAskForTab(TAB_ID);
    expect(await getPendingAskForTab(TAB_ID)).toBeUndefined();
  });

  it('isolates pending asks between different tabs', async () => {
    await setPendingAskForTab(1, { text: 'for tab 1' });
    await setPendingAskForTab(2, { text: 'for tab 2' });
    expect(await getPendingAskForTab(1)).toEqual({ text: 'for tab 1' });
    expect(await getPendingAskForTab(2)).toEqual({ text: 'for tab 2' });
  });

  it('degrades silently when persisting fails (e.g. storage quota exceeded)', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await setPendingAskForTab(TAB_ID, { text: 'selected text' });
    expect(await getPendingAskForTab(TAB_ID)).toBeUndefined();
  });

  it('does not throw when clearing a pending ask that was never set', async () => {
    await expect(clearPendingAskForTab(TAB_ID)).resolves.toBeUndefined();
  });

  it('keeps the selection context alongside the text', async () => {
    await setPendingAskForTab(TAB_ID, { text: 'E2B / Cube', context: '在会话级持久的 Docker / E2B / Cube 沙箱中运行' });
    expect(await getPendingAskForTab(TAB_ID)).toEqual({ text: 'E2B / Cube', context: '在会话级持久的 Docker / E2B / Cube 沙箱中运行' });
  });

  it('still reads a bare-string pending ask written before the context field existed', async () => {
    await fakeBrowser.storage.session.set({ 'runi:tab-pending-ask:1': 'legacy text' });
    expect(await getPendingAskForTab(TAB_ID)).toEqual({ text: 'legacy text' });
  });
});
