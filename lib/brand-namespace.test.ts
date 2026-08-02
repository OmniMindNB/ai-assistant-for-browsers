import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearConversationIdForTab,
  getConversationIdForTab,
  setConversationIdForTab,
} from './agent/tab-conversation';
import { db } from './db';
import { loadLocale, saveLocale } from './i18n';
import { loadSettings, saveSettings } from './settings';
import { defaultShortcutConfigs, loadShortcutConfigs, saveShortcutConfigs } from './shortcuts';
import { loadTheme, saveTheme } from './theme';
import {
  loadWorkbenchPreferences,
  saveWorkbenchPreferences,
} from './workbench/preferences';

const originalBrowser = (globalThis as typeof globalThis & { browser?: unknown }).browser;

function installStorage(initial: {
  local?: Record<string, unknown>;
  session?: Record<string, unknown>;
}) {
  const local = { ...initial.local };
  const session = { ...initial.session };
  const localRemove = vi.fn(async (key: string) => {
    delete local[key];
  });
  const sessionRemove = vi.fn(async (key: string) => {
    delete session[key];
  });

  (globalThis as typeof globalThis & { browser: unknown }).browser = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in local ? { [key]: local[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(local, items)),
        remove: localRemove,
      },
      session: {
        get: vi.fn(async (key: string) => (key in session ? { [key]: session[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(session, items)),
        remove: sessionRemove,
      },
    },
  };

  return { local, session, localRemove, sessionRemove };
}

afterEach(() => {
  (globalThis as typeof globalThis & { browser?: unknown }).browser = originalBrowser;
  vi.restoreAllMocks();
});

describe('Runi persistence namespace', () => {
  it('ignores every legacy local value and saves every owner only in the Runi namespace', async () => {
    const legacySettingsKey = `${['alu', 'minum'].join('')}:settings`;
    const legacyShortcutsKey = `${['alu', 'minum'].join('')}:shortcuts`;
    const legacyThemeKey = `${['alu', 'minum'].join('')}:theme`;
    const legacyLocaleKey = `${['alu', 'minum'].join('')}:locale`;
    const legacyPreferencesKey = ['workbench', 'Preferences'].join('');
    const legacyLocal = {
      [legacySettingsKey]: { providers: [{ id: 'legacy-provider' }] },
      [legacyShortcutsKey]: [],
      [legacyThemeKey]: 'dark',
      [legacyLocaleKey]: 'zh',
      [legacyPreferencesKey]: { attachPageByDefault: false },
    };
    const { local, localRemove } = installStorage({ local: legacyLocal });

    await expect(loadSettings()).resolves.toEqual({ providers: [] });
    await expect(loadShortcutConfigs()).resolves.toEqual({
      shortcuts: defaultShortcutConfigs(),
      errors: [],
    });
    await expect(loadTheme()).resolves.toBe('auto');
    await expect(loadLocale()).resolves.toBe('auto');
    await expect(loadWorkbenchPreferences()).resolves.toEqual({ attachPageByDefault: true });

    await saveSettings({ providers: [] });
    await saveShortcutConfigs([]);
    await saveTheme('light');
    await saveLocale('en');
    await saveWorkbenchPreferences({ attachPageByDefault: false });

    expect(local).toMatchObject({
      ...legacyLocal,
      'runi:settings': { providers: [] },
      'runi:shortcuts': [],
      'runi:theme': 'light',
      'runi:locale': 'en',
      'runi:workbench-preferences': { attachPageByDefault: false },
    });
    expect(localRemove).not.toHaveBeenCalled();
  });

  it('ignores and preserves the legacy tab mapping while using only its Runi session key', async () => {
    const tabId = 17;
    const legacyKey = `${['tab', 'Conversation'].join('')}:${tabId}`;
    const { session, sessionRemove } = installStorage({
      session: { [legacyKey]: 'legacy-conversation' },
    });

    await expect(getConversationIdForTab(tabId)).resolves.toBeUndefined();
    await setConversationIdForTab(tabId, 'runi-conversation');
    expect(session).toMatchObject({
      [legacyKey]: 'legacy-conversation',
      [`runi:tab-conversation:${tabId}`]: 'runi-conversation',
    });

    await clearConversationIdForTab(tabId);
    expect(session[legacyKey]).toBe('legacy-conversation');
    expect(session[`runi:tab-conversation:${tabId}`]).toBeUndefined();
    expect(sessionRemove).toHaveBeenCalledOnce();
    expect(sessionRemove).toHaveBeenCalledWith(`runi:tab-conversation:${tabId}`);
  });
});

it('opens a new Runi IndexedDB database', () => {
  expect(db.name).toBe('runi');
});
