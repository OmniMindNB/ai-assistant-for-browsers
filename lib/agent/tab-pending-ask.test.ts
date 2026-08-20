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
    await setPendingAskForTab(TAB_ID, 'selected text');
    expect(await getPendingAskForTab(TAB_ID)).toBe('selected text');
  });

  it('overwrites the previous pending ask when set again', async () => {
    await setPendingAskForTab(TAB_ID, 'first');
    await setPendingAskForTab(TAB_ID, 'second');
    expect(await getPendingAskForTab(TAB_ID)).toBe('second');
  });

  it('clears the pending ask', async () => {
    await setPendingAskForTab(TAB_ID, 'selected text');
    await clearPendingAskForTab(TAB_ID);
    expect(await getPendingAskForTab(TAB_ID)).toBeUndefined();
  });

  it('isolates pending asks between different tabs', async () => {
    await setPendingAskForTab(1, 'for tab 1');
    await setPendingAskForTab(2, 'for tab 2');
    expect(await getPendingAskForTab(1)).toBe('for tab 1');
    expect(await getPendingAskForTab(2)).toBe('for tab 2');
  });

  it('degrades silently when persisting fails (e.g. storage quota exceeded)', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await setPendingAskForTab(TAB_ID, 'selected text');
    expect(await getPendingAskForTab(TAB_ID)).toBeUndefined();
  });

  it('does not throw when clearing a pending ask that was never set', async () => {
    await expect(clearPendingAskForTab(TAB_ID)).resolves.toBeUndefined();
  });
});
