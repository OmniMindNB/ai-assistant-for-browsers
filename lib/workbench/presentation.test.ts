import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../db';
import type { ShortcutConfig, ResolvedShortcut } from '../shortcuts';
import {
  filterShortcutCommands,
  groupConversationsByDay,
  summarizeToolActivities,
  type ResolvedShortcutCommand,
} from './presentation';

const records: ConversationRecord[] = [
  { id: 'today', title: 'Today', createdAt: 0, updatedAt: new Date('2026-07-30T09:00:00+08:00').getTime() },
  { id: 'yesterday', title: 'Yesterday', createdAt: 0, updatedAt: new Date('2026-07-29T23:59:00+08:00').getTime() },
  { id: 'earlier', title: 'Earlier', createdAt: 0, updatedAt: new Date('2026-07-28T23:59:00+08:00').getTime() },
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
    const groups = groupConversationsByDay(records, new Date('2026-07-30T12:00:00+08:00'));

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
});

describe('summarizeToolActivities', () => {
  it('summarizes the active tool and completed count', () => {
    expect(summarizeToolActivities([
      { id: '1', name: 'browser_read_page', status: 'done' },
      { id: '2', name: 'browser_set_style', status: 'running' },
    ])).toMatchObject({ completed: 1, total: 2, status: 'running', activeId: '2' });
  });

  it('uses status precedence while preserving activity order', () => {
    const activities = [
      { id: '1', name: 'first', status: 'done' as const },
      { id: '2', name: 'second', status: 'error' as const },
      { id: '3', name: 'third', status: 'confirming' as const },
    ];

    const summary = summarizeToolActivities(activities);

    expect(summary.status).toBe('confirming');
    expect(summary.activeId).toBe('3');
    expect(summary.activities).toEqual(activities);
  });
});
