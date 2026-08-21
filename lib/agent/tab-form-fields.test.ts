import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  clearFormFieldsForTab,
  getFormFieldsForTab,
  setFormFieldsForTab,
  type FormFieldTable,
} from './tab-form-fields';

(globalThis as any).browser = fakeBrowser;

function table(overrides: Partial<FormFieldTable> = {}): FormFieldTable {
  return {
    url: 'https://example.com/checkout',
    fields: {
      f1: {
        path: [{ kind: 'selector', selector: 'input[name=email]', index: 0 }],
        expect: { tag: 'input', type: 'email', name: 'email', label: '邮箱' },
        sensitive: false,
        kind: 'text',
      },
    },
    ...overrides,
  };
}

describe('tab-form-fields', () => {
  const TAB_ID = 1;

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('has no field table for an untouched tab', async () => {
    expect(await getFormFieldsForTab(TAB_ID)).toBeUndefined();
  });

  it('stores and reads back a field table', async () => {
    await setFormFieldsForTab(TAB_ID, table());
    const stored = await getFormFieldsForTab(TAB_ID);
    expect(stored?.fields.f1?.expect.name).toBe('email');
    expect(stored?.url).toBe('https://example.com/checkout');
  });

  it('replaces the previous table instead of merging', async () => {
    await setFormFieldsForTab(TAB_ID, table());
    await setFormFieldsForTab(TAB_ID, table({ fields: { f2: table().fields.f1 } }));
    const stored = await getFormFieldsForTab(TAB_ID);
    expect(stored?.fields.f1).toBeUndefined();
    expect(stored?.fields.f2).toBeDefined();
  });

  it('isolates field tables between tabs', async () => {
    await setFormFieldsForTab(1, table({ url: 'https://a.test' }));
    await setFormFieldsForTab(2, table({ url: 'https://b.test' }));
    expect((await getFormFieldsForTab(1))?.url).toBe('https://a.test');
    expect((await getFormFieldsForTab(2))?.url).toBe('https://b.test');
  });

  it('clears the table', async () => {
    await setFormFieldsForTab(TAB_ID, table());
    await clearFormFieldsForTab(TAB_ID);
    expect(await getFormFieldsForTab(TAB_ID)).toBeUndefined();
  });

  it('degrades silently when persisting fails', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await setFormFieldsForTab(TAB_ID, table());
    expect(await getFormFieldsForTab(TAB_ID)).toBeUndefined();
  });

  it('does not throw when clearing a table that was never set', async () => {
    await expect(clearFormFieldsForTab(TAB_ID)).resolves.toBeUndefined();
  });
});
