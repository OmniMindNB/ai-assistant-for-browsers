import { describe, expect, it } from 'vitest';
import type { FormFieldDescriptor } from '@/lib/messaging';
import {
  findNewFieldIds,
  isSensitiveField,
  MAX_FIELD_TEXT_CHARS,
  pickFieldLabel,
  resolveFieldKind,
  sanitizeFieldText,
  sanitizePageText,
  toFieldDescriptor,
  toScrollableContainerDescriptor,
  type RawFormField,
  type RawScrollableContainer,
} from './form-schema';

function raw(overrides: Partial<RawFormField> = {}): RawFormField {
  return {
    path: [{ kind: 'selector', selector: 'input', index: 0 }],
    tag: 'input',
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    contentEditable: false,
    ...overrides,
  };
}

describe('pickFieldLabel', () => {
  it('prefers the <label for> text over everything else', () => {
    const field = raw({
      forLabelText: '邮箱',
      ancestorLabelText: '祖先',
      ariaLabel: 'aria',
      placeholder: '请输入邮箱',
      name: 'email',
    });
    expect(pickFieldLabel(field)).toBe('邮箱');
  });

  it('falls back through the full priority chain', () => {
    expect(pickFieldLabel(raw({ ancestorLabelText: '祖先', ariaLabel: 'aria' }))).toBe('祖先');
    expect(pickFieldLabel(raw({ ariaLabel: 'aria', labelledByText: 'by' }))).toBe('aria');
    expect(pickFieldLabel(raw({ labelledByText: 'by', placeholder: 'ph' }))).toBe('by');
    expect(pickFieldLabel(raw({ placeholder: 'ph', name: 'n' }))).toBe('ph');
    expect(pickFieldLabel(raw({ name: 'n' }))).toBe('n');
    expect(pickFieldLabel(raw())).toBeUndefined();
  });

  it('collapses whitespace and truncates to 80 chars', () => {
    expect(pickFieldLabel(raw({ forLabelText: '  收件\n\n  地址  ' }))).toBe('收件 地址');
    expect(pickFieldLabel(raw({ forLabelText: 'a'.repeat(200) }))?.length).toBe(80);
  });

  it('ignores an empty-after-trim label and moves to the next source', () => {
    expect(pickFieldLabel(raw({ forLabelText: '   ', ariaLabel: 'aria' }))).toBe('aria');
  });

  it("falls back to the element's own text for buttons, links and generic interactive elements", () => {
    expect(pickFieldLabel(raw({ tag: 'button', elementText: '下单' }))).toBe('下单');
    expect(pickFieldLabel(raw({ tag: 'a', href: '/x', elementText: '登录' }))).toBe('登录');
    expect(pickFieldLabel(raw({ tag: 'div', interactive: true, elementText: '展开菜单' }))).toBe('展开菜单');
  });

  it('does not fall back to element text for a plain text input', () => {
    expect(pickFieldLabel(raw({ tag: 'input', type: 'text', elementText: '一些无关文本' }))).toBeUndefined();
  });
});

describe('isSensitiveField', () => {
  it('flags password inputs', () => {
    expect(isSensitiveField(raw({ type: 'password' }))).toBe(true);
  });

  it('flags payment autocomplete tokens', () => {
    expect(isSensitiveField(raw({ autocomplete: 'cc-number' }))).toBe(true);
    expect(isSensitiveField(raw({ autocomplete: 'cc-csc' }))).toBe(true);
  });

  it('flags otp/cvv/ssn style names on a token boundary', () => {
    expect(isSensitiveField(raw({ name: 'card_cvv' }))).toBe(true);
    expect(isSensitiveField(raw({ id: 'one-time-otp' }))).toBe(true);
    expect(isSensitiveField(raw({ name: 'ssn' }))).toBe(true);
  });

  it('does not flag innocent fields that merely contain those letters', () => {
    expect(isSensitiveField(raw({ name: 'discount-code' }))).toBe(false);
    expect(isSensitiveField(raw({ name: 'processing_note' }))).toBe(false);
    expect(isSensitiveField(raw({ name: 'lesson' }))).toBe(false);
    expect(isSensitiveField(raw({ type: 'text', name: 'email' }))).toBe(false);
  });
});

describe('resolveFieldKind', () => {
  it('maps inputs by type', () => {
    expect(resolveFieldKind(raw({ type: 'text' }))).toBe('text');
    expect(resolveFieldKind(raw({ type: 'email' }))).toBe('text');
    expect(resolveFieldKind(raw({ type: 'checkbox' }))).toBe('checkbox');
    expect(resolveFieldKind(raw({ type: 'radio' }))).toBe('radio');
    expect(resolveFieldKind(raw({ type: 'file' }))).toBe('file');
    expect(resolveFieldKind(raw({ type: 'submit' }))).toBe('submit');
  });

  it('maps textarea, select, contenteditable and buttons', () => {
    expect(resolveFieldKind(raw({ tag: 'textarea' }))).toBe('textarea');
    expect(resolveFieldKind(raw({ tag: 'select' }))).toBe('select');
    expect(resolveFieldKind(raw({ tag: 'div', contentEditable: true }))).toBe('contenteditable');
    expect(resolveFieldKind(raw({ tag: 'button', buttonRole: 'submit' }))).toBe('submit');
    expect(resolveFieldKind(raw({ tag: 'button', buttonRole: 'button' }))).toBe('button');
  });

  it('falls back to unsupported for anything else', () => {
    expect(resolveFieldKind(raw({ tag: 'div' }))).toBe('unsupported');
  });

  it('maps a hyperlink with an href to link', () => {
    expect(resolveFieldKind(raw({ tag: 'a', href: 'https://example.com' }))).toBe('link');
  });

  it('does not treat an anchor without href as a link', () => {
    expect(resolveFieldKind(raw({ tag: 'a' }))).toBe('unsupported');
  });

  it('maps a generic interactive element (role/tabindex) to button', () => {
    expect(resolveFieldKind(raw({ tag: 'div', interactive: true }))).toBe('button');
  });
});

describe('toFieldDescriptor formId', () => {
  // 会让这个用例失败的 production 改动：子帧字段的 formId 也直接渲染成 formN。
  // formIndex 是「本文档内第几个 <form>」，每个帧各自从 0 数起，撞名之后
  // background 的 getForm() 按 formId 相等过滤 submitFieldIds 时，会把子帧的提交按钮
  // 算进主框架表单里，模型看到的表单分组因此失真。
  it('namespaces a child-frame formId so it cannot collide with a main-frame one', () => {
    const child = toFieldDescriptor(
      { ...raw({ formIndex: 0 }), frameId: 4, frameOrigin: 'https://pay.example.com' },
      'f1',
    );
    expect(child.formId).toBe('f4:form0');
    expect(child.formId).not.toBe('form0');
  });

  // 会让这个用例失败的 production 改动：主框架字段也被加上前缀，
  // 那样 getForm() 的 submitFieldIds 过滤（比对 `form${formIndex}`）一条都匹配不上。
  it('keeps the plain formN shape for main-frame and legacy fields', () => {
    expect(toFieldDescriptor({ ...raw({ formIndex: 2 }), frameId: 0 }, 'f2').formId).toBe('form2');
    expect(toFieldDescriptor(raw({ formIndex: 1 }), 'f3').formId).toBe('form1');
  });

  it('leaves formId undefined for a field that belongs to no form', () => {
    expect(toFieldDescriptor(raw(), 'f4').formId).toBeUndefined();
  });
});

describe('toFieldDescriptor', () => {
  it('omits the value of a sensitive field but still reports whether it is filled', () => {
    const descriptor = toFieldDescriptor(raw({ type: 'password', name: 'pw', value: 'hunter2' }), 'f1');
    expect(descriptor.value).toBeUndefined();
    expect(descriptor.valueState).toBe('filled');
    expect(descriptor.sensitive).toBe(true);
    expect(descriptor.writable).toBe(false);
  });

  it('keeps the value of a normal field and marks it writable', () => {
    const descriptor = toFieldDescriptor(raw({ type: 'text', name: 'email', value: 'a@b.c' }), 'f2');
    expect(descriptor.value).toBe('a@b.c');
    expect(descriptor.valueState).toBe('filled');
    expect(descriptor.writable).toBe(true);
  });

  it('marks disabled, readOnly, file and unsupported fields as not writable', () => {
    expect(toFieldDescriptor(raw({ type: 'text', disabled: true }), 'f3').writable).toBe(false);
    expect(toFieldDescriptor(raw({ type: 'text', readOnly: true }), 'f4').writable).toBe(false);
    expect(toFieldDescriptor(raw({ type: 'file' }), 'f5').writable).toBe(false);
    expect(toFieldDescriptor(raw({ tag: 'div' }), 'f6').writable).toBe(false);
  });

  it('marks buttons clickable and text fields not', () => {
    expect(toFieldDescriptor(raw({ tag: 'button', buttonRole: 'submit' }), 'f7').clickable).toBe(true);
    expect(toFieldDescriptor(raw({ type: 'text' }), 'f8').clickable).toBe(false);
  });

  it('gives the same fingerprint to structurally identical fields and different ones otherwise', () => {
    const a = toFieldDescriptor(raw({ type: 'text', name: 'email', forLabelText: '邮箱' }), 'f1');
    const b = toFieldDescriptor(raw({ type: 'text', name: 'email', forLabelText: '邮箱' }), 'f9');
    const c = toFieldDescriptor(raw({ type: 'text', name: 'phone', forLabelText: '邮箱' }), 'f10');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  it('marks links clickable and passes href through', () => {
    const descriptor = toFieldDescriptor(raw({ tag: 'a', href: '/settings' }), 'f11');
    expect(descriptor.clickable).toBe(true);
    expect(descriptor.href).toBe('/settings');
  });

  it('does not set href for a non-link field', () => {
    expect(toFieldDescriptor(raw({ type: 'text', name: 'email' }), 'f12').href).toBeUndefined();
  });

  it('sanitizes precedingText onto the descriptor', () => {
    const descriptor = toFieldDescriptor(raw({ type: 'text', name: 'email', precedingText: 'a\u0000b  c' }), 'f13');
    expect(descriptor.precedingText).toBe('ab c');
  });

  it('leaves precedingText undefined when the raw field has none', () => {
    expect(toFieldDescriptor(raw({ type: 'text', name: 'email' }), 'f14').precedingText).toBeUndefined();
  });

  it('drops precedingText when it exactly matches the resolved label (pure restatement of <label>)', () => {
    const descriptor = toFieldDescriptor(
      raw({ type: 'text', name: 'email', forLabelText: '邮箱', precedingText: '邮箱' }),
      'f15',
    );
    expect(descriptor.label).toBe('邮箱');
    expect(descriptor.precedingText).toBeUndefined();
  });

  it('keeps precedingText that merely ends with the label, since that is not an exact match (Fix 2 ruling: exact-match only)', () => {
    const descriptor = toFieldDescriptor(
      raw({ type: 'text', name: 'email', forLabelText: '邮箱', precedingText: '一些说明 邮箱' }),
      'f16',
    );
    expect(descriptor.label).toBe('邮箱');
    expect(descriptor.precedingText).toBe('一些说明 邮箱');
  });

  it('keeps precedingText that differs from the label even after sanitization normalizes whitespace', () => {
    const descriptor = toFieldDescriptor(
      raw({ type: 'text', name: 'email', forLabelText: '邮箱', precedingText: '请填写您的常用邮箱地址' }),
      'f17',
    );
    expect(descriptor.precedingText).toBe('请填写您的常用邮箱地址');
  });

  // 会让这个用例失败的 production 改动：toFieldDescriptor 的形参停留在纯 RawFormField——
  // 合并后的子帧字段带着 frameOrigin 传进来也读不出，渲染层就永远分不清字段属于哪个帧。
  it('passes frameOrigin through onto the descriptor when the merged raw field carries one', () => {
    const descriptor = toFieldDescriptor(
      { ...raw({ type: 'text', name: 'cardNumber' }), frameOrigin: 'https://pay.example.com' },
      'f18',
    );
    expect(descriptor.frameOrigin).toBe('https://pay.example.com');
  });

  it('leaves frameOrigin undefined for a main-frame field', () => {
    expect(toFieldDescriptor(raw({ type: 'text', name: 'email' }), 'f19').frameOrigin).toBeUndefined();
  });
});

describe('sanitizePageText', () => {
  it('strips control characters and collapses whitespace', () => {
    expect(sanitizePageText('a\u0000b\n\nc', 60)).toBe('ab c');
  });

  it('truncates with an ellipsis', () => {
    expect(sanitizePageText('x'.repeat(100), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('returns an empty string for undefined-ish input', () => {
    expect(sanitizePageText('', 10)).toBe('');
  });
});

describe('sanitizeFieldText', () => {
  it('returns truncated: false and no text for undefined input', () => {
    expect(sanitizeFieldText(undefined)).toEqual({ truncated: false });
  });

  it('normalizes whitespace and strips control characters without truncating short text', () => {
    expect(sanitizeFieldText('a\u0000b\n\nc')).toEqual({ text: 'ab c', truncated: false });
  });

  it('truncates and reports truncated: true when normalized text exceeds MAX_FIELD_TEXT_CHARS (defaults to keeping the head)', () => {
    const long = 'x'.repeat(MAX_FIELD_TEXT_CHARS + 50);
    const result = sanitizeFieldText(long);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(`${'x'.repeat(MAX_FIELD_TEXT_CHARS)}…`);
  });

  it('returns truncated: false for a string that normalizes to empty', () => {
    expect(sanitizeFieldText('   \n\t  ')).toEqual({ truncated: false });
  });

  it('does not truncate text whose normalized length is exactly MAX_FIELD_TEXT_CHARS (> vs >= boundary)', () => {
    const exact = 'x'.repeat(MAX_FIELD_TEXT_CHARS);
    const result = sanitizeFieldText(exact);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(exact);
  });

  it("keeps the tail (with a leading ellipsis) when keepEnd is 'tail', for precedingText", () => {
    const long = `head-part-lost${'x'.repeat(MAX_FIELD_TEXT_CHARS)}`;
    const result = sanitizeFieldText(long, 'tail');
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(`…${'x'.repeat(MAX_FIELD_TEXT_CHARS)}`);
    expect(result.text?.startsWith('…')).toBe(true);
  });

  it("keeps the head (with a trailing ellipsis) when keepEnd is 'head' (explicit), for trailingText", () => {
    const long = `${'x'.repeat(MAX_FIELD_TEXT_CHARS)}tail-part-lost`;
    const result = sanitizeFieldText(long, 'head');
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(`${'x'.repeat(MAX_FIELD_TEXT_CHARS)}…`);
  });
});

// 「上一步之后新出现了哪些可交互元素」——填完输入框弹出的下拉建议、点开的菜单项，
// 都靠这个差集识别（对标 alibaba/page-agent 的 *[n] 新元素标记）。
describe('findNewFieldIds', () => {
  function field(fieldId: string, fingerprint: string): FormFieldDescriptor {
    return {
      fieldId,
      kind: 'button',
      required: false,
      disabled: false,
      readOnly: false,
      visible: true,
      valueState: 'empty',
      sensitive: false,
      writable: false,
      clickable: true,
      fingerprint,
    };
  }

  // 首次读取该页面时「全都是新的」，这个信号没有信息量，只会淹没真正的变化。
  it('marks nothing as new when there is no previous snapshot', () => {
    expect(findNewFieldIds([field('f1', 'a'), field('f2', 'b')], undefined)).toEqual(new Set());
  });

  it('marks nothing as new when the snapshot is unchanged', () => {
    expect(findNewFieldIds([field('f1', 'a'), field('f2', 'b')], ['a', 'b'])).toEqual(new Set());
  });

  it('marks a newly appeared field', () => {
    expect(findNewFieldIds([field('f1', 'a'), field('f2', 'b')], ['a'])).toEqual(new Set(['f2']));
  });

  // 一页上五个一模一样的「删除」按钮共享同一个指纹，所以要按多重集比较个数，
  // 不能只看指纹「存不存在」。
  it('counts duplicates and marks only the surplus, latest-first in document order', () => {
    const fields = [field('f1', 'x'), field('f2', 'x'), field('f3', 'x'), field('f4', 'x')];
    expect(findNewFieldIds(fields, ['x', 'x'])).toEqual(new Set(['f3', 'f4']));
  });

  it('marks only the addition when one field is replaced by another', () => {
    expect(findNewFieldIds([field('f1', 'a'), field('f2', 'c')], ['a', 'b'])).toEqual(new Set(['f2']));
  });

  it('marks nothing when fields only disappeared', () => {
    expect(findNewFieldIds([field('f1', 'a')], ['a', 'b'])).toEqual(new Set());
  });
});

describe('toFieldDescriptor byCursor passthrough', () => {
  function raw(overrides: Partial<RawFormField> = {}): RawFormField {
    return {
      path: [],
      tag: 'div',
      required: false,
      disabled: false,
      readOnly: false,
      visible: true,
      contentEditable: false,
      ...overrides,
    };
  }

  it('carries byCursor through to the descriptor', () => {
    expect(toFieldDescriptor(raw({ byCursor: true, interactive: true }), 'f1').byCursor).toBe(true);
  });

  it('leaves byCursor undefined for semantically detected fields', () => {
    expect(toFieldDescriptor(raw({ tag: 'button' }), 'f1').byCursor).toBeUndefined();
  });

  it('makes a cursor-detected element clickable, not unsupported', () => {
    // interactive 为真是 resolveFieldKind 归到 'button' 的唯一途径；漏了它，
    // 靠 cursor 捞回来的元素会拿到 unsupported、被 CLICKABLE_KINDS 判为不可点击，
    // 等于发了一个没用的句柄（ref: 设计文档 §4.5）。
    const descriptor = toFieldDescriptor(raw({ byCursor: true, interactive: true, elementText: '下单' }), 'f1');
    expect(descriptor.kind).toBe('button');
    expect(descriptor.clickable).toBe(true);
    expect(descriptor.label).toBe('下单');
  });
});

function rawScrollable(overrides: Partial<RawScrollableContainer> = {}): RawScrollableContainer {
  return {
    path: [{ kind: 'selector', selector: 'div', index: 0 }],
    tag: 'div',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    scrollLeft: 0,
    scrollWidth: 0,
    clientWidth: 0,
    ...overrides,
  };
}

describe('toScrollableContainerDescriptor', () => {
  it('reports vertical remaining distance instead of raw scrollTop/scrollHeight/clientHeight', () => {
    const descriptor = toScrollableContainerDescriptor(
      rawScrollable({ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 }),
      's1',
    );
    expect(descriptor.pixelsAbove).toBe(300);
    expect(descriptor.pixelsBelow).toBe(300); // maxScroll = 1000-400 = 600; 600-300 = 300
  });

  it('reports horizontal remaining distance the same way', () => {
    const descriptor = toScrollableContainerDescriptor(
      rawScrollable({ scrollLeft: 100, scrollWidth: 900, clientWidth: 400 }),
      's1',
    );
    expect(descriptor.pixelsLeft).toBe(100);
    expect(descriptor.pixelsRight).toBe(400); // maxScrollX = 900-400 = 500; 500-100 = 400
  });

  it('clamps remaining distance to 0 instead of going negative for a stale/inconsistent snapshot', () => {
    const descriptor = toScrollableContainerDescriptor(
      rawScrollable({ scrollTop: 900, scrollHeight: 1000, clientHeight: 400, scrollLeft: 900, scrollWidth: 900, clientWidth: 400 }),
      's1',
    );
    expect(descriptor.pixelsBelow).toBe(0);
    expect(descriptor.pixelsRight).toBe(0);
  });

  it('reports zero remaining distance in both directions for a container with no horizontal overflow', () => {
    const descriptor = toScrollableContainerDescriptor(
      rawScrollable({ scrollTop: 0, scrollHeight: 800, clientHeight: 300 }),
      's1',
    );
    expect(descriptor.pixelsLeft).toBe(0);
    expect(descriptor.pixelsRight).toBe(0);
  });

  it('carries fieldId, tag, and label through unchanged', () => {
    const descriptor = toScrollableContainerDescriptor(rawScrollable({ tag: 'section', label: '聊天记录' }), 's2');
    expect(descriptor.fieldId).toBe('s2');
    expect(descriptor.tag).toBe('section');
    expect(descriptor.label).toBe('聊天记录');
  });
});
