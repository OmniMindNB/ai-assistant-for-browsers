import type { Translate } from './i18n';

export type ShortcutScope = 'page' | 'selection' | 'none';
export type ShortcutOrigin = 'builtin' | 'custom';
export type MoveDirection = 'up' | 'down';

export interface ShortcutConfig {
  id: string;
  origin: ShortcutOrigin;
  scope: ShortcutScope;
  customized: boolean;
  name?: string;
  prompt?: string;
}

export interface ResolvedShortcut {
  id: string;
  origin: ShortcutOrigin;
  scope: ShortcutScope;
  customized: boolean;
  name: string;
  prompt: string;
}

export interface ShortcutLoadResult {
  shortcuts: ShortcutConfig[];
  errors: string[];
}

export const SHORTCUTS_STORAGE_KEY = 'aluminum:shortcuts';
export const BUILTIN_SUMMARIZE_ID = 'builtin:summarize-page';
export const BUILTIN_EXPLAIN_ID = 'builtin:explain-selection';

const BUILTINS = [
  {
    id: BUILTIN_SUMMARIZE_ID,
    scope: 'page',
    nameKey: 'shortcut.builtinSummarizeName',
    promptKey: 'shortcut.builtinSummarizePrompt',
  },
  {
    id: BUILTIN_EXPLAIN_ID,
    scope: 'selection',
    nameKey: 'shortcut.builtinExplainName',
    promptKey: 'shortcut.builtinExplainPrompt',
  },
] as const;

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTINS.map((item) => item.id));

export function defaultShortcutConfigs(): ShortcutConfig[] {
  return BUILTINS.map((item) => ({
    id: item.id,
    origin: 'builtin',
    scope: item.scope,
    customized: false,
  }));
}

export function resolveShortcut(config: ShortcutConfig, translate: Translate): ResolvedShortcut {
  if (config.customized || config.origin === 'custom') {
    return { ...config, name: config.name!.trim(), prompt: config.prompt!.trim() };
  }
  const builtin = BUILTINS.find((item) => item.id === config.id);
  if (!builtin) throw new Error(`Unknown built-in shortcut: ${config.id}`);
  return {
    ...config,
    name: translate(builtin.nameKey),
    prompt: translate(builtin.promptKey),
  };
}

export function validateShortcutConfigs(value: unknown): ShortcutLoadResult {
  if (!Array.isArray(value)) {
    return { shortcuts: [], errors: ['Shortcut configuration must be an array.'] };
  }

  const shortcuts: ShortcutConfig[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();

  value.forEach((valueItem, index) => {
    const label = `Shortcut at index ${index}`;
    if (!valueItem || typeof valueItem !== 'object' || Array.isArray(valueItem)) {
      errors.push(`${label} must be an object.`);
      return;
    }

    const item = valueItem as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) {
      errors.push(`${label} must have a non-empty string id.`);
      return;
    }
    if (ids.has(id)) {
      errors.push(`${label} has a duplicate id: ${id}.`);
      return;
    }
    if (item.origin !== 'builtin' && item.origin !== 'custom') {
      errors.push(`${label} has an invalid origin.`);
      return;
    }
    if (item.scope !== 'page' && item.scope !== 'selection' && item.scope !== 'none') {
      errors.push(`${label} has an invalid scope.`);
      return;
    }
    if (typeof item.customized !== 'boolean') {
      errors.push(`${label} must have a boolean customized value.`);
      return;
    }
    if (item.origin === 'builtin' && !BUILTIN_IDS.has(id)) {
      errors.push(`${label} has an unknown built-in id: ${id}.`);
      return;
    }
    if (item.origin === 'custom' && BUILTIN_IDS.has(id)) {
      errors.push(`${label} cannot use a reserved built-in id: ${id}.`);
      return;
    }

    const requiresText = item.origin === 'custom' || item.customized;
    const name = typeof item.name === 'string' ? item.name.trim() : undefined;
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : undefined;
    if (requiresText && (!name || !prompt)) {
      errors.push(`${label} must have non-empty name and prompt text.`);
      return;
    }
    if ((!requiresText && item.name !== undefined && typeof item.name !== 'string') ||
      (!requiresText && item.prompt !== undefined && typeof item.prompt !== 'string')) {
      errors.push(`${label} has invalid optional name or prompt text.`);
      return;
    }

    ids.add(id);
    shortcuts.push({
      id,
      origin: item.origin,
      scope: item.scope,
      customized: item.customized,
      ...(name !== undefined ? { name } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    });
  });

  return { shortcuts, errors };
}

export async function loadShortcutConfigs(): Promise<ShortcutLoadResult> {
  const result = await browser.storage.local.get(SHORTCUTS_STORAGE_KEY);
  if (!(SHORTCUTS_STORAGE_KEY in result)) {
    const shortcuts = defaultShortcutConfigs();
    await saveShortcutConfigs(shortcuts);
    return { shortcuts, errors: [] };
  }
  return validateShortcutConfigs(result[SHORTCUTS_STORAGE_KEY]);
}

export async function saveShortcutConfigs(shortcuts: ShortcutConfig[]): Promise<void> {
  const parsed = validateShortcutConfigs(shortcuts);
  if (parsed.errors.length > 0 || parsed.shortcuts.length !== shortcuts.length) {
    throw new Error(parsed.errors.join('\n'));
  }
  await browser.storage.local.set({ [SHORTCUTS_STORAGE_KEY]: parsed.shortcuts });
}

export async function updateShortcutConfigs(
  mutate: (current: ShortcutConfig[]) => ShortcutConfig[],
): Promise<ShortcutConfig[]> {
  const current = await loadShortcutConfigs();
  if (current.errors.length > 0) throw new Error(current.errors.join('\n'));
  const next = mutate(current.shortcuts.map((item) => ({ ...item })));
  await saveShortcutConfigs(next);
  return next;
}

export function restoreDefaultShortcuts(shortcuts: readonly ShortcutConfig[]): ShortcutConfig[] {
  const existingIds = new Set(shortcuts.map((item) => item.id));
  return [
    ...shortcuts.map((item) => ({ ...item })),
    ...defaultShortcutConfigs().filter((item) => !existingIds.has(item.id)),
  ];
}

export function moveShortcut(
  shortcuts: readonly ShortcutConfig[],
  id: string,
  direction: MoveDirection,
): ShortcutConfig[] {
  const currentIndex = shortcuts.findIndex((item) => item.id === id);
  const targetIndex = currentIndex + (direction === 'up' ? -1 : 1);
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= shortcuts.length) return [...shortcuts];

  const next = [...shortcuts];
  [next[currentIndex], next[targetIndex]] = [next[targetIndex], next[currentIndex]];
  return next;
}

export function splitShortcutList<T>(
  items: readonly T[],
  visibleCount: number,
): { visible: T[]; overflow: T[] } {
  return {
    visible: items.slice(0, visibleCount),
    overflow: items.slice(visibleCount),
  };
}

export function newShortcutId(): string {
  return `shortcut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
