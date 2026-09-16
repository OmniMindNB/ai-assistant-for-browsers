import { describe, it, expect } from 'vitest';
import { describeToolResultNote } from './activity-result-note';

describe('describeToolResultNote', () => {
  it('counts find_text matches', () => {
    expect(describeToolResultNote('browser_find_text', { details: { matches: [{}, {}, {}], truncated: false } }))
      .toBe('3 results');
  });

  // truncated 说明"至少这么多"，写成确切数字会让用户以为页面上只有这些。
  it('marks a truncated find_text count as a lower bound', () => {
    expect(describeToolResultNote('browser_find_text', { details: { matches: [{}, {}], truncated: true } }))
      .toBe('2+ results');
  });

  it('counts form fields and dom matches', () => {
    expect(describeToolResultNote('browser_get_form', { details: { fields: [{}, {}, {}, {}] } })).toBe('4 fields');
    expect(describeToolResultNote('browser_query_dom', { details: { count: 12, truncated: false } })).toBe('12 results');
  });

  it('counts tracked tabs', () => {
    expect(describeToolResultNote('browser_list_tabs', { details: { trackedTabs: [{}, {}] } })).toBe('2 tabs');
  });

  // 填表是写操作，用户最该看到的是"几个字段真写进去了"，而不是"请求了几个"。
  it('reports how many fill_form fields actually landed', () => {
    const details = { outcomes: [{ status: 'ok' }, { status: 'ok' }, { status: 'not_found' }] };
    expect(describeToolResultNote('browser_fill_form', { details })).toBe('2/3 written');
  });

  it('returns undefined for tools with no naturally countable result', () => {
    expect(describeToolResultNote('browser_click', { details: { ok: true } })).toBeUndefined();
    expect(describeToolResultNote('browser_read_page', { details: { text: 'x' } })).toBeUndefined();
  });

  // 结果形状不对时宁可不显示，也不要编一个 0 出来——那会读成"什么都没找到"。
  it('returns undefined when the result does not have the expected shape', () => {
    expect(describeToolResultNote('browser_find_text', undefined)).toBeUndefined();
    expect(describeToolResultNote('browser_find_text', { details: {} })).toBeUndefined();
    expect(describeToolResultNote('browser_get_form', { details: { fields: 'nope' } })).toBeUndefined();
    expect(describeToolResultNote('browser_query_dom', { details: { count: 'nope' } })).toBeUndefined();
  });
});
