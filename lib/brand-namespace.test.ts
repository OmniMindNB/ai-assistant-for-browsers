import { describe, expect, it } from 'vitest';
import { db } from './db';
import { LOCALE_KEY } from './i18n';
import { STORAGE_KEY } from './settings';
import { SHORTCUTS_STORAGE_KEY } from './shortcuts';
import { THEME_KEY } from './theme';

describe('Runi persistence namespace', () => {
  it('uses only the fresh Runi chrome.storage keys', () => {
    expect(STORAGE_KEY).toBe('runi:settings');
    expect(SHORTCUTS_STORAGE_KEY).toBe('runi:shortcuts');
    expect(THEME_KEY).toBe('runi:theme');
    expect(LOCALE_KEY).toBe('runi:locale');
    for (const key of [STORAGE_KEY, SHORTCUTS_STORAGE_KEY, THEME_KEY, LOCALE_KEY]) {
      expect(key).not.toContain('aluminum');
    }
  });
});

it('opens a new Runi IndexedDB database', () => {
  expect(db.name).toBe('runi');
});
