import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../db';
import type { ShortcutConfig, ResolvedShortcut } from '../shortcuts';
import {
  filterShortcutCommands,
  formatConversationTimestamp,
  groupConversationsByDay,
  normalizeShortcutCommand,
  resolvePageAttached,
  type ResolvedShortcutCommand,
} from './presentation';

const records: ConversationRecord[] = [
  { id: 'today', title: 'Today', createdAt: 0, updatedAt: new Date('2031-03-14T09:00:00+08:00').getTime() },
  { id: 'yesterday', title: 'Yesterday', createdAt: 0, updatedAt: new Date('2031-03-13T23:59:00+08:00').getTime() },
  { id: 'earlier', title: 'Earlier', createdAt: 0, updatedAt: new Date('2031-03-12T23:59:00+08:00').getTime() },
];

function shortcut(id: string, name: string): ResolvedShortcutCommand {
  const config: ShortcutConfig = {
    id,
    origin: 'custom',
    scope: 'none',
    customized: true,
    name,
    prompt: 'Prompt',
  };
  const resolved: ResolvedShortcut = { ...config, name, prompt: 'Prompt' };
  return { config, resolved };
}

const shortcuts = [
  shortcut('summarize', '总结页面'),
  shortcut('reading-mode', '阅读模式'),
  shortcut('translate', '翻译页面'),
];

describe('groupConversationsByDay', () => {
  it('groups conversations into today, yesterday, and earlier', () => {
    const groups = groupConversationsByDay(records, new Date('2031-03-14T12:00:00+08:00'));

    expect(groups.map((group) => group.key)).toEqual(['today', 'yesterday', 'earlier']);
    expect(groups.map((group) => group.records.map((record) => record.id))).toEqual([
      ['today'],
      ['yesterday'],
      ['earlier'],
    ]);
  });
});

describe('filterShortcutCommands', () => {
  it('matches slash commands by localized name without changing order', () => {
    expect(filterShortcutCommands(shortcuts, '/阅').map((item) => item.config.id))
      .toEqual(['reading-mode']);
  });

  it('removes one leading slash, whitespace, and casing from the query', () => {
    const commands = [shortcut('reading', 'Reading Mode'), shortcut('summarize', 'Summary')];

    expect(filterShortcutCommands(commands, ' / reading ')).toEqual([commands[0]]);
  });

  it('keeps a second leading slash as part of the query', () => {
    const commands = [shortcut('reading', 'Reading Mode')];

    expect(filterShortcutCommands(commands, '//reading')).toEqual([]);
  });

  it('matches the displayed whitespace-free slash command exactly', () => {
    const commands = [shortcut('summarize', 'Summarize page')];
    expect(normalizeShortcutCommand('Summarize page')).toBe('/Summarizepage');
    expect(filterShortcutCommands(commands, '/Summarizepage')).toEqual(commands);
  });
});

describe('resolvePageAttached', () => {
  it.each([
    ['available', true],
    ['loading', true],
    ['restricted', false],
    ['error', false],
  ] as const)('status=%s -> %s', (status, expected) => {
    expect(resolvePageAttached(status)).toBe(expected);
  });
});

// 行内时间与分组标题的分工：日期由标题承担，行内只给时刻；更早的给短日期
// （ref: UI 走查 P2-6）。日期用本地时区构造，断言不随运行环境时区漂移。
describe('formatConversationTimestamp', () => {
  const now = new Date(2026, 6, 30, 12, 0, 0);

  it('今天/昨天只给时刻，日期由分组标题承担', () => {
    const today = new Date(2026, 6, 30, 9, 5).getTime();
    const yesterday = new Date(2026, 6, 29, 23, 59).getTime();

    expect(formatConversationTimestamp(today, 'today', now, 'zh')).toBe('9:05');
    expect(formatConversationTimestamp(yesterday, 'yesterday', now, 'zh')).toBe('23:59');
    expect(formatConversationTimestamp(today, 'today', now, 'en')).toBe('9:05 AM');
  });

  it('更早的条目给短日期，同一年不重复年份', () => {
    const sameYear = new Date(2026, 0, 15, 9, 5).getTime();

    expect(formatConversationTimestamp(sameYear, 'earlier', now, 'zh')).toBe('1月15日');
    expect(formatConversationTimestamp(sameYear, 'earlier', now, 'en')).toBe('Jan 15');
  });

  it('往年的条目补上年份', () => {
    const lastYear = new Date(2025, 11, 31, 9, 5).getTime();

    expect(formatConversationTimestamp(lastYear, 'earlier', now, 'zh')).toBe('2025年12月31日');
    expect(formatConversationTimestamp(lastYear, 'earlier', now, 'en')).toBe('Dec 31, 2025');
  });
});
