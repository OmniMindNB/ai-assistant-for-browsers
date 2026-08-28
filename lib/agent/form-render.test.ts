import { describe, expect, it } from 'vitest';
import type { FormFieldDescriptor } from '@/lib/messaging';
import { renderFieldLine } from './form-render';

function field(overrides: Partial<FormFieldDescriptor> = {}): FormFieldDescriptor {
  return {
    fieldId: 'f1',
    kind: 'text',
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    valueState: 'empty',
    sensitive: false,
    writable: true,
    clickable: false,
    fingerprint: 'input|text|nickname|昵称',
    ...overrides,
  };
}

describe('renderFieldLine', () => {
  it('never leaks the fingerprint into model-facing text', () => {
    const line = renderFieldLine(field({ fingerprint: 'SHOULD-NOT-APPEAR' }), { showFormId: false });
    expect(line).not.toContain('SHOULD-NOT-APPEAR');
  });

  it('omits every attribute that equals its default', () => {
    const line = renderFieldLine(field({ label: '昵称' }), { showFormId: false });
    expect(line).toBe('f1 text「昵称」empty');
  });

  it('renders a filled value and the flags that are true', () => {
    const line = renderFieldLine(
      field({ label: '邮箱', type: 'email', value: 'a@b.c', valueState: 'filled', required: true }),
      { showFormId: false },
    );
    expect(line).toBe('f1 text「邮箱」type=email value="a@b.c" required');
  });

  it('falls back to name only when there is no label', () => {
    expect(renderFieldLine(field({ name: 'nickname' }), { showFormId: false })).toContain('name=nickname');
    expect(renderFieldLine(field({ name: 'nickname', label: '昵称' }), { showFormId: false })).not.toContain('name=');
  });

  it('renders toggles as checked/unchecked without a value or valueState', () => {
    const line = renderFieldLine(
      field({ fieldId: 'f3', kind: 'checkbox', label: '订阅', value: 'on', valueState: 'filled', checked: true }),
      { showFormId: false },
    );
    expect(line).toBe('f3 checkbox「订阅」checked');
  });

  it('does not tag non-value kinds with a valueState', () => {
    const line = renderFieldLine(field({ fieldId: 'f5', kind: 'submit', label: '提交' }), { showFormId: false });
    expect(line).toBe('f5 submit「提交」');
  });

  it('withholds a sensitive value but keeps the state and the flag', () => {
    const line = renderFieldLine(
      field({ fieldId: 'f2', kind: 'text', type: 'password', label: '密码', valueState: 'empty', sensitive: true }),
      { showFormId: false },
    );
    expect(line).toBe('f2 text「密码」type=password empty sensitive');
  });

  it('caps the option list and reports the true total', () => {
    const options = Array.from({ length: 12 }, (_, index) => ({
      value: String(index),
      label: `选项${index}`,
      selected: false,
    }));
    const line = renderFieldLine(field({ fieldId: 'f4', kind: 'select', label: '城市', options }), {
      showFormId: false,
    });
    expect(line).toContain('options=选项0|选项1|选项2|选项3|选项4|选项5|选项6|选项7|…(共 12 个)');
  });

  it('clips an overlong value', () => {
    const line = renderFieldLine(field({ value: 'x'.repeat(200), valueState: 'filled' }), { showFormId: false });
    expect(line).toContain(`value="${'x'.repeat(80)}…"`);
  });

  it('emits formId only when the caller says the page has several forms', () => {
    expect(renderFieldLine(field({ formId: 'form0' }), { showFormId: false })).not.toContain('form=');
    expect(renderFieldLine(field({ formId: 'form0' }), { showFormId: true })).toContain('form=form0');
  });

  it('puts precedingText on its own indented line', () => {
    const line = renderFieldLine(field({ label: '手机号', precedingText: '仅用于接收验证码' }), {
      showFormId: false,
    });
    expect(line).toBe('f1 text「手机号」empty\n  ctx: 仅用于接收验证码');
  });

  it('marks newly appeared and non-default-state fields', () => {
    const line = renderFieldLine(
      field({ label: '建议', isNew: true, visible: false, disabled: true, readOnly: true }),
      { showFormId: false },
    );
    expect(line).toBe('f1 text「建议」empty disabled readonly hidden new');
  });
});
