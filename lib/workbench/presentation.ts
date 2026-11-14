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

/**
 * 历史抽屉每行的时间文案。分组标题（今天/昨天/更早）已经把日期说了，行内再把
 * toLocaleString 的完整串抄一遍（2026/2/14 20:23:45）既与标题重复，又在窄抽屉里占掉
 * 大半行宽。今天/昨天只给时刻；更早给短日期，年份与当前不同才补年。
 * 精确到秒的完整时间退到行悬停（title）里。
 */
export function formatConversationTimestamp(
  updatedAt: number,
  groupKey: ConversationGroupKey,
  now: Date,
  locale: string,
): string {
  const date = new Date(updatedAt);
  if (groupKey === 'today' || groupKey === 'yesterday') {
    return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(locale, {
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    month: 'short',
    day: 'numeric',
  });
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

export function resolvePageAttached(status: PageAttachStatus): boolean {
  return status !== 'restricted' && status !== 'error';
}
