import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIND_TEXT_LIMIT,
  MAX_FIND_TEXT_LIMIT,
  matchesFindText,
  mergeFindTextHandles,
  normalizeFindText,
  parseFindTextParams,
} from './find-text';
import type { FormFieldTable } from './tab-form-fields';

describe('parseFindTextParams', () => {
  it('rejects missing or blank text', () => {
    expect(parseFindTextParams({}).ok).toBe(false);
    expect(parseFindTextParams({ text: '   ' }).ok).toBe(false);
  });

  it('defaults mode to contains and limit to the default', () => {
    const parsed = parseFindTextParams({ text: '总计' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.params).toEqual({ text: '总计', mode: 'contains', limit: DEFAULT_FIND_TEXT_LIMIT });
  });

  it('accepts mode: exact', () => {
    const parsed = parseFindTextParams({ text: '已发货', mode: 'exact' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.params.mode).toBe('exact');
  });

  it('treats an unknown mode string as contains', () => {
    const parsed = parseFindTextParams({ text: 'x', mode: 'regex' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.params.mode).toBe('contains');
  });

  it('clamps limit to [1, MAX_FIND_TEXT_LIMIT]', () => {
    expect((parseFindTextParams({ text: 'x', limit: 0 }) as any).params.limit).toBe(1);
    expect((parseFindTextParams({ text: 'x', limit: 999 }) as any).params.limit).toBe(MAX_FIND_TEXT_LIMIT);
    expect((parseFindTextParams({ text: 'x', limit: 'many' }) as any).params.limit).toBe(DEFAULT_FIND_TEXT_LIMIT);
  });

  it('trims surrounding whitespace from text', () => {
    const parsed = parseFindTextParams({ text: '  总计  ' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.params.text).toBe('总计');
  });
});

describe('normalizeFindText', () => {
  it('collapses runs of whitespace to a single space and trims', () => {
    expect(normalizeFindText('  总计  \n ¥1,280.00  ')).toBe('总计 ¥1,280.00');
  });
});

describe('matchesFindText', () => {
  it('contains mode is case-insensitive substring match', () => {
    expect(matchesFindText('总计 ¥1,280.00', '总计', 'contains')).toBe(true);
    expect(matchesFindText('Shipped', 'shipped', 'contains')).toBe(true);
    expect(matchesFindText('总计 ¥1,280.00', '优惠', 'contains')).toBe(false);
  });

  it('exact mode requires the whole normalized text to match', () => {
    expect(matchesFindText('已发货', '已发货', 'exact')).toBe(true);
    expect(matchesFindText('已发货了', '已发货', 'exact')).toBe(false);
  });

  it('never matches an empty candidate or empty query', () => {
    expect(matchesFindText('', '总计', 'contains')).toBe(false);
    expect(matchesFindText('总计', '', 'contains')).toBe(false);
  });
});

function table(overrides: Partial<FormFieldTable> = {}): FormFieldTable {
  return {
    url: 'https://a.test/orders',
    fields: {
      f1: {
        path: [{ kind: 'selector', selector: 'input', index: 0 }],
        expect: { tag: 'input', type: 'email', name: 'email' },
        sensitive: false,
        kind: 'text',
      },
      s1: {
        path: [{ kind: 'selector', selector: 'div', index: 2 }],
        expect: { tag: 'div' },
        sensitive: false,
        kind: 'scrollable',
      },
    },
    ...overrides,
  };
}

function hit(overrides: Partial<Parameters<typeof mergeFindTextHandles>[2][number]> = {}) {
  return {
    path: [{ kind: 'selector' as const, selector: 'span', index: 0 }],
    tag: 'span',
    frameId: 0,
    frameOrigin: 'https://a.test',
    ...overrides,
  };
}

describe('mergeFindTextHandles', () => {
  it('assigns sequential t* fieldIds starting at t1', () => {
    const merged = mergeFindTextHandles(undefined, 'https://a.test/orders', [hit(), hit(), hit()]);
    expect(Object.keys(merged.fields).sort()).toEqual(['t1', 't2', 't3']);
  });

  it('keeps existing f*/s* entries from browser_get_form when the page is unchanged', () => {
    const merged = mergeFindTextHandles(table(), 'https://a.test/orders', [hit()]);
    expect(merged.fields.f1).toBeDefined();
    expect(merged.fields.s1).toBeDefined();
    expect(merged.fields.t1).toBeDefined();
  });

  it('replaces (not accumulates) its own previous t* entries on a new call', () => {
    const withOldT = table({ fields: { ...table().fields, t1: hit(), t2: hit() } as any });
    const merged = mergeFindTextHandles(withOldT, 'https://a.test/orders', [hit()]);
    expect(Object.keys(merged.fields).filter((id) => id.startsWith('t'))).toEqual(['t1']);
    // f*/s* from the old table are still preserved.
    expect(merged.fields.f1).toBeDefined();
  });

  it('discards the whole existing table when the page has navigated', () => {
    const merged = mergeFindTextHandles(table({ url: 'https://a.test/old-page' }), 'https://a.test/orders', [hit()]);
    expect(merged.fields.f1).toBeUndefined();
    expect(merged.fields.s1).toBeUndefined();
    expect(Object.keys(merged.fields)).toEqual(['t1']);
  });

  it('carries type/name/href into expect so applyFormFill\'s matchesExpect will accept the real element', () => {
    const merged = mergeFindTextHandles(undefined, 'https://a.test/orders', [
      hit({ tag: 'a', href: '/detail/1' }),
    ]);
    expect(merged.fields.t1.expect).toEqual({ tag: 'a', type: undefined, name: undefined, href: '/detail/1' });
  });

  it('always stores frameOrigin, even for main-frame hits (frameId 0)', () => {
    const merged = mergeFindTextHandles(undefined, 'https://a.test/orders', [hit({ frameId: 0, frameOrigin: 'https://a.test' })]);
    expect(merged.fields.t1.frameOrigin).toBe('https://a.test');
  });

  it('uses a non-scrollable kind so browser_click accepts the handle', () => {
    const merged = mergeFindTextHandles(undefined, 'https://a.test/orders', [hit()]);
    expect(merged.fields.t1.kind).not.toBe('scrollable');
  });

  it('sets the table url to currentUrl', () => {
    const merged = mergeFindTextHandles(undefined, 'https://a.test/orders', [hit()]);
    expect(merged.url).toBe('https://a.test/orders');
  });
});
