import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  loadWorkbenchPreferences,
  saveWorkbenchPreferences,
  WORKBENCH_PREFERENCES_KEY,
} from './preferences';

const originalBrowser = (globalThis as any).browser;

function installStorage(value: Record<string, unknown> = {}) {
  const get = vi.fn(async (key: string) => (key in value ? { [key]: value[key] } : {}));
  const set = vi.fn(async (items: Record<string, unknown>) => Object.assign(value, items));
  (globalThis as any).browser = {
    storage: { local: { get, set } },
  };
  return { get, set, value };
}

afterEach(() => {
  (globalThis as any).browser = originalBrowser;
  vi.restoreAllMocks();
});

describe('workbench preferences', () => {
  it('returns safe defaults when the key is absent', async () => {
    installStorage();

    await expect(loadWorkbenchPreferences()).resolves.toEqual({
      defaultMode: 'ask',
      attachPageByDefault: true,
    });
  });

  it('rejects invalid persisted values without rewriting storage', async () => {
    const { set } = installStorage({
      workbenchPreferences: { defaultMode: 'unsafe', attachPageByDefault: 'yes' },
    });

    await expect(loadWorkbenchPreferences()).rejects.toThrow('Invalid workbench preferences');
    expect(set).not.toHaveBeenCalled();
  });

  it('returns a valid stored preference record unchanged', async () => {
    const stored = { defaultMode: 'agent' as const, attachPageByDefault: false };
    installStorage({ [WORKBENCH_PREFERENCES_KEY]: stored });

    await expect(loadWorkbenchPreferences()).resolves.toEqual(stored);
  });

  it('persists a complete preference record under the dedicated key', async () => {
    const { set } = installStorage();
    const preferences = { ...DEFAULT_WORKBENCH_PREFERENCES, defaultMode: 'agent' as const };

    await saveWorkbenchPreferences(preferences);

    expect(set).toHaveBeenCalledWith({ [WORKBENCH_PREFERENCES_KEY]: preferences });
  });
});
