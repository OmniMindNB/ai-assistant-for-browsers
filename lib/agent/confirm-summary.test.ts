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

  it('summarizes modify_dom setText with the value being written', () => {
    const result = summarizeToolCallForConfirmation('browser_modify_dom', {
      selector: '.title',
      action: 'setText',
      value: 'Hello world',
    });
    expect(result.summary).toContain('.title');
    expect(result.summary).toContain('setText');
    expect(result.summary).toContain('Hello world');
  });

  it('summarizes modify_dom setAttribute with the attribute and value', () => {
    const result = summarizeToolCallForConfirmation('browser_modify_dom', {
      selector: 'a.link',
      action: 'setAttribute',
      attribute: 'href',
      value: 'https://evil.test',
    });
    expect(result.summary).toContain('href');
    expect(result.summary).toContain('https://evil.test');
  });

  it('truncates a long modify_dom value in the summary', () => {
    const longValue = 'x'.repeat(500);
    const result = summarizeToolCallForConfirmation('browser_modify_dom', {
      selector: '.body',
      action: 'setHtml',
      value: longValue,
    });
    expect(result.summary.length).toBeLessThan(400);
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

  it('summarizes type with the text being typed', () => {
    const result = summarizeToolCallForConfirmation('browser_type', { selector: 'input.name', text: 'Alice Smith' });
    expect(result.summary).toContain('input.name');
    expect(result.summary).toContain('Alice Smith');
  });

  it('truncates a long typed text in the summary', () => {
    const longText = 'y'.repeat(500);
    const result = summarizeToolCallForConfirmation('browser_type', { selector: 'textarea', text: longText });
    expect(result.summary.length).toBeLessThan(400);
  });

  it('summarizes set_storage with the value being written', () => {
    const result = summarizeToolCallForConfirmation('browser_set_storage', { area: 'local', key: 'token', value: 'secret-abc' });
    expect(result.summary).toContain('token');
    expect(result.summary).toContain('secret-abc');
  });

  it('summarizes set_storage with value: null as a deletion, not an empty write', () => {
    const result = summarizeToolCallForConfirmation('browser_set_storage', { area: 'session', key: 'cart', value: null });
    expect(result.summary).toContain('cart');
    expect(result.summary).toContain('删除');
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
