import { describe, expect, it } from 'vitest';
import { TabSessionController, createTabSession, formatTabList } from './tab-session';

describe('TabSessionController', () => {
  it('defaults to a single tracked tab: the panel tab itself', () => {
    const session = createTabSession(1);
    expect(session.currentTabId).toBe(1);
    expect(session.trackedTabs).toEqual([{ id: 1 }]);
    expect(session.isTracked(1)).toBe(true);
  });

  it('injects the panel tab when restoring a snapshot that lost it', () => {
    const session = new TabSessionController(1, { currentTabId: 2, trackedTabs: [{ id: 2, title: 'B' }] });
    expect(session.trackedTabs.map((t) => t.id)).toEqual([1, 2]);
    expect(session.currentTabId).toBe(2);
  });

  it('opens a new tab and makes it the current target', () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2, title: 'Example', url: 'https://example.com' });
    expect(session.currentTabId).toBe(2);
    expect(session.trackedTabs).toEqual([{ id: 1 }, { id: 2, title: 'Example', url: 'https://example.com' }]);
  });

  it('updates an already-tracked tab instead of duplicating it', () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2, title: 'First', url: 'https://a.example.com' });
    session.openAndSwitch({ id: 2, title: 'Reloaded', url: 'https://a.example.com/next' });
    expect(session.trackedTabs).toHaveLength(2);
    expect(session.trackedTabs[1]).toEqual({ id: 2, title: 'Reloaded', url: 'https://a.example.com/next' });
  });

  it('switches to a tracked tab', () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2 });
    session.openAndSwitch({ id: 3 });
    expect(session.switchTo(2)).toEqual({ ok: true });
    expect(session.currentTabId).toBe(2);
  });

  it('refuses to switch to an untracked tab and leaves currentTabId unchanged', () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2 });
    const result = session.switchTo(999);
    expect(result.ok).toBe(false);
    expect(session.currentTabId).toBe(2);
  });

  it('refuses to close the panel tab', () => {
    const session = createTabSession(1);
    const result = session.close(1);
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(session.isTracked(1)).toBe(true);
  });

  it('refuses to close an untracked tab', () => {
    const session = createTabSession(1);
    const result = session.close(999);
    expect(result.ok).toBe(false);
  });

  it('closes a non-current tracked tab without changing currentTabId', () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2 });
    session.openAndSwitch({ id: 3 });
    session.switchTo(2);
    const result = session.close(3);
    expect(result).toEqual({ ok: true, fellBackToPanelTab: false });
    expect(session.currentTabId).toBe(2);
    expect(session.isTracked(3)).toBe(false);
  });

  it('closing the current tab falls back to the panel tab', () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2 });
    const result = session.close(2);
    expect(result).toEqual({ ok: true, fellBackToPanelTab: true });
    expect(session.currentTabId).toBe(1);
  });

  it('round-trips through a snapshot', () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2, title: 'Example', url: 'https://example.com' });
    const restored = new TabSessionController(1, session.snapshot());
    expect(restored.currentTabId).toBe(2);
    expect(restored.trackedTabs).toEqual(session.trackedTabs);
  });
});

describe('formatTabList', () => {
  it('marks the panel tab and the current target', () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2, title: 'Example', url: 'https://example.com' });
    const text = formatTabList(session);
    expect(text).toContain('1');
    expect(text).toContain('2');
    expect(text).toContain('Example');
    expect(text).toContain('https://example.com');
    expect(text).toContain('面板');
    expect(text).toContain('当前操作目标');
  });
});
