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

/**
 * mergeFrameCollections 会给每条 raw 都挂上它所在帧的 frameId/frameOrigin——
 * 主框架也不例外（frameId: 0，frameOrigin: 主页面的 origin），而不是 undefined。
 * 但写入侧的 origin 校验（form-dom.ts 的 applyFormFill/pressKeyInPage/
 * scrollContainerInPage）只应该拦住"子帧的 frameId 被 Chrome 复用给了别的帧"这一种
 * 陈旧——主框架的陈旧检测完全由 table.url 与 location.href 的比对负责（ref: 设计文档
 * §3.3）。如果不加区分地把主框架句柄的 frameOrigin 也当作 expectOrigin 传下去，会
 * 让 form-dom.ts 里"只要 expectOrigin 存在就跳过 url 校验"的分支意外命中主框架
 * 写入，使一次同源换页（例如分步 SPA 流程）不再能被识别为陈旧。
 *
 * 因此这里是 expectOrigin 的唯一决策点：只有 handle.frameId 为真值（非 0、非
 * undefined）——也就是真正的子帧句柄——才转发 frameOrigin；主框架句柄一律传
 * undefined，交回给 url 校验。
 */
export function resolveExpectOrigin(handle: FormFieldHandle | undefined): string | undefined {
  return handle?.frameId ? handle.frameOrigin : undefined;
}

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

export interface FormFillFrameGroup {
  /** undefined = 主框架旧句柄（向后兼容缺省 frameId 的表），否则是采集时记下的真实 frameId。 */
  frameId: number | undefined;
  frameOrigin: string | undefined;
  items: ApplyFillItem[];
  submit?: { fieldId: string; path: FormFieldHandle['path']; expect: FormFieldHandle['expect'] };
}

/**
 * 把 planFormFill 产出的 items/submit 按句柄的 frameId 分组，每组对应一次独立的
 * executeInTab 调用。
 *
 * 背景：一次 browser_fill_form 天然可能横跨多个帧——旗舰场景就是主框架的姓名/邮箱
 * 与支付 iframe 里的卡号在同一次 browser_get_form 快照里、同一次 browser_fill_form
 * 调用里。过去的实现只用"代表整批"的一个句柄（submit 或第一个字段）做 origin 校验、
 * 只发起一次 executeInTab，其余字段的 path 会被拿去跟这唯一目标帧解析——同源撞名时
 * 甚至可能真的解析成功，写进完全不该写的帧，却仍然回报 'ok'。按帧分组、每组各自
 * 校验 origin，才能让 Critical #2 描述的这条误写路径被真正堵住
 * （ref: 设计文档 §3.3，2026-09-04 review Critical #2）。
 *
 * submit 归入它自己句柄所在的组，可能与所有 items 所在的组都不同（字段在 iframe 里，
 * 提交按钮却在主框架的表单上，或反过来）；若它的 frameId 在 items 分组里找不到对应的
 * 组，就单独开一个 items 为空的组——与 clickElementByFieldId 现有的
 * `applyFormFill({ items: [], submit })` 用法是同一个模式。
 *
 * items 与 submit 都为空时（例如请求的字段全被判定为敏感、且未请求提交）仍返回一个
 * 面向主框架、items 为空的组：过去的实现在这种情况下也会对主框架发起一次空 items 的
 * executeInTab 调用，用来检测页面是否已经导航——分组不能把这次校验静默丢掉。
 */
export function groupItemsByFrame(
  items: ApplyFillItem[],
  submit: FormFillPlan['submit'],
  table: FormFieldTable,
): FormFillFrameGroup[] {
  const groups = new Map<number | undefined, FormFillFrameGroup>();

  const groupFor = (fieldId: string): FormFillFrameGroup => {
    const handle = table.fields[fieldId];
    const frameId = handle?.frameId;
    let group = groups.get(frameId);
    if (!group) {
      group = { frameId, frameOrigin: resolveExpectOrigin(handle), items: [] };
      groups.set(frameId, group);
    }
    return group;
  };

  for (const item of items) {
    groupFor(item.fieldId).items.push(item);
  }

  if (submit) {
    groupFor(submit.fieldId).submit = submit;
  }

  if (groups.size === 0) {
    groups.set(undefined, { frameId: undefined, frameOrigin: undefined, items: [] });
  }

  return Array.from(groups.values());
}

export interface FieldClickPlan {
  ok: boolean;
  reason?: 'no_table' | 'unknown_field' | 'wrong_kind';
  submit?: { fieldId: string; path: FormFieldHandle['path']; expect: FormFieldHandle['expect'] };
}

/** browser_click(fieldId) 的查表与校验：background 只负责把结果送进页面执行。 */
export function planFieldClick(fieldId: string, table: FormFieldTable | undefined): FieldClickPlan {
  if (!table) return { ok: false, reason: 'no_table' };
  const handle = table.fields[fieldId];
  if (!handle) return { ok: false, reason: 'unknown_field' };
  // s{n} 句柄是滚动容器，不是可点击字段：放过去会用 {tag:'div'} 这种弱 expect 顺利通过
  // 校验，对面板本体派发一次真实点击（ref: 设计文档 §3.5，click-handle-addressing）。
  if (handle.kind === 'scrollable') return { ok: false, reason: 'wrong_kind' };
  return { ok: true, submit: { fieldId, path: handle.path, expect: handle.expect } };
}

export interface FieldScrollPlan {
  ok: boolean;
  reason?: 'no_table' | 'unknown_field' | 'wrong_kind';
  target?: { fieldId: string; path: FormFieldHandle['path']; expect: { tag: string } };
}

/** browser_scroll(fieldId) 的查表与校验：background 只负责把结果送进页面执行。 */
export function planFieldScroll(fieldId: string, table: FormFieldTable | undefined): FieldScrollPlan {
  if (!table) return { ok: false, reason: 'no_table' };
  const handle = table.fields[fieldId];
  if (!handle) return { ok: false, reason: 'unknown_field' };
  if (handle.kind !== 'scrollable') return { ok: false, reason: 'wrong_kind' };
  return { ok: true, target: { fieldId, path: handle.path, expect: { tag: handle.expect.tag } } };
}

/**
 * 探测该打哪个帧。抽成纯函数不是为了复用，是为了让「探测必须跟着 frameId 走」
 * 这条安全约束有测试守着——background 里的逻辑没有任何 vitest project 覆盖
 * （ref: 设计文档 §5.2）。
 */
export function planProbeTarget(
  fieldId: string | undefined,
  table: FormFieldTable | undefined,
): { path?: FormFieldHandle['path']; frameId?: number; expectOrigin?: string } {
  if (!fieldId || !table) return {};
  const handle = table.fields[fieldId];
  if (!handle) return {};
  return { path: handle.path, frameId: handle.frameId, expectOrigin: handle.frameOrigin };
}
