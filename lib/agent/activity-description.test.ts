import { describe, expect, it } from 'vitest';
import { describeToolActivity } from './activity-description';

describe('describeToolActivity', () => {
  it('describes a running click with the selector as target', () => {
    expect(describeToolActivity('browser_click', { selector: 'button.buy' }, 'running')).toBe('Clicking "button.buy"');
  });

  it('describes a failed click with the same target', () => {
    expect(describeToolActivity('browser_click', { selector: 'button.buy' }, 'failed')).toBe('Failed to click "button.buy"');
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
});
