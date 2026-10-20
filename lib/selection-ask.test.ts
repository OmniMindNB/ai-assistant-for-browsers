import { beforeEach, describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/locales/en';
import type { Translate, TranslationKey } from '@/lib/i18n';
import {
  SELECTION_ASK_ENABLED_KEY,
  buildReplyQuoteTemplate,
  buildSelectionAskTemplate,
  clampBubblePosition,
  clipSelectionContext,
  loadSelectionAskEnabled,
  saveSelectionAskEnabled,
  truncateSelectionText,
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

describe('buildSelectionAskTemplate with context', () => {
  it('adds the surrounding passage between the selection and the question', () => {
    expect(buildSelectionAskTemplate('E2B', t, 'runs in a Docker / E2B / Cube sandbox')).toBe(
      'Regarding the selected text:\n```\nE2B\n```\n\nThe passage it sits in on the current page (page text, only for understanding what the selection means here):\n```\nruns in a Docker / E2B / Cube sandbox\n```\n\nMy question: ',
    );
  });
});

describe('buildReplyQuoteTemplate', () => {
  it("frames the quote as part of the assistant's own earlier reply, not page text", () => {
    const result = buildReplyQuoteTemplate('  E2B sandbox  ', t);
    expect(result).toBe(
      'Following up on this part of your reply above:\n```\nE2B sandbox\n```\n\nMy question: ',
    );
    expect(result).not.toMatch(/page/i);
  });

  it('truncates long quotes with the same limit as page selections', () => {
    const result = buildReplyQuoteTemplate('y'.repeat(5000), t);
    expect(result).toContain('y'.repeat(4000));
    expect(result).not.toContain('y'.repeat(4001));
  });
});

describe('clipSelectionContext', () => {
  it('returns the whole passage when it fits, with whitespace collapsed', () => {
    expect(clipSelectionContext('Agent 的工具箱。  技能在\n\n  Docker / E2B / Cube 沙箱中运行，对话旁可打开终端。', 'E2B / Cube')).toBe(
      'Agent 的工具箱。 技能在\nDocker / E2B / Cube 沙箱中运行，对话旁可打开终端。',
    );
  });

  it('returns undefined when the passage is barely more than the selection', () => {
    expect(clipSelectionContext('E2B / Cube', 'E2B / Cube')).toBeUndefined();
    expect(clipSelectionContext('see E2B / Cube.', 'E2B / Cube')).toBeUndefined();
  });

  it('returns undefined when the selection is already long enough to carry its own context', () => {
    const selection = 'x'.repeat(60);
    expect(clipSelectionContext(`${'a'.repeat(200)}${selection}`, selection, 100)).toBeUndefined();
  });

  it('windows a long passage around the selection and marks both cut ends', () => {
    const block = `${'a'.repeat(500)}TARGET${'b'.repeat(500)}`;
    const clipped = clipSelectionContext(block, 'TARGET', 100)!;
    expect(clipped.startsWith('…')).toBe(true);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).toContain('TARGET');
    expect(clipped.length).toBe(102);
  });

  it('falls back to the head of the passage when the selection cannot be located in it', () => {
    const clipped = clipSelectionContext(`${'a'.repeat(300)}`, 'missing', 100)!;
    expect(clipped).toBe(`${'a'.repeat(100)}…`);
  });
});

describe('truncateSelectionText', () => {
  it('trims surrounding whitespace', () => {
    expect(truncateSelectionText('  hello world  ')).toBe('hello world');
  });

  it('truncates selections longer than the shared shortcut selection limit', () => {
    const long = 'x'.repeat(5000);
    const result = truncateSelectionText(long);
    expect(result).toBe('x'.repeat(4000));
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
