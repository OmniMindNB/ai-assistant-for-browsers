import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { clearTabSession, loadTabSession, saveTabSession } from './tab-session-storage';

(globalThis as any).browser = fakeBrowser;

describe('tab-session-storage', () => {
  const PANEL_TAB_ID = 1;

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('returns a fresh single-tab session when nothing was persisted', async () => {
    const session = await loadTabSession(PANEL_TAB_ID);
    expect(session.currentTabId).toBe(PANEL_TAB_ID);
    expect(session.trackedTabs).toEqual([{ id: PANEL_TAB_ID }]);
  });

  it('persists and restores tracked tabs and the current target', async () => {
    const session = await loadTabSession(PANEL_TAB_ID);
    session.openAndSwitch({ id: 2, title: 'Example', url: 'https://example.com' });
    await saveTabSession(session);

    const restored = await loadTabSession(PANEL_TAB_ID);
    expect(restored.currentTabId).toBe(2);
    expect(restored.trackedTabs).toEqual(session.trackedTabs);
  });

  it('isolates sessions between different panel tabs', async () => {
    const sessionA = await loadTabSession(1);
    sessionA.openAndSwitch({ id: 10 });
    await saveTabSession(sessionA);

    const sessionB = await loadTabSession(2);
    expect(sessionB.currentTabId).toBe(2);
    expect(sessionB.isTracked(10)).toBe(false);
  });

  it('degrades silently when persisting fails', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    const session = await loadTabSession(PANEL_TAB_ID);
    session.openAndSwitch({ id: 2 });
    await expect(saveTabSession(session)).resolves.toBeUndefined();
    const restored = await loadTabSession(PANEL_TAB_ID);
    expect(restored.currentTabId).toBe(PANEL_TAB_ID);
  });

  it('clears a persisted session back to a fresh single-tab state', async () => {
    const session = await loadTabSession(PANEL_TAB_ID);
    session.openAndSwitch({ id: 2, title: 'Example' });
    await saveTabSession(session);

    await clearTabSession(PANEL_TAB_ID);

    const restored = await loadTabSession(PANEL_TAB_ID);
    expect(restored.currentTabId).toBe(PANEL_TAB_ID);
    expect(restored.trackedTabs).toEqual([{ id: PANEL_TAB_ID }]);
  });

  it('does not throw when clearing a session that was never saved', async () => {
    await expect(clearTabSession(PANEL_TAB_ID)).resolves.toBeUndefined();
  });
});
