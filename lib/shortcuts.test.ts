import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from './i18n/locales/en';
import { zh } from './i18n/locales/zh';
import type { Translate, TranslationKey } from './i18n';
import {
  BUILTIN_EXPLAIN_ID,
  BUILTIN_SUMMARIZE_ID,
  SHORTCUTS_STORAGE_KEY,
  defaultShortcutConfigs,
  loadShortcutConfigs,
  moveShortcut,
  repairShortcutConfigs,
  resolveShortcut,
  restoreDefaultShortcuts,
  saveShortcutConfigs,
  splitShortcutList,
  updateShortcutConfigs,
  validateShortcutConfigs,
  type ShortcutConfig,
} from './shortcuts';
import { buildShortcutExecution } from './chat/shortcut-prompts';

function translator(dict: Record<TranslationKey, string>): Translate {
  return ((key: TranslationKey, vars?: Record<string, string | number>) => {
    const template = dict[key];
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      vars && name in vars ? String(vars[name]) : match,
    );
  }) as Translate;
}

function installStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  const set = vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items));
  (globalThis as any).browser = {
    storage: {
      local: {
        get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
        set,
      },
    },
  };
  return { data, set };
}

const originalBrowser = (globalThis as any).browser;
afterEach(() => {
  (globalThis as any).browser = originalBrowser;
  vi.restoreAllMocks();
});

describe('shortcut defaults and localization', () => {
  it('creates the two stable defaults in canonical order', () => {
    expect(defaultShortcutConfigs().map((item) => item.id)).toEqual([
      BUILTIN_SUMMARIZE_ID,
      BUILTIN_EXPLAIN_ID,
    ]);
  });

  it('resolves an unedited built-in through the current locale', () => {
    const summarize = defaultShortcutConfigs()[0];
    expect(resolveShortcut(summarize, translator(zh)).name).toBe('总结本页');
    expect(resolveShortcut(summarize, translator(en)).name).toBe('Summarize page');
  });

  it('keeps customized built-in text fixed across locales', () => {
    const customized: ShortcutConfig = {
      id: BUILTIN_SUMMARIZE_ID,
      origin: 'builtin',
      scope: 'none',
      customized: true,
      name: '我的摘要',
      prompt: '固定提示词',
    };
    expect(resolveShortcut(customized, translator(en))).toMatchObject({
      name: '我的摘要',
      prompt: '固定提示词',
      scope: 'none',
    });
  });
});

describe('shortcut storage semantics', () => {
  it('persists defaults when the storage key is absent', async () => {
    const { data, set } = installStorage();
    const loaded = await loadShortcutConfigs();
    expect(loaded.shortcuts).toEqual(defaultShortcutConfigs());
    expect(data[SHORTCUTS_STORAGE_KEY]).toEqual(defaultShortcutConfigs());
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicitly stored empty array', async () => {
    const { set } = installStorage({ [SHORTCUTS_STORAGE_KEY]: [] });
    const loaded = await loadShortcutConfigs();
    expect(loaded).toEqual({ shortcuts: [], errors: [] });
    expect(set).not.toHaveBeenCalled();
  });

  it('reports malformed records without rewriting storage', async () => {
    const malformed = [{ id: 'bad', origin: 'custom', scope: 'unknown' }];
    const { set } = installStorage({ [SHORTCUTS_STORAGE_KEY]: malformed });
    const loaded = await loadShortcutConfigs();
    expect(loaded.shortcuts).toEqual([]);
    expect(loaded.errors).toHaveLength(1);
    expect(set).not.toHaveBeenCalled();
  });

  it('rejects a custom shortcut that uses a reserved built-in id', () => {
    const result = validateShortcutConfigs([
      {
        id: BUILTIN_SUMMARIZE_ID,
        origin: 'custom',
        scope: 'page',
        customized: true,
        name: 'Custom summary',
        prompt: 'Custom prompt',
      },
    ]);
    expect(result.shortcuts).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('rejects a custom shortcut whose customized flag is false', () => {
    const result = validateShortcutConfigs([
      {
        id: 'custom-not-customized',
        origin: 'custom',
        scope: 'none',
        customized: false,
        name: 'Custom name',
        prompt: 'Custom prompt',
      },
    ]);
    expect(result.shortcuts).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('filters a forged uncustomized explain shortcut before it can receive page tools', async () => {
    const forged = [
      {
        id: BUILTIN_EXPLAIN_ID,
        origin: 'builtin',
        scope: 'page',
        customized: false,
      },
    ];
    installStorage({ [SHORTCUTS_STORAGE_KEY]: forged });

    const loaded = await loadShortcutConfigs();
    const browserToolModes = loaded.shortcuts.map((config) =>
      buildShortcutExecution(resolveShortcut(config, translator(en)), translator(en)).browserTools,
    );

    expect(loaded.shortcuts).toEqual([]);
    expect(loaded.errors).toHaveLength(1);
    expect(browserToolModes).not.toContain('all');
  });

  it('rejects persisted text on an uncustomized built-in shortcut', () => {
    const result = validateShortcutConfigs([
      {
        id: BUILTIN_SUMMARIZE_ID,
        origin: 'builtin',
        scope: 'page',
        customized: false,
        name: 'Stored name',
        prompt: 'Stored prompt',
      },
    ]);
    expect(result.shortcuts).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('rejects a duplicate id after its first record is otherwise malformed', () => {
    const result = validateShortcutConfigs([
      {
        id: 'custom-duplicate',
        origin: 'custom',
        scope: 'invalid',
        customized: true,
        name: 'Broken',
        prompt: 'Broken prompt',
      },
      {
        id: 'custom-duplicate',
        origin: 'custom',
        scope: 'page',
        customized: true,
        name: 'Valid',
        prompt: 'Valid prompt',
      },
    ]);
    expect(result.shortcuts).toEqual([]);
    expect(result.errors).toHaveLength(2);
  });

  it('reloads the latest array before applying a mutation', async () => {
    installStorage({ [SHORTCUTS_STORAGE_KEY]: defaultShortcutConfigs() });
    await updateShortcutConfigs((items) => items.slice(1));
    expect((await loadShortcutConfigs()).shortcuts.map((item) => item.id)).toEqual([
      BUILTIN_EXPLAIN_ID,
    ]);
  });

  it('explicitly repairs malformed storage by preserving valid records and restoring CRUD', async () => {
    const valid: ShortcutConfig = {
      id: 'custom-valid',
      origin: 'custom',
      scope: 'none',
      customized: true,
      name: 'Valid shortcut',
      prompt: 'Valid prompt',
    };
    const invalid = {
      id: 'custom-invalid',
      origin: 'custom',
      scope: 'invalid',
      customized: true,
      name: 'Invalid shortcut',
      prompt: 'PRIVATE INVALID PROMPT',
    };
    const { data, set } = installStorage({
      [SHORTCUTS_STORAGE_KEY]: [valid, invalid],
    });

    const loaded = await loadShortcutConfigs();
    expect(loaded.shortcuts).toEqual([valid]);
    expect(loaded.errors).toHaveLength(1);
    expect(set).not.toHaveBeenCalled();

    const repaired = await repairShortcutConfigs();
    expect(repaired).toEqual([valid]);
    expect(data[SHORTCUTS_STORAGE_KEY]).toEqual([valid]);
    expect(JSON.stringify(data[SHORTCUTS_STORAGE_KEY])).not.toContain('PRIVATE INVALID PROMPT');
    expect(set).toHaveBeenCalledTimes(1);

    const updated = await updateShortcutConfigs((items) => [
      ...items,
      {
        id: 'custom-after-repair',
        origin: 'custom',
        scope: 'page',
        customized: true,
        name: 'After repair',
        prompt: 'Works again',
      },
    ]);
    expect(updated.map((item) => item.id)).toEqual([
      'custom-valid',
      'custom-after-repair',
    ]);
  });
});

describe('shortcut list operations', () => {
  it('restores only missing built-ins at the end without replacing same-name custom items', () => {
    const custom: ShortcutConfig = {
      id: 'custom-1',
      origin: 'custom',
      scope: 'page',
      customized: true,
      name: '总结本页',
      prompt: '自定义',
    };
    const restored = restoreDefaultShortcuts([custom, defaultShortcutConfigs()[1]]);
    expect(restored.map((item) => item.id)).toEqual([
      'custom-1',
      BUILTIN_EXPLAIN_ID,
      BUILTIN_SUMMARIZE_ID,
    ]);
  });

  it('moves one item without changing any record', () => {
    const items = [
      ...defaultShortcutConfigs(),
      { id: 'custom-1', origin: 'custom', scope: 'none', customized: true, name: 'C', prompt: 'P' },
    ] satisfies ShortcutConfig[];
    expect(moveShortcut(items, 'custom-1', 'up').map((item) => item.id)).toEqual([
      BUILTIN_SUMMARIZE_ID,
      'custom-1',
      BUILTIN_EXPLAIN_ID,
    ]);
  });

  it('splits the first three items from overflow without reordering', () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      id: `custom-${index}`,
      origin: 'custom' as const,
      scope: 'none' as const,
      customized: true,
      name: `N${index}`,
      prompt: `P${index}`,
    }));
    expect(splitShortcutList(items, 3)).toEqual({
      visible: items.slice(0, 3),
      overflow: items.slice(3),
    });
  });
});
