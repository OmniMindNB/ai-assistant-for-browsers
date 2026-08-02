import type { ConversationRecord } from '../db';
import type { ResolvedShortcut, ShortcutConfig } from '../shortcuts';

export type ConversationGroupKey = 'today' | 'yesterday' | 'earlier';

export interface ConversationGroup {
  key: ConversationGroupKey;
  records: ConversationRecord[];
}

export type ResolvedShortcutCommand = {
  config: ShortcutConfig;
  resolved: ResolvedShortcut;
};

/** The command label is intentionally compact, while name search remains human-readable. */
export function normalizeShortcutCommand(name: string): string {
  return `/${name.replace(/\s+/g, '')}`;
}

export function groupConversationsByDay(
  records: readonly ConversationRecord[],
  now: Date,
): ConversationGroup[] {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const grouped: Record<ConversationGroupKey, ConversationRecord[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };

  for (const record of records) {
    if (record.updatedAt >= todayStart) grouped.today.push(record);
    else if (record.updatedAt >= yesterdayStart) grouped.yesterday.push(record);
    else grouped.earlier.push(record);
  }

  return (['today', 'yesterday', 'earlier'] as const)
    .filter((key) => grouped[key].length > 0)
    .map((key) => ({ key, records: grouped[key] }));
}

export function isUsableShortcutCommand(command: ResolvedShortcutCommand): boolean {
  return Boolean(command.config.id && command.resolved.id && command.resolved.name.trim() && command.resolved.prompt.trim());
}

export function filterShortcutCommands(
  shortcuts: readonly ResolvedShortcutCommand[],
  query: string,
): ResolvedShortcutCommand[] {
  const trimmedQuery = query.trim();
  const normalizedQuery = (trimmedQuery.startsWith('/') ? trimmedQuery.slice(1) : trimmedQuery)
    .trim()
    .toLowerCase();
  return shortcuts.filter((shortcut) =>
    normalizeShortcutCommand(shortcut.resolved.name).slice(1).toLowerCase() === normalizedQuery ||
    shortcut.resolved.name.toLowerCase().includes(normalizedQuery),
  );
}

export type PageAttachStatus = 'loading' | 'available' | 'restricted' | 'error';

export function resolvePageAttached(status: PageAttachStatus, attachPageByDefault: boolean): boolean {
  if (status === 'restricted' || status === 'error') return false;
  return attachPageByDefault;
}
