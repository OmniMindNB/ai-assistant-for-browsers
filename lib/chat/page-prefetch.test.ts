import { describe, expect, it } from 'vitest';
import { MAX_TOOL_RESULT_CHARS } from '@/lib/agent/context-budget';
import {
  MAX_PAGE_PREFETCH_CHARS,
  MIN_PAGE_PREFETCH_CHARS,
  PAGE_PREFETCH_HEAD_CHARS,
  PAGE_PREFETCH_TAIL_CHARS,
  planPagePrefetch,
  renderPageOutline,
} from './page-prefetch';

function page(text: string, outline?: Array<{ level: 1 | 2 | 3; title: string }>) {
  return { title: 'T', url: 'https://example.com/a', text, outline };
}

describe('planPagePrefetch', () => {
  it('shares its ceiling with the tool-result limit instead of inventing one', () => {
    expect(MAX_PAGE_PREFETCH_CHARS).toBe(MAX_TOOL_RESULT_CHARS);
    expect(PAGE_PREFETCH_HEAD_CHARS + PAGE_PREFETCH_TAIL_CHARS).toBe(MAX_PAGE_PREFETCH_CHARS);
  });

  it('skips a body too short to support any page-scope task', () => {
    expect(planPagePrefetch(page(''))).toEqual({ kind: 'skip' });
    expect(planPagePrefetch(page('x'.repeat(MIN_PAGE_PREFETCH_CHARS - 1)))).toEqual({ kind: 'skip' });
  });

  it('passes a body at the minimum through as full text', () => {
    const plan = planPagePrefetch(page('x'.repeat(MIN_PAGE_PREFETCH_CHARS)));
    expect(plan).toMatchObject({ kind: 'full', title: 'T', url: 'https://example.com/a' });
  });

  it('passes a body exactly at the ceiling through as full text', () => {
    expect(planPagePrefetch(page('x'.repeat(MAX_PAGE_PREFETCH_CHARS))).kind).toBe('full');
  });

  it('windows a body past the ceiling into head and tail', () => {
    const total = MAX_PAGE_PREFETCH_CHARS + 5000;
    const text =
      'h'.repeat(PAGE_PREFETCH_HEAD_CHARS) + 'm'.repeat(5000) + 't'.repeat(PAGE_PREFETCH_TAIL_CHARS);
    expect(text).toHaveLength(total);
    const plan = planPagePrefetch(page(text));
    expect(plan).toMatchObject({
      kind: 'windowed',
      headEnd: PAGE_PREFETCH_HEAD_CHARS,
      tailStart: total - PAGE_PREFETCH_TAIL_CHARS,
      total,
      omitted: 5000,
      outline: [],
    });
    if (plan.kind !== 'windowed') throw new Error('unreachable');
    expect(plan.head).toBe('h'.repeat(PAGE_PREFETCH_HEAD_CHARS));
    expect(plan.tail).toBe('t'.repeat(PAGE_PREFETCH_TAIL_CHARS));
    expect(plan.head).not.toContain('m');
    expect(plan.tail).not.toContain('m');
  });

  it('carries the outline into the windowed plan', () => {
    const plan = planPagePrefetch(
      page('x'.repeat(MAX_PAGE_PREFETCH_CHARS + 1), [{ level: 2, title: '第 4 节' }]),
    );
    expect(plan).toMatchObject({ outline: [{ level: 2, title: '第 4 节' }] });
  });
});

describe('renderPageOutline', () => {
  it('renders levels as heading marks inside one JSON array', () => {
    expect(
      renderPageOutline([
        { level: 1, title: '总览' },
        { level: 3, title: '细节' },
      ]),
    ).toBe(JSON.stringify(['# 总览', '### 细节']));
  });

  it('renders an empty outline as an empty array', () => {
    expect(renderPageOutline([])).toBe('[]');
  });
});
