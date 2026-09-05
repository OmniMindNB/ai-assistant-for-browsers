import { describe, expect, it } from 'vitest';
import {
  buildTabRefContext,
  findMentionQuery,
  planTabRefBudget,
  selectReferencableTabs,
  TAB_REF_SINGLE_MAX_CHARS,
} from './tab-reference';

describe('selectReferencableTabs', () => {
  it('keeps only http(s) tabs and drops the panel tab', () => {
    const tabs = [
      { id: 1, title: 'Panel', url: 'https://a.example.com' },
      { id: 2, title: 'Settings', url: 'chrome://settings' },
      { id: 3, title: 'Docs', url: 'https://docs.example.com', favIconUrl: 'https://docs.example.com/f.ico' },
      { id: 4, title: 'Local', url: 'file:///tmp/x.html' },
      { id: 5, url: 'http://plain.example.com' },
    ];
    expect(selectReferencableTabs(tabs, 1)).toEqual([
      { id: 3, title: 'Docs', url: 'https://docs.example.com', favIconUrl: 'https://docs.example.com/f.ico' },
      { id: 5, title: 'http://plain.example.com', url: 'http://plain.example.com' },
    ]);
  });

  it('drops entries without a usable id or url', () => {
    expect(selectReferencableTabs([{ title: 'ghost' }, { id: 9 }], 1)).toEqual([]);
  });
});

describe('planTabRefBudget', () => {
  it('gives a lone reference the same budget as the existing page prefetch', () => {
    expect(planTabRefBudget(1)).toBe(TAB_REF_SINGLE_MAX_CHARS);
  });

  it('splits the total budget across references', () => {
    expect(planTabRefBudget(5)).toBe(4800);
    expect(planTabRefBudget(2)).toBe(TAB_REF_SINGLE_MAX_CHARS);
  });

  it('returns 0 for no references', () => {
    expect(planTabRefBudget(0)).toBe(0);
  });
});

describe('buildTabRefContext', () => {
  it('labels each snapshot with title/url and repeats the untrusted-content warning', () => {
    const text = buildTabRefContext([
      { id: 7, title: 'Docs', url: 'https://docs.example.com', text: '正文一' },
      { id: 8, title: 'Blog', url: 'https://blog.example.com', text: '正文二' },
    ]);
    expect(text).toContain('untrusted page content');
    expect(text).toContain('https://docs.example.com');
    expect(text).toContain('正文二');
    expect(text).toContain('tabId 7');
  });

  it('returns an empty string when there is nothing to inject', () => {
    expect(buildTabRefContext([])).toBe('');
  });
});

describe('findMentionQuery', () => {
  it('finds a mention at the caret', () => {
    expect(findMentionQuery('对比 @doc', 7)).toEqual({ start: 3, query: 'doc' });
  });

  it('finds a bare @ that has just been typed', () => {
    expect(findMentionQuery('对比 @', 4)).toEqual({ start: 3, query: '' });
  });

  it('ignores an @ that is glued to a preceding word (e.g. an email address)', () => {
    expect(findMentionQuery('mail me@example.com', 19)).toBeNull();
  });

  it('stops at whitespace: a finished mention is no longer active', () => {
    expect(findMentionQuery('对比 @doc 和别的', 9)).toBeNull();
  });

  it('uses the caret, not the end of the string', () => {
    expect(findMentionQuery('@a 然后 @b', 2)).toEqual({ start: 0, query: 'a' });
  });
});
