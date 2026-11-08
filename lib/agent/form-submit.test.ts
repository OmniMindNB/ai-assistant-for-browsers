import { describe, expect, it } from 'vitest';
import {
  countLandedFieldWrites,
  decideFormlessCommitIntent,
  decideSubmitIntent,
  FORM_COMMIT_CONFIRM_MIN_LANDED_WRITES,
  type ClickTargetInfo,
} from './form-submit';
import type { FormFieldKind } from '@/lib/messaging';

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

describe('decideFormlessCommitIntent（无 form 结构的提交确认）', () => {
  it('阈值是 3：本轮落地写入不达标不确认', () => {
    expect(FORM_COMMIT_CONFIRM_MIN_LANDED_WRITES).toBe(3);
    expect(decideFormlessCommitIntent({ kind: 'button', landedFieldWrites: 2 })).toBe(false);
    expect(decideFormlessCommitIntent({ kind: 'button', landedFieldWrites: 3 })).toBe(true);
    expect(decideFormlessCommitIntent({ kind: 'button' })).toBe(false);
  });

  it('句柄 kind 为 submit / button 的是提交候选', () => {
    expect(decideFormlessCommitIntent({ kind: 'submit', landedFieldWrites: 5 })).toBe(true);
    expect(decideFormlessCommitIntent({ kind: 'button', landedFieldWrites: 5 })).toBe(true);
  });

  it('链接、可写字段、滚动容器不是提交候选', () => {
    const kinds: FormFieldKind[] = ['link', 'text', 'textarea', 'select', 'checkbox', 'radio', 'scrollable'];
    for (const kind of kinds) {
      expect(decideFormlessCommitIntent({ kind, landedFieldWrites: 5 })).toBe(false);
    }
  });

  it('无句柄 kind 时退回探针形状判定（selector 路径）', () => {
    expect(decideFormlessCommitIntent({ tag: 'button', landedFieldWrites: 5 })).toBe(true);
    expect(decideFormlessCommitIntent({ tag: 'input', type: 'button', landedFieldWrites: 5 })).toBe(true);
    expect(decideFormlessCommitIntent({ tag: 'input', type: 'image', landedFieldWrites: 5 })).toBe(true);
    expect(decideFormlessCommitIntent({ tag: 'input', type: 'text', landedFieldWrites: 5 })).toBe(false);
    expect(decideFormlessCommitIntent({ tag: 'div', role: 'button', landedFieldWrites: 5 })).toBe(true);
    expect(decideFormlessCommitIntent({ tag: 'div', role: 'link', landedFieldWrites: 5 })).toBe(false);
    expect(decideFormlessCommitIntent({ tag: 'a', landedFieldWrites: 5 })).toBe(false);
    expect(decideFormlessCommitIntent({ tag: 'div', landedFieldWrites: 5 })).toBe(false);
  });

});

describe('countLandedFieldWrites（填写活动计数）', () => {
  it('只数回读确认过的 fill_form outcomes，pendingSelection 不算落地', () => {
    expect(
      countLandedFieldWrites('browser_fill_form', {
        outcomes: [
          { fieldId: 'f1', status: 'ok' },
          { fieldId: 'f2', status: 'ok', pendingSelection: true },
          { fieldId: 'f3', status: 'invalid_value' },
          { fieldId: 'f4', status: 'ok' },
        ],
      }),
    ).toBe(2);
    expect(countLandedFieldWrites('browser_fill_form', {})).toBe(0);
    expect(countLandedFieldWrites('browser_fill_form', undefined)).toBe(0);
  });

  it('type / select 各计 1，待选定与失败不计', () => {
    expect(countLandedFieldWrites('browser_type', { status: 'ok' })).toBe(1);
    expect(countLandedFieldWrites('browser_type', { status: 'ok', pendingSelection: true })).toBe(0);
    expect(countLandedFieldWrites('browser_type', { status: 'not_writable' })).toBe(0);
    expect(countLandedFieldWrites('browser_select', { status: 'ok' })).toBe(1);
    expect(countLandedFieldWrites('browser_select', { status: 'not_found' })).toBe(0);
  });

  it('单点点击只认可写字段 kind，点按钮/链接不计数', () => {
    expect(countLandedFieldWrites('browser_click', { status: 'ok', kind: 'checkbox' })).toBe(1);
    expect(countLandedFieldWrites('browser_click', { status: 'ok', kind: 'radio' })).toBe(1);
    expect(countLandedFieldWrites('browser_click', { status: 'ok', kind: 'button' })).toBe(0);
    expect(countLandedFieldWrites('browser_click', { status: 'ok', kind: 'link' })).toBe(0);
    // selector 兑底路径没有句柄 kind：不计（宁少不多，方向安全）。
    expect(countLandedFieldWrites('browser_click', { status: 'ok' })).toBe(0);
    expect(countLandedFieldWrites('browser_click', { status: 'not_found', kind: 'checkbox' })).toBe(0);
  });

  it('批量点击按 outcomes 逐条计可写字段 kind', () => {
    expect(
      countLandedFieldWrites('browser_click', {
        outcomes: [
          { fieldId: 'f1', status: 'ok', kind: 'checkbox' },
          { fieldId: 'f2', status: 'ok', kind: 'button' },
          { fieldId: 'f3', status: 'mismatch', kind: 'radio' },
          { fieldId: 'f4', status: 'ok', kind: 'radio' },
        ],
      }),
    ).toBe(2);
  });

  it('不写字段的工具一律 0', () => {
    expect(countLandedFieldWrites('browser_read_page', { whatever: 1 })).toBe(0);
    expect(countLandedFieldWrites('browser_press_key', { status: 'ok' })).toBe(0);
    expect(countLandedFieldWrites('browser_fill_form', { outcomes: [] })).toBe(0);
  });
});
