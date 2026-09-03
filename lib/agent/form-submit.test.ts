import { describe, expect, it } from 'vitest';
import { decideSubmitIntent, type ClickTargetInfo } from './form-submit';

function target(overrides: Partial<ClickTargetInfo> = {}): ClickTargetInfo {
  return { tag: 'button', hasFormOwner: false, ...overrides };
}

describe('decideSubmitIntent', () => {
  it('treats a form-owned button with no explicit type as a submit', () => {
    expect(decideSubmitIntent(target({ hasFormOwner: true })).isSubmit).toBe(true);
  });

  it('treats a form-owned button[type=submit] as a submit', () => {
    expect(decideSubmitIntent(target({ type: 'submit', hasFormOwner: true })).isSubmit).toBe(true);
  });

  it('treats input[type=submit] and input[type=image] as submits', () => {
    expect(decideSubmitIntent(target({ tag: 'input', type: 'submit', hasFormOwner: true })).isSubmit).toBe(true);
    expect(decideSubmitIntent(target({ tag: 'input', type: 'image', hasFormOwner: true })).isSubmit).toBe(true);
  });

  it('does not treat button[type=button] as a submit', () => {
    expect(decideSubmitIntent(target({ type: 'button', hasFormOwner: true })).isSubmit).toBe(false);
  });

  it('does not treat a button outside any form as a submit', () => {
    expect(decideSubmitIntent(target({ type: 'submit', hasFormOwner: false })).isSubmit).toBe(false);
  });

  it('does not treat links or divs as submits', () => {
    expect(decideSubmitIntent(target({ tag: 'a', hasFormOwner: true })).isSubmit).toBe(false);
    expect(decideSubmitIntent(target({ tag: 'div', hasFormOwner: true })).isSubmit).toBe(false);
  });

  // 锁住 Spec-0005 的非目标：不做文案启发式。
  it('ignores button text entirely — no copy heuristics', () => {
    expect(decideSubmitIntent(target({ type: 'button', hasFormOwner: true, textContent: '立即下单' })).isSubmit).toBe(false);
    expect(decideSubmitIntent(target({ type: 'button', hasFormOwner: true, textContent: '支付' })).isSubmit).toBe(false);
    expect(decideSubmitIntent(target({ hasFormOwner: true, textContent: '取消' })).isSubmit).toBe(true);
  });

  it('carries the form action and field count through for the confirmation card', () => {
    const intent = decideSubmitIntent(
      target({ hasFormOwner: true, formAction: 'https://example.com/checkout', fieldCount: 12 }),
    );
    expect(intent).toEqual({ isSubmit: true, formAction: 'https://example.com/checkout', fieldCount: 12 });
  });

  it('reports no action or count when the target is not a submit', () => {
    expect(decideSubmitIntent(target({ type: 'button', hasFormOwner: true, formAction: 'https://x.test' })))
      .toEqual({ isSubmit: false });
  });
});

import { decideEnterSubmitIntent, type EnterTargetInfo } from './form-submit';

function enterTarget(overrides: Partial<EnterTargetInfo> = {}): EnterTargetInfo {
  return {
    tag: 'input',
    type: 'text',
    hasFormOwner: true,
    formAction: 'https://example.com/search',
    fieldCount: 3,
    hasSubmitButton: true,
    textLikeFieldCount: 2,
    ...overrides,
  };
}

describe('decideEnterSubmitIntent', () => {
  it('归属表单的文本框 + 表单有提交按钮 = 会提交', () => {
    expect(decideEnterSubmitIntent(enterTarget())).toEqual({
      isSubmit: true,
      formAction: 'https://example.com/search',
      fieldCount: 3,
    });
  });

  // HTML 隐式提交规则：没有提交按钮时，单字段表单仍然会被 Enter 提交。
  it('没有提交按钮但只有一个文本类字段 = 会提交', () => {
    const intent = decideEnterSubmitIntent(enterTarget({ hasSubmitButton: false, textLikeFieldCount: 1 }));
    expect(intent.isSubmit).toBe(true);
  });

  it('没有提交按钮且有多个文本类字段 = 不提交', () => {
    const intent = decideEnterSubmitIntent(enterTarget({ hasSubmitButton: false, textLikeFieldCount: 3 }));
    expect(intent.isSubmit).toBe(false);
  });

  it('不归属任何表单 = 不提交', () => {
    expect(decideEnterSubmitIntent(enterTarget({ hasFormOwner: false })).isSubmit).toBe(false);
  });

  // textarea 里 Enter 是换行，不是提交。
  it('textarea = 不提交', () => {
    expect(decideEnterSubmitIntent(enterTarget({ tag: 'textarea', type: undefined })).isSubmit).toBe(false);
  });

  it('checkbox / radio / button 类型的 input = 不提交', () => {
    for (const type of ['checkbox', 'radio', 'button', 'file']) {
      expect(decideEnterSubmitIntent(enterTarget({ type })).isSubmit).toBe(false);
    }
  });

  it('type 缺省的 input 按 text 处理 = 会提交', () => {
    expect(decideEnterSubmitIntent(enterTarget({ type: undefined })).isSubmit).toBe(true);
  });

  it('search/email/password/number 等文本类 type 都算', () => {
    for (const type of ['search', 'email', 'password', 'number', 'tel', 'url', 'date']) {
      expect(decideEnterSubmitIntent(enterTarget({ type })).isSubmit).toBe(true);
    }
  });

  // 与 decideSubmitIntent 同一原则：只看结构，不看文案。
  it('不因为按钮文案像"支付"就改变判定', () => {
    const intent = decideEnterSubmitIntent(enterTarget({ hasSubmitButton: false, textLikeFieldCount: 4 }));
    expect(intent.isSubmit).toBe(false);
  });
});
