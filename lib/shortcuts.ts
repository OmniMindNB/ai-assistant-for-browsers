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

export const SHORTCUTS_STORAGE_KEY = 'runi:shortcuts';
export const SHORTCUTS_REVISION_STORAGE_KEY = 'runi:shortcuts:builtins-revision';

export const BUILTIN_SUMMARIZE_ID = 'builtin:summarize-page';
export const BUILTIN_FOCUS_READ_ID = 'builtin:focus-read';
export const BUILTIN_FILL_FORM_ID = 'builtin:fill-form';
export const BUILTIN_TRANSLATE_ID = 'builtin:translate-selection';
export const BUILTIN_POLISH_ID = 'builtin:polish-selection';

/**
 * 已退役的内置：代码里不再提供，但老用户的 storage.local 里还存着。
 * 如果放任不管，validateShortcutConfigs 会把它判成「未知内置 id」，
 * 设置页就会给每个老用户弹一条「配置无效」横幅——所以校验之前先由
 * migrateRetiredBuiltins 摘掉。
 */
export const RETIRED_EXPLAIN_ID = 'builtin:explain-selection';
const RETIRED_BUILTIN_IDS: ReadonlySet<string> = new Set([RETIRED_EXPLAIN_ID]);

/**
 * 内置集合的版本号：每新增一批内置就 +1，并给新条目标上对应的 since。
 * 迁移只补 since 大于「已存版本号」的内置，所以用户主动删掉的内置不会在
 * 下次加载时被复活——这正是不能用「缺啥补啥」的原因。
 */
export const BUILTINS_REVISION = 2;

// 顺序即侧边栏展示顺序：侧边栏会把每一条可用快捷指令都渲染成芯片（工具条自动折行），
// 所以排在后面的不会被藏掉。
const BUILTINS = [
  {
    id: BUILTIN_SUMMARIZE_ID,
    scope: 'page',
    since: 1,
    nameKey: 'shortcut.builtinSummarizeName',
    promptKey: 'shortcut.builtinSummarizePrompt',
  },
  {
    id: BUILTIN_FOCUS_READ_ID,
    scope: 'page',
    since: 2,
    nameKey: 'shortcut.builtinFocusReadName',
    promptKey: 'shortcut.builtinFocusReadPrompt',
  },
  {
    id: BUILTIN_FILL_FORM_ID,
    scope: 'page',
    since: 2,
    nameKey: 'shortcut.builtinFillFormName',
    promptKey: 'shortcut.builtinFillFormPrompt',
  },
  {
    id: BUILTIN_TRANSLATE_ID,
    scope: 'selection',
    since: 1,
    nameKey: 'shortcut.builtinTranslateName',
    promptKey: 'shortcut.builtinTranslatePrompt',
  },
  {
    id: BUILTIN_POLISH_ID,
    scope: 'selection',
    since: 2,
    nameKey: 'shortcut.builtinPolishName',
    promptKey: 'shortcut.builtinPolishPrompt',
  },
] as const;

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTINS.map((item) => item.id));

type BuiltinDefinition = (typeof BUILTINS)[number];

function builtinConfig(item: BuiltinDefinition): ShortcutConfig {
  return { id: item.id, origin: 'builtin', scope: item.scope, customized: false };
}

export function defaultShortcutConfigs(): ShortcutConfig[] {
  return BUILTINS.map(builtinConfig);
}

/**
 * 校验之前跑在原始存储值上：已退役的内置，用户改过文案的转成自定义快捷方式
 * （保住他们写的名称和提示词，位置也不动），没动过的直接丢弃。
 */
export function migrateRetiredBuiltins(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  const migrated: unknown[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      migrated.push(entry);
      continue;
    }
    const item = entry as Record<string, unknown>;
    if (
      item.origin !== 'builtin' ||
      typeof item.id !== 'string' ||
      !RETIRED_BUILTIN_IDS.has(item.id)
    ) {
      migrated.push(entry);
      continue;
    }
    if (item.customized === true) migrated.push({ ...item, origin: 'custom' });
  }
  return migrated;
}

/** 把 since 大于已存版本号、且当前列表里没有的内置追加到末尾，保留用户自己的排序。 */
export function appendNewBuiltins(
  shortcuts: readonly ShortcutConfig[],
  storedRevision: number,
): ShortcutConfig[] {
  const existingIds = new Set(shortcuts.map((item) => item.id));
  return [
    ...shortcuts.map((item) => ({ ...item })),
    ...BUILTINS.filter((item) => item.since > storedRevision && !existingIds.has(item.id)).map(
      builtinConfig,
    ),
  ];
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
    ids.add(id);
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
    if (item.origin === 'custom' && !item.customized) {
      errors.push(`${label} must mark a custom shortcut as customized.`);
      return;
    }
    if (item.origin === 'builtin' && !item.customized) {
      const builtin = BUILTINS.find((candidate) => candidate.id === id)!;
      if (item.scope !== builtin.scope) {
        errors.push(`${label} must use the default scope for an uncustomized built-in.`);
        return;
      }
      if (item.name !== undefined || item.prompt !== undefined) {
        errors.push(`${label} cannot persist text for an uncustomized built-in.`);
        return;
      }
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
  const result = await browser.storage.local.get([
    SHORTCUTS_STORAGE_KEY,
    SHORTCUTS_REVISION_STORAGE_KEY,
  ]);
  if (!(SHORTCUTS_STORAGE_KEY in result)) {
    const shortcuts = defaultShortcutConfigs();
    await writeShortcuts(shortcuts, BUILTINS_REVISION);
    return { shortcuts, errors: [] };
  }

  const parsed = validateShortcutConfigs(migrateRetiredBuiltins(result[SHORTCUTS_STORAGE_KEY]));
  // 存储里有坏数据时一律不迁移也不回写：设置页会让用户自己决定「删除无效项」，
  // 这里替他做了等于悄悄丢掉他的配置。
  if (parsed.errors.length > 0) return parsed;

  const storedRevision = typeof result[SHORTCUTS_REVISION_STORAGE_KEY] === 'number'
    ? (result[SHORTCUTS_REVISION_STORAGE_KEY] as number)
    : 1;
  // >= 而不是 ===：版本号比代码新（用户装回了旧版本）时什么都不做，
  // 免得把它往回写、导致下次升级时重复补内置。
  if (storedRevision >= BUILTINS_REVISION) return parsed;

  const shortcuts = appendNewBuiltins(parsed.shortcuts, storedRevision);
  await writeShortcuts(shortcuts, BUILTINS_REVISION);
  return { shortcuts, errors: [] };
}

export async function saveShortcutConfigs(shortcuts: ShortcutConfig[]): Promise<void> {
  await writeShortcuts(shortcuts);
}

/** 传了 revision 就和列表一起写（同一次 set，避免两者短暂不一致）。 */
async function writeShortcuts(shortcuts: ShortcutConfig[], revision?: number): Promise<void> {
  const parsed = validateShortcutConfigs(shortcuts);
  if (parsed.errors.length > 0 || parsed.shortcuts.length !== shortcuts.length) {
    throw new Error(parsed.errors.join('\n'));
  }
  await browser.storage.local.set({
    [SHORTCUTS_STORAGE_KEY]: parsed.shortcuts,
    ...(revision === undefined ? {} : { [SHORTCUTS_REVISION_STORAGE_KEY]: revision }),
  });
}

export async function repairShortcutConfigs(): Promise<ShortcutConfig[]> {
  const current = await loadShortcutConfigs();
  if (current.errors.length === 0) return current.shortcuts;
  await saveShortcutConfigs(current.shortcuts);
  return current.shortcuts;
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
