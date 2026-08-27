import { describe, expect, it } from 'vitest';
import type { FillFormFieldOutcome, FillFormPayload } from '@/lib/messaging';
import { mergeFillOutcomes, planFieldClick, planFieldScroll, planFormFill } from './fill-form-request';
import type { FormFieldHandle, FormFieldTable } from './tab-form-fields';

function handle(overrides: Partial<FormFieldHandle> = {}): FormFieldHandle {
  return {
    path: [{ kind: 'selector', selector: 'input', index: 0 }],
    expect: { tag: 'input', type: 'text', name: 'email', label: '邮箱' },
    sensitive: false,
    kind: 'text',
    ...overrides,
  };
}

function table(fields: Record<string, FormFieldHandle>): FormFieldTable {
  return { url: 'https://example.com/checkout', fields };
}

describe('planFormFill', () => {
  // 会让这个用例失败的 production 改动：删掉 handle.sensitive 分支——
  // 那样密码字段会连同它的值一起进入 items，被注入页面。
  it('blocks a sensitive field while still filling the normal ones in the same call', () => {
    const plan = planFormFill(
      {
        fields: [
          { fieldId: 'f1', value: 'a@b.c' },
          { fieldId: 'f2', value: 'hunter2' },
          { fieldId: 'f3', value: '13800000000' },
        ],
      },
      table({
        f1: handle(),
        f2: handle({ sensitive: true, expect: { tag: 'input', type: 'password', name: 'pw' } }),
        f3: handle({ expect: { tag: 'input', type: 'tel', name: 'phone' } }),
      }),
    );

    expect(plan.items.map((item) => item.fieldId)).toEqual(['f1', 'f3']);
    expect(plan.blocked).toEqual([
      {
        fieldId: 'f2',
        status: 'blocked_sensitive',
        detail: '出于安全考虑，本扩展不代填密码与支付类字段，请提示用户手动输入。',
      },
    ]);
  });

  // 会让这个用例失败的 production 改动：同上。这条单独断言"值"而不只是"状态"，
  // 因为 Spec-0005 的要求是敏感值在离开 background 之前就被丢弃，不进注入参数。
  it('never carries a sensitive value into the injected payload', () => {
    const plan = planFormFill(
      { fields: [{ fieldId: 'f1', value: 'hunter2' }] },
      table({ f1: handle({ sensitive: true }) }),
    );

    expect(plan.items).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain('hunter2');
  });

  // 会让这个用例失败的 production 改动：删掉 !handle 分支——
  // 未知 fieldId 会变成一个 path 为 undefined 的 item 被送进页面。
  it('reports an unknown fieldId as not_found instead of forwarding it', () => {
    const plan = planFormFill(
      { fields: [{ fieldId: 'ghost', value: 'x' }, { fieldId: 'f1', value: 'y' }] },
      table({ f1: handle() }),
    );

    expect(plan.items.map((item) => item.fieldId)).toEqual(['f1']);
    expect(plan.blocked[0]).toMatchObject({ fieldId: 'ghost', status: 'not_found' });
  });

  it('carries value and checked through to the injected item', () => {
    const plan = planFormFill(
      { fields: [{ fieldId: 'f1', value: 'a@b.c' }, { fieldId: 'f2', checked: true }] },
      table({ f1: handle(), f2: handle({ kind: 'checkbox' }) }),
    );

    expect(plan.items[0]).toMatchObject({ fieldId: 'f1', value: 'a@b.c', kind: 'text' });
    expect(plan.items[1]).toMatchObject({ fieldId: 'f2', checked: true, kind: 'checkbox' });
  });

  it('resolves a submit button handle into the plan', () => {
    const plan = planFormFill(
      { fields: [], submit: { fieldId: 'f9' } },
      table({ f9: handle({ kind: 'submit', expect: { tag: 'button', name: 'go' } }) }),
    );

    expect(plan.submit).toMatchObject({ fieldId: 'f9', expect: { tag: 'button', name: 'go' } });
    expect(plan.submitFieldMissing).toBe(false);
  });

  // 会让这个用例失败的 production 改动：删掉 submitFieldMissing——
  // submit 会静默从注入参数里消失，模型收不到任何提交失败的信号。
  it('flags a submit whose handle cannot be resolved rather than dropping it silently', () => {
    const plan = planFormFill({ fields: [], submit: { fieldId: 'ghost' } }, table({ f1: handle() }));

    expect(plan.submit).toBeUndefined();
    expect(plan.submitFieldMissing).toBe(true);
  });

  it('does not flag a missing submit when none was requested', () => {
    expect(planFormFill({ fields: [] }, table({})).submitFieldMissing).toBe(false);
  });

  // 敏感判定的目的是不代填密码/支付「值」，而点击提交按钮不写入任何值。
  // 一个 <button name="verify-otp"> 会命中敏感 token 正则，若因此拒绝提交，
  // 就会挡掉用户已经明确批准的 OTP 表单——那是 bug，不是安全。
  it('still resolves a submit button whose name trips the sensitive-token regex', () => {
    const plan = planFormFill(
      { fields: [], submit: { fieldId: 'f9' } },
      table({ f9: handle({ kind: 'submit', sensitive: true, expect: { tag: 'button', name: 'verify-otp' } }) }),
    );

    expect(plan.submit).toMatchObject({ fieldId: 'f9' });
    expect(plan.submitFieldMissing).toBe(false);
  });
});

describe('mergeFillOutcomes', () => {
  const payload: FillFormPayload = {
    fields: [{ fieldId: 'f1' }, { fieldId: 'f2' }, { fieldId: 'f3' }],
  };

  // 会让这个用例失败的 production 改动：把 `blocked ?? applied` 的优先级颠倒，
  // 或改成按 applied 的顺序返回而不是按模型请求的顺序。
  it('keeps the order the model asked for and lets blocked outcomes win', () => {
    const blocked: FillFormFieldOutcome[] = [{ fieldId: 'f2', status: 'blocked_sensitive' }];
    const applied: FillFormFieldOutcome[] = [
      { fieldId: 'f3', status: 'ok' },
      { fieldId: 'f1', status: 'mismatch' },
      { fieldId: 'f2', status: 'ok' },
    ];

    expect(mergeFillOutcomes(payload, blocked, applied)).toEqual([
      { fieldId: 'f1', status: 'mismatch' },
      { fieldId: 'f2', status: 'blocked_sensitive' },
      { fieldId: 'f3', status: 'ok' },
    ]);
  });

  // 会让这个用例失败的 production 改动：删掉兜底的 not_found，
  // 那样字段会变成 undefined 落进结果数组。
  it('falls back to not_found for a field the page never reported on', () => {
    expect(mergeFillOutcomes(payload, [], [{ fieldId: 'f1', status: 'ok' }])).toEqual([
      { fieldId: 'f1', status: 'ok' },
      { fieldId: 'f2', status: 'not_found' },
      { fieldId: 'f3', status: 'not_found' },
    ]);
  });

  it('returns an empty list when no fields were requested', () => {
    expect(mergeFillOutcomes({ fields: [] }, [], [{ fieldId: 'stray', status: 'ok' }])).toEqual([]);
  });
});

describe('planFieldClick', () => {
  it('reports no_table when the tab has no handle table at all', () => {
    expect(planFieldClick('f1', undefined)).toEqual({ ok: false, reason: 'no_table' });
  });

  it('reports unknown_field when the fieldId is not in the table', () => {
    expect(planFieldClick('f9', table({ f1: handle() }))).toEqual({ ok: false, reason: 'unknown_field' });
  });

  it('resolves a known fieldId to its path and expected fingerprint', () => {
    const h = handle({ kind: 'link', expect: { tag: 'a', label: '登录' } });
    expect(planFieldClick('f1', table({ f1: h }))).toEqual({
      ok: true,
      submit: { fieldId: 'f1', path: h.path, expect: h.expect },
    });
  });

  it('reports wrong_kind when the fieldId belongs to a scrollable container, not a clickable field', () => {
    expect(planFieldClick('s1', table({ s1: handle({ kind: 'scrollable', expect: { tag: 'div' } }) }))).toEqual({
      ok: false,
      reason: 'wrong_kind',
    });
  });
});

describe('planFieldScroll', () => {
  it('reports no_table when the tab has no handle table at all', () => {
    expect(planFieldScroll('s1', undefined)).toEqual({ ok: false, reason: 'no_table' });
  });

  it('reports unknown_field when the fieldId is not in the table', () => {
    expect(planFieldScroll('s9', table({ f1: handle() }))).toEqual({ ok: false, reason: 'unknown_field' });
  });

  it('reports wrong_kind when the fieldId belongs to a form field, not a scrollable container', () => {
    expect(planFieldScroll('f1', table({ f1: handle() }))).toEqual({ ok: false, reason: 'wrong_kind' });
  });

  it('resolves a known scrollable fieldId to its path and expected tag', () => {
    const h = handle({ kind: 'scrollable', expect: { tag: 'div' } });
    expect(planFieldScroll('s1', table({ s1: h }))).toEqual({
      ok: true,
      target: { fieldId: 's1', path: h.path, expect: { tag: 'div' } },
    });
  });
});
