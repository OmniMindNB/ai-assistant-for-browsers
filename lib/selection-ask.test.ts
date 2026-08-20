import { beforeEach, describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/locales/en';
import type { Translate, TranslationKey } from '@/lib/i18n';
import {
  SELECTION_ASK_ENABLED_KEY,
  buildSelectionAskTemplate,
  clampBubblePosition,
  loadSelectionAskEnabled,
  saveSelectionAskEnabled,
} from './selection-ask';

const t = ((key: TranslationKey, vars?: Record<string, string | number>) =>
  en[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    vars && name in vars ? String(vars[name]) : match,
  )) as Translate;

describe('buildSelectionAskTemplate', () => {
  it('interpolates the trimmed selection into the template', () => {
    expect(buildSelectionAskTemplate('  hello world  ', t)).toBe(
      'Regarding the selected text:\n```\nhello world\n```\n\nMy question: ',
    );
  });

  it('truncates selections longer than the shared shortcut selection limit', () => {
    const long = 'x'.repeat(5000);
    const result = buildSelectionAskTemplate(long, t);
    expect(result).toContain('x'.repeat(4000));
    expect(result).not.toContain('x'.repeat(4001));
  });
});

describe('clampBubblePosition', () => {
  const viewport = { width: 800, height: 600 };
  const bubbleSize = { width: 88, height: 32 };

  it('places the bubble above the selection when there is room', () => {
    const rect = { top: 200, left: 100, right: 200, bottom: 220 };
    const pos = clampBubblePosition(rect, viewport, bubbleSize);
    expect(pos.top).toBe(200 - 32 - 8);
  });

  it('falls back to below the selection when there is no room above', () => {
    const rect = { top: 10, left: 100, right: 200, bottom: 30 };
    const pos = clampBubblePosition(rect, viewport, bubbleSize);
    expect(pos.top).toBe(30 + 8);
  });

  it('clamps the left edge so the bubble never runs off the left of the viewport', () => {
    const rect = { top: 200, left: -50, right: 10, bottom: 220 };
    const pos = clampBubblePosition(rect, viewport, bubbleSize);
    expect(pos.left).toBeGreaterThanOrEqual(4);
  });

  it('clamps the right edge so the bubble never runs off the right of the viewport', () => {
    const rect = { top: 200, left: 780, right: 830, bottom: 220 };
    const pos = clampBubblePosition(rect, viewport, bubbleSize);
    expect(pos.left).toBeLessThanOrEqual(viewport.width - bubbleSize.width - 4);
  });
});

describe('selection-ask enabled toggle', () => {
  beforeEach(() => {
    (globalThis as any).browser.storage.local = {
      get: async () => ({}),
      set: async () => undefined,
    };
  });

  it('defaults to enabled when nothing has been saved', async () => {
    expect(await loadSelectionAskEnabled()).toBe(true);
  });

  it('reads back a saved value', async () => {
    (globalThis as any).browser.storage.local.get = async () => ({ [SELECTION_ASK_ENABLED_KEY]: false });
    expect(await loadSelectionAskEnabled()).toBe(false);
  });

  it('persists the value under the expected storage key', async () => {
    let saved: Record<string, unknown> = {};
    (globalThis as any).browser.storage.local.set = async (next: Record<string, unknown>) => {
      saved = next;
    };
    await saveSelectionAskEnabled(false);
    expect(saved).toEqual({ [SELECTION_ASK_ENABLED_KEY]: false });
  });
});
