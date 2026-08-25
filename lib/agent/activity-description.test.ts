import { describe, expect, it } from 'vitest';
import { describeToolActivity } from './activity-description';

describe('describeToolActivity', () => {
  it('describes a running click with the selector as target', () => {
    expect(describeToolActivity('browser_click', { selector: 'button.buy' }, 'running')).toBe('Clicking "button.buy"');
  });

  it('describes asking, having asked, and a failed ask with the question as target', () => {
    expect(describeToolActivity('ask_user', { question: '要保存这些改动吗？' }, 'running')).toBe('Asking: "要保存这些改动吗？"');
    expect(describeToolActivity('ask_user', { question: '要保存这些改动吗？' }, 'done')).toBe('Asked: "要保存这些改动吗？"');
    expect(describeToolActivity('ask_user', { question: '要保存这些改动吗？' }, 'failed')).toBe('Failed to ask "要保存这些改动吗？"');
  });

  it('describes a failed click with the same target', () => {
    expect(describeToolActivity('browser_click', { selector: 'button.buy' }, 'failed')).toBe('Failed to click "button.buy"');
  });

  it('describes a running click by fieldId when no selector is given', () => {
    expect(describeToolActivity('browser_click', { fieldId: 'f7' }, 'running')).toBe('Clicking "f7"');
  });

  it('describes running type/select/setStyle/modifyDom/getHtml/getComputedStyle/queryDom by selector', () => {
    expect(describeToolActivity('browser_type', { selector: 'input.name' }, 'running')).toBe('Typing into "input.name"');
    expect(describeToolActivity('browser_select', { selector: 'select.country' }, 'running')).toBe('Selecting an option in "select.country"');
    expect(describeToolActivity('browser_set_style', { selector: '.ad' }, 'running')).toBe('Styling ".ad"');
    expect(describeToolActivity('browser_modify_dom', { selector: '.ad' }, 'running')).toBe('Modifying ".ad"');
    expect(describeToolActivity('browser_get_html', { selector: 'main' }, 'running')).toBe('Reading HTML for "main"');
    expect(describeToolActivity('browser_get_computed_style', { selector: 'main' }, 'running')).toBe('Reading computed style for "main"');
    expect(describeToolActivity('browser_query_dom', { selector: 'main' }, 'running')).toBe('Querying "main"');
  });

  it('falls back to "html" for get_html with no selector', () => {
    expect(describeToolActivity('browser_get_html', {}, 'running')).toBe('Reading HTML for "html"');
  });

  it('describes navigate by URL and set_storage by key', () => {
    expect(describeToolActivity('browser_navigate', { url: 'https://example.com' }, 'running')).toBe('Navigating to "https://example.com"');
    expect(describeToolActivity('browser_set_storage', { key: 'token' }, 'running')).toBe('Writing storage key "token"');
  });

  it('describes fill_form by field count', () => {
    expect(
      describeToolActivity(
        'browser_fill_form',
        { fields: [{ fieldId: 'f1' }, { fieldId: 'f2' }, { fieldId: 'f3' }] },
        'running',
      ),
    ).toBe('Filling 3 fields');
    expect(describeToolActivity('browser_fill_form', { fields: [{ fieldId: 'f1' }] }, 'done')).toBe('Filled 1 fields');
    expect(describeToolActivity('browser_fill_form', {}, 'failed')).toBe('Failed to fill 0 fields');
  });

  it('describes scroll with and without a target selector', () => {
    expect(describeToolActivity('browser_scroll', { selector: '#footer' }, 'running')).toBe('Scrolling to "#footer"');
    expect(describeToolActivity('browser_scroll', {}, 'running')).toBe('Scroll');
  });

  it('describes inspect_page_implementation with and without a focus', () => {
    expect(describeToolActivity('browser_inspect_page_implementation', { focus: 'scroll' }, 'running')).toBe(
      'Inspecting page implementation (focus: "scroll")',
    );
    expect(describeToolActivity('browser_inspect_page_implementation', {}, 'running')).toBe('Inspect page implementation');
  });

  it('falls back to the plain tool label for no-arg tools, appending a failure suffix when failed', () => {
    expect(describeToolActivity('browser_get_active_tab', {}, 'running')).toBe('Get active tab');
    expect(describeToolActivity('browser_get_active_tab', {}, 'failed')).toBe('Get active tab failed');
    expect(describeToolActivity('browser_read_page', {}, 'running')).toBe('Read page');
    expect(describeToolActivity('browser_get_page_meta', {}, 'running')).toBe('Get page metadata');
    expect(describeToolActivity('browser_get_scripts', {}, 'running')).toBe('Get scripts');
    expect(describeToolActivity('browser_get_stylesheets', {}, 'running')).toBe('Get stylesheets');
    expect(describeToolActivity('browser_screenshot', {}, 'running')).toBe('Take screenshot');
  });

  it('falls back to a generic label for an unknown tool', () => {
    expect(describeToolActivity('browser_something_new', {}, 'running')).toBe('Browser action');
    expect(describeToolActivity('browser_something_new', {}, 'failed')).toBe('Browser action failed');
  });

  it('truncates a very long target', () => {
    const longSelector = `.${'x'.repeat(200)}`;
    const result = describeToolActivity('browser_click', { selector: longSelector }, 'running');
    expect(result.length).toBeLessThan(100);
    expect(result).toContain('…');
  });

  it('handles non-object args without throwing', () => {
    expect(() => describeToolActivity('browser_click', undefined, 'running')).not.toThrow();
    expect(() => describeToolActivity('browser_click', 'not an object', 'running')).not.toThrow();
  });

  it('describes done click/type/select/setStyle/modifyDom/getHtml/getComputedStyle/queryDom by selector', () => {
    expect(describeToolActivity('browser_click', { selector: 'button.buy' }, 'done')).toBe('Clicked "button.buy"');
    expect(describeToolActivity('browser_type', { selector: 'input.name' }, 'done')).toBe('Typed into "input.name"');
    expect(describeToolActivity('browser_select', { selector: 'select.country' }, 'done')).toBe('Selected an option in "select.country"');
    expect(describeToolActivity('browser_set_style', { selector: '.ad' }, 'done')).toBe('Styled ".ad"');
    expect(describeToolActivity('browser_modify_dom', { selector: '.ad' }, 'done')).toBe('Modified ".ad"');
    expect(describeToolActivity('browser_get_html', { selector: 'main' }, 'done')).toBe('Read HTML for "main"');
    expect(describeToolActivity('browser_get_computed_style', { selector: 'main' }, 'done')).toBe('Read computed style for "main"');
    expect(describeToolActivity('browser_query_dom', { selector: 'main' }, 'done')).toBe('Queried "main"');
  });

  it('describes done navigate/set_storage/scroll/inspect_page_implementation', () => {
    expect(describeToolActivity('browser_navigate', { url: 'https://example.com' }, 'done')).toBe('Navigated to "https://example.com"');
    expect(describeToolActivity('browser_set_storage', { key: 'token' }, 'done')).toBe('Wrote storage key "token"');
    expect(describeToolActivity('browser_scroll', { selector: '#footer' }, 'done')).toBe('Scrolled to "#footer"');
    expect(describeToolActivity('browser_inspect_page_implementation', { focus: 'scroll' }, 'done')).toBe(
      'Inspected page implementation (focus: "scroll")',
    );
  });

  it('reuses the plain tool label for done no-arg tools (same as running, no tense change needed)', () => {
    expect(describeToolActivity('browser_get_active_tab', {}, 'done')).toBe('Get active tab');
    expect(describeToolActivity('browser_read_page', {}, 'done')).toBe('Read page');
    expect(describeToolActivity('browser_scroll', {}, 'done')).toBe('Scroll');
    expect(describeToolActivity('browser_something_new', {}, 'done')).toBe('Browser action');
  });
});
