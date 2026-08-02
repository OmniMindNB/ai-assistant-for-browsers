import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../db';
import type { ShortcutConfig, ResolvedShortcut } from '../shortcuts';
import {
  filterShortcutCommands,
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
    ['available', true, true],
    ['available', false, false],
    ['loading', true, true],
    ['loading', false, false],
    ['restricted', true, false],
    ['restricted', false, false],
    ['error', true, false],
    ['error', false, false],
  ] as const)('status=%s, attachPageByDefault=%s -> %s', (status, attachPageByDefault, expected) => {
    expect(resolvePageAttached(status, attachPageByDefault)).toBe(expected);
  });
});
