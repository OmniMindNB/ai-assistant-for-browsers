import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from './i18n/locales/en';
import { zh } from './i18n/locales/zh';
import type { Translate, TranslationKey } from './i18n';
import {
  BUILTINS_REVISION,
  BUILTIN_FILL_FORM_ID,
  BUILTIN_FOCUS_READ_ID,
  BUILTIN_POLISH_ID,
  BUILTIN_SUMMARIZE_ID,
  BUILTIN_TRANSLATE_ID,
  RETIRED_EXPLAIN_ID,
  SHORTCUTS_REVISION_STORAGE_KEY,
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
        get: async (keys: string | string[]) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            wanted.filter((key) => key in data).map((key) => [key, data[key]]),
          );
        },
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
  it('creates the stable defaults in canonical order, page-scoped ones first', () => {
    expect(defaultShortcutConfigs().map((item) => item.id)).toEqual([
      BUILTIN_SUMMARIZE_ID,
      BUILTIN_FOCUS_READ_ID,
      BUILTIN_FILL_FORM_ID,
      BUILTIN_TRANSLATE_ID,
      BUILTIN_POLISH_ID,
    ]);
  });

  it('no longer offers the retired explain built-in', () => {
    expect(defaultShortcutConfigs().map((item) => item.id)).not.toContain(RETIRED_EXPLAIN_ID);
  });

  it('gives the write-capable built-ins page scope so they receive browser tools', () => {
    const scopes = new Map(defaultShortcutConfigs().map((item) => [item.id, item.scope]));
    expect(scopes.get(BUILTIN_FOCUS_READ_ID)).toBe('page');
    expect(scopes.get(BUILTIN_FILL_FORM_ID)).toBe('page');
    expect(scopes.get(BUILTIN_POLISH_ID)).toBe('selection');
  });

  it('resolves an unedited built-in through the current locale', () => {
    const summarize = defaultShortcutConfigs()[0];
    expect(resolveShortcut(summarize, translator(zh)).name).toBe('总结本页');
    expect(resolveShortcut(summarize, translator(en)).name).toBe('Summarize page');
  });

  it('resolves the translate built-in through the current locale', () => {
    const translateShortcut = defaultShortcutConfigs()[3];
    expect(resolveShortcut(translateShortcut, translator(zh)).name).toBe('翻译划词');
    expect(resolveShortcut(translateShortcut, translator(en)).name).toBe('Translate selection');
  });

  it('resolves the new built-ins through the current locale', () => {
    const byId = new Map(defaultShortcutConfigs().map((item) => [item.id, item]));
    const name = (id: string, dict: Record<TranslationKey, string>) =>
      resolveShortcut(byId.get(id)!, translator(dict)).name;
    expect(name(BUILTIN_FOCUS_READ_ID, zh)).toBe('专注阅读');
    expect(name(BUILTIN_FOCUS_READ_ID, en)).toBe('Focus mode');
    expect(name(BUILTIN_FILL_FORM_ID, zh)).toBe('帮我填表');
    expect(name(BUILTIN_FILL_FORM_ID, en)).toBe('Fill this form');
    expect(name(BUILTIN_POLISH_ID, zh)).toBe('润色改写');
    expect(name(BUILTIN_POLISH_ID, en)).toBe('Polish selection');
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
  it('persists defaults and the current revision when the storage key is absent', async () => {
    const { data, set } = installStorage();
    const loaded = await loadShortcutConfigs();
    expect(loaded.shortcuts).toEqual(defaultShortcutConfigs());
    expect(data[SHORTCUTS_STORAGE_KEY]).toEqual(defaultShortcutConfigs());
    expect(data[SHORTCUTS_REVISION_STORAGE_KEY]).toBe(BUILTINS_REVISION);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicitly stored empty array once it is already at the current revision', async () => {
    const { set } = installStorage({
      [SHORTCUTS_STORAGE_KEY]: [],
      [SHORTCUTS_REVISION_STORAGE_KEY]: BUILTINS_REVISION,
    });
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

  it('filters a forged uncustomized selection shortcut before it can receive page tools', async () => {
    const forged = [
      {
        id: BUILTIN_TRANSLATE_ID,
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
    installStorage({
      [SHORTCUTS_STORAGE_KEY]: defaultShortcutConfigs(),
      [SHORTCUTS_REVISION_STORAGE_KEY]: BUILTINS_REVISION,
    });
    await updateShortcutConfigs((items) => items.slice(1));
    expect((await loadShortcutConfigs()).shortcuts.map((item) => item.id)).toEqual([
      BUILTIN_FOCUS_READ_ID,
      BUILTIN_FILL_FORM_ID,
      BUILTIN_TRANSLATE_ID,
      BUILTIN_POLISH_ID,
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
      [SHORTCUTS_REVISION_STORAGE_KEY]: BUILTINS_REVISION,
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

describe('built-in retirement and revision migration', () => {
  const legacy = (overrides: Record<string, unknown> = {}) => ({
    id: RETIRED_EXPLAIN_ID,
    origin: 'builtin',
    scope: 'selection',
    customized: false,
    ...overrides,
  });

  it('drops an untouched retired built-in instead of reporting invalid config', async () => {
    installStorage({
      [SHORTCUTS_STORAGE_KEY]: [
        { id: BUILTIN_SUMMARIZE_ID, origin: 'builtin', scope: 'page', customized: false },
        legacy(),
      ],
    });

    const loaded = await loadShortcutConfigs();

    expect(loaded.errors).toEqual([]);
    expect(loaded.shortcuts.map((item) => item.id)).not.toContain(RETIRED_EXPLAIN_ID);
  });

  it('keeps a customized retired built-in as a custom shortcut in place', async () => {
    installStorage({
      [SHORTCUTS_STORAGE_KEY]: [
        { id: BUILTIN_SUMMARIZE_ID, origin: 'builtin', scope: 'page', customized: false },
        legacy({ customized: true, name: '我的解释', prompt: '我自己的提示词' }),
        { id: BUILTIN_TRANSLATE_ID, origin: 'builtin', scope: 'selection', customized: false },
      ],
    });

    const loaded = await loadShortcutConfigs();

    expect(loaded.errors).toEqual([]);
    expect(loaded.shortcuts[1]).toEqual({
      id: RETIRED_EXPLAIN_ID,
      origin: 'custom',
      scope: 'selection',
      customized: true,
      name: '我的解释',
      prompt: '我自己的提示词',
    });
  });

  it('appends the newly introduced built-ins after the user list and records the revision', async () => {
    const { data } = installStorage({
      [SHORTCUTS_STORAGE_KEY]: [
        { id: BUILTIN_TRANSLATE_ID, origin: 'builtin', scope: 'selection', customized: false },
        { id: BUILTIN_SUMMARIZE_ID, origin: 'builtin', scope: 'page', customized: false },
      ],
    });

    const loaded = await loadShortcutConfigs();

    expect(loaded.shortcuts.map((item) => item.id)).toEqual([
      BUILTIN_TRANSLATE_ID,
      BUILTIN_SUMMARIZE_ID,
      BUILTIN_FOCUS_READ_ID,
      BUILTIN_FILL_FORM_ID,
      BUILTIN_POLISH_ID,
    ]);
    expect(data[SHORTCUTS_REVISION_STORAGE_KEY]).toBe(BUILTINS_REVISION);
  });

  it('adds only the newly introduced built-ins to a list the user had emptied', async () => {
    installStorage({ [SHORTCUTS_STORAGE_KEY]: [] });

    const loaded = await loadShortcutConfigs();

    expect(loaded.shortcuts.map((item) => item.id)).toEqual([
      BUILTIN_FOCUS_READ_ID,
      BUILTIN_FILL_FORM_ID,
      BUILTIN_POLISH_ID,
    ]);
  });

  it('does not resurrect a new built-in the user deleted after the migration ran', async () => {
    installStorage({ [SHORTCUTS_STORAGE_KEY]: [] });
    await loadShortcutConfigs();

    await updateShortcutConfigs((items) =>
      items.filter((item) => item.id !== BUILTIN_FILL_FORM_ID),
    );

    expect((await loadShortcutConfigs()).shortcuts.map((item) => item.id)).toEqual([
      BUILTIN_FOCUS_READ_ID,
      BUILTIN_POLISH_ID,
    ]);
  });

  it('leaves malformed storage untouched instead of migrating on top of it', async () => {
    const { set } = installStorage({
      [SHORTCUTS_STORAGE_KEY]: [{ id: 'bad', origin: 'custom', scope: 'unknown' }],
    });

    const loaded = await loadShortcutConfigs();

    expect(loaded.errors).toHaveLength(1);
    expect(loaded.shortcuts).toEqual([]);
    expect(set).not.toHaveBeenCalled();
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
      BUILTIN_FOCUS_READ_ID,
      BUILTIN_SUMMARIZE_ID,
      BUILTIN_FILL_FORM_ID,
      BUILTIN_TRANSLATE_ID,
      BUILTIN_POLISH_ID,
    ]);
  });

  it('moves one item without changing any record', () => {
    const items = [
      ...defaultShortcutConfigs(),
      { id: 'custom-1', origin: 'custom', scope: 'none', customized: true, name: 'C', prompt: 'P' },
    ] satisfies ShortcutConfig[];
    expect(moveShortcut(items, 'custom-1', 'up').map((item) => item.id)).toEqual([
      BUILTIN_SUMMARIZE_ID,
      BUILTIN_FOCUS_READ_ID,
      BUILTIN_FILL_FORM_ID,
      BUILTIN_TRANSLATE_ID,
      'custom-1',
      BUILTIN_POLISH_ID,
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
