import { describe, expect, it } from 'vitest';
import type { FormFieldDescriptor, GetFormResult } from '@/lib/messaging';
import { renderFieldLine, renderFormResultForModel } from './form-render';

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

function resultWith(overrides: Partial<GetFormResult> = {}): GetFormResult {
  return {
    forms: [],
    fields: [],
    orphanFieldIds: [],
    unreachable: { iframes: 0, closedShadowRoots: 0 },
    truncated: false,
    textTruncated: false,
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

describe('renderFormResultForModel', () => {
  it('keeps the untrusted-content declaration', () => {
    expect(renderFormResultForModel(resultWith())).toContain('untrusted page content');
  });

  it('leads with a count of forms and interactive elements', () => {
    const text = renderFormResultForModel(
      resultWith({ forms: [{ formId: 'form0', submitFieldIds: [] }], fields: [field(), field({ fieldId: 'f2' })] }),
    );
    expect(text).toContain('共 1 个表单、2 个可交互元素。');
  });

  it('renders one line per form with its submit handles', () => {
    const text = renderFormResultForModel(
      resultWith({
        forms: [{ formId: 'form0', method: 'post', action: 'https://example.com/checkout', submitFieldIds: ['f5'] }],
      }),
    );
    expect(text).toContain('[form0] method=post action=https://example.com/checkout submit=f5');
  });

  it('shows formId on fields only when the page has several forms', () => {
    const single = renderFormResultForModel(
      resultWith({ forms: [{ formId: 'form0', submitFieldIds: [] }], fields: [field({ formId: 'form0' })] }),
    );
    expect(single).not.toContain('form=form0');

    const many = renderFormResultForModel(
      resultWith({
        forms: [
          { formId: 'form0', submitFieldIds: [] },
          { formId: 'form1', submitFieldIds: [] },
        ],
        fields: [field({ formId: 'form0' })],
      }),
    );
    expect(many).toContain('form=form0');
  });

  it('never leaks any fingerprint', () => {
    const text = renderFormResultForModel(resultWith({ fields: [field({ fingerprint: 'SHOULD-NOT-APPEAR' })] }));
    expect(text).not.toContain('SHOULD-NOT-APPEAR');
  });

  it('keeps the closed-shadow-root and truncation notes that stop the model probing', () => {
    const text = renderFormResultForModel(
      resultWith({ unreachable: { iframes: 0, closedShadowRoots: 1 }, truncated: true }),
    );
    expect(text).toContain('closed shadow root');
    expect(text).toContain('字段数量已达上限');
  });

  it('keeps the textTruncated note when includeText cut off surrounding copy', () => {
    const text = renderFormResultForModel(resultWith({ textTruncated: true }));
    expect(text).toContain('部分正文已截断');
  });

  it('renders scrollable containers with their handles and four-directional remaining distance', () => {
    const text = renderFormResultForModel(
      resultWith({
        scrollableContainers: [
          { fieldId: 's1', tag: 'div', label: '消息列表', pixelsAbove: 0, pixelsBelow: 3400, pixelsLeft: 0, pixelsRight: 0 },
        ],
      }),
    );
    expect(text).toContain('s1 div「消息列表」top=0 bottom=3400 left=0 right=0');
  });

  it('renders trailing text when includeText was used', () => {
    expect(renderFormResultForModel(resultWith({ trailingText: '提交即代表同意条款' }))).toContain(
      '尾部正文: 提交即代表同意条款',
    );
  });

  it('is dramatically smaller than the pretty-printed JSON it replaces', () => {
    const fields = Array.from({ length: 40 }, (_, index) =>
      field({ fieldId: `f${index + 1}`, label: `字段${index + 1}` }),
    );
    const data = resultWith({ fields });
    expect(renderFormResultForModel(data).length).toBeLessThan(JSON.stringify(data, null, 2).length / 4);
  });
});

describe('分帧渲染', () => {
  // 会让这个用例失败的 production 改动：把子帧字段和主框架字段平铺在一起——
  // 模型无从判断这个「卡号」输入框属于哪一方。
  it('groups child-frame fields under an origin heading', () => {
    const rendered = renderFormResultForModel(resultWith({
      fields: [
        field({ fieldId: 'f1', label: '邮箱' }),
        field({ fieldId: 'f2', label: '卡号', frameOrigin: 'https://pay.example.com' }),
      ],
    }));

    expect(rendered).toContain('嵌入框架 https://pay.example.com');
    expect(rendered.indexOf('f1')).toBeLessThan(rendered.indexOf('嵌入框架'));
  });

  // 会让这个用例失败的 production 改动：保留旧的 unreachable.iframes 旁注——
  // 那句话现在是假的，会让模型主动放弃它其实够得着的表单。
  it('no longer tells the model that iframes are unreachable', () => {
    const rendered = renderFormResultForModel(resultWith({ unreachable: { iframes: 3, closedShadowRoots: 0 } }));
    expect(rendered).not.toContain('无法读取或操作');
  });

  // 会让这个用例失败的 production 改动：上限截断时不出旁注——
  // 模型会以为自己看到了页面上全部字段。
  it('reports how much was dropped by the frame and field caps', () => {
    const rendered = renderFormResultForModel(resultWith({ droppedFrames: 2, droppedChildFields: 7 }));
    expect(rendered).toContain('2');
    expect(rendered).toContain('7');
  });
});
