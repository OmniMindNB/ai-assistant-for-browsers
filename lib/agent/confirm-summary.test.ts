import { describe, expect, it } from 'vitest';
import { summarizeToolCallForConfirmation } from './confirm-summary';

describe('summarizeToolCallForConfirmation', () => {
  it('summarizes inject_script with a code preview', () => {
    const result = summarizeToolCallForConfirmation('browser_inject_script', { code: 'document.title = "x"' });
    expect(result.summary).toContain('注入');
    expect(result.codePreview).toBe('document.title = "x"');
  });

  it('summarizes set_style with the selector', () => {
    const result = summarizeToolCallForConfirmation('browser_set_style', { selector: '.ad', styles: { display: 'none' } });
    expect(result.summary).toContain('.ad');
    expect(result.codePreview).toBeUndefined();
  });

  it('summarizes modify_dom with selector and action', () => {
    const result = summarizeToolCallForConfirmation('browser_modify_dom', { selector: '.ad', action: 'remove' });
    expect(result.summary).toContain('.ad');
    expect(result.summary).toContain('remove');
  });

  it('summarizes click, type, select, scroll, navigate, set_storage', () => {
    expect(summarizeToolCallForConfirmation('browser_click', { selector: 'button' }).summary).toContain('button');
    expect(summarizeToolCallForConfirmation('browser_type', { selector: 'input' }).summary).toContain('input');
    expect(summarizeToolCallForConfirmation('browser_select', { selector: 'select', value: 'a' }).summary).toContain('a');
    expect(summarizeToolCallForConfirmation('browser_scroll', {}).summary).toContain('滚动');
    expect(summarizeToolCallForConfirmation('browser_navigate', { url: 'https://x.test' }).summary).toContain(
      'https://x.test',
    );
    expect(summarizeToolCallForConfirmation('browser_set_storage', { area: 'local', key: 'k' }).summary).toContain('k');
  });

  it('falls back to a generic summary for an unknown tool', () => {
    const result = summarizeToolCallForConfirmation('browser_something_new', {});
    expect(result.summary).toContain('browser_something_new');
  });

  it('handles non-object args without throwing', () => {
    expect(() => summarizeToolCallForConfirmation('browser_click', undefined)).not.toThrow();
    expect(() => summarizeToolCallForConfirmation('browser_click', 'not an object')).not.toThrow();
  });
});
