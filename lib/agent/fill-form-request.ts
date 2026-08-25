// browser_fill_form 的请求规划与结果合并。
//
// 从 entrypoints/background.ts 的 fillForm 中抽出的纯逻辑：那里同时做三件事——
// 读句柄表、把请求翻译成注入参数、把页面回报归位成模型能读的结果。中间两件与
// 浏览器 API 无关，但埋在 entrypoint 里就没有任何测试 project 能覆盖到
// （vitest 的三个 project 都不匹配 entrypoints/**/*.test.ts），
// 而"敏感字段不进注入参数"恰恰是本模块最需要被钉死的一条安全约束。
import type { FillFormFieldOutcome, FillFormPayload } from '@/lib/messaging';
import type { ApplyFillItem } from './form-dom';
import type { FormFieldHandle, FormFieldTable } from './tab-form-fields';

const SENSITIVE_DETAIL = '出于安全考虑，本扩展不代填密码与支付类字段，请提示用户手动输入。';
const UNKNOWN_FIELD_DETAIL = '未知的 fieldId，请重新调用 browser_get_form。';

export interface FormFillPlan {
  /** 真正送进页面注入函数的字段。 */
  items: ApplyFillItem[];
  /** 没进页面就已经定了结果的字段（未知 fieldId / 敏感字段）。 */
  blocked: FillFormFieldOutcome[];
  submit?: { fieldId: string; path: FormFieldHandle['path']; expect: FormFieldHandle['expect'] };
  /**
   * 请求了提交但句柄解析不到。必须如实上报 not_found——
   * 若让 submit 静默从注入参数里消失，模型收不到任何提交失败的信号。
   */
  submitFieldMissing: boolean;
}

export function planFormFill(payload: FillFormPayload, table: FormFieldTable): FormFillPlan {
  const items: ApplyFillItem[] = [];
  const blocked: FillFormFieldOutcome[] = [];

  for (const field of payload?.fields ?? []) {
    const handle = table.fields[field.fieldId];
    if (!handle) {
      blocked.push({ fieldId: field.fieldId, status: 'not_found', detail: UNKNOWN_FIELD_DETAIL });
      continue;
    }
    // 敏感字段在离开 background 之前就被丢弃：值不进注入参数、不进确认卡片、不落库
    // （ref: Spec-0005 §安全与隐私）。
    if (handle.sensitive) {
      blocked.push({ fieldId: field.fieldId, status: 'blocked_sensitive', detail: SENSITIVE_DETAIL });
      continue;
    }
    items.push({
      fieldId: field.fieldId,
      path: handle.path,
      expect: handle.expect,
      kind: handle.kind,
      value: field.value,
      checked: field.checked,
    });
  }

  // 注意：提交目标不看 sensitive。敏感判定的目的是不代填密码/支付「值」，
  // 而点击按钮不写入任何值；一个 <button name="verify-otp"> 会命中敏感 token 正则，
  // 若因此拒绝提交，挡掉的是用户已经明确批准的操作。
  const submitHandle = payload?.submit ? table.fields[payload.submit.fieldId] : undefined;

  return {
    items,
    blocked,
    submit:
      payload?.submit && submitHandle
        ? { fieldId: payload.submit.fieldId, path: submitHandle.path, expect: submitHandle.expect }
        : undefined,
    submitFieldMissing: Boolean(payload?.submit) && !submitHandle,
  };
}

/**
 * 按模型请求的字段顺序归位结果，便于它逐条核对；
 * 已在 background 侧定案的 blocked 结果优先于页面回报。
 */
export function mergeFillOutcomes(
  payload: FillFormPayload,
  blocked: FillFormFieldOutcome[],
  applied: FillFormFieldOutcome[],
): FillFormFieldOutcome[] {
  const byId = new Map(applied.map((outcome) => [outcome.fieldId, outcome]));
  return (payload?.fields ?? []).map((field) => {
    const short = blocked.find((outcome) => outcome.fieldId === field.fieldId);
    return short ?? byId.get(field.fieldId) ?? { fieldId: field.fieldId, status: 'not_found' };
  });
}

export interface FieldClickPlan {
  ok: boolean;
  reason?: 'no_table' | 'unknown_field';
  submit?: { fieldId: string; path: FormFieldHandle['path']; expect: FormFieldHandle['expect'] };
}

/** browser_click(fieldId) 的查表与校验：background 只负责把结果送进页面执行。 */
export function planFieldClick(fieldId: string, table: FormFieldTable | undefined): FieldClickPlan {
  if (!table) return { ok: false, reason: 'no_table' };
  const handle = table.fields[fieldId];
  if (!handle) return { ok: false, reason: 'unknown_field' };
  return { ok: true, submit: { fieldId, path: handle.path, expect: handle.expect } };
}
