import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  SIDE_PANEL_PATH,
  clearPanelOpenedForTab,
  decideTabPanelOptions,
  isPanelOpenedForTab,
  listPanelOpenedTabs,
  markPanelOpenedForTab,
  panelScopeStorageKey,
} from './tab-panel-scope';
import type { SidePanelApi } from './tab-panel-scope';
import { enableAndOpenPanelForTab } from './tab-panel-scope';

(globalThis as any).browser = fakeBrowser;

describe('tab-panel-scope', () => {
  const TAB_ID = 1;

  beforeEach(() => {
    fakeBrowser.reset();
  });

  describe('decideTabPanelOptions', () => {
    // 这条是本模块存在的理由：manifest 的 side_panel.default_path 让 Chrome 默认在所有
    // 标签页启用面板，只有显式写入 enabled:false 才会在切过去时把跟来的面板关掉。
    it('disables the panel on a tab the user never opened it on', () => {
      expect(decideTabPanelOptions(TAB_ID, false)).toEqual({
        tabId: TAB_ID,
        path: SIDE_PANEL_PATH,
        enabled: false,
      });
    });

    it('enables the panel on a tab the user opened it on', () => {
      expect(decideTabPanelOptions(TAB_ID, true)).toEqual({
        tabId: TAB_ID,
        path: SIDE_PANEL_PATH,
        enabled: true,
      });
    });

    it('points at the same panel document the manifest declares', () => {
      expect(SIDE_PANEL_PATH).toBe('sidepanel.html');
    });
  });

  it('reports no panel for an untouched tab', async () => {
    expect(await isPanelOpenedForTab(TAB_ID)).toBe(false);
  });

  it('remembers a tab the panel was opened on', async () => {
    await markPanelOpenedForTab(TAB_ID);
    expect(await isPanelOpenedForTab(TAB_ID)).toBe(true);
  });

  it('keeps tabs independent of each other', async () => {
    await markPanelOpenedForTab(TAB_ID);
    expect(await isPanelOpenedForTab(2)).toBe(false);
  });

  it('forgets a tab once cleared', async () => {
    await markPanelOpenedForTab(TAB_ID);
    await clearPanelOpenedForTab(TAB_ID);
    expect(await isPanelOpenedForTab(TAB_ID)).toBe(false);
  });

  it('does not throw when clearing a tab that was never marked', async () => {
    await expect(clearPanelOpenedForTab(TAB_ID)).resolves.toBeUndefined();
  });

  // Service Worker 被回收后模块级变量会清空，记录必须活在 storage.session 里，
  // 否则回收一次就再也认不出"这个标签页是用户打开过面板的"。写法仿 tab-conversation.test.ts。
  it('reads the record back through a fresh module instance', async () => {
    await markPanelOpenedForTab(TAB_ID);

    vi.resetModules();
    const fresh = await import('./tab-panel-scope');

    expect(await fresh.isPanelOpenedForTab(TAB_ID)).toBe(true);
  });

  describe('listPanelOpenedTabs', () => {
    it('is empty before any panel is opened', async () => {
      expect(await listPanelOpenedTabs()).toEqual([]);
    });

    it('enumerates every marked tab so a restarted worker can restore them', async () => {
      await markPanelOpenedForTab(1);
      await markPanelOpenedForTab(7);
      expect((await listPanelOpenedTabs()).sort((a, b) => a - b)).toEqual([1, 7]);
    });

    it('ignores other extension keys living in the same session storage', async () => {
      await markPanelOpenedForTab(1);
      await browser.storage.session.set({
        'runi:tab-conversation:9': 'c-1',
        'runi:tab-pending-ask:9': 'hello',
      });
      expect(await listPanelOpenedTabs()).toEqual([1]);
    });

    it('degrades to an empty list when session storage cannot be read', async () => {
      await markPanelOpenedForTab(1);
      vi.spyOn(fakeBrowser.storage.session, 'get').mockRejectedValueOnce(new Error('boom'));
      expect(await listPanelOpenedTabs()).toEqual([]);
    });
  });

  it('degrades silently when persisting fails (e.g. storage quota exceeded)', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await expect(markPanelOpenedForTab(TAB_ID)).resolves.toBeUndefined();
    expect(await isPanelOpenedForTab(TAB_ID)).toBe(false);
  });

  // 读失败时必须按"没打开过"处理：让用户重新点一次图标，好过把面板漏到别的标签页上。
  it('treats an unreadable record as "panel not opened here"', async () => {
    await markPanelOpenedForTab(TAB_ID);
    vi.spyOn(fakeBrowser.storage.session, 'get').mockRejectedValueOnce(new Error('boom'));
    expect(await isPanelOpenedForTab(TAB_ID)).toBe(false);
  });

  it('exposes a per-tab storage key', () => {
    expect(panelScopeStorageKey(TAB_ID)).toBe('runi:tab-panel-open:1');
  });
});

describe('enableAndOpenPanelForTab', () => {
  const TAB_ID = 7;

  /** setOptions 停在未决状态，用来证明 open() 没有等它。 */
  function makeSidePanel() {
    const calls: string[] = [];
    let settleSetOptions!: (err?: Error) => void;
    const sidePanel: SidePanelApi = {
      setOptions: vi.fn((options) => {
        calls.push(`setOptions:${JSON.stringify(options)}`);
        return new Promise<void>((resolve, reject) => {
          settleSetOptions = (err) => (err ? reject(err) : resolve());
        });
      }),
      open: vi.fn(() => {
        calls.push('open');
        return Promise.resolve();
      }),
    };
    return { sidePanel, calls, settleSetOptions: (err?: Error) => settleSetOptions(err) };
  }

  // 本项目最容易复发的一条：只要在 open() 前面插入任何 await，Chrome 就判定用户手势已失效，
  // 抛 "`sidePanel.open()` may only be called in response to a user gesture."（2026-09-02 实测）。
  // 所以这里同步断言——函数还没被 await 过，open() 就必须已经发起。
  it('dispatches open() in the same synchronous turn, without awaiting setOptions', async () => {
    const { sidePanel, calls, settleSetOptions } = makeSidePanel();

    const pending = enableAndOpenPanelForTab(sidePanel, TAB_ID);

    expect(calls).toEqual([
      `setOptions:${JSON.stringify({ tabId: TAB_ID, path: SIDE_PANEL_PATH, enabled: true })}`,
      'open',
    ]);
    settleSetOptions();
    await expect(pending).resolves.toEqual({ opened: true });
  });

  it('reports the raw error when open() is rejected', async () => {
    const sidePanel: SidePanelApi = {
      setOptions: vi.fn(() => Promise.resolve()),
      open: vi.fn(() => Promise.reject(new Error('`sidePanel.open()` may only be called in response to a user gesture.'))),
    };

    await expect(enableAndOpenPanelForTab(sidePanel, TAB_ID)).resolves.toEqual({
      opened: false,
      error: '`sidePanel.open()` may only be called in response to a user gesture.',
    });
  });

  // setOptions 失败不代表面板没开（它可能只是重复设置同样的值），open() 的结果才算数。
  it('still reports opened when setOptions fails but open succeeds', async () => {
    const { sidePanel, settleSetOptions } = makeSidePanel();

    const pending = enableAndOpenPanelForTab(sidePanel, TAB_ID);
    settleSetOptions(new Error('boom'));

    await expect(pending).resolves.toEqual({ opened: true, setOptionsError: 'boom' });
  });

  it('reports a failure instead of throwing when the API is unavailable', async () => {
    await expect(enableAndOpenPanelForTab(undefined, TAB_ID)).resolves.toEqual({
      opened: false,
      error: 'sidePanel.open 不可用',
    });
  });
});
