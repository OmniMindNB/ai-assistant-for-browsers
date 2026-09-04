import { describe, expect, it } from 'vitest';
import type { FillFormFieldOutcome, FillFormPayload } from '@/lib/messaging';
import type { ApplyFillItem } from './form-dom';
import {
  groupItemsByFrame,
  mergeFillOutcomes,
  planFieldClick,
  planFieldScroll,
  planFormFill,
  planProbeTarget,
  resolveExpectOrigin,
} from './fill-form-request';
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

function item(overrides: Partial<ApplyFillItem> = {}): ApplyFillItem {
  return {
    fieldId: 'f1',
    path: [{ kind: 'selector', selector: 'input', index: 0 }],
    expect: { tag: 'input', type: 'text', name: 'x' },
    kind: 'text',
    value: 'v',
    ...overrides,
  };
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

describe('groupItemsByFrame', () => {
  const submitHandlePath = [{ kind: 'selector' as const, selector: 'button', index: 0 }];
  const submitHandleExpect = { tag: 'button', name: 'go' };

  // frameId: 0 是主框架句柄——即便它也带着真实的 frameOrigin 字符串，分组结果里的
  // frameOrigin 也必须是 undefined，而不是转发那个值：main-frame 的陈旧检测完全交给
  // table.url 与 location.href 的比对负责，expectOrigin 只应该守住"子帧的 frameId
  // 被 Chrome 复用给了别的帧"这一种陈旧（ref: 设计文档 §3.3，2026-09-04 review 第二轮
  // 发现：round 1 的 Critical #2 修复把这一区分弄反了，导致主框架写入的 url 陈旧检测
  // 被意外关闭）。
  it('keeps all items and submit in one group for the common single-frame case, without forwarding the main frame origin', () => {
    const items = [item({ fieldId: 'f1' }), item({ fieldId: 'f2' })];
    const submit = { fieldId: 'f9', path: submitHandlePath, expect: submitHandleExpect };
    const t = table({
      f1: handle({ frameId: 0, frameOrigin: 'https://example.com' }),
      f2: handle({ frameId: 0, frameOrigin: 'https://example.com' }),
      f9: handle({ frameId: 0, frameOrigin: 'https://example.com', kind: 'submit' }),
    });

    const groups = groupItemsByFrame(items, submit, t);

    expect(groups).toHaveLength(1);
    expect(groups[0].frameId).toBe(0);
    expect(groups[0].frameOrigin).toBeUndefined();
    expect(groups[0].items.map((i) => i.fieldId)).toEqual(['f1', 'f2']);
    expect(groups[0].submit).toEqual(submit);
  });

  // 会让这个用例失败的 production 改动：分组时不按 frameId 分桶，仍然只用一个"代表"句柄
  // （比如 submit 或第一个字段）去发起唯一一次 executeInTab——那样支付 iframe 里的字段
  // 会被拿去跟主框架（或另一个字段所在帧）的 origin 比对，origin 校验对它形同虚设，
  // 这正是本轮修的 Critical #2。
  it('splits items across frames instead of using one "primary" handle for the whole batch', () => {
    const items = [item({ fieldId: 'f1' }), item({ fieldId: 'f2' })];
    const t = table({
      f1: handle({ frameId: 0, frameOrigin: 'https://example.com' }),
      f2: handle({ frameId: 7, frameOrigin: 'https://payments.example.com' }),
    });

    const groups = groupItemsByFrame(items, undefined, t);

    expect(groups).toHaveLength(2);
    const main = groups.find((g) => g.frameId === 0)!;
    const child = groups.find((g) => g.frameId === 7)!;
    expect(main.items.map((i) => i.fieldId)).toEqual(['f1']);
    // 主框架分组不转发 frameOrigin（见上面用例的说明）；只有真正的子帧分组才带 origin。
    expect(main.frameOrigin).toBeUndefined();
    expect(child.items.map((i) => i.fieldId)).toEqual(['f2']);
    expect(child.frameOrigin).toBe('https://payments.example.com');
  });

  it('gives submit its own empty-items group when its frame has no items in the batch', () => {
    const items = [item({ fieldId: 'f2' })];
    const submit = { fieldId: 'f9', path: submitHandlePath, expect: submitHandleExpect };
    const t = table({
      f2: handle({ frameId: 7, frameOrigin: 'https://payments.example.com' }),
      f9: handle({ frameId: 0, frameOrigin: 'https://example.com', kind: 'submit' }),
    });

    const groups = groupItemsByFrame(items, submit, t);

    expect(groups).toHaveLength(2);
    const itemsGroup = groups.find((g) => g.frameId === 7)!;
    const submitGroup = groups.find((g) => g.frameId === 0)!;
    expect(itemsGroup.items.map((i) => i.fieldId)).toEqual(['f2']);
    expect(itemsGroup.submit).toBeUndefined();
    expect(submitGroup.items).toEqual([]);
    expect(submitGroup.submit).toEqual(submit);
  });

  it('joins submit into an existing item group when their frames match', () => {
    const items = [item({ fieldId: 'f1' })];
    const submit = { fieldId: 'f9', path: submitHandlePath, expect: submitHandleExpect };
    const t = table({
      f1: handle({ frameId: 3, frameOrigin: 'https://example.com' }),
      f9: handle({ frameId: 3, frameOrigin: 'https://example.com', kind: 'submit' }),
    });

    const groups = groupItemsByFrame(items, submit, t);

    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.fieldId)).toEqual(['f1']);
    expect(groups[0].submit).toEqual(submit);
  });

  // 会让这个用例失败的 production 改动：items/submit 都为空时直接返回空数组——过去的
  // 实现即使没有任何字段可写，也会对主框架发一次空 items 的 executeInTab 调用，用来检测
  // 页面是否已经导航；分组不能把这次校验静默丢掉（否则页面已导航时 fillForm 不再报
  // fieldsTableStale）。
  it('falls back to a single main-frame group with empty items when there is nothing to write or submit', () => {
    const groups = groupItemsByFrame([], undefined, table({}));

    expect(groups).toEqual([{ frameId: undefined, frameOrigin: undefined, items: [] }]);
  });

  it('buckets a field with no explicit frameId (legacy handle) into the main-frame group', () => {
    const items = [item({ fieldId: 'f1' })];
    const t = table({ f1: handle() }); // handle() 默认不带 frameId/frameOrigin

    const groups = groupItemsByFrame(items, undefined, t);

    expect(groups).toEqual([{ frameId: undefined, frameOrigin: undefined, items }]);
  });
});

describe('resolveExpectOrigin', () => {
  // 会让这个用例失败的 production 改动：判定条件从"handle.frameId 为真值"松绑成
  // "handle.frameId !== undefined"（或者干脆直接返回 handle?.frameOrigin）——那样
  // frameId: 0 的主框架句柄也会被当成子帧句柄转发 frameOrigin，关闭 form-dom.ts 里
  // "存在 expectOrigin 就跳过 url 检查"分支对主框架的 url 陈旧检测（2026-09-04 review
  // 第二轮：round 1 修 Critical #1 时引入的缺陷）。
  it('does not forward frameOrigin for a main-frame handle (frameId: 0), even though it carries a real origin string', () => {
    const mainFrame = handle({ frameId: 0, frameOrigin: 'https://example.com' });
    expect(resolveExpectOrigin(mainFrame)).toBeUndefined();
  });

  it('forwards frameOrigin for a real child-frame handle (truthy frameId)', () => {
    const childFrame = handle({ frameId: 7, frameOrigin: 'https://payments.example.com' });
    expect(resolveExpectOrigin(childFrame)).toBe('https://payments.example.com');
  });

  it('returns undefined for a legacy handle with no frameId at all', () => {
    expect(resolveExpectOrigin(handle())).toBeUndefined();
  });

  it('returns undefined when there is no handle to resolve', () => {
    expect(resolveExpectOrigin(undefined)).toBeUndefined();
  });
});

describe('planProbeTarget', () => {
  // 会让这个用例失败的 production 改动：探测忽略 handle.frameId 只打主框架。
  // 后果不是"探不到"这么轻——探测失败会被 resolveSubmitIntent 降级成
  // { isSubmit: false } 放行，于是子帧里的每一次表单提交都绕过确认闸门。
  it('targets the frame recorded on the handle', () => {
    const plan = planProbeTarget(
      'f9',
      table({ f9: handle({ frameId: 7, frameOrigin: 'https://pay.example.com', kind: 'submit' }) }),
    );

    expect(plan.frameId).toBe(7);
    expect(plan.expectOrigin).toBe('https://pay.example.com');
    expect(plan.path).toBeDefined();
  });

  // 会让这个用例失败的 production 改动：主框架句柄也回传一个 frameId，
  // 那样 executeInTab 会走 frameIds 分支，与改动前的行为不再等价。
  it('leaves frameId undefined for a main-frame handle', () => {
    const plan = planProbeTarget('f1', table({ f1: handle() }));
    expect(plan.frameId).toBeUndefined();
  });

  // 会让这个用例失败的 production 改动：没有句柄时凭空造一个 path 去探测。
  it('returns an empty plan when the handle is unknown', () => {
    expect(planProbeTarget('f404', table({}))).toEqual({});
    expect(planProbeTarget(undefined, undefined)).toEqual({});
  });
});
